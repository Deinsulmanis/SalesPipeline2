'use strict';

const { sendSuppressionReason } = require('./pipeline-state');
const { staffingSendBlockReason } = require('./staffing-launch-gate');
const { NON_COLD_STAGES } = require('./automation-ownership');
const { sendAuthorization } = require('./send-authorization');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function suppressionCode(reason) {
  if (reason === '[MANUAL HOLD]') return 'manual_hold';
  if (reason === '[REPLY: Unsubscribed]') return 'unsubscribed';
  if (String(reason || '').startsWith('[BOUNCED')) return 'bounced';
  if (reason === 'suppression-list') return 'suppressed';
  return 'suppressed';
}

function terminalReason(current, { purpose = 'cold' } = {}) {
  if (purpose === 'warm') return null;
  const status = String(current.emailStatus || '').trim().toLowerCase();
  if (status === 'replied' || status === 'done') {
    return { code: 'terminal_state', reason: `emailStatus is ${status}` };
  }
  const stage = String(current.stage || '').trim().toLowerCase();
  if (purpose === 'sequence') {
    if (stage === 'unsub' || stage === 'unsubscribed' || stage === 'done') {
      return { code: 'terminal_state', reason: `stage ${current.stage} is not sendable` };
    }
    return null;
  }
  if (NON_COLD_STAGES.includes(stage)) {
    return { code: 'terminal_state', reason: `stage ${current.stage} is not sendable` };
  }
  return null;
}

/**
 * Fresh send-safety subset shared with the warm-path last-moment revalidate.
 * PURE against already-loaded durable rows. Does not send.
 *
 * purpose:
 *   cold     — ordinary Gmail / Smartlead enqueue
 *   sequence — stage-sequence follow-up (pipeline stages may be non-cold)
 *   warm     — identity + suppression + staffing only (caller keeps extra hold/booking checks)
 */
function evaluateFreshSendSafety(lead, current, suppressedEmails, { purpose = 'cold', env = process.env } = {}) {
  if (!lead || !lead.id) {
    return { allowed: false, code: 'invalid_identity', reason: 'lead identity is missing' };
  }
  const staffing = staffingSendBlockReason(lead, env);
  if (staffing) return { allowed: false, code: 'staffing_launch_paused', reason: staffing };

  if (!current) {
    return { allowed: false, code: 'identity_changed', reason: 'lead is no longer in durable state' };
  }
  if (normalizeEmail(current.email) !== normalizeEmail(lead.email)) {
    return { allowed: false, code: 'identity_changed', reason: 'lead email changed since selection' };
  }

  const staffingNow = staffingSendBlockReason(current, env);
  if (staffingNow) return { allowed: false, code: 'staffing_launch_paused', reason: staffingNow };

  const suppressed = sendSuppressionReason(current, {
    suppressedEmails: suppressedEmails instanceof Set ? suppressedEmails : new Set(),
  });
  if (suppressed) {
    return { allowed: false, code: suppressionCode(suppressed), reason: suppressed };
  }

  const terminal = terminalReason(current, { purpose });
  if (terminal) return { allowed: false, ...terminal };

  return { allowed: true, code: '', reason: '', current };
}

async function loadFreshSendState(lead, deps) {
  if (typeof deps.loadFreshState === 'function') {
    const state = await deps.loadFreshState(lead.id);
    return {
      current: state && state.current,
      suppressedEmails: state && state.suppressedEmails,
    };
  }
  if (typeof deps.loadFreshLead !== 'function' || typeof deps.loadSuppressedEmails !== 'function') {
    throw new Error('fresh send revalidation is not configured');
  }
  const [current, suppressedEmails] = await Promise.all([
    deps.loadFreshLead(lead.id),
    deps.loadSuppressedEmails(),
  ]);
  return { current, suppressedEmails };
}

/**
 * Last-moment durable revalidation. Fail closed if the read fails.
 * Uses freshly loaded Sheets/Supabase state, never the run-start snapshot.
 */
async function revalidateFreshSendSafety(lead, deps = {}, options = {}) {
  const env = deps.env || options.env || process.env;
  try {
    const { current, suppressedEmails } = await loadFreshSendState(lead, deps);
    return evaluateFreshSendSafety(lead, current, suppressedEmails, { ...options, env });
  } catch (error) {
    return {
      allowed: false,
      code: 'revalidation_unavailable',
      reason: error.message || 'fresh send revalidation failed',
    };
  }
}

/**
 * Process authorization + staffing + last-moment durable safety, in that order.
 * Call immediately before a provider send/enqueue. Does not itself send.
 */
async function guardProviderSend(lead, deps = {}, options = {}) {
  const env = deps.env || options.env || process.env;
  const auth = sendAuthorization(env);
  if (!auth.allowed) return auth;
  return revalidateFreshSendSafety(lead, { ...deps, env }, options);
}

module.exports = {
  evaluateFreshSendSafety,
  revalidateFreshSendSafety,
  guardProviderSend,
};
