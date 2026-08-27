'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACTION_OWNER, ACTION_STATUS, ACTION_TYPE, BUSINESS_TIMEZONE,
  businessDay, deriveActionStatus, deriveNextAction,
  compareNextActions, summarizeNextActions,
  MANUAL_HOLD_TAG,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout hands these tests CRLF
// source while an editor-written file is LF. Normalising on read keeps the
// slicing and regexes below independent of how git materialised the file.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const agent = readSource(path.join(root, 'outreach-agent.js'));

// Every test pins `now` so the suite cannot drift with the wall clock.
const NOW = new Date('2026-08-26T19:00:00.000Z'); // 12:00 Vancouver, Aug 26
const ctx = (activities = []) => ({ now: NOW, activities });

function event(eventType, occurredAt) {
  return { eventType, occurredAt, leadId: 'L1', email: 'a@example.com' };
}

// ── Follow Up / automation ──────────────────────────────────────────────────

test('1. active automated Follow Up derives an automation-owned action', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-25T00:00:00.000Z' };
  const next = deriveNextAction({ stage: 'follow_up' }, twin, ctx());
  assert.equal(next.type, ACTION_TYPE.AUTOMATED_FOLLOW_UP);
  assert.equal(next.owner, ACTION_OWNER.AUTOMATION);
  assert.equal(next.label, 'Automated follow-up #2');
  assert.equal(next.needsAttention, false);
});

test('2. the sequence due date comes from the real cadence, not a new constant', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-25T00:00:00.000Z' };
  // +3 days, mirroring FOLLOW_UP_SEQUENCE step 1 in the agent.
  assert.equal(deriveNextAction({ stage: 'follow_up' }, twin, ctx()).dueAt, '2026-08-28T00:00:00.000Z');
  const step2 = { emailStatus: 'emailed', emailStep: '2', lastEmailedAt: '2026-08-25T00:00:00.000Z' };
  assert.equal(deriveNextAction({ stage: 'follow_up' }, step2, ctx()).dueAt, '2026-08-30T00:00:00.000Z');
  assert.match(agent, /delayDays: 3/);
  assert.match(agent, /delayDays: 5/);
});

test('a queued lead derives an automation-owned first send', () => {
  const next = deriveNextAction({ stage: 'follow_up' }, { stage: 'Queued', emailStatus: '' }, ctx());
  assert.equal(next.type, ACTION_TYPE.AUTOMATED_FIRST_SEND);
  assert.equal(next.owner, ACTION_OWNER.AUTOMATION);
});

// ── Hot / replies ───────────────────────────────────────────────────────────

test('3. a Hot positive reply derives a human response action', () => {
  const twin = { emailStatus: 'replied', notes: '[REPLY: Interested]' };
  const next = deriveNextAction({ stage: 'hot' }, twin, ctx([event('positive_reply', '2026-08-25T10:00:00.000Z')]));
  assert.equal(next.type, ACTION_TYPE.RESPOND_REPLY);
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.equal(next.label, 'Respond to positive reply');
  assert.equal(next.dueAt, '2026-08-25T10:00:00.000Z');
  assert.equal(next.status, ACTION_STATUS.OVERDUE); // reply landed yesterday
});

test('4. once a human has answered, the state becomes Waiting for prospect', () => {
  const twin = { emailStatus: 'replied', notes: '[REPLY: Interested]' };
  const activities = [
    event('positive_reply', '2026-08-24T10:00:00.000Z'),
    event('conversation_note', '2026-08-25T10:00:00.000Z'), // we answered after
  ];
  const next = deriveNextAction({ stage: 'hot' }, twin, ctx(activities));
  assert.equal(next.type, ACTION_TYPE.WAITING_PROSPECT);
  assert.equal(next.owner, ACTION_OWNER.WAITING);
  assert.equal(next.status, ACTION_STATUS.WAITING);
});

