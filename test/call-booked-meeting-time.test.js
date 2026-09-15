'use strict';

// Silver 7 Dental could not be moved to Call Booked.
//
// The drawer's Meeting time input was not the value the stage chip checked: the
// chip read lead.meetingAt, which only changes after a separate "Save call
// details", so a time sitting visibly in the input was refused on every click
// and every click stacked another identical warning. The same drawer showed
// "Added Dec 31, 1969" because GET /api/leads parseInt()-ed an ISO `created`
// into its year (2026 ms after the epoch) and the board wrote that back.
//
// Nothing here touches Google or the network: the booking commit runs against
// an in-memory Sheets double, and browser functions are lifted from index.html
// and run in a VM with stubbed DOM and fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const { commitCallBooked } = require('../integrations/call-booking');
const {
  parseCreatedMs, stageTransitionCheck, deriveCallLifecycle, callLifecycleActions, CALL_STATUS,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

function fnSource(src, name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
  assert.ok(match, `${name} exists`);
  const open = src.indexOf('{', src.indexOf(')', match.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const lifecycleRoute = (() => {
  const start = server.indexOf("app.post('/api/leads/:id/call-lifecycle'");
  assert.notEqual(start, -1);
  const body = server.slice(start);
  return body.slice(0, body.indexOf('\n});'));
})();

// Tue 15 Sep 2026, 10:00 Vancouver.
const NOW = Date.parse('2026-09-15T17:00:00.000Z');
const FUTURE_LOCAL = '2026-09-18T14:30';                 // entered in a Vancouver browser
const FUTURE_ISO = '2026-09-18T21:30:00.000Z';           // the same instant, canonical
const PAST_ISO = '2026-09-10T17:00:00.000Z';

// ── The Sheets double ───────────────────────────────────────────────────────

function sheetDouble({ failUpdate = null, failGet = null, readBack = {} } = {}) {
  const cells = new Map();
  const calls = [];
  const column = range => range.split('!')[1].replace(/\d+$/, '');
  return {
    calls, cells,
    values: {
      async update({ range, requestBody }) {
        calls.push(`update ${column(range)}`);
        if (failUpdate === column(range)) throw new Error('quota exceeded');
        cells.set(range, requestBody.values[0][0]);
        return {};
      },
      async get({ range }) {
        calls.push(`get ${column(range)}`);
        if (failGet === column(range)) throw new Error('read failed');
        const value = column(range) in readBack ? readBack[column(range)] : cells.get(range);
        return { data: { values: value === undefined ? [] : [[value]] } };
      },
    },
  };
}
const commit = (sheet, meetingAt = FUTURE_ISO) => commitCallBooked({
  values: sheet.values, spreadsheetId: 'sheet', sheetName: 'Leads', rowNum: 25, meetingAt,
});

// ── A browser VM ────────────────────────────────────────────────────────────

const BROWSER_FUNCTIONS = ['apiError', 'toLocalDateTimeInput', 'meetingIsoFromLocal', 'formatAddedDate',
  'callBookedMeetingCandidate', 'transitionToCallBooked', 'setStage', 'submitCallAction'];

function drawer({ lead, inputValue = '', drawerOpen = true, respond, nextActions = new Map(), confirmAnswer = false }) {
  const confirms = [];
  const toasts = [];
  const requests = [];
  const refreshed = [];
  const synced = [];
  const input = { value: inputValue, focus() {} };
  const overlay = { classList: { contains: name => name === 'open' && drawerOpen } };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = {
    leads: [lead], detailId: lead.id, pendingStageWrites: new Map(), nextActions,
    LOSS_OUTCOMES: ['no_show', 'ghosted', 'not_interested', 'not_fit', 'timing', 'other'],
    document: { getElementById: id => (id === 'd-meeting-at' ? input : id === 'detail-overlay' ? overlay : null) },
    showToast: (msg, type) => toasts.push({ msg, type }),
    setSaving() {}, openDetail() {}, renderBoard() {}, closeCallModal() {},
    displayStageFor: stage => stage,
    callWhen: iso => iso,
    syncLead: async item => { synced.push({ ...item }); },
    refreshLeadEverywhere: async id => { refreshed.push({ id, stage: lead.stage }); },
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), stageWhenSent: lead.stage });
      return respond(url, init);
    },
    Date: FixedDate, console, clearTimeout() {}, setTimeout() { return 0; },
    confirm: message => { confirms.push(message); return confirmAnswer; },
  };
  vm.createContext(context);
  vm.runInContext(BROWSER_FUNCTIONS.map(name => fnSource(browser, name)).join('\n\n'), context);
  return { context, toasts, requests, refreshed, synced, input, confirms };
}

