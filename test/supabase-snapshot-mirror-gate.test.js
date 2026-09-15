'use strict';

// Incident repair, Phase 2 — the agent's whole-corpus snapshot mirror.
//
// Every agent cycle re-stated every lead to Supabase from the snapshot it read at
// the start of the cycle. In dual mode that snapshot comes from Sheets — the
// truth — and re-stating it is how the mirror healed itself. In primary mode the
// snapshot comes from Supabase, so the same upsert writes cycle-start values back
// over everything committed since: a MANUAL HOLD a human applied mid-cycle is
// reverted, and because the upsert never touches `revision`, compare-and-set
// cannot detect that it happened.
//
// The snapshot now runs only in dual mode with Sheets authoritative.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  snapshotMirrorAllowed, mirrorCycleSnapshotInBackground, mirrorOutreachLeads,
  readOutreachCorpus, applyLeadChange, fromOutreachLeadRow, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
const quiet = { log() {}, warn() {}, error() {} };

const PRIMARY = { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
const DUAL = { SUPABASE_OUTREACH_MODE: 'dual', SUPABASE_OUTREACH_WRITES: 'sheets' };

/** A complete outreach_leads row. */
function leadRow(overrides = {}) {
  return {
    lead_id: 'lead-hold', company: 'Harbour Dental', contact_name: 'Dana', email: 'dana@harbour.example',
    city: 'Kingston', trade_type: 'dental', website: 'https://harbour.example', stage: 'Contacted',
    email_status: 'emailed', last_emailed_at: '2026-09-14T15:00:00.000Z', email_step: '1',
    notes: 'opened twice', review_count: '12', rating: '4.8', tier: 'A', site_context: '',
    campaign: 'Ontario List', campaign_notes: '', enrichment_attempted: 'true', lead_niche: 'dental',
    sender_inbox_id: 'tryscalelabai', email_template_id: 'dental-guarantee-v1', routing_required: 'true',
    intended_campaign_version: 'dental_v3_pay_per_booking', ...overrides,
  };
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

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for background work to reach the double, bounded. */
async function settle(predicate, ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await pause(20);
  }
  return predicate();
}

/** A cycle reads the corpus, then a human applies MANUAL HOLD before the hook runs. */
async function cycleWithMidCycleHold(env) {
  const cycleStart = await readOutreachCorpus({ env });
  assert.equal(cycleStart.ok, true, cycleStart.reason);
  const sheets = sheetsStub();
  const held = await applyLeadChange('lead-hold', { notes: '[MANUAL HOLD] opened twice' }, {
    row: 7, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
  });
  assert.equal(held.revision, 2, 'the hold committed canonically');
  return cycleStart.leads;
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

test('the snapshot mirror is allowed only in dual mode with Sheets authoritative', () => {
  const allowed = (mode, writes) => snapshotMirrorAllowed({
    SUPABASE_OUTREACH_MODE: mode, SUPABASE_OUTREACH_WRITES: writes,
  });
  assert.equal(allowed('off', 'sheets'), false);
  assert.equal(allowed('dual', 'sheets'), true, 'dual keeps its self-healing mirror');
  assert.equal(allowed('dual', 'supabase'), false, 'a Sheets snapshot must never overwrite canonical Supabase');
  assert.equal(allowed('primary', 'sheets'), false, 'a Supabase snapshot must not be written back to Supabase');
  assert.equal(allowed('primary', 'supabase'), false);
  assert.equal(snapshotMirrorAllowed({}), false, 'unset means off');
});

test('primary mode does not invoke the snapshot mirror', async () => {
  const db = createPostgrestDouble({ rows: [leadRow()] });
  const env = await db.start(PRIMARY);
  try {
    const corpus = await readOutreachCorpus({ env });
    assert.equal(corpus.ok, true, corpus.reason);
    const result = mirrorCycleSnapshotInBackground(corpus.leads, { env, logger: quiet });
    assert.equal(result.started, false);
    assert.match(result.reason, /mode=primary writes=supabase/);
    await pause(150);
    assert.equal(db.requests.filter(r => r.method === 'POST').length, 0, 'no upsert reached Supabase');
  } finally { await db.stop(); }
});

test('dual mode still invokes the snapshot mirror, and it lands', async () => {
  const db = createPostgrestDouble({ rows: [leadRow({ stage: 'Queued', email_status: '' })] });
  const env = await db.start(DUAL);
  try {
    // In dual mode the Sheets read is the truth and the mirror is behind it.
    const sheetsSnapshot = [{ ...fromOutreachLeadRow(leadRow()), _row: 7 }];
    const result = mirrorCycleSnapshotInBackground(sheetsSnapshot, { env, logger: quiet });
    assert.equal(result.started, true);
    assert.ok(await settle(() => db.row('lead-hold').stage === 'Contacted'),
      'the mirror healed from the Sheets snapshot');
    assert.equal(db.row('lead-hold').email_status, 'emailed');
    assert.equal(db.requests.filter(r => r.method === 'POST').length, 1);
  } finally { await db.stop(); }
});

test('a MANUAL HOLD applied mid-cycle is not reverted by the cycle snapshot', async () => {
  const db = createPostgrestDouble({ rows: [leadRow()] });
  const env = await db.start(PRIMARY);
  try {
    const cycleStartLeads = await cycleWithMidCycleHold(env);
    const result = mirrorCycleSnapshotInBackground(cycleStartLeads, { env, logger: quiet });
    assert.equal(result.started, false);
    await pause(150);
    const row = db.row('lead-hold');
    assert.equal(row.notes, '[MANUAL HOLD] opened twice', 'the hold stands');
    assert.equal(row.revision, 2);
    assert.equal(db.requests.filter(r => r.method === 'POST').length, 0);
  } finally { await db.stop(); }
});

test('why the gate exists: the whole-row snapshot silently reverts a newer hold', async () => {
  // Pinned deliberately. This is the lost update the gate prevents, reproduced
  // with the same upsert the agent ran every cycle in primary mode.
  const db = createPostgrestDouble({ rows: [leadRow()] });
  const env = await db.start(PRIMARY);
  try {
    const cycleStartLeads = await cycleWithMidCycleHold(env);
    await mirrorOutreachLeads(cycleStartLeads, { env, logger: quiet });
    const row = db.row('lead-hold');
    assert.equal(row.notes, 'opened twice', 'the snapshot wrote cycle-start notes back over the hold');
    assert.equal(row.revision, 2, 'and left revision untouched, so compare-and-set cannot see it');
  } finally { await db.stop(); }
});

test('the agent reaches the whole-corpus mirror only through the gated wrapper', () => {
  assert.match(agentSrc, /\n {2}mirrorCycleSnapshotInBackground\(all\);\n/,
    'the cycle hook calls the gated wrapper');
  assert.ok(!/mirrorOutreachLeadsInBackground/.test(agentSrc),
    'the ungated whole-corpus mirror must not be reachable from the agent');
  assert.ok(!/outreachStateMode\(\) !== 'off'\) mirror/.test(agentSrc),
    'the off-only gate that let primary mode snapshot must not return');
});
