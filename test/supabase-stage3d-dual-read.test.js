'use strict';

// Stage 3D — dual-read parity measurement.
//
// The promise being defended: in dual mode Google Sheets still produces every
// operational result, and the Supabase read alongside it is measurement that
// cannot influence a decision, cannot throw into its caller, cannot cost a
// request per lead, and cannot leak prospect data into diagnostics.
//
// The subtle one: a comparison must catch a REAL divergence while refusing to
// invent one from a field the source never loaded.
//
// No live Supabase project is contacted; a local http server stands in.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROBE_INTERVAL_MS, STALE_AFTER_MS, DASHBOARD_OMITTED_FIELDS,
  readMirrorCorpus, compareCorpus, measureLag,
  probeOutreachParity, probeOutreachParityInBackground,
  recordFallback, stage3ParitySnapshot, resetStage3Diagnostics,
} = require('../integrations/outreach-dual-read');
const { SHEET_FIELDS, CRITICAL_FIELDS } = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const dualSrc = readSource(path.join(root, 'integrations', 'outreach-dual-read.js'));

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
const quiet = { log() {}, warn() {}, error() {} };

function lead(id, overrides = {}) {
  const row = {};
  for (const field of SHEET_FIELDS) row[field] = '';
  row.id = id;
  row.email = `${id}@northbridge.example`;
  row.company = `Company ${id}`;
  row.stage = 'Contacted';
  row.senderInboxId = 'primary';
  row.campaign = 'Ontario List';
  row.leadNiche = 'dental';
  return Object.assign(row, overrides);
}

