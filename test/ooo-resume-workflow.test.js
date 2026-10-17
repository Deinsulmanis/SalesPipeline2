'use strict';

// The OOO workflow end to end (2026-10-15): an autoresponder pauses the cold
// sequence until a STATED return date, then the sequence continues at the next
// unsent touch — never Touch 1 again — with one line of context, through every
// ordinary gate. An absence with no reliable date is human review, never an
// invented date. Numbered tests 1–20 are the required regression scenarios;
// the "production" block replays the seven live OOO leads of 2026-10-15.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyReplyText, extractReturnDate, resolveReplyState, isGenuineHumanReply } = require('../integrations/canonical-reply');
const {
  planOooResume, buildOooResumeEvent, scheduledOooResume, oooPauseState, oooResumeCopy,
  OOO_RESUME_SOURCE, OOO_PAUSE_STATUS,
} = require('../integrations/ooo-pause');
const { planOooResumeSchedule } = require('../integrations/ooo-hold-repair');
const { deriveReplyOperation, REPLY_ACTION } = require('../integrations/reply-operations');
const { deriveAutomationOwnership, mayColdSend } = require('../integrations/automation-ownership');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');
const { isFollowUpDue, nextFollowUp, stepAlreadySent, nextSendWindowAt, SEND_WINDOW_CRON } = require('../integrations/sequence-timing');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { createClientCapacityState, clientCapacityVerdict } = require('../integrations/clients/capacity');
const { staffingSendBlockReason } = require('../integrations/staffing-launch-gate');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { resolveColdFollowUpThread } = require('../integrations/gmail-threading');
const { responseNeed } = require('../integrations/reply-decision');
const { orphanedHumanReplies } = require('../integrations/reply-watchdog');
const { renderStaffingEmail, validateStaffingEmail, STAFFING_CAMPAIGN, OOO_RESUME_CONTEXT_LINE } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agent = read('outreach-agent.js');
const server = read('server.js');