test('5. a Needs Human reply derives Review reply', () => {
  const twin = { emailStatus: 'replied', notes: '[REPLY: Question]' };
  const next = deriveNextAction({ stage: 'hot' }, twin, ctx([event('positive_reply', '2026-08-26T15:00:00.000Z')]));
  assert.equal(next.type, ACTION_TYPE.REVIEW_REPLY);
  assert.equal(next.label, 'Review reply');
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
});

test('6. an unclassified reply derives a review action and never guesses', () => {
  const twin = { emailStatus: 'replied', notes: '[REPLY: Replied]' };
  const next = deriveNextAction({ stage: 'hot' }, twin, ctx([event('positive_reply', '2026-08-26T15:00:00.000Z')]));
  assert.equal(next.type, ACTION_TYPE.REVIEW_UNCLASSIFIED);
  assert.equal(next.label, 'Review unclassified reply');
  assert.match(next.reason, /do not guess/);
});

// ── Late replies ────────────────────────────────────────────────────────────

test('7. a late positive reply derives a human attention action', () => {
  const twin = { emailStatus: 'done', notes: '[LATE REPLY: Interested — needs review]\n[REPLY: Interested]' };
  const next = deriveNextAction({ stage: 'follow_up' }, twin, ctx([event('late_reply', '2026-08-26T09:00:00.000Z')]));
  assert.equal(next.type, ACTION_TYPE.RESPOND_LATE_REPLY);
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.equal(next.status, ACTION_STATUS.DUE_TODAY);
});

test('8. a late reply never resumes automation and never clears the hold', () => {
  const twin = {
    emailStatus: 'done', emailStep: '2',
    notes: MANUAL_HOLD_TAG + ' [LATE REPLY: Question — needs review] [REPLY: Question]',
  };
  const next = deriveNextAction({ stage: 'follow_up' }, twin, ctx([event('late_reply', '2026-08-26T09:00:00.000Z')]));
  assert.equal(next.type, ACTION_TYPE.REVIEW_LATE_REPLY);
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.notEqual(next.owner, ACTION_OWNER.AUTOMATION);
  assert.match(next.reason, /automation stays stopped/);
  // The engine is pure: the twin it was handed is untouched.
  assert.ok(twin.notes.includes(MANUAL_HOLD_TAG));
  assert.equal(twin.emailStatus, 'done');
});

// ── Call Booked ─────────────────────────────────────────────────────────────

test('9. Call Booked derives a Sales call owned by the meeting', () => {
  const next = deriveNextAction({ stage: 'call_booked', meetingAt: '2026-08-30T21:30:00.000Z' }, null, ctx());
  assert.equal(next.type, ACTION_TYPE.SALES_CALL);
  assert.equal(next.label, 'Sales call');
  assert.equal(next.owner, ACTION_OWNER.MEETING);
  assert.equal(next.dueAt, '2026-08-30T21:30:00.000Z');
  assert.equal(next.status, ACTION_STATUS.UPCOMING);
});

test('10. a passed meeting with no outcome derives Record call outcome, overdue', () => {
  const next = deriveNextAction({ stage: 'call_booked', meetingAt: '2026-08-24T21:30:00.000Z' }, null, ctx());
  assert.equal(next.type, ACTION_TYPE.RECORD_CALL_OUTCOME);
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.equal(next.status, ACTION_STATUS.OVERDUE);
  assert.equal(next.needsAttention, true);
  // Never infers the outcome itself.
  assert.ok(!/no.?show|completed/i.test(next.label));
});

test('a passed meeting WITH an outcome stops asking for one', () => {
  const next = deriveNextAction(
    { stage: 'call_booked', meetingAt: '2026-08-24T21:30:00.000Z', outcome: 'no_show' }, null, ctx());
  assert.equal(next.type, ACTION_TYPE.CLOSE_OUT_CALL);
  assert.equal(next.needsAttention, false);
});

// ── Terminal stages ─────────────────────────────────────────────────────────

test('11. Closed Won derives no action and is not overdue', () => {
  const next = deriveNextAction({ stage: 'closed_won' }, { emailStatus: 'done' }, ctx());
  assert.equal(next.type, ACTION_TYPE.NONE_WON);
  assert.equal(next.status, ACTION_STATUS.NONE);
  assert.notEqual(next.status, ACTION_STATUS.OVERDUE);
  assert.equal(next.dueAt, null);
  assert.equal(next.needsAttention, false);
});

