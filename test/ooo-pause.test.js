'use strict';

// OOO auto-resume (2026-10-03). An autoresponder pauses cold automation until
// the stated return date (or the 7-day OOO policy) through an append-only
// ooo_resume_scheduled event — never a [MANUAL HOLD], which stays absolute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OOO_RESUME_EVENT, OOO_DEFAULT_RETRY_DAYS, OOO_RESUME_SOURCE,
  planOooResume, buildOooResumeEvent, scheduledOooResume,
} = require('../integrations/ooo-pause');
const { planOooHoldRelease } = require('../integrations/ooo-hold-repair');
const { deriveReplyOperation, REPLY_ACTION, DUE_SOURCE } = require('../integrations/reply-operations');
const { deriveAutomationOwnership, mayColdSend } = require('../integrations/automation-ownership');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agent = read('outreach-agent.js');
const server = read('server.js');

const iso = value => new Date(value).toISOString();
const OOO_AT = '2026-09-30T14:10:51.000Z';          // Summit's autoresponder
const lead = (extra = {}) => ({
  id: 'L1', email: 'kyle@summitservice.com', company: 'Summit Service Solutions', stage: 'Contacted',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-09-30T14:10:46.417Z', notes: '[REPLY: OOO until 2026-10-05]',
  leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'tryscalelabai', ...extra,
});
const row = (eventType, occurredAt, metadata = {}, extra = {}) => ({
  eventId: `${eventType}:${occurredAt}`, leadId: 'CE-L1', sourceLeadId: 'L1', eventType, occurredAt,
  metadata: JSON.stringify(metadata), ...extra,
});
const sent = row('initial_email_sent', '2026-09-30T14:10:46.417Z', { step: 1, senderInboxId: 'tryscalelabai' });
const oooReply = (returnDate = null, at = OOO_AT) => row('out_of_office_reply', at, {
  canonicalState: 'automated_reply', subtype: 'out_of_office', returnDate, gmailMessageId: 'ooo-msg-1',
});
const resume = (resumeAt, resumeSource = OOO_RESUME_SOURCE.POLICY_DEFAULT, at = '2026-09-30T14:30:17.000Z') =>
  row(OOO_RESUME_EVENT, at, { resumeAt, resumeSource, oooMessageId: 'ooo-msg-1' });

function owner(target, activities, now, extra = {}) {
  const verdict = deriveAutomationOwnership(target, {
    activities, sendingEnabled: true, coldCadenceDue: true, now: new Date(now),
    suppressionReason: item => sendSuppressionReason(item, { suppressedEmails: extra.suppressedEmails || new Set() }),
    ...extra,
  });
  return { verdict, allowed: mayColdSend(verdict).allowed };
}

// ── The resume rule ──────────────────────────────────────────────────────────

test('a stated future return date wins; otherwise 7 Vancouver days from the autoresponder', () => {
  assert.deepEqual(planOooResume({ returnDate: '2026-10-05', occurredAt: OOO_AT, now: OOO_AT }),
    { resumeAt: '2026-10-05T00:00:00.000Z', resumeSource: OOO_RESUME_SOURCE.PROSPECT_STATED });
  const policy = planOooResume({ returnDate: '', occurredAt: '2026-10-01T14:48:46.000Z', now: '2026-10-01T15:00:00Z' });
  assert.equal(policy.resumeSource, OOO_RESUME_SOURCE.POLICY_DEFAULT);
  assert.equal(policy.resumeAt, '2026-10-08T14:48:46.000Z');
  assert.equal(OOO_DEFAULT_RETRY_DAYS, 7);
  // A stated date already in the past falls back to the policy, never "now".
  assert.equal(planOooResume({ returnDate: '2026-09-01', occurredAt: OOO_AT, now: OOO_AT }).resumeSource,
    OOO_RESUME_SOURCE.POLICY_DEFAULT);
  // Deterministic: re-processing the same autoresponder later gives the same date.
  assert.deepEqual(planOooResume({ occurredAt: OOO_AT, now: '2026-09-30T15:00:00Z' }),
    planOooResume({ occurredAt: OOO_AT, now: '2026-10-02T15:00:00Z' }));
});

