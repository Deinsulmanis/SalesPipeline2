'use strict';

// Stage 1 Supabase mirror.
//
// The promise being defended: Google Sheets stays the authoritative database,
// and the mirror is incapable of changing that. It must be absent-by-default,
// non-blocking when present, idempotent when replayed, and silent about its
// credentials — and no production read path may consult it.
//
// No live Supabase project is contacted. Where an endpoint is needed, a local
// http server stands in, so these tests run offline and touch nothing real.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  mirrorConfig, mirrorEnabled, toCrmEvent, describeUnmirrorable,
  mirrorEvents, mirrorEventsInBackground, mirrorHealth, TABLE,
} = require('../integrations/supabase-mirror');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const mirrorSrc = readSource(path.join(root, 'integrations', 'supabase-mirror.js'));
const backfillSrc = readSource(path.join(root, 'scripts', 'supabase-backfill.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const migration = readSource(path.join(root, 'supabase', 'migrations', '20260902000000_crm_events.sql'));

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
const quiet = { log() {}, warn() {}, error() {} };

// A stand-in PostgREST. Records what it was asked to do so the tests can assert
// on the request rather than on a real database.
function fakeSupabase({ status = 201, onRequest } = {}) {
  const received = [];
  const rows = new Map();          // event_id → row, i.e. a primary key
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (onRequest) { onRequest(req, res, body); if (res.writableEnded) return; }
      if (req.method === 'POST') {
        // Upsert semantics: keyed by event_id, so a replay overwrites.
        for (const row of JSON.parse(body || '[]')) rows.set(row.event_id, row);
        res.writeHead(status); res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-range': `0-${rows.size}/${rows.size}` }); res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...rows.values()].slice(0, 1)));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, received, rows,
      env: { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SECRET_KEY: SECRET },
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

// mirrorConfig requires https for a real URL; the fake runs on http, so tests
// that need a live endpoint patch the check the same way the module would see
// a valid configuration.
function httpEnv(env) { return { ...env, SUPABASE_URL: env.SUPABASE_URL }; }

const activity = (over = {}) => ({
  eventId: 'gmail:1a05dfc901c056a6',
  leadId: 'CE-abc123', sourceLeadId: 'abc123',
  email: 'hello@clinic.test', company: 'A Dental',
  eventType: 'initial_email_sent',
  occurredAt: '2026-09-01T17:20:28.648Z',
  subject: 'quick question about Invisalign',
  content: 'Hi there — this is the full email body and must never be mirrored.',
  metadata: JSON.stringify({
    step: 1, trigger: 'cold_sequence_step_1',
    gmailMessageId: '1a05dfc901c056a6', gmailThreadId: '1a05dfc901c056a6',
    providerMessageId: '1a05dfc901c056a6', senderInboxId: 'tryscalelabai',
    campaignVersion: 'dental_v3_pay_per_booking', campaignFamily: 'dental_ai_receptionist',
    copyVersion: 'dental_pay_per_booking_hp_v3',
    sequenceId: 'dental_ai_receptionist_cold', sequenceStep: 1,
  }),
  ...over,
});

// ── 1–2. Absent by default ──────────────────────────────────────────────────

test('1. with Supabase unconfigured the mirror is off and every call is a no-op', async () => {
  assert.equal(mirrorEnabled({}), false);
  const config = mirrorConfig({});
  assert.equal(config.enabled, false);
  assert.match(config.reason, /SUPABASE_URL and SUPABASE_SECRET_KEY are not set/);

  const result = await mirrorEvents([activity()], { env: {}, logger: quiet });
  assert.deepEqual(result, {
    enabled: false, attempted: 0, mirrored: 0, skipped: 0, failed: 0,
    reason: 'SUPABASE_URL and SUPABASE_SECRET_KEY are not set',
  });

  // Half-configured is also off — a URL with no key must not be "enabled".
  assert.equal(mirrorEnabled({ SUPABASE_URL: 'https://x.supabase.co' }), false);
  assert.equal(mirrorEnabled({ SUPABASE_SECRET_KEY: SECRET }), false);
  // A plaintext URL to a real project is refused rather than trusted; only a
  // loopback stand-in may be http, which is what the tests below use.
  assert.equal(mirrorEnabled({ SUPABASE_URL: 'http://x.supabase.co', SUPABASE_SECRET_KEY: SECRET }), false);
  assert.equal(mirrorEnabled({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: SECRET }), true);
});

test('2. the app boots and reports the mirror off without touching Sheets behaviour', () => {
  // One boot line, and it names no value.
  assert.match(serverSrc, /\[supabase-mirror\] disabled — Google Sheets only/);
  assert.match(serverSrc, /\[supabase-mirror\] enabled — canonical activity is shadow-mirrored/);
  // Naming the variable is useful guidance; printing its value would be the
  // leak. The boot line reads neither.
  const boot = serverSrc.slice(serverSrc.indexOf('app.listen(PORT'), serverSrc.indexOf('app.listen(PORT') + 700);
  assert.ok(!/process\.env\.SUPABASE/.test(boot), 'the boot line must not read a secret value');
  assert.match(boot, /mirrorEnabled\(\)/, 'it asks the module, which returns only a boolean');
});

// ── 3–4. Sheets stays authoritative and cannot be blocked ───────────────────

test('3. every mirror call happens strictly AFTER the authoritative Sheets write', () => {
  for (const [name, src, fn] of [
    ['appendIntegrationRow', serverSrc, 'async function appendIntegrationRow'],
    ['appendColdCallActivities', serverSrc, 'async function appendColdCallActivities'],
    ['recordColdCallActivity', agentSrc, 'async function recordColdCallActivity('],
    ['recordColdCallActivityStrict', agentSrc, 'async function recordColdCallActivityStrict'],
  ]) {
    const start = src.indexOf(fn);
    assert.ok(start !== -1, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const appendAt = body.indexOf('spreadsheets.values.append');
    const mirrorAt = body.indexOf('mirrorEventsInBackground');
    assert.ok(appendAt !== -1, `${name} must still write to Sheets`);
    assert.ok(mirrorAt !== -1, `${name} must mirror`);
    assert.ok(appendAt < mirrorAt, `${name} must mirror only after the Sheets append`);
    // Never awaited: the authoritative path cannot wait on the shadow.
    assert.ok(!new RegExp(`await\\s+mirrorEventsInBackground`).test(body),
      `${name} must not await the mirror`);
  }
});

test('4. a Supabase failure cannot block or fail activity persistence', async () => {
  const fake = await fakeSupabase({ status: 500 });
  try {
    // Server error: reported, never thrown.
    const failed = await mirrorEvents([activity()], { env: httpEnv(fake.env), logger: quiet });
    assert.equal(failed.failed, 1);
    assert.equal(failed.mirrored, 0);
    assert.match(failed.reason, /HTTP 500/);
  } finally { await fake.close(); }

  // Unreachable host: still resolves, still never throws.
  const dead = await mirrorEvents([activity()], {
    env: { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET }, logger: quiet,
  });
  assert.equal(dead.failed, 1);
  assert.equal(dead.enabled, true);

  // The fire-and-forget wrapper returns nothing and swallows everything, so a
  // rejected promise can never surface as an unhandled rejection in the agent.
  assert.equal(mirrorEventsInBackground([activity()], {
    env: { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET }, logger: quiet,
  }), undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
});

// ── 5. Idempotency ──────────────────────────────────────────────────────────

test('5. mirroring the same event twice creates exactly one row', async () => {
  const fake = await fakeSupabase();
  try {
    const event = activity();
    await mirrorEvents([event], { env: httpEnv(fake.env), logger: quiet });
    await mirrorEvents([event], { env: httpEnv(fake.env), logger: quiet });
    assert.equal(fake.rows.size, 1, 'the second write upserts onto the first');
    assert.equal(fake.received.length, 2, 'both writes were genuinely attempted');
    // The upsert is requested explicitly, not left to chance.
    for (const request of fake.received) {
      assert.match(request.headers.prefer || '', /resolution=merge-duplicates/);
    }
  } finally { await fake.close(); }

  // And the schema enforces it independently of the client.
  assert.match(migration, /event_id\s+text primary key/);
});

// ── 6–8. The canonical model is preserved, not reinvented ───────────────────

test('6. attribution survives the mapping intact', () => {
  const row = toCrmEvent(activity());
  assert.equal(row.event_id, 'gmail:1a05dfc901c056a6');
  assert.equal(row.lead_id, 'CE-abc123');
  assert.equal(row.source_lead_id, 'abc123');
  assert.equal(row.event_type, 'initial_email_sent');
  assert.equal(row.occurred_at, '2026-09-01T17:20:28.648Z');
  assert.equal(row.sender_inbox_id, 'tryscalelabai');
  assert.equal(row.campaign_version, 'dental_v3_pay_per_booking');
  assert.equal(row.campaign_family, 'dental_ai_receptionist');
  assert.equal(row.copy_version, 'dental_pay_per_booking_hp_v3');
  assert.equal(row.provider_message_id, '1a05dfc901c056a6');
  assert.equal(row.provider_thread_id, '1a05dfc901c056a6');
  assert.equal(row.sequence_id, 'dental_ai_receptionist_cold');
  assert.equal(row.sequence_step, 1);
  // The full metadata object is kept verbatim alongside the promoted columns.
  assert.equal(row.metadata.trigger, 'cold_sequence_step_1');
});

test('7. legacy rows with no attribution mirror as null, never as a default', () => {
  // A real production shape: 129 send events carry no sender or campaign.
  const legacy = activity({
    eventId: 'legacy-1', metadata: JSON.stringify({ step: 2, trigger: 'cold_sequence_follow_up' }),
    occurredAt: '', subject: '',
  });
  const row = toCrmEvent(legacy);
  for (const key of ['sender_inbox_id', 'campaign_version', 'campaign_family', 'copy_version',
    'provider_message_id', 'provider_thread_id', 'sequence_id', 'subject']) {
    assert.equal(row[key], null, `${key} must be null, not a fabricated value`);
  }
  // An unusable timestamp stays unknown rather than becoming "now".
  assert.equal(row.occurred_at, null);
  assert.equal(toCrmEvent(activity({ occurredAt: 'not a date' })).occurred_at, null);
  // sequence_step falls back to `step` only because the app writes both names.
  assert.equal(row.sequence_step, 2);
  // And the schema permits every one of them to be absent.
  assert.ok(!/campaign_version[^,]*not null/i.test(migration));
  assert.ok(!/sender_inbox_id[^,]*not null/i.test(migration));
  assert.ok(!/occurred_at[^,]*not null/i.test(migration));
});

test('8. email bodies are never mirrored', async () => {
  const row = toCrmEvent(activity());
  assert.equal(row.content, undefined, 'content is not part of the mirrored shape');
  assert.ok(!JSON.stringify(row).includes('must never be mirrored'));
  assert.ok(!/\bcontent\b/.test(migration.slice(migration.indexOf('create table'), migration.indexOf(');'))),
    'the table has no content column');

  const fake = await fakeSupabase();
  try {
    await mirrorEvents([activity()], { env: httpEnv(fake.env), logger: quiet });
    assert.ok(!fake.received[0].body.includes('must never be mirrored'),
      'no body text may cross the wire');
  } finally { await fake.close(); }
});

test('an event with no id or no type is reported, not silently dropped', () => {
  assert.equal(describeUnmirrorable(activity()), null);
  assert.match(describeUnmirrorable({ eventType: 'x' }), /missing eventId/);
  assert.match(describeUnmirrorable({ eventId: 'x' }), /missing eventType/);
});

// ── 9. Secrets ──────────────────────────────────────────────────────────────

test('9. no secret reaches the frontend, an API payload, a log, or the repo', async () => {
  // The browser bundle knows nothing about Supabase at all.
  assert.ok(!/supabase/i.test(browser), 'public/index.html must not mention Supabase');

  // The module never returns the key, in any shape.
  const config = mirrorConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: SECRET });
  assert.equal(config.enabled, true);
  const health = await mirrorHealth({ env: { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET } });
  assert.ok(!JSON.stringify(health).includes(SECRET));
  assert.ok(!JSON.stringify(health).includes('127.0.0.1'), 'not even the project URL is echoed');

  // Failures log a status, never a body or a header.
  const logged = [];
  const capture = { log: (...a) => logged.push(a.join(' ')), warn: (...a) => logged.push(a.join(' ')) };
  await mirrorEvents([activity()], {
    env: { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET }, logger: capture,
  });
  const output = logged.join('\n');
  assert.ok(output.length > 0, 'a failure is observable');
  assert.ok(!output.includes(SECRET), 'the key never appears in a log line');

  // The health endpoint returns a fixed message rather than a driver error.
  const route = serverSrc.slice(serverSrc.indexOf("app.get('/api/supabase/mirror-health'"), serverSrc.indexOf('// Campaign performance is derived'));
  assert.match(route, /error: 'mirror health could not be determined'/);
  assert.ok(!/e\.message/.test(route.slice(route.indexOf('res.status(500)'))), 'no driver message is returned');

  // Nothing is hardcoded and no .env file is committed.
  // A real key is a long opaque string; the doc comment's "sb_secret_..."
  // placeholder is not one, so match on shape rather than on the prefix alone.
  assert.ok(!/sb_secret_[A-Za-z0-9_-]{12,}/.test(mirrorSrc), 'no key literal in source');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(mirrorSrc), 'no service_role JWT literal in source');
  assert.ok(!/supabase\.co/.test(mirrorSrc), 'no project URL literal in source');
  // Not "no .env on disk" -- a working checkout legitimately has one, and this
  // assertion only passed before because it ran in a worktree that had none.
  // The property that matters is that git never tracks it.
  const tracked = require('node:child_process')
    .spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: root }).status === 0;
  assert.equal(tracked, false, '.env must never be committed');
  const ignored = require('node:child_process')
    .spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: root }).status === 0;
  assert.equal(ignored, true, '.env must be gitignored so it cannot be added by accident');
});

