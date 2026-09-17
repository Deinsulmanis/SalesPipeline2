'use strict';

// Stage 3 Phase A — the canonical mutation abstraction.
//
// Every live operational ColdEmail write now goes through applyLeadChange() or
// applyLeadChanges(). What has to stay true of them:
//
//   * they write EXACTLY the cells the patch names, so a narrow mutation stays
//     narrow — this is the property the MANUAL HOLD and stage-change safety
//     tests depend on
//   * Sheets is authoritative, so a Sheets failure throws, unchanged
//   * a mirror failure never undoes, blocks or disguises a committed mutation
//   * a bad field name is refused BEFORE anything is written
//   * atomicity that spans sheets is preserved in one batch
//   * mode off means no mirror traffic at all
//
// No live Supabase project and no Google client: a local http server stands in
// for PostgREST and the Sheets client is a recording stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  applyLeadChange, applyLeadChanges, columnLetterFor, SHEET_FIELDS,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
const quiet = { log() {}, warn() {}, error() {} };
const OFF = {};                                    // no SUPABASE_* -> mirror disabled

/** Records what would have been written; never touches Google. */
function sheetsStub({ fail = null, notesByRange = {} } = {}) {
  const batches = [];
  const notes = { ...notesByRange };
  return {
    batches,
    notes,
    get ranges() { return batches.flat().map(entry => entry.range); },
    client: {
      spreadsheets: {
        values: {
          get: async ({ range }) => ({ data: { values: [[notes[range] || '']] } }),
          batchGet: async ({ ranges }) => ({
            data: { valueRanges: ranges.map(range => ({ range, values: [[notes[range] || '']] })) },
          }),
          batchUpdate: async (args) => {
            if (fail) throw new Error(fail);
            batches.push(args.requestBody.data);
            for (const entry of args.requestBody.data) {
              if (/!L\d+$/.test(entry.range)) notes[entry.range] = entry.values[0][0];
            }
            return {};
          },
        },
      },
    },
  };
}

function fakeSupabase({ status = 201 } = {}) {
  const received = [];
  const rows = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, body });
      if (req.method === 'POST') {
        for (const row of JSON.parse(body || '[]')) {
          rows.set(row.lead_id, { ...(rows.get(row.lead_id) || {}), ...row });
        }
        res.writeHead(status); res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]');
    });
  });
  return {
    received, rows,
    async start() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
        SUPABASE_SECRET_KEY: SECRET, SUPABASE_OUTREACH_MODE: 'dual' };
    },
    async stop() { await new Promise(r => server.close(r)); },
  };
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

// ── narrowness ──────────────────────────────────────────────────────────────

test('writes exactly the cells the patch names, and nothing else', async () => {
  const sheets = sheetsStub();
  await applyLeadChange('ce-1', { stage: 'Contacted' },
    { row: 42, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet });
  assert.deepEqual(sheets.ranges, ['ColdEmail!H42'], 'a one-field patch writes one cell');
  assert.deepEqual(sheets.batches[0][0].values, [['Contacted']]);
});

test('every ColdEmail field maps to its real sheet column', () => {
  // A:X in CE_COLUMNS order. If this drifts, a mutation silently lands in the
  // wrong column — the single most dangerous failure this abstraction could have.
  const expected = {
    id: 'A', company: 'B', contactName: 'C', email: 'D', city: 'E', tradeType: 'F',
    website: 'G', stage: 'H', emailStatus: 'I', lastEmailedAt: 'J', emailStep: 'K',
    notes: 'L', reviewCount: 'M', rating: 'N', tier: 'O', siteContext: 'P',
    campaign: 'Q', campaign_notes: 'R', enrichment_attempted: 'S', leadNiche: 'T',
    senderInboxId: 'U', emailTemplateId: 'V', routingRequired: 'W',
    intendedCampaignVersion: 'X',
  };
  assert.equal(Object.keys(expected).length, SHEET_FIELDS.length);
  for (const [field, letter] of Object.entries(expected)) {
    assert.equal(columnLetterFor(field), letter, `${field} must write column ${letter}`);
  }
});

test('a multi-field patch writes one cell per field, in one batch', async () => {
  const sheets = sheetsStub();
  await applyLeadChange('ce-1', { stage: 'Done', emailStatus: 'done', emailStep: '3' },
    { row: 7, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet });
  assert.equal(sheets.batches.length, 1, 'one batch, so the transition stays atomic');
  assert.deepEqual(sheets.ranges, ['ColdEmail!H7', 'ColdEmail!I7', 'ColdEmail!K7']);
});

