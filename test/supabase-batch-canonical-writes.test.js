'use strict';

// Incident repair, Phase 7 — a batch mutation gets the same canonical guarantees
// as a single-lead write.
//
// applyLeadChanges wrote Google Sheets first and then upserted Supabase, whatever
// the write authority. Under Supabase authority that was a last-write-wins route
// straight around compare-and-set: no canonical read, no expected-state check, no
// revision, no conflict re-evaluation, and Sheets written before the store that
// owns the state. The Outreach queue ran through it.
//
// Now every lead of a batch is its own canonical compare-and-set with its own
// verdict — succeeded, unchanged, refused, conflict or failed — and only leads
// that committed are mirrored to Sheets, after Supabase. No transaction across
// leads is pretended.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyLeadChanges, BATCH_STATUSES, fromOutreachLeadRow, outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { MANUAL_HOLD_TAG, sendSuppressionReason } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const quiet = { log() {}, warn() {}, error() {} };
const SUPABASE = { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };

// Synthetic leads only.
function leadRow(id, overrides = {}) {
  return {
    lead_id: id, company: `Clinic ${id}`, email: `${id}@clinic.example`, stage: 'Import',
    email_status: '', email_step: '', notes: 'enriched', sender_inbox_id: '', campaign: 'Ontario List',
    ...overrides,
  };
}

const QUEUE_PATCH = Object.freeze({
  stage: 'Queued', senderInboxId: 'tryscalelabai', emailTemplateId: 'dental-guarantee-v1',
  routingRequired: 'true', intendedCampaignVersion: 'dental_v3_pay_per_booking',
});
const change = (leadId, row, extra = {}) => ({
  leadId, row, patch: { ...QUEUE_PATCH }, expectedState: { stage: 'Import', notes: 'enriched' }, ...extra,
});

/** Records each Sheets batch together with the canonical revisions at that instant. */
function sheetsRecorder(db, { fail = null } = {}) {
  const batches = [];
  return {
    batches,
    client: { spreadsheets: { values: { batchUpdate: async (args) => {
      batches.push({
        data: args.requestBody.data,
        revisions: Object.fromEntries([...db.table.values()].map(row => [row.lead_id, row.revision])),
      });
      if (fail) throw new Error(fail);
      return {};
    } } } },
  };
}

async function withDouble(rows, fn) {
  const db = createPostgrestDouble({ rows });
  const env = await db.start(SUPABASE);
  try { return await fn(db, env); } finally { await db.stop(); }
}

const verdicts = result => result.results.map(item => [item.leadId, item.status]);
const rowOf = range => Number(/!(?:[A-X])(\d+)$/.exec(range)[1]);

test.beforeEach(() => resetOutreachWriteDiagnostics());