const LIVE_ENV = { STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' };
const RENDER_ENV = { COMMERCIAL_MAILING_ADDRESS: '500 ScaleLab Way, Vancouver, BC V6B 1A1' };
const T1 = '2026-10-12T14:49:11.000Z';

const lead = (extra = {}) => ({
  id: 'L1', email: 'pat@summitlaborgroup.com', company: 'Agency Staffing', firstName: 'Pat', stage: 'Contacted',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: T1, notes: '', clientId: 'scalelab',
  leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary', siteContext: 'Saw you place welders.',
  ...extra,
});
let seq = 0;
const ev = (eventType, occurredAt, metadata = {}, extra = {}) => ({
  eventId: `${eventType}:${++seq}`, leadId: 'CE-L1', sourceLeadId: 'L1', eventType, occurredAt,
  subject: '', content: '', metadata: JSON.stringify(metadata), ...extra,
});
const touch = (step, at, { sender = 'primary', thread = 'thr-1' } = {}) => ev(step === 1 ? 'initial_email_sent' : 'follow_up_sent', at, {
  step, sequenceStep: step, senderInboxId: sender, gmailMessageId: `msg-step-${step}`, gmailThreadId: thread,
}, { subject: step === 1 ? 'employer accounts' : 'Re: employer accounts' });

/** The reply pass for one autoresponder: the recorded reply plus whatever the handler schedules. */
function receiveOoo(target, text, at, { subject = 'Automatic reply: employer accounts', messageId = `ooo-${++seq}` } = {}) {
  const canonical = classifyReplyText(text, { subject, now: at });
  const reply = ev('out_of_office_reply', at, {
    canonicalState: canonical.state, subtype: canonical.subtype, returnDate: canonical.returnDate,
    genuineHuman: canonical.genuineHuman, gmailMessageId: messageId, gmailThreadId: `ooo-thread-${messageId}`,
  }, { eventId: `gmail-reply:${messageId}`, content: text, subject });
  const plan = planOooResume({ returnDate: canonical.returnDate || '', occurredAt: at, subtype: canonical.subtype });
  const rows = [reply];
  if (plan.resumeAt) {
    rows.push(buildOooResumeEvent({ lead: target, oooMessageId: messageId, oooOccurredAt: at,
      resumeAt: plan.resumeAt, resumeSource: plan.resumeSource, statedReturnDate: plan.statedReturnDate,
      occurredAt: new Date(Date.parse(at) + 60000).toISOString() }));
  }
  return { canonical, plan, rows, messageId };
}

function owner(target, activities, now, { env = LIVE_ENV, suppressedEmails = new Set(), sendingEnabled = true, ...extra } = {}) {
  const verdict = deriveAutomationOwnership(target, {
    activities, sendingEnabled, coldCadenceDue: true, now: new Date(now),
    suppressionReason: item => staffingSendBlockReason(item, env) || sendSuppressionReason(item, { suppressedEmails }),
    ...extra,
  });
  return { verdict, allowed: mayColdSend(verdict).allowed };
}

/** What one scheduler pass would do with this lead at `now` (selection + gates + copy). */
function schedulerPass(target, activities, now, options = {}) {
  const gate = owner(target, activities, now, options);
  const due = isFollowUpDue(target, Date.parse(now), { activities });
  const next = nextFollowUp(target, { activities });
  const copy = next ? oooResumeCopy(target, activities, { step: next.nextStep, now: Date.parse(now) }) : null;
  const sends = gate.allowed && due && !copy?.refusal;
  return { sends, step: sends ? next.nextStep : null, contextLine: Boolean(sends && copy?.contextLine), gate, due, copy };
}

/** Record a delivered touch the way markSent does: ledger row plus the row's step and timestamp. */
function deliver(target, activities, step, at) {
  return { lead: { ...target, emailStep: String(step), lastEmailedAt: at }, activities: [...activities, touch(step, at)] };
}

// ── 1–3. Return dates ────────────────────────────────────────────────────────

test('1. explicit return date: held until "back October 21", then resumes at the next touch', () => {
  const sent = [touch(1, T1)];
  const ooo = receiveOoo(lead(), 'Thanks for your note. I am out of the office and will be back October 21.', '2026-10-12T14:49:24.000Z');
  assert.equal(ooo.canonical.returnDate, '2026-10-21');
  assert.equal(ooo.plan.resumeAt, '2026-10-21T07:00:00.000Z', '00:00 Vancouver on the stated day');
  const acts = [...sent, ...ooo.rows];
  for (const now of ['2026-10-15T16:00:00Z', '2026-10-20T18:00:00Z', '2026-10-21T06:59:00Z']) {
    const pass = schedulerPass(lead(), acts, now);
    assert.equal(pass.sends, false, now);
    assert.equal(pass.gate.verdict.blockedBy, 'waiting_until_date', now);
  }
  const back = schedulerPass(lead(), acts, '2026-10-21T14:00:00Z');   // 07:00 PT, Wednesday
  assert.equal(back.sends, true);
  assert.equal(back.step, 2, 'Touch 2 — never Touch 1 again');
  assert.equal(back.contextLine, true);
  assert.equal(oooPauseState(lead(), acts, { now: '2026-10-21T14:00:00Z' }).status, OOO_PAUSE_STATUS.RESUME_DUE);
});

test('2. no return date: OOO detected, no invented date, held for human review', () => {
  const ooo = receiveOoo(lead(), 'I am currently out of the office with limited access to email.', '2026-10-12T15:00:00.000Z');
  assert.equal(ooo.canonical.state, 'automated_reply');
  assert.equal(ooo.canonical.subtype, 'out_of_office');
  assert.equal(ooo.canonical.returnDate, null);
  assert.equal(ooo.plan.resumeAt, null);
  assert.equal(ooo.plan.reviewRequired, true);
  assert.deepEqual(ooo.rows.map(row => row.eventType), ['out_of_office_reply'], 'no resume is scheduled');
  const acts = [touch(1, T1), ...ooo.rows];
  const op = deriveReplyOperation(lead(), { activities: acts });
  assert.equal(op.action, REPLY_ACTION.OOO_REVIEW);
  assert.equal(op.dueAt, null);
  assert.equal(op.requiresHumanReview, true);
  for (const now of ['2026-10-13T16:00:00Z', '2026-10-19T16:00:00Z', '2026-12-01T16:00:00Z']) {
    const pass = schedulerPass(lead(), acts, now);
    assert.equal(pass.sends, false, now);
    assert.equal(pass.gate.verdict.owner, 'human', `${now}: a person owns it, it is not silently parked`);
  }
  assert.equal(oooPauseState(lead(), acts).status, OOO_PAUSE_STATUS.REVIEW_REQUIRED);
});

test('3. vague or unreliable return date: low confidence, no unsafe resume', () => {
  const now = '2026-10-15T15:00:00.000Z';
  for (const text of [
    "I'll be away for a while.", 'Currently out of office.', 'Returning next week.', 'Back next Monday.',
    'Back on the 21st.', 'Out until 21/10.', 'Back Monday, October 21.',  // Oct 21 2026 is a Wednesday
    'I will not be available until Monday, 10//05/26.', 'Out until Oct 16, back Oct 30.', 'Back March 1.',
  ]) {
    assert.equal(extractReturnDate(text, { now }), '', text);
    const ooo = receiveOoo(lead(), `I am out of the office. ${text}`, now);
    assert.equal(ooo.plan.resumeAt, null, text);
    assert.equal(ooo.canonical.confidence, 'medium', `${text}: an undated reading is never high confidence`);
    assert.equal(schedulerPass(lead(), [touch(1, T1), ...ooo.rows], '2026-11-30T16:00:00Z').sends, false, text);
  }
  // The confident forms the task names.
  for (const [text, iso] of [['Back October 21', '2026-10-21'], ['Returning Oct 21', '2026-10-21'],
    ['Out until 10/21', '2026-10-21'], ['Back Monday, October 19', '2026-10-19'], ['back Oct. 19th, 2026', '2026-10-19'],
    ['will return on 19 October', '2026-10-19'], ['out until 10/21/26', '2026-10-21'], ["I'm out until Monday", '2026-10-19']]) {
    assert.equal(extractReturnDate(text, { now }), iso, text);
  }
  // Year rollover is read from the message's own date, never the clock.
  assert.equal(extractReturnDate('back January 5', { now: '2026-12-20T15:00:00Z' }), '2027-01-05');
});

// ── 4–8. Repeat OOO and precedence ───────────────────────────────────────────

test('4. repeat OOO: the second autoresponder governs; one active resume only', () => {
  const first = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const second = receiveOoo(lead(), 'Out of office, back October 28.', '2026-10-21T15:00:00.000Z');
  const acts = [touch(1, T1), ...first.rows, ...second.rows];
  const active = scheduledOooResume(acts, { since: second.rows[0].occurredAt });
  assert.equal(active.resumeAt, '2026-10-28T07:00:00.000Z');
  assert.equal(oooPauseState(lead(), acts, { now: '2026-10-22T00:00:00Z' }).resumeEventId, second.rows[1].eventId);
  assert.notEqual(first.rows[1].eventId, second.rows[1].eventId);
  assert.equal(schedulerPass(lead(), acts, '2026-10-22T16:00:00Z').sends, false, 'the older date no longer answers');
  assert.equal(schedulerPass(lead(), acts, '2026-10-28T15:00:00Z').sends, true);
  // A second OOO with no date is never answered by the first one's schedule.
  const undated = receiveOoo(lead(), 'I am currently out of the office.', '2026-10-21T15:00:00.000Z');
  const acts2 = [touch(1, T1), ...first.rows, ...undated.rows];
  assert.equal(oooPauseState(lead(), acts2).status, OOO_PAUSE_STATUS.REVIEW_REQUIRED);
  assert.equal(schedulerPass(lead(), acts2, '2026-11-02T16:00:00Z').sends, false);
});

test('5. human reply before the return date: the resume is obsolete, the reply is handled normally', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const question = ev('question_reply', '2026-10-16T15:00:00.000Z', {
    canonicalState: 'needs_human', reason: 'question_or_objection', gmailMessageId: 'q1', genuineHuman: true,
  });
  const acts = [touch(1, T1), ...ooo.rows, question];
  assert.equal(oooPauseState(lead(), acts).status, OOO_PAUSE_STATUS.SUPERSEDED);
  for (const now of ['2026-10-17T16:00:00Z', '2026-10-21T16:00:00Z', '2026-11-05T16:00:00Z']) {
    const pass = schedulerPass(lead(), acts, now);
    assert.equal(pass.sends, false, now);
    assert.equal(pass.gate.verdict.owner, 'human', now);
  }
  assert.equal(oooResumeCopy(lead(), acts, { step: 2 }).resumed, false);
});

