'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateScopedSuppression, buildClientSuppression, clientSuppressionMatch, companyKey,
} = require('../integrations/clients/suppression');
const { classifyClientReply, WORKFLOW_STATE } = require('../integrations/clients/reply-policy');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const { handleManagedClientReply } = require('../integrations/clients/reply-pipeline');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');

const joleLead = (extra = {}) => ({
  id: 'jole-lead-1', company: 'Voltline Mission Critical LLC', contactName: 'Pat Rivera',
  email: 'pat.rivera@voltline-test.invalid', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '',
  leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
  intendedCampaignVersion: 'jole-btx-employer-acquisition', campaign: 'jole-btx-employer-acquisition',
  senderInboxId: 'jole_test', routingRequired: 'true', tradeType: '', ...extra,
});
const scalelabLead = (extra = {}) => ({
  id: 'sl-1', company: 'Voltline Mission Critical LLC', email: 'ops@voltline-test.invalid', notes: '',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', ...extra,
});
const entries = rows => ({ available: true, entries: rows });

// ── SUPPRESSION ────────────────────────────────────────────────────────────
test('suppression: GLOBAL blocks every client', () => {
  const global = new Set(['pat.rivera@voltline-test.invalid', 'ops@voltline-test.invalid']);
  assert.equal(evaluateScopedSuppression(joleLead(), { clientId: 'jole', suppressedEmails: global, clientEntries: entries([]) }).scope, 'global');
  assert.equal(evaluateScopedSuppression(scalelabLead(), { clientId: 'scalelab', suppressedEmails: global }).scope, 'global');
  // Sticky note tags are global too.
  assert.equal(evaluateScopedSuppression(joleLead({ notes: '[REPLY: Unsubscribed]' }), { clientId: 'jole', clientEntries: entries([]) }).reason, '[REPLY: Unsubscribed]');
});

test('suppression: JOLE-only blocks Jole and does not automatically block ScaleLab', () => {
  const joleExclusion = buildClientSuppression({ clientId: 'jole', matchType: 'company', value: 'Voltline Mission Critical, LLC', reason: 'current Jole client' });
  assert.equal(joleExclusion.match_value, 'voltline mission critical');
  const verdictJole = evaluateScopedSuppression(joleLead(), { clientId: 'jole', clientEntries: entries([joleExclusion]) });
  assert.equal(verdictJole.code, 'client_suppressed');
  const verdictScalelab = evaluateScopedSuppression(scalelabLead(), { clientId: 'scalelab', clientEntries: entries([joleExclusion]) });
  assert.equal(verdictScalelab, null);
});

test('suppression: SCALELAB-only blocks ScaleLab and does not automatically block Jole', () => {
  const scalelabExclusion = buildClientSuppression({ clientId: 'scalelab', matchType: 'domain', value: 'https://www.voltline-test.invalid/about' });
  assert.equal(scalelabExclusion.match_value, 'voltline-test.invalid');
  assert.equal(evaluateScopedSuppression(scalelabLead(), { clientId: 'scalelab', clientEntries: entries([scalelabExclusion]) }).code, 'client_suppressed');
  assert.equal(evaluateScopedSuppression(joleLead(), { clientId: 'jole', clientEntries: entries([scalelabExclusion]) }), null);
  assert.equal(clientSuppressionMatch(joleLead(), 'jole', [scalelabExclusion]), null);
});

test('suppression: order is global first, then client; an unreadable client list refuses', () => {
  const joleExclusion = buildClientSuppression({ clientId: 'jole', matchType: 'email', value: 'pat.rivera@voltline-test.invalid' });
  const both = evaluateScopedSuppression(joleLead(), { clientId: 'jole', suppressedEmails: new Set(['pat.rivera@voltline-test.invalid']), clientEntries: entries([joleExclusion]) });
  assert.equal(both.scope, 'global');
  assert.equal(evaluateScopedSuppression(joleLead(), { clientId: 'jole', clientEntries: { available: false, error: 'HTTP 500' } }).code, 'client_suppression_unavailable');
  // Jole requires the store; unconfigured is a refusal.
  assert.equal(evaluateScopedSuppression(joleLead(), { clientId: 'jole', clientEntries: { available: false } }).code, 'client_suppression_unavailable');
  // ScaleLab does not require it while it is unconfigured (no client entry can exist)…
  assert.equal(evaluateScopedSuppression(scalelabLead(), { clientId: 'scalelab', clientEntries: { available: false } }), null);
  // …but a configured store that fails refuses ScaleLab too.
  assert.equal(evaluateScopedSuppression(scalelabLead(), { clientId: 'scalelab', clientEntries: { available: false, error: 'timeout' } }).code, 'client_suppression_unavailable');
});

