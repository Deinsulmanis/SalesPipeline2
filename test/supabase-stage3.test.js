'use strict';

// Stage 3 — operational outreach state (ColdEmail → Supabase outreach_leads).
//
// The promise being defended: Google Sheets stays the authoritative store for
// operational lead state, and the mirror is incapable of changing that. It must
// be absent-by-default, non-blocking when present, idempotent when replayed,
// silent about its credentials — and, the one genuinely new hazard at this
// stage, structurally unable to mirror a PARTIAL ColdEmail row as if it were a
// whole one. No production read path may consult it for a decision.
//
// No live Supabase project is contacted. Where an endpoint is needed, a local
// http server stands in, so these tests run offline and touch nothing real.
// Nothing here sends email or reads Google Sheets.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const state = require('../integrations/outreach-state');
const {
  TABLE, FIELD_MAP, SHEET_FIELDS, CRITICAL_FIELDS, NONCRITICAL_FIELDS,
  outreachStateMode, isCompleteLead, missingFields, describeUnmirrorable,
  toOutreachLeadRow, toOutreachLeadPatch, fromOutreachLeadRow,
  mirrorOutreachLeads, mirrorOutreachLeadFields,
  mirrorOutreachLeadsInBackground, mirrorOutreachLeadFieldsInBackground,
  getOutreachLeadById, getOutreachLeadByEmail, batchGetOutreachLeads,
  listOutreachLeads, countOutreachLeads, compareOutreachLead,
} = state;

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const stateSrc = readSource(path.join(root, 'integrations', 'outreach-state.js'));
const backfillSrc = readSource(path.join(root, 'scripts', 'supabase-outreach-backfill.js'));
const migration = readSource(path.join(root, 'supabase', 'migrations', '20260912000000_outreach_leads.sql'));

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
const quiet = { log() {}, warn() {}, error() {} };

/** A complete ColdEmail row — every one of the 24 COLUMNS keys present. */
function completeLead(overrides = {}) {
  const lead = { _row: 7 };
  for (const field of SHEET_FIELDS) lead[field] = '';
  Object.assign(lead, {
    id: 'ce-1', company: 'Northbridge Dental', contactName: 'Dana Reyes',
    email: 'Dana@Northbridge.example', city: 'Halifax', tradeType: 'dental',
    website: 'https://northbridge.example', stage: 'Contacted', emailStatus: 'sent',
    lastEmailedAt: '2026-09-01T14:00:00.000Z', emailStep: '2', notes: '[MANUAL HOLD]',
    reviewCount: '12', rating: '4.7', tier: 'A', siteContext: 'no online booking',
    campaign: 'Industrial Staffing Agency', campaign_notes: 'n/a',
    enrichment_attempted: 'true', leadNiche: 'dental', senderInboxId: 'tryscalelabai',
    emailTemplateId: 'dental-v1', routingRequired: 'true',
    intendedCampaignVersion: 'dental_ai_receptionist_v3',
  }, overrides);
  return lead;
}

/** The nine-field projection findColdEmailTwins() actually produces. */
function twinLead(overrides = {}) {
  return {
    id: 'ce-1', company: 'Northbridge Dental', email: 'dana@northbridge.example',
    stage: 'Contacted', emailStatus: 'sent', lastEmailedAt: '2026-09-01T14:00:00.000Z',
    emailStep: '2', notes: '[MANUAL HOLD]', senderInboxId: 'tryscalelabai',
    _row: 7, ...overrides,
  };
}

/**
 * A stand-in PostgREST that implements the upsert semantics this module relies
 * on: keyed by lead_id, and ON CONFLICT updates ONLY the columns present in the
 * payload. Getting that right is the whole point — it is what makes a narrow
 * patch safe.
 */
function fakeSupabase({ status = 201, onRequest } = {}) {
  const received = [];
  const rows = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (onRequest) { onRequest(req, res, body); if (res.writableEnded) return; }
      if (req.method === 'POST') {
        for (const row of JSON.parse(body || '[]')) {
          const existing = rows.get(row.lead_id) || {};
          rows.set(row.lead_id, { ...existing, ...row });   // merge, never replace
        }
        res.writeHead(status); res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-range': `0-${rows.size}/${rows.size}` }); res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...rows.values()]));
    });
  });
  return {
    received, rows,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return { SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SECRET_KEY: SECRET };
    },
    async stop() { await new Promise(resolve => server.close(resolve)); },
  };
}

// ── A. shape and classification ─────────────────────────────────────────────

