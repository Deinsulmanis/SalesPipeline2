'use strict';
/**
 * Stage 2F — hybrid timeline read.
 *
 * The property under test: a body that cannot be reproduced exactly must cause
 * a fallback, never a blank. An empty `content` reads as "they wrote nothing",
 * which is a lie, so every partial result is refused.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FALLBACK, readTimelineHybrid, hybridMayServeTimeline,
  compareHybridActivities } = require('../integrations/supabase-timeline-hybrid');
const { CONTENT_BEARING_TYPES, timelineMode } = require('../integrations/supabase-timeline');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const server = read('server.js');

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SECRET_KEY: 'stub-key' };
const LEAD = { sourceLeadId: 'lead1', leadId: 'CE-lead1', email: 'a@b.com' };

// A mirrored row as PostgREST returns it.
const mirrored = (id, type, over = {}) => ({
  event_id: id, lead_id: 'CE-lead1', source_lead_id: 'lead1', email: 'a@b.com',
  company: 'Acme', event_type: type, occurred_at: '2026-09-01T10:00:00+00:00',
  subject: 's', metadata: {}, ...over });
// The authoritative Sheets row, which alone carries content.
const sheetRow = (id, type, content = '', over = {}) => ({
  eventId: id, leadId: 'CE-lead1', sourceLeadId: 'lead1', email: 'a@b.com',
  company: 'Acme', eventType: type, occurredAt: '2026-09-01T10:00:00.000Z',
  subject: 's', content, metadata: '{}', ...over });

/** Stubs global fetch so the reader can be exercised without a network. */
function withMirror(rows, { fail = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    if (fail) throw new Error('connection refused');
    return { ok: true, json: async () => rows };
  };
  return () => { globalThis.fetch = original; };
}

async function hybrid(rows, loader, options = {}) {
  const restore = withMirror(rows, options);
  try { return await readTimelineHybrid({ ...LEAD, env: ENV, loadAuthoritativeActivities: loader }); }
  finally { restore(); }
}

// ── A. no-content lead never opens the sheet ───────────────────────────────
test('A. a lead with no content-bearing event serves without touching the content source', async () => {
  let loaderCalls = 0;
  const result = await hybrid(
    [mirrored('e1', 'lead_queued'), mirrored('e2', 'stage_changed')],
    async () => { loaderCalls++; return []; });
  assert.equal(result.ok, true);
  assert.equal(result.sheetsConsulted, false, 'the whole point: no sheet read');
  assert.equal(loaderCalls, 0, 'the content source was never called');
  assert.equal(result.activities.length, 2);
  assert.equal(result.hydrated, 0);
  assert.ok(result.activities.every(e => e.content === ''));
});

// ── B/C/D. hydration exactness ─────────────────────────────────────────────
test('B. a single content-bearing event is hydrated with its exact body', async () => {
  const body = 'Hi Ada,\n\nThanks for the note.\n\n— Deins';
  const result = await hybrid([mirrored('e1', 'initial_email_sent')],
    async () => [sheetRow('e1', 'initial_email_sent', body)]);
  assert.equal(result.ok, true);
  assert.equal(result.sheetsConsulted, true);
  assert.equal(result.hydrated, 1);
  assert.equal(result.activities[0].content, body, 'byte-exact');
});

test('C. several content-bearing events each receive their own body', async () => {
  const rows = [mirrored('e1', 'initial_email_sent'), mirrored('e2', 'follow_up_sent', { occurred_at: '2026-09-02T10:00:00+00:00' }),
    mirrored('e3', 'lead_queued', { occurred_at: '2026-09-03T10:00:00+00:00' })];
  const result = await hybrid(rows, async () => [
    sheetRow('e1', 'initial_email_sent', 'first body'),
    sheetRow('e2', 'follow_up_sent', 'second body', { occurredAt: '2026-09-02T10:00:00.000Z' }),
    sheetRow('e3', 'lead_queued', '', { occurredAt: '2026-09-03T10:00:00.000Z' }),
  ]);
  assert.equal(result.ok, true);
  const byId = new Map(result.activities.map(e => [e.eventId, e.content]));
  assert.equal(byId.get('e1'), 'first body');
  assert.equal(byId.get('e2'), 'second body');
  assert.equal(byId.get('e3'), '', 'a non-content type stays empty and is not hydrated');
  assert.equal(result.hydrated, 2);
});

