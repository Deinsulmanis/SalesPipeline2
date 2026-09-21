'use strict';

// "We have responded to this prospect after their inbound reply" has ONE
// definition (integrations/prospect-response.js). The bug this prevents: an
// automated warm reply (booking link, qualification question, question answer)
// was delivered and recorded as `booking_link_sent`, but every CRM derivation
// ignored it. The lead stayed "waiting on us", the Inbox kept saying Respond,
// the Hot clock ran from the prospect's message, and hot_stale_v1 could never
// be offered. Nothing here sends, moves or closes anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveHotState, deriveNextAction, addBusinessDays,
  WAITING_ON, HOT_STALENESS, ACTION_TYPE, ACTION_OWNER, ACTION_STATUS,
} = require('../integrations/pipeline-state');
const { deriveOperationalAction, REPLY_ACTION } = require('../integrations/reply-operations');
const { deriveAutomationOwnership, mayColdSend, OWNER } = require('../integrations/automation-ownership');
const { evaluateStageSequence } = require('../integrations/stage-sequences');

// Thu 27 Aug 2026, 12:00 Vancouver. Every test pins `now`.
const NOW = new Date('2026-08-27T19:00:00.000Z');
const REPLY_AT = '2026-08-27T16:00:00.000Z';
const ANSWER_AT = '2026-08-27T16:05:00.000Z';

const ev = (eventType, occurredAt, metadata = {}) => ({
  eventType, occurredAt, leadId: 'CE-L1', sourceLeadId: 'L1', email: 'owner@example.com',
  metadata: JSON.stringify(metadata),
});
// The exact shape outreach-agent's deliverHardenedWarmReply persists.
const warmReply = (action, occurredAt = ANSWER_AT) => ev('booking_link_sent', occurredAt, {
  action, classification: 'INTERESTED', inboundMessageId: 'm-in-1', senderInboxId: 'primary',
});
const positiveReply = (occurredAt = REPLY_AT) => ev('positive_reply', occurredAt, {
  classification: 'INTERESTED', canonicalState: 'positive', gmailMessageId: 'm-in-1',
});
const questionReply = (occurredAt = REPLY_AT) => ev('question_reply', occurredAt, {
  classification: 'QUESTION', canonicalState: 'needs_human', reason: 'question_or_objection',
  gmailMessageId: 'm-in-1', requiresHumanAttention: true,
});

const hotTwin = { email: 'owner@example.com', emailStatus: 'replied', notes: '[REPLY: Interested]' };
const hot = activities => deriveHotState({ stage: 'hot' }, { now: NOW, activities });
const hotAction = activities => deriveNextAction({ stage: 'hot' }, hotTwin, { now: NOW, activities });

// ── Hot lead: waiting-on and the Inbox action ───────────────────────────────

test('A. inbound reply then a human response: waiting on the prospect', () => {
  const activities = [positiveReply(), ev('human_response_sent', ANSWER_AT)];
  assert.equal(hot(activities).waitingOn, WAITING_ON.PROSPECT);
  assert.equal(hotAction(activities).type, ACTION_TYPE.WAITING_PROSPECT);
});

test('B. inbound reply then an automated booking-link reply: waiting on the prospect, not Respond', () => {
  const activities = [positiveReply(), warmReply('AUTO_BOOKING_RESPONSE')];
  const state = hot(activities);
  assert.equal(state.waitingOn, WAITING_ON.PROSPECT, 'the automated reply answered them');
  assert.equal(state.staleness, HOT_STALENESS.ACTIVE, 'answered minutes ago; nothing is due');
  assert.equal(state.lastInteractionAt, ANSWER_AT, 'the clock runs from our reply');
  assert.equal(state.dueAt, addBusinessDays(ANSWER_AT, 2), 'the existing 2-business-day chase rule is unchanged');
  const next = hotAction(activities);
  assert.equal(next.type, ACTION_TYPE.WAITING_PROSPECT);
  assert.notEqual(next.type, ACTION_TYPE.RESPOND_REPLY, 'the Inbox must not ask a human to respond again');
  assert.equal(next.owner, ACTION_OWNER.WAITING);
  assert.equal(next.status, ACTION_STATUS.WAITING);
});

test('C. inbound reply then an automated staffing qualification question: waiting on the prospect', () => {
  for (const action of ['AUTO_STAFFING_QUALIFY_QUESTION', 'AUTO_STAFFING_SEND_INFO', 'AUTO_STAFFING_QUALIFIED',
    'AUTO_MEETING_RESPONSE']) {
    const state = hot([positiveReply(), warmReply(action)]);
    assert.equal(state.waitingOn, WAITING_ON.PROSPECT, `${action} answered the prospect`);
  }
});