test('atomicity spanning sheets is preserved in the same batch', async () => {
  // A contact change must land the new address and its MANUAL HOLD together, or
  // an intermediate state could mail the new address.
  const sheets = sheetsStub();
  await applyLeadChange('ce-1', { email: 'new@x.test', notes: '[MANUAL HOLD]' }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet,
    extraData: [{ range: 'Leads!K9', values: [['new@x.test']] }],
  });
  assert.equal(sheets.batches.length, 1, 'one batch across both sheets');
  assert.deepEqual(sheets.ranges, ['ColdEmail!D5', 'ColdEmail!L5', 'Leads!K9']);
});

test('null and undefined are written as empty, never as the string "null"', async () => {
  const sheets = sheetsStub();
  await applyLeadChange('ce-1', { notes: null, senderInboxId: undefined },
    { row: 3, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet });
  assert.deepEqual(sheets.batches[0].map(e => e.values[0][0]), ['', '']);
});

// ── refusal before any write ────────────────────────────────────────────────

test('an unknown field is refused BEFORE anything reaches the sheet', async () => {
  const sheets = sheetsStub();
  await assert.rejects(
    () => applyLeadChange('ce-1', { stage: 'Done', nope: 'x' },
      { row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet }),
    /unknown ColdEmail field/);
  assert.equal(sheets.batches.length, 0,
    'a typo must not half-apply a mutation — nothing may be written');
});

test('a missing lead id, row or client is refused', async () => {
  const sheets = sheetsStub();
  const ok = { row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet };
  await assert.rejects(() => applyLeadChange('', { stage: 'x' }, ok), /requires a lead id/);
  await assert.rejects(() => applyLeadChange('ce-1', { stage: 'x' },
    { ...ok, row: undefined }), /resolved sheet row/);
  await assert.rejects(() => applyLeadChange('ce-1', { stage: 'x' },
    { ...ok, sheetsClient: null }), /requires a Sheets client/);
  await assert.rejects(() => applyLeadChange('ce-1', {}, ok), /at least one field/);
  assert.equal(sheets.batches.length, 0);
});

// ── Sheets is authoritative ─────────────────────────────────────────────────

test('a Sheets failure throws, exactly as every call site expects', async () => {
  const sheets = sheetsStub({ fail: 'quota exceeded' });
  await assert.rejects(
    () => applyLeadChange('ce-1', { stage: 'Done' },
      { row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet }),
    /quota exceeded/);
  assert.equal(outreachWriteDiagnostics().mutations, 0,
    'a failed write is not counted as a mutation');
});

test('the mirror never runs when the authoritative write failed', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub({ fail: 'sheets down' });
    await assert.rejects(() => applyLeadChange('ce-1', { stage: 'Done' },
      { row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet }));
    assert.equal(supabase.received.length, 0,
      'Supabase must never hold state Sheets refused to accept');
  } finally { await supabase.stop(); }
});

// ── mirror currency and failure ─────────────────────────────────────────────

test('a successful mutation brings the mirror current in the same call', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub();
    const result = await applyLeadChange('ce-1', { stage: 'Replied', emailStatus: 'replied' },
      { row: 9, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet });
    assert.equal(result.ok, true);
    assert.equal(result.mirrored, true, 'awaited, so a read cutover can rely on read-your-writes');
    const row = supabase.rows.get('ce-1');
    assert.equal(row.stage, 'Replied');
    assert.equal(row.email_status, 'replied');
    // Narrow in, narrow out: the mirror was told about two columns, not twenty-four.
    const sent = JSON.parse(supabase.received[0].body)[0];
    assert.ok(!('campaign' in sent), 'a patch must not mention fields it did not change');
    assert.ok(!('sender_inbox_id' in sent));
  } finally { await supabase.stop(); }
});

