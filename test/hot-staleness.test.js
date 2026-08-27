'use strict';

// Hot lead staleness. The bug this prevents: a Hot lead whose prospect went
// quiet returned WAITING_PROSPECT with dueAt:null, which resolves to status
// 'waiting' — a bucket the work queues rank below upcoming and never escalate.
// Opportunities rotted there silently. Nothing here sends, moves or closes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  deriveHotState, lastMeaningfulInteraction, addBusinessDays,
  deriveNextAction, compareNextActions, summarizeNextActions,
  HOT_FOLLOW_UP, WAITING_ON, HOT_STALENESS,
  ACTION_TYPE, ACTION_OWNER, ACTION_STATUS, MANUAL_HOLD_TAG,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const agent = readSource(path.join(root, 'outreach-agent.js'));
const stateSrc = readSource(path.join(root, 'integrations', 'pipeline-state.js'));

// Thu 27 Aug 2026, 12:00 Vancouver. Every test pins `now`.
const NOW = new Date('2026-08-27T19:00:00.000Z');
const ev = (eventType, occurredAt) => ({ eventType, occurredAt, leadId: 'L1' });
const twin = (notes = '[REPLY: Interested]') => ({ emailStatus: 'replied', notes });
const hot = (lead = {}, activities = []) => deriveHotState({ stage: 'hot', ...lead }, { now: NOW, activities });
const action = (lead = {}, activities = [], t = twin()) =>
  deriveNextAction({ stage: 'hot', ...lead }, t, { now: NOW, activities });

// ── 1–4. Waiting-on and timing ──────────────────────────────────────────────

test('1/2. an inbound reply puts the ball with us, due the day it arrived', () => {
  const state = hot({}, [ev('positive_reply', '2026-08-25T10:00:00.000Z')]);
  assert.equal(state.waitingOn, WAITING_ON.US);
  assert.equal(state.dueAt, '2026-08-25T10:00:00.000Z', 'due when they wrote, not later');
  const a = action({}, [ev('positive_reply', '2026-08-25T10:00:00.000Z')]);
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.equal(a.status, ACTION_STATUS.OVERDUE, 'two days unanswered is already late');
  // Answered the same day it arrived: due today, never "upcoming".
  const today = hot({}, [ev('positive_reply', '2026-08-27T09:00:00.000Z')]);
  assert.equal(today.staleness, HOT_STALENESS.FOLLOW_UP_DUE);
});

test('3/4. a recorded human response flips the ball and opens a fresh window', () => {
  const activities = [ev('positive_reply', '2026-08-24T10:00:00.000Z'), ev('human_response_sent', '2026-08-26T15:00:00.000Z')];
  const state = hot({}, activities);
  assert.equal(state.waitingOn, WAITING_ON.PROSPECT);
  // Wed 26th + 2 business days = Fri 28th.
  assert.equal(state.dueAt.slice(0, 10), '2026-08-28');
  assert.equal(state.staleness, HOT_STALENESS.ACTIVE);
  const a = action({}, activities);
  assert.equal(a.type, ACTION_TYPE.WAITING_PROSPECT);
  assert.equal(a.owner, ACTION_OWNER.WAITING);
});

test('the follow-up window is business days, and is a constant not a magic number', () => {
  assert.equal(HOT_FOLLOW_UP.WAITING_ON_PROSPECT_BUSINESS_DAYS, 2);
  // Thu + 2 business days = Mon, skipping the weekend.
  assert.equal(addBusinessDays('2026-08-27T15:00:00.000Z', 2).slice(0, 10), '2026-08-31');
  // Fri + 2 = Tue.
  assert.equal(addBusinessDays('2026-08-28T15:00:00.000Z', 2).slice(0, 10), '2026-09-01');
  assert.equal(addBusinessDays('not-a-date', 2), null, 'never invents a date');
  // The human clock is deliberately separate from cold-email cadence.
  assert.ok(!/FOLLOW_UP_DELAY_DAYS/.test(
    stateSrc.slice(stateSrc.indexOf('const HOT_FOLLOW_UP'), stateSrc.indexOf('function deriveHotState'))),
    'Hot timing must not reuse the sending cadence');
});

// ── 5–9. Manual override and the staleness ladder ───────────────────────────

test('5. an explicit follow-up date overrides the derived one', () => {
  const activities = [ev('human_response_sent', '2026-08-26T15:00:00.000Z')];
  assert.equal(hot({}, activities).dueAt.slice(0, 10), '2026-08-28', 'derived');
  const overridden = hot({ followup: '2026-09-10' }, activities);
  assert.equal(overridden.dueAt, '2026-09-10', 'the human date wins');
  assert.equal(overridden.source, 'followup-field');
  assert.match(overridden.reason, /set by hand/);
});