test('D. newlines, punctuation and unicode survive hydration unchanged', async () => {
  const body = 'Hi — “Ada”,\r\n\tQuestion: 30‑day pilot? Cost £1,000 · 100% ✓\n\nRegards,\nDeins 🙂';
  const result = await hybrid([mirrored('e1', 'needs_human_reply')],
    async () => [sheetRow('e1', 'needs_human_reply', body)]);
  assert.equal(result.ok, true);
  assert.equal(result.activities[0].content, body);
  assert.equal(result.activities[0].content.length, body.length, 'no normalisation, no trimming');
});

// ── E/F. identity joining ──────────────────────────────────────────────────
test('E/F. joining is by event id alone, never by timestamp', async () => {
  // Two events, identical timestamp, different bodies. A timestamp join would
  // scramble these; an id join cannot.
  const rows = [mirrored('alpha', 'initial_email_sent'), mirrored('beta', 'follow_up_sent')];
  const result = await hybrid(rows, async () => [
    sheetRow('beta', 'follow_up_sent', 'BETA BODY'),
    sheetRow('alpha', 'initial_email_sent', 'ALPHA BODY'),
  ]);
  assert.equal(result.ok, true);
  const byId = new Map(result.activities.map(e => [e.eventId, e.content]));
  assert.equal(byId.get('alpha'), 'ALPHA BODY');
  assert.equal(byId.get('beta'), 'BETA BODY');
  // The source itself never joins on anything but eventId.
  const source = read('integrations/supabase-timeline-hybrid.js');
  assert.match(source, /const id = idOf\(row\);/);
  assert.ok(!/occurredAt.*===.*occurredAt|subject.*===.*subject/.test(source.split('function compareHybridActivities')[0]),
    'the join half of the module never matches on timestamp or subject');
});

// ── G/H. refusal rather than a blank body ──────────────────────────────────
test('G. a body that cannot be found causes a fallback, never an empty string', async () => {
  const result = await hybrid([mirrored('e1', 'initial_email_sent')], async () => []);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK.HYDRATION_CONTENT_MISSING);
  assert.deepEqual(result.activities, [], 'no partial timeline is offered');
});

test('H. an ambiguous content source causes a fallback rather than a guess', async () => {
  const result = await hybrid([mirrored('e1', 'initial_email_sent')], async () => [
    sheetRow('e1', 'initial_email_sent', 'one'),
    sheetRow('e1', 'initial_email_sent', 'two'),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK.HYDRATION_IDENTITY_UNRESOLVED);
});

test('J. a failing or malformed content source falls back', async () => {
  const thrown = await hybrid([mirrored('e1', 'initial_email_sent')],
    async () => { throw new Error('sheets 503'); });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.fallbackReason, FALLBACK.HYDRATION_QUERY_FAILED);
  const wrongShape = await hybrid([mirrored('e1', 'initial_email_sent')], async () => null);
  assert.equal(wrongShape.fallbackReason, FALLBACK.HYDRATION_QUERY_FAILED);
  const absent = await hybrid([mirrored('e1', 'initial_email_sent')], undefined);
  assert.equal(absent.fallbackReason, FALLBACK.HYDRATION_QUERY_FAILED);
});

// ── I/K. mirror-side failures ──────────────────────────────────────────────
test('I. an unreachable mirror falls back and is never read as an empty history', async () => {
  const result = await hybrid([], async () => [], { fail: true });
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK.SUPABASE_UNAVAILABLE);
  assert.deepEqual(result.activities, []);
  assert.equal(hybridMayServeTimeline(result).allowed, false);
});

