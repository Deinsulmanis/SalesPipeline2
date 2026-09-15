'use strict';

// Incident repair, Phase 1 — PostgREST equality filters.
//
// Production ran with Supabase as the canonical outreach store, and every
// canonical write failed with "lead not found in Supabase": no row ever advanced
// past revision 1, and 50 sends went unrecorded. readCanonicalLead, casAttempt,
// getOutreachLeadById and getOutreachLeadByEmail all built `col=eq."<value>"`.
// PostgREST takes everything after `eq.` as the literal value — it parses quotes
// only inside in.(...) lists and logic trees — so each filter asked for an id
// that literally begins and ends with a quote character.
//
// The suite stayed green because the Stage 3F double returned the row for any
// GET, whatever the filter said. Every test here runs against a double that
// evaluates filters as PostgREST does, and the first test proves that double
// reproduces the production failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyCanonicalChange, applyLeadChange, readCanonicalLead,
  getOutreachLeadById, getOutreachLeadByEmail, batchGetOutreachLeads,
  resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const stateSrc = fs.readFileSync(path.join(root, 'integrations', 'outreach-state.js'), 'utf8')
  .split('\r\n').join('\n');
const quiet = { log() {}, warn() {}, error() {} };

const LEADS = [
  { lead_id: 'mt9ka4dnwfgdo8rlbz', email: 'info@clinic.example', stage: 'Contacted', email_status: 'emailed', email_step: '1' },
  { lead_id: 'plus-dot', email: 'First.Last+Booking@Example.com', stage: 'Contacted', email_status: 'emailed', email_step: '1' },
  // The same address without its dot: proves `.` is compared literally.
  { lead_id: 'no-dot', email: 'firstlast+booking@example.com', stage: 'Queued', email_status: '', email_step: '' },
  // The same address with a space where the + was: what an unencoded + finds.
  { lead_id: 'space', email: 'first.last booking@example.com', stage: 'Queued', email_status: '', email_step: '' },
  { lead_id: 'ce-1', email: 'dana@northbridge.example', stage: 'Contacted', email_status: 'emailed', email_step: '1' },
  { lead_id: 'ce-2', email: 'sam@northbridge.example', stage: 'Contacted', email_status: 'emailed', email_step: '1' },
];

async function withDouble(fn, { rows = LEADS, env: extraEnv = {} } = {}) {
  const db = createPostgrestDouble({ rows });
  const env = await db.start(extraEnv);
  try { return await fn(db, env); } finally { await db.stop(); }
}