test('A1 — FIELD_MAP matches outreach-agent COLUMNS exactly, in order', () => {
  const block = agentSrc.match(/const COLUMNS = \[([\s\S]*?)\];/);
  assert.ok(block, 'outreach-agent.js must still declare COLUMNS');
  const columns = block[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.equal(columns.length, 24, 'ColdEmail is a 24-column sheet (A:X)');
  assert.deepEqual(SHEET_FIELDS, columns,
    'FIELD_MAP must list every ColdEmail column in sheet order — a new column added '
    + 'to COLUMNS without extending FIELD_MAP would silently stop being mirrored');
});

test('A2 — 21 of 24 fields are behaviour-critical; the 3 UI-only ones are named', () => {
  assert.equal(CRITICAL_FIELDS.length, 21);
  assert.deepEqual([...NONCRITICAL_FIELDS].sort(),
    ['campaign_notes', 'enrichment_attempted', 'reviewCount'].sort());
  for (const field of ['stage', 'emailStatus', 'notes', 'senderInboxId', 'routingRequired',
    'leadNiche', 'emailTemplateId', 'campaign', 'siteContext', 'intendedCampaignVersion']) {
    assert.ok(CRITICAL_FIELDS.includes(field), `${field} decides behaviour and must be critical`);
  }
});

test('A3 — every field maps to a column the migration actually creates', () => {
  for (const column of Object.values(FIELD_MAP)) {
    const declared = new RegExp(`^\\s{2}${column}\\s`, 'm').test(migration);
    assert.ok(declared, `migration must declare column ${column}`);
  }
  assert.match(migration, /lead_id\s+text primary key/, 'lead_id must be the primary key so upserts are idempotent');
  assert.match(migration, /enable row level security/, 'RLS must be on, as it is for crm_events');
  assert.match(migration, /email_normalized\s+text generated always as/,
    'email_normalized must be GENERATED so it cannot drift from email');
});

// ── B. the partial-row guard (the new hazard at this stage) ─────────────────

test('B1 — a nine-field twin is refused, not silently blanked', () => {
  const twin = twinLead();
  assert.equal(isCompleteLead(twin), false);
  const problem = describeUnmirrorable(twin);
  assert.ok(problem, 'a twin must never be mirrorable as a whole row');
  assert.match(problem, /partial row/);
  assert.match(problem, /mirrorOutreachLeadFields/, 'the message must point at the safe alternative');
});

test('B2 — the twin is missing exactly the 15 fields findColdEmailTwins omits', () => {
  const missing = missingFields(twinLead());
  assert.deepEqual(missing.sort(), [
    'contactName', 'city', 'tradeType', 'website', 'reviewCount', 'rating', 'tier',
    'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche',
    'emailTemplateId', 'routingRequired', 'intendedCampaignVersion',
  ].sort());
  const criticalLost = missing.filter(f => CRITICAL_FIELDS.includes(f));
  assert.equal(criticalLost.length, 12,
    'twelve behaviour-critical columns would be blanked — this is why the guard exists');
});

test('B3 — completeness is key PRESENCE, not truthiness ("" is a real value)', () => {
  const blanked = completeLead();
  for (const field of SHEET_FIELDS) blanked[field] = '';
  blanked.id = 'ce-1';
  assert.equal(isCompleteLead(blanked), true,
    'an all-empty but complete row is legitimate — only absent keys signal a partial read');
  const missingOne = completeLead();
  delete missingOne.senderInboxId;
  assert.equal(isCompleteLead(missingOne), false);
});

test('B4 — a lead with no id is refused (nothing to upsert on)', () => {
  assert.match(describeUnmirrorable(completeLead({ id: '' })), /missing lead id/);
  assert.match(describeUnmirrorable(completeLead({ id: '   ' })), /missing lead id/);
  assert.match(describeUnmirrorable(null), /not a lead object/);
});

test('B5 — a complete row is accepted', () => {
  assert.equal(describeUnmirrorable(completeLead()), null);
});

// ── C. conversion fidelity ──────────────────────────────────────────────────

test('C1 — values are mirrored verbatim, with no helpful coercion', () => {
  const row = toOutreachLeadRow(completeLead({ routingRequired: 'TRUE', emailStatus: '' }));
  assert.equal(row.routing_required, 'TRUE', 'case must survive: the runtime lowercases at the point of use');
  assert.equal(row.email_status, '', 'empty must stay empty, not become null');
  assert.equal(row.email, 'Dana@Northbridge.example', 'the raw address is preserved; only the generated column normalises');
  assert.equal(row.sender_inbox_id, 'tryscalelabai');
  assert.equal(row.sheet_row, 7);
});

test('C2 — derived columns are derived, and refuse to invent a value', () => {
  const good = toOutreachLeadRow(completeLead());
  assert.equal(good.last_emailed_at_ts, '2026-09-01T14:00:00.000Z');
  assert.equal(good.email_step_int, 2);

  const junk = toOutreachLeadRow(completeLead({ lastEmailedAt: 'not a date', emailStep: 'two' }));
  assert.equal(junk.last_emailed_at_ts, null, 'an unparseable date must be null, never a substituted now()');
  assert.equal(junk.email_step_int, null);
  assert.equal(junk.last_emailed_at, 'not a date', 'the text column still holds exactly what the sheet holds');

  const blank = toOutreachLeadRow(completeLead({ lastEmailedAt: '', emailStep: '' }));
  assert.equal(blank.last_emailed_at_ts, null);
  assert.equal(blank.email_step_int, null);
});

test('C3 — round-trips back to the ColdEmail shape the runtime expects', () => {
  const lead = completeLead();
  const back = fromOutreachLeadRow(toOutreachLeadRow(lead));
  for (const field of SHEET_FIELDS) {
    assert.equal(back[field], lead[field], `${field} must survive the round trip unchanged`);
  }
});

test('C4 — nulls from Postgres read back as empty strings, not "null"', () => {
  const back = fromOutreachLeadRow({ lead_id: 'ce-1', notes: null, sender_inbox_id: undefined });
  assert.equal(back.notes, '');
  assert.equal(back.senderInboxId, '');
  assert.equal(back.id, 'ce-1');
});

// ── D. narrow patches ───────────────────────────────────────────────────────

test('D1 — a patch carries the lead id and only the named columns', () => {
  const patch = toOutreachLeadPatch('ce-1', { notes: '[MANUAL HOLD]' });
  assert.deepEqual(Object.keys(patch).sort(), ['lead_id', 'mirrored_at', 'notes', 'updated_at'].sort());
  assert.equal(patch.lead_id, 'ce-1');
  assert.equal(patch.notes, '[MANUAL HOLD]');
  assert.ok(!('stage' in patch), 'a notes patch must not mention stage at all');
});

test('D2 — a patch keeps derived columns consistent with the column they come from', () => {
  const patch = toOutreachLeadPatch('ce-1', { lastEmailedAt: '2026-09-10T09:00:00.000Z', emailStep: '3' });
  assert.equal(patch.last_emailed_at_ts, '2026-09-10T09:00:00.000Z');
  assert.equal(patch.email_step_int, 3);
});

test('D3 — an unknown field name is refused rather than dropped', () => {
  assert.throws(() => toOutreachLeadPatch('ce-1', { nope: 'x' }), /unknown ColdEmail field/);
  assert.throws(() => toOutreachLeadPatch('ce-1', { Notes: 'x' }), /unknown ColdEmail field/,
    'field names are case-sensitive: a near-miss must fail loudly, not mirror nothing');
  assert.throws(() => toOutreachLeadPatch('ce-1', {}), /at least one field/);
  assert.throws(() => toOutreachLeadPatch('', { notes: 'x' }), /requires a lead id/);
});

test('D4 — a patch does NOT blank the columns it omits', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    const before = fake.rows.get('ce-1');
    assert.equal(before.sender_inbox_id, 'tryscalelabai');
    assert.equal(before.campaign, 'Industrial Staffing Agency');

    const result = await mirrorOutreachLeadFields('ce-1', { notes: '[REPLY: Interested]' }, { env, logger: quiet });
    assert.equal(result.mirrored, 1);

    const after = fake.rows.get('ce-1');
    assert.equal(after.notes, '[REPLY: Interested]', 'the patched column changed');
    assert.equal(after.sender_inbox_id, 'tryscalelabai', 'sender routing survived the patch');
    assert.equal(after.campaign, 'Industrial Staffing Agency', 'campaign identity survived the patch');
    assert.equal(after.routing_required, 'true', 'the routing guard survived the patch');
    assert.equal(after.lead_niche, 'dental');
    assert.equal(after.email_template_id, 'dental-v1');
  } finally { await fake.stop(); }
});

