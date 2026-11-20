'use strict';

// Calendar-day keys ("2026-11-18") in a named time zone.
//
// `date.toLocaleDateString('en-CA', { timeZone })` builds a new Intl formatter
// on every call (~0.1 ms each). Over a 25,000-row activity log that was seconds
// of every dashboard snapshot. One formatter per zone gives the same string.
const formatters = new Map();

function dayFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Exactly `new Date(value).toLocaleDateString('en-CA', { timeZone })`,
 * including 'Invalid Date' for a value that does not parse. Callers that
 * guarded invalid input before keep their own guard.
 */
function calendarDay(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return dayFormatter(timeZone).format(date);
}

module.exports = { calendarDay };