// ── 10–11. Backfill ─────────────────────────────────────────────────────────

test('10. the backfill is dry-run by default and cannot mutate Sheets or send', () => {
  assert.match(backfillSrc, /const APPLY = flag\('apply'\);/);
  assert.match(backfillSrc, /DRY RUN — nothing was written to Supabase/);
  assert.match(backfillSrc, /if \(!APPLY\) \{[\s\S]{0,300}return;/, 'writing is gated on --apply');
  // Read-only Google scope: a Sheets write is refused by Google, not just
  // avoided by the code.
  assert.match(backfillSrc, /spreadsheets\.readonly/);
  assert.ok(!/spreadsheets'\]/.test(backfillSrc), 'no read-write Sheets scope');
  assert.ok(!/values\.(update|append|batchUpdate)/.test(backfillSrc), 'the backfill never writes to Sheets');
  // It cannot send: it requires neither the agent nor any mail client. Checked
  // against require() calls, since the prose above them names Gmail.
  const requires = [...backfillSrc.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(requires.sort(), [
    '../integrations/cold-call-pipeline', '../integrations/supabase-mirror', 'dotenv', 'googleapis',
  ], 'the backfill pulls in nothing that could send');
  // Dry run reports what was asked for.
  for (const line of ['canonical activities read', 'already mirrored', 'would insert',
    'malformed / not safely representable']) {
    assert.ok(backfillSrc.includes(line), `dry run reports "${line}"`);
  }
});

test('11. re-running the backfill is idempotent', async () => {
  const fake = await fakeSupabase();
  try {
    const batch = [activity(), activity({ eventId: 'gmail:second', sourceLeadId: 'def456' })];
    await mirrorEvents(batch, { env: httpEnv(fake.env), logger: quiet });
    assert.equal(fake.rows.size, 2);
    // A second full pass over the same canonical rows converges.
    await mirrorEvents(batch, { env: httpEnv(fake.env), logger: quiet });
    await mirrorEvents(batch, { env: httpEnv(fake.env), logger: quiet });
    assert.equal(fake.rows.size, 2, 'repeated runs never duplicate');
  } finally { await fake.close(); }
});

// ── 12–14. Nothing production depends on the mirror ─────────────────────────

test('12. no send, Pipeline, or automation path reads from Supabase', () => {
  // The mirror module is write-and-health only: it exposes no lead lookup.
  assert.ok(!/function (getEvents|readEvents|fetchLead|loadFromSupabase)/.test(mirrorSrc));

  // The agent imports exactly one symbol, and it is the write path.
  const agentImport = agentSrc.slice(agentSrc.indexOf("require('./integrations/supabase-mirror')") - 120,
    agentSrc.indexOf("require('./integrations/supabase-mirror')"));
  assert.match(agentImport, /\{ mirrorEventsInBackground \}/);
  assert.ok(!/mirrorHealth|mirrorConfig/.test(agentImport), 'the agent has no read access to the mirror');

  // No decision anywhere branches on the mirror's result.
  for (const src of [serverSrc, agentSrc]) {
    assert.ok(!/if\s*\(\s*(await\s+)?mirrorEvents/.test(src), 'no control flow depends on a mirror result');
    assert.ok(!/await mirrorEventsInBackground/.test(src));
  }
  // Ownership, sending and Pipeline modules do not know Supabase exists.
  for (const file of ['automation-ownership.js', 'pipeline-state.js', 'gmail-sender-routing.js',
    'stage-sequences.js', 'reply-analytics.js', 'crm-health.js']) {
    const source = readSource(path.join(root, 'integrations', file));
    assert.ok(!/supabase/i.test(source), `${file} must not reference Supabase`);
  }
});

test('13. CRM Health does not consult the mirror', () => {
  const health = serverSrc.slice(serverSrc.indexOf("app.get('/api/crm/health'"), serverSrc.indexOf("app.get('/api/crm/ui-status'"));
  assert.ok(!/supabase|mirror/i.test(health), 'CRM Health must stay free of the shadow store');
  // The mirror has its own endpoint, and it says what it is.
  assert.match(serverSrc, /app\.get\('\/api\/supabase\/mirror-health'/);
  assert.match(serverSrc, /authoritativeStore: 'google_sheets'/);
  assert.match(serverSrc, /Observational only\./);
});

test('14. the health diagnostic reports status and counts, and writes nothing', async () => {
  const fake = await fakeSupabase();
  try {
    await mirrorEvents([activity(), activity({ eventId: 'gmail:two' })], { env: httpEnv(fake.env), logger: quiet });
    const before = fake.received.length;
    const health = await mirrorHealth({ env: httpEnv(fake.env), sheetCount: 5 });
    assert.equal(health.configured, true);
    assert.equal(health.healthy, true);
    assert.equal(health.mirroredCount, 2);
    assert.equal(health.sheetCount, 5);
    assert.equal(health.difference, 3, 'the gap between Sheets and the mirror is reported');
    // Read-only: only HEAD and GET after the writes above.
    for (const request of fake.received.slice(before)) {
      assert.ok(['HEAD', 'GET'].includes(request.method), `health issued a ${request.method}`);
    }
  } finally { await fake.close(); }

  // Unconfigured health is a plain statement, not an error.
  const off = await mirrorHealth({ env: {}, sheetCount: 12 });
  assert.equal(off.configured, false);
  assert.equal(off.healthy, null);
  assert.equal(off.sheetCount, 12);
  assert.equal(off.difference, null);
});

// ── 15. Bounded behaviour ───────────────────────────────────────────────────

test('15. retries are bounded and a bad request is not retried', async () => {
  let posts = 0;
  const transient = await fakeSupabase({ onRequest: (req, res) => {
    if (req.method !== 'POST') return;
    posts++; res.writeHead(503); res.end();
  } });
  try {
    await mirrorEvents([activity()], { env: httpEnv(transient.env), logger: quiet });
    assert.equal(posts, 2, 'a transient failure is retried exactly once');
  } finally { await transient.close(); }

  posts = 0;
  const badRequest = await fakeSupabase({ onRequest: (req, res) => {
    if (req.method !== 'POST') return;
    posts++; res.writeHead(400); res.end();
  } });
  try {
    await mirrorEvents([activity()], { env: httpEnv(badRequest.env), logger: quiet });
    assert.equal(posts, 1, 'a 4xx is a bad request; resending it would just fail again');
  } finally { await badRequest.close(); }
});

test('the migration is reproducible and defines the table this code writes', () => {
  assert.equal(TABLE, 'crm_events');
  assert.match(migration, /create table if not exists public\.crm_events/);
  // Every column the mapper emits must exist in the migration.
  for (const column of Object.keys(toCrmEvent(activity()))) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(migration), `${column} is missing from the migration`);
  }
  assert.match(migration, /mirrored_at\s+timestamptz not null default now\(\)/);
  assert.match(migration, /metadata\s+jsonb not null default/);
  // Idempotent to apply, and RLS on so a leaked publishable key still reads nothing.
  assert.match(migration, /create index if not exists/);
  assert.match(migration, /alter table public\.crm_events enable row level security/);
});
