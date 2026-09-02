'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  stageSendGate,
} = require('../integrations/pipeline-sequence-safety');
const {
  sequenceRfcMessageId, verifyThreadOwnership, findSuccessfulSequenceSend,
} = require('../integrations/gmail-stage-sequence');
const {
  automaticEnrollmentDecision, provenSequenceSenderId, resolveSequenceThread,
} = require('../integrations/stage-sequences');

const sender = { id: 'secondary', email: 'b@example.com', dailyLimit: 40, sendEligible: true };
const proof = { ok: true, senderInboxId: 'secondary' };
const thread = { threadId: 'T', rfcMessageId: '<old@example.com>' };
const ready = { sendingEnabled: true, senderProof: proof, sender, thread, threadVerified: true,
  observationOk: true, senderCount: 39, globalCount: 79, globalLimit: 80 };

test('CHECK_ONLY makes the stage send gate impossible to pass', () => {
  assert.deepEqual(stageSendGate({ ...ready, checkOnly: true }).code, 'check_only');
});
test('the owning sender 40/day ceiling blocks without migration', () => {
  const gate = stageSendGate({ ...ready, senderCount: 40 });
  assert.equal(gate.allowed, false); assert.equal(gate.code, 'sender_quota');
});
test('the global 80/day ceiling independently blocks', () => {
  const gate = stageSendGate({ ...ready, globalCount: 80 });
  assert.equal(gate.allowed, false); assert.equal(gate.code, 'global_quota');
});
test('missing sender ownership fails closed', () => {
  assert.equal(stageSendGate({ ...ready, senderProof: { ok: false, reason: 'missing' } }).code, 'sender_unproven');
});
test('Gmail observation failure blocks only the candidate using that sender', () => {
  assert.equal(stageSendGate({ ...ready, observationOk: false }).code, 'observation_failed');
  assert.equal(stageSendGate(ready).allowed, true);
});
test('a cross-account or unverified thread fails closed', () => {
  assert.equal(stageSendGate({ ...ready, threadVerified: false }).code, 'thread_mismatch');
});

test('thread resolution is sender-scoped', () => {
  const activities = [
    { occurredAt: '2026-01-01', metadata: JSON.stringify({ senderInboxId: 'primary', gmailThreadId: 'A' }) },
    { occurredAt: '2026-01-02', metadata: JSON.stringify({ senderInboxId: 'secondary', gmailThreadId: 'B' }) },
  ];
  assert.equal(resolveSequenceThread(activities, { senderInboxId: 'primary' }).threadId, 'A');
  assert.equal(resolveSequenceThread(activities, { senderInboxId: 'secondary' }).threadId, 'B');
});
test('conflicting sender evidence is rejected', () => {
  const activities = ['primary', 'secondary'].map((senderInboxId, index) => ({
    eventType: index ? 'follow_up_sent' : 'initial_email_sent',
    metadata: JSON.stringify({ senderInboxId }),
  }));
  assert.equal(provenSequenceSenderId({}, activities).ok, false);
});

test('Gmail thread verification requires an outbound from owning mailbox to this recipient', async () => {
  const gmail = { users: { threads: { get: async () => ({ data: { messages: [{ id: 'M', internalDate: '2', payload: { headers: [
    { name: 'From', value: 'Deins <b@example.com>' }, { name: 'To', value: 'lead@example.com' },
    { name: 'Message-ID', value: '<m@example.com>' },
  ] } }] } }) } } };
  assert.equal((await verifyThreadOwnership({ gmail, threadId: 'T', senderEmail: 'b@example.com', recipientEmail: 'lead@example.com' })).ok, true);
  assert.equal((await verifyThreadOwnership({ gmail, threadId: 'T', senderEmail: 'a@example.com', recipientEmail: 'lead@example.com' })).ok, false);
});
test('provider-success recovery finds the deterministic Message-ID without sending', async () => {
  const id = sequenceRfcMessageId('seq:L:hot:1', 'b@example.com');
  const gmail = { users: { messages: {
    list: async ({ q }) => { assert.match(q, new RegExp(id.replace(/[<>]/g, ''))); return { data: { messages: [{ id: 'M' }] } }; },
    get: async () => ({ data: { id: 'M', threadId: 'T', internalDate: '1788297600000', payload: { headers: [{ name: 'Message-ID', value: id }] } } }),
  } } };
  const recovered = await findSuccessfulSequenceSend({ gmail, rfcMessageId: id });
  assert.equal(recovered.providerMessageId, 'M');
  assert.equal(recovered.rfcMessageId, id);
});