const ok = body => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });
const silver7 = (extra = {}) => ({
  id: 'CE-mt9ka4dnwfgdo8rlbz', company: 'Silver 7 Dental', email: 'info@silver7dental.ca',
  stage: 'follow_up', meetingAt: '', outcome: '', created: '', ...extra,
});

// ── 1. Entered meeting time + Call Booked succeeds ─────────────────────────

test('1. an entered meeting time is committed, confirmed, then the stage moves', async () => {
  const sheet = sheetDouble();
  const result = await commit(sheet);
  assert.equal(result.ok, true);
  assert.equal(result.meetingAt, FUTURE_ISO);
  assert.deepEqual(sheet.calls, ['update U', 'get U', 'update M', 'get M'],
    'meeting time written, read back, and only then the stage');
  assert.equal(sheet.cells.get('Leads!U25'), FUTURE_ISO);
  assert.equal(sheet.cells.get('Leads!M25'), 'call_booked');
});

test('1b. the drawer books the value visibly in the Meeting time input', async () => {
  const lead = silver7();
  const ui = drawer({ lead, inputValue: FUTURE_LOCAL, respond: () => ok({ ok: true, meetingAt: FUTURE_ISO, stage: 'call_booked' }) });
  // Pin the input's zone: the VM runs in whatever zone the test host has.
  const expectedIso = new Date(FUTURE_LOCAL).toISOString();
  ui.context.setStage(lead.id, 'call_booked');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.requests.length, 1);
  assert.match(ui.requests[0].url, /\/api\/leads\/CE-mt9ka4dnwfgdo8rlbz\/call-lifecycle$/);
  assert.deepEqual(ui.requests[0].body, { action: 'book', meetingAt: expectedIso, expectedMeetingAt: '' });
  assert.equal(ui.synced.length, 0, 'the stage chip no longer PUTs call_booked directly');
  assert.deepEqual(ui.toasts.map(t => t.type), ['success']);
  assert.equal(ui.refreshed.length, 1, 'the board reloads from stored state');
});

// ── 2. Missing meeting time refuses ────────────────────────────────────────

test('2. no entered and no saved meeting time: refused, nothing sent', async () => {
  const lead = silver7();
  const ui = drawer({ lead, respond: () => assert.fail('must not reach the server') });
  const moved = await ui.context.transitionToCallBooked(lead.id);
  assert.equal(moved, false);
  assert.equal(ui.requests.length, 0);
  assert.equal(lead.stage, 'follow_up');
  assert.deepEqual(ui.toasts, [{ msg: 'Add the booked meeting time before moving this lead to Call Booked.', type: 'warning' }]);
  // The server keeps its own gate.
  assert.equal(stageTransitionCheck('call_booked', { meetingAt: '' }).ok, false);
  assert.match(lifecycleRoute, /stageTransitionCheck\('call_booked', \{ meetingAt, outcome: lead\.outcome \}\)/);
});

// ── 3. Invalid meeting time refuses ────────────────────────────────────────