test('12. a hard Closed Lost derives no action', () => {
  const next = deriveNextAction({ stage: 'closed_lost', outcome: 'not_interested' }, null, ctx());
  assert.equal(next.type, ACTION_TYPE.NONE_LOST);
  assert.equal(next.status, ACTION_STATUS.NONE);
  assert.equal(next.recoverable, false);
});

test('13. a recoverable loss is flagged but schedules nothing that could send', () => {
  const next = deriveNextAction({ stage: 'closed_lost', outcome: 'no_show' }, null, ctx());
  assert.equal(next.recoverable, true);
  assert.equal(next.dueAt, null, 'no fake due date before a recovery system exists');
  assert.equal(next.owner, ACTION_OWNER.NONE);
  assert.equal(next.status, ACTION_STATUS.NONE);
  assert.match(next.reason, /recoverable/);
});

// ── Gaps and blocks ─────────────────────────────────────────────────────────

test('14. an active lead with insufficient state reports No next action', () => {
  const next = deriveNextAction({ stage: 'follow_up' }, { emailStatus: 'done' }, ctx());
  assert.equal(next.type, ACTION_TYPE.NO_NEXT_ACTION);
  assert.equal(next.needsAttention, true);
  assert.equal(next.label, 'No next action defined');

  const hot = deriveNextAction({ stage: 'hot' }, { emailStatus: 'replied' }, ctx());
  assert.equal(hot.type, ACTION_TYPE.NO_NEXT_ACTION);
  assert.equal(hot.needsAttention, true);
});

test('15. a manual hold over a live sequence produces Blocked', () => {
  const twin = {
    emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-25T00:00:00.000Z',
    notes: MANUAL_HOLD_TAG + ' human took over',
  };
  const next = deriveNextAction({ stage: 'follow_up' }, twin, ctx());
  assert.equal(next.type, ACTION_TYPE.BLOCKED_BY_HOLD);
  assert.equal(next.status, ACTION_STATUS.BLOCKED);
  assert.equal(next.needsAttention, true);
  assert.match(next.reason, /releasing the hold is not automatic/);
});

test('a hold on an exhausted sequence is not reported as blocked', () => {
  const twin = { emailStatus: 'done', emailStep: '3', notes: MANUAL_HOLD_TAG };
  const next = deriveNextAction({ stage: 'follow_up' }, twin, ctx());
  assert.notEqual(next.type, ACTION_TYPE.BLOCKED_BY_HOLD);
});

// ── Status derivation / timezone ────────────────────────────────────────────

test('16. Due Today is computed on the business calendar, not on UTC', () => {
  assert.equal(BUSINESS_TIMEZONE, 'America/Vancouver');
  // 2026-08-27T05:00Z is 22:00 on Aug 26 in Vancouver — still "today" there,
  // even though UTC has already rolled over to the 27th.
  assert.equal(businessDay('2026-08-27T05:00:00.000Z'), '2026-08-26');
  assert.equal(deriveActionStatus('2026-08-27T05:00:00.000Z', NOW), ACTION_STATUS.DUE_TODAY);
  // And the reverse: 07:00Z on the 27th is already the 27th in Vancouver.
  assert.equal(deriveActionStatus('2026-08-27T18:00:00.000Z', NOW), ACTION_STATUS.UPCOMING);
});

test('17. Overdue is derived for a past due date', () => {
  assert.equal(deriveActionStatus('2026-08-25T12:00:00.000Z', NOW), ACTION_STATUS.OVERDUE);
});

test('18. Upcoming is derived for a future due date', () => {
  assert.equal(deriveActionStatus('2026-09-04T12:00:00.000Z', NOW), ACTION_STATUS.UPCOMING);
  assert.equal(deriveActionStatus(null, NOW), null);
});

// ── UI wiring ───────────────────────────────────────────────────────────────