test('the resume event is append-only metadata with a stable id and no message text', () => {
  const event = buildOooResumeEvent({ lead: lead(), oooMessageId: 'ooo-msg-1', oooOccurredAt: OOO_AT,
    resumeAt: '2026-10-05T00:00:00.000Z', resumeSource: OOO_RESUME_SOURCE.PROSPECT_STATED, occurredAt: '2026-09-30T14:30:00Z' });
  assert.equal(event.eventId, 'ooo-resume:L1:ooo-msg-1');
  assert.equal(event.eventType, OOO_RESUME_EVENT);
  assert.equal(event.content, '');
  assert.deepEqual(JSON.parse(event.metadata), {
    resumeAt: '2026-10-05T00:00:00.000Z', resumeSource: 'prospect_stated', oooMessageId: 'ooo-msg-1',
    oooOccurredAt: OOO_AT, by: 'reply-auto',
  });
});

// ── OOO with a known return date ─────────────────────────────────────────────

test('OOO with a known return date: waits until it, then cold automation resumes', () => {
  const acts = [sent, oooReply('2026-10-05'), resume('2026-10-05T00:00:00.000Z', OOO_RESUME_SOURCE.PROSPECT_STATED)];
  const op = deriveReplyOperation(lead(), { activities: acts });
  assert.equal(op.action, REPLY_ACTION.WAIT_UNTIL_RETURN);
  assert.equal(op.dueAt, '2026-10-05T00:00:00.000Z');
  assert.equal(op.dueAtSource, DUE_SOURCE.PROSPECT_STATED);
  const before = owner(lead(), acts, '2026-10-02T15:00:00Z');
  assert.equal(before.verdict.blockedBy, 'waiting_until_date');
  assert.equal(before.allowed, false);
  const after = owner(lead(), acts, '2026-10-05T14:00:00Z');
  assert.equal(after.verdict.owner, 'cold_automation');
  assert.equal(after.allowed, true);
});

// ── OOO with "retry in N days" ───────────────────────────────────────────────

test('OOO with no date ("retry in 7 days"): the policy date gates, then automation resumes', () => {
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z')];
  const op = deriveReplyOperation(lead({ notes: '[REPLY: OOO — retry in 7d]' }), { activities: acts });
  assert.equal(op.action, REPLY_ACTION.WAIT_UNTIL_RETURN);
  assert.equal(op.dueAtSource, DUE_SOURCE.OOO_POLICY);
  const before = owner(lead(), acts, '2026-10-07T14:00:00Z');
  assert.equal(before.allowed, false);
  assert.match(before.verdict.reason, /7-day OOO policy/);
  assert.equal(owner(lead(), acts, '2026-10-07T14:30:00Z').allowed, true);
});

test('an OOO handled before this change (no resume event) still waits with nothing due — Mc Labor stays manual', () => {
  const acts = [sent, oooReply(null)];
  const { verdict, allowed } = owner(lead({ notes: '[REPLY: OOO — retry in 7d]' }), acts, '2026-10-30T15:00:00Z');
  assert.equal(verdict.blockedBy, 'nothing_due');
  assert.equal(allowed, false);
});

test('a newer autoresponder is never answered by an older resume record', () => {
  const second = oooReply(null, '2026-10-08T15:00:00.000Z');
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z'), second];
  assert.equal(scheduledOooResume(acts, { since: second.occurredAt }), null);
  assert.equal(owner(lead(), acts, '2026-10-09T15:00:00Z').allowed, false, 'falls back to waiting with nothing due');
});

// ── Everything else still outranks the pause ─────────────────────────────────

test('manual hold without auto-resume: a person\'s hold is absolute even after the OOO date', () => {
  const acts = [sent, oooReply('2026-10-05'), resume('2026-10-05T00:00:00.000Z', OOO_RESUME_SOURCE.PROSPECT_STATED)];
  const held = lead({ notes: `${MANUAL_HOLD_TAG} [REPLY: OOO until 2026-10-05]` });
  const { verdict, allowed } = owner(held, acts, '2026-10-20T15:00:00Z');
  assert.equal(verdict.blockedBy, 'manual_hold');
  assert.equal(allowed, false);
});

test('unsubscribe while OOO: suppressed before and after the resume date', () => {
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z'),
    row('unsubscribe_reply', '2026-10-02T15:00:00.000Z', { canonicalState: 'negative', reason: 'unsubscribe_request' })];
  const target = lead({ notes: '[REPLY: Unsubscribed] [REPLY: OOO — retry in 7d]' });
  for (const now of ['2026-10-03T15:00:00Z', '2026-10-20T15:00:00Z']) {
    const { verdict, allowed } = owner(target, acts, now);
    assert.equal(verdict.blockedBy, 'suppression', now);
    assert.equal(allowed, false);
  }
});