test('suppression: entries validate client and match type', () => {
  assert.throws(() => buildClientSuppression({ clientId: 'acme', matchType: 'email', value: 'a@b.co' }), error => error.code === 'client_unknown');
  assert.throws(() => buildClientSuppression({ clientId: 'jole', matchType: 'phone', value: '1' }), error => error.code === 'invalid_match_type');
  assert.throws(() => buildClientSuppression({ clientId: 'jole', matchType: 'email', value: 'not-an-email' }), error => error.code === 'invalid_match_value');
  assert.equal(companyKey('The Acme Electric Co., Inc.'), 'acme electric');
});

// ── REPLY CLASSIFICATION ───────────────────────────────────────────────────
const joleReply = text => classifyClientReply({ clientId: 'jole', campaignId: 'jole-btx-employer-acquisition', text });

test('replies: ScaleLab replies are left to the legacy pipeline untouched', () => {
  assert.deepEqual(classifyClientReply({ clientId: 'scalelab', text: 'What are your rates?' }), { mode: 'legacy', clientId: 'scalelab' });
});

test('replies: identical language, different workflow by client context', () => {
  // "What are your rates?" — ScaleLab asks a question; for Jole only Jole can answer it.
  assert.equal(deterministicReplyCategory('What are your rates?'), 'QUESTION');
  const jole = joleReply('What are your rates?');
  assert.equal(jole.workflowState, WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION);
  assert.deepEqual(jole.clarification.topics, ['rates']);
  assert.equal(jole.clarification.question, 'What are your rates?');
  // "Not interested" — ScaleLab suppresses globally (legacy); Jole only for Jole.
  assert.equal(deterministicReplyCategory('Not interested, thanks.'), 'NOT_INTERESTED');
  const no = joleReply('Not interested, thanks.');
  assert.equal(no.workflowState, WORKFLOW_STATE.NOT_INTERESTED);
  assert.equal(no.suppressionScope, 'client');
});

test('replies: Jole workflow states', () => {
  const cases = [
    ['Please unsubscribe me', WORKFLOW_STATE.UNSUBSCRIBE, 'global'],
    ['Sounds interesting, tell me more', WORKFLOW_STATE.POSITIVE_INTEREST, null],
    ['Can you send more info?', WORKFLOW_STATE.ASKS_FOR_INFORMATION, null],
    ['Yes, lets set up a call next week', WORKFLOW_STATE.MEETING_BOOKING, null],
    ['Talk to Mike Smith, he handles hiring: mike@acme-test.invalid', WORKFLOW_STATE.REFERRAL_TO_DECISION_MAKER, null],
    ['Not the right person.', WORKFLOW_STATE.WRONG_CONTACT, null],
    ['We have a big data center project starting next spring, keep us in mind', WORKFLOW_STATE.FUTURE_WORKFORCE_NEED, null],
    ["We don't hire electricians, we sub everything out", WORKFLOW_STATE.OUTSIDE_ICP, 'client'],
    ['I am out of the office until Monday', WORKFLOW_STATE.AUTOMATED, null],
    ['How many journeyman electricians could you have on site, and are they OSHA 30 certified?', WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION, null],
  ];
  for (const [text, state, scope] of cases) {
    const verdict = joleReply(text);
    assert.equal(verdict.workflowState, state, text);
    assert.equal(verdict.suppressionScope, scope, text);
  }
  assert.equal(joleReply('I am out of the office until Monday').stopsColdSequence, false);
  assert.equal(joleReply('Sounds interesting').stopsColdSequence, true);
  assert.equal(joleReply('Sounds interesting, tell me more').conversationStatus, 'qualification_in_progress');
});