test('D5 — a bad patch is reported, never thrown, at a post-write call site', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    const result = await mirrorOutreachLeadFields('ce-1', { bogus: 'x' }, { env, logger: quiet });
    assert.equal(result.mirrored, 0);
    assert.equal(result.failed, 0, 'a programming error is not a transport failure');
    assert.match(result.reason, /unknown ColdEmail field/);
    assert.equal(fake.received.length, 0, 'nothing may be sent when the patch is invalid');
  } finally { await fake.stop(); }
});

// ── E. absent by default, non-blocking always ───────────────────────────────

test('E1 — unconfigured is a cheap no-op, not an error', async () => {
  const env = {};
  assert.equal(outreachStateMode(env), 'off');
  const result = await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
  assert.equal(result.enabled, false);
  assert.equal(result.mirrored, 0);
  assert.match(result.reason, /SUPABASE_URL/);

  const patch = await mirrorOutreachLeadFields('ce-1', { notes: 'x' }, { env, logger: quiet });
  assert.equal(patch.enabled, false);
});

test('E2 — the mode gate defaults off and ignores anything it does not recognise', () => {
  assert.equal(outreachStateMode({}), 'off');
  assert.equal(outreachStateMode({ SUPABASE_OUTREACH_MODE: '' }), 'off');
  assert.equal(outreachStateMode({ SUPABASE_OUTREACH_MODE: 'yes' }), 'off');
  assert.equal(outreachStateMode({ SUPABASE_OUTREACH_MODE: 'DUAL' }), 'dual');
  assert.equal(outreachStateMode({ SUPABASE_OUTREACH_MODE: ' primary ' }), 'primary');
});

test('E3 — an unreachable Supabase never throws and never rejects', async () => {
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  const result = await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
  assert.equal(result.failed, 1);
  assert.equal(result.mirrored, 0);
  assert.ok(result.reason, 'the failure is reported, not raised');
});

test('E4 — a 500 is retried; a 400 is not', async () => {
  const server500 = fakeSupabase({ status: 500 });
  const env500 = await server500.start();
  try {
    await mirrorOutreachLeads([completeLead()], { env: env500, logger: quiet });
    assert.equal(server500.received.length, 2, 'a server error is worth one retry');
  } finally { await server500.stop(); }

  const server400 = fakeSupabase({ status: 400 });
  const env400 = await server400.start();
  try {
    await mirrorOutreachLeads([completeLead()], { env: env400, logger: quiet });
    assert.equal(server400.received.length, 1, 'a malformed request will not become well-formed on retry');
  } finally { await server400.stop(); }
});

test('E5 — the background wrappers swallow everything', async () => {
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  assert.doesNotThrow(() => mirrorOutreachLeadsInBackground([completeLead()], { env, logger: quiet }));
  assert.doesNotThrow(() => mirrorOutreachLeadsInBackground(null, { env, logger: quiet }));
  assert.doesNotThrow(() => mirrorOutreachLeadFieldsInBackground('ce-1', { notes: 'x' }, { env, logger: quiet }));
  assert.doesNotThrow(() => mirrorOutreachLeadFieldsInBackground('ce-1', { bogus: 'x' }, { env, logger: quiet }));
  await new Promise(resolve => setTimeout(resolve, 50));
});

test('E6 — a partial row is skipped and reported, and never reaches the wire', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    const result = await mirrorOutreachLeads([twinLead(), completeLead({ id: 'ce-2' })], { env, logger: quiet });
    assert.equal(result.skipped, 1);
    assert.equal(result.mirrored, 1, 'the complete row still goes through');
    assert.match(result.skippedDetail[0].problem, /partial row/);
    const sent = JSON.parse(fake.received[0].body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].lead_id, 'ce-2', 'only the complete lead was transmitted');
  } finally { await fake.stop(); }
});

// ── F. idempotence and batching ─────────────────────────────────────────────

test('F1 — replaying a mirror converges instead of duplicating', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    await mirrorOutreachLeads([completeLead({ stage: 'Replied' })], { env, logger: quiet });
    assert.equal(fake.rows.size, 1, 'lead_id is the primary key');
    assert.equal(fake.rows.get('ce-1').stage, 'Replied', 'the latest state wins');
    for (const request of fake.received) {
      assert.match(request.headers.prefer, /resolution=merge-duplicates/);
    }
  } finally { await fake.stop(); }
});