test('19. the pipeline card renders the derived action and its due line', () => {
  assert.match(browser, /function naCardHtml\(leadId\)/);
  assert.match(browser, /\$\{naCardHtml\(lead\.id\)\}/, 'buildCard injects the block');
  assert.match(browser, /Next: '\s*\+\s*esc\(action\.label\)/);
  // "Due: " only prefixes a real date; undated states read as their own phrase.
  assert.match(browser, /\$\{action\.dueAt \? 'Due: ' : ''\}\$\{esc\(due\)\}/);
  // Terminal leads show nothing rather than an empty "Next:" line.
  assert.match(browser, /if \(action\.status === 'none'\) return '';/);
});

test('20. the drawer renders the canonical action with owner, status, why and source', () => {
  const drawer = browser.slice(browser.indexOf('function renderPipelineState'), browser.indexOf('function setMotion'));
  assert.match(drawer, /Next action/);
  assert.match(drawer, /pipeline-row-label">Owner/);
  assert.match(drawer, /NA_STATUS_LABEL\[next\.status\]/);
  assert.match(drawer, /pipeline-row-label">Why/);
  assert.match(drawer, /pipeline-row-label">Derived from/);
  assert.match(drawer, /Recovery eligible/);
});

test('21/22/23. Due Today, Overdue and No Next Action filters exist and select correctly', () => {
  for (const id of ['overdue', 'due_today', 'needs_attention', 'no_next_action']) {
    assert.match(browser, new RegExp(`setActionFilter\\('${id}'\\)`), `${id} tab`);
  }
  // The matcher is a pure function of the derived action, exercised here.
  const block = browser.slice(browser.indexOf('function naMatchesFilter'));
  const naMatchesFilter = new Function('return ' + block.slice(0, block.indexOf('\n}\n') + 2))();
  const mk = (status, type = 'respond_reply', needsAttention = false) => ({ status, type, needsAttention });
  assert.equal(naMatchesFilter(mk('overdue'), 'overdue'), true);
  assert.equal(naMatchesFilter(mk('due_today'), 'overdue'), false);
  assert.equal(naMatchesFilter(mk('due_today'), 'due_today'), true);
  assert.equal(naMatchesFilter(mk('blocked', 'no_next_action', true), 'no_next_action'), true);
  assert.equal(naMatchesFilter(mk('upcoming'), 'no_next_action'), false);
  assert.equal(naMatchesFilter(mk('blocked', 'blocked_by_hold', true), 'needs_attention'), true);
  assert.equal(naMatchesFilter(mk('none', 'none_won'), 'needs_attention'), false);
});

test('24. sorting puts overdue first, then blocked, due today, upcoming, waiting', () => {
  const actions = [
    { status: ACTION_STATUS.WAITING, dueAt: null },
    { status: ACTION_STATUS.UPCOMING, dueAt: '2026-09-01T00:00:00.000Z' },
    { status: ACTION_STATUS.OVERDUE, dueAt: '2026-08-25T00:00:00.000Z' },
    { status: ACTION_STATUS.DUE_TODAY, dueAt: '2026-08-26T00:00:00.000Z' },
    { status: ACTION_STATUS.BLOCKED, dueAt: null },
    { status: ACTION_STATUS.OVERDUE, dueAt: '2026-08-20T00:00:00.000Z' },
  ];
  const sorted = [...actions].sort(compareNextActions).map(a => a.status);
  assert.deepEqual(sorted, [
    ACTION_STATUS.OVERDUE, ACTION_STATUS.OVERDUE, ACTION_STATUS.BLOCKED,
    ACTION_STATUS.DUE_TODAY, ACTION_STATUS.UPCOMING, ACTION_STATUS.WAITING,
  ]);
  // Oldest first within the same status.
  const overdue = [...actions].sort(compareNextActions).slice(0, 2).map(a => a.dueAt);
  assert.deepEqual(overdue, ['2026-08-20T00:00:00.000Z', '2026-08-25T00:00:00.000Z']);
});

test('the queue view does not reorder the Kanban columns', () => {
  // The stage columns still sort by compareLeads; the queue is a separate render.
  assert.match(browser, /stageLeads = filtered\.filter\(.*\)\.sort\(compareLeads\)/);
  assert.match(browser, /if \(actionFilter !== 'none'\) \{\s*renderActionQueue\(board, filtered\);/);
});

test('the summary counts every bucket the audit reports on', () => {
  const entries = [
    { nextAction: { status: ACTION_STATUS.OVERDUE, type: ACTION_TYPE.RESPOND_REPLY } },
    { nextAction: { status: ACTION_STATUS.DUE_TODAY, type: ACTION_TYPE.REVIEW_REPLY } },
    { nextAction: { status: ACTION_STATUS.WAITING, type: ACTION_TYPE.WAITING_PROSPECT } },
    { nextAction: { status: ACTION_STATUS.BLOCKED, type: ACTION_TYPE.NO_NEXT_ACTION } },
    { nextAction: { status: ACTION_STATUS.NONE, type: ACTION_TYPE.NONE_WON } },
  ];
  const summary = summarizeNextActions(entries);
  assert.equal(summary.total, 5);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.dueToday, 1);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.noNextAction, 1);
  assert.equal(summary.terminal, 1);
  assert.equal(summary.withAction, 3);
});

// ── Safety ──────────────────────────────────────────────────────────────────

test('25. no derivation can cause a send: the engine has no outbound path', () => {
  const source = readSource(path.join(root, 'integrations', 'pipeline-state.js'));
  assert.ok(!/sendEmail|nodemailer|gmail\(|sheets\(|require\('googleapis'\)/.test(source));
  assert.ok(!/axios|fetch\(/.test(source), 'engine makes no network call');
});

test('26. no derivation can change a stage: the queue endpoint only reads', () => {
  const handler = server.slice(server.indexOf("app.get('/api/leads/next-actions'"));
  const body = handler.slice(0, handler.indexOf('\napp.'));
  assert.ok(!/values\.(update|append|batchUpdate|clear)/.test(body), 'no sheet writes');
  assert.ok(!/applyManualHold|sendEmail|moveLead/.test(body));
  assert.match(server, /app\.get\('\/api\/leads\/next-actions', requireAuth/);
});

test('the browser queue never mutates: it only reads and opens the drawer', () => {
  const block = browser.slice(browser.indexOf('// ── NEXT ACTION ─'), browser.indexOf('function renderBoard'));
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(block), 'no mutating fetch');
  assert.ok(!/moveLeadToStage|syncLead|applyHold/.test(block));
  assert.equal((block.match(/fetch\(/g) || []).length, 1, 'exactly one read request');
});

test('the engine is pure — deriving twice does not alter its inputs', () => {
  const lead = { stage: 'hot', followup: '2026-08-30' };
  const twin = { emailStatus: 'replied', emailStep: '2', notes: MANUAL_HOLD_TAG + ' [REPLY: Interested]' };
  const before = JSON.stringify({ lead, twin });
  deriveNextAction(lead, twin, ctx([event('positive_reply', '2026-08-25T10:00:00.000Z')]));
  deriveNextAction(lead, twin, ctx());
  assert.equal(JSON.stringify({ lead, twin }), before);
});

test('27/28/29/30. the engine reuses the canonical modules rather than forking them', () => {
  const source = readSource(path.join(root, 'integrations', 'pipeline-state.js'));
  // Reply buckets come from reply-analytics, not a second classifier.
  assert.match(source, /require\('\.\/reply-analytics'\)/);
  assert.ok(!/INTERESTED|MEETING_REQUEST|NOT_INTERESTED/.test(source), 'no second reply mapping');
  // Manual hold and cadence stay single-sourced.
  assert.match(source, /MANUAL_HOLD_TAG/);
  assert.match(source, /mirrors FOLLOW_UP_SEQUENCE/i);
  // The cadence still matches the agent's real sequence.
  assert.match(source, /FOLLOW_UP_DELAY_DAYS = Object\.freeze\(\[3, 5\]\)/);
});
