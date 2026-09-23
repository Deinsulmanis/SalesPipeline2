'use strict';

// Sheets has no unique constraint on eventId. Reconcile a whole append against
// the canonical ledger, and never blindly retry an ambiguous multi-row write.
async function persistActivityEvents({ events, values, spreadsheetId, sheetName, header, ensureSheet,
  mirrorEvents = () => {} }) {
  if (!events?.length) return { candidates: 0, deduplicated: 0, persisted: 0 };
  await ensureSheet();
  const range = `${sheetName}!A:J`;
  const read = async () => {
    const response = await values.get({ spreadsheetId, range });
    return (response.data.values || []).slice(1).map(row =>
      Object.fromEntries(header.map((field, index) => [field, row[index] || ''])));
  };
  const existing = new Set((await read()).map(row => row.eventId));
  const pending = [];
  for (const event of events) {
    const eventId = String(event.eventId || '');
    if (!eventId) throw new Error('Activity eventId is required');
    if (existing.has(eventId)) continue;
    existing.add(eventId);
    pending.push(event);
  }
  if (!pending.length) return { candidates: events.length, deduplicated: events.length, persisted: 0 };

  let appendError = null;
  try {
    await values.append({ spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: pending.map(event => header.map(field => String(event[field] ?? ''))) } });
  } catch (error) {
    appendError = error;
  }
  // Preserve the existing shadow behavior when Sheets acknowledges the write:
  // a later readback outage must not suppress a mirror of canonical rows.
  if (!appendError) mirrorEvents(pending);

  // A failed request may have landed. One readback covers success, ambiguous
  // failure, and partial acceptance. If any row is missing, leave the observer
  // cursor untouched; the next pass can reconcile by deterministic eventId.
  const after = await read();
  const saved = new Map();
  for (const row of after) if (!saved.has(row.eventId)) saved.set(row.eventId, row);
  const missing = pending.filter(event => {
    const row = saved.get(event.eventId);
    return !row || row.eventType !== event.eventType || row.metadata !== event.metadata;
  });
  if (missing.length) {
    const error = new Error(`Activity ledger readback failed for ${missing.length} of ${pending.length} event(s)`);
    if (appendError) error.cause = appendError;
    throw error;
  }
  if (appendError) mirrorEvents(pending);
  return { candidates: events.length, deduplicated: events.length - pending.length, persisted: pending.length };
}

module.exports = { persistActivityEvents };
