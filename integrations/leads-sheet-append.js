'use strict';
/**
 * leads-sheet-append.js — the one way a new card is added to the Leads board.
 *
 * values.append does not write where its range says. It searches the range for
 * a "table" and appends after that table, starting at the table's FIRST column.
 * Leads is two blocks — the card in A:Q and the call details in U:W — with R:T
 * empty on every row, so the search can settle on the U:W block. On 2026-09-25
 * a promoted card landed in U26:AQ26 with column A blank, and every reader,
 * which keys on the id in column A, skipped it.
 *
 * appendCells has no table search: it adds the row after the last row that has
 * data in ANY column, and the row's first value is column A. It inserts, so it
 * never overwrites a row another writer just added, and Sheets applies each
 * request atomically.
 *
 * Duplicate protection: a card whose id is already in column A is not appended
 * again (a retried promote, a double click), and calls in one process are
 * serialised so two concurrent requests cannot both pass that check.
 */

const COLUMN_LIMIT = 23; // A:W — the card (A:Q), agent bookkeeping (R:T), call details (U:W)

const sheetIdCache = new Map();
let queue = Promise.resolve();

function serialised(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function sheetIdFor(sheets, spreadsheetId, sheetName) {
  const key = `${spreadsheetId}|${sheetName}`;
  if (sheetIdCache.has(key)) return sheetIdCache.get(key);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const sheet = (meta.data.sheets || []).find(item => item.properties && item.properties.title === sheetName);
  if (!sheet) throw new Error(`sheet ${sheetName} not found`);
  sheetIdCache.set(key, sheet.properties.sheetId);
  return sheet.properties.sheetId;
}

async function rowsWithId(sheets, spreadsheetId, sheetName, id) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:A` });
  return (response.data.values || [])
    .map((row, index) => ({ row: index + 1, value: String((row && row[0]) || '') }))
    .filter(item => item.value === id)
    .map(item => item.row);
}

/**
 * Append one Leads row whose first value is its id, so it lands in column A.
 *
 * @param values  the row, A first; at most 23 values (A:W). Values are stored
 *                as strings, exactly as valueInputOption RAW stored them.
 * @returns { appended, duplicate, row } — row is the 1-based sheet row holding
 *          the id (the existing one when duplicate is true)
 */
function appendLeadsRow({ sheets, spreadsheetId, sheetName = 'Leads', values } = {}) {
  if (!sheets || !spreadsheetId) return Promise.reject(new Error('appendLeadsRow requires a Sheets client and spreadsheetId'));
  if (!Array.isArray(values) || !values.length) return Promise.reject(new Error('appendLeadsRow requires a row of values'));
  if (values.length > COLUMN_LIMIT) return Promise.reject(new Error(`a Leads row has at most ${COLUMN_LIMIT} values (A:W)`));
  const id = String(values[0] ?? '').trim();
  if (!id) return Promise.reject(new Error('a Leads row must start with its id (column A)'));
  return serialised(async () => {
    const existing = await rowsWithId(sheets, spreadsheetId, sheetName, id);
    if (existing.length) return { appended: false, duplicate: true, row: existing[0] };
    const sheetId = await sheetIdFor(sheets, spreadsheetId, sheetName);
    const cells = values.map(value => {
      const text = value === null || value === undefined ? '' : String(value);
      return text === '' ? {} : { userEnteredValue: { stringValue: text } };
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendCells: { sheetId, rows: [{ values: cells }], fields: 'userEnteredValue' } }] },
    });
    const rows = await rowsWithId(sheets, spreadsheetId, sheetName, id);
    return { appended: true, duplicate: false, row: rows.length ? rows[rows.length - 1] : null };
  });
}

module.exports = { appendLeadsRow, COLUMN_LIMIT };