const ev = (eventType, occurredAt, metadata = {}) => ({ eventType, occurredAt, metadata: JSON.stringify(metadata) });
const enrollmentBase = {
  senderProof: proof, thread, now: new Date('2026-09-01T18:00:00Z'),
};

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
const agentSource = source('outreach-agent.js');
const serverSource = source('server.js');
const uiSource = source('public/index.html');
test('verified demo Follow Up auto-enrolls, generic Follow Up does not', () => {
  const verified = automaticEnrollmentDecision({ ...enrollmentBase,
    verdict: { offer: 'demo_follow_up_v1' }, activities: [ev('booking_link_sent', '2026-08-25T18:00:00Z')], twin: {} });
  assert.equal(verified.sequenceId, 'demo_follow_up_v1');
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: null }, activities: [] }).enroll, false);
});
test('stale Hot waiting on prospect auto-enrolls; waiting on us does not', () => {
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: 'hot_stale_v1' }, activities: [],
    hotState: { staleness: 'stale', waitingOn: 'waiting_on_prospect' } }).enroll, true);
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: 'hot_stale_v1' }, activities: [],
    hotState: { staleness: 'stale', waitingOn: 'waiting_on_us' } }).enroll, false);
});
test('explicit no-show and cancellation authorize recovery, elapsed time alone does not', () => {
  const noShow = automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: 'no_show_recovery_v1' },
    callState: { status: 'no_show' }, activities: [ev('meeting_no_show', '2026-09-01T18:00:00Z')] });
  const cancel = automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: 'cancelled_rebook_v1' },
    callState: { status: 'cancelled' }, activities: [ev('meeting_cancelled', '2026-09-01T18:00:00Z')] });
  assert.equal(noShow.authorization, 'explicit_lifecycle'); assert.equal(cancel.enroll, true);
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, verdict: { offer: null }, callState: { status: 'outcome_pending' }, activities: [] }).enroll, false);
});
test('MANUAL HOLD blocks demo and Hot auto-enrollment but explicit lifecycle remains authorized', () => {
  const twin = { notes: '[MANUAL HOLD]' };
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, twin, verdict: { offer: 'hot_stale_v1' }, activities: [],
    hotState: { staleness: 'stale', waitingOn: 'waiting_on_prospect' } }).enroll, false);
  assert.equal(automaticEnrollmentDecision({ ...enrollmentBase, twin, verdict: { offer: 'no_show_recovery_v1' },
    callState: { status: 'no_show' }, activities: [ev('meeting_no_show', '2026-09-01T18:00:00Z')] }).enroll, true);
});

test('CHECK_ONLY returns before every stage, intent, or cold send path', () => {
  const run = agentSource.slice(agentSource.indexOf('async function run()'));
  const exit = run.indexOf("if (CHECK_ONLY) {");
  assert.ok(exit >= 0);
  assert.match(run, /if \(INTENT_ONLY && !CHECK_ONLY\)/, 'check-only also disables the early intent send branch');
  for (const sendPath of ['await runStageSequencePass(', 'const queued = selectQueued(all)']) {
    assert.ok(exit < run.indexOf(sendPath), `${sendPath} must be after the check-only exit`);
  }
});

test('restart recovery probes Gmail before provider delivery and checkpoints strictly', () => {
  const pass = agentSource.slice(agentSource.indexOf('async function runStageSequencePass'), agentSource.indexOf('async function run()'));
  assert.ok(pass.indexOf('findSuccessfulSequenceSend') < pass.indexOf('result = await sendEmail('));
  assert.match(pass, /await recordColdCallActivityStrict\(/);
  assert.match(pass, /eventType: SEQUENCE_EVENTS\.SEND_RESERVED/);
  assert.ok(pass.indexOf('eventType: SEQUENCE_EVENTS.SEND_RESERVED') < pass.indexOf('result = await sendEmail('));
  assert.match(pass, /a durable delivery reservation exists and Gmail has not confirmed it yet/);
  assert.match(pass, /deterministic Message-ID will recover this delivery on the next run; it will not resend/);
});

test('stage successes reduce the same global capacity used by later cold sends', () => {
  const run = agentSource.slice(agentSource.indexOf('async function run()'));
  assert.match(run, /const quotaState = \{ globalCount: todaySent \};/);
  assert.match(run, /todaySent = quotaState\.globalCount;/);
  assert.match(run, /dailyRemaining = Math\.max\(0, DAILY_SEND_LIMIT - todaySent\);/);
  const pass = agentSource.slice(agentSource.indexOf('async function runStageSequencePass'), agentSource.indexOf('async function run()'));
  assert.match(pass, /quotaState\.globalCount = todaySent;/);
});

test('explicit CRM no-show/cancel and trusted Calendar cancel wire automatic enrollment', () => {
  assert.match(serverSource, /if \(action === 'no_show' \|\| action === 'cancel'\) \{/);
  assert.match(serverSource, /planLifecycleAutoEnrollment\(/);
  const calendar = serverSource.slice(serverSource.indexOf('async function applyCalendarPlanItem'), serverSource.indexOf('async function runGoogleCalendarSync'));
  assert.match(calendar, /if \(action === 'cancel'\)/);
  assert.match(calendar, /planLifecycleAutoEnrollment\(/);
});

test('selecting a future timing date creates the one-step timing journey', () => {
  const route = serverSource.slice(serverSource.indexOf("app.put('/api/leads/:id'"), serverSource.indexOf("app.delete('/api/leads/:id'"));
  assert.match(route, /timingDateChanged/);
  assert.match(route, /sequenceId: 'timing_recontact_v1'/);
  assert.match(route, /authorization: 'human_selected_recontact_date'/);
});

test('CRM projection includes authoritative U:W meeting fields and activity writes invalidate cache', () => {
  assert.match(serverSource, /lead\.meetingAt = row\[20\] \|\| '';/);
  assert.match(serverSource, /range\.includes\(COLD_CALL_ACTIVITY_SHEET\)/);
});

test('Pipeline drawer exposes enrollment, step, sender, thread, gate, and block reason', () => {
  for (const label of ['Enrollment', 'Current step', 'Owning sender', 'Thread', 'Send gate']) {
    assert.match(uiSource, new RegExp(`pipeline-row-label">${label}`));
  }
  assert.match(serverSource, /enrollmentMode:/);
  assert.match(serverSource, /threadStatus:/);
  assert.match(serverSource, /sendGate: \{ allowed:/);
});
