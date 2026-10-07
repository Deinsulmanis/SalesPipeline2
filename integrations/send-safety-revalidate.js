'use strict';

const { sendSuppressionReason } = require('./pipeline-state');
const { staffingSendBlockReason } = require('./staffing-launch-gate');
const { NON_COLD_STAGES } = require('./automation-ownership');
const { sendAuthorization } = require('./send-authorization');
const { checkClientConsistency, resolveLeadClient } = require('./clients/ownership');
const { clientSendBlock } = require('./clients/send-policy');
const { evaluateScopedSuppression } = require('./clients/suppression');
const { outreachBlockForLead } = require('./lead-archive');
const { providerVerdict, coldDeliveryVerdict } = require('./cold-delivery-policy');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function suppressionCode(reason) {
  if (reason === '[MANUAL HOLD]') return 'manual_hold';
  if (reason === '[REPLY: Unsubscribed]') return 'unsubscribed';
  if (reason === '[REPLY: Not Interested]') return 'not_interested';
  if (String(reason || '').startsWith('[BOUNCED')) return 'bounced';
  if (String(reason || '').startsWith('[ARCHIVED')) return 'archived';
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
function evaluateFreshSendSafety(lead, current, suppressedEmails, {
  purpose = 'cold', env = process.env, senderInboxId = '', senders, clientSuppression,
} = {}) {
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

  // Client isolation on the row as it is NOW, plus the sender about to send:
  // lead == campaign == template == sender, or no send. Never repaired here.
  let owner;
  try {
    owner = checkClientConsistency({ lead: current, senderInboxId, senders });
  } catch (error) {
    return { allowed: false, code: 'client_ownership_unavailable', reason: error.message || 'client ownership could not be resolved' };
  }
  if (!owner.ok) return { allowed: false, code: owner.code, reason: owner.reason };
  const clientBlocked = clientSendBlock(owner.clientId, env);
  if (clientBlocked) return { allowed: false, code: clientBlocked.code, reason: clientBlocked.reason, clientId: owner.clientId };

  // Global suppression first — the existing verdict, codes unchanged — then
  // the client's own exclusions.
  const suppressed = sendSuppressionReason(current, {
    suppressedEmails: suppressedEmails instanceof Set ? suppressedEmails : new Set(),
  });
  if (suppressed) {
    return { allowed: false, code: suppressionCode(suppressed), reason: suppressed };
  }
  const scoped = evaluateScopedSuppression(current, { clientId: owner.clientId, suppressedEmails: new Set(), clientEntries: clientSuppression });
  if (scoped) return { allowed: false, code: scoped.code, reason: scoped.reason, clientId: owner.clientId };

  const terminal = terminalReason(current, { purpose });
  if (terminal) return { allowed: false, ...terminal };

  // Archived leads and retired offers, for EVERY purpose — cold, sequence and
  // warm alike — as the last word before an allow. Asked of the row as it is
  // now and of the selected snapshot, so neither a stale selection nor a
  // restore that raced this send can pass. (An archive marker is already a
  // suppression above, coded 'archived'; this also covers the archived stage
  // on a warm send, which skips the terminal check.) A retired offer stays
  // blocked after a restore: this never reads the archive to decide the offer.
  const blocked = outreachBlockForLead(current) || outreachBlockForLead(lead);
  if (blocked) return { allowed: false, code: blocked.code, reason: blocked.reason };

  return { allowed: true, code: '', reason: '', current, clientId: owner.clientId };
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
    // The client's exclusions for the fresh row. A loader that fails reports
    // { available: false, error }, which refuses the send.
    let clientSuppression;
    const owner = current ? resolveLeadClient(current) : null;
    if (owner?.ok && typeof deps.loadClientSuppression === 'function') {
      clientSuppression = await deps.loadClientSuppression(owner.clientId, current);
    }
    return evaluateFreshSendSafety(lead, current, suppressedEmails, {
      ...options, env, senders: deps.senders || options.senders, clientSuppression,
    });
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
  const safety = await revalidateFreshSendSafety(lead, { ...deps, env }, options);
  if (!safety.allowed || options.purpose !== 'cold') return safety;
  return coldDeliveryGate(lead, deps, options, env, safety);
}

/**
 * Temporary recipient-provider policy (cold-delivery-policy.js) as the last
 * word on every cold send or enqueue. The classification comes from the
 * caller's classifier (normally a cache read); none, or a failure, is UNKNOWN
 * and refuses under google_only. When the Gmail sender is named it must also
 * be send-eligible and in the Gmail-healthy pool.
 */
async function coldDeliveryGate(lead, deps, options, env, safety) {
  let classification = null;
  try {
    classification = typeof deps.classifyRecipient === 'function' ? await deps.classifyRecipient(lead.email) : null;
  } catch (_) { classification = null; }
  const verdict = options.coldSender
    ? coldDeliveryVerdict({ sender: options.coldSender, classification, env })
    : providerVerdict(classification, env);
  if (!verdict.allowed) {
    return { allowed: false, code: verdict.code, reason: verdict.reason, layer: verdict.layer || 'recipient',
      provider: verdict.provider, domain: classification?.domain || '' };
  }
  return safety;
}

module.exports = {
  evaluateFreshSendSafety,
  revalidateFreshSendSafety,
  guardProviderSend,
};