test('D. inbound question then a valid automated answer: reply operations say wait, not respond', () => {
  const twin = { email: 'owner@example.com', emailStatus: 'replied',
    notes: '[REPLY: Question — auto-answered, booking link sent]' };
  for (const action of ['AUTO_QUESTION_RESPONSE', 'AUTO_PRICING_RESPONSE']) {
    const activities = [questionReply(), warmReply(action)];
    const op = deriveOperationalAction(twin, { activities });
    assert.equal(op.action, REPLY_ACTION.WAIT, `${action}: the ball is with the prospect`);
    assert.equal(op.source, 'already_answered');
    // The Inbox row for an Outreach-only lead (no Pipeline row) is the same answer.
    const next = deriveNextAction({}, twin, { now: NOW, activities, outreachOnly: true });
    assert.equal(next.type, ACTION_TYPE.WAITING_PROSPECT, `${action}: Inbox must not say Respond`);
    assert.equal(next.owner, ACTION_OWNER.WAITING);
  }
});

test('E. inbound reply with no response: still waiting on us', () => {
  const activities = [positiveReply()];
  assert.equal(hot(activities).waitingOn, WAITING_ON.US);
  assert.equal(hotAction(activities).type, ACTION_TYPE.RESPOND_REPLY);
});

// ── What does NOT count ─────────────────────────────────────────────────────

test('F. an internal conversation note keeps its existing, intentional meaning', () => {
  // conversation_note is the operator recording a conversation that happened
  // off-platform (a call, an in-person reply). The CRM has always treated it as
  // "we answered" (next-action test 4, hot-staleness direction test), and this
  // change deliberately preserves that. It is a recorded interaction, NOT a
  // prospect-facing message, and the taxonomy keeps the two apart.
  const activities = [positiveReply(), ev('conversation_note', ANSWER_AT, { trigger: 'crm_notes' })];
  assert.equal(hot(activities).waitingOn, WAITING_ON.PROSPECT);
});

test('F2. unsolicited or unidentifiable automated sends never count as answering a reply', () => {
  const noise = [
    // The demo-intent booking-link email is automated outreach, not an answer.
    ev('booking_link_sent', ANSWER_AT, { action: 'AUTO_DEMO_ENGAGEMENT_RESPONSE', inboundMessageId: 'm-cold' }),
    // A recovered delivery without an action cannot prove what it answered: fail toward a human.
    ev('booking_link_sent', ANSWER_AT, { recoveredAfterCheckpointFailure: true }),
    ev('booking_link_sent', ANSWER_AT),
    ev('follow_up_sent', ANSWER_AT), ev('initial_email_sent', ANSWER_AT),
    ev('sequence_step_sent', ANSWER_AT, { sequenceId: 'hot_stale_v1', step: 1 }),
    ev('prospect_reply_reserved', ANSWER_AT, { action: 'AUTO_BOOKING_RESPONSE' }),
    ev('prospect_reply_failed', ANSWER_AT, { action: 'AUTO_BOOKING_RESPONSE' }),
    ev('stage_changed', ANSWER_AT), ev('pipeline_promoted', ANSWER_AT), ev('gmail_reply_evaluated', ANSWER_AT),
  ];
  for (const row of noise) {
    const state = hot([positiveReply(), row]);
    assert.equal(state.waitingOn, WAITING_ON.US, `${row.eventType} ${row.metadata} must not answer the prospect`);
  }
});

test('an automated reply sent BEFORE the latest inbound message does not answer it', () => {
  const activities = [
    positiveReply('2026-08-26T16:00:00.000Z'), warmReply('AUTO_BOOKING_RESPONSE', '2026-08-26T16:05:00.000Z'),
    positiveReply('2026-08-27T16:00:00.000Z'),
  ];
  assert.equal(hot(activities).waitingOn, WAITING_ON.US, 'they wrote again after our reply');
});

// ── Meetings keep their own precedence ──────────────────────────────────────

test('G. a booked meeting still owns the next move', () => {
  const state = deriveHotState({ stage: 'hot', meetingAt: '2026-09-02T17:00:00.000Z' },
    { now: NOW, activities: [positiveReply(), warmReply('AUTO_BOOKING_RESPONSE')] });
  assert.equal(state.waitingOn, WAITING_ON.MEETING);
  assert.equal(state.staleness, HOT_STALENESS.ACTIVE);
});