// ── MANAGED REPLY PIPELINE ─────────────────────────────────────────────────
function pipelineDeps(overrides = {}) {
  const calls = { activities: [], leadChanges: [], unsubscribes: [], globalSuppressions: [] };
  const deps = {
    recordActivity: async row => { calls.activities.push(row); },
    applyLeadChange: async (lead, patch) => { calls.leadChanges.push({ id: lead.id, patch }); },
    applyGlobalUnsubscribe: async lead => { calls.unsubscribes.push(lead.id); },
    addGlobalSuppression: async (lead, reason) => { calls.globalSuppressions.push([lead.email, reason]); },
    store: createMemoryLedgerStore(), activities: [],
    log: { log() {}, error() {} },
    ...overrides,
  };
  return { deps, calls };
}
const context = { ok: true, clientId: 'jole', campaignId: 'jole-btx-employer-acquisition', policyMode: 'managed' };

test('managed reply: a clarification question stops the sequence, records evidence and opens a clarification — never sends', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const { deps, calls } = pipelineDeps();
  const lead = joleLead();
  const result = await handleManagedClientReply({ lead, replyText: 'What are your bill rates for journeyman electricians?', context,
    message: { messageId: 'gm-1', threadId: 'th-1', senderInboxId: 'jole_test', occurredAt: '2026-10-01T15:00:00.000Z' } }, deps);
  assert.equal(result.verdict.workflowState, WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION);
  assert.deepEqual(calls.leadChanges[0].patch.emailStatus, 'replied');
  assert.equal(calls.activities[0].eventType, 'client_reply_classified');
  assert.equal(JSON.parse(calls.activities[0].metadata).clientId, 'jole');
  const clarifications = await deps.store.listClarifications('jole');
  assert.equal(clarifications.length, 1);
  assert.equal(clarifications[0].status, 'open');
  assert.equal((await deps.store.listOpportunities('jole'))[0].conversation_status, 'awaiting_client_clarification');
  assert.equal(calls.globalSuppressions.length, 0);
  // Idempotent per message.
  const again = await handleManagedClientReply({ lead, replyText: 'x', context, message: { messageId: 'gm-1' } }, { ...deps, activities: calls.activities });
  assert.equal(again.skipped, 'already_handled');
});

test('managed reply: not interested → Jole-only suppression, never global', async () => {
  const { deps, calls } = pipelineDeps();
  const lead = joleLead();
  const result = await handleManagedClientReply({ lead, replyText: 'Not interested, thanks.', context, message: { messageId: 'gm-2' } }, deps);
  assert.equal(result.suppression, 'client');
  assert.equal(calls.globalSuppressions.length, 0);
  assert.match(calls.leadChanges[0].patch.notes, /\[REPLY: Not Interested\]/);
  const rows = await deps.store.listClientSuppressions('jole');
  assert.equal(rows[0].match_value, 'pat.rivera@voltline-test.invalid');
  assert.equal((await deps.store.listClientSuppressions('scalelab')).length, 0);
});

test('managed reply: unsubscribe uses the existing global handler', async () => {
  const { deps, calls } = pipelineDeps();
  const result = await handleManagedClientReply({ lead: joleLead(), replyText: 'Please unsubscribe me', context, message: { messageId: 'gm-3' } }, deps);
  assert.deepEqual(calls.unsubscribes, ['jole-lead-1']);
  assert.equal(result.suppression, 'global');
});

test('managed reply: a failed lead write records nothing (the next pass retries)', async () => {
  const { deps, calls } = pipelineDeps({ applyLeadChange: async () => { throw new Error('Supabase unavailable'); } });
  await assert.rejects(handleManagedClientReply({ lead: joleLead(), replyText: 'Sounds interesting', context, message: { messageId: 'gm-4' } }, deps), /Supabase unavailable/);
  assert.equal(calls.activities.length, 0);
});

test('managed reply: ledger unavailable is logged, the reply is still recorded and the lead still stopped', async () => {
  const { deps, calls } = pipelineDeps({ store: createMemoryLedgerStore({ available: false }) });
  const result = await handleManagedClientReply({ lead: joleLead(), replyText: 'Sounds interesting, tell me more', context, message: { messageId: 'gm-5' } }, deps);
  assert.equal(result.ledger, 'unavailable');
  assert.equal(calls.activities.length, 1);
  assert.equal(calls.leadChanges.length, 1);
});

test('managed reply: refuses without a resolved managed context', async () => {
  const { deps } = pipelineDeps();
  await assert.rejects(handleManagedClientReply({ lead: joleLead(), replyText: 'hi', context: { ok: true, clientId: 'scalelab', policyMode: 'legacy' } }, deps));
});