test('every lead is its own compare-and-set, mirrored to Sheets only after Supabase committed', () =>
  withDouble([leadRow('a'), leadRow('b')], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([change('a', 2), change('b', 3)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.equal(result.ok, true);
    assert.equal(result.authority, 'supabase');
    assert.deepEqual(result.summary, { requested: 2, succeeded: 2, unchanged: 0, refused: 0, conflict: 0, failed: 0 });
    assert.deepEqual(result.results.map(item => [item.leadId, item.status, item.revision, item.mirrored]),
      [['a', 'succeeded', 2, true], ['b', 'succeeded', 2, true]]);
    for (const id of ['a', 'b']) {
      assert.equal(db.row(id).revision, 2, `${id}: revision incremented`);
      assert.equal(db.row(id).stage, 'Queued');
    }
    const cas = db.requests.filter(request => request.method === 'PATCH');
    assert.deepEqual(cas.map(request => new Map(request.params).get('revision')), ['eq.1', 'eq.1'],
      'each lead was conditioned on its own revision');
    assert.equal(db.requests.filter(request => request.method === 'POST').length, 0,
      'no upsert: nothing goes around compare-and-set');
    assert.equal(sheets.batches.length, 1, 'one Sheets batch for the whole action');
    assert.deepEqual(sheets.batches[0].revisions, { a: 2, b: 2 }, 'Supabase had committed before Sheets was written');
    const cells = Object.fromEntries(sheets.batches[0].data.map(entry => [entry.range, entry.values[0][0]]));
    assert.equal(cells['ColdEmail!H2'], 'Queued');
    assert.equal(cells['ColdEmail!U3'], 'tryscalelabai');
  }));

test('a lead whose validated state moved is refused on its own; the others still land', () =>
  withDouble([leadRow('a'), leadRow('b', { notes: '[MANUAL HOLD] enriched' }), leadRow('c')], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([change('a', 2), change('b', 3), change('c', 4)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.equal(result.ok, false, 'a partial batch is never reported as a success');
    assert.deepEqual(verdicts(result), [['a', 'succeeded'], ['b', 'refused'], ['c', 'succeeded']]);
    assert.match(result.results[1].reason, /validated lead state changed/);
    assert.equal(db.row('b').revision, 1);
    assert.equal(db.row('b').stage, 'Import');
    assert.equal(sendSuppressionReason(fromOutreachLeadRow(db.row('b'))), MANUAL_HOLD_TAG);
    assert.ok(sheets.batches[0].data.every(entry => rowOf(entry.range) !== 3), 'the refused lead is not mirrored');
    assert.equal(db.row('a').stage, 'Queued');
    assert.equal(db.row('c').stage, 'Queued');
  }));

test('a permanently contended lead is a conflict on its own; the others still land', () =>
  withDouble([leadRow('a'), leadRow('b'), leadRow('c')], async (db, env) => {
    db.hooks.beforeWrite = ({ method, row }) => { if (method === 'PATCH') row('b').revision += 1; };
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([change('a', 2), change('b', 3), change('c', 4)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.deepEqual(verdicts(result), [['a', 'succeeded'], ['b', 'conflict'], ['c', 'succeeded']]);
    assert.equal(db.row('b').stage, 'Import', 'the contended lead was not overwritten');
    assert.ok(sheets.batches[0].data.every(entry => rowOf(entry.range) !== 3));
    assert.equal(outreachWriteDiagnostics().casConflicts >= 3, true);
  }));

test('a lead missing from Supabase fails on its own, and is never written to Sheets', () =>
  withDouble([leadRow('a')], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([change('a', 2), change('ghost', 3)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.deepEqual(verdicts(result), [['a', 'succeeded'], ['ghost', 'failed']]);
    assert.match(result.results[1].reason, /not found/);
    assert.ok(sheets.batches[0].data.every(entry => rowOf(entry.range) !== 3));
  }));

test('an unsafe transition that lands mid-flight still outranks the batch', () =>
  withDouble([leadRow('a', { stage: 'Contacted', email_status: 'emailed', email_step: '1' })], async (db, env) => {
    let once = false;
    db.hooks.beforeWrite = ({ method, row }) => {
      if (method !== 'PATCH' || once) return;
      once = true;
      Object.assign(row('a'), { stage: 'Unsubscribed', revision: row('a').revision + 1 });
    };
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([{ leadId: 'a', row: 2, patch: { stage: 'Contacted', emailStep: '2' } }], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.deepEqual(verdicts(result), [['a', 'refused']]);
    assert.match(result.results[0].reason, /terminal/);
    assert.equal(db.row('a').stage, 'Unsubscribed');
    assert.equal(sheets.batches.length, 0, 'nothing committed, so nothing is mirrored');
  }));

test('a notes patch in a batch keeps canonical safety markers, and Sheets gets the kept value', () =>
  withDouble([leadRow('a', { notes: '[MANUAL HOLD] enriched' })], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const result = await applyLeadChanges([{ leadId: 'a', row: 2, patch: { notes: '[REPLY: Interested] enriched' } }], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    });
    assert.deepEqual(verdicts(result), [['a', 'succeeded']]);
    assert.deepEqual(result.results[0].keptMarkers, ['[MANUAL HOLD]']);
    assert.equal(db.row('a').notes, '[MANUAL HOLD] [REPLY: Interested] enriched');
    assert.equal(sheets.batches[0].data.find(entry => entry.range === 'ColdEmail!L2').values[0][0], db.row('a').notes);
  }));

test('retrying the same batch is idempotent: no write, no new revision, no Sheets rewrite', () =>
  withDouble([leadRow('a'), leadRow('b')], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const options = { sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet };
    await applyLeadChanges([change('a', 2), change('b', 3)], options);
    const patchesBefore = db.requests.filter(request => request.method === 'PATCH').length;
    const retry = await applyLeadChanges([change('a', 2), change('b', 3)], options);
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.summary, { requested: 2, succeeded: 0, unchanged: 2, refused: 0, conflict: 0, failed: 0 });
    assert.equal(db.requests.filter(request => request.method === 'PATCH').length, patchesBefore, 'no compare-and-set was sent');
    assert.equal(db.row('a').revision, 2);
    assert.equal(sheets.batches.length, 1, 'the retry wrote nothing to Sheets');
  }));

test('after a partial failure, a retry lands only what did not land before', () =>
  withDouble([leadRow('a'), leadRow('b', { notes: '[MANUAL HOLD] enriched' })], async (db, env) => {
    const sheets = sheetsRecorder(db);
    const options = { sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet };
    const first = await applyLeadChanges([change('a', 2), change('b', 3)], options);
    assert.deepEqual(verdicts(first), [['a', 'succeeded'], ['b', 'refused']]);
    Object.assign(db.row('b'), { notes: 'enriched', revision: db.row('b').revision + 1 });   // a human releases the hold
    const retry = await applyLeadChanges([change('a', 2), change('b', 3)], options);
    assert.deepEqual(verdicts(retry), [['a', 'unchanged'], ['b', 'succeeded']]);
    assert.equal(db.row('a').revision, 2, 'the lead that already landed was not rewritten');
    assert.equal(db.row('b').stage, 'Queued');
    assert.ok(sheets.batches[1].data.every(entry => rowOf(entry.range) === 3), 'the retry mirrors only the lead it wrote');
  }));

test('a Sheets mirror failure never rolls back committed leads', () =>
  withDouble([leadRow('a')], async (db, env) => {
    const lines = [];
    const sheets = sheetsRecorder(db, { fail: 'sheets 503' });
    const result = await applyLeadChanges([change('a', 2)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: { log() {}, error() {}, warn: line => lines.push(line) },
    });
    assert.deepEqual(result.results.map(item => [item.status, item.mirrored]), [['succeeded', false]]);
    assert.equal(result.mirrorReason, 'sheets 503');
    assert.equal(db.row('a').stage, 'Queued', 'Supabase was not rolled back');
    assert.match(lines.join(' '), /Supabase writes COMMITTED, Sheets mirror deferred/);
    assert.equal(outreachWriteDiagnostics().mirrorFailures, 1);
  }));

test('companion extraData is written only when no lead was left behind', () =>
  withDouble([leadRow('a'), leadRow('b', { notes: '[MANUAL HOLD] enriched' })], async (db, env) => {
    const extraData = [{ range: 'Leads!K7', values: [['queued']] }];
    const sheets = sheetsRecorder(db);
    const partial = await applyLeadChanges([change('a', 2), change('b', 3)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet, extraData,
    });
    assert.equal(partial.extraDataWritten, false);
    assert.ok(!sheets.batches[0].data.some(entry => entry.range === 'Leads!K7'));
    Object.assign(db.row('b'), { notes: 'enriched', revision: db.row('b').revision + 1 });
    const complete = await applyLeadChanges([change('a', 2), change('b', 3)], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet, extraData,
    });
    assert.equal(complete.extraDataWritten, true);
    assert.ok(sheets.batches[1].data.some(entry => entry.range === 'Leads!K7'));
  }));

test('every change is validated before any lead is written', () =>
  withDouble([leadRow('a')], async (db, env) => {
    const sheets = sheetsRecorder(db);
    await assert.rejects(() => applyLeadChanges([change('a', 2), { leadId: 'b', row: 3, patch: { bogus: 'x' } }], {
      sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    }), /unknown ColdEmail field/);
    assert.equal(db.requests.length, 0, 'no canonical request was made');
    assert.equal(sheets.batches.length, 0);
  }));

test('under Sheets authority the batch is still one atomic Sheets write, with a verdict per lead', async () => {
  const batches = [];
  const sheetsClient = { spreadsheets: { values: { batchUpdate: async args => { batches.push(args.requestBody.data); return {}; } } } };
  const result = await applyLeadChanges([
    { leadId: 'a', row: 2, patch: { stage: 'Queued' } },
    { leadId: 'b', row: 3, patch: { stage: 'Queued' } },
  ], { sheetsClient, spreadsheetId: 'sheet', env: {}, logger: quiet });
  assert.equal(batches.length, 1);
  assert.equal(result.authority, 'sheets');
  assert.deepEqual(result.summary, { requested: 2, succeeded: 2, unchanged: 0, refused: 0, conflict: 0, failed: 0 });
  assert.deepEqual(BATCH_STATUSES, ['succeeded', 'unchanged', 'refused', 'conflict', 'failed']);
});

test('the Supabase batch path has no Sheets-first write and no upsert', () => {
  const src = readSource('integrations/outreach-state.js');
  const fn = src.slice(src.indexOf('async function applyLeadChanges('), src.indexOf('module.exports = {'));
  const canonical = fn.slice(fn.indexOf("if (outreachWriteAuthority(env) === 'supabase')"), fn.indexOf('// ── Sheets canonical'));
  assert.ok(canonical.indexOf('applyCanonicalChange(') < canonical.indexOf('batchUpdate('),
    'the canonical compare-and-set runs before any Sheets write');
  assert.ok(!/mirrorOutreachLeadFields|upsert\(/.test(canonical), 'nothing upserts around compare-and-set');
});

// ── the Outreach queue ──────────────────────────────────────────────────────

function staffingLead(id, email) {
  return {
    id, company: `Example Staffing ${id}`, email, contactName: 'Alex', stage: 'Import', emailStatus: '',
    emailStep: '', notes: '', lastEmailedAt: '', leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name,
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, senderInboxId: 'primary', routingRequired: 'true',
    siteContext: 'Your warehouse staffing team serves local manufacturers.',
  };
}
const REQUEST = { ids: ['L1', 'L2', 'L3'], senderInboxId: 'primary',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN.id };
const LEADS = [staffingLead('L1', 'alex@example.com'), staffingLead('L2', 'jordan@example.com'), staffingLead('L3', 'sam@example.com')];

test('a queue action reports each lead\'s verdict and records activity only for leads that queued', async () => {
  const events = [];
  const result = await queueSelectedLeads(REQUEST, {
    loadState: async () => ({ leads: LEADS }), validateSelection: () => ({ ok: true }),
    applyChanges: async changes => changes.map(({ lead }) => ({
      leadId: lead.id, status: { L1: 'succeeded', L2: 'refused', L3: 'conflict' }[lead.id], reason: 'test verdict' })),
    appendActivity: async ({ lead }) => events.push(lead.id),
  });
  assert.equal(result.status, 409);
  assert.deepEqual([result.requested, result.succeeded, result.unchanged, result.refused, result.conflict, result.failed],
    [3, 1, 0, 1, 1, 0]);
  assert.deepEqual(result.queuedIds, ['L1']);
  assert.deepEqual(events, ['L1'], 'no audit event for a lead that did not queue');
  assert.match(result.error, /1 queued, 0 already queued, 2 not queued \(1 refused, 1 conflict, 0 failed\)/);
});

test('a batch that throws fails every pending lead and invents no success', async () => {
  const events = [];
  const result = await queueSelectedLeads(REQUEST, {
    loadState: async () => ({ leads: LEADS }), validateSelection: () => ({ ok: true }),
    applyChanges: async () => { throw new Error('Supabase unreachable'); },
    appendActivity: async ({ lead }) => events.push(lead.id),
  });
  assert.equal(result.failed, 3);
  assert.equal(result.queued, 0);
  assert.deepEqual(events, []);
});

test('a lead that comes back with no verdict is failed, never assumed queued', async () => {
  const result = await queueSelectedLeads(REQUEST, {
    loadState: async () => ({ leads: LEADS }), validateSelection: () => ({ ok: true }),
    applyChanges: async () => [{ leadId: 'L1', status: 'succeeded' }, { leadId: 'L2', status: 'done' }],
    appendActivity: async () => {},
  });
  assert.deepEqual(result.results.map(item => [item.leadId, item.status]), [['L1', 'succeeded'], ['L2', 'failed'], ['L3', 'failed']]);
});

test('retrying a queue after partial success sends only the leads that did not land', async () => {
  let leads = LEADS.map(lead => ({ ...lead }));
  const sent = [];
  const deps = {
    loadState: async () => ({ leads }), validateSelection: () => ({ ok: true }),
    applyChanges: async changes => changes.map(({ lead, patch }) => {
      sent.push(lead.id);
      if (lead.id === 'L2' && sent.filter(id => id === 'L2').length === 1) return { leadId: lead.id, status: 'failed', reason: 'transient' };
      leads = leads.map(item => (item.id === lead.id ? { ...item, ...patch } : item));
      return { leadId: lead.id, status: 'succeeded' };
    }),
    appendActivity: async () => {},
  };
  const first = await queueSelectedLeads(REQUEST, deps);
  assert.deepEqual([first.succeeded, first.failed], [2, 1]);
  const retry = await queueSelectedLeads(REQUEST, deps);
  assert.deepEqual(retry.results.map(item => [item.leadId, item.status]),
    [['L1', 'unchanged'], ['L3', 'unchanged'], ['L2', 'succeeded']]);
  assert.deepEqual(sent, ['L1', 'L2', 'L3', 'L2'], 'the retry resubmitted only L2');
  assert.equal(retry.status, undefined, 'a fully landed retry is a success');
});

test('the queue route mutates through applyLeadChanges with each lead\'s expected state', () => {
  const serverSrc = readSource('server.js');
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/coldemail/queue'"), serverSrc.indexOf('// The Outreach summary.'));
  assert.match(route, /applyChanges: async changes => \{/);
  assert.match(route, /applyLeadChanges\(resolvable\.map\(\(\{ lead, patch \}\) => \(\{[\s\S]*?expectedState: lead,/);
  assert.match(route, /return \[\.\.\.unresolved, \.\.\.batch\.results\];/, 'every per-lead verdict reaches the response');
  assert.ok(!/applyLeadChange\(lead\.id/.test(route), 'no single-lead write bypasses the batch path');
  assert.ok(!/findCERow\(/.test(route), 'one column read resolves every row');
});