test('K. a mirror missing events the authoritative store has falls back', async () => {
  // Mirror knows one event; the sheet holds two for this lead.
  const result = await hybrid([mirrored('e1', 'initial_email_sent')], async () => [
    sheetRow('e1', 'initial_email_sent', 'body'),
    sheetRow('e2', 'follow_up_sent', 'later body', { occurredAt: '2026-09-02T10:00:00.000Z' }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK.MIRROR_INCOMPLETE,
    'a silently shorter history is the worst failure mode, so it is refused');
  // And an empty mirror can never displace a non-empty authoritative answer.
  assert.equal(hybridMayServeTimeline({ ok: true, activities: [] }, { authoritativeCount: 7 }).allowed, false);
  assert.equal(hybridMayServeTimeline({ ok: true, activities: [] }, { authoritativeCount: 0 }).allowed, true);
});

test('a duplicate identity inside the mirror falls back', async () => {
  const result = await hybrid([mirrored('dup', 'lead_queued'), mirrored('dup', 'lead_queued')], async () => []);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK.DUPLICATE_EVENT_ID);
});

// ── L/O. final-result parity comparator ────────────────────────────────────
test('L/O. the comparator checks the final array, content and ordering included', () => {
  const a = sheetRow('e1', 'initial_email_sent', 'body one');
  const b = sheetRow('e2', 'follow_up_sent', 'body two', { occurredAt: '2026-09-02T10:00:00.000Z' });
  assert.equal(compareHybridActivities([a, b], [a, b]).parityClean, true);
  assert.equal(compareHybridActivities([a, b], [b, a]).parityClean, true, 'order is normalised before comparing');
  // A content difference is caught — the check Stage 2 metadata parity could not make.
  const tampered = { ...a, content: 'body ONE' };
  const parity = compareHybridActivities([a, b], [tampered, b]);
  assert.equal(parity.parityClean, false);
  assert.deepEqual(parity.contentMismatched, ['e1']);
  assert.ok(parity.mismatched[0].fields.includes('content'));
  // Missing and extra are still caught.
  assert.deepEqual(compareHybridActivities([a, b], [a]).missing, ['e2']);
  assert.deepEqual(compareHybridActivities([a], [a, b]).extra, ['e2']);
});

// ── M/N. the derived projection is untouched ───────────────────────────────
test('M/N. only the stored-activity source is replaced; derived projection is unchanged', () => {
  const timeline = read('integrations/activity-timeline.js');
  // buildActivityTimeline still merges derived events and open/demo signals.
  assert.match(timeline, /for \(const event of deriveHistoricalEvents\(lead, activities\)\)/);
  assert.match(timeline, /groupedSignalEvent\('email_opened', lead, opens\)/);
  assert.match(timeline, /groupedSignalEvent\('demo_played', lead, demos\)/);
  // Neither Stage 2 module imports or reimplements it.
  const hybridSource = read('integrations/supabase-timeline-hybrid.js');
  assert.ok(!/activity-timeline|deriveHistoricalEvents|groupedSignalEvent/.test(hybridSource),
    'the hybrid reader supplies activities only; it does not build the timeline');
  // The server still passes whatever activities it obtained into the same builder.
  assert.match(server, /const timeline = timelineForLead\(/);
});

// ── V/W/X/Y. mode behaviour ────────────────────────────────────────────────
test('V. dual mode never serves the hybrid result', () => {
  // The probe runs only under dual, and the response uses `activities` built by
  // the authoritative loader in that mode.
  assert.match(server, /if \(timelineMode\(\) === 'dual'\) \{\n\s*stage2TimelineProbe\(/);
  assert.match(server, /if \(!activities\) activities = await loadAuthoritative\(\);/);
  // The probe cannot influence the response.
  assert.match(server, /\.catch\(\(\) => \{ \/\* a parity probe may never affect the response \*\/ \}\)/);
});

test('W/X. primary mode serves the hybrid result only when the gate allows, else falls back', () => {
  assert.match(server, /if \(timelineMode\(\) === 'primary'\) \{/);
  assert.match(server, /const gate = hybridMayServeTimeline\(hybrid\);/);
  assert.match(server, /if \(gate\.allowed\) \{[\s\S]{0,200}timelineSource = 'supabase-hybrid';/);
  assert.match(server, /\} else \{[\s\S]{0,120}noteFallback\(gate\.reason\);/);
  // A refused hybrid result is never served.
  assert.equal(hybridMayServeTimeline({ ok: false, fallbackReason: FALLBACK.MIRROR_INCOMPLETE }).allowed, false);
  assert.equal(hybridMayServeTimeline({ ok: true, activities: [{}] }).allowed, true);
});

test('Y. an unknown mode falls back to off, and off never calls the hybrid reader', () => {
  assert.equal(timelineMode({ SUPABASE_TIMELINE_MODE: 'nonsense' }), 'off');
  assert.equal(timelineMode({}), 'off');
  // Both branches are mode-guarded, so `off` reaches neither.
  assert.match(server, /if \(timelineMode\(\) === 'primary'\)/);
  assert.match(server, /if \(timelineMode\(\) === 'dual'\)/);
});

// ── Z + T/U. the privacy boundary and blast radius ─────────────────────────
test('Z. no body text is ever written to Supabase', () => {
  const mirror = read('integrations/supabase-mirror.js');
  const hybridSource = read('integrations/supabase-timeline-hybrid.js');
  const reader = read('integrations/supabase-timeline.js');
  // toCrmEvent builds the mirrored row and has no content field.
  const toCrmEvent = mirror.slice(mirror.indexOf('function toCrmEvent'), mirror.indexOf('function describeUnmirrorable'));
  assert.ok(!/content/.test(toCrmEvent.replace(/\/\/.*$/gm, '')), 'the mirrored row carries no content');
  // The hybrid and reader modules issue no writes at all.
  for (const [name, source] of [['hybrid', hybridSource], ['reader', reader]]) {
    assert.ok(!/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(source), `${name} never writes`);
  }
  // Hydrated content is returned to the caller and never sent onward.
  assert.ok(!/fetch\([^)]*rest\/v1[\s\S]{0,200}content/.test(hybridSource));
});

test('T/U. no operational state read moved, and no sending behaviour changed', () => {
  const agent = read('outreach-agent.js');
  assert.ok(!/supabase-timeline/.test(agent), 'automation still reads canonical state, not the mirror');
  assert.match(agent, /require\('\.\/integrations\/supabase-mirror'\)/, 'the agent still only mirrors');
  // The hybrid module has no operational surface whatsoever.
  const hybridSource = read('integrations/supabase-timeline-hybrid.js');
  assert.ok(!/sendEmail|chooseSender|stageSendGate|suppress|quota|observer|routedLeadReady|MANUAL HOLD/i.test(hybridSource));
  // Only the timeline endpoint consults it.
  assert.equal(server.split('readTimelineHybrid(').length - 1, 2, 'one call in primary mode, one in the dual probe');
});

// ── P/Q/R/S. attribution across families ───────────────────────────────────
test('P/Q/R/S. campaign attribution survives hydration for every family', async () => {
  for (const family of ['dental_ai_receptionist', 'roofing_survey', 'industrial_staffing']) {
    const result = await hybrid(
      [mirrored('e1', 'initial_email_sent', { metadata: { campaignFamily: family, senderInboxId: 'primary' } })],
      async () => [sheetRow('e1', 'initial_email_sent', 'body', { metadata: JSON.stringify({ campaignFamily: family }) })]);
    assert.equal(result.ok, true, family);
    const meta = JSON.parse(result.activities[0].metadata);
    assert.equal(meta.campaignFamily, family, 'the mirror metadata is preserved verbatim');
    assert.equal(meta.senderInboxId, 'primary');
    assert.equal(result.activities[0].content, 'body');
  }
  assert.ok(CONTENT_BEARING_TYPES.has('initial_email_sent'));
});
