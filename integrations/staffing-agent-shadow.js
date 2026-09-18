'use strict';

/**
 * Phase 1 shadow observer for the staffing conversation agent.
 *
 * This module records a recommendation beside existing reply handling. It has
 * no send, CRM, suppression, queue, campaign, or booking authority. Callers
 * must ignore the returned recommendation for routing.
 */

const { isStaffingCampaign } = require('./staffing-campaign');
const { LEGACY_REPLY_EVENT_TYPES } = require('./canonical-reply');
const { deterministicReplyCategory } = require('./reply-classifier');
const { decideReplyResponse } = require('./reply-response-policy');
const { offerForLead } = require('./offer-config');
const { buildStaffingAgentContext } = require('./staffing-agent-context');
const { runStaffingConversationAgent } = require('./staffing-conversation-agent');
const {
  EVENT_TYPE, AGENT_VERSION, PROMPT_VERSION, OPERATION, MODEL,
  ZERO_AUTHORITY, shadowEventId, staffingConversationAgentConfig,
  staffingAgentApiKey, failClosedResult, broadlyAgree,
} = require('./staffing-agent-schema');

const REPLY_EVENT_SET = new Set(LEGACY_REPLY_EVENT_TYPES);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function existingShadow(activities = [], messageId) {
  const eventId = shadowEventId(messageId);
  if (!eventId) return null;
  return activities.find(row => String(row.eventId || '') === eventId
    || (row.eventType === EVENT_TYPE && parseMetadata(row.metadata).gmailMessageId === String(messageId))) || null;
}

function observableProductionAction(lead, classification, replyText) {
  try {
    const offer = offerForLead(lead);
    return decideReplyResponse({ classification, offer, text: replyText }).action || '';
  } catch (_) {
    return '';
  }
}

function shadowActivity({ lead, message, context, result, productionClassification, productionAction, checkOnly, now }) {
  const messageId = String(message.messageId || message.id || '');
  const agree = broadlyAgree(productionClassification, result.recommendedAction);
  return {
    eventId: shadowEventId(messageId),
    leadId: `CE-${lead.id}`,
    sourceLeadId: String(lead.id || ''),
    email: String(lead.email || ''),
    company: String(lead.company || ''),
    eventType: EVENT_TYPE,
    occurredAt: (now || new Date()).toISOString(),
    subject: `Shadow ${result.recommendedAction}`,
    content: String(result.reason || '').slice(0, 240),
    metadata: JSON.stringify({
      provider: 'gmail',
      gmailMessageId: messageId,
      gmailThreadId: String(message.threadId || ''),
      productionClassification: productionClassification || '',
      productionAction: productionAction || '',
      agentIntent: result.intent,
      agentConfidence: result.confidence,
      agentFit: result.fit,
      recommendedAction: result.recommendedAction,
      reason: result.reason,
      broadlyAgree: agree,
      model: result.model || MODEL,
      operation: OPERATION,
      agentVersion: AGENT_VERSION,
      promptVersion: PROMPT_VERSION,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      contextHash: context.contextHash,
      status: result.status,
      checkOnly: Boolean(checkOnly),
      authority: ZERO_AUTHORITY,
      autoSendAllowed: false,
      identityMutationAllowed: false,
    }),
  };
}