// ── Staleness is measured from the correct last outbound touch ──────────────

test('H. an automated reply does not leave the Hot lead falsely due, overdue or stale', () => {
  // Fresh: before the fix this read "follow-up due" (waiting on us since 16:00 today).
  assert.equal(hot([positiveReply(), warmReply('AUTO_BOOKING_RESPONSE')]).staleness, HOT_STALENESS.ACTIVE);

  // A week old: reply Thu 20 Aug, answered the same minute.
  const reply = '2026-08-20T16:00:00.000Z';
  const answer = '2026-08-20T16:01:00.000Z';
  const state = hot([positiveReply(reply), warmReply('AUTO_BOOKING_RESPONSE', answer)]);
  assert.equal(state.waitingOn, WAITING_ON.PROSPECT);
  assert.equal(state.dueAt, addBusinessDays(answer, 2), 'due 2 business days after OUR reply (Mon 24 Aug)');
  assert.equal(state.staleness, HOT_STALENESS.OVERDUE,
    '3 days past a chase due Mon 24 Aug — overdue, not the 7-day "stale" of an unanswered reply');
});

// ── Recovery eligibility follows, with its timing unchanged ─────────────────

test('I. hot_stale_v1 is offered only once the chase is due after an automated reply', () => {
  const twin = { ...hotTwin, leadNiche: 'dental', tradeType: 'dental', emailTemplateId: 'dental-guarantee-v1' };
  const offersAt = (now, activities) => evaluateStageSequence({
    boardLead: { stage: 'hot' }, twin, activities, now,
    hotState: deriveHotState({ stage: 'hot' }, { now, activities }), featureEnabled: true,
  }).offers;

  const answered = [positiveReply(), warmReply('AUTO_BOOKING_RESPONSE')];
  assert.deepEqual(offersAt(NOW, answered), [], 'just answered: nothing to recover yet');
  const due = new Date(addBusinessDays(ANSWER_AT, 2));
  assert.ok(offersAt(due, answered).includes('hot_stale_v1'),
    'offered once the unchanged 2-business-day chase window has passed');

  // An unanswered reply is human work, never a recovery journey.
  assert.deepEqual(offersAt(due, [positiveReply()]), []);
});

// ── Execution and display ask the same question ─────────────────────────────

test('the sender-side ownership verdict agrees with the display, and send authority is unchanged', () => {
  const twin = { email: 'owner@example.com', emailStatus: 'replied', stage: 'Replied',
    notes: '[REPLY: Question — auto-answered, booking link sent]' };
  const unanswered = deriveAutomationOwnership(twin, { activities: [questionReply()],
    sendingEnabled: true, coldCadenceDue: true, now: NOW });
  assert.equal(unanswered.owner, OWNER.HUMAN, 'an unanswered question is human work');

  // No humanTouchAt supplied, exactly like CRM Health and the queue checks call it.
  const answered = deriveAutomationOwnership(twin, {
    activities: [questionReply(), warmReply('AUTO_QUESTION_RESPONSE')],
    sendingEnabled: true, coldCadenceDue: true, now: NOW });
  assert.equal(answered.owner, OWNER.WAITING, 'answered by automation: waiting on the prospect');
  assert.equal(mayColdSend(answered).allowed, false, 'waiting never re-opens cold cadence');
  assert.equal(mayColdSend(unanswered).allowed, false);
});

// ── The taxonomy itself ─────────────────────────────────────────────────────

const {
  isProspectFacingResponse, isResponseEvidence, latestResponseAt, latestProspectFacingResponseAt,
  AUTOMATED_REPLY_ACTIONS,
} = require('../integrations/prospect-response');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

