'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAILBOXES, CAMPAIGN_ID } = require('../integrations/clients/sender-delegation');
const { configuredSenders, senderCountsToday, allowedForLead } = require('../integrations/gmail-sender-routing');
const { DEFAULT_SECONDARY_INBOXES } = require('../integrations/gmail-inbox-registry');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { mailboxLeadScope } = require('../integrations/mailbox-conversation-ownership');
const { matchMailboxMessages } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');
const { resolveReplyClientContext } = require('../integrations/clients/reply-policy');
const { clientInboundHealth } = require('../integrations/clients/inbound-health');
const { clientDeliveryHealth } = require('../integrations/clients/delivery-health');
const { clientSendBlock } = require('../integrations/clients/send-policy');
const { clientSendCountsToday } = require('../integrations/clients/capacity');
const { observerFollowUpVerdict } = require('../integrations/gmail-followup-safety');
const { createMemorySendQuotaStore } = require('../test-support/send-quota-memory');

function environment(transfer = true) {
  const rows = [
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    ...DEFAULT_SECONDARY_INBOXES,
  ].map(row => ({ ...row, status: 'active', dailyLimit: row.clientId === 'jole'
    ? (['jole_group_jorge', 'jole_industrial_jorge', 'jole_industrial_jguerrero'].includes(row.id) ? 15 : 20)
    : row.id === 'scalelabaiteam' ? 30 : 45, perRunLimit: row.clientId === 'jole' ? 2 : 5 }));
  return { FROM_EMAIL: MAILBOXES[0].email, GMAIL_TOKEN_JSON: '{}',
    GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
    GMAIL_INBOX_REGISTRY_JSON: JSON.stringify(rows), ...Object.fromEntries(rows.map(row => [row.tokenEnv, '{}'])),
    CLIENT_SENDING_AUTHORIZED: 'jole', CLIENT_SENDING_PAUSED: 'scalelab',
    JOLE_SCALELAB_SENDERS_ENABLED: String(transfer), COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'none',
    COLD_INBOX_DAILY_CAPS: 'scalelabaiteam:15', GMAIL_GLOBAL_DAILY_CEILING: '185', GMAIL_GLOBAL_PER_RUN_CEILING: '27' };
}
const scale = (extra = {}) => ({ id: 's1', clientId: 'scalelab', email: 'buyer@example.test',
  campaign: 'Staffing Outreach Campaign 2', intendedCampaignVersion: 'industrial_staffing_outreach_campaign_2',
  leadNiche: 'industrial_staffing', emailTemplateId: 'industrial-staffing-employer-v2',
  senderInboxId: 'tryscalelabai', emailStep: '1', emailStatus: 'emailed', stage: 'Contacted',
  lastEmailedAt: '2026-10-20T14:00:00Z', ...extra });
const jole = (extra = {}) => ({ id: 'j1', clientId: 'jole', email: 'jole-buyer@example.test',
  campaign: CAMPAIGN_ID, intendedCampaignVersion: CAMPAIGN_ID, leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', senderInboxId: 'tryscalelabai',
  emailStep: '1', emailStatus: 'emailed', stage: 'Contacted', lastEmailedAt: '2026-11-02T14:00:00Z', ...extra });
