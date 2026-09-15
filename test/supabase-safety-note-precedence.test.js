'use strict';

// Incident repair, Phase 3 — a safety marker in canonical notes outranks a notes
// value built from an older read.
//
// Notes are written whole. A writer reads a lead, builds its notes from that copy
// (prependNote(lead.notes, '[REPLY: …]')), and writes the result. If a human
// applied [MANUAL HOLD] after that read — or an unsubscribe or bounce landed — the
// write erased it. Compare-and-set could not catch it when the writer's own
// canonical read already saw the marker: the revision was current, only the VALUE
// was stale. Even on a conflict retry, the precedence rules refused stage and
// status changes under a hold, but a notes-only write went straight through.
//
// Now every attempt checks a notes patch against the canonical notes it replaces,
// and keeps any safety marker present there. The mutation still lands — refusing
// would drop a reply or bounce record on the floor — but it can no longer lift a
// suppression. Only Resume may remove a hold, and it has to say so.
//
//   A  MANUAL HOLD survives            B  unsubscribe survives
//   C  bounce survives                 D  Resume releases only the hold it declares
//
// Each runs twice: the marker landing BEFORE the writer's canonical read (no CAS
// conflict, attempt 1), and landing BETWEEN that read and the write (a conflict,
// caught and re-evaluated on attempt 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyLeadChange, applyCanonicalChange, readCanonicalLead, fromOutreachLeadRow,
  preserveSafetyMarkers, SAFETY_NOTE_MARKERS,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');
