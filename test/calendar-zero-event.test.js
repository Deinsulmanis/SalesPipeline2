'use strict';

// F1 — the Calendar pre-check no longer downloads the CRM snapshot when Google
// reports no changed events.
//
// runGoogleCalendarSync() runs before EVERY automation launch and on a
// five-minute tick. Its loadContext() is loadBookingContext() -> the shared
// outreach dataset -> in primary mode a full outreach_leads corpus download.
// Production measured ~680 of those a day, all for syncs that returned zero
// events, where planning cannot produce a single plan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGoogleCalendarSync } = require('../integrations/google-calendar');
const { sheetsFallbackAllowed } = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const server = readSource('server.js');
const agent = readSource('outreach-agent.js');

function harness({ fetchResults, loadContext, plans = [], applyResult } = {}) {
  const calls = { read: 0, fetch: [], load: 0, plan: [], apply: [], write: [] };
  const h = {
    enabled: true, calendarId: 'cal@x.test', appointmentScheduleId: 'sched1',
    readState: async () => { calls.read++; return { syncToken: 'old-token', needsFullSync: false }; },
    fetchChanges: async args => { calls.fetch.push(args); return fetchResults[calls.fetch.length - 1]; },
    loadContext: async () => {
      calls.load++;
      if (loadContext) return loadContext();
      return { dataset: { leads: [] }, boardLeads: [], activities: [] };
    },
    planBookings: async (events, context) => { calls.plan.push({ events, context }); return plans; },
    applyPlan: async item => { calls.apply.push(item); return applyResult || { ok: true, leadId: 'L1' }; },
    writeState: async state => { calls.write.push(state); },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { calls, h };
}

const ok = (events, over = {}) => ({
  ok: true, complete: true, events, nextSyncToken: 'new-token', at: '2026-09-24T03:25:00.000Z', ...over,
});

test('F1.1 zero events: no context load, no planning, checkpoint advances', async () => {
  const { calls, h } = harness({ fetchResults: [ok([])] });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, true);
  assert.equal(result.contextLoaded, false);
  assert.equal(result.events, 0);
  assert.equal(result.mutations, 0);
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(calls.load, 0, 'the CRM snapshot (outreach corpus) is not loaded');
  assert.equal(calls.plan.length, 0, 'nothing is planned');
  assert.equal(calls.apply.length, 0, 'nothing is applied');
  assert.equal(calls.write.length, 1);
  assert.deepEqual(calls.write[0], {
    syncToken: 'new-token', needsFullSync: false, lastError: null,
    lastAttemptAt: '2026-09-24T03:25:00.000Z', lastSyncAt: '2026-09-24T03:25:00.000Z',
  });
});

test('F1.1 a result with no events array is treated exactly like an empty one', async () => {
  const { calls, h } = harness({ fetchResults: [{ ok: true, complete: true, nextSyncToken: 't2', at: 'x' }] });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, true);
  assert.equal(calls.load, 0);
  assert.equal(calls.write[0].syncToken, 't2');
});

test('F1.1 the zero-event checkpoint equals the one the old full path wrote', async () => {
  // The old path, with zero events: load context, plan [] -> no plans, write
  // nextSyncState(previous, completed). The skip must write the same state.
  const { nextSyncState } = require('../integrations/google-calendar');
  const fetched = ok([]);
  const expected = nextSyncState({ syncToken: 'old-token', needsFullSync: false },
    { ...fetched, ok: true, complete: true });
  const { calls, h } = harness({ fetchResults: [fetched] });
  await runGoogleCalendarSync(h);
  assert.deepEqual(calls.write[0], expected);
});

test('F1.1 an unreadable CRM snapshot cannot matter when there is nothing to plan', async () => {
  const { calls, h } = harness({
    fetchResults: [ok([])],
    loadContext: () => { throw new Error('Supabase unreachable'); },
  });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, true);
  assert.equal(calls.load, 0);
});

test('F1.2 one or more events: context is loaded once and planning is unchanged', async () => {
  const events = [{ id: 'g1' }, { id: 'g2' }];
  const classified = { event: { providerEventId: 'g1' } };
  const { calls, h } = harness({
    fetchResults: [ok(events)],
    plans: [{ action: 'book', outcome: 'book', classified }],
  });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, true);
  assert.equal(result.contextLoaded, true);
  assert.equal(result.events, 2);
  assert.equal(calls.load, 1);
  assert.equal(calls.plan.length, 1);
  assert.deepEqual(calls.plan[0].events, events, 'the planner receives every fetched event');
  assert.deepEqual(calls.plan[0].context, { dataset: { leads: [] }, boardLeads: [], activities: [] });
  assert.equal(calls.apply.length, 1);
  assert.equal(result.mutations, 1);
  assert.equal(calls.write.length, 1);
});

