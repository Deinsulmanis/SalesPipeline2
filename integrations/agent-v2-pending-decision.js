'use strict';

const { responseActionId } = require('./prospect-reply-delivery');

const PENDING_EVENT = 'reply_decision_pending_execution';
const PENDING_VERSION = 'reply_decision_pending_execution_v1';
const PENDING_STATUS = 'pending_execution';
const QUALIFY_ACTION = 'AUTO_STAFFING_QUALIFY_QUESTION';
const QUALIFICATION_CLASSES = new Set(['INTERESTED', 'STAFFING_QUALIFICATION']);

function metadata(row) {
  try { return typeof row?.metadata === 'object' ? row.metadata : JSON.parse(row?.metadata || '{}'); }
  catch { return {}; }
}

function pendingEventId(leadId, messageId) {
  return `reply-decision-pending:${leadId}:${messageId}`;
}

function providerProof(sourceRow, lead, message) {
  const source = metadata(sourceRow);
  if (!lead?.id || !message?.messageId || !message.threadId || !message.rfcMessageId
    || !message.senderInboxId || sourceRow?.eventId !== `gmail-reply:${message.messageId}`
    || sourceRow?.sourceLeadId !== lead.id || sourceRow?.eventType !== 'positive_reply'
    || String(sourceRow.email || '').trim().toLowerCase() !== String(lead.email || '').trim().toLowerCase()
    || source.provider !== 'gmail' || source.gmailMessageId !== message.messageId
    || source.gmailThreadId !== message.threadId || source.rfcMessageId !== message.rfcMessageId
    || source.senderInboxId !== message.senderInboxId || source.genuineHuman !== true
    || source.recoveredDuringOutage !== false || source.responsePending !== true)
    return null;
  return { version: PENDING_VERSION, provider: 'gmail', sourceEventId: sourceRow.eventId,
    leadId: lead.id, messageId: message.messageId, threadId: message.threadId,
    rfcMessageId: message.rfcMessageId, senderInboxId: message.senderInboxId,
    genuineHuman: true };
}

function pendingDecisionActivity({ lead, message, decision, sourceRow } = {}) {
  const proof = providerProof(sourceRow, lead, message);
  if (!proof || decision?.leadId !== lead.id || decision.inboundMessageId !== message.messageId
    || !QUALIFICATION_CLASSES.has(decision.finalClassification)
    || decision.policyAction !== QUALIFY_ACTION || decision.policySend !== true)
    return null;
  return {
    eventId: pendingEventId(lead.id, message.messageId),
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: lead.company || '', eventType: PENDING_EVENT,
    occurredAt: new Date().toISOString(), subject: '', content: '',
    metadata: JSON.stringify({ version: PENDING_VERSION, decisionId: decision.decisionId,
      leadId: lead.id, inboundMessageId: message.messageId,
      finalClassification: decision.finalClassification,
      policyAction: decision.policyAction, policySend: true,
      executionStatus: PENDING_STATUS, providerProof: proof }),
  };
}

function pendingDecisionFor(activities = [], messageId = '', leadId = '') {
  const id = pendingEventId(leadId, messageId);
  const rows = activities.filter(row => row?.eventId === id && row.eventType === PENDING_EVENT);
  if (rows.length !== 1) return null;
  const pending = metadata(rows[0]);
  if (pending.version !== PENDING_VERSION || pending.leadId !== leadId
    || pending.inboundMessageId !== messageId || pending.executionStatus !== PENDING_STATUS
    || !QUALIFICATION_CLASSES.has(pending.finalClassification)
    || pending.policyAction !== QUALIFY_ACTION || pending.policySend !== true)
    return null;
  const proof = pending.providerProof;
  const sources = activities.filter(row => row?.eventId === `gmail-reply:${messageId}`);
  if (sources.length !== 1 || !proof || typeof proof !== 'object') return null;
  const verified = providerProof(sources[0], { id: leadId, email: rows[0].email }, {
    messageId, threadId: proof.threadId, rfcMessageId: proof.rfcMessageId,
    senderInboxId: proof.senderInboxId,
  });
  if (!verified || JSON.stringify(verified) !== JSON.stringify(proof)) return null;
  return pending;
}

function pendingProofMatches(state, target) {
  const decision = target?.decision;
  const proof = decision?.providerProof;
  return Boolean(decision?.status === PENDING_STATUS && decision.executionStatus === PENDING_STATUS
    && decision.policyAction === QUALIFY_ACTION && decision.policySend === true
    && QUALIFICATION_CLASSES.has(decision.finalClassification)
    && proof?.version === PENDING_VERSION && proof.provider === 'gmail'
    && proof.genuineHuman === true && proof.leadId === state?.identity?.leadId
    && proof.messageId === target.messageId && proof.threadId === target.threadId
    && proof.senderInboxId === target.senderInboxId
    && typeof proof.rfcMessageId === 'string' && proof.rfcMessageId.length > 0
    && proof.sourceEventId === `gmail-reply:${target.messageId}`
    && target.sourceEventIds?.includes(proof.sourceEventId)
    && target.genuineHuman === true && !target.automatedReply);
}

function confirmedQualificationActivity(activities = [], leadId = '', messageId = '', senderInboxId = '') {
  if (!leadId || !messageId || !senderInboxId) return null;
  const id = responseActionId(leadId, messageId, QUALIFY_ACTION);
  const rows = activities.filter(row => row?.eventId === id);
  if (rows.length !== 1 || rows[0].eventType !== 'booking_link_sent'
    || rows[0].sourceLeadId !== leadId) return null;
  const proof = metadata(rows[0]);
  return proof.actionId === id && proof.action === QUALIFY_ACTION
    && proof.inboundMessageId === messageId && proof.senderInboxId === senderInboxId
    && typeof proof.gmailMessageId === 'string' && proof.gmailMessageId.length > 0
    ? rows[0] : null;
}

module.exports = { PENDING_EVENT, PENDING_VERSION, PENDING_STATUS, QUALIFY_ACTION,
  pendingEventId, providerProof, pendingDecisionActivity, pendingDecisionFor,
  pendingProofMatches, confirmedQualificationActivity };
