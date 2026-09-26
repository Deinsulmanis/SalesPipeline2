'use strict';

// New Leads cards must land in A:W.
//
// Production, 2026-09-25: a manually promoted Hot card was written with
// values.append to Leads!A:W and landed in U26:AQ26, column A blank. The board
// is two blocks — card fields A:Q and call details U:W — with R:T empty on
// every row, and values.append positions a row by searching the range for a
// "table", which settled on the U:W block. Every reader keys on column A, so
// the card was invisible. appendLeadsRow uses appendCells instead: after the
// last row with data in any column, first value in column A, insert-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendLeadsRow, COLUMN_LIMIT } = require('../integrations/leads-sheet-append');

const COLUMNS = ['id', 'type', 'first', 'last', 'brokerage', 'tradeType', 'company', 'city', 'cityTrade', 'phone',
  'email', 'website', 'stage', 'priority', 'followup', 'notes', 'created'];
const col = letter => letter.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// A Sheets stand-in with appendCells' documented semantics. values.append is
// deliberately absent: calling it is the defect under test.
function fakeSheets(rows, { title = 'Leads', sheetId = 7, onGet = null } = {}) {
  const grid = rows.map(row => [...row]);
  const calls = [];
  const hasData = row => (row || []).some(value => value !== '' && value !== undefined && value !== null);
  const lastDataRow = () => { for (let i = grid.length - 1; i >= 0; i--) if (hasData(grid[i])) return i + 1; return 0; };
  const client = {
    grid, calls,
    spreadsheets: {
      get: async () => { calls.push('get'); return { data: { sheets: [{ properties: { sheetId: 1, title: 'ColdEmail' } }, { properties: { sheetId, title } }] } }; },
      values: {
        get: async ({ range }) => {
          calls.push(`values.get ${range}`);
          assert.equal(range, `${title}!A:A`);
          if (onGet) await onGet();
          const colA = grid.map(row => (row && row[0] ? [row[0]] : []));
          let last = colA.length; while (last > 0 && !colA[last - 1].length) last--;
          return { data: { values: colA.slice(0, last) } };
        },
        append: async () => { throw new Error('values.append must never write a Leads row'); },
      },
      batchUpdate: async ({ requestBody }) => {
        calls.push('batchUpdate');
        for (const request of requestBody.requests) {
          const append = request.appendCells;
          assert.ok(append, 'only appendCells may write a Leads row');
          assert.equal(append.sheetId, sheetId);
          assert.equal(append.fields, 'userEnteredValue');
          const at = lastDataRow();
          grid[at] = append.rows[0].values.map(cell => (cell.userEnteredValue ? cell.userEnteredValue.stringValue : ''));
        }
        return { data: {} };
      },
    },
  };
  return client;
}

const row = (cells = {}) => { const out = []; for (const [letter, value] of Object.entries(cells)) out[col(letter)] = value; return Array.from(out, v => v ?? ''); };
const cardCells = (id, extra = {}) => Object.fromEntries(COLUMNS.map((field, i) => [String.fromCharCode(65 + i), extra[field] ?? `${field}-${id}`]).concat([['A', id]]));

// The production layout: header A:Q, cards in A:Q, call details in U:W, R:T
// empty on every row, and a last row carrying U (a meeting time).
function productionShapedSheet() {
  return [
    row(Object.fromEntries(COLUMNS.map((field, i) => [String.fromCharCode(65 + i), field]))),
    row(cardCells('mq3i5pbt1quywgesayc')),
    row({ ...cardCells('CE-ms3k32h4eb7laipistw'), W: 'waiting on her to reply' }),
    row({ ...cardCells('ms75rn6f2fjit7scfuz'), V: 'ghosted' }),
    row({ ...cardCells('CE-mt9ka4dnusqarqbva3'), U: '2026-09-02T00:30:00.000Z', V: 'ghosted' }),
    row({ ...cardCells('CE-mt9ka4dnwfgdo8rlbz'), U: '2026-09-14T22:30:00.000Z' }),
  ];
}