test('each event is classified as a prospect-facing response, other response evidence, or neither', () => {
  const facing = [ev('human_response_sent', ANSWER_AT), ...AUTOMATED_REPLY_ACTIONS.map(a => warmReply(a))];
  for (const row of facing) {
    assert.equal(isProspectFacingResponse(row), true, `${row.eventType} ${row.metadata}`);
    assert.equal(isResponseEvidence(row), true);
  }
  // Answers the prospect, but is not a message they received from us.
  for (const type of ['conversation_note', 'call_booked', 'meeting_rescheduled']) {
    assert.equal(isProspectFacingResponse(ev(type, ANSWER_AT)), false, type);
    assert.equal(isResponseEvidence(ev(type, ANSWER_AT)), true, type);
  }
  const never = [
    ev('booking_link_sent', ANSWER_AT, { action: 'AUTO_DEMO_ENGAGEMENT_RESPONSE' }),
    ev('booking_link_sent', ANSWER_AT, { recoveredAfterCheckpointFailure: true }),
    ev('initial_email_sent', ANSWER_AT), ev('follow_up_sent', ANSWER_AT), ev('sequence_step_sent', ANSWER_AT),
    ev('prospect_reply_reserved', ANSWER_AT), ev('prospect_reply_failed', ANSWER_AT),
    ev('positive_reply', ANSWER_AT), ev('demo_pair_played', ANSWER_AT), ev('meeting_cancelled', ANSWER_AT),
  ];
  for (const row of never) assert.equal(isResponseEvidence(row), false, `${row.eventType} ${row.metadata}`);
  // Metadata may arrive parsed (Supabase) or as a JSON string (Sheets).
  assert.equal(isProspectFacingResponse({ eventType: 'booking_link_sent', metadata: { action: 'AUTO_BOOKING_RESPONSE' } }), true);
  assert.equal(isProspectFacingResponse({ eventType: 'booking_link_sent', metadata: 'not json' }), false);
});

test('the latest-answer helpers pick the newest qualifying instant only', () => {
  const rows = [
    positiveReply(), warmReply('AUTO_BOOKING_RESPONSE', '2026-08-27T16:05:00.000Z'),
    ev('conversation_note', '2026-08-27T17:00:00.000Z'),
    ev('booking_link_sent', '2026-08-27T18:00:00.000Z', { action: 'AUTO_DEMO_ENGAGEMENT_RESPONSE' }),
  ];
  assert.equal(latestResponseAt(rows), '2026-08-27T17:00:00.000Z');
  assert.equal(latestProspectFacingResponseAt(rows), '2026-08-27T16:05:00.000Z');
  assert.equal(latestResponseAt([positiveReply()]), null);
  assert.equal(latestResponseAt(undefined), null);
});

test('every reply-policy action that sends is recognised as an automated reply', () => {
  // If a new auto-send action is added to reply-response-policy without being
  // counted here, the CRM would silently go back to "waiting on us" for it.
  const policy = readSource('integrations/reply-response-policy.js');
  const sending = [...new Set([...policy.matchAll(/action: ACTION\.([A-Z_]+), send: true/g)].map(m => m[1]))].sort();
  assert.ok(sending.length >= 7, 'the policy source still lists its sending actions');
  assert.deepEqual([...AUTOMATED_REPLY_ACTIONS].sort(), sending);
});

test('no derivation keeps a private list of "we answered" events', () => {
  for (const file of ['integrations/pipeline-state.js', 'integrations/reply-operations.js',
    'integrations/automation-ownership.js']) {
    const src = readSource(file);
    assert.doesNotMatch(src, /HUMAN_TOUCH_EVENTS|MEANINGFUL_HUMAN_EVENTS/, `${file} re-lists response events`);
    assert.match(src, /require\('\.\/prospect-response'\)/, `${file} reads the shared definition`);
  }
  // Every ownership caller that supplies the instant supplies the shared one.
  for (const file of ['outreach-agent.js', 'server.js', 'integrations/pipeline-resume.js']) {
    assert.doesNotMatch(readSource(file), /humanTouchAt: latestHumanOutboundAt/, `${file} answers ownership from human-only evidence`);
  }
});

test('CRM Health no longer lists an automatically answered reply as an unanswered backlog', () => {
  const { buildCrmHealth } = require('../integrations/crm-health');
  const lead = { id: 'L1', email: 'owner@example.com', emailStatus: 'replied', stage: 'Replied',
    notes: '[REPLY: Question — auto-answered, booking link sent]' };
  const old = '2026-08-01T16:00:00.000Z';
  const backlog = activities => {
    const report = buildCrmHealth({ leads: [lead], boardLeads: [], activities, now: NOW });
    const item = report.findings.find(f => f.id === 'ownership.unanswered_inbound_backlog');
    return item ? item.affected : 0;
  };
  assert.equal(backlog([questionReply(old)]), 1, 'an unanswered 26-day-old reply is backlog');
  assert.equal(backlog([questionReply(old), warmReply('AUTO_QUESTION_RESPONSE', '2026-08-01T16:05:00.000Z')]), 0,
    'answered by automation the same day: not backlog');
});