const sent = (lead, thread = lead.id) => ({ eventId: `sent:${lead.id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
  eventType: 'initial_email_sent', occurredAt: lead.lastEmailedAt, metadata: JSON.stringify({ senderInboxId: lead.senderInboxId,
    gmailMessageId: `out:${lead.id}`, gmailThreadId: thread, rfcMessageId: `<${lead.id}@out.test>` }) });
const inbound = (lead, extra = {}) => ({ id: 'in1', threadId: lead.id, internalDate: String(Date.parse('2026-11-08T12:00:00Z')),
  labelIds: [], payload: { mimeType: 'text/plain', body: { data: Buffer.from('Please send more information').toString('base64url') },
    headers: [{ name: 'From', value: lead.email }, { name: 'Message-ID', value: '<incoming@test>' }] }, ...extra });

test('all five transfer together with stable identities, credentials, quotas and unchanged six Jole inboxes', () => {
  const before = configuredSenders(environment(false));
  const after = configuredSenders(environment());
  assert.equal(after.length, 11);
  assert.equal(new Set(after.map(row => row.id)).size, 11);
  assert.equal(new Set(after.map(row => row.email)).size, 11);
  for (const sender of after) {
    const old = before.find(row => row.id === sender.id);
    assert.equal(sender.tokenEnv, old.tokenEnv);
    assert.equal(sender.oauthClient, old.oauthClient);
    assert.equal(sender.clientId, 'jole');
    if (MAILBOXES.some(row => row.id === sender.id)) {
      assert.equal(sender.dailyLimit, sender.id === 'scalelabaiteam' ? 15 : 20);
      assert.equal(sender.perRunLimit, 2);
      assert.equal(sender.sendEligible, true);
      assert.match(sender.fromName, /on behalf of Jole BTX LLC/);
    } else assert.deepEqual(sender, old);
  }
  assert.deepEqual(capacityFromEnv(after, environment()).clientLimits, {
    scalelab: { daily: 0, perRun: 0 }, jole: { daily: 200, perRun: 22 } });
});

test('cutover refuses an unexpected mailbox binding instead of creating a second sender', () => {
  const env = environment(); env.FROM_EMAIL = 'somebody@scalelabai.ca';
  assert.throws(() => configuredSenders(env), /original unique mailbox primary/);
});

test('client pause is independent of Jole authorization and cannot enable another client', () => {
  assert.equal(clientSendBlock('scalelab', environment()).code, 'client_sending_paused');
  assert.equal(clientSendBlock('jole', environment()), null);
  const beforeTransfer = configuredSenders(environment(false));
  assert.equal(beforeTransfer.filter(sender => sender.sendEligible && sender.clientId !== 'jole').length, 0);
  assert.deepEqual(capacityFromEnv(beforeTransfer, environment(false)).clientLimits, {
    scalelab: { daily: 0, perRun: 0 }, jole: { daily: 105, perRun: 12 } });
  assert.equal(beforeTransfer.filter(sender => sender.observerEnabled).length, 11);
});

for (const transfer of [true, false]) test(`historical replies retain their owner with transfer=${transfer}, including rollback`, () => {
  const senders = configuredSenders(environment(transfer)); const sender = senders.find(row => row.id === 'tryscalelabai');
  const leads = [scale(), jole()]; const activities = leads.map(lead => sent(lead));
  const scoped = mailboxLeadScope(leads, sender, activities);
  assert.equal(scoped.length, 2);
  for (const lead of leads) {
    const matched = matchMailboxMessages([inbound(lead)], { leads: scoped, activities, senderInboxId: sender.id, senderEmail: sender.email });
    assert.deepEqual([...matched.replies.keys()], [lead.id]);
    const context = resolveReplyClientContext({ senderInboxId: sender.id, lead, senders, activities });
    assert.equal(context.ok, true); assert.equal(context.clientId, lead.clientId);
  }
  assert.equal(allowedForLead(sender, transfer ? scale() : jole()), false, 'historical reply permission never authorizes cross-client outbound');
});

test('sender assignment or a reservation without confirmed evidence cannot confer historical ownership', () => {
  const senders = configuredSenders(environment()); const lead = scale();
  const activities = [{ ...sent(lead), eventType: 'ordinary_send_reserved' }];
  const sender = senders.find(row => row.id === lead.senderInboxId);
  assert.equal(mailboxLeadScope([lead], sender, activities).length, 0);
  assert.equal(resolveReplyClientContext({ senderInboxId: sender.id, lead, senders, activities }).ok, false);
});

test('same address in two tenants uses unique thread evidence and fails closed without it', () => {
  const leads = [scale(), jole({ email: scale().email })]; const activities = leads.map(lead => sent(lead));
  const options = { leads, activities, senderInboxId: 'tryscalelabai', senderEmail: MAILBOXES[1].email };
  assert.deepEqual([...matchMailboxMessages([inbound(leads[0])], options).replies.keys()], ['s1']);
  assert.throws(() => matchMailboxMessages([inbound(leads[0], { threadId: 'unknown' })], options), /Ambiguous/);
});

test('a conflicted thread cannot disappear from the index and fall back to an exact email', () => {
  const leads = [scale(), jole()]; const activities = leads.map(lead => sent(lead, 'conflict'));
  assert.throws(() => matchMailboxMessages([inbound(leads[0], { threadId: 'conflict' })], {
    leads, activities, senderInboxId: 'tryscalelabai', senderEmail: MAILBOXES[1].email }), /Conflicting inbound CRM thread/);
});

test('recovered ScaleLab inbound persists ownership, commits once and remains replayable after reassignment', async () => {
  const lead = scale(); const sender = configuredSenders(environment()).find(row => row.id === lead.senderInboxId);
  const activities = [sent(lead)]; const message = inbound(lead);
  const input = { observation: { messages: [message], recovered: true, unavailable: [], anchor: 'anchor' },
    gmail: {}, leads: [lead], activities, senderInboxId: sender.id, senderEmail: sender.email, now: new Date('2026-11-08T13:00:00Z') };
  const plan = await planMailboxEvents(input);
  const row = plan.events.find(row => row.eventId === 'gmail-reply:in1');
  assert.equal(JSON.parse(row.metadata).clientId, 'scalelab');
  let checkpointed = false;
  await commitObservation({ observation: input.observation, plan, activities, appendEvents: async () => {},
    suppress: async () => {}, checkpoint: async () => { checkpointed = true; } });
  assert.equal(checkpointed, true);
  const replay = await planMailboxEvents(input);
  assert.equal(replay.events.some(row => row.eventId === 'gmail-reply:in1'), false);
  assert.equal(resolveReplyClientContext({ senderInboxId: sender.id, lead, senders: [sender], activities }).clientId, 'scalelab');
});

test('unowned messages are metadata-only operator review and never a tenant reply', async () => {
  const lead = scale(); const plan = await planMailboxEvents({
    observation: { messages: [inbound(lead, { threadId: 'unknown' })], recovered: false, unavailable: [] }, gmail: {},
    leads: [], activities: [], senderInboxId: 'tryscalelabai', senderEmail: MAILBOXES[1].email });
  assert.equal(plan.replies.length, 0);
  assert.equal(plan.events[0].eventType, 'gmail_ownership_review');
  assert.equal(plan.events[0].sourceLeadId, ''); assert.equal(plan.events[0].content, '');
  assert.equal(JSON.stringify(plan.events).includes(lead.email), false);
});

test('health and delivery reports never absorb the other tenant history from a reassigned mailbox', () => {
  const leads = [scale(), jole()]; const senders = configuredSenders(environment());
  const activities = leads.flatMap(lead => [sent(lead), { eventId: `gmail-reply:${lead.id}`, sourceLeadId: lead.id,
    eventType: 'needs_human_reply', occurredAt: '2026-11-08T12:00:00Z', metadata: JSON.stringify({ senderInboxId: lead.senderInboxId, gmailMessageId: lead.id }) }]);
  const report = clientDeliveryHealth({ clientId: 'jole', leads, senders, activities });
  assert.equal(report.totals.sends, 1);
  const health = clientInboundHealth({ clientId: 'jole', leads, senders, activities,
    observerRows: [['tryscalelabai','h','2026-11-08T12:00:00Z','2026-11-08T12:00:00Z','','healthy','history','complete','1']],
    now: new Date('2026-11-08T12:01:00Z') });
  assert.equal(health.inboxes.find(row => row.senderInboxId === 'tryscalelabai').inboundEvents, 1);
});

test('sender usage crosses client assignments while client totals keep their original owner', () => {
  const leads = [scale(), jole()]; const activities = leads.map(lead => ({ ...sent(lead), occurredAt: '2026-11-08T12:00:00Z' }));
  assert.equal(senderCountsToday(activities, '2026-11-08').get('tryscalelabai'), 2);
  assert.deepEqual([...clientSendCountsToday(activities, { dayKey: '2026-11-08', leadsById: new Map(leads.map(lead => [lead.id, lead])) })], [['scalelab',1],['jole',1]]);
});

test('durable sender usage and ambiguous actions survive a same-day reassignment', async () => {
  const store = createMemorySendQuotaStore(); const dayKey = '2026-11-08';
  const plan = clientId => ({ globalDailyLimit: 200, globalRunLimit: 22, clientLimits: { [clientId]: { daily: 200, perRun: 22 } },
    lanes: [{ senderId: 'primary', clientId, dailyLimit: 2, budget: 2 }] });
  const baselines = { global: 0, clients: new Map(), senders: new Map() };
  await store.beginRun({ runId: 'old', dayKey, plan: plan('scalelab'), baselines });
  await store.reserve({ actionId: 'old-send', runId: 'old', dayKey, clientId: 'scalelab', senderId: 'primary' });
  await store.markAmbiguous('old-send'); await store.finishRun('old');
  await store.beginRun({ runId: 'new', dayKey, plan: plan('jole'), baselines });
  await store.reserve({ actionId: 'new-send', runId: 'new', dayKey, clientId: 'jole', senderId: 'primary' });
  await assert.rejects(store.reserve({ actionId: 'extra', runId: 'new', dayKey, clientId: 'jole', senderId: 'primary' }), { code: 'quota_exhausted' });
  await assert.rejects(store.reserve({ actionId: 'old-send', runId: 'new', dayKey, clientId: 'jole', senderId: 'primary' }), { code: 'quota_action_held' });
});

test('delegated first touches require fresh observation while existing dedicated behavior is preserved', () => {
  const lead = { emailStep: '', emailStatus: '', lastEmailedAt: '' };
  assert.equal(observerFollowUpVerdict({ lead }).allowed, true);
  assert.equal(observerFollowUpVerdict({ lead, requireHealthyFirstTouch: true }).code, 'observer_stale_first_touch');
});

test('quota inspection uses one read-only snapshot and never acquires or changes quotas', async () => {
  const queries = []; let released = false;
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }, release: () => { released = true; } };
  const result = await require('../integrations/send-quota-inspection').inspectSendQuota({ connect: async () => client }, '2026-11-08');
  assert.equal(result.readOnly, true); assert.equal(released, true);
  assert.match(queries[0].sql, /REPEATABLE READ READ ONLY/);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  for (const { sql } of queries) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|FOR UPDATE)\b/i);
});

test('quota inspection failure rolls back and releases its read-only connection', async () => {
  const queries = []; let released = false;
  const client = { query: async sql => { queries.push(sql); if (sql.startsWith('SELECT')) throw Error('offline'); return { rows: [] }; }, release: () => { released = true; } };
  await assert.rejects(require('../integrations/send-quota-inspection').inspectSendQuota({ connect: async () => client }, '2026-11-08'), /offline/);
  assert.equal(queries.at(-1), 'ROLLBACK'); assert.equal(released, true);
});
