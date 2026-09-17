'use strict';

const DEFAULT_MAX_AGE_MINUTES = Number(process.env.GMAIL_OBSERVER_FOLLOWUP_MAX_AGE_MINUTES || 45);

function classifyOutboundTouch(lead = {}) {
  const step = Number.parseInt(lead.emailStep || '0', 10);
  const status = String(lead.emailStatus || '').trim().toLowerCase();
  const emailedAt = String(lead.lastEmailedAt || '').trim();
  if (Number.isFinite(step) && step >= 1) return 'follow_up';
  if ((step === 0 || !Number.isFinite(step) || step < 1) && !emailedAt && status === '') return 'first_touch';
  return 'unknown';
}

function observerIsFresh(observer = {}, { now = new Date(), maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES } = {}) {
  const health = String(observer.health || '');
  if (health === 'backoff' || health === 'recovering' || health === 'unavailable') return false;
  const age = observer.checkpointAgeMinutes;
  if (age === null || age === undefined || !Number.isFinite(Number(age))) return false;
  if (health !== 'healthy') return false;
  return Number(age) <= Number(maxAgeMinutes);
}

function observerFollowUpVerdict({
  lead = {}, observer = null, now = new Date(),
  maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES,
} = {}) {
  const kind = classifyOutboundTouch(lead);
  const fresh = observerIsFresh(observer || {}, { now, maxAgeMinutes });
  if (fresh) return { allowed: true, kind, code: 'observer_healthy', reason: 'mailbox observer is fresh' };
  if (kind === 'first_touch') {
    return {
      allowed: true, kind, code: 'first_touch_allowed_observer_stale',
      reason: 'first-touch safety does not depend on detecting a previous reply',
    };
  }
  if (kind === 'follow_up') {
    return {
      allowed: false, kind, code: 'observer_stale_followup', blockedFollowUp: true,
      reason: `automated follow-up blocked — mailbox observer is older than ${maxAgeMinutes} minutes or unhealthy`,
    };
  }
  return {
    allowed: false, kind, code: 'observer_stale_unclassified',
    reason: 'cannot distinguish first-touch from follow-up while the mailbox observer is unhealthy — failing closed',
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MINUTES, classifyOutboundTouch, observerIsFresh, observerFollowUpVerdict,
};