test('F2 — a large mirror is chunked so one timeout cannot lose the whole tab', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    const leads = Array.from({ length: 1200 }, (_, i) => completeLead({ id: `ce-${i}` }));
    const result = await mirrorOutreachLeads(leads, { env, logger: quiet });
    assert.equal(result.mirrored, 1200);
    assert.equal(fake.received.length, 3, '1200 rows at 500 per chunk is three requests');
    assert.equal(fake.rows.size, 1200);
  } finally { await fake.stop(); }
});

test('F3 — an empty or non-array input is handled without a request', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    assert.equal((await mirrorOutreachLeads([], { env, logger: quiet })).attempted, 0);
    assert.equal(fake.received.length, 0);
    const single = await mirrorOutreachLeads(completeLead(), { env, logger: quiet });
    assert.equal(single.mirrored, 1, 'a bare lead is accepted as a one-element batch');
  } finally { await fake.stop(); }
});

// ── G. secrets ──────────────────────────────────────────────────────────────

test('G1 — the key is never returned, and a failure body is never echoed', async () => {
  const fake = fakeSupabase({
    status: 400,
    onRequest(req, res) {
      // A real PostgREST error can quote the submitted row back at you.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'invalid input', details: 'dana@northbridge.example' }));
    },
  });
  const env = await fake.start();
  try {
    const result = await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET), 'the secret must never appear in a returned object');
    assert.ok(!serialized.includes('northbridge.example'),
      'a provider error body may contain prospect data and must not be surfaced');
    assert.equal(result.reason, 'HTTP 400', 'only the status is recorded');
  } finally { await fake.stop(); }
});

test('G2 — the module never logs a key, and reads it only from the environment', () => {
  assert.ok(!/console\.log\([^)]*key/i.test(stateSrc));
  assert.match(stateSrc, /mirrorConfig/, 'credentials come from the shared Stage 1 config, not a second copy');
  assert.ok(!/sb_secret_[A-Za-z0-9]/.test(stateSrc), 'no key literal may appear in source');
});

// ── H. reads are parity-only: nothing operational may consult them ──────────

test('H1 — reads report failure rather than pretending the mirror is empty', async () => {
  const env = {};
  const byId = await getOutreachLeadById('ce-1', { env });
  assert.equal(byId.ok, false);
  assert.equal(byId.lead, null, 'a disabled mirror must not look like "no such lead"');
  const byEmail = await getOutreachLeadByEmail('dana@northbridge.example', { env });
  assert.equal(byEmail.ok, false);
  const list = await listOutreachLeads({ env });
  assert.equal(list.ok, false);
  const count = await countOutreachLeads({ env });
  assert.equal(count.ok, false);
  assert.equal(count.count, null);
});

test('H2 — a batch read is one request, not N', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    await mirrorOutreachLeads(
      ['ce-1', 'ce-2', 'ce-3'].map(id => completeLead({ id })), { env, logger: quiet });
    fake.received.length = 0;
    const result = await batchGetOutreachLeads(['ce-1', 'ce-2', 'ce-3', 'ce-1'], { env });
    assert.equal(result.ok, true);
    assert.equal(fake.received.length, 1, 'three ids must cost one round trip');
    assert.equal(result.byId.size, 3);
    assert.match(fake.received[0].url, /lead_id=in\./);
  } finally { await fake.stop(); }
});

test('H3 — a filter value cannot break out of its quoted literal', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    await getOutreachLeadById('ce-1","ce-2', { env });
    const url = decodeURIComponent(fake.received[0].url);
    assert.ok(!/"ce-2"/.test(url.split('lead_id=eq.')[1] || ''),
      'an embedded quote must not become a second filter term');
  } finally { await fake.stop(); }
});

test('H4 — NO production read path consults Supabase for an operational decision', () => {
  const readers = [
    'getOutreachLeadById', 'getOutreachLeadByEmail', 'batchGetOutreachLeads',
    'listOutreachLeads', 'countOutreachLeads', 'fromOutreachLeadRow',
  ];
  for (const reader of readers) {
    assert.ok(!serverSrc.includes(reader),
      `server.js must not call ${reader} — Sheets is authoritative for operational state in Stage 3`);
    assert.ok(!agentSrc.includes(reader),
      `outreach-agent.js must not call ${reader} — the sender must never read from the mirror`);
  }
});

test('H5 — the mode gate has no reader honouring "primary" yet', () => {
  assert.ok(!/outreachStateMode\(\)\s*===\s*'primary'/.test(serverSrc + agentSrc),
    'nothing may branch on primary until a read cutover is separately approved');
});

// ── I. write-path integration (3B) ──────────────────────────────────────────

test('I1 — the agent mirrors the COMPLETE authoritative read, once per cycle', () => {
  assert.match(agentSrc, /const all = await readLeads\(snapshot\.coldEmail\);/,
    'the cycle must still read the full A:X tab');
  const hook = agentSrc.match(/mirrorOutreachLeadsInBackground\(all\)/);
  assert.ok(hook, 'the agent must mirror the leads it just read');

  const readIndex = agentSrc.indexOf('const all = await readLeads(snapshot.coldEmail);');
  const hookIndex = agentSrc.indexOf('mirrorOutreachLeadsInBackground(all)');
  const spliceIndex = agentSrc.indexOf('all.splice(0, all.length, target)');
  assert.ok(hookIndex > readIndex, 'the mirror must follow the authoritative read');
  assert.ok(hookIndex < spliceIndex,
    'the mirror must run BEFORE TARGET_LEAD_ID narrows the set, or a targeted run would shrink the mirror');
});