const {
  SEND_SUPPRESSION_TAGS, MANUAL_HOLD_TAG, sendSuppressionReason, hasManualHold, releaseHoldFromNotes,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const quiet = { log() {}, warn() {}, error() {} };
const SUPABASE = { SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
const NOTES_CELL = 'ColdEmail!L12';

function leadRow(notes) {
  return {
    lead_id: 'lead-1', company: 'Harbour Dental', email: 'owner@harbour.example',
    stage: 'Contacted', email_status: 'emailed', email_step: '1', notes,
    sender_inbox_id: 'tryscalelabai', campaign: 'Ontario List',
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

/**
 * A writer reads the lead; then `landedNotes` is committed by someone else; then
 * the writer writes notes built from its stale copy.
 *
 *   conflict=false  the change lands before the writer's canonical read
 *   conflict=true   the change lands between that read and the compare-and-set
 */
async function staleNotesWrite({
  initialNotes = 'enriched', landedNotes, write, patch = {}, conflict, releaseMarkers, resumeIntent, logger = quiet,
}) {
  const db = createPostgrestDouble({ rows: [leadRow(initialNotes)] });
  const env = await db.start(SUPABASE);
  const sheets = sheetsStub();
  try {
    const stale = await readCanonicalLead('lead-1', { env });
    assert.equal(stale.ok, true, stale.reason);

    if (conflict) {
      let landed = false;
      db.hooks.beforeWrite = ({ method, row }) => {
        if (method !== 'PATCH' || landed) return;
        landed = true;
        const current = row('lead-1');
        Object.assign(current, { notes: landedNotes, revision: current.revision + 1 });
      };
    } else {
      const landed = await applyCanonicalChange('lead-1', { notes: landedNotes }, { env, logger: quiet });
      assert.equal(landed.ok, true, landed.reason);
    }

    let result = null;
    let error = null;
    try {
      result = await applyLeadChange('lead-1', { ...patch, notes: write(stale.lead) }, {
        row: 12, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger, releaseMarkers, resumeIntent,
      });
    } catch (caught) { error = caught; }

    const canonical = fromOutreachLeadRow(db.row('lead-1'));
    const sheetsCell = sheets.batches[0] && sheets.batches[0].find(entry => entry.range === NOTES_CELL);
    return { result, error, canonical, sheetsNotes: sheetsCell ? sheetsCell.values[0][0] : null };
  } finally { await db.stop(); }
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

for (const conflict of [false, true]) {
  const when = conflict ? 'with a CAS conflict' : 'without a CAS conflict';
  const conflicts = conflict ? 1 : 0;

  test(`A (${when}) — a MANUAL HOLD survives a notes value built before it landed`, async () => {
    const { result, canonical, sheetsNotes } = await staleNotesWrite({
      conflict,
      landedNotes: '[MANUAL HOLD] enriched',
      write: stale => `[REPLY: Interested] ${stale.notes}`,
    });
    assert.equal(result.ok, true, 'the reply annotation still lands');
    assert.equal(result.conflicts, conflicts);
    assert.deepEqual(result.keptMarkers, ['[MANUAL HOLD]']);
    assert.equal(canonical.notes, '[MANUAL HOLD] [REPLY: Interested] enriched');
    assert.equal(sendSuppressionReason(canonical), MANUAL_HOLD_TAG, 'the lead is still held');
    assert.equal(sheetsNotes, canonical.notes, 'Sheets mirrors the committed notes, hold included');
  });

  test(`B (${when}) — an unsubscribe survives a notes value built before it landed`, async () => {
    const { result, canonical, sheetsNotes } = await staleNotesWrite({
      conflict,
      landedNotes: '[REPLY: Unsubscribed] enriched',
      write: stale => `[REPLY: OOO — retry in 7d] ${stale.notes}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.conflicts, conflicts);
    assert.deepEqual(result.keptMarkers, ['[REPLY: Unsubscribed]']);
    assert.equal(canonical.notes, '[REPLY: Unsubscribed] [REPLY: OOO — retry in 7d] enriched');
    assert.equal(sendSuppressionReason(canonical), '[REPLY: Unsubscribed]');
    assert.equal(sheetsNotes, canonical.notes);
  });

  test(`C (${when}) — a bounce survives, verbatim, a notes value built before it landed`, async () => {
    const { result, canonical, sheetsNotes } = await staleNotesWrite({
      conflict,
      landedNotes: '[BOUNCED: Smartlead] enriched',
      write: stale => `[REPLY: Question — draft awaiting review] ${stale.notes}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.conflicts, conflicts);
    assert.deepEqual(result.keptMarkers, ['[BOUNCED: Smartlead]'], 'the whole marker is kept, not just its prefix');
    assert.equal(canonical.notes, '[BOUNCED: Smartlead] [REPLY: Question — draft awaiting review] enriched');
    assert.equal(sendSuppressionReason(canonical), '[BOUNCED');
    assert.equal(sheetsNotes, canonical.notes);
  });

  test(`D (${when}) — Resume releases the hold it declares, and cannot lift a bounce that landed during it`, async () => {
    const held = '[MANUAL HOLD] [RESUME: 2026-09-01T00:00:00.000Z] enriched';
    const { result, canonical, sheetsNotes } = await staleNotesWrite({
      conflict,
      initialNotes: held,
      landedNotes: `[BOUNCED] ${held}`,
      write: stale => releaseHoldFromNotes(stale.notes),
      // Asking to release everything: only the hold is releasable at all.
      releaseMarkers: [MANUAL_HOLD_TAG, '[BOUNCED', '[REPLY: Unsubscribed]'],
      // Resume clears the schedule with the hold, and declares that too.
      resumeIntent: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.conflicts, conflicts);
    assert.equal(hasManualHold(canonical.notes), false, 'the declared release happened');
    assert.deepEqual(result.keptMarkers, ['[BOUNCED]']);
    assert.equal(canonical.notes, '[BOUNCED] enriched');
    assert.equal(sendSuppressionReason(canonical), '[BOUNCED', 'the lead is still suppressed');
    assert.equal(sheetsNotes, canonical.notes);
  });
}

test('D — without the declaration, a notes write cannot remove a hold', async () => {
  const { result, canonical } = await staleNotesWrite({
    conflict: false,
    initialNotes: '[MANUAL HOLD] enriched',
    landedNotes: '[MANUAL HOLD] enriched',
    write: stale => releaseHoldFromNotes(stale.notes),
  });
  assert.deepEqual(result.keptMarkers, ['[MANUAL HOLD]']);
  assert.equal(canonical.notes, '[MANUAL HOLD] enriched');
});

test('the stage and status refusal under a hold is unchanged: still refused, not merged', async () => {
  const { error, canonical } = await staleNotesWrite({
    conflict: true,
    landedNotes: '[MANUAL HOLD] enriched',
    write: stale => `[QUEUED] ${stale.notes}`,
    patch: { stage: 'Queued', emailStatus: 'queued' },
  });
  assert.ok(error, 'automation moving a lead that a human took mid-flight must still fail');
  assert.equal(error.refused, true);
  assert.match(error.message, /MANUAL HOLD/);
  assert.equal(canonical.stage, 'Contacted');
  assert.equal(canonical.notes, '[MANUAL HOLD] enriched');
});

test('a writer whose value already carries the marker writes exactly its own value', async () => {
  const { result, canonical } = await staleNotesWrite({
    conflict: false,
    initialNotes: '[MANUAL HOLD] enriched',
    landedNotes: '[MANUAL HOLD] enriched',
    write: stale => `[REPLY: Interested] ${stale.notes}`,
  });
  assert.deepEqual(result.keptMarkers, []);
  assert.equal(canonical.notes, '[REPLY: Interested] [MANUAL HOLD] enriched', 'no duplicated marker');
});

test('keeping a marker is logged and counted, naming the marker and never the notes', async () => {
  const lines = [];
  const logger = { log() {}, error() {}, warn: line => lines.push(line) };
  await staleNotesWrite({
    conflict: false,
    initialNotes: 'private enrichment detail',
    landedNotes: '[MANUAL HOLD] private enrichment detail',
    write: stale => `[REPLY: Interested] ${stale.notes}`,
    logger,
  });
  const text = lines.join('\n');
  assert.match(text, /lead lead-1: a notes write would have removed \[MANUAL HOLD\]/);
  assert.ok(!text.includes('private enrichment detail'), 'notes content is prospect data and is not logged');
  assert.equal(outreachWriteDiagnostics().safetyMarkersKept, 1);
});

test('the protected markers are exactly the send-time suppression tags', () => {
  assert.deepEqual([...SAFETY_NOTE_MARKERS], [...SEND_SUPPRESSION_TAGS],
    'a tag that stops a send must also be one a stale notes write cannot erase');
});

test('preserveSafetyMarkers is pure and releases only a hold', () => {
  assert.deepEqual(preserveSafetyMarkers('[BOUNCED - manual cleanup] a', 'b'),
    { notes: '[BOUNCED - manual cleanup] b', kept: ['[BOUNCED - manual cleanup]'] });
  assert.deepEqual(preserveSafetyMarkers('[MANUAL HOLD] a', 'a', { releaseMarkers: [MANUAL_HOLD_TAG] }),
    { notes: 'a', kept: [] });
  assert.deepEqual(preserveSafetyMarkers('[REPLY: Unsubscribed] a', '', { releaseMarkers: ['[REPLY: Unsubscribed]'] }),
    { notes: '[REPLY: Unsubscribed]', kept: ['[REPLY: Unsubscribed]'] }, 'opt-out is permanent');
  assert.deepEqual(preserveSafetyMarkers('plain', 'other'), { notes: 'other', kept: [] });
});

test('Resume is the one caller that declares a release', () => {
  const serverSrc = readSource(path.join(root, 'server.js'));
  assert.match(serverSrc,
    /async function writeResumeNotes[\s\S]*?await writeColdEmailNotes\(current\[0\], notes, \{ releaseMarkers: \[MANUAL_HOLD_TAG\], resumeIntent: true \}\);/);
  const callers = [
    ['server.js', serverSrc],
    ['outreach-agent.js', readSource(path.join(root, 'outreach-agent.js'))],
    ...fs.readdirSync(path.join(root, 'integrations'))
      .filter(file => file.endsWith('.js') && file !== 'outreach-state.js')
      .map(file => [file, readSource(path.join(root, 'integrations', file))]),
  ];
  const declarations = callers.flatMap(([file, src]) =>
    (src.match(/releaseMarkers: \[/g) || []).map(() => file));
  assert.deepEqual(declarations, ['server.js'], 'no other writer may declare a release');
});