async function rawGet(env, query) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_leads?${query}`,
    { headers: { apikey: env.SUPABASE_SECRET_KEY } });
  return { status: response.status, rows: await response.json() };
}

function sheetsStub() {
  const batches = [];
  return {
    batches,
    client: { spreadsheets: { values: { batchUpdate: async (args) => {
      batches.push(args.requestBody.data); return {};
    } } } },
  };
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

test('the double reproduces production: a quoted eq value matches no row', () => withDouble(async (db, env) => {
  const quoted = await rawGet(env, 'select=*&lead_id=eq."ce-1"&limit=1');
  assert.equal(quoted.status, 200);
  assert.deepEqual(quoted.rows, [],
    'PostgREST compares against the quote characters too — this is the production defect');

  const plain = await rawGet(env, 'select=*&lead_id=eq.ce-1&limit=1');
  assert.deepEqual(plain.rows.map(r => r.lead_id), ['ce-1']);

  const unencodedPlus = await rawGet(env, 'select=*&email_normalized=eq.first.last+booking@example.com');
  assert.deepEqual(unencodedPlus.rows.map(r => r.lead_id), ['space'],
    'a raw + in a query string is decoded as a space');
  const encodedPlus = await rawGet(env, 'select=*&email_normalized=eq.first.last%2Bbooking%40example.com');
  assert.deepEqual(encodedPlus.rows.map(r => r.lead_id), ['plus-dot']);
}));

test('readCanonicalLead finds the canonical row and its revision', () => withDouble(async (db, env) => {
  const result = await readCanonicalLead('mt9ka4dnwfgdo8rlbz', { env });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.lead.id, 'mt9ka4dnwfgdo8rlbz');
  assert.equal(result.lead.email, 'info@clinic.example');
  assert.equal(result.revision, 1);

  const absent = await readCanonicalLead('no-such-lead', { env });
  assert.deepEqual(absent, { ok: false, reason: 'lead not found in Supabase' },
    'a lead that genuinely is not there is still reported as absent');
}));

test('getOutreachLeadById resolves exact ids, including characters a URL must escape', () => {
  const awkward = 'CE-a b#c%d&e+f/g"h';
  return withDouble(async (db, env) => {
    const byId = await getOutreachLeadById('ce-1', { env });
    assert.equal(byId.ok, true, byId.reason);
    assert.equal(byId.lead && byId.lead.id, 'ce-1');

    const escaped = await getOutreachLeadById(awkward, { env });
    assert.equal(escaped.lead && escaped.lead.id, awkward, 'the id reaches PostgREST byte for byte');

    const prefix = await getOutreachLeadById('ce', { env });
    assert.equal(prefix.ok, true);
    assert.equal(prefix.lead, null, 'equality is exact; a prefix is not a match');
  }, { rows: [...LEADS, { lead_id: awkward, email: '' }] });
});

test('getOutreachLeadByEmail resolves addresses containing + and .', () => withDouble(async (db, env) => {
  const plusDot = await getOutreachLeadByEmail('  First.Last+Booking@Example.com ', { env });
  assert.equal(plusDot.ok, true, plusDot.reason);
  assert.equal(plusDot.lead && plusDot.lead.id, 'plus-dot', '+ must reach PostgREST as +, not as a space');

  const noDot = await getOutreachLeadByEmail('firstlast+booking@example.com', { env });
  assert.equal(noDot.lead && noDot.lead.id, 'no-dot', 'a dot is literal, not a wildcard');

  const plain = await getOutreachLeadByEmail('info@clinic.example', { env });
  assert.equal(plain.lead && plain.lead.id, 'mt9ka4dnwfgdo8rlbz');

  const absent = await getOutreachLeadByEmail('nobody@example.com', { env });
  assert.equal(absent.ok, true);
  assert.equal(absent.lead, null);
}));

test('compare-and-set lands, and the revision increments on every mutation', () => withDouble(async (db, env) => {
  const first = await applyCanonicalChange('mt9ka4dnwfgdo8rlbz',
    { emailStep: '2', lastEmailedAt: '2026-09-14T16:00:00.000Z' }, { env, logger: quiet });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.revision, 2);

  const second = await applyCanonicalChange('mt9ka4dnwfgdo8rlbz',
    { emailStatus: 'emailed', emailStep: '3' }, { env, logger: quiet });
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.revision, 3);

  const row = db.row('mt9ka4dnwfgdo8rlbz');
  assert.equal(row.revision, 3);
  assert.equal(row.email_step, '3');
  assert.equal(row.email_step_int, 3);
  assert.equal(row.last_emailed_at, '2026-09-14T16:00:00.000Z');

  const patches = db.requests.filter(r => r.method === 'PATCH');
  assert.deepEqual(patches.map(p => new Map(p.params).get('revision')), ['eq.1', 'eq.2'],
    'each write was conditioned on the revision it read');
  for (const other of db.table.values()) {
    if (other.lead_id !== 'mt9ka4dnwfgdo8rlbz') assert.equal(other.revision, 1, `${other.lead_id} was not touched`);
  }
}));

test('a stale revision matches zero rows, so a lost race is detected rather than overwritten', () => withDouble(async (db, env) => {
  let raced = false;
  db.hooks.beforeWrite = ({ method, row }) => {
    if (method !== 'PATCH' || raced) return;
    raced = true;
    Object.assign(row('ce-1'), { revision: 2, notes: 'written by another worker' });
  };
  const result = await applyCanonicalChange('ce-1', { stage: 'Done' }, { env, logger: quiet });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.conflicts, 1);
  assert.equal(result.revision, 3);
  assert.equal(db.row('ce-1').notes, 'written by another worker', "the other writer's change survived");
  assert.equal(db.row('ce-1').stage, 'Done');
}));

test('applyLeadChange under Supabase authority commits canonically, then mirrors Sheets', () => withDouble(async (db, env) => {
  const sheets = sheetsStub();
  const result = await applyLeadChange('ce-2', { emailStep: '2', emailStatus: 'emailed' }, {
    row: 9, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
  });
  assert.equal(result.ok, true);
  assert.equal(result.authority, 'supabase');
  assert.equal(result.revision, 2);
  assert.equal(result.mirrored, true);
  assert.equal(db.row('ce-2').email_step, '2');
  assert.equal(db.row('ce-2').revision, 2);
  assert.deepEqual(sheets.batches[0].map(d => d.range), ['ColdEmail!K9', 'ColdEmail!I9']);
}, { env: { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' } }));

test('no request carries a quoted equality filter, and + always travels encoded', () => withDouble(async (db, env) => {
  await readCanonicalLead('ce-1', { env });
  await getOutreachLeadById('ce-1', { env });
  await getOutreachLeadByEmail('First.Last+Booking@Example.com', { env });
  await applyCanonicalChange('ce-1', { notes: 'phase 1' }, { env, logger: quiet });

  const methods = new Set(db.requests.map(r => r.method));
  assert.ok(methods.has('GET') && methods.has('PATCH'), 'reads and the compare-and-set write were both exercised');
  for (const request of db.requests) {
    assert.ok(!request.url.includes('eq."') && !/eq\.%22/i.test(request.url),
      `quoted eq filter sent: ${request.method} ${request.url}`);
    for (const [name, value] of request.params) {
      assert.ok(!/^(not\.)?eq\."/.test(value), `${name} filter value must not begin with a quote`);
    }
  }
  const byEmail = db.requests.find(r => r.url.includes('email_normalized='));
  assert.match(byEmail.url, /email_normalized=eq\.first\.last%2Bbooking%40example\.com/);
}));

test('in.(...) batch reads are unchanged and still resolve every id', () => withDouble(async (db, env) => {
  const result = await batchGetOutreachLeads(['ce-1', 'ce-2', 'plus-dot', 'ce-1'], { env });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual([...result.byId.keys()].sort(), ['ce-1', 'ce-2', 'plus-dot']);
  assert.match(db.requests[0].url, /lead_id=in\.\(/);
}));

test('a hostile value stays one literal: it matches nothing and adds no filter term', () => withDouble(async (db, env) => {
  for (const hostile of ['ce-1","ce-2', 'ce-1&lead_id=eq.ce-2', 'ce-1&or=(lead_id.eq.ce-2)', 'ce-1,ce-2', 'ce-1#']) {
    const byId = await getOutreachLeadById(hostile, { env });
    assert.equal(byId.ok, true, byId.reason);
    assert.equal(byId.lead, null, `${JSON.stringify(hostile)} must not resolve to another lead`);
    const write = await applyCanonicalChange(hostile, { stage: 'Done' }, { env, logger: quiet });
    assert.equal(write.ok, false, 'a lead that does not exist is never written');
  }
  for (const request of db.requests) {
    const terms = request.params.map(([name]) => name).filter(name => !['select', 'limit'].includes(name));
    assert.deepEqual(terms, ['lead_id'], `exactly one filter term: ${request.url}`);
  }
  assert.ok([...db.table.values()].every(row => row.stage !== 'Done'), 'nothing was written');
}));

test('every top-level equality filter in the canonical store goes through the encoder', () => {
  assert.ok(!/=eq\.\$\{quote\(/.test(stateSrc), 'no eq filter may wrap its value in quotes');
  for (const fn of ['getOutreachLeadById', 'getOutreachLeadByEmail', 'readCanonicalLead', 'casAttempt']) {
    const start = stateSrc.indexOf(`async function ${fn}(`);
    assert.ok(start !== -1, `${fn} still exists`);
    const body = stateSrc.slice(start, stateSrc.indexOf('\n}\n', start));
    assert.match(body, /\$\{eqFilter\(/, `${fn} must encode its equality filter`);
  }
});