test('6/7/8/9. the staleness ladder is derived from the due date', () => {
  const at = day => hot({ followup: day }, []).staleness;
  assert.equal(at('2026-08-29'), HOT_STALENESS.ACTIVE, 'not due yet');
  assert.equal(at('2026-08-27'), HOT_STALENESS.FOLLOW_UP_DUE, 'due today');
  assert.equal(at('2026-08-26'), HOT_STALENESS.OVERDUE, '1 day past');
  assert.equal(at('2026-08-24'), HOT_STALENESS.OVERDUE, '3 days past');
  assert.equal(at('2026-08-20'), HOT_STALENESS.STALE, '7 days past');
  assert.equal(at('2026-08-06'), HOT_STALENESS.SEVERELY_STALE, '21 days past');
  assert.equal(HOT_FOLLOW_UP.STALE_DAYS_PAST_DUE, 7);
  assert.equal(HOT_FOLLOW_UP.SEVERELY_STALE_DAYS_PAST_DUE, 21);
  assert.equal(hot({ followup: '2026-08-20' }, []).daysPastDue, 7);
});

// ── 10–15. What does and does not reset the clock ───────────────────────────

test('10. a new inbound reply resets a stale conversation', () => {
  const stale = [ev('human_response_sent', '2026-06-01T10:00:00.000Z')];
  assert.equal(hot({}, stale).staleness, HOT_STALENESS.SEVERELY_STALE);
  const revived = [...stale, ev('positive_reply', '2026-08-27T09:00:00.000Z')];
  const state = hot({}, revived);
  assert.equal(state.waitingOn, WAITING_ON.US, 'the ball is back with us');
  assert.equal(state.staleness, HOT_STALENESS.FOLLOW_UP_DUE, 'and it is due now, not still stale');
});

test('11. recording a human response resets the timer', () => {
  const owed = [ev('positive_reply', '2026-08-10T10:00:00.000Z')];
  assert.equal(hot({}, owed).waitingOn, WAITING_ON.US);
  const answered = [...owed, ev('human_response_sent', '2026-08-27T09:00:00.000Z')];
  const state = hot({}, answered);
  assert.equal(state.waitingOn, WAITING_ON.PROSPECT);
  assert.equal(state.staleness, HOT_STALENESS.ACTIVE);
});

test('12/13/14/15. automated sends, opens, warm and demo views never reset the clock', () => {
  const base = ev('human_response_sent', '2026-06-01T10:00:00.000Z');
  const noise = [
    'initial_email_sent', 'follow_up_sent', 'booking_link_sent',
    'demo_pair_played', 'lead_queued', 'automation_held', 'stage_changed',
  ];
  for (const type of noise) {
    const state = hot({}, [base, ev(type, '2026-08-27T09:00:00.000Z')]);
    assert.equal(state.staleness, HOT_STALENESS.SEVERELY_STALE, `${type} must not reset the conversation`);
    assert.equal(state.lastInteractionAt, '2026-06-01T10:00:00.000Z', `${type} is not an interaction`);
  }
  // All of them together still change nothing.
  assert.equal(hot({}, [base, ...noise.map(t => ev(t, '2026-08-27T09:00:00.000Z'))]).staleness,
    HOT_STALENESS.SEVERELY_STALE);
});

test('the meaningful-interaction derivation reports direction honestly', () => {
  assert.deepEqual(lastMeaningfulInteraction([]), { inboundAt: null, humanAt: null, at: null, direction: null });
  const inbound = lastMeaningfulInteraction([ev('positive_reply', '2026-08-25T10:00:00.000Z')]);
  assert.equal(inbound.direction, 'inbound');
  const outbound = lastMeaningfulInteraction([
    ev('positive_reply', '2026-08-25T10:00:00.000Z'), ev('conversation_note', '2026-08-26T10:00:00.000Z')]);
  assert.equal(outbound.direction, 'outbound');
});

// ── 16–19. Precedence: meetings and terminal stages ─────────────────────────