async function evaluateStaffingConversationShadow({
  lead, message = {}, replyText = '', activities = [],
  productionClassification = '', productionAction = '',
  checkOnly = false, now,
  persistEvent, env = process.env, createMessage, AnthropicImpl,
} = {}) {
  const skipped = (status, reason) => ({
    skipped: true, status, reason, authority: ZERO_AUTHORITY, result: null, event: null,
  });
  try {
  const messageId = String(message.messageId || message.id || '').trim();
  const config = staffingConversationAgentConfig(env);

  if (!config.enabled) return skipped('disabled', 'staffing conversation agent disabled');
  if (!isStaffingCampaign(lead)) return skipped('not_staffing', 'not a staffing lead');
  if (!messageId) return skipped('missing_message_id', 'inbound message id required for idempotency');

  const prior = existingShadow(activities, messageId);
  if (prior) {
    return {
      skipped: true, status: 'already_evaluated', reason: 'existing shadow evaluation reused',
      authority: ZERO_AUTHORITY, result: null, event: prior, reused: true,
    };
  }

  const context = buildStaffingAgentContext({ lead, message, replyText, activities });
  const classification = productionClassification
    || deterministicReplyCategory(replyText || message.body || message.snippet || '')
    || '';
  const action = productionAction || observableProductionAction(lead, classification, replyText || message.body || '');

  let result;
  if (!staffingAgentApiKey(env)) {
    result = failClosedResult('dedicated staffing conversation agent key missing', { status: 'unavailable' });
  } else {
    result = await runStaffingConversationAgent({ context, env, createMessage, AnthropicImpl });
  }

  const event = shadowActivity({
    lead, message, context, result,
    productionClassification: classification,
    productionAction: action,
    checkOnly, now,
  });

  if (typeof persistEvent === 'function') {
    try { await persistEvent(event); }
    catch (error) { console.warn(`[staffing-shadow] persist failed closed: ${error.message}`); }
  }
  if (Array.isArray(activities) && !activities.some(row => row.eventId === event.eventId)) activities.push(event);

  return {
    skipped: false,
    status: result.status,
    reason: result.reason,
    authority: ZERO_AUTHORITY,
    result,
    event,
    reused: false,
    calledModel: result.status !== 'unavailable' && result.status !== 'disabled',
  };
  } catch (error) {
    return skipped('agent_error', `staffing conversation agent failed closed: ${error.message}`);
  }
}

function pendingStaffingShadowItems({ leads = [], activities = [] } = {}) {
  const staffing = new Map(leads.filter(isStaffingCampaign).map(lead => [String(lead.id), lead]));
  const evaluated = new Set(
    activities.filter(row => row.eventType === EVENT_TYPE || String(row.eventId || '').startsWith(`${EVENT_TYPE}:`))
      .map(row => String(parseMetadata(row.metadata).gmailMessageId || String(row.eventId || '').replace(`${EVENT_TYPE}:`, ''))),
  );
  const pending = [];
  for (const row of activities) {
    if (!REPLY_EVENT_SET.has(String(row.eventType || ''))) continue;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || '').trim();
    if (!messageId || evaluated.has(messageId)) continue;
    const lead = staffing.get(String(row.sourceLeadId || '').replace(/^CE-/, ''));
    if (!lead) continue;
    pending.push({
      lead,
      message: {
        messageId,
        threadId: String(meta.gmailThreadId || ''),
        rfcMessageId: String(meta.rfcMessageId || ''),
        subject: String(row.subject || ''),
        body: String(row.content || ''),
        snippet: String(row.content || ''),
        occurredAt: String(row.occurredAt || ''),
      },
      replyText: String(row.content || ''),
      productionClassification: String(meta.classification || ''),
    });
    evaluated.add(messageId);
  }
  return pending;
}

async function observeStaffingConversationShadows({
  leads = [], activities = [], checkOnly = false, now,
  persistEvent, env = process.env, createMessage, AnthropicImpl,
  productionByMessageId = new Map(),
} = {}) {
  const config = staffingConversationAgentConfig(env);
  if (!config.enabled) return { skipped: true, status: 'disabled', evaluated: 0, reused: 0, calledModel: 0 };

  const pending = pendingStaffingShadowItems({ leads, activities });
  let evaluated = 0, reused = 0, calledModel = 0;
  const results = [];
  for (const item of pending) {
    const production = productionByMessageId.get(item.message.messageId) || {};
    let outcome;
    try {
      outcome = await evaluateStaffingConversationShadow({
        lead: item.lead,
        message: item.message,
        replyText: item.replyText,
        activities,
        productionClassification: production.classification || item.productionClassification,
        productionAction: production.action || '',
        checkOnly, now, persistEvent, env, createMessage, AnthropicImpl,
      });
    } catch (error) {
      outcome = { skipped: true, status: 'agent_error', reason: error.message, reused: false, calledModel: false };
    }
    results.push(outcome);
    if (outcome.reused) reused++;
    else evaluated++;
    if (outcome.calledModel && outcome.result && !['unavailable', 'disabled'].includes(outcome.result.status)) {
      if (outcome.result.usage && (outcome.result.usage.inputTokens || outcome.result.usage.outputTokens || outcome.result.ok)) {
        calledModel++;
      } else if (outcome.status !== 'unavailable') calledModel++;
    }
  }
  return { skipped: false, status: 'ok', evaluated, reused, calledModel, results };
}

module.exports = {
  evaluateStaffingConversationShadow,
  observeStaffingConversationShadows,
  pendingStaffingShadowItems,
  existingShadow,
};
