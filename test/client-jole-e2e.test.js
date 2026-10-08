'use strict';

// SAFE END-TO-END: a test Jole lead through import validation, routing, queue
// dry run, the final send gate, a simulated reply, clarification, booking, a
// held qualified meeting and internal reporting/billing.
//
// No real email: global fetch throws for the whole test, the provider is a spy
// that must never be called, and every store is in memory. ScaleLab records are
// snapshotted before and compared after.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateClientLeadImport } = require('../integrations/clients/lead-import');
const { validateRoute, routedLeadReady } = require('../integrations/campaign-routing');
const { chooseSender, configuredSenders } = require('../integrations/gmail-sender-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { actionOwnership } = require('../integrations/clients/ownership');
const { resolveReplyClientContext } = require('../integrations/clients/reply-policy');
const { handleManagedClientReply } = require('../integrations/clients/reply-pipeline');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { buildClientOverview } = require('../integrations/clients/reporting');
const ledger = require('../integrations/clients/ledger');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

const AUTHORIZED_SENDER_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'production', RAILWAY_ENVIRONMENT: 'production',
  SEND_AUTHORIZED_TOKEN: 'test-token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
});
const JOLE_TEST_INBOX = { id: 'jole_test', email: 'outreach@jole-test.invalid', status: 'warming', tokenEnv: 'GMAIL_JOLE_TEST_TOKEN_JSON', dailyLimit: 10, perRunLimit: 2, clientId: 'jole' };