test('human reply before resume: a person owns the lead before and after the date', () => {
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z'),
    row('question_reply', '2026-10-03T15:00:00.000Z', { canonicalState: 'needs_human', reason: 'question_or_objection', gmailMessageId: 'q1' })];
  for (const now of ['2026-10-04T15:00:00Z', '2026-10-20T15:00:00Z']) {
    const { verdict, allowed } = owner(lead(), acts, now);
    assert.equal(verdict.owner, 'human', now);
    assert.equal(allowed, false);
  }
});

test('booking before resume: the meeting owns the lead', () => {
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z'), row('call_booked', '2026-10-03T15:00:00.000Z')];
  const { verdict, allowed } = owner(lead(), acts, '2026-10-20T15:00:00Z', {
    boardLead: { id: 'B1', stage: 'demo_booked', email: lead().email }, callState: { status: 'scheduled' },
  });
  assert.equal(verdict.owner, 'meeting');
  assert.equal(allowed, false);
});

test('suppression before resume: the durable list refuses after the date', () => {
  const acts = [sent, oooReply(null), resume('2026-10-07T14:10:51.000Z')];
  const { verdict, allowed } = owner(lead(), acts, '2026-10-20T15:00:00Z', { suppressedEmails: new Set([lead().email]) });
  assert.equal(verdict.blockedBy, 'suppression');
  assert.equal(allowed, false);
});

// ── The handler and the same-pass guarantee ──────────────────────────────────