test('3. an invalid meeting time is refused in the browser and in the commit', async () => {
  for (const bad of ['soon', '2026-13-01T10:00', '2026-02-30T10:00', '18/09/2026 14:30']) {
    const lead = silver7();
    const ui = drawer({ lead, inputValue: bad, respond: () => assert.fail('must not reach the server') });
    assert.equal(await ui.context.transitionToCallBooked(lead.id), false, bad);
    assert.equal(ui.requests.length, 0, bad);
    assert.equal(ui.toasts.length, 1, bad);
    assert.match(ui.toasts[0].msg, /Enter a valid meeting date and time/);
  }
  // A past time is refused unless the operator confirms it already happened…
  const lead = silver7();
  const ui = drawer({ lead, inputValue: '2026-09-14T15:30', confirmAnswer: false, respond: () => assert.fail('must not reach the server') });
  assert.equal(await ui.context.transitionToCallBooked(lead.id), false);
  assert.equal(ui.confirms.length, 1);
  assert.deepEqual(ui.toasts.map(t => t.msg), ['A meeting cannot be booked in the past.']);
  // …and anything older than 30 days is refused without asking.
  const old = silver7();
  const stale = drawer({ lead: old, inputValue: '2026-07-01T09:00', confirmAnswer: true, respond: () => assert.fail('must not reach the server') });
  assert.equal(await stale.context.transitionToCallBooked(old.id), false);
  assert.equal(stale.confirms.length, 0);
  assert.deepEqual(stale.toasts.map(t => t.msg), ['A meeting cannot be booked in the past.']);

  for (const bad of ['', 'not a date', '2026-09-18T14:30', '2026-09-18T21:30:00Z']) {
    const sheet = sheetDouble();
    const result = await commit(sheet, bad);
    assert.equal(result.code, 'invalid_meeting_time', bad);
    assert.deepEqual(sheet.calls, [], `${bad}: nothing is written`);
  }
  assert.match(lifecycleRoute, /A valid meeting date and time is required\./);
  assert.match(lifecycleRoute, /A meeting cannot be booked in the past\./);
});

// ── 4. Saved meeting time survives refresh ─────────────────────────────────

test('4. the committed meeting time is what the board reads back after a refresh', async () => {
  const sheet = sheetDouble();
  await commit(sheet);
  // GET /api/leads maps Leads!U into meetingAt; the drawer fills the input from it.
  assert.match(server, /const CALL_DETAIL_COLS = \['meetingAt', 'outcome', 'conversationContext'\]/);
  assert.match(server, /CALL_DETAIL_COLS\.forEach\(\(col, i\) => \{ lead\[col\] = row\[20 \+ i\] \|\| ''; \}\)/);
  assert.match(browser, /getElementById\('d-meeting-at'\)\.value = toLocalDateTimeInput\(lead\.meetingAt\)/);

  // After a refresh the lead carries the saved time and an empty input still books it.
  const lead = silver7({ meetingAt: sheet.cells.get('Leads!U25') });
  const ui = drawer({ lead, inputValue: '', respond: () => ok({ ok: true, meetingAt: FUTURE_ISO }) });
  // Objects built inside the VM have its prototypes, so compare their data.
  assert.deepEqual(JSON.parse(JSON.stringify(ui.context.callBookedMeetingCandidate(lead))), { iso: FUTURE_ISO, source: 'saved' });
  assert.equal(await ui.context.transitionToCallBooked(lead.id), true);
  assert.equal(ui.requests[0].body.meetingAt, FUTURE_ISO);
  assert.equal(ui.requests[0].body.expectedMeetingAt, FUTURE_ISO);
});