test('6. unsubscribe after OOO: suppression wins and the lead never resumes', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const unsub = ev('unsubscribe_reply', '2026-10-16T15:00:00.000Z', { canonicalState: 'negative', reason: 'unsubscribe_request' });
  const target = lead({ stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed] [REPLY: OOO until 2026-10-21]' });
  for (const now of ['2026-10-17T16:00:00Z', '2026-10-21T16:00:00Z']) {
    assert.equal(schedulerPass(target, [touch(1, T1), ...ooo.rows, unsub], now, { suppressedEmails: new Set([target.email]) }).sends, false);
    assert.equal(owner(target, [touch(1, T1), ...ooo.rows, unsub], now).verdict.blockedBy, 'suppression');
  }
});

test('7. negative reply after OOO: the negative state wins and the lead never resumes', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const no = ev('negative_reply', '2026-10-16T15:00:00.000Z', { canonicalState: 'negative', reason: 'explicit_rejection', genuineHuman: true });
  const target = lead({ stage: 'Done', emailStatus: 'done', notes: '[REPLY: Not Interested] [REPLY: OOO until 2026-10-21]' });
  const acts = [touch(1, T1), ...ooo.rows, no];
  assert.equal(deriveReplyOperation(target, { activities: acts }).action, REPLY_ACTION.NO_ACTION_SUPPRESSED);
  assert.equal(oooPauseState(target, acts).status, OOO_PAUSE_STATUS.SUPERSEDED);
  assert.equal(schedulerPass(target, acts, '2026-10-22T16:00:00Z').sends, false);
});

test('8. manual hold after OOO: the hold wins after the return date', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const target = lead({ notes: `${MANUAL_HOLD_TAG} [REPLY: OOO until 2026-10-21]` });
  const pass = schedulerPass(target, [touch(1, T1), ...ooo.rows], '2026-10-22T16:00:00Z');
  assert.equal(pass.sends, false);
  assert.equal(pass.gate.verdict.blockedBy, 'manual_hold');
});

// ── 9–11. Sequence integrity ─────────────────────────────────────────────────

test('9. sequence preservation: Touch 1 already sent, the resume sends Touch 2, never Touch 1', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  assert.equal(stepAlreadySent(lead(), acts, 1), true);
  assert.equal(schedulerPass(lead(), acts, '2026-10-21T15:00:00Z').step, 2);
  const state = oooPauseState(lead(), acts, { now: '2026-10-21T15:00:00Z' });
  assert.equal(state.ledgerLastStep, 1);
  assert.equal(state.nextStep, 2);
  // Touch 1 can never carry the resume line, and a row that lies about the step defers.
  assert.throws(() => renderStaffingEmail(lead(), 1, { oooResumeContext: true, env: RENDER_ENV }), /only a staffing follow-up/);
  const stale = oooResumeCopy(lead({ emailStep: '2' }), acts, { step: 3, now: '2026-10-21T15:00:00Z' });
  assert.match(stale.refusal, /ledger shows Touch 1 sent but the row says step 2/);
});

test('10. Touch 2 sent before the OOO: the resume targets Touch 3', () => {
  const at2 = '2026-10-15T14:30:00.000Z';
  const ooo = receiveOoo(lead(), 'Out of office, back October 26.', '2026-10-15T14:30:09.000Z');
  const target = lead({ emailStep: '2', lastEmailedAt: at2 });
  const acts = [touch(1, T1), touch(2, at2), ...ooo.rows];
  assert.equal(schedulerPass(target, acts, '2026-10-23T16:00:00Z').sends, false, 'Touch 3 is due, but they are away');
  const back = schedulerPass(target, acts, '2026-10-26T15:00:00Z');
  assert.equal(back.sends, true);
  assert.equal(back.step, 3);
  assert.match(oooResumeCopy(target, acts, { step: 2, now: '2026-10-26T15:00:00Z' }).refusal, /next unsent touch is 3/);
});