test('the OOO handler records the pause and never writes a hold or resume tag', () => {
  const handler = agent.slice(agent.indexOf('async function handleOutOfOffice('), agent.indexOf('async function handleWrongPerson'));
  assert.doesNotMatch(handler, /applyHoldToNotes|applyResumeToNotes|\[MANUAL HOLD\]'/);
  assert.match(handler, /const plan = planOooResume\(\{ returnDate, occurredAt, now: Date\.now\(\) \}\);/);
  // Idempotent per autoresponder, and the event lands before the notes marker.
  assert.match(handler, /if \(!\(activities \|\| \[\]\)\.some\(row => row\.eventId === event\.eventId\)\) \{/);
  assert.ok(handler.indexOf('recordColdCallActivityStrict(event)') < handler.indexOf('applyLeadChange('));
  assert.match(handler, /activities\.push\(event\)/, 'visible to the same pass');
  assert.match(agent, /result = await handleOutOfOffice\(lead, \{\n\s*returnDate: canonicalReply\.returnDate \|\| '', occurredAt: message\.occurredAt,\n\s*messageId: message\.messageId \|\| '', activities: attributionActivities,/);
});

test('same pass: the send pass\'s ownership context is built after the reply pass, from the same activities', () => {
  const replyPass = agent.indexOf('const replyObservation = await runReplyCheckPass(all, todaySent, outbound.ok, ownershipActivities);');
  const context = agent.indexOf('const ownershipContext = buildOwnershipContext({');
  assert.ok(replyPass > 0 && context > replyPass);
  assert.match(agent, /if \(!attributionActivities\) attributionActivities = activitiesForCycle \|\| await readColdCallActivities\(\);/);
});

test('the reply decision records an OOO pause, not a hold', () => {
  const decisionSrc = read('integrations/reply-decision.js');
  assert.match(decisionSrc, /case ROUTE\.OUT_OF_OFFICE:\n\s*return \{ executedAction: ACTION\.WAIT_OUT_OF_OFFICE, status: EXECUTION_STATUS\.WAITING, effects: \[EFFECT\.OOO_PAUSE_SCHEDULED\] \};/);
  assert.match(decisionSrc, /OOO_PAUSE_SCHEDULED: 'ooo_pause_scheduled'/);
});

// ── One-off repair of leads the old handler held ─────────────────────────────

const heldLead = (extra = {}) => lead({ notes: `${MANUAL_HOLD_TAG} [REPLY: OOO until 2026-10-05] [STAFFING HIGH] note`, ...extra });
const decision = row('reply_decision_recorded', '2026-09-30T14:30:17.853Z', { route: 'out_of_office', effects: ['hold_applied'] });
const NOW = '2026-10-03T22:00:00.000Z';
const plan = (overrides = {}) => planOooHoldRelease({
  lead: heldLead(), activities: [sent, oooReply('2026-10-05'), decision], suppressedEmails: new Set(),
  resumeAt: '2026-10-05T00:00:00.000Z', by: 'Deins', now: NOW, ...overrides,
});

test('repair: a hold the OOO handler applied is released into a dated OOO pause', () => {
  const result = plan();
  assert.equal(result.ok, true, result.refusals.join('; '));
  assert.equal(result.nextNotes, '[REPLY: OOO until 2026-10-05] [STAFFING HIGH] note');
  assert.equal(result.event.eventType, OOO_RESUME_EVENT);
  assert.equal(result.event.eventId, 'ooo-resume:L1:ooo-msg-1:repair');
  assert.equal(JSON.parse(result.event.metadata).resumeSource, OOO_RESUME_SOURCE.OPERATOR_REPAIR);
  assert.equal(JSON.parse(result.event.metadata).by, 'Deins');
  assert.equal(result.checks.statedReturnDate, '2026-10-05');
  assert.equal(plan().fingerprint, result.fingerprint, 'stable for the same reviewed state');
  // After the release the lead is not sendable before the resume instant.
  const after = [sent, oooReply('2026-10-05'), decision, result.event];
  assert.equal(owner(heldLead({ notes: result.nextNotes }), after, '2026-10-04T15:00:00Z').allowed, false);
  assert.equal(owner(heldLead({ notes: result.nextNotes }), after, '2026-10-05T14:00:00Z').allowed, true);
});

test('repair refuses anything a person decided or that makes automation wrong', () => {
  const refused = (overrides, pattern) => {
    const result = plan(overrides);
    assert.equal(result.ok, false);
    assert.ok(result.refusals.some(text => pattern.test(text)), `${pattern} in ${result.refusals.join(' | ')}`);
  };
  refused({ by: '' }, /by is required/);
  refused({ lead: lead() }, /not on \[MANUAL HOLD\]/);
  refused({ lead: heldLead({ notes: `${MANUAL_HOLD_TAG} note` }) }, /no OOO marker/);
  refused({ activities: [sent, oooReply('2026-10-05')] }, /no reply decision proves/);
  refused({ activities: [sent, oooReply('2026-10-05'), decision, row('automation_held', '2026-10-01T00:00:00Z')] }, /a person also applied a manual hold/);
  refused({ activities: [sent, oooReply('2026-10-05'), decision, row('positive_reply', '2026-10-02T00:00:00Z')] }, /genuine reply arrived after the OOO/);
  refused({ activities: [sent, oooReply('2026-10-05'), decision, row('human_response_sent', '2026-10-02T00:00:00Z')] }, /a person answered/);
  refused({ activities: [sent, oooReply('2026-10-05'), decision, row('call_booked', '2026-10-02T00:00:00Z')] }, /a booking exists/);
  refused({ suppressedEmails: new Set([lead().email]) }, /suppression-list/);
  refused({ lead: heldLead({ notes: `${MANUAL_HOLD_TAG} [REPLY: Unsubscribed] [REPLY: OOO until 2026-10-05]` }) }, /Unsubscribed/);
  refused({ lead: heldLead({ emailStatus: 'replied' }) }, /not an active cold sequence/);
  refused({ resumeAt: 'soon' }, /valid date/);
  refused({ resumeAt: '2026-09-01T00:00:00Z' }, /before the OOO reply/);
  refused({ resumeAt: '2027-03-01T00:00:00Z' }, /more than 60 days out/);
});

test('repair route: plan then apply the reviewed fingerprint; never sends; never during a pass', () => {
  const get = server.slice(server.indexOf("app.get('/api/ops/ooo-hold-release/:id'"), server.indexOf("app.post('/api/ops/ooo-hold-release/:id'"));
  const post = server.slice(server.indexOf("app.post('/api/ops/ooo-hold-release/:id'"), server.indexOf("app.get('/api/ops/agent-v2'"));
  assert.match(get, /requireAuth/);
  assert.match(get, /dryRun: true/);
  assert.match(post, /requireAuth/);
  assert.match(post, /if \(agentState\.running \|\| automationLaunchReserved\) \{/);
  assert.match(post, /if \(!plan\.ok\) return res\.status\(409\)/);
  assert.match(post, /String\(req\.body\?\.fingerprint \|\| ''\) !== plan\.fingerprint/);
  assert.ok(post.indexOf('appendMissingEvents([plan.event]') < post.indexOf('applyLeadChange(leadId'),
    'the pause is recorded before the hold is released');
  assert.match(post, /expectedState: \{ notes: state\.lead\.notes \}, releaseMarkers: \[MANUAL_HOLD_TAG\],/);
  for (const forbidden of ['sendEmail', 'messages.send', 'withOutboundReservation', 'spawnAgent', 'resumeIntent']) {
    assert.ok(!post.includes(forbidden), `the repair route must not use ${forbidden}`);
  }
  assert.match(server, /return \{ state, status: 409, error: 'this lead has a Pipeline card; release its hold through Resume' \};/);
});
