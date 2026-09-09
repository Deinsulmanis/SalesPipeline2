'use strict';
const WARNING_MINUTES = 45;
const CRITICAL_MINUTES = 90;

function observerHealth(rows = [], { senderIds = [], now = new Date() } = {}) {
  const byId = new Map(rows.slice(1).map(row => [String(row[0]), row]));
  return [...new Set([...senderIds, ...byId.keys()])].map(senderInboxId => {
    const row = byId.get(senderInboxId) || [];
    const ms = Date.parse(row[2] || '');
    const age = Number.isFinite(ms) ? Math.max(0, (new Date(now).getTime() - ms) / 60000) : null;
    const fresh = age !== null && age <= WARNING_MINUTES;
    const health = row[5] === 'healthy' && row[1] && fresh ? 'healthy' : 'unavailable';
    const severity = !row[1] || age === null || age > CRITICAL_MINUTES || row[5] !== 'healthy'
      ? 'critical' : !fresh ? 'warning' : 'healthy';
    return { senderInboxId, historyId: row[1] || '', lastSuccessfulAt: row[2] || '',
      lastAttemptAt: row[3] || '', lastError: row[4] || '', health, severity,
      mode: row[6] || '', bootstrapState: row[7] || '', messagesObserved: Number(row[8] || 0),
      checkpointAgeMinutes: age === null ? null : Math.round(age),
      quotaBackoff: /429|quota|rate limit|backoff/i.test(row[4] || ''),
      cursorState: !row[1] ? 'missing' : /users.history.list.*404|404.*users.history.list|history_cursor_invalid/i.test(row[4] || '') ? 'invalid' : 'present',
      warningAfterMinutes: WARNING_MINUTES, criticalAfterMinutes: CRITICAL_MINUTES };
  });
}
module.exports = { observerHealth, WARNING_MINUTES, CRITICAL_MINUTES };