const scalelabCorpus = () => [
  { id: 's1', company: 'Bright Smiles Dental', email: 'office@brightsmiles.example.com', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '',
    leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List', senderInboxId: 'primary', routingRequired: 'true', tradeType: '' },
  { id: 's2', company: 'North Staffing Group', email: 'ceo@northstaffing.example.com', stage: 'Queued', emailStatus: '', emailStep: '', notes: '',
    leadNiche: 'industrial_staffing', emailTemplateId: 'industrial-staffing-employer-v1', intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1', campaign: 'Industrial Staffing Agency', senderInboxId: 'scalelabaiteam', routingRequired: 'true', tradeType: '' },
];

test('SAFE E2E: Jole lead → routing → queue dry run → gate → reply → clarification → meeting → billing, fully isolated', async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network access is forbidden in this test'); };
  const originalRegistry = process.env.GMAIL_INBOX_REGISTRY_JSON;
  process.env.GMAIL_INBOX_REGISTRY_JSON = JSON.stringify([JOLE_TEST_INBOX]);
  t.after(() => {
    globalThis.fetch = realFetch;
    if (originalRegistry === undefined) delete process.env.GMAIL_INBOX_REGISTRY_JSON; else process.env.GMAIL_INBOX_REGISTRY_JSON = originalRegistry;
  });

  const corpus = scalelabCorpus();
  const scalelabBefore = JSON.stringify(corpus);
  const providerCalls = [];

  // 1. Import validation (dry run). A cross-client collision is refused.
  const imported = validateClientLeadImport({
    clientId: 'jole', campaignId: 'jole-btx-employer-acquisition', existingLeads: corpus, suppressedEmails: new Set(),
    rows: [
      { company: 'Voltline Mission Critical LLC', contactName: 'Pat Rivera', email: 'Pat.Rivera@voltline.example.com', evidence: 'Hyperscale DC electrical, 400 direct electricians' },
      { company: 'Bright Smiles Dental', email: 'office@brightsmiles.example.com' },
      { company: 'Staffing-Heavy Contractor', email: 'x@contractor.example.com', tradeType: 'staffing' },
    ],
  });
  assert.equal(imported.writes, 0);
  assert.equal(imported.accepted, 1);
  assert.deepEqual(imported.refusals.map(r => r.code), ['cross_client_collision', 'ownership_conflict']);
  const lead = { id: 'jole-e2e-1', ...imported.leads[0], senderInboxId: 'jole_test' };
  assert.equal(lead.email, 'pat.rivera@voltline.example.com');

  // 2. Routing validation and sender selection: Jole sender only.
  const senders = configuredSenders({ ...process.env, GMAIL_JOLE_TEST_TOKEN_JSON: '{"refresh_token":"x"}', FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}' })
    .map(sender => (sender.id === 'jole_test' ? { ...sender, status: 'active', sendEligible: true } : sender));
  const jole = senders.find(sender => sender.id === 'jole_test');
  assert.equal(jole.clientId, 'jole');
  const inboxes = senders.map(sender => ({ ...sender, deliveryImplemented: true }));
  const route = validateRoute({ niche: lead.leadNiche, senderInboxId: 'jole_test', emailTemplateId: lead.emailTemplateId, inboxes, lead, campaignVersionId: lead.intendedCampaignVersion });
  // Isolation passes and the approved campaign routes; the queue and send
  // gates below are what still refuse.
  assert.equal(route.ok, true);
  assert.equal(route.clientId, 'jole');
  assert.equal(validateRoute({ niche: lead.leadNiche, senderInboxId: 'primary', emailTemplateId: lead.emailTemplateId, inboxes, lead }).code, 'client_ownership_conflict');
  assert.equal(chooseSender({ lead, senders, sendsToday: new Map() }).sender.id, 'jole_test');
  assert.equal(chooseSender({ lead: { ...lead, senderInboxId: '', routingRequired: '' }, senders: senders.filter(s => s.id !== 'jole_test'), sendsToday: new Map() }).sender, null);
  assert.equal(routedLeadReady(lead, AUTHORIZED_SENDER_ENV).ok, false);

  // 3. Queue dry run: refused before any mutation.
  let applied = 0;
  const queued = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'jole_test', emailTemplateId: lead.emailTemplateId, campaignVersionId: lead.intendedCampaignVersion }, {
    loadState: async () => ({ leads: [...corpus, { ...lead, senderInboxId: '' }], activities: [], boardLeads: [], suppressedEmails: new Set() }),
    validateSelection: (candidate, sender) => validateRoute({ niche: candidate.leadNiche, senderInboxId: sender, emailTemplateId: lead.emailTemplateId, inboxes, lead: candidate, campaignVersionId: lead.intendedCampaignVersion }),
    applyChanges: async () => { applied += 1; return []; },
    appendActivity: async () => { applied += 1; },
  });
  // Refused before any mutation: the lead has no researched personalization,
  // so its Jole copy cannot render (the same check the agent makes at send).
  assert.equal(queued.status, 409);
  assert.match(queued.error, /research profile/);
  assert.equal(applied, 0);

  // 4. Final send gate in a fully authorized send process. Before activation
  // Jole is refused as inactive; as shipped (active since 2026-10-05) it is
  // still refused until sending is enabled.
  const restorePending = require('../test-support/client-lifecycle').pendingJoleForTest();
  const inactive = await guardProviderSend(lead, {
    env: AUTHORIZED_SENDER_ENV, senders,
    loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }),
    loadClientSuppression: async () => ({ available: true, entries: [] }),
  }, { purpose: 'cold', senderInboxId: 'jole_test' });
  restorePending();
  assert.equal(inactive.code, 'client_inactive');
  // From here on, model Jole after onboarding and an explicit operator
  // activation (sending still disabled) to exercise fulfillment end to end.
  t.after(activateJoleForTest());
  const gate = await guardProviderSend(lead, {
    env: AUTHORIZED_SENDER_ENV, senders,
    loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }),
    loadClientSuppression: async () => ({ available: true, entries: [] }),
  }, { purpose: 'cold', senderInboxId: 'jole_test' });
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'client_sending_disabled');
  if (gate.allowed) providerCalls.push('send');
  assert.equal(actionOwnership(lead, jole, { senders }).clientId, 'jole');

  // 5. Simulated inbound reply → Jole classifier → clarification.
  const store = createMemoryLedgerStore();
  const activities = [];
  const leadChanges = [];
  const deps = {
    recordActivity: async row => { activities.push(row); },
    applyLeadChange: async (target, patch) => { leadChanges.push({ id: target.id, patch }); },
    applyGlobalUnsubscribe: async () => { throw new Error('not expected'); },
    addGlobalSuppression: async () => { throw new Error('not expected'); },
    store, activities, log: { log() {}, error() {} },
  };
  const context = resolveReplyClientContext({ senderInboxId: 'jole_test', lead, senders });
  assert.equal(context.clientId, 'jole');
  assert.equal(resolveReplyClientContext({ senderInboxId: 'primary', lead, senders }).ok, false);
  const replied = await handleManagedClientReply({
    lead, context, replyText: 'Interesting. We have a big hyperscale job next spring. What are your rates for journeyman electricians?',
    message: { messageId: 'sim-msg-1', threadId: 'sim-thread-1', senderInboxId: 'jole_test', occurredAt: '2026-10-02T15:00:00.000Z' },
  }, deps);
  assert.equal(replied.verdict.workflowState, 'awaiting_client_clarification');
  assert.equal(leadChanges[0].patch.emailStatus, 'replied');
  const [clarification] = await store.listClarifications('jole', { status: 'open' });
  assert.match(clarification.question, /rates for journeyman electricians/);

  // ScaleLab asks Jorge outside the system and records the answer; qualification continues.
  await ledger.answerClarification(store, { clientId: 'jole', clarificationId: clarification.clarification_id, answer: 'Rates depend on location; Jorge will quote on the call.', answeredBy: 'deins', now: '2026-10-03T15:00:00.000Z' });
  assert.equal((await store.listOpportunities('jole'))[0].conversation_status, 'qualification_in_progress');

  // 6. Simulated booking → held → qualified.
  const meeting = await ledger.recordMeetingBooked(store, { clientId: 'jole', lead, bookedAt: '2026-10-04T15:00:00.000Z', scheduledFor: '2026-10-09T16:00:00.000Z', now: '2026-10-04T15:00:00.000Z' });
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD', patch: { held_at: '2026-10-09T16:02:00.000Z' }, now: '2026-10-09T17:00:00.000Z' });
  const qualified = await ledger.updateMeeting(store, {
    clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD', now: '2026-10-09T17:05:00.000Z',
    patch: { attendee_name: 'Dana Ops', attendee_title: 'VP Field Operations', attendee_status: 'decision_maker', employer_fit: 'fit',
      decision_areas: ['operations', 'hiring'], use_case: 'upcoming', qualification_basis: 'Owns electrician hiring for a spring hyperscale project.' },
  });
  assert.equal(qualified.billable, true);

  // 7. Internal reporting / billing — Jole only.
  const overview = buildClientOverview({
    clientId: 'jole', leads: [...corpus, lead], activities, senders, routedLeadReady, env: AUTHORIZED_SENDER_ENV,
    ledger: { available: true, opportunities: await store.listOpportunities('jole'), meetings: await store.listMeetings('jole'), clarifications: await store.listClarifications('jole') },
  });
  assert.equal(overview.leads.imported, 1);
  assert.equal(overview.replies.positive, 1);
  assert.equal(overview.pipeline.qualifiedHeld, 1);
  assert.equal(overview.pipeline.awaitingClarification, 0);
  assert.equal(overview.billing.billableMeetings, 1);
  assert.equal(overview.billing.accruedCents, 35000);
  assert.equal(overview.sending.sendingEnabled, false);
  assert.deepEqual(overview.deliverability.senders.map(s => s.id), ['jole_test']);

  const scalelabOverview = buildClientOverview({ clientId: 'scalelab', leads: [...corpus, lead], activities, senders, routedLeadReady, env: {} });
  assert.equal(scalelabOverview.leads.imported, 2);
  assert.equal(scalelabOverview.replies.total, 0);
  assert.equal(scalelabOverview.deliverability.senders.some(s => s.id === 'jole_test'), false);

  // Isolation throughout: nothing sent, ScaleLab untouched, ledger holds Jole rows only.
  assert.deepEqual(providerCalls, []);
  assert.equal(JSON.stringify(corpus), scalelabBefore);
  assert.deepEqual(await store.listOpportunities('scalelab'), []);
  assert.deepEqual(await store.listMeetings('scalelab'), []);
  assert.ok(leadChanges.every(change => change.id === lead.id));
});
