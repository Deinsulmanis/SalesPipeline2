'use strict';

/**
 * "Did this exact Agent v2 response already send?" — answered from Gmail's own
 * identifiers, never from the RFC Message-ID we write (Gmail replaces it on
 * send, so an rfc822msgid probe on our deterministic id never matches).
 *
 * Evidence, strongest first:
 *   1. the provider message id the durable reservation recorded when the send
 *      succeeded (status sent_unconfirmed): the message must exist, carry the
 *      SENT label, sit in the expected thread, come from our inbox and go to
 *      the lead;
 *   2. the X-ScaleLab-Action-Id header every Agent v2 send carries: a SENT
 *      message in the expected thread, after the inbound, from our inbox, whose
 *      header equals the deterministic responseActionId.
 *
 * Outcomes:
 *   SENT          proven; the caller reconciles and never sends again
 *   INCONCLUSIVE  anything else — including "nothing found". Absence of proof
 *                 is not proof of absence: a lost acknowledgment must never
 *                 become a resend. The caller hands off for reconciliation.
 */

const ACTION_HEADER = 'X-ScaleLab-Action-Id';
const norm = value => String(value || '').trim().toLowerCase();

function header(message, name) {
  const wanted = name.toLowerCase();
  return ((message?.payload?.headers) || []).find(item => String(item.name || '').toLowerCase() === wanted)?.value || '';
}
function address(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return norm(match ? match[1] : value);
}
function addresses(value) {
  return String(value || '').split(',').map(address).filter(Boolean);
}

function provenOurs(message, { threadId, senderEmail, recipientEmail }) {
  return Boolean(message && (message.labelIds || []).includes('SENT')
    && (!threadId || message.threadId === threadId)
    && address(header(message, 'From')) === norm(senderEmail)
    && addresses(header(message, 'To')).includes(norm(recipientEmail)));
}

const result = (status, extra = {}) => Object.freeze({ status, providerMessageId: null, threadId: null,
  evidence: null, reason: null, ...extra });

async function locateAgentV2Send({ gmail, actionId, reservation = null, threadId, senderEmail,
  recipientEmail, afterInternalDate = 0 } = {}) {
  if (!gmail || !actionId || !threadId || !senderEmail || !recipientEmail)
    return result('INCONCLUSIVE', { reason: 'recovery_input_missing' });
  const metadataHeaders = ['From', 'To', ACTION_HEADER];
  try {
    if (reservation?.providerMessageId) {
      const found = await gmail.users.messages.get({ userId: 'me', id: reservation.providerMessageId,
        format: 'metadata', metadataHeaders });
      if (provenOurs(found?.data, { threadId, senderEmail, recipientEmail })) {
        return result('SENT', { providerMessageId: found.data.id, threadId: found.data.threadId,
          evidence: 'reservation_provider_message_id' });
      }
      return result('INCONCLUSIVE', { reason: 'reserved_provider_message_not_ours' });
    }
    const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders });
    const after = Number(afterInternalDate) || 0;
    const ours = (thread?.data?.messages || []).filter(message => Number(message.internalDate || 0) > after
      && provenOurs({ ...message, threadId: message.threadId || threadId }, { threadId, senderEmail, recipientEmail }));
    const matching = ours.filter(message => header(message, ACTION_HEADER) === actionId);
    if (matching.length === 1) {
      return result('SENT', { providerMessageId: matching[0].id, threadId, evidence: 'action_header' });
    }
    if (matching.length > 1) return result('INCONCLUSIVE', { reason: 'multiple_matching_sends' });
    return result('INCONCLUSIVE', { reason: ours.length ? 'unlabelled_send_after_inbound' : 'no_send_found' });
  } catch (error) {
    return result('INCONCLUSIVE', { reason: `provider_lookup_failed_${Number(error?.status || error?.code) || 'error'}` });
  }
}

/**
 * Reconcile an Agent v2 send whose durable reservation is unresolved (the
 * process died after the provider call). Writes happen ONLY when Gmail proves
 * the send AND the reservation already holds that same provider message id
 * (the only state the store may confirm): the delivered activity is recorded
 * if missing, then the reservation is confirmed. Otherwise the reservation is
 * marked reconciliation_required and a human decides. Never sends.
 *
 * deps: locate() → locateAgentV2Send result; hasDelivered(); writeDelivered({ providerMessageId, threadId });
 *       confirm() → { ok }; markReconciliation(reason)
 */
async function reconcileAgentV2Send({ reservation, deps }) {
  const unresolved = code => Object.freeze({ recovered: false, code, providerMessageId: null });
  if (!reservation) return unresolved('no_reservation');
  let located;
  try { located = await deps.locate(); } catch (_) { located = result('INCONCLUSIVE', { reason: 'provider_lookup_failed' }); }
  if (located.status !== 'SENT') {
    await Promise.resolve(deps.markReconciliation(`agent_v2_recovery:${located.reason}`)).catch(() => {});
    return unresolved(located.reason || 'inconclusive');
  }
  if (!reservation.providerMessageId || reservation.providerMessageId !== located.providerMessageId) {
    await Promise.resolve(deps.markReconciliation('agent_v2_recovery:sent_but_reservation_lacks_provider_id')).catch(() => {});
    return Object.freeze({ recovered: false, code: 'sent_but_reservation_unconfirmable',
      providerMessageId: located.providerMessageId });
  }
  try {
    if (!(await deps.hasDelivered())) await deps.writeDelivered({ providerMessageId: located.providerMessageId,
      threadId: located.threadId });
  } catch (_) { return unresolved('delivered_record_failed'); }
  let confirmed;
  try { confirmed = await deps.confirm(); } catch (_) { confirmed = null; }
  if (!confirmed?.ok) return unresolved('reservation_confirm_failed');
  return Object.freeze({ recovered: true, code: 'PRIOR_PROVIDER_SEND_RECOVERED',
    providerMessageId: located.providerMessageId, evidence: located.evidence });
}

module.exports = { ACTION_HEADER, locateAgentV2Send, reconcileAgentV2Send };