test('16/17. a booked meeting supersedes the Hot follow-up', () => {
  const activities = [ev('positive_reply', '2026-08-01T10:00:00.000Z')];   // long stale otherwise
  const state = hot({ meetingAt: '2026-09-02T17:00:00.000Z' }, activities);
  assert.equal(state.waitingOn, WAITING_ON.MEETING);
  assert.equal(state.staleness, HOT_STALENESS.ACTIVE, 'a booked meeting is never stale');
  const a = action({ meetingAt: '2026-09-02T17:00:00.000Z' }, activities);
  assert.equal(a.type, ACTION_TYPE.SALES_CALL);
  assert.equal(a.owner, ACTION_OWNER.MEETING);
  assert.ok(!/Follow up with prospect/.test(a.label));
  // And a Call Booked lead never derives Hot staleness at all.
  const booked = deriveNextAction({ stage: 'call_booked', meetingAt: '2026-09-02T17:00:00.000Z' }, twin(),
    { now: NOW, activities });
  assert.equal(booked.type, ACTION_TYPE.SALES_CALL);
  assert.equal(booked.hotState, null);
});

test('18/19. terminal stages never show Hot staleness or go overdue', () => {
  const ancient = [ev('positive_reply', '2026-01-01T10:00:00.000Z')];
  for (const [stage, expected] of [['closed_won', ACTION_TYPE.NONE_WON], ['closed_lost', ACTION_TYPE.NONE_LOST]]) {
    const a = deriveNextAction({ stage, outcome: 'no_show', followup: '2026-01-01' }, twin(), { now: NOW, activities: ancient });
    assert.equal(a.type, expected);
    assert.equal(a.status, ACTION_STATUS.NONE);
    assert.notEqual(a.status, ACTION_STATUS.OVERDUE, `${stage} must never read overdue`);
    assert.equal(a.hotState, null, `${stage} carries no Hot state`);
    assert.equal(a.dueAt, null);
  }
});

// ── 20–21. Historical gaps ──────────────────────────────────────────────────

test('20/21. an undatable Hot lead asks for review rather than inventing an age', () => {
  const state = hot({}, []);
  assert.equal(state.waitingOn, WAITING_ON.UNKNOWN);
  assert.equal(state.staleness, HOT_STALENESS.UNKNOWN);
  assert.equal(state.dueAt, null, 'no due date is fabricated');
  assert.equal(state.daysPastDue, null, 'no age is fabricated');
  assert.equal(state.hasConversationEvidence, false);
  assert.match(state.reason, /cannot be proven/);

  const a = action({}, [], twin());
  assert.equal(a.type, ACTION_TYPE.HOT_REVIEW);
  assert.equal(a.label, 'Review Hot lead');
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.equal(a.needsAttention, true, 'it still escalates — never silently hidden');
  assert.equal(a.dueAt, null);

  // A human date is the one honest way to age such a lead.
  const dated = hot({ followup: '2026-07-28' }, []);
  assert.equal(dated.dueAt, '2026-07-28');
  assert.equal(dated.source, 'followup-field');
  assert.equal(dated.hasConversationEvidence, false, 'still no conversation evidence');
});

// ── 22–26. Safety ───────────────────────────────────────────────────────────

