'use strict';

const crypto = require('node:crypto');

function responseActionId(leadId, inboundMessageId, action) {
  return `reply-action:${crypto.createHash('sha256').update([leadId, inboundMessageId, action].join('|')).digest('hex').slice(0, 32)}`;
}

function responseRfcMessageId(actionId, senderEmail) {
  const domain = String(senderEmail || '').split('@')[1];
  if (!domain) throw new Error('sender email is invalid');
  const digest = crypto.createHash('sha256').update(actionId).digest('hex').slice(0, 32);
  return `<prospect-reply-${digest}@${domain}>`;
}

async function deliverProspectReply(input, deps) {
  const { lead, sender, thread, inboundMessage, action, subject, body, checkOnly = false } = input;
  if (checkOnly) return { delivered: false, code: 'check_only' };
  if (!lead?.id || !/^\S+@\S+\.\S+$/.test(String(lead.email || ''))) return { delivered: false, code: 'invalid_identity' };
  if (!sender?.id || !sender?.email || !sender.sendEligible) return { delivered: false, code: 'sender_unproven' };
  if (!thread?.threadId || !inboundMessage?.messageId || !inboundMessage?.rfcMessageId) return { delivered: false, code: 'thread_unproven' };
  const actionId = responseActionId(lead.id, inboundMessage.messageId, action);
  const rfcMessageId = responseRfcMessageId(actionId, sender.email);
  if (await deps.existingDelivery?.(actionId)) {
    return { delivered: true, recovered: true, alreadyCheckpointed: true, actionId, rfcMessageId };
  }
  const recovered = await deps.findDelivered(rfcMessageId);
  if (recovered) {
    await deps.persistDelivered({ actionId, rfcMessageId, recovered, input, recovery: true });
    deps.consumeQuota?.({ senderId: sender.id, recovered: true });
    return { delivered: true, recovered: true, actionId, rfcMessageId, result: recovered };
  }
  const existing = await deps.existingReservation(actionId);
  if (existing?.unresolved) return { delivered: false, code: 'reservation_unresolved', actionId, rfcMessageId };
  const gate = await deps.finalRevalidate({ ...input, actionId, rfcMessageId });
  if (!gate?.allowed) return { delivered: false, code: gate?.code || 'final_gate', reason: gate?.reason || 'final revalidation refused' };
  const verified = await deps.verifyThread({ threadId: thread.threadId, senderEmail: sender.email,
    recipientEmail: lead.email, inboundMessageId: inboundMessage.messageId });
  if (!verified?.ok) return { delivered: false, code: 'thread_mismatch', reason: verified?.reason };
  const reservation = await deps.persistReservation({ actionId, rfcMessageId, input,
    attempt: Number(existing?.attempts || 0) + 1 });
  let result;
  try {
    result = await deps.sendProvider({ to: lead.email, subject, body, sender, messageId: rfcMessageId,
      threadId: thread.threadId, inReplyTo: inboundMessage.rfcMessageId, references: inboundMessage.rfcMessageId });
  } catch (error) {
    const status = Number(error?.response?.status || error?.code);
    const definite = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
    if (definite) await deps.persistFailure({ actionId, reservation, error, input });
    return { delivered: false, code: definite ? 'provider_rejected' : 'provider_ambiguous', actionId, rfcMessageId };
  }
  deps.consumeQuota?.({ senderId: sender.id, recovered: false });
  try { await deps.persistDelivered({ actionId, rfcMessageId, result, input, recovery: false }); }
  catch (error) { return { delivered: true, checkpointFailed: true, actionId, rfcMessageId, result, error }; }
  return { delivered: true, recovered: false, actionId, rfcMessageId, result };
}

module.exports = { responseActionId, responseRfcMessageId, deliverProspectReply };