test('11. duplicate scheduler execution: one reservation id per step, one send', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  const now = '2026-10-21T15:00:00.000Z';
  const first = schedulerPass(lead(), acts, now);
  const again = schedulerPass(lead(), acts, now);
  assert.equal(first.sends && again.sends, true, 'before the send, every pass agrees on the same touch');
  assert.equal(ordinaryColdActionId('L1', first.step), ordinaryColdActionId('L1', again.step), 'one durable reservation key');
  // Once Touch 2 is recorded, no pass offers it again — including a pass whose
  // row checkpoint failed and still says step 1.
  const after = deliver(lead(), acts, 2, '2026-10-21T15:00:05.000Z');
  for (const target of [after.lead, lead()]) {
    const pass = schedulerPass(target, after.activities, '2026-10-21T15:30:00Z');
    assert.equal(pass.sends, false);
  }
  const later = Date.parse('2026-10-21T15:30:00Z');
  assert.equal(oooPauseState(after.lead, after.activities, { now: later }).status, OOO_PAUSE_STATUS.RESUMED);
  const touch3 = oooResumeCopy(after.lead, after.activities, { step: 3, now: later });
  assert.deepEqual([touch3.resumed, touch3.contextLine], [false, false], 'the context line is used once');
  // The send path keeps its single durable reservation and provider recovery.
  const start = agent.indexOf('async function deliverOrdinaryColdStep(');
  const deliverSrc = agent.slice(start, agent.indexOf('\n}\n', start));
  assert.match(deliverSrc, /an unresolved delivery reservation exists and Gmail has not confirmed it/);
  assert.match(deliverSrc, /recovered = await findSuccessfulSequenceSend/);
  assert.ok(deliverSrc.indexOf('oooResumeCopy(') < deliverSrc.indexOf('await recordColdCallActivityStrict(reservation)'),
    'the resume is decided before any reservation');
});

// ── 12–16. Capacity, windows and stronger blocks ─────────────────────────────

const SENDERS = [
  { id: 'primary', email: 'primary@scalelab.example', status: 'active', sendEligible: true, credentialConfigured: true, dailyLimit: 60, perRunLimit: 6 },
  { id: 'tryscalelabai', email: 'try@scalelab.example', status: 'active', sendEligible: true, credentialConfigured: true, dailyLimit: 60, perRunLimit: 6 },
];

test('12. sender daily cap reached: the resume waits, then sends when capacity returns', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  assert.equal(schedulerPass(lead(), acts, '2026-10-21T15:00:00Z').sends, true);
  const full = chooseSender({ lead: lead(), activities: acts, senders: SENDERS, sendsToday: new Map([['primary', 60]]), step: 2 });
  assert.equal(full.sender, null);
  assert.equal(full.reason, 'pinned sender daily limit reached', 'never borrowed by another inbox');
  const windowFull = chooseSender({ lead: lead(), activities: acts, senders: SENDERS, sendsToday: new Map(),
    windowRemainingBySender: new Map([['primary', 0]]), step: 2 });
  assert.equal(windowFull.reason, 'pinned sender scheduled-window limit reached');
  const later = chooseSender({ lead: lead(), activities: acts, senders: SENDERS, sendsToday: new Map(), step: 2 });
  assert.equal(later.sender.id, 'primary');
  // The resume is still due on the later pass: deferral loses nothing.
  assert.equal(schedulerPass(lead(), acts, '2026-10-22T15:00:00Z').step, 2);
});

test('13. outside a send window: nothing sends until the next normal window', () => {
  // Back Saturday October 17: eligible from 00:00 Saturday, but sends only run
  // in the weekday windows, so the first possible send is Monday 07:00.
  const ooo = receiveOoo(lead(), 'Out of office, back Saturday, October 17.', '2026-10-12T15:00:00.000Z');
  assert.equal(ooo.plan.resumeAt, '2026-10-17T07:00:00.000Z');
  assert.equal(new Date(nextSendWindowAt(Date.parse(ooo.plan.resumeAt))).toISOString(), '2026-10-19T14:00:00.000Z');
  assert.equal(SEND_WINDOW_CRON, '0,30 7-11 * * 1-5', 'the scheduler is the only trigger and runs weekdays only');
  // Nothing in the OOO path triggers a send or bypasses the scheduler.
  const handler = agent.slice(agent.indexOf('async function handleOutOfOffice('), agent.indexOf('async function handleWrongPerson('));
  for (const forbidden of ['sendEmail', 'deliverOrdinaryColdStep', 'runAgent', 'messages.send']) {
    assert.ok(!handler.includes(forbidden), `the OOO handler must not call ${forbidden}`);
  }
});

test('14. campaign disabled before the return date: no resume', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  const paused = schedulerPass(lead(), acts, '2026-10-22T16:00:00Z', { env: {} });
  assert.equal(paused.sends, false, 'staffing launch switch off');
  assert.equal(paused.gate.verdict.blockedBy, 'suppression');
  const killSwitch = schedulerPass(lead(), acts, '2026-10-22T16:00:00Z', { sendingEnabled: false });
  assert.equal(killSwitch.sends, false);
  assert.equal(killSwitch.gate.verdict.blockedBy, 'sending_disabled');
});

test('15. client or sender sending disabled before the return date: no resume', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  assert.equal(schedulerPass(lead(), acts, '2026-10-22T16:00:00Z').sends, true, 'ownership alone would allow it');
  const disabled = createClientCapacityState({ globalDailyLimit: 200, globalWindowLimit: 25,
    sendBlock: id => (id === 'scalelab' ? { code: 'client_sending_disabled', reason: 'client sending is disabled' } : null) });
  const verdict = clientCapacityVerdict(disabled, 'scalelab');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'client_sending_disabled');
  const pausedSender = SENDERS.map(item => (item.id === 'primary' ? { ...item, status: 'paused', sendEligible: false } : item));
  assert.throws(() => chooseSender({ lead: lead(), activities: acts, senders: pausedSender, sendsToday: new Map(), step: 2 }),
    /pinned sender primary is not delivery eligible/, 'never moved to another inbox either');
});