/** Serves a corpus over the PostgREST paging contract the reader uses. */
function fakeMirror(leads, { status = 200, mirroredAt = new Date().toISOString() } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    if (status !== 200) { res.writeHead(status); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') || 1000);
    const offset = Number(url.searchParams.get('offset') || 0);
    const page = leads.slice(offset, offset + limit).map(item => {
      const row = { lead_id: item.id, mirrored_at: item.__mirroredAt || mirroredAt };
      const { FIELD_MAP } = require('../integrations/outreach-state');
      for (const [field, column] of Object.entries(FIELD_MAP)) row[column] = item[field] ?? '';
      return row;
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  return {
    received,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SECRET_KEY: SECRET };
    },
    async stop() { await new Promise(resolve => server.close(resolve)); },
  };
}

test.beforeEach(() => resetStage3Diagnostics());

// ── A. the comparison itself ────────────────────────────────────────────────

test('A1 — identical corpora compare exact', () => {
  const sheet = [lead('a'), lead('b')];
  const mirror = new Map(sheet.map(l => [l.id, { ...l }]));
  const result = compareCorpus(sheet, mirror, SHEET_FIELDS);
  assert.equal(result.exact, 2);
  assert.equal(result.criticalMismatches, 0);
  assert.equal(result.missing, 0);
  assert.equal(result.extra, 0);
});

test('A2 — a REAL divergence is caught, a projection artefact is not invented', () => {
  // The dashboard reads A:O and Q:X, so siteContext arrives blank no matter what
  // the sheet holds. That blank is an artefact of the read, not a disagreement.
  const sheet = [lead('a', { siteContext: '' }), lead('b', { stage: 'Queued' })];
  const mirror = new Map([
    ['a', lead('a', { siteContext: 'no online booking' })],
    ['b', lead('b', { stage: 'Replied' })],
  ]);

  const unscoped = compareCorpus(sheet, mirror, SHEET_FIELDS);
  assert.equal(unscoped.criticalMismatches, 2, 'comparing every field flags the artefact too');

  const scoped = compareCorpus(sheet, mirror,
    SHEET_FIELDS.filter(f => !DASHBOARD_OMITTED_FIELDS.includes(f)));
  assert.equal(scoped.criticalMismatches, 1, 'only the artefact is dropped');
  assert.deepEqual(scoped.criticalIds, [{ id: 'b', fields: ['stage'] }],
    'the real stage divergence must still be caught — this is not normalising away a difference');
});

test('A3 — scoping cannot hide a divergence in a field the source DID load', () => {
  const comparable = SHEET_FIELDS.filter(f => !DASHBOARD_OMITTED_FIELDS.includes(f));
  // `id` is the join key, not a comparable value: a different id is a MISSING
  // lead, which A4 covers. Every other critical field must report a divergence.
  const compared = CRITICAL_FIELDS.filter(f => f !== 'id' && !DASHBOARD_OMITTED_FIELDS.includes(f));
  assert.equal(compared.length, 19, 'nineteen critical fields are compared on the dashboard path');
  for (const field of compared) {
    const sheet = [lead('a', { [field]: 'SHEET' })];
    const mirror = new Map([['a', lead('a', { [field]: 'SUPABASE' })]]);
    const result = compareCorpus(sheet, mirror, comparable);
    assert.equal(result.criticalMismatches, 1, `${field} divergence must be reported`);
    assert.deepEqual(result.criticalIds[0].fields, [field]);
  }
});

test('A3b — a lead whose id changed is MISSING, not a silent match', () => {
  const result = compareCorpus([lead('renamed')], new Map([['original', lead('original')]]), SHEET_FIELDS);
  assert.equal(result.missing, 1);
  assert.equal(result.extra, 1);
  assert.equal(result.exact, 0);
});

test('A4 — missing, extra and duplicates are counted separately', () => {
  const sheet = [lead('a'), lead('b'), lead('a')];          // 'a' twice
  const mirror = new Map([['a', lead('a')], ['z', lead('z')]]);
  const result = compareCorpus(sheet, mirror, SHEET_FIELDS);
  assert.equal(result.missing, 1, 'b is absent from the mirror');
  assert.equal(result.extra, 1, 'z is in the mirror but not the sheet');
  assert.equal(result.duplicateIds, 1, 'a appears twice in the sheet');
  assert.ok(result.missingIds.includes('b'));
  assert.ok(result.extraIds.includes('z'));
});

test('A5 — duplicate normalized emails are counted, blanks are not', () => {
  const sheet = [
    lead('a', { email: 'Dana@X.test' }),
    lead('b', { email: 'dana@x.test' }),     // same address, different case
    lead('c', { email: '' }),
    lead('d', { email: '' }),                // two blanks are not a duplicate
  ];
  const result = compareCorpus(sheet, new Map(), SHEET_FIELDS);
  assert.equal(result.duplicateEmails, 1);
});

test('A6 — mirror lag and stale rows are measured from mirrored_at', () => {
  const now = Date.now();
  const fresh = measureLag([{ mirrored_at: new Date(now - 1000).toISOString() }], now);
  assert.ok(fresh.mirrorLagMs < 5000);
  assert.equal(fresh.staleRows, 0);

  const stale = measureLag([
    { mirrored_at: new Date(now - STALE_AFTER_MS - 60000).toISOString() },
    { mirrored_at: new Date(now - 1000).toISOString() },
  ], now);
  assert.equal(stale.staleRows, 1);
  assert.ok(stale.mirrorLagMs < 5000, 'lag is measured from the NEWEST row');

  assert.deepEqual(measureLag([]), { mirrorLagMs: null, staleRows: 0 });
  assert.equal(measureLag([{ mirrored_at: 'nonsense' }]).mirrorLagMs, null);
});

// ── B. the probe ────────────────────────────────────────────────────────────

test('B1 — a clean probe records counts and one Supabase read, not one per lead', async () => {
  const leads = Array.from({ length: 40 }, (_, i) => lead(`l${i}`));
  const fake = fakeMirror(leads);
  const env = await fake.start();
  try {
    const result = await probeOutreachParity(leads, { label: 'test', env, logger: quiet });
    assert.equal(result.exact, 40);
    assert.equal(result.criticalMismatches, 0);
    assert.equal(fake.received.length, 1, '40 leads must cost one request, not 40');
    const snap = stage3ParitySnapshot('dual');
    assert.equal(snap.byLabel.test.exact, 40);
    assert.equal(snap.totals.readFailures, 0);
  } finally { await fake.stop(); }
});

test('B2 — the probe is throttled per label', async () => {
  const leads = [lead('a')];
  const fake = fakeMirror(leads);
  const env = await fake.start();
  try {
    const now = Date.now();
    assert.ok(await probeOutreachParity(leads, { label: 'x', env, logger: quiet, now }));
    assert.equal(await probeOutreachParity(leads, { label: 'x', env, logger: quiet, now: now + 1000 }), null,
      'a second probe inside the window must not run');
    assert.ok(await probeOutreachParity(leads, { label: 'x', env, logger: quiet, now: now + PROBE_INTERVAL_MS + 1 }),
      'after the window it runs again');
    assert.ok(await probeOutreachParity(leads, { label: 'y', env, logger: quiet, now: now + 1000 }),
      'a different chokepoint has its own window');
  } finally { await fake.stop(); }
});

test('B3 — an unreachable mirror records a read failure and returns null', async () => {
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  const result = await probeOutreachParity([lead('a')], { label: 'test', env, logger: quiet });
  assert.equal(result, null);
  const snap = stage3ParitySnapshot('dual');
  assert.equal(snap.totals.readFailures, 1);
  assert.equal(snap.recent[0].outcome, 'read_failure');
});

test('B4 — an HTTP error is a read failure, not a false "everything is missing"', async () => {
  const fake = fakeMirror([lead('a')], { status: 500 });
  const env = await fake.start();
  try {
    assert.equal(await probeOutreachParity([lead('a')], { label: 'test', env, logger: quiet }), null);
    const snap = stage3ParitySnapshot('dual');
    assert.equal(snap.totals.readFailures, 1);
    assert.equal(snap.totals.missing, 0, 'an unreadable mirror must never be reported as 1 missing lead');
  } finally { await fake.stop(); }
});

test('B5 — the probe never throws, whatever it is handed', async () => {
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  for (const input of [null, undefined, [], 'nonsense', 42, [null]]) {
    await assert.doesNotReject(() => probeOutreachParity(input, { label: 'junk', env, logger: quiet }));
  }
  assert.doesNotThrow(() => probeOutreachParityInBackground(null, { env, logger: quiet }));
  assert.doesNotThrow(() => probeOutreachParityInBackground([lead('a')], { env, logger: quiet }));
  await new Promise(resolve => setTimeout(resolve, 50));
});

test('B6 — a critical mismatch is logged with counts but no field values', async () => {
  const lines = [];
  const capture = { log() {}, warn: l => lines.push(l), error() {} };
  const sheet = [lead('a', { stage: 'Contacted' })];
  const fake = fakeMirror([lead('a', { stage: 'Replied' })]);
  const env = await fake.start();
  try {
    await probeOutreachParity(sheet, { label: 'test', env, logger: capture });
    const text = lines.join('\n');
    assert.match(text, /1 critical mismatch/);
    assert.match(text, /Google Sheets served the result/, 'the log must state what is still true');
    assert.ok(!text.includes('northbridge.example'), 'no prospect address in the log');
    assert.ok(!text.includes('Replied'), 'no field VALUE in the log');
  } finally { await fake.stop(); }
});

// ── C. diagnostics are bounded and safe ─────────────────────────────────────

test('C1 — recent entries are capped', async () => {
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  for (let i = 0; i < 60; i++) {
    await probeOutreachParity([lead('a')], { label: `l${i}`, env, logger: quiet });
  }
  assert.ok(stage3ParitySnapshot('dual').recent.length <= 20, 'diagnostics must stay bounded');
});

test('C2 — the snapshot carries ids and field names but never a field value', async () => {
  const fake = fakeMirror([lead('a', { senderInboxId: 'tryscalelabai' })]);
  const env = await fake.start();
  try {
    await probeOutreachParity([lead('a', { senderInboxId: 'primary' })],
      { label: 'test', env, logger: quiet });
    const text = JSON.stringify(stage3ParitySnapshot('dual'));
    assert.match(text, /senderInboxId/, 'the diverging field NAME is reported');
    assert.ok(!text.includes('tryscalelabai'), 'the mirrored VALUE must not appear');
    assert.ok(!text.includes('northbridge.example'), 'no prospect address');
    assert.ok(!text.includes(SECRET), 'no credential');
  } finally { await fake.stop(); }
});

test('C3 — the snapshot reports every field the Stage 3 brief asks for', () => {
  const snap = stage3ParitySnapshot('dual');
  for (const key of ['mode', 'startedAt', 'lastProbeAt', 'totals', 'byLabel', 'recent']) {
    assert.ok(key in snap, `snapshot must report ${key}`);
  }
  for (const key of ['exact', 'missing', 'extra', 'criticalMismatches', 'noncriticalMismatches',
    'duplicateIds', 'duplicateEmails', 'readFailures', 'staleRows', 'fallbacks']) {
    assert.ok(key in snap.totals, `totals must report ${key}`);
  }
});

test('C4 — fallbacks are recorded', () => {
  recordFallback('ui-directory', 'SUPABASE_UNAVAILABLE');
  const snap = stage3ParitySnapshot('dual');
  assert.equal(snap.totals.fallbacks, 1);
  assert.equal(snap.recent[0].outcome, 'fallback');
  assert.equal(snap.recent[0].reason, 'SUPABASE_UNAVAILABLE');
});

// ── D. dual mode cannot influence a decision ────────────────────────────────

test('D1 — both chokepoints probe only in dual mode', () => {
  assert.match(serverSrc,
    /if \(outreachStateMode\(\) === 'dual'\) \{\s*probeOutreachParityInBackground\(leads, \{/,
    'the UI chokepoint must probe only in dual');
  assert.match(agentSrc,
    /if \(outreachStateMode\(\) === 'dual'\) \{\s*probeOutreachParityInBackground\(all, \{/,
    'the automation chokepoint must probe only in dual');
});

test('D2 — the probe result is never captured or branched on', () => {
  for (const [name, src] of [['server.js', serverSrc], ['outreach-agent.js', agentSrc]]) {
    assert.ok(!/=\s*(await\s+)?probeOutreachParity/.test(src),
      `${name} must not assign the probe result — measurement may not become a decision`);
    assert.ok(!/await probeOutreachParity/.test(src),
      `${name} must not await the probe — a Supabase stall cannot delay a send or a page`);
    assert.ok(!/if\s*\(\s*probeOutreachParity/.test(src),
      `${name} must not branch on the probe`);
  }
});

test('D3 — the UI probe excludes exactly the field its snapshot does not load', () => {
  assert.deepEqual(DASHBOARD_OMITTED_FIELDS, ['siteContext']);
  // The claim has to stay true of the actual read: A:O then Q:X, P left blank.
  assert.match(serverSrc, /\$\{CE_SHEET_NAME\}!A:O`, `\$\{CE_SHEET_NAME\}!Q:X`/,
    'if the dashboard ever loads column P, the exclusion must be removed');
  assert.match(serverSrc, /comparable: CE_COLUMNS\.filter\(field => !DASHBOARD_OMITTED_FIELDS\.includes\(field\)\)/);
});

test('D4 — the agent probe compares EVERY field, because it reads A:X', () => {
  assert.match(agentSrc, /const READ_RANGE\s*=\s*`\$\{SHEET_NAME\}!A:X`/);
  const hook = agentSrc.match(/probeOutreachParityInBackground\(all, \{[^}]*\}/)[0];
  assert.ok(!hook.includes('comparable'),
    'the automation corpus is complete, so no field may be excluded from its comparison');
});

test('D5 — the parity endpoint is authenticated and states what is authoritative', () => {
  const route = serverSrc.match(/app\.get\('\/api\/integrations\/supabase\/stage3-parity'[\s\S]*?\n\}\);/)[0];
  assert.match(route, /requireAuth/, 'parity diagnostics must not be public');
  assert.match(route, /Google Sheets serves every operational result/);
  assert.ok(!/email|body|token|key/i.test(route.replace(/stage3ParitySnapshot|byLabel/g, '')),
    'the endpoint must not surface addresses, bodies or credentials');
});

test('D6 — the dual-read module cannot write, send, or reach Google', () => {
  assert.ok(!/mirrorOutreachLead|values\.update|values\.append|batchUpdate/.test(dualSrc),
    'a read-parity module must not contain a write path');
  assert.ok(!/googleapis|sheets\(\)/.test(dualSrc), 'it must not reach Google directly');
  assert.ok(!/sendEmail|gmail|nodemailer/i.test(dualSrc), 'it must not be able to send');
});