test('22/23/24. staleness never sends, never reactivates, never touches the hold', () => {
  const block = stateSrc.slice(stateSrc.indexOf('// ── HOT LEAD STALENESS'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/sendEmail|sheets\(|gmail\(|fetch\(/i.test(block), 'the model performs no I/O');
  assert.ok(!/applyResumeToNotes|clearResumeFromNotes|MANUAL_HOLD/.test(block), 'it cannot alter hold state');
  // A severely stale Hot lead leaves the hold and the sequence exactly as they were.
  const held = { emailStatus: 'replied', emailStep: '2', notes: MANUAL_HOLD_TAG + ' [REPLY: Interested]' };
  const before = JSON.stringify(held);
  const a = deriveNextAction({ stage: 'hot', followup: '2026-06-01' }, held, { now: NOW, activities: [] });
  assert.equal(a.hotState.staleness, HOT_STALENESS.SEVERELY_STALE);
  assert.equal(JSON.stringify(held), before, 'the twin is untouched');
  assert.ok(held.notes.includes(MANUAL_HOLD_TAG), 'the hold survives staleness');
  // Staleness is not reactivation: no resume tag is ever produced.
  assert.ok(!/RESUME/.test(JSON.stringify(a)));
});

test('25/26. staleness never marks ghosted and never closes an opportunity', () => {
  const a = deriveNextAction({ stage: 'hot', followup: '2026-01-01' }, twin(), { now: NOW, activities: [] });
  assert.equal(a.hotState.staleness, HOT_STALENESS.SEVERELY_STALE);
  assert.notEqual(a.type, ACTION_TYPE.NONE_LOST);
  assert.ok(!/ghost/i.test(JSON.stringify(a)), 'no outcome is implied');
  const block = stateSrc.slice(stateSrc.indexOf('// ── HOT LEAD STALENESS'), stateSrc.indexOf('/**\n * The canonical Next Action'));
  assert.ok(!/ghosted|closed_lost|outcome\s*=/.test(block), 'the model decides no outcome');
  // Time passing is explicitly not proof.
  assert.match(a.reason, /nothing is closed automatically/);
});

// ── 27–29. Engine, queues, activity ─────────────────────────────────────────

test('27/28. Hot flows through the ONE canonical engine into the existing queues', () => {
  // No second task engine: the Hot mapper returns ordinary actions.
  assert.match(stateSrc, /function hotNextAction\(lead, \{ activities, now, twin \}\)/);
  assert.match(stateSrc, /if \(stage === 'hot'\) return hotNextAction/);
  assert.ok(!/class HotEngine|deriveHotAction\b/.test(stateSrc));

  // A stale Hot lead sorts and summarises like any other overdue work.
  const stale = deriveNextAction({ stage: 'hot', followup: '2026-08-01' }, twin(), { now: NOW, activities: [] });
  assert.equal(stale.status, ACTION_STATUS.OVERDUE);
  const summary = summarizeNextActions([{ nextAction: stale }]);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.withAction, 1);
  assert.equal(summary.noNextAction, 0, 'a stale Hot lead is real work, not a gap');
  // Overdue sorts ahead of an upcoming automated follow-up.
  const upcoming = { status: ACTION_STATUS.UPCOMING, dueAt: '2026-09-10T00:00:00.000Z' };
  assert.ok(compareNextActions(stale, upcoming) < 0);

  // The undatable case lands in Needs Attention, not silently nowhere.
  const review = deriveNextAction({ stage: 'hot' }, twin(), { now: NOW, activities: [] });
  assert.equal(review.status, ACTION_STATUS.BLOCKED);
  assert.equal(summarizeNextActions([{ nextAction: review }]).blocked, 1);
});

test('29. the human-response event is recorded once, and records only', () => {
  const handler = server.slice(server.indexOf("app.post('/api/leads/:id/human-response'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /stableActivityId\('human-response'/, 'the id is derived, not random');
  assert.match(body, /if \(existing\.some\(activity => activity\.eventId === eventId\)\)/, 'and deduped');
  assert.match(body, /eventType: 'human_response_sent'/);
  assert.match(body, /direction: 'outbound'/);
  // It records; it must not send, and must not write lead state.
  assert.ok(!/sendEmail|gmail\(/i.test(body), 'recording never sends');
  assert.ok(!/values\.update/.test(body), 'no lead row is rewritten');
  assert.ok(!/emailStatus|lastEmailedAt|emailStep/.test(body), 'cold-email state is untouched');
  // A future-dated response is refused rather than skewing the clock.
  assert.match(body, /cannot be recorded in the future/);
});

// ── 30–31. Performance and UI wiring ────────────────────────────────────────

test('30. Hot state adds no per-card sheet read', () => {
  const queue = server.slice(server.indexOf("app.get('/api/leads/next-actions'"));
  const body = queue.slice(0, queue.indexOf('\n});'));
  assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*await[^}]*spreadsheets/.test(body), 'no per-lead await');
  assert.equal((body.match(/spreadsheets\.values\.get/g) || []).length, 3, 'still three fixed reads');
  assert.match(body, /deriveNextAction\(lead, twin, \{ activities, now \}\)/);
  // The model itself performs no I/O, so it cannot introduce one.
  const block = stateSrc.slice(stateSrc.indexOf('// ── HOT LEAD STALENESS'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/await/.test(block));
});

test('the browser renders server-derived state and computes no thresholds', () => {
  assert.match(browser, /function hotChipHtml\(action\)/);
  assert.match(browser, /const hot = action && action\.hotState;/);
  assert.match(browser, /\$\{hotChipHtml\(action\)\}/, 'the card renders it');
  assert.match(browser, /function hotDrawerRows\(next\)/, 'the drawer renders it');
  assert.match(browser, /Waiting on/);
  assert.match(browser, /Last interaction/);
  assert.match(browser, /function logHumanResponse\(\)/);
  // No client-side thresholds: the browser must not know the day counts.
  const ui = browser.slice(browser.indexOf('function hotChipHtml'), browser.indexOf('function naCardHtml'));
  assert.ok(!/[^0-9]7[^0-9]|[^0-9]21[^0-9]/.test(ui.replace(/data-s="[^"]*"/g, '')), 'no stale thresholds in the browser');
  assert.ok(!/addBusinessDays|businessDay\(/.test(ui));
});
