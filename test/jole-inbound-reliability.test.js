'use strict';

/**
 * Jole BTX inbound reliability: matching, client routing, dedupe, replay,
 * classification, suppression race, and operator health. No outbound send.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { matchMailboxMessages, observeMailbox } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, commitObservation, ownReplyText } = require('../integrations/mailbox-observation-events');
const { classifyClientReply, resolveReplyClientContext, WORKFLOW_STATE } = require('../integrations/clients/reply-policy');
const { handleManagedClientReply, replyEventId, managedReplyNeedsHandler } = require('../integrations/clients/reply-pipeline');
const { clientInboundHealth } = require('../integrations/clients/inbound-health');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { leadsInEmailScope } = require('../integrations/clients/email-scope');
const { getClient } = require('../integrations/clients/registry');
const { clientCampaign } = require('../integrations/clients/campaigns');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { classifyReplyText } = require('../integrations/canonical-reply');
const { stripQuotedReply } = require('../integrations/reply-reconciliation');

const CAMPAIGN = 'jole-btx-employer-acquisition';
const JOLE_SENDER = Object.freeze({
  id: 'jole_group_jorge', email: 'jorge@jolebtxgroup.com', clientId: 'jole',
  status: 'warming', sendEligible: false, dailyLimit: 20, perRunLimit: 2,
  credentialConfigured: true, observerEnabled: true, provider: 'gmail',
  allowedCampaignIds: [CAMPAIGN],
});
const SCALELAB_SENDER = Object.freeze({
  id: 'primary', email: 'deins@scalelabai.ca', clientId: 'scalelab',
  status: 'active', sendEligible: true, credentialConfigured: true, observerEnabled: true,
});
const SENDERS = [JOLE_SENDER, SCALELAB_SENDER];

const joleLead = (extra = {}) => ({
  id: 'jole-lead-1', company: 'Voltline Mission Critical LLC', contactName: 'Pat Rivera',
  email: 'pat.rivera@voltline-test.invalid', stage: 'Contacted', emailStatus: 'emailed',
  emailStep: '1', notes: '', lastEmailedAt: '2026-10-20T14:00:00Z',
  leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
  intendedCampaignVersion: CAMPAIGN, campaign: CAMPAIGN,
  senderInboxId: 'jole_group_jorge', routingRequired: 'true', ...extra,
});
const scalelabLead = (extra = {}) => ({
  id: 'sl-1', company: 'Bright Smiles Dental', email: 'office@brightsmiles-test.invalid',
  stage: 'Contacted', emailStatus: 'emailed', lastEmailedAt: '2026-10-20T14:00:00Z',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List',
  senderInboxId: 'primary', ...extra,
});

const outboundActivity = (lead, extra = {}) => ({
  eventId: `gmail-outbound:${extra.gmailMessageId || 'out-1'}`,
  sourceLeadId: lead.id, leadId: `CE-${lead.id}`, eventType: 'initial_email_sent',
  occurredAt: lead.lastEmailedAt, email: lead.email, company: lead.company,
  metadata: JSON.stringify({
    provider: 'gmail', senderInboxId: lead.senderInboxId, gmailThreadId: extra.threadId || 't-jole-1',
    gmailMessageId: extra.gmailMessageId || 'out-1', rfcMessageId: extra.rfcMessageId || '<jole-out-1@jolebtxgroup.com>',
  }),
});

function inboundMessage({
  id = 'in-1', from, threadId = 't-jole-1', at = '2026-10-21T15:00:00Z', text = 'Yes, please call me',
  subject = 'Re: skilled trades coverage', inReplyTo = '<jole-out-1@jolebtxgroup.com>', labels = [],
} = {}) {
  return {
    id, threadId, internalDate: String(Date.parse(at)), labelIds: labels,
    snippet: text,
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from(text).toString('base64url') },
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@inbound.test>` },
        { name: 'In-Reply-To', value: inReplyTo },
        { name: 'References', value: inReplyTo },
      ],
    },
  };
}

function planInput(messages, { lead = joleLead(), activities = [outboundActivity(joleLead())], sender = JOLE_SENDER } = {}) {
  return {
    observation: { messages, recovered: false, unavailable: [], messagesInspected: messages.length },
    gmail: { users: { threads: { get: async () => ({ data: { messages: [] } }) } } },
    leads: [lead], activities, senderInboxId: sender.id, senderEmail: sender.email,
    now: new Date('2026-10-21T15:05:00Z'),
  };
}

async function managedDeps() {
  const store = createMemoryLedgerStore();
  const calls = { activities: [], patches: [], unsubs: [], global: [] };
  return {
    store, calls,
    deps: {
      recordActivity: async row => { calls.activities.push(row); },
      applyLeadChange: async (lead, patch) => { calls.patches.push(patch); Object.assign(lead, patch); },
      applyGlobalUnsubscribe: async lead => { calls.unsubs.push(lead.email); },
      addGlobalSuppression: async (lead, reason) => { calls.global.push({ email: lead.email, reason }); },
      store, activities: calls.activities, log: { log() {}, error() {} },
      now: () => '2026-10-21T15:06:00Z',
    },
  };
}

const context = {
  ok: true, clientId: 'jole', campaignId: CAMPAIGN, policyMode: 'managed',
};

// ── architecture pins ─────────────────────────────────────────────────────
test('canonical Jole client and campaign IDs have not drifted', () => {
  const jole = getClient('jole');
  assert.equal(jole.displayName, 'Jole BTX LLC');
  assert.equal(jole.replyPolicy.mode, 'managed');
  assert.deepEqual(jole.senderPolicy.allowedCampaignIds, [CAMPAIGN]);
  const campaign = clientCampaign(CAMPAIGN);
  assert.equal(campaign.clientId, 'jole');
  assert.match(String(campaign.label || campaign.name || ''), /Manufacturing & Heavy Industry Employers|jole-btx-employer-acquisition/i);
});

test('Jole inbound path does not call Anthropic and does not send', () => {
  const pipeline = fs.readFileSync(path.join(__dirname, '../integrations/clients/reply-pipeline.js'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, '../integrations/clients/reply-policy.js'), 'utf8');
  const agent = fs.readFileSync(path.join(__dirname, '../outreach-agent.js'), 'utf8');
  assert.doesNotMatch(pipeline, /anthropic|classifyReplyWithProvenance|sendEmail\(/i);
  assert.doesNotMatch(policy, /anthropic|sendEmail\(/i);
  const managed = agent.slice(agent.indexOf("if (replyContext.policyMode === 'managed')"), agent.indexOf('if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE)'));
  assert.match(managed, /handleManagedClientReply/);
  assert.doesNotMatch(managed, /sendEmail\(|deliverOrdinaryColdStep\(|guardProviderSend\(/);
  assert.match(agent, /managedReplyNeedsHandler\(activitiesForCycle, inboundId, managedContext\.clientId\)/);
});

test('operator health endpoint exists and does not send', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/ops\/jole-inbound-health', requireAuth/);
  const block = server.slice(server.indexOf("app.get('/api/ops/jole-inbound-health'"), server.indexOf("app.get('/api/ops/mailbox-diagnostic'"));
  assert.doesNotMatch(block, /sendEmail|CLIENT_SENDING_AUTHORIZED|spawnAgent/);
  assert.match(block, /clientInboundHealth/);
});

// ── matching + routing ────────────────────────────────────────────────────
test('normal Jole reply matches the Jole lead and not ScaleLab', async () => {
  const lead = joleLead();
  const other = scalelabLead({ email: lead.email });
  const scoped = leadsInEmailScope([lead, other], 'jole');
  assert.deepEqual(scoped.map(item => item.id), ['jole-lead-1']);
  const message = inboundMessage({ from: lead.email });
  const matched = matchMailboxMessages([message], {
    leads: scoped, activities: [outboundActivity(lead)],
    senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
  });
  assert.equal(matched.replies.get(lead.id).id, 'in-1');
  const ctx = resolveReplyClientContext({ senderInboxId: JOLE_SENDER.id, lead, senders: SENDERS });
  assert.deepEqual({ ok: ctx.ok, clientId: ctx.clientId, campaignId: ctx.campaignId, policyMode: ctx.policyMode }, {
    ok: true, clientId: 'jole', campaignId: CAMPAIGN, policyMode: 'managed',
  });
  assert.equal(resolveReplyClientContext({ senderInboxId: SCALELAB_SENDER.id, lead, senders: SENDERS }).ok, false);
});

test('subject change, stripped quote, and days-later still match the same Jole lead', () => {
  const lead = joleLead();
  const activities = [outboundActivity(lead)];
  const late = inboundMessage({
    id: 'late', from: lead.email, subject: 'staffing', at: '2026-10-25T18:00:00Z',
    text: 'Yes\n\nOn Oct 20 Jorge wrote:\n> we cover industrial sites',
  });
  const matched = matchMailboxMessages([late], {
    leads: [lead], activities, senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
  });
  assert.equal(matched.replies.get(lead.id).id, 'late');
});

test('paused campaign and already-replied lead still match inbound evidence', () => {
  const lead = joleLead({ emailStatus: 'replied', stage: 'Replied', notes: '[CLIENT REPLY: positive_interest]' });
  const matched = matchMailboxMessages([inboundMessage({ from: lead.email, id: 'again' })], {
    leads: [lead], activities: [outboundActivity(lead)],
    senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
  });
  assert.equal(matched.replies.get(lead.id).id, 'again');
});

test('unknown sender creates no Jole event', async () => {
  const plan = await planMailboxEvents(planInput([
    inboundMessage({ id: 'stranger', from: 'random@elsewhere.invalid', threadId: 't-other', inReplyTo: '' }),
  ]));
  assert.equal(plan.events.filter(row => row.sourceLeadId).length, 0);
  assert.equal(plan.replies.length, 0);
  assert.ok(plan.ignored.some(item => item.reason === 'unmatched_or_irrelevant'));
});

test('two Jole leads with the same email fail closed', () => {
  const a = joleLead({ id: 'j1' });
  const b = joleLead({ id: 'j2' });
  assert.throws(
    () => matchMailboxMessages([inboundMessage({ from: a.email })], {
      leads: [a, b], activities: [], senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
    }),
    /Ambiguous inbound CRM identity/,
  );
});

test('inbox cursors stay isolated: activities from another inbox do not bind a thread', () => {
  const lead = joleLead();
  const activities = [{
    sourceLeadId: lead.id,
    metadata: JSON.stringify({ senderInboxId: 'primary', gmailThreadId: 'shared-looking', rfcMessageId: '<scale@x>' }),
  }];
  const matched = matchMailboxMessages([
    inboundMessage({ id: 'x', from: 'alias@other.invalid', threadId: 'shared-looking', inReplyTo: '<scale@x>' }),
  ], { leads: [lead], activities, senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email });
  assert.equal(matched.replies.size, 0);
});

// ── persist / dedupe / replay ─────────────────────────────────────────────
test('normal Jole reply persists one gmail-reply and re-queues the managed handler', async () => {
  const plan = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email })]));
  assert.equal(plan.events.filter(row => row.eventId === 'gmail-reply:in-1').length, 1);
  assert.equal(plan.replies.length, 1);
  assert.equal(JSON.parse(plan.events[0].metadata).matchedColdEmailId, 'jole-lead-1');
  assert.equal(JSON.parse(plan.events[0].metadata).senderInboxId, 'jole_group_jorge');
});

test('duplicate Gmail replay writes no second event but still retries an unfinished Jole handler', async () => {
  const first = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email })]));
  const again = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email })], {
    activities: [outboundActivity(joleLead()), ...first.events],
  }));
  assert.equal(again.events.filter(row => String(row.eventId).startsWith('gmail-reply:')).length, 0);
  assert.equal(again.replies.length, 1);
  assert.equal(again.replies[0].alreadyRecorded, true);
  assert.equal(managedReplyNeedsHandler(first.events, 'in-1', 'jole'), true);
  const handled = [...first.events, { eventId: replyEventId('jole', 'in-1'), eventType: 'client_reply_classified', metadata: JSON.stringify({ gmailMessageId: 'in-1', clientId: 'jole' }) }];
  assert.equal(managedReplyNeedsHandler(handled, 'in-1', 'jole'), false);
  const done = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email })], {
    activities: [outboundActivity(joleLead()), ...handled],
  }));
  assert.equal(done.replies.length, 0);
});

test('crash after gmail-reply persist still applies the Jole handler once', async () => {
  const lead = joleLead();
  const { deps, calls } = await managedDeps();
  const first = await handleManagedClientReply({
    lead, message: { messageId: 'in-1', threadId: 't-jole-1', subject: 'Re: coverage', senderInboxId: JOLE_SENDER.id },
    replyText: 'Yes, we need welders next month', context,
  }, deps);
  assert.equal(first.handled, true);
  assert.equal(lead.emailStatus, 'replied');
  assert.equal(calls.activities[0].eventType, 'client_reply_classified');
  assert.equal(calls.activities[0].eventId, 'client-reply:jole:in-1');
  const second = await handleManagedClientReply({
    lead, message: { messageId: 'in-1' }, replyText: 'Yes, we need welders next month', context,
  }, { ...deps, activities: calls.activities });
  assert.equal(second.skipped, 'already_handled');
  assert.equal(calls.activities.length, 1);
  assert.equal(calls.patches.length, 1);
});

test('handler failure before evidence leaves the inbound retryable', async () => {
  const lead = joleLead();
  const { deps, calls } = await managedDeps();
  deps.applyLeadChange = async () => { throw new Error('Sheets unavailable'); };
  await assert.rejects(handleManagedClientReply({
    lead, message: { messageId: 'in-1' }, replyText: 'Interested', context,
  }, deps), /Sheets unavailable/);
  assert.equal(calls.activities.length, 0);
  assert.equal(managedReplyNeedsHandler([], 'in-1', 'jole'), true);
});

test('commitObservation does not checkpoint if event persist fails', async () => {
  const plan = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email })]));
  let checkpoints = 0;
  await assert.rejects(commitObservation({
    observation: { nextHistoryId: '999' }, plan, activities: [],
    suppress: async () => {}, appendEvents: async () => { throw new Error('activity write failed'); },
    checkpoint: async () => { checkpoints += 1; },
  }), /activity write failed/);
  assert.equal(checkpoints, 0);
});

// ── classification ────────────────────────────────────────────────────────
const classify = text => classifyClientReply({
  clientId: 'jole', campaignId: CAMPAIGN, text,
});

test('Jole reply types map to the managed workflow, not ScaleLab automation', () => {
  const cases = [
    ['Sounds interesting, tell me more', WORKFLOW_STATE.POSITIVE_INTEREST],
    ['Yes, lets set up a call next week', WORKFLOW_STATE.MEETING_BOOKING],
    ['What are your bill rates for journeyman electricians?', WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION],
    ['Can you send more info?', WORKFLOW_STATE.ASKS_FOR_INFORMATION],
    ['Talk to Mike Smith, he handles hiring: mike@acme-test.invalid', WORKFLOW_STATE.REFERRAL_TO_DECISION_MAKER],
    ['I am out of the office until Monday', WORKFLOW_STATE.AUTOMATED],
    ['Please unsubscribe me', WORKFLOW_STATE.UNSUBSCRIBE],
    ['Not interested, thanks.', WORKFLOW_STATE.NOT_INTERESTED],
    ['Not the right person.', WORKFLOW_STATE.WRONG_CONTACT],
    ["We don't hire electricians, we sub everything out", WORKFLOW_STATE.OUTSIDE_ICP],
    ['yes', WORKFLOW_STATE.NEEDS_REVIEW],
  ];
  for (const [text, state] of cases) {
    const verdict = classify(text);
    assert.equal(verdict.mode, 'managed');
    assert.equal(verdict.clientId, 'jole');
    assert.equal(verdict.workflowState, state, text);
    assert.equal(verdict.stopsColdSequence, state !== WORKFLOW_STATE.AUTOMATED);
  }
  assert.equal(classify('yes').stopsColdSequence, true, 'short yes still leaves the cold cadence');
});

test('empty, signature-only, and bounce-like mail are not human positives', () => {
  assert.equal(classify('').workflowState, WORKFLOW_STATE.NEEDS_REVIEW);
  const quotedOnly = stripQuotedReply('Sent from my iPhone\n\nOn Oct 20 Jorge wrote:\n> we cover industrial sites');
  const own = ownReplyText({
    mimeType: 'text/plain',
    body: { data: Buffer.from('Sent from my iPhone\n\nOn Oct 20 Jorge wrote:\n> we cover industrial sites').toString('base64url') },
    headers: [],
  }, '');
  assert.ok(own.length < 40, own);
  const auto = classifyReplyText('This is an automatic reply. I am out of the office.');
  assert.equal(auto.state, 'automated_reply');
  assert.equal(classify('This is an automatic reply. I am out of the office.').workflowState, WORKFLOW_STATE.AUTOMATED);
});

test('hard bounce is a bounce, not a Jole human reply', () => {
  const lead = joleLead();
  const bounce = inboundMessage({
    id: 'dsn', from: 'Mailer-Daemon <mailer-daemon@google.com>', threadId: 't-b',
    text: `550 5.1.1 The email account that you tried to reach does not exist: ${lead.email}`,
    inReplyTo: '',
  });
  const matched = matchMailboxMessages([bounce], {
    leads: [lead], activities: [outboundActivity(lead)],
    senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
  });
  assert.equal(matched.replies.size, 0);
  assert.equal(matched.bounces.get(lead.id).id, 'dsn');
});

test('classification lives on evidence; a later reclassify does not drop the raw inbound', async () => {
  const plan = await planMailboxEvents(planInput([inboundMessage({ from: joleLead().email, text: '???' })]));
  const event = plan.events.find(row => row.eventId === 'gmail-reply:in-1');
  assert.ok(event.content.includes('?'));
  assert.equal(JSON.parse(event.metadata).gmailMessageId, 'in-1');
});

// ── suppression race ──────────────────────────────────────────────────────
test('a Jole reply that stops the sequence blocks the next scheduled send', async () => {
  const selected = joleLead({ stage: 'Queued', emailStatus: 'emailed' });
  const { deps } = await managedDeps();
  const fresh = joleLead({ stage: 'Queued', emailStatus: 'emailed' });
  await handleManagedClientReply({
    lead: fresh, message: { messageId: 'in-unsub' }, replyText: 'Unsubscribe please', context,
  }, deps);
  const env = { CLIENT_SENDING_AUTHORIZED: 'jole' };
  const after = evaluateFreshSendSafety(selected, fresh, new Set([fresh.email.toLowerCase()]), {
    purpose: 'cold', env, senderInboxId: JOLE_SENDER.id, senders: SENDERS,
    clientSuppression: { available: true, entries: [] },
  });
  assert.equal(after.allowed, false);
  assert.match(String(after.code || after.reason), /unsub|suppress|terminal/i);
});

test('OOO does not permanently suppress a later Jole send the way unsubscribe does', async () => {
  const lead = joleLead();
  const { deps } = await managedDeps();
  await handleManagedClientReply({
    lead, message: { messageId: 'ooo' },
    replyText: 'I am out of the office until November 3 and will have limited access to email.',
    context,
  }, deps);
  assert.notEqual(lead.stage, 'Unsub');
  assert.notEqual(lead.emailStatus, 'done');
  const verdict = classify('I am out of the office until November 3 and will have limited access to email.');
  assert.equal(verdict.workflowState, WORKFLOW_STATE.AUTOMATED);
  assert.equal(verdict.stopsColdSequence, false);
  assert.equal(verdict.suppressionScope, null);
});

// ── health ────────────────────────────────────────────────────────────────
test('Jole inbound health is no_credentials when tokens are absent', () => {
  const senders = [{ ...JOLE_SENDER, credentialConfigured: false }];
  const health = clientInboundHealth({
    clientId: 'jole', senders, observerRows: [['senderInboxId', 'historyId']], activities: [],
  });
  assert.equal(health.verdict, 'no_credentials');
  assert.equal(health.receivingNormally, false);
  assert.match(health.answer, /no connected observer credentials/);
});

test('Jole inbound health flags a persisted reply that never reached the managed handler', () => {
  const header = ['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health', 'mode', 'bootstrap', 'n'];
  const now = '2026-10-21T16:00:00Z';
  const rows = [header, [JOLE_SENDER.id, '100', now, now, '', 'healthy', 'history', 'complete', '1']];
  const activities = [{
    eventId: 'gmail-reply:in-1', eventType: 'positive_reply', occurredAt: now, sourceLeadId: 'jole-lead-1',
    metadata: JSON.stringify({ senderInboxId: JOLE_SENDER.id, gmailMessageId: 'in-1', clientId: 'jole' }),
  }];
  const health = clientInboundHealth({
    clientId: 'jole', senders: [JOLE_SENDER], observerRows: rows, activities, now: new Date(now),
  });
  assert.equal(health.pendingManagedHandler, 1);
  assert.equal(health.receivingNormally, false);
  assert.equal(health.verdict, 'warning');
});

test('Jole inbound health is healthy when the observer is fresh and the handler finished', () => {
  const header = ['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health', 'mode', 'bootstrap', 'n'];
  const now = '2026-10-21T16:00:00Z';
  const rows = [header, [JOLE_SENDER.id, '100', now, now, '', 'healthy', 'history', 'complete', '1']];
  const activities = [
    {
      eventId: 'gmail-reply:in-1', eventType: 'positive_reply', occurredAt: now, sourceLeadId: 'jole-lead-1',
      metadata: JSON.stringify({ senderInboxId: JOLE_SENDER.id, gmailMessageId: 'in-1' }),
    },
    {
      eventId: replyEventId('jole', 'in-1'), eventType: 'client_reply_classified', occurredAt: now,
      metadata: JSON.stringify({ senderInboxId: JOLE_SENDER.id, gmailMessageId: 'in-1', clientId: 'jole' }),
    },
  ];
  const health = clientInboundHealth({
    clientId: 'jole', senders: [JOLE_SENDER], observerRows: rows, activities, now: new Date(now),
  });
  assert.equal(health.verdict, 'healthy');
  assert.equal(health.receivingNormally, true);
  assert.equal(health.answer, 'yes');
});

test('history pagination still fails closed after the Jole matching change', async () => {
  const gmail = {
    users: {
      history: { list: async () => ({ data: { historyId: '102', nextPageToken: 'more', history: [] } }) },
      messages: { get: async () => { throw new Error('not reached'); } },
    },
  };
  await assert.rejects(() => observeMailbox({
    gmail, historyId: '100', maxPages: 1, leads: [joleLead()], activities: [],
    senderInboxId: JOLE_SENDER.id, senderEmail: JOLE_SENDER.email,
  }), /checkpoint was not advanced/);
});