test('a mirror failure leaves the mutation committed and says so plainly', async () => {
  const supabase = fakeSupabase({ status: 500 });
  const env = await supabase.start();
  const lines = [];
  try {
    const sheets = sheetsStub();
    const result = await applyLeadChange('ce-1', { stage: 'Done' }, {
      row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env,
      logger: { log() {}, warn: l => lines.push(l), error() {} },
    });
    assert.equal(result.ok, true, 'the operational action is committed — Sheets accepted it');
    assert.equal(result.mirrored, false, 'and is NOT reported as current in Supabase');
    assert.equal(sheets.batches.length, 1, 'the Sheets write stands');
    const text = lines.join(' ');
    assert.match(text, /Sheets write COMMITTED, mirror deferred/);
    assert.match(text, /Google Sheets remains authoritative/);
    assert.match(text, /re-run the Stage 3 backfill/);
    const diagnostics = outreachWriteDiagnostics();
    assert.equal(diagnostics.mutations, 1);
    assert.equal(diagnostics.mirrorFailures, 1);
    assert.ok(diagnostics.lastMirrorFailureReason);
  } finally { await supabase.stop(); }
});

test('a retried mutation converges instead of duplicating', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub();
    const opts = { row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet };
    await applyLeadChange('ce-1', { stage: 'Done' }, opts);
    await applyLeadChange('ce-1', { stage: 'Done' }, opts);
    assert.equal(supabase.rows.size, 1, 'lead_id is the primary key');
    assert.equal(supabase.rows.get('ce-1').stage, 'Done');
  } finally { await supabase.stop(); }
});

test('with mode off there is no mirror traffic at all', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub();
    const result = await applyLeadChange('ce-1', { stage: 'Done' }, {
      row: 1, sheetsClient: sheets.client, spreadsheetId: 'sheet', logger: quiet,
      env: { ...env, SUPABASE_OUTREACH_MODE: 'off' },
    });
    assert.equal(result.mirrored, false);
    assert.equal(result.mirrorReason, 'skipped');
    assert.equal(supabase.received.length, 0, 'mode off means Supabase is not contacted');
    assert.equal(sheets.batches.length, 1, 'but the authoritative write still happens');
  } finally { await supabase.stop(); }
});

// ── the bulk form ───────────────────────────────────────────────────────────

test('applyLeadChanges writes many leads in ONE batch', async () => {
  const sheets = sheetsStub();
  await applyLeadChanges([
    { leadId: 'a', row: 2, patch: { stage: 'Queued', senderInboxId: 'primary' } },
    { leadId: 'b', row: 3, patch: { stage: 'Queued', senderInboxId: 'primary' } },
  ], { sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet });
  assert.equal(sheets.batches.length, 1,
    'queueing selected leads is one user action and must stay one write');
  assert.deepEqual(sheets.ranges,
    ['ColdEmail!H2', 'ColdEmail!U2', 'ColdEmail!H3', 'ColdEmail!U3']);
});

test('applyLeadChanges refuses a bad field before writing any lead', async () => {
  const sheets = sheetsStub();
  await assert.rejects(() => applyLeadChanges([
    { leadId: 'a', row: 2, patch: { stage: 'Queued' } },
    { leadId: 'b', row: 3, patch: { bogus: 'x' } },
  ], { sheetsClient: sheets.client, spreadsheetId: 'sheet', env: OFF, logger: quiet }),
  /unknown ColdEmail field/);
  assert.equal(sheets.batches.length, 0, 'one bad entry must not half-apply the batch');
});

test('applyLeadChanges mirrors every lead it wrote', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub();
    const result = await applyLeadChanges([
      { leadId: 'a', row: 2, patch: { stage: 'Queued' } },
      { leadId: 'b', row: 3, patch: { stage: 'Queued' } },
    ], { sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet });
    assert.equal(result.count, 2);
    assert.equal(result.mirrored, 2);
    assert.equal(supabase.rows.size, 2);
  } finally { await supabase.stop(); }
});

// ── diagnostics ─────────────────────────────────────────────────────────────

test('write diagnostics are bounded and carry no field values', async () => {
  const supabase = fakeSupabase();
  const env = await supabase.start();
  try {
    const sheets = sheetsStub();
    for (let i = 0; i < 40; i++) {
      await applyLeadChange(`ce-${i}`, { notes: 'a prospect-specific note' },
        { row: i + 2, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet });
    }
    const diagnostics = outreachWriteDiagnostics();
    assert.equal(diagnostics.mutations, 40);
    assert.equal(diagnostics.mirrored, 40);
    assert.ok(diagnostics.recent.length <= 20, 'diagnostics must stay bounded');
    const text = JSON.stringify(diagnostics);
    assert.match(text, /notes/, 'the field NAME is recorded');
    assert.ok(!text.includes('a prospect-specific note'), 'the VALUE must never be');
    assert.ok(!text.includes(SECRET), 'no credential');
  } finally { await supabase.stop(); }
});
