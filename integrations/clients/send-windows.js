'use strict';

// The shared Pacific scheduler remains ScaleLab's schedule. Jole's early
// Chicago slots are scheduled separately; both paths use this client clock at
// the final send boundary so a long-running worker cannot send after noon.
const { getClient } = require('./registry');

const JOLE_EARLY_CRON = '0,30 7-8 * * 1-5';
const JOLE_FIRST_HOUR = 7;
const JOLE_LAST_HOUR = 11;
const JOLE_WINDOW_MINUTES = Object.freeze([0, 30]);

function joleWallClock(now = Date.now()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: getClient('jole').timezone, weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function clientSendWindowVerdict(clientId, { now = Date.now(), scheduledClientScope = '' } = {}) {
  if (scheduledClientScope && clientId !== scheduledClientScope) return { allowed: false, reason: 'scheduled run is scoped to another client' };
  if (clientId !== 'jole') return { allowed: true };
  const clock = joleWallClock(now);
  if (!clock || !['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)
    || clock.hour < JOLE_FIRST_HOUR || clock.hour > JOLE_LAST_HOUR) {
    return { allowed: false, reason: 'outside Jole America/Chicago weekday 07:00-11:59 send window' };
  }
  return { allowed: true };
}

module.exports = { JOLE_EARLY_CRON, JOLE_WINDOW_MINUTES, joleWallClock, clientSendWindowVerdict };