test('I2 — every agent mirror call is gated and fire-and-forget', () => {
  assert.match(agentSrc, /if \(outreachStateMode\(\) !== 'off'\) mirrorOutreachLeadsInBackground\(all\)/);
  assert.ok(!/await mirrorOutreachLeads\(/.test(agentSrc),
    'the sender must never await the mirror — a Supabase stall cannot delay a send');
});

test('I3 — the narrow notes writer mirrors a PATCH, never the partial twin', () => {
  const fn = serverSrc.match(/async function writeColdEmailNotes\([\s\S]*?\n}/);
  assert.ok(fn, 'writeColdEmailNotes must still exist');
  assert.match(fn[0], /mirrorOutreachLeadFieldsInBackground\(twin\.id, \{ notes \}\)/,
    'a twin is a nine-field projection; mirroring it whole would blank fifteen columns');
  assert.ok(!/mirrorOutreachLeadsInBackground\(twin/.test(fn[0]),
    'the twin must never be passed to the whole-row mirror');
  const sheetWrite = fn[0].indexOf('values.update');
  const mirror = fn[0].indexOf('mirrorOutreachLeadFieldsInBackground');
  assert.ok(mirror > sheetWrite, 'the mirror runs only after the authoritative write has succeeded');
});

test('I4 — the import mirrors complete rows, and only after the append succeeds', () => {
  assert.match(serverSrc, /toMirror\.push\(lead\)/, 'the import must retain the lead objects it built');
  const appendIndex = serverSrc.indexOf('insertDataOption:\'INSERT_ROWS\'');
  const mirrorIndex = serverSrc.indexOf('mirrorOutreachLeadsInBackground(toMirror)');
  assert.ok(mirrorIndex > appendIndex, 'nothing is mirrored until Sheets has accepted the rows');
  // The import builds its rows from CE_COLUMNS, so they are complete by construction.
  assert.match(serverSrc, /toAdd\.push\(CE_COLUMNS\.map\(col => String\(lead\[col\] \?\? ''\)\)\)/);
});

test('I5 — no ColdEmail write path awaits the mirror or lets it throw', () => {
  for (const [name, src] of [['server.js', serverSrc], ['outreach-agent.js', agentSrc]]) {
    assert.ok(!/await mirrorOutreachLead/.test(src),
      `${name} must not await the Stage 3 mirror — it sits after an authoritative write`);
    assert.ok(!/mirrorOutreachLeads\(/.test(src.replace(/mirrorOutreachLeadsInBackground\(/g, '')),
      `${name} must use the background wrapper, never the awaitable form`);
  }
});

/**
 * Resolve every Sheets mutation to the tab it targets, the way the Stage 3A
 * write-path inventory did. SHEET_NAME is ambiguous across the two files — it
 * means ColdEmail in the agent and Leads in the server — so each file is
 * resolved with its own meaning rather than by a shared regex.
 */
function coldEmailWriteSites(source, sheetNameMeans) {
  const lines = source.split('\n');
  const sites = [];
  lines.forEach((line, index) => {
    if (!/values\.(update|batchUpdate|append)\(/.test(line)) return;
    // The range may sit on this line or a few below it, inside the request body.
    const window = lines.slice(index, index + 8).join(' ');
    const tokens = [...window.matchAll(/range:\s*`?\$\{([A-Za-z_]+)\}|range:\s*[`'"]([A-Za-z]+)!/g)];
    for (const match of tokens) {
      const token = match[1] || match[2];
      const target = token === 'SHEET_NAME' ? sheetNameMeans
        : (token === 'CE_SHEET_NAME' || token === 'CE_COL_RANGE') ? 'ColdEmail'
          : token;
      if (target === 'ColdEmail') { sites.push(index + 1); return; }
    }
  });
  return sites;
}

test('I6 — ColdEmail write-site count is a canary against an unmirrored new writer', () => {
  // Not a style rule — a tripwire. Stage 3A resolved every Sheets mutation to
  // its target tab; if this count moves, a ColdEmail write path was added or
  // removed and Stage 3 must decide whether it needs its own mirror hook, or
  // whether the agent's cycle snapshot already covers it.
  const server = coldEmailWriteSites(serverSrc, 'Leads');
  const agent = coldEmailWriteSites(agentSrc, 'ColdEmail');
  const total = server.length + agent.length;
  assert.equal(total, 31,
    `ColdEmail write sites moved from 31 to ${total} `
    + `(server.js ${server.length}, outreach-agent.js ${agent.length}). `
    + 'Re-run the Stage 3A write-path inventory and confirm the change is covered.');
});

test('I7 — the cycle snapshot is what makes coverage complete, not a list of hooks', () => {
  // Only three call sites mirror anything, against 31 ColdEmail write sites.
  // That is deliberate and is the reason the design is safe: the agent re-states
  // every lead from the authoritative A:X read each cycle, so a writer with no
  // hook of its own is reconciled on the next run rather than diverging forever.
  const hooks = (serverSrc + agentSrc).match(/mirrorOutreachLead(?:s|Fields)InBackground\(/g) || [];
  assert.equal(hooks.length, 3,
    'expected exactly three hooks: the agent cycle snapshot, the import, and the notes patch');
  assert.match(agentSrc, /self-heals/, 'the convergence property must stay documented where it is relied on');
});

// ── J. parity comparison ────────────────────────────────────────────────────

test('J1 — identical rows compare clean', () => {
  const lead = completeLead();
  const verdict = compareOutreachLead(lead, fromOutreachLeadRow(toOutreachLeadRow(lead)));
  assert.equal(verdict.clean, true);
  assert.deepEqual(verdict.critical, []);
  assert.deepEqual(verdict.noncritical, []);
});

test('J2 — a missing mirror row is a critical failure, not a clean pass', () => {
  const verdict = compareOutreachLead(completeLead(), null);
  assert.equal(verdict.present, false);
  assert.equal(verdict.clean, false);
  assert.equal(verdict.critical.length, 1);
});

test('J3 — critical and noncritical divergence are separated', () => {
  const sheet = completeLead();
  const mirrored = fromOutreachLeadRow(toOutreachLeadRow(completeLead({
    senderInboxId: 'primary',     // critical: wrong mailbox
    reviewCount: '99',            // noncritical: display only
  })));
  const verdict = compareOutreachLead(sheet, mirrored);
  assert.deepEqual(verdict.critical, ['senderInboxId']);
  assert.deepEqual(verdict.noncritical, ['reviewCount']);
  assert.equal(verdict.clean, false);
});

test('J4 — only absence is normalised; nothing semantic is smoothed over', () => {
  assert.equal(compareOutreachLead({ ...completeLead(), notes: null },
    fromOutreachLeadRow(toOutreachLeadRow(completeLead({ notes: '' })))).clean, true,
    'null and "" are the same statement');

  const trimmed = compareOutreachLead(completeLead({ stage: 'Contacted ' }),
    fromOutreachLeadRow(toOutreachLeadRow(completeLead({ stage: 'Contacted' }))));
  assert.deepEqual(trimmed.critical, ['stage'],
    'whitespace must NOT be trimmed away — the runtime compares these exactly');

  const cased = compareOutreachLead(completeLead({ senderInboxId: 'Primary' }),
    fromOutreachLeadRow(toOutreachLeadRow(completeLead({ senderInboxId: 'primary' }))));
  assert.deepEqual(cased.critical, ['senderInboxId'], 'case must not be folded away');
});

// ── K. the backfill tool ────────────────────────────────────────────────────

test('K1 — the backfill cannot write to Google Sheets, by scope', () => {
  assert.match(backfillSrc, /spreadsheets\.readonly/,
    'the authoritative store must be unreachable for writes even if the code asked');
  assert.ok(!/spreadsheets'\]/.test(backfillSrc), 'no read-write scope may be requested');
});

test('K2 — the backfill is dry-run by default and never sends', () => {
  assert.match(backfillSrc, /const APPLY = flag\('apply'\)/);
  assert.match(backfillSrc, /DRY RUN IS THE DEFAULT/);
  // Requires, not mentions: the file names outreach-agent.js in a comment
  // explaining where its projection comes from, which is documentation, not a load.
  const required = [...backfillSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  for (const name of ['outreach-agent', 'gmail', 'nodemailer', 'anthropic']) {
    assert.ok(!required.some(module => module.includes(name)),
      `the backfill must not load ${name} — it can neither send nor compose`);
  }
  assert.deepEqual(required.sort(), [
    '../integrations/outreach-state', '../integrations/supabase-mirror', 'dotenv', 'googleapis',
  ].sort(), 'the backfill loads exactly four modules, none of which can send');
});

test('K3 — the backfill projects COMPLETE rows, so nothing is skipped as partial', () => {
  assert.match(backfillSrc, /SHEET_FIELDS\.forEach\(\(field, i\) => \{ lead\[field\] = row\[i\] \|\| ''; \}\)/,
    'the projection must set every one of the 24 fields, exactly as readLeads does');
  assert.match(backfillSrc, /ColdEmail!A:X|\$\{SHEET_NAME\}!A:X/, 'it must read the full column range');
});

test('K4 — the parity report prints lead ids and field NAMES, never field values', () => {
  assert.match(backfillSrc, /Field VALUES are prospect data and are not printed/);
  assert.match(backfillSrc, /row\.fields\.join\(', '\)/, 'field names are printed');
  assert.ok(!/sheetLead\[field\]|mirroredLead\[field\]/.test(backfillSrc),
    'no comparison value may be interpolated into output');
});

// ── L. partial-row safety, end to end against a populated row (§9C) ─────────

test('L1 — a twin passed to the FULL mirror cannot blank a single populated column', async () => {
  const fake = fakeSupabase();
  const env = await fake.start();
  try {
    // A fully populated production-shaped row lands first.
    await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    const before = { ...fake.rows.get('ce-1') };
    fake.received.length = 0;

    // Now the dangerous call: the nine-field A:U projection, offered to the
    // whole-row mirror exactly as a careless call site would offer it.
    const result = await mirrorOutreachLeads([twinLead({ notes: '[REPLY: Interested]' })],
      { env, logger: quiet });

    assert.equal(result.mirrored, 0, 'nothing may be written from a partial row');
    assert.equal(result.skipped, 1);
    assert.equal(fake.received.length, 0, 'the partial row must not even reach the wire');

    // Every one of the twelve behaviour-critical omitted fields survives, plus
    // the three UI-only ones. Asserted individually so a failure names the column.
    const after = fake.rows.get('ce-1');
    for (const column of ['campaign', 'lead_niche', 'email_template_id', 'routing_required',
      'intended_campaign_version', 'site_context', 'contact_name', 'city', 'trade_type',
      'website', 'rating', 'tier', 'review_count', 'campaign_notes', 'enrichment_attempted']) {
      assert.equal(after[column], before[column],
        `${column} was omitted by the twin and must be untouched, not blanked`);
    }
    assert.deepEqual(after, before, 'the stored row must be byte-identical to before the attempt');
  } finally { await fake.stop(); }
});

test('L2 — the six fields named in the Stage 3 brief are provably unblankable', async () => {
  // campaign, leadNiche, emailTemplateId, routingRequired, intendedCampaignVersion,
  // siteContext — the brief calls these out by name, so they get their own gate.
  const named = ['campaign', 'leadNiche', 'emailTemplateId', 'routingRequired',
    'intendedCampaignVersion', 'siteContext'];
  const missing = missingFields(twinLead());
  for (const field of named) {
    assert.ok(missing.includes(field), `${field} is absent from an A:U twin`);
    assert.ok(CRITICAL_FIELDS.includes(field), `${field} is behaviour-critical`);
  }
  // And a twin carrying a blank value for one of them is STILL a complete-row
  // candidate for that field — blank is a value, absence is not. This is the
  // distinction the whole guard rests on.
  const withBlank = twinLead();
  for (const field of named) withBlank[field] = '';
  assert.equal(missingFields(withBlank).length, 9,
    'supplying the six named fields as blanks leaves only the other nine absent');
  assert.equal(isCompleteLead(withBlank), false, 'still partial — nine fields remain absent');
});

// ── M. shadow-write failure behaviour (§12) ─────────────────────────────────

test('M1 — a failed mirror never reports a false success', async () => {
  const fake = fakeSupabase({ status: 500 });
  const env = await fake.start();
  try {
    const whole = await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    assert.equal(whole.mirrored, 0, 'mirrored must count only what actually landed');
    assert.equal(whole.failed, 1);
    assert.equal(whole.attempted, 1);
    assert.notEqual(whole.reason, 'ok');

    const patch = await mirrorOutreachLeadFields('ce-1', { notes: 'x' }, { env, logger: quiet });
    assert.equal(patch.mirrored, 0);
    assert.equal(patch.failed, 1);
  } finally { await fake.stop(); }
});

test('M2 — a retry after a partially-applied 500 converges, it does not duplicate', async () => {
  // The nastiest transport case: the server APPLIED the write, then failed to
  // answer. The retry re-sends the same rows. Because lead_id is the primary key
  // and every write is an upsert, the replay converges instead of corrupting.
  let calls = 0;
  const fake = fakeSupabase({
    onRequest(req, res, body) {
      if (req.method !== 'POST') return;
      calls++;
      for (const row of JSON.parse(body || '[]')) {
        const existing = fake.rows.get(row.lead_id) || {};
        fake.rows.set(row.lead_id, { ...existing, ...row });
      }
      if (calls === 1) { res.writeHead(500); res.end(); return; }   // applied, then "failed"
      res.writeHead(201); res.end();
    },
  });
  const env = await fake.start();
  try {
    const result = await mirrorOutreachLeads([completeLead()], { env, logger: quiet });
    assert.equal(calls, 2, 'the 500 was retried');
    assert.equal(result.mirrored, 1);
    assert.equal(fake.rows.size, 1, 'the replay produced one row, not two');
    assert.equal(fake.rows.get('ce-1').campaign, 'Industrial Staffing Agency');
  } finally { await fake.stop(); }
});

test('M3 — a mirror failure cannot reach the Sheets write path', () => {
  // Structural, not behavioural: every hook sits AFTER an awaited Sheets call and
  // is itself unawaited, so a rejection has nowhere to propagate to.
  const hooks = [
    { name: 'notes patch', src: serverSrc.match(/async function writeColdEmailNotes\([\s\S]*?\n}/)[0] },
    { name: 'import', src: serverSrc.match(/if \(toAdd\.length > 0\) \{[\s\S]*?\n      \}/)[0] },
  ];
  for (const hook of hooks) {
    assert.ok(!/await mirrorOutreachLead/.test(hook.src),
      `the ${hook.name} hook must not await the mirror`);
    assert.ok(!/try\s*\{[\s\S]*mirrorOutreachLead/.test(hook.src),
      `the ${hook.name} hook needs no try/catch — the background wrapper cannot throw`);
    const sheetsCall = Math.max(hook.src.indexOf('values.update'), hook.src.indexOf('values.append'));
    assert.ok(hook.src.indexOf('mirrorOutreachLead') > sheetsCall,
      `the ${hook.name} mirror must follow the authoritative Sheets write`);
  }
});

test('M4 — mirror failure is diagnosable without leaking prospect data', async () => {
  const lines = [];
  const capture = { log() {}, warn: line => lines.push(line), error() {} };
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: SECRET };
  await mirrorOutreachLeads([completeLead()], { env, logger: capture });
  assert.ok(lines.length, 'a deferred mirror must say so');
  const text = lines.join('\n');
  assert.match(text, /Google Sheets is unaffected/, 'the log must state what is still true');
  assert.match(text, /re-run the Stage 3 backfill/i, 'and how to reconcile');
  assert.ok(!text.includes('northbridge.example'), 'no prospect address in the log');
  assert.ok(!text.includes('Dana'), 'no contact name in the log');
  assert.ok(!text.includes(SECRET), 'no credential in the log');
});

// ── N. mode-off isolation (§10, §11) ────────────────────────────────────────

test('N1 — with mode off, no hook writes anything at all', () => {
  // All three hooks are gated on the same predicate. Asserted as a count so a
  // fourth hook added without a gate fails here.
  const gated = (serverSrc + agentSrc)
    .match(/if \(outreachStateMode\(\) !== 'off'\) mirrorOutreachLead(?:s|Fields)InBackground\(/g) || [];
  const total = (serverSrc + agentSrc).match(/mirrorOutreachLead(?:s|Fields)InBackground\(/g) || [];
  assert.equal(gated.length, 3, 'all three hooks must be gated on the mode');
  assert.equal(gated.length, total.length, 'every mirror call site must be gated — no ungated hook may exist');
});

test('N2 — reads are gated more strongly than writes: nothing calls them', () => {
  // Writes are gated by a runtime predicate. Reads are gated by ABSENCE OF A
  // CALLER anywhere in the application, which no environment variable can undo.
  // That asymmetry is deliberate and is what makes "off" unable to promote
  // Supabase to authority by accident.
  const fs2 = require('node:fs');
  const readers = ['getOutreachLeadById', 'getOutreachLeadByEmail', 'batchGetOutreachLeads',
    'listOutreachLeads', 'countOutreachLeads'];
  const appFiles = [
    path.join(root, 'server.js'), path.join(root, 'outreach-agent.js'),
    ...fs2.readdirSync(path.join(root, 'integrations'))
      .filter(f => f.endsWith('.js') && f !== 'outreach-state.js')
      .map(f => path.join(root, 'integrations', f)),
  ];
  for (const file of appFiles) {
    const src = readSource(file);
    for (const reader of readers) {
      assert.ok(!src.includes(reader),
        `${path.basename(file)} must not call ${reader} — Sheets is authoritative in Stage 3`);
    }
  }
});

test('N3 — no send-eligibility, routing or sequence path can consult the mirror', () => {
  // The modules that decide whether and how to send must not even import it.
  const fs2 = require('node:fs');
  const decisionModules = [
    'campaign-routing.js', 'campaign-versions.js', 'gmail-sender-routing.js',
    'stage-sequences.js', 'automation-ownership.js', 'pipeline-state.js',
    'sending-window-quota.js', 'pipeline-sequence-safety.js', 'reply-operations.js',
    'offer-config.js', 'demo-intent-state.js', 'generic-reengagement.js',
  ].filter(f => fs2.existsSync(path.join(root, 'integrations', f)));
  assert.ok(decisionModules.length >= 10, 'the decision surface must stay discoverable');
  for (const file of decisionModules) {
    const src = readSource(path.join(root, 'integrations', file));
    assert.ok(!src.includes('outreach-state'),
      `${file} decides sending behaviour and must not import the Stage 3 mirror`);
    assert.ok(!src.includes('outreach_leads'),
      `${file} must not reference the mirror table`);
  }
});

test('N4 — the mirror introduces no additional Google Sheets read', () => {
  // The agent hook consumes `all`, which readLeads() already produced from the
  // batched cycle snapshot. Sheets quota is the binding constraint on this system,
  // so a mirror that cost a read would be a regression, not a feature.
  const hookLine = agentSrc.match(/.*mirrorOutreachLeadsInBackground\(all\).*/)[0];
  assert.ok(!/sheets\(\)|values\.get|batchGet/.test(hookLine));
  assert.match(agentSrc, /costs no extra Sheets quota/, 'the property must stay documented');

  // Nothing in the mirror module can reach Google at all.
  assert.ok(!stateSrc.includes('googleapis'), 'outreach-state must not load the Sheets client');
  assert.ok(!/sheets\(\)/.test(stateSrc));
});

// ── O. production-shaped round trips (§13) ──────────────────────────────────

// Shapes taken from the read-only production pre-flight of the live ColdEmail
// tab (1951 rows): the niches, senders, stages and tags that actually exist.
const PRODUCTION_SHAPES = {
  'dental, primary sender, contacted': {
    leadNiche: 'dental', tradeType: 'Dentist', senderInboxId: 'primary', stage: 'Contacted',
    emailStatus: 'sent', emailStep: '2', campaign: 'Ontario List',
    emailTemplateId: 'dental-v1', intendedCampaignVersion: 'dental_ai_receptionist_v3',
  },
  'staffing, secondary sender, queued': {
    leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency',
    senderInboxId: 'tryscalelabai', stage: 'Queued', emailStatus: 'queued', emailStep: '',
    campaign: 'Industrial Staffing Agency', emailTemplateId: 'industrial-staffing-employer-v1',
    routingRequired: 'true', siteContext: '3 open CDL roles posted',
  },
  'roofing, survey campaign': {
    leadNiche: 'roofing', tradeType: 'Roofer', campaign: 'BC Roofing Survey',
    stage: 'Done', emailStatus: 'sent', emailStep: '3', emailTemplateId: 'roofing-survey-v1',
  },
  'replied': { stage: 'Replied', emailStatus: 'replied', notes: '[REPLY: Interested]' },
  'no reply, never emailed': { stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '' },
  'MANUAL HOLD': { notes: '[MANUAL HOLD] paused by operator', stage: 'Contacted' },
  'unsubscribed': { stage: 'Unsubscribed', notes: '[REPLY: Unsubscribe]' },
  'imported draft, unassigned sender': {
    stage: 'Import', senderInboxId: '', emailTemplateId: '', intendedCampaignVersion: '',
    routingRequired: 'true',
  },
  'inactive/blank campaign': { campaign: '', intendedCampaignVersion: '', emailTemplateId: '' },
  'promoted to pipeline': { stage: 'Promoted', notes: '[REPLY: Interested] promoted' },
};

for (const [label, overrides] of Object.entries(PRODUCTION_SHAPES)) {
  test(`O — ${label} round-trips losslessly and compares clean`, () => {
    const lead = completeLead(overrides);
    assert.equal(describeUnmirrorable(lead), null, 'a real production shape must be mirrorable');
    const back = fromOutreachLeadRow(toOutreachLeadRow(lead));
    for (const field of SHEET_FIELDS) {
      assert.equal(back[field], lead[field], `${field} must survive unchanged`);
    }
    assert.equal(compareOutreachLead(lead, back).clean, true, 'parity must see no divergence');
  });
}

test('O11 — blank is carried as blank, never as null or the string "null"', () => {
  const lead = completeLead({
    senderInboxId: '', emailTemplateId: '', intendedCampaignVersion: '',
    campaign: '', siteContext: '', notes: '', emailStatus: '', lastEmailedAt: '', emailStep: '',
  });
  const row = toOutreachLeadRow(lead);
  for (const column of ['sender_inbox_id', 'email_template_id', 'intended_campaign_version',
    'campaign', 'site_context', 'notes', 'email_status', 'last_emailed_at', 'email_step']) {
    assert.equal(row[column], '', `${column} must be '' — an unassigned sender is not a null sender`);
    assert.notEqual(row[column], null);
  }
  // Only the DERIVED columns may be null, because null there means "no value to index".
  assert.equal(row.last_emailed_at_ts, null);
  assert.equal(row.email_step_int, null);
});