test('F1.2 with events, an unreadable CRM snapshot still fails the sync and keeps the checkpoint', async () => {
  const { calls, h } = harness({
    fetchResults: [ok([{ id: 'g1' }])],
    loadContext: () => { throw new Error('Supabase unreachable'); },
  });
  await assert.rejects(() => runGoogleCalendarSync(h), /Supabase unreachable/);
  assert.equal(calls.write.length, 0, 'no checkpoint when the booking could not be planned');
});

test('F1.3 a Calendar fetch failure is unchanged: no context, no checkpoint, ok=false', async () => {
  const { calls, h } = harness({ fetchResults: [{ ok: false, error: 'HTTP 503' }] });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'HTTP 503');
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(calls.load, 0);
  assert.equal(calls.write.length, 0);
});

test('F1.3 a failed full resync after 410 is unchanged', async () => {
  const { calls, h } = harness({ fetchResults: [
    { ok: true, tokenInvalid: true, events: [] },
    { ok: false, error: 'HTTP 500' },
  ] });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, false);
  assert.equal(calls.load, 0);
  assert.equal(calls.write.length, 0);
});

test('F1.3 a 410 whose replacement walk is empty checkpoints the fresh token without a context load', async () => {
  const { calls, h } = harness({ fetchResults: [
    { ok: true, tokenInvalid: true, events: [] },
    ok([], { nextSyncToken: 'fresh-token' }),
  ] });
  const result = await runGoogleCalendarSync(h);
  assert.equal(result.ok, true);
  assert.equal(calls.load, 0);
  assert.equal(calls.write[0].syncToken, 'fresh-token');
});

// ── the launch gate and fail-closed behaviour around it ───────────────────────

test('F1 the server still gates every launch on a successful Calendar observation', () => {
  const guard = server.slice(server.indexOf('async function observeCalendarBeforeAutomation'),
    server.indexOf('async function launchAutomationAfterCalendar'));
  assert.match(guard, /if \(!result \|\| result\.ok !== true\)/);
  assert.match(guard, /return \{ ok: false, launched: false, reason \}/);
  const launch = server.slice(server.indexOf('async function launchAutomationAfterCalendar'),
    server.indexOf('// Read-only preview'));
  assert.ok(launch.indexOf('observeCalendarBeforeAutomation') < launch.indexOf('launch()'));
  assert.match(launch, /if \(!observation\.ok\) return \{ launched: false, observation \}/);
});

test('F1 the only CRM read on the Calendar path is loadContext -> loadBookingContext', () => {
  const sync = server.slice(server.indexOf('async function runGoogleCalendarSync'),
    server.indexOf('// A booking can arrive between scheduler cycles'));
  assert.match(sync, /loadContext: loadBookingContext/);
  assert.doesNotMatch(sync, /getOutreachDataset|readOutreachCorpus/);
  const booking = server.slice(server.indexOf('async function loadBookingContext'),
    server.indexOf('async function applyCalendarPlanItem'));
  assert.match(booking, /await getOutreachDataset\(\)/);
});

test('F1 fail-closed: with Supabase authoritative, an unreadable corpus refuses the agent run', () => {
  // The Calendar pre-check no longer reads the corpus on a quiet calendar, so
  // the refusal it used to trigger by accident is the agent's own, as designed.
  const env = { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
  const verdict = sheetsFallbackAllowed('automation', env);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'automation-must-not-decide-from-a-lagging-mirror');

  const readLeads = agent.slice(agent.indexOf('async function readLeads('),
    agent.indexOf('async function loadAgentSnapshot('));
  assert.match(readLeads, /const corpus = await readOutreachCorpus\(\);/);
  assert.match(readLeads, /if \(!fallback\.allowed\) \{\s*throw new Error/);

  // readLeads() runs before any pass in run(), and a throw exits the process 1.
  const run = agent.slice(agent.indexOf('async function run()'));
  const read = run.indexOf('const all = await readLeads(snapshot.coldEmail)');
  assert.ok(read > 0);
  for (const pass of ['runIntentTriggerPass(', 'runHumanOutboundPass(', 'runReplyCheckPass(', 'prepareDemoIntentCandidates(']) {
    assert.ok(run.indexOf(pass) > read, `${pass} runs only after the authoritative corpus was read`);
  }
  assert.match(agent, /run\(\)\.catch\(e => \{\s*console\.error\('\\n\[FATAL\]', e\.message\);\s*process\.exit\(1\);/);
});

// F3 (2026-09-26): the per-send re-check was the remaining per-send corpus
// download. It now reads the one lead being sent to; see fresh-send-state.js.
test('F3 the per-send fresh-state re-check reads the one lead, not the corpus', () => {
  const fresh = agent.slice(agent.indexOf('function freshSendSafetyDeps()'),
    agent.indexOf('function loadGmailObservationState('));
  assert.doesNotMatch(fresh, /readLeads\(snapshot\.coldEmail\)/);
  assert.match(fresh, /getLeadById: id => getOutreachLeadById\(id\)/);
});
