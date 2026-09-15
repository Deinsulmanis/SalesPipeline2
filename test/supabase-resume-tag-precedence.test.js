'use strict';

// Incident repair, Phase 7 — a stale notes value cannot resurrect, move or erase
// a scheduled resume.
//
// [RESUME: <ISO>] beside [MANUAL HOLD] schedules a held lead's cold automation to
// resume at that instant. A writer that read the lead while a resume was
// scheduled builds its notes from that copy. If a human cancelled the schedule in
// the meantime, the write put the tag back — and once the instant has passed the
// hold is released, so automation resumes on a lead the human meant to keep held.
// The inverse erased a schedule a human set after the writer's read.
//
// Now a notes write keeps the canonical resume tag unless it declares
// resumeIntent. Reactivation (schedule, cancel) and Resume are the only callers
// that declare it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyLeadChange, readCanonicalLead, preserveResumeTag, fromOutreachLeadRow,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');
const {
  MANUAL_HOLD_TAG, sendSuppressionReason, applyResumeToNotes, clearResumeFromNotes, releaseHoldFromNotes,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const quiet = { log() {}, warn() {}, error() {} };
const SUPABASE = { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
const PAST = '2026-09-01T00:00:00.000Z';     // an instant that has passed: the tag releases the hold
const FUTURE = '2099-01-01T00:00:00.000Z';
const NOTES_CELL = 'ColdEmail!L5';

/**
 * A writer reads the lead; a human then changes the resume schedule (declared);
 * then the writer writes notes built from its stale copy (undeclared).
 *   conflict=false  the human change lands before the writer's canonical read
 *   conflict=true   it lands between that read and the compare-and-set
 */
async function staleWrite({ initialNotes, human, stale, conflict }) {
  const db = createPostgrestDouble({ rows: [{
    lead_id: 'held-1', company: 'Harbour Dental', email: 'owner@harbour.example',
    stage: 'Contacted', email_status: 'emailed', email_step: '1', notes: initialNotes,
  }] });
  const env = await db.start(SUPABASE);
  const batches = [];
  const sheetsClient = { spreadsheets: { values: { batchUpdate: async args => { batches.push(args.requestBody.data); return {}; } } } };
  const options = { row: 5, sheetsClient, spreadsheetId: 'sheet', env, logger: quiet };
  try {
    const read = await readCanonicalLead('held-1', { env });
    assert.equal(read.ok, true, read.reason);
    if (conflict) {
      let landed = false;
      db.hooks.beforeWrite = ({ method, row }) => {
        if (method !== 'PATCH' || landed) return;
        landed = true;
        const current = row('held-1');
        Object.assign(current, { notes: human(current.notes), revision: current.revision + 1 });
      };
    } else {
      await applyLeadChange('held-1', { notes: human(read.lead.notes) }, { ...options, resumeIntent: true });
    }
    const result = await applyLeadChange('held-1', { notes: stale(read.lead.notes) }, options);
    const canonical = fromOutreachLeadRow(db.row('held-1'));
    const cell = batches.at(-1).find(entry => entry.range === NOTES_CELL);
    return { result, canonical, mirroredNotes: cell ? cell.values[0][0] : null };
  } finally { await db.stop(); }
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

test('preserveResumeTag keeps exactly the canonical tag', () => {
  const tag = `[RESUME: ${FUTURE}]`;
  assert.deepEqual(preserveResumeTag(`${tag} a`, `${tag} b`), { notes: `${tag} b`, changed: false });
  assert.deepEqual(preserveResumeTag('a', `${tag} b`), { notes: 'b', changed: true }, 'a removed tag is not re-added');
  assert.deepEqual(preserveResumeTag(`${tag} a`, 'b'), { notes: `${tag} b`, changed: true }, 'a set tag is not erased');
  assert.deepEqual(preserveResumeTag(`${tag} a`, `[RESUME: ${PAST}] b`), { notes: `${tag} b`, changed: true },
    'a moved schedule is not moved back');
  assert.deepEqual(preserveResumeTag('a', 'b'), { notes: 'b', changed: false });
});

for (const conflict of [false, true]) {
  const when = conflict ? 'with a CAS conflict' : 'without a CAS conflict';

  test(`(${when}) a stale write cannot resurrect a resume a human cancelled`, async () => {
    const scheduled = applyResumeToNotes(`${MANUAL_HOLD_TAG} enriched`, PAST);
    const stale = notes => `[REPLY: OOO — retry in 7d] ${notes}`;
    assert.equal(sendSuppressionReason({ notes: stale(scheduled) }), null,
      'pinned hazard: the stale value on its own releases the hold');
    const { result, canonical, mirroredNotes } = await staleWrite({
      conflict, initialNotes: scheduled, human: clearResumeFromNotes, stale,
    });
    assert.equal(result.ok, true, 'the annotation still lands');
    assert.equal(result.resumeTagKept, true);
    assert.equal(canonical.notes, `[REPLY: OOO — retry in 7d] ${MANUAL_HOLD_TAG} enriched`);
    assert.equal(sendSuppressionReason(canonical), MANUAL_HOLD_TAG, 'the lead stays held');
    assert.equal(mirroredNotes, canonical.notes, 'Sheets mirrors the committed notes');
  });

  test(`(${when}) a stale write cannot erase a resume a human scheduled after its read`, async () => {
    const { result, canonical, mirroredNotes } = await staleWrite({
      conflict, initialNotes: `${MANUAL_HOLD_TAG} enriched`,
      human: notes => applyResumeToNotes(notes, FUTURE),
      stale: notes => `[REPLY: OOO — retry in 7d] ${notes}`,
    });
    assert.equal(result.resumeTagKept, true);
    assert.equal(canonical.notes, `[RESUME: ${FUTURE}] [REPLY: OOO — retry in 7d] ${MANUAL_HOLD_TAG} enriched`);
    assert.equal(mirroredNotes, canonical.notes);
  });
}

test('reactivation still schedules, moves and cancels a resume, because it declares it', async () => {
  const db = createPostgrestDouble({ rows: [{ lead_id: 'held-2', email: 'x@harbour.example', notes: `${MANUAL_HOLD_TAG} enriched` }] });
  const env = await db.start(SUPABASE);
  const sheetsClient = { spreadsheets: { values: { batchUpdate: async () => ({}) } } };
  const write = async notes => applyLeadChange('held-2', { notes }, {
    row: 6, sheetsClient, spreadsheetId: 'sheet', env, logger: quiet, resumeIntent: true });
  try {
    const scheduled = await write(applyResumeToNotes(db.row('held-2').notes, FUTURE));
    assert.equal(scheduled.resumeTagKept, false);
    assert.match(db.row('held-2').notes, new RegExp(`\\[RESUME: ${FUTURE}\\]`));
    await write(applyResumeToNotes(db.row('held-2').notes, PAST));
    assert.match(db.row('held-2').notes, new RegExp(`\\[RESUME: ${PAST}\\]`));
    await write(clearResumeFromNotes(db.row('held-2').notes));
    assert.equal(db.row('held-2').notes, `${MANUAL_HOLD_TAG} enriched`);
    assert.equal(outreachWriteDiagnostics().resumeTagsKept, 0);
  } finally { await db.stop(); }
});

test('Resume releases the hold and its schedule together, as declared', async () => {
  const db = createPostgrestDouble({ rows: [{ lead_id: 'held-3', email: 'y@harbour.example',
    notes: applyResumeToNotes(`${MANUAL_HOLD_TAG} enriched`, FUTURE) }] });
  const env = await db.start(SUPABASE);
  const sheetsClient = { spreadsheets: { values: { batchUpdate: async () => ({}) } } };
  try {
    await applyLeadChange('held-3', { notes: releaseHoldFromNotes(db.row('held-3').notes) }, {
      row: 7, sheetsClient, spreadsheetId: 'sheet', env, logger: quiet,
      releaseMarkers: [MANUAL_HOLD_TAG], resumeIntent: true,
    });
    assert.equal(db.row('held-3').notes, 'enriched');
  } finally { await db.stop(); }
});

test('an undeclared write that carries the canonical tag unchanged is untouched and not logged', async () => {
  const lines = [];
  const scheduled = applyResumeToNotes(`${MANUAL_HOLD_TAG} enriched`, FUTURE);
  const { result, canonical } = await staleWrite({
    conflict: false, initialNotes: scheduled, human: notes => notes,
    stale: notes => `[REPLY: OOO — retry in 7d] ${notes}`,
  });
  assert.equal(result.resumeTagKept, false);
  assert.equal(canonical.notes, `[REPLY: OOO — retry in 7d] ${scheduled}`);
  assert.deepEqual(lines, []);
});

test('only reactivation and Resume declare resume intent', () => {
  const serverSrc = readSource('server.js');
  const sources = [
    ['server.js', serverSrc],
    ['outreach-agent.js', readSource('outreach-agent.js')],
    ...fs.readdirSync(path.join(root, 'integrations'))
      .filter(file => file.endsWith('.js') && file !== 'outreach-state.js')
      .map(file => [file, readSource(path.join('integrations', file))]),
  ];
  const declarations = sources.flatMap(([file, src]) => (src.match(/resumeIntent: true/g) || []).map(() => file));
  assert.deepEqual(declarations, ['server.js', 'server.js', 'server.js'], 'cancel, schedule and Resume — nothing else');
  assert.match(serverSrc, /await writeColdEmailNotes\(twin, cleared, \{ resumeIntent: true \}\);/);
  assert.match(serverSrc, /await writeColdEmailNotes\(twin, scheduled, \{ resumeIntent: true \}\);/);
  assert.match(serverSrc, /releaseMarkers: \[MANUAL_HOLD_TAG\], resumeIntent: true \}\);/);
  const writer = serverSrc.slice(serverSrc.indexOf('async function writeColdEmailNotes'),
    serverSrc.indexOf('async function recordReactivationEvent'));
  assert.match(writer, /releaseMarkers, resumeIntent,/, 'the notes writer passes the declaration through');
});