// What POST /api/coldemail/:id/promote and the calendar sync write: 17 card
// fields, R:T blank, then meetingAt / outcome / conversationContext.
const promoteRow = id => [...COLUMNS.map(field => (field === 'id' ? id : field === 'stage' ? 'hot' : `${field}-x`)), '', '', '', '', '', 'context'];
// What automatic positive-reply promotion (outreach-agent.js) writes: A:Q only.
const positiveReplyRow = id => COLUMNS.map(field => (field === 'id' ? id : field === 'stage' ? 'hot' : `${field}-y`));

function assertLandsInA(sheets, rowNumber, values) {
  const written = sheets.grid[rowNumber - 1];
  assert.equal(written[0], values[0], 'column A carries the id');
  assert.equal(written.length, values.length, `exactly ${values.length} cells`);
  assert.ok(written.length <= 23, 'nothing lands beyond W');
  values.forEach((value, i) => assert.equal(written[i], value, `cell ${i}`));
}

test('manual promote on a sparse sheet (empty R:T, data in A:Q and U:W) lands 23 values in A:W of the next row', async () => {
  const sheets = fakeSheets(productionShapedSheet());
  const values = promoteRow('CE-mu5sratzhkzhrw3yv8');
  assert.equal(values.length, 23);
  const result = await appendLeadsRow({ sheets, spreadsheetId: 's', values });
  assert.deepEqual(result, { appended: true, duplicate: false, row: 7 });
  assertLandsInA(sheets, 7, values);
  assert.equal(sheets.grid[6][col('W')], 'context', 'call details land in U:W, not beyond');
  assert.ok(!sheets.calls.some(call => call.startsWith('values.append')));
});

test('positive-reply promotion lands its 17 card fields in A:Q', async () => {
  const sheets = fakeSheets(productionShapedSheet());
  const values = positiveReplyRow('CE-newpositive');
  const result = await appendLeadsRow({ sheets, spreadsheetId: 's', values });
  assert.equal(result.row, 7);
  assertLandsInA(sheets, 7, values);
});

test('a row whose data sits only beyond column T is never overwritten; the new card goes after it, in A', async () => {
  const sheets = fakeSheets([...productionShapedSheet(), row({ U: 'CE-misplaced', V: 'trade', W: 'Jorge' })]);
  const result = await appendLeadsRow({ sheets, spreadsheetId: 's', values: promoteRow('CE-after') });
  assert.equal(result.row, 8);
  assert.equal(sheets.grid[6][col('U')], 'CE-misplaced', 'the existing row is untouched');
  assertLandsInA(sheets, 8, promoteRow('CE-after'));
});

test('a retried append of an existing card is a no-op that reports the existing row', async () => {
  const sheets = fakeSheets(productionShapedSheet());
  const first = await appendLeadsRow({ sheets, spreadsheetId: 's', values: promoteRow('CE-retry') });
  const second = await appendLeadsRow({ sheets, spreadsheetId: 's', values: promoteRow('CE-retry') });
  assert.deepEqual(second, { appended: false, duplicate: true, row: first.row });
  assert.equal(sheets.grid.filter(r => r[0] === 'CE-retry').length, 1);
  assert.equal(sheets.calls.filter(call => call === 'batchUpdate').length, 1);
});

test('concurrent promotions of the same card in one process write it once', async () => {
  const sheets = fakeSheets(productionShapedSheet(), { onGet: () => new Promise(resolve => setImmediate(resolve)) });
  const results = await Promise.all([1, 2, 3].map(() => appendLeadsRow({ sheets, spreadsheetId: 's', values: promoteRow('CE-double-click') })));
  assert.equal(results.filter(r => r.appended).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 2);
  assert.equal(sheets.grid.filter(r => r[0] === 'CE-double-click').length, 1);
});

