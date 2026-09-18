'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyLeadChange, applyLeadChanges, mergeNotesPatch,
  preserveSafetyMarkers, outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');
const { MANUAL_HOLD_TAG, applyResumeToNotes, releaseHoldFromNotes } = require('../integrations/pipeline-state');

const quiet = { log() {}, warn() {}, error() {} };
const SHEETS = {};
const FUTURE = '2099-01-01T00:00:00.000Z';

function sheetsStore(initialNotes = '') {
  const notes = { 'ColdEmail!L5': initialNotes };
  const batches = [];
  return {
    batches,
    notes,
    writtenNotes() {
      const last = batches.at(-1) || [];
      const cell = last.find(entry => entry.range === 'ColdEmail!L5');
      return cell ? cell.values[0][0] : notes['ColdEmail!L5'];
    },
    client: {
      spreadsheets: {
        values: {
          get: async ({ range }) => ({ data: { values: [[notes[range] || '']] } }),
          batchGet: async ({ ranges }) => ({
            data: { valueRanges: ranges.map(range => ({ range, values: [[notes[range] || '']] })) },
          }),
          batchUpdate: async (args) => {
            batches.push(args.requestBody.data);
            for (const entry of args.requestBody.data) {
              if (Object.prototype.hasOwnProperty.call(notes, entry.range) || /!L\d+$/.test(entry.range)) {
                notes[entry.range] = entry.values[0][0];
              }
            }
            return {};
          },
        },
      },
    },
  };
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

test('C. a stale agent Notes prepend cannot remove a newer MANUAL HOLD', async () => {
  const sheets = sheetsStore('enriched');
  sheets.notes['ColdEmail!L5'] = '[MANUAL HOLD] operator paused';
  const staleAgentNotes = 'enriched';
  const result = await applyLeadChange('lead-1', { notes: `[REPLY: Interested] ${staleAgentNotes}` }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
  });
  assert.match(sheets.writtenNotes(), /\[MANUAL HOLD\]/);
  assert.match(sheets.writtenNotes(), /\[REPLY: Interested\]/);
  assert.deepEqual(result.keptMarkers, ['[MANUAL HOLD]']);
  assert.equal(outreachWriteDiagnostics().safetyMarkersKept, 1);
});

test('a stale Notes write cannot remove an unsubscribe marker', async () => {
  const sheets = sheetsStore('[REPLY: Unsubscribed] prior');
  await applyLeadChange('lead-1', { notes: '[REPLY: Interested] prior' }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
  });
  assert.match(sheets.writtenNotes(), /\[REPLY: Unsubscribed\]/);
});

test('a stale Notes write cannot remove a bounce marker', async () => {
  const sheets = sheetsStore('[BOUNCED - manual cleanup] prior');
  await applyLeadChange('lead-1', { notes: '[REPLY: Interested] prior' }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
  });
  assert.match(sheets.writtenNotes(), /\[BOUNCED - manual cleanup\]/);
});

test('G. Resume releaseMarkers still removes only the hold', async () => {
  const held = `${MANUAL_HOLD_TAG} [REPLY: Unsubscribed] operator`;
  const sheets = sheetsStore(held);
  await applyLeadChange('lead-1', { notes: releaseHoldFromNotes(held) }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
    releaseMarkers: [MANUAL_HOLD_TAG], resumeIntent: true,
  });
  assert.equal(sheets.writtenNotes().includes(MANUAL_HOLD_TAG), false);
  assert.match(sheets.writtenNotes(), /\[REPLY: Unsubscribed\]/);
});

test('a notes write without resumeIntent keeps the canonical resume tag', async () => {
  const scheduled = applyResumeToNotes(MANUAL_HOLD_TAG, FUTURE);
  const sheets = sheetsStore(scheduled);
  await applyLeadChange('lead-1', { notes: MANUAL_HOLD_TAG }, {
    row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
  });
  assert.match(sheets.writtenNotes(), /\[RESUME:/);
  assert.match(sheets.writtenNotes(), /\[MANUAL HOLD\]/);
  assert.equal(outreachWriteDiagnostics().resumeTagsKept, 1);
});

test('applyLeadChanges preserves a hold across a stale batch notes write', async () => {
  const sheets = sheetsStore();
  sheets.notes['ColdEmail!L2'] = '[MANUAL HOLD] row two';
  sheets.notes['ColdEmail!L3'] = 'plain';
  await applyLeadChanges([
    { leadId: 'a', row: 2, patch: { notes: '[REPLY: Interested] row two' } },
    { leadId: 'b', row: 3, patch: { notes: '[REPLY: Interested] plain' } },
  ], { sheetsClient: sheets.client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet });
  assert.match(sheets.notes['ColdEmail!L2'], /\[MANUAL HOLD\]/);
  assert.equal(sheets.notes['ColdEmail!L3'], '[REPLY: Interested] plain');
});

test('a notes read failure refuses the write instead of clobbering markers', async () => {
  const client = {
    spreadsheets: {
      values: {
        get: async () => { throw new Error('quota exceeded'); },
        batchUpdate: async () => assert.fail('must not write notes when the canonical cell cannot be read'),
      },
    },
  };
  await assert.rejects(
    () => applyLeadChange('lead-1', { notes: 'stale' }, {
      row: 5, sheetsClient: client, spreadsheetId: 'sheet', env: SHEETS, logger: quiet,
    }),
    /cannot read current notes/,
  );
});

test('mergeNotesPatch matches the existing preserve helpers', () => {
  assert.deepEqual(
    mergeNotesPatch('[MANUAL HOLD] a', '[REPLY: Interested] a'),
    { notes: '[MANUAL HOLD] [REPLY: Interested] a', kept: ['[MANUAL HOLD]'], resumeTagKept: false },
  );
  assert.deepEqual(
    preserveSafetyMarkers('[MANUAL HOLD] a', 'a', { releaseMarkers: [MANUAL_HOLD_TAG] }),
    { notes: 'a', kept: [] },
  );
});
