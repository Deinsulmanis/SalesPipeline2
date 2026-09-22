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
const { replyDecisionFor, productionFactsFromDecision } = require('./reply-decision');
const { buildStaffingAgentContext } = require('./staffing-agent-context');
const { runStaffingConversationAgent } = require('./staffing-conversation-agent');
const {
  EVENT_TYPE, AGENT_VERSION, PROMPT_VERSION, OPERATION, MODEL,
  ZERO_AUTHORITY, shadowEventId, staffingConversationAgentConfig,
  staffingAgentApiKey, failClosedResult, broadlyAgree, actionAgreesWithPolicy,
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

/**
 * What production actually decided for this message. The shadow never
 * recomputes it: re-running the reply policy without its real inputs is how
 * every auto-send used to be recorded as HUMAN_REVIEW. In order of authority:
 *   1. the reply decision passed in by this pass
 *   2. the persisted reply_decision_recorded event
 *   3. a classification production recorded before decision records existed
 * and otherwise an explicit "unavailable".
 */
function productionFacts({ lead, messageId, activities, productionDecision, productionClassification, productionAction }) {
  const decision = productionDecision
    || productionFactsFromDecision(replyDecisionFor(activities, messageId, lead && lead.id));
  if (decision) return decision;
  const classification = String(productionClassification || '').trim().toUpperCase();
  const policyAction = String(productionAction || '').trim().toUpperCase();
  return {
    source: classification || policyAction ? 'recorded_classification' : 'unavailable',
    decisionId: null, classification, classificationSource: null, canonicalState: null,
    policyAction, executedAction: '', executionStatus: '',
  };
}

function shadowActivity({ lead, message, context, result, production, checkOnly, now }) {
  const messageId = String(message.messageId || message.id || '');
  const productionClassification = production.classification;
  const productionAction = production.policyAction;
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
      // Production's recorded decision, compared three ways: the agent against
      // the final interpretation (broadlyAgree), the agent against the policy
      // action, and the policy action against what was actually executed.
      productionDecisionSource: production.source,
      productionDecisionId: production.decisionId || null,
      productionClassificationSource: production.classificationSource || null,
      productionCanonicalState: production.canonicalState || null,
      productionPolicyAction: productionAction || null,
      productionExecutedAction: production.executedAction || null,
      productionExecutionStatus: production.executionStatus || null,
      actionAgreesWithPolicy: actionAgreesWithPolicy(result.recommendedAction, productionAction),
      policyExecuted: productionAction && production.executionStatus
        ? production.executedAction === productionAction : null,
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
  productionClassification = '', productionAction = '', productionDecision = null,
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
  const production = productionFacts({
    lead, messageId, activities, productionDecision, productionClassification, productionAction,
  });

  let result;
  if (!staffingAgentApiKey(env)) {
    result = failClosedResult('dedicated staffing conversation agent key missing', { status: 'unavailable' });
  } else {
    result = await runStaffingConversationAgent({ context, env, createMessage, AnthropicImpl });
  }

  const event = shadowActivity({
    lead, message, context, result, production,
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

function pendingStaffingShadowItems({ leads = [], activities = [], productionByMessageId = new Map() } = {}) {
  const staffing = new Map(leads.filter(isStaffingCampaign).map(lead => [String(lead.id), lead]));
  const evaluated = new Set(
    activities.filter(row => row.eventType === EVENT_TYPE || String(row.eventId || '').startsWith(`${EVENT_TYPE}:`))
      .map(row => String(parseMetadata(row.metadata).gmailMessageId || String(row.eventId || '').replace(`${EVENT_TYPE}:`, ''))),
  );
  const replyByMessageId = new Map();
  for (const row of activities) {
    if (!REPLY_EVENT_SET.has(String(row.eventType || ''))) continue;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || '').trim();
    if (messageId && !replyByMessageId.has(messageId)) replyByMessageId.set(messageId, row);
  }
  const pending = [];
  const consider = (lead, message, replyText, productionClassification) => {
    const messageId = String(message.messageId || '').trim();
    if (!messageId || evaluated.has(messageId) || !lead || !isStaffingCampaign(lead)) return;
    pending.push({ lead, message, replyText: String(replyText || ''), productionClassification: String(productionClassification || '') });
    evaluated.add(messageId);
  };

  for (const row of activities) {
    const eventType = String(row.eventType || '');
    const fromReply = REPLY_EVENT_SET.has(eventType);
    const fromEvaluated = eventType === 'gmail_reply_evaluated';
    if (!fromReply && !fromEvaluated) continue;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || String(meta.sourceEventId || '').replace(/^gmail-reply:/, '')).trim();
    if (!messageId || evaluated.has(messageId)) continue;
    const lead = staffing.get(String(row.sourceLeadId || '').replace(/^CE-/, ''))
      || staffing.get(String(row.leadId || '').replace(/^CE-/, ''));
    if (!lead) continue;
    const replyRow = fromReply ? row : replyByMessageId.get(messageId);
    const replyMeta = replyRow ? parseMetadata(replyRow.metadata) : meta;
    consider(lead, {
      messageId,
      threadId: String(replyMeta.gmailThreadId || meta.gmailThreadId || ''),
      rfcMessageId: String(replyMeta.rfcMessageId || meta.rfcMessageId || ''),
      subject: String((replyRow || row).subject || ''),
      body: String((replyRow || row).content || ''),
      snippet: String((replyRow || row).content || ''),
      occurredAt: String((replyRow || row).occurredAt || row.occurredAt || ''),
    }, (replyRow || row).content || '', replyMeta.classification || meta.classification || '');
  }

  for (const [messageId, production] of productionByMessageId.entries()) {
    const lead = production.lead || staffing.get(String(production.leadId || ''));
    consider(
      lead,
      production.message || { messageId },
      production.replyText || '',
      production.classification || '',
    );
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

  const pending = pendingStaffingShadowItems({ leads, activities, productionByMessageId });
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
        productionDecision: production.decision || null,
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