test('concurrent promotions of different cards each land in A on their own row', async () => {
  const sheets = fakeSheets(productionShapedSheet(), { onGet: () => new Promise(resolve => setImmediate(resolve)) });
  const [a, b] = await Promise.all([
    appendLeadsRow({ sheets, spreadsheetId: 's', values: promoteRow('CE-a') }),
    appendLeadsRow({ sheets, spreadsheetId: 's', values: positiveReplyRow('CE-b') }),
  ]);
  assert.notEqual(a.row, b.row);
  assertLandsInA(sheets, a.row, promoteRow('CE-a'));
  assertLandsInA(sheets, b.row, positiveReplyRow('CE-b'));
});

test('values are stored as strings and blanks stay empty cells', async () => {
  const sheets = fakeSheets(productionShapedSheet());
  let request;
  const original = sheets.spreadsheets.batchUpdate;
  sheets.spreadsheets.batchUpdate = async args => { request = args.requestBody.requests[0].appendCells; return original(args); };
  await appendLeadsRow({ sheets, spreadsheetId: 's', values: ['CE-s', '', null, undefined, 42] });
  assert.deepEqual(request.rows[0].values, [{ userEnteredValue: { stringValue: 'CE-s' } }, {}, {}, {}, { userEnteredValue: { stringValue: '42' } }]);
});

test('a row must start with its id and fit A:W', async () => {
  const sheets = fakeSheets(productionShapedSheet());
  await assert.rejects(appendLeadsRow({ sheets, spreadsheetId: 's', values: ['', 'trade'] }), /start with its id/);
  await assert.rejects(appendLeadsRow({ sheets, spreadsheetId: 's', values: Array(COLUMN_LIMIT + 1).fill('x') }), /at most 23/);
  assert.equal(sheets.calls.filter(call => call === 'batchUpdate').length, 0);
});

// Every Leads writer uses the helper; none positions a row by table search.
test('manual promote, calendar booking, dashboard create and positive-reply promotion all write through appendLeadsRow', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\r\n').join('\n');
  const server = read('server.js');
  const agent = read('outreach-agent.js');
  const promote = server.slice(server.indexOf("app.post('/api/coldemail/:id/promote'"), server.indexOf('// ── OUTREACH PROVIDER INTEGRATION'));
  assert.match(promote, /appendLeadsRow\(\{ sheets: sheets\(\), spreadsheetId: SPREADSHEET_ID, sheetName: SHEET_NAME,\n\s+values: \[\.\.\.COLUMNS\.map/);
  const calendar = server.slice(server.indexOf('async function applyCalendarPlanItem'), server.indexOf('async function applyCalendarPlanItem') + 6000);
  assert.match(calendar, /appendLeadsRow\(/);
  const create = server.slice(server.indexOf("app.post('/api/leads'"), server.indexOf("app.post('/api/leads'") + 1500);
  assert.match(create, /appendLeadsRow\(/);
  const positive = agent.slice(agent.indexOf('async function upsertColdCallLeadFromEvent'), agent.indexOf('// ── AUTH (same pattern as server.js)'));
  assert.match(positive, /appendLeadsRow\(\{ sheets: sheets\(\), spreadsheetId: SPREADSHEET_ID, sheetName: LEADS_SHEET,/);
  for (const [name, source] of [['server.js', server], ['outreach-agent.js', agent]]) {
    const appends = [...source.matchAll(/values\.append\(\{[\s\S]{0,200}?range:\s*([^,\n]+)/g)].map(m => m[1].trim());
    for (const range of appends) {
      assert.ok(!/^(?:AGENT_READ_RANGE|COL_RANGE|LEADS_RANGE|`\$\{(?:SHEET_NAME|LEADS_SHEET)\}!|'Leads!)/.test(range),
        `${name} still appends a Leads row with values.append (${range})`);
    }
  }
});
