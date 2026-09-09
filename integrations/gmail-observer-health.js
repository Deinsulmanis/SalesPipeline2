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
    // A recovering mailbox must never read as simply healthy because one slice
    // succeeded: it has not reached a trustworthy observation point, and a send
    // gate that saw "healthy" would treat a partial view as proof.
    const recoveryActive = String(row[9] || '') === 'true';
    const backingOff = recoveryActive && Boolean(row[14]);
    const health = recoveryActive ? (backingOff ? 'backoff' : 'recovering')
      : (row[5] === 'healthy' && row[1] && fresh ? 'healthy' : 'unavailable');
    // Recovery in progress is a warning, not a critical: it is the system
    // working, and it is distinct from a mailbox nobody is draining.
    const severity = recoveryActive ? 'warning'
      : (!row[1] || age === null || age > CRITICAL_MINUTES || row[5] !== 'healthy'
        ? 'critical' : !fresh ? 'warning' : 'healthy');
    return { senderInboxId, historyId: row[1] || '', lastSuccessfulAt: row[2] || '',
      lastAttemptAt: row[3] || '', lastError: row[4] || '', health, severity,
      mode: row[6] || '', bootstrapState: row[7] || '', messagesObserved: Number(row[8] || 0),
      // Recovery progress, so an operator can see a backlog draining rather
      // than only "not healthy".
      recovery: recoveryActive ? {
        active: true, startedFrom: row[10] || '', target: row[11] || '',
        processedThroughId: row[12] || '', processed: Number(row[13] || 0),
        backoffUntil: row[14] || '',
      } : null,
      checkpointAgeMinutes: age === null ? null : Math.round(age),
      quotaBackoff: /429|quota|rate limit|backoff/i.test(row[4] || ''),
      cursorState: !row[1] ? 'missing' : /users.history.list.*404|404.*users.history.list|history_cursor_invalid/i.test(row[4] || '') ? 'invalid' : 'present',
      warningAfterMinutes: WARNING_MINUTES, criticalAfterMinutes: CRITICAL_MINUTES };
  });
}
module.exports = { observerHealth, WARNING_MINUTES, CRITICAL_MINUTES };