test('16. bounce or suppression after OOO: no resume', () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  const listed = schedulerPass(lead(), acts, '2026-10-22T16:00:00Z', { suppressedEmails: new Set(['pat@summitlaborgroup.com']) });
  assert.equal(listed.sends, false);
  assert.equal(listed.gate.verdict.blockedBy, 'suppression');
  const bounced = schedulerPass(lead({ emailStatus: 'done', notes: '[BOUNCED] hard bounce' }), acts, '2026-10-22T16:00:00Z');
  assert.equal(bounced.sends, false);
});

// ── 17–20. Thread, reply semantics, watchdog, idempotency ────────────────────

test('17. the resumed email stays in the original conversation thread', async () => {
  const ooo = receiveOoo(lead(), 'Out of office, back October 21.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...ooo.rows];
  const gmail = { users: { messages: { get: async ({ id }) => ({ data: {
    id, threadId: 'thr-1',
    payload: { headers: [{ name: 'Message-ID', value: '<step1@scalelab.example>' }, { name: 'To', value: 'pat@summitlaborgroup.com' }] },
  } }) } } };
  const thread = await resolveColdFollowUpThread({ gmail, lead: lead(), activities: acts, expectedSenderId: 'primary' });
  assert.equal(thread.threadId, 'thr-1', 'the autoresponder\'s own thread never replaces ours');
  assert.equal(thread.subject, 'Re: employer accounts');
  assert.equal(thread.inReplyTo, '<step1@scalelab.example>');
});

test('18. an OOO is not a positive or human reply', () => {
  const text = 'I am out of the office and will return on Monday, October 19th.';
  const canonical = classifyReplyText(text, { subject: 'Automatic reply: employer accounts', now: '2026-10-12T14:49:24Z' });
  assert.equal(canonical.state, 'automated_reply');
  assert.equal(canonical.genuineHuman, false);
  const need = responseNeed({ classification: 'OUT_OF_OFFICE', replyText: text, rule: canonical });
  assert.deepEqual({ human: need.isHumanMessage, respond: need.requiresResponse, commercial: need.commercialIntent, intent: need.intent },
    { human: false, respond: false, commercial: false, intent: 'out_of_office' });
  const ooo = receiveOoo(lead(), text, '2026-10-12T14:49:24.000Z');
  assert.equal(isGenuineHumanReply(resolveReplyState(lead(), { activities: ooo.rows })), false);
});

test('19. the reply watchdog never flags a valid automated OOO as an unanswered human reply', () => {
  const at = '2026-10-12T14:49:24.000Z';
  for (const text of ['Out of office, back October 21.', 'I am currently out of the office.']) {
    const ooo = receiveOoo(lead(), text, at, { messageId: `m-${text.length}` });
    const orphans = orphanedHumanReplies({ leads: [lead()], activities: [touch(1, T1), ...ooo.rows],
      now: new Date('2026-10-13T00:00:00Z'), since: '2026-10-01T00:00:00Z' });
    assert.deepEqual(orphans, [], `${text}: review-required or dated, an autoresponder is not an orphan`);
  }
  // Control: a genuine reply with no disposition is still caught.
  const question = ev('question_reply', at, { canonicalState: 'needs_human', gmailMessageId: 'q-orphan', genuineHuman: true });
  assert.equal(orphanedHumanReplies({ leads: [lead()], activities: [touch(1, T1), question],
    now: new Date('2026-10-13T00:00:00Z'), since: '2026-10-01T00:00:00Z' }).length, 1);
});

test('20. idempotency: re-running the handler, the scheduler or the reconciliation duplicates nothing', () => {
  const at = '2026-10-12T15:00:00.000Z';
  const a = receiveOoo(lead(), 'Out of office, back October 21.', at, { messageId: 'same-msg' });
  const b = receiveOoo(lead(), 'Out of office, back October 21.', at, { messageId: 'same-msg' });
  assert.equal(a.rows[1].eventId, b.rows[1].eventId, 'one resume event per autoresponder');
  assert.deepEqual(a.plan, b.plan);
  const handler = agent.slice(agent.indexOf('async function handleOutOfOffice('), agent.indexOf('async function handleWrongPerson('));
  assert.match(handler, /if \(!\(activities \|\| \[\]\)\.some\(row => row\.eventId === event\.eventId\)\) \{/);
  // Reconciliation through the operator plan: same reviewed date, same event id.
  const undated = receiveOoo(lead(), 'I am currently out of the office.', at, { messageId: 'undated' });
  const acts = [touch(1, T1), ...undated.rows];
  const plan1 = planOooResumeSchedule({ lead: lead(), activities: acts, resumeAt: '2026-10-19', by: 'ops', now: '2026-10-15T05:00:00Z' });
  const plan2 = planOooResumeSchedule({ lead: lead(), activities: acts, resumeAt: '2026-10-19', by: 'ops', now: '2026-10-15T06:00:00Z' });
  assert.equal(plan1.ok, true, plan1.refusals.join('; '));
  assert.equal(plan1.event.eventId, plan2.event.eventId);
  assert.equal(plan1.fingerprint, plan2.fingerprint);
  const replay = planOooResumeSchedule({ lead: lead(), activities: [...acts, plan1.event], resumeAt: '2026-10-19', by: 'ops', now: '2026-10-15T07:00:00Z' });
  assert.equal(replay.alreadyRecorded, true, 'a second apply appends nothing');
  assert.match(server, /const eventsAppended = await withAuth\(\(\) => appendMissingEvents\(\[plan\.event\], state\.activities\)\);\n\s*invalidateOutreachCache\('ooo_resume_scheduled'\);/);
  // The derived state is a pure function of the ledger.
  assert.deepEqual(oooPauseState(lead(), acts, { now: '2026-10-16T00:00:00Z' }), oooPauseState(lead(), acts, { now: '2026-10-16T00:00:00Z' }));
});

// ── Resume copy ──────────────────────────────────────────────────────────────

test('the resumed touch opens with one line of context; the locked copy after it is unchanged', () => {
  for (const step of [2, 3]) {
    const plain = renderStaffingEmail(lead(), step, { env: RENDER_ENV });
    const resumed = renderStaffingEmail(lead(), step, { env: RENDER_ENV, oooResumeContext: true });
    assert.equal(validateStaffingEmail(resumed, step), null);
    assert.equal(resumed.body, plain.body.replace('Hi Pat,\n\n', `Hi Pat,\n\n${OOO_RESUME_CONTEXT_LINE}\n\n`));
    assert.doesNotMatch(resumed.body, /vacation|holiday|trip|bereavement|illness|honeymoon/i, 'never a reason for the absence');
  }
  assert.equal(OOO_RESUME_CONTEXT_LINE, "Circling back now that you're back in the office.");
  // Only an out-of-office absence earns the line; a closure or acknowledgement does not.
  const closure = receiveOoo(lead(), 'Our office is closed until October 19 for the holiday.', '2026-10-12T15:00:00.000Z');
  assert.equal(closure.canonical.subtype, 'temporary_closure');
  const copy = oooResumeCopy(lead(), [touch(1, T1), ...closure.rows], { step: 2, now: '2026-10-19T15:00:00Z' });
  assert.equal(copy.resumed, true);
  assert.equal(copy.contextLine, false);
});

test('the send path renders the same resume decision in both places it renders', () => {
  assert.match(agent, /const oooResume = oooResumeCopy\(lead, activities, \{ step \}\);\n\s*if \(oooResume\.refusal\) throw new Error\(oooResume\.refusal\);/);
  assert.match(agent, /const oooResume = Number\(step\) > 1 \? oooResumeCopy\(lead, activitiesForCycle \|\| \[\], \{ step: Number\(step\) \}\) : null;\n\s*if \(oooResume\?\.refusal\) return \{ delivered: false, reason: oooResume\.refusal \};/);
  assert.match(agent, /if \(staffingEmail && staffingEmail\.body !== body\) return \{ delivered: false, reason: 'staffing delivery body differs from locked copy' \};/);
});

// ── Operator scheduling (the reconciliation path) ────────────────────────────

test('operator scheduling refuses whenever resuming would be wrong', () => {
  const undated = receiveOoo(lead(), 'I am currently out of the office.', '2026-10-12T15:00:00.000Z');
  const acts = [touch(1, T1), ...undated.rows];
  const refused = (overrides, pattern) => {
    const plan = planOooResumeSchedule({ lead: lead(), activities: acts, resumeAt: '2026-10-19', by: 'ops', now: '2026-10-15T05:00:00Z', ...overrides });
    assert.equal(plan.ok, false);
    assert.ok(plan.refusals.some(text => pattern.test(text)), `${pattern} in ${plan.refusals.join(' | ')}`);
    assert.equal(plan.event, null);
  };
  refused({ by: '' }, /by is required/);
  refused({ activities: [touch(1, T1)] }, /no automated reply/);
  refused({ activities: [...acts, ev('positive_reply', '2026-10-13T15:00:00Z', { canonicalState: 'positive', genuineHuman: true })] }, /genuine reply exists/);
  refused({ activities: [...acts, ev('human_response_sent', '2026-10-13T15:00:00Z')] }, /a person answered/);
  refused({ activities: [...acts, ev('call_booked', '2026-10-13T15:00:00Z')] }, /a booking exists/);
  refused({ lead: lead({ notes: `${MANUAL_HOLD_TAG} [REPLY: OOO]` }) }, /MANUAL HOLD/);
  refused({ suppressedEmails: new Set(['pat@summitlaborgroup.com']) }, /suppressed/);
  refused({ lead: lead({ emailStatus: 'done' }) }, /not an active cold sequence/);
  refused({ lead: lead({ emailStep: '2' }) }, /ledger shows Touch 1 sent but the row says step 2/);
  refused({ resumeAt: 'soon' }, /resumeAt is required/);
  refused({ resumeAt: '2026-10-01' }, /before the day of the OOO reply/);
  refused({ resumeAt: '2027-02-01' }, /more than 60 days out/);
  const complete = [touch(1, T1), touch(2, '2026-10-15T15:00:00Z'), touch(3, '2026-10-19T15:00:00Z'),
    ...receiveOoo(lead(), 'I am out of the office.', '2026-10-19T15:00:09Z').rows];
  refused({ activities: complete, lead: lead({ emailStep: '3' }) }, /every touch was already sent/);
});

test('the operator route plans first, applies only the reviewed fingerprint, appends one event and never sends', () => {
  const get = server.slice(server.indexOf("app.get('/api/ops/ooo-resume/:id'"), server.indexOf("app.post('/api/ops/ooo-resume/:id'"));
  const post = server.slice(server.indexOf("app.post('/api/ops/ooo-resume/:id'"), server.indexOf("app.get('/api/ops/agent-v2'"));
  assert.match(get, /requireAuth/);
  assert.match(get, /dryRun: true/);
  assert.match(post, /requireAuth/);
  assert.match(post, /if \(agentState\.running \|\| automationLaunchReserved\) \{/);
  assert.match(post, /if \(!plan\.ok\) return res\.status\(409\)/);
  assert.match(post, /String\(req\.body\?\.fingerprint \|\| ''\) !== plan\.fingerprint/);
  for (const forbidden of ['sendEmail', 'messages.send', 'withOutboundReservation', 'spawnAgent', 'applyLeadChange', 'addSuppression']) {
    assert.ok(!post.includes(forbidden), `the OOO resume route must not use ${forbidden}`);
  }
  assert.match(post, /automationSent: false/);
  assert.match(server, /return \{ state, status: 409, error: 'this lead has a Pipeline card; its next action is managed on the board' \};/);
});

// ── The seven live OOO leads of 2026-10-15 ───────────────────────────────────
// Ledger shapes and autoresponder sentences as recorded in production (contact
// details omitted). NOW is 2026-10-15 00:00 Vancouver.

const NOW = '2026-10-15T07:00:00.000Z';
function liveCase({ id, touches, oooAt, text, subject = 'Automatic reply: employer accounts', recordedReturnDate = null,
  resumeEvents = [], row = {} }) {
  const target = lead({ id, email: `${id}@summitlaborgroup.com`, ...row });
  const rows = touches.map(([step, at]) => ({ ...touch(step, at), leadId: `CE-${id}`, sourceLeadId: id, eventId: `send:${id}:${step}` }));
  const reply = ev('out_of_office_reply', oooAt, {
    canonicalState: 'automated_reply', subtype: 'out_of_office', returnDate: recordedReturnDate,
    gmailMessageId: `ooo-${id}`, gmailThreadId: `ooo-thread-${id}`, genuineHuman: false,
  }, { leadId: `CE-${id}`, sourceLeadId: id, eventId: `gmail-reply:ooo-${id}`, content: text, subject });
  const resumes = resumeEvents.map(([resumeAt, resumeSource, recordedAt], index) => ev('ooo_resume_scheduled', recordedAt,
    { resumeAt, resumeSource, oooMessageId: `ooo-${id}` }, { leadId: `CE-${id}`, sourceLeadId: id, eventId: `resume:${id}:${index}` }));
  return { lead: target, activities: [...rows, reply, ...resumes] };
}

const LIVE = {
  mcLabor: liveCase({ id: 'mclabor', touches: [[1, '2026-09-17T18:11:53.723Z']], oooAt: '2026-09-17T18:12:09.000Z',
    text: 'I will be out of the office until Tuesday 9/22 and will have limited access to both my email and cell phone.',
    row: { emailStep: '1', lastEmailedAt: '2026-09-24T18:11:53.723Z', notes: '[REPLY: OOO — retry in 7d]' } }),
  bane: liveCase({ id: 'bane', touches: [[1, '2026-09-17T15:44:43.353Z'], [2, '2026-09-21T17:03:02.546Z'], [3, '2026-09-28T15:32:52.112Z']],
    oooAt: '2026-09-28T15:33:05.000Z', recordedReturnDate: '2026-10-05',
    text: 'I am currently out of the office and will not be available until Monday, 10//05/26.',
    row: { stage: 'Done', emailStatus: 'done', emailStep: '3', lastEmailedAt: '2026-09-28T15:32:52.112Z', notes: `${MANUAL_HOLD_TAG} [REPLY: OOO until 2026-10-05]` } }),
  summit: liveCase({ id: 'summit', touches: [[1, '2026-09-30T14:10:46.417Z'], [2, '2026-10-09T14:05:18.330Z']],
    oooAt: '2026-09-30T14:10:51.000Z', recordedReturnDate: '2026-10-05',
    text: 'I am currently away with limited access to my email and will be back in the office on October 5th.',
    resumeEvents: [['2026-10-05T00:00:00.000Z', OOO_RESUME_SOURCE.OPERATOR_REPAIR, '2026-10-06T00:30:03.966Z']],
    row: { emailStep: '2', lastEmailedAt: '2026-10-09T14:05:18.330Z', senderInboxId: 'tryscalelabai' } }),
  ets: liveCase({ id: 'ets', touches: [[1, '2026-10-01T14:48:42.586Z'], [2, '2026-10-13T14:34:58.267Z']],
    oooAt: '2026-10-01T14:48:46.000Z', subject: 'Out Of Office, Returning 10/12 Re: employer accounts',
    text: "Appreciate you reaching out! I'm out of office with limited access to email.",
    resumeEvents: [['2026-10-12T14:00:00.000Z', OOO_RESUME_SOURCE.OPERATOR_REPAIR, '2026-10-06T00:30:09.937Z']],
    row: { emailStep: '2', lastEmailedAt: '2026-10-13T14:34:58.267Z', senderInboxId: 'tryscalelabai' } }),
  teamwrx: liveCase({ id: 'teamwrx', touches: [[1, '2026-09-30T15:07:57.549Z'], [2, '2026-10-09T15:06:14.597Z']],
    oooAt: '2026-10-09T15:06:23.000Z', subject: 'Out of Office – Bereavement Re: employer accounts',
    text: 'I am currently out of the office on bereavement leave this week. I will have limited availability but will be monitoring and responding to emails as I am able.',
    resumeEvents: [['2026-10-16T15:06:23.000Z', OOO_RESUME_SOURCE.POLICY_DEFAULT, '2026-10-09T15:30:36.846Z']],
    row: { emailStep: '2', lastEmailedAt: '2026-10-09T15:06:14.597Z', senderInboxId: 'tryscalelabai' } }),
  ihc: liveCase({ id: 'ihc', touches: [[1, '2026-10-12T14:49:11.627Z']], oooAt: '2026-10-12T14:49:24.000Z', recordedReturnDate: '2026-10-19',
    text: 'Hello! I will be out of the office from October 12th and will return on Monday, October 19th.',
    resumeEvents: [['2026-10-19T00:00:00.000Z', OOO_RESUME_SOURCE.PROSPECT_STATED, '2026-10-12T15:00:23.143Z']],
    row: { emailStep: '1', lastEmailedAt: '2026-10-12T14:49:11.627Z' } }),
  cleanPower: liveCase({ id: 'cleanpower', touches: [[1, '2026-10-14T17:05:38.577Z']], oooAt: '2026-10-14T17:05:50.000Z',
    text: 'I will be traveling Thursday and Friday. Please contact the below for assistance.',
    resumeEvents: [['2026-10-21T17:05:50.000Z', OOO_RESUME_SOURCE.POLICY_DEFAULT, '2026-10-14T17:30:24.287Z']],
    row: { emailStep: '1', lastEmailedAt: '2026-10-14T17:05:38.577Z', senderInboxId: 'deniels' } }),
};

test('production: each live OOO lead resolves to the state its evidence supports', () => {
  const expect = {
    mcLabor: [OOO_PAUSE_STATUS.REVIEW_REQUIRED, 2], bane: [OOO_PAUSE_STATUS.SEQUENCE_COMPLETE, null],
    summit: [OOO_PAUSE_STATUS.RESUMED, 3], ets: [OOO_PAUSE_STATUS.RESUMED, 3],
    teamwrx: [OOO_PAUSE_STATUS.REVIEW_REQUIRED, 3], ihc: [OOO_PAUSE_STATUS.WAITING, 2],
    cleanPower: [OOO_PAUSE_STATUS.REVIEW_REQUIRED, 2],
  };
  for (const [name, [status, nextStep]] of Object.entries(expect)) {
    const state = oooPauseState(LIVE[name].lead, LIVE[name].activities, { now: NOW });
    assert.equal(state.status, status, name);
    assert.equal(state.nextStep, nextStep, name);
    assert.equal(state.stepsConsistent, true, `${name}: ledger and row agree`);
  }
  // The parser now reads what the old one missed; nothing invents the rest.
  const parsed = name => {
    const reply = LIVE[name].activities.find(row => row.eventType === 'out_of_office_reply');
    return classifyReplyText(reply.content, { subject: reply.subject, now: reply.occurredAt }).returnDate;
  };
  assert.equal(parsed('mcLabor'), '2026-09-22');
  assert.equal(parsed('ets'), '2026-10-12');
  assert.equal(parsed('summit'), '2026-10-05');
  assert.equal(parsed('ihc'), '2026-10-19');
  for (const name of ['bane', 'teamwrx', 'cleanPower']) assert.equal(parsed(name), null, name);
});

test('production: TeamWRX and Clean Power never send on the 7-day policy date', () => {
  for (const [name, policyAt] of [['teamwrx', '2026-10-16T15:30:00Z'], ['cleanPower', '2026-10-21T17:30:00Z']]) {
    const { lead: target, activities } = LIVE[name];
    const pass = schedulerPass(target, activities, policyAt);
    assert.equal(pass.sends, false, name);
    assert.equal(pass.gate.verdict.owner, 'human', name);
    assert.equal(oooPauseState(target, activities).ignoredPolicyResumeAt !== null, true, name);
  }
});

test('production: IHC resumes with Touch 2 on Monday October 19; Summit and ETS continue normally', () => {
  const ihc = LIVE.ihc;
  assert.equal(schedulerPass(ihc.lead, ihc.activities, '2026-10-16T15:00:00Z').sends, false);
  const monday = schedulerPass(ihc.lead, ihc.activities, '2026-10-19T14:00:00Z');
  assert.deepEqual([monday.sends, monday.step, monday.contextLine], [true, 2, true]);
  for (const name of ['summit', 'ets']) {
    const { lead: target, activities } = LIVE[name];
    const copy = oooResumeCopy(target, activities, { step: 3 });
    assert.deepEqual([copy.resumed, copy.contextLine, copy.refusal], [false, false, null], `${name}: Touch 3 is ordinary copy`);
  }
  assert.equal(schedulerPass(LIVE.bane.lead, LIVE.bane.activities, NOW).sends, false, 'Bane finished its sequence');
});

test('production: Mc Labor reconciles through the operator path to Touch 2, never Touch 1', () => {
  const { lead: target, activities } = LIVE.mcLabor;
  assert.equal(schedulerPass(target, activities, '2026-10-15T15:00:00Z').sends, false, 'held for review until reconciled');
  const plan = planOooResumeSchedule({ lead: target, activities, resumeAt: '2026-09-22', by: 'Deins',
    evidence: 'out of the office until Tuesday 9/22', now: NOW });
  assert.equal(plan.ok, true, plan.refusals.join('; '));
  assert.equal(plan.checks.parsedReturnDate, '2026-09-22');
  const meta = JSON.parse(plan.event.metadata);
  assert.equal(meta.resumeAt, '2026-09-22T07:00:00.000Z');
  assert.equal(meta.resumeSource, OOO_RESUME_SOURCE.OPERATOR_SCHEDULED);
  const after = [...activities, plan.event];
  const pass = schedulerPass(target, after, '2026-10-15T15:00:00Z');
  assert.deepEqual([pass.sends, pass.step, pass.contextLine], [true, 2, true]);
  // The live Bane, Summit and ETS rows refuse a schedule: nothing to resume.
  for (const name of ['bane', 'summit', 'ets']) {
    const refused = planOooResumeSchedule({ lead: LIVE[name].lead, activities: LIVE[name].activities, resumeAt: '2026-10-20', by: 'Deins', now: NOW });
    assert.equal(refused.ok, false, name);
  }
});