test('4b. a saved future time does not block entering Call Booked, and is not booked twice', () => {
  // A time stored by Save call details reads as "scheduled", which forbids `book`
  // for a lead already in Call Booked — but not for one entering it.
  assert.match(lifecycleRoute, /const entersCallBooked = action === 'book'\s*&& !\['call_booked', 'closed_won', 'closed_lost'\]\.includes\(currentStage\)/);
  assert.match(lifecycleRoute, /if \(!allowed\[action\] && !entersCallBooked\) \{/);
  assert.match(lifecycleRoute, /meetingAt === previousMeetingAt && !entersCallBooked/);
  assert.match(lifecycleRoute, /bookingAlreadyRecorded/);
  assert.ok(lifecycleRoute.indexOf('unchanged: true') < lifecycleRoute.indexOf('commitCallBooked('));
});

// ── 5. The stage cannot outrun meeting-time persistence ────────────────────

test('5. a meeting time that is not saved, or not confirmed, never moves the stage', async () => {
  const notSaved = sheetDouble({ failUpdate: 'U' });
  assert.equal((await commit(notSaved)).code, 'meeting_not_saved');
  assert.deepEqual(notSaved.calls, ['update U']);

  const unreadable = sheetDouble({ failGet: 'U' });
  assert.equal((await commit(unreadable)).code, 'meeting_not_confirmed');
  assert.ok(!unreadable.calls.includes('update M'));

  const mismatch = sheetDouble({ readBack: { U: '2026-09-18T20:30:00.000Z' } });
  const result = await commit(mismatch);
  assert.equal(result.code, 'meeting_not_confirmed');
  assert.equal(result.stageChanged, false);
  assert.ok(!mismatch.calls.includes('update M'));

  const stageFails = sheetDouble({ failUpdate: 'M' });
  const partial = await commit(stageFails);
  assert.deepEqual({ ok: partial.ok, code: partial.code, meetingSaved: partial.meetingSaved, stageChanged: partial.stageChanged },
    { ok: false, code: 'stage_not_saved', meetingSaved: true, stageChanged: false });

  const auth = sheetDouble();
  auth.values.update = async () => { const error = new Error('invalid_grant'); error.isAuthError = true; throw error; };
  await assert.rejects(commit(auth), /invalid_grant/, 'an expired login reaches the route, not "not saved"');
});

test('5b. the route orders hold → commit → timeline, and refuses without moving the stage', () => {
  const holdAt = lifecycleRoute.indexOf('ensureManualHoldDurable(req.params.id, email)');
  const commitAt = lifecycleRoute.indexOf('commitCallBooked(');
  const appendAt = lifecycleRoute.indexOf('appendColdCallActivities(pending)');
  assert.ok(holdAt !== -1 && holdAt < commitAt && commitAt < appendAt);
  assert.match(lifecycleRoute, /if \(!committed\.ok\) \{[\s\S]{0,400}return res\.status\(/);
  assert.ok(!/values\.batchUpdate/.test(lifecycleRoute), 'no unverified combined write remains');
});

test('5c. the browser never shows Call Booked before the server confirms it', async () => {
  const lead = silver7();
  const ui = drawer({ lead, inputValue: FUTURE_LOCAL,
    respond: () => refused(409, { error: 'The meeting time was not saved, so the stage was not changed.', code: 'meeting_not_saved' }) });
  assert.equal(await ui.context.transitionToCallBooked(lead.id), false);
  assert.equal(ui.requests[0].stageWhenSent, 'follow_up', 'no optimistic stage before the request');
  assert.equal(lead.stage, 'follow_up', 'and none after a failure');
  assert.deepEqual(ui.toasts, [{ msg: 'The meeting time was not saved, so the stage was not changed.', type: 'error' }]);

  // Board drag and the mobile picker go through the same path.
  const move = fnSource(browser, 'moveLeadToStage');
  assert.match(move, /return transitionToCallBooked\(leadId, \{ openOnRefusal: true \}\)/);
  assert.ok(move.indexOf('transitionToCallBooked') < move.indexOf('lead.stage = toStage'));
  // Edit Lead saves its other fields first, then books.
  const save = fnSource(browser, 'saveLead');
  assert.match(save, /if \(entersCallBooked\) lead\.stage = existingLead\.stage;/);
  assert.ok(save.indexOf('await syncLead(lead)') < save.indexOf('await transitionToCallBooked(lead.id'));
});

test('5d. a second click while a booking is in flight sends nothing more', async () => {
  const lead = silver7();
  let release;
  const ui = drawer({ lead, inputValue: FUTURE_LOCAL,
    respond: () => new Promise(resolve => { release = () => resolve(ok({ ok: true, meetingAt: FUTURE_ISO })); }) });
  const first = ui.context.transitionToCallBooked(lead.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await ui.context.transitionToCallBooked(lead.id), false);
  release();
  assert.equal(await first, true);
  assert.equal(ui.requests.length, 1);
});

// ── 6. No Show uses the existing booked meeting time ───────────────────────

test('6. No Show resolves the canonical booked time without asking for it again', async () => {
  const booked = [{ eventType: 'call_booked', occurredAt: '2026-09-05T00:00:00.000Z', metadata: JSON.stringify({ meetingAt: PAST_ISO }) }];
  const state = deriveCallLifecycle({ stage: 'call_booked', meetingAt: PAST_ISO }, { activities: booked, now: NOW });
  assert.equal(state.status, CALL_STATUS.OUTCOME_PENDING, 'a passed meeting waits for a human');
  assert.equal(callLifecycleActions(state, NOW).no_show, true);
  assert.equal(state.meetingAt, PAST_ISO);

  // The drawer sends no new time for a no-show: only the one it was showing.
  const lead = silver7({ stage: 'call_booked', meetingAt: PAST_ISO });
  const nextActions = new Map([[lead.id, { nextAction: { callState: { status: 'outcome_pending', meetingAt: PAST_ISO } } }]]);
  const ui = drawer({ lead, nextActions, respond: () => ok({ ok: true, status: 'no_show' }) });
  await ui.context.submitCallAction('no_show');
  assert.deepEqual(ui.requests[0].body, { action: 'no_show', expectedMeetingAt: PAST_ISO });
  assert.ok(!ui.toasts.some(t => /Choose a meeting date/.test(t.msg)));
  assert.match(browser, /const needsTime = action === 'book' \|\| action === 'reschedule';/);

  // Server-side, the no-show keeps the stored time and hands it to the recovery plan.
  assert.match(lifecycleRoute, /let meetingAt = String\(lifecycle\.meetingAt \|\| ''\);/);
  assert.match(lifecycleRoute, /lead: \{ \.\.\.lead, meetingAt, stage: 'call_booked' \}/);
  const reassigned = [...lifecycleRoute.matchAll(/\n\s+meetingAt = /g)].map(m => m.index);
  const bookBlock = lifecycleRoute.indexOf("if (action === 'book' || action === 'reschedule') {");
  const bookEnd = lifecycleRoute.indexOf('// Resolutions write NO lead state');
  assert.ok(reassigned.length && reassigned.every(at => at > bookBlock && at < bookEnd),
    'only booking and rescheduling change the meeting time');
});

test('6b. a real meeting that already happened can be recorded, then marked no show', async () => {
  // Silver 7: booked for Sep 14, 3:30 PM Vancouver; they did not attend.
  const lead = silver7();
  const pastIso = new Date('2026-09-14T15:30').toISOString();
  const ui = drawer({ lead, inputValue: '2026-09-14T15:30', confirmAnswer: true,
    respond: () => ok({ ok: true, meetingAt: pastIso, stage: 'call_booked', status: 'outcome_pending' }) });
  assert.equal(await ui.context.transitionToCallBooked(lead.id), true);
  assert.equal(ui.confirms.length, 1, 'the operator is asked, every time');
  assert.deepEqual(ui.requests[0].body, { action: 'book', meetingAt: pastIso, expectedMeetingAt: '', pastMeetingConfirmed: true });

  // The server accepts a past time only for that narrow case.
  assert.match(lifecycleRoute, /const recordsPastMeeting = entersCallBooked && req\.body\?\.pastMeetingConfirmed === true\s*&& Date\.now\(\) - ms <= PAST_MEETING_RECORD_WINDOW_MS;/);
  assert.match(lifecycleRoute, /if \(!recordsPastMeeting\) \{\s*return res\.status\(422\)\.json\(\{ error: 'A meeting cannot be booked in the past\.'/);
  assert.match(server, /const PAST_MEETING_RECORD_WINDOW_MS = 30 \* 86400000;/);

  // Recorded, it is immediately Outcome Pending, so No Show is offered with that time.
  const booked = [{ eventType: 'call_booked', occurredAt: '2026-09-15T17:00:00.000Z', metadata: JSON.stringify({ meetingAt: '2026-09-14T22:30:00.000Z' }) }];
  const state = deriveCallLifecycle({ stage: 'call_booked', meetingAt: '2026-09-14T22:30:00.000Z' }, { activities: booked, now: NOW });
  assert.equal(state.status, CALL_STATUS.OUTCOME_PENDING);
  assert.equal(callLifecycleActions(state, NOW).no_show, true);
  assert.equal(callLifecycleActions(state, NOW).reschedule, true);
});

// ── 7. No epoch dates ──────────────────────────────────────────────────────

test('7. a missing or mangled created date is unknown, never Dec 31, 1969', () => {
  const { context } = drawer({ lead: silver7(), respond: () => ok({}) });
  for (const bad of ['', null, undefined, 0, '0', 2026, '2026', 'abc', Number.NaN, '1969-12-31T23:59:59.000Z']) {
    assert.equal(context.formatAddedDate(bad), '—', `browser: ${String(bad)}`);
    assert.equal(parseCreatedMs(bad), null, `server: ${String(bad)}`);
  }
  // Both real encodings still read. 06:12Z on the 14th is the 13th in Vancouver.
  assert.equal(context.formatAddedDate('2026-09-14T06:12:10.184Z'), 'Sep 13, 2026');
  assert.equal(context.formatAddedDate(Date.parse('2026-09-14T20:00:00.000Z')), 'Sep 14, 2026');
  assert.equal(parseCreatedMs('1757000000000'), 1757000000000);
  assert.equal(parseCreatedMs('2026-09-14T06:12:10.184Z'), Date.parse('2026-09-14T06:12:10.184Z'));

  assert.ok(!/parseInt\(lead\.created\)/.test(server), 'the year-truncating reader is gone');
  assert.match(server, /lead\.created = parseCreatedMs\(lead\.created\) \?\? '';/);
  assert.match(browser, /\{ label: 'Added', val: formatAddedDate\(lead\.created\) \}/);
  // A board save cannot write an unreadable created value over the stored one.
  const put = server.slice(server.indexOf("app.put('/api/leads/:id'"), server.indexOf('const previousNotes'));
  assert.match(put, /parseCreatedMs\(lead\.created\) === null\) \{\s*vals\[0\]\[createdIndex\] = String\(priorRow\[createdIndex\] \|\| ''\);/);
  assert.ok(put.indexOf('createdIndex') < put.indexOf('range:           `${SHEET_NAME}!A${rowNum}:Q${rowNum}`'));
  assert.match(fnSource(browser, 'saveLead'), /created:\s+editingId \? \(existingLead\.created \?\? ''\) : Date\.now\(\)/);
});

// ── 8. One message per failed transition ───────────────────────────────────

test('8. repeating a refused move shows one message, not a stack', () => {
  const children = [];
  const make = () => {
    const el = { className: '', textContent: '', isConnected: true,
      classList: { add() {}, remove() {} }, remove() { this.isConnected = false; } };
    return el;
  };
  const context = {
    document: {
      getElementById: () => ({ appendChild: el => children.push(el) }),
      createElement: make,
    },
    requestAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(`${fnSource(browser, 'showToast')}\n${fnSource(browser, 'scheduleToastRemoval')}`, context);
  const warning = 'Add the booked meeting time before moving this lead to Call Booked.';
  for (let i = 0; i < 4; i++) context.showToast(warning, 'warning');
  assert.equal(children.length, 1);
  context.showToast('Call booked.', 'success');
  assert.equal(children.length, 2, 'different messages still each show');
  children[0].remove();
  context.showToast(warning, 'warning');
  assert.equal(children.length, 3, 'once dismissed, the next refusal shows again');
});

// ── 9. Timezone round trip ─────────────────────────────────────────────────

test('9. a Vancouver wall-clock time round-trips through UTC across DST', () => {
  const sources = ['toLocalDateTimeInput', 'meetingIsoFromLocal', 'callWhen'].map(name => fnSource(browser, name)).join('\n');
  const script = `${sources}
    const out = {
      summerOffset: new Date(2026, 6, 1).getTimezoneOffset(),
      winterOffset: new Date(2026, 11, 1).getTimezoneOffset(),
      summerIso: meetingIsoFromLocal('2026-09-18T14:30'),
      winterIso: meetingIsoFromLocal('2026-12-01T09:00'),
      springGap: meetingIsoFromLocal('2026-03-08T02:30'),
    };
    out.summerBack = toLocalDateTimeInput(out.summerIso);
    out.winterBack = toLocalDateTimeInput(out.winterIso);
    out.summerShown = callWhen(out.summerIso);
    process.stdout.write(JSON.stringify(out));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Vancouver' }, encoding: 'utf8',
  }));
  assert.deepEqual([out.summerOffset, out.winterOffset], [420, 480], 'the child really runs in Vancouver time');
  assert.equal(out.summerIso, '2026-09-18T21:30:00.000Z', 'PDT is UTC-7');
  assert.equal(out.winterIso, '2026-12-01T17:00:00.000Z', 'PST is UTC-8');
  assert.equal(out.summerBack, '2026-09-18T14:30');
  assert.equal(out.winterBack, '2026-12-01T09:00');
  assert.match(out.summerShown, /^Sep 18 · 2:30\sPM$/u);
  assert.equal(out.springGap, null, 'a wall-clock time that does not exist on the DST change is refused');
});
