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

// A provider or configuration failure says nothing about the message, so it
// must not stand as the message's permanent evaluation. Each retry appends a
// NEW ledger row (attempt N has its own event id); nothing is overwritten.
// Validation failures (`agent_error`, `invalid_response`) and real answers are
// final. Attempts and spacing are bounded so an outage cannot loop.
const RETRYABLE_STATUSES = new Set(['credits', 'rate_limited', 'timeout', 'api_error', 'unavailable']);
const MAX_SHADOW_ATTEMPTS = 3;
const RETRY_BASE_MS = 30 * 60 * 1000;

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function attemptEventId(messageId, attempt) {
  const base = shadowEventId(messageId);
  return !base || attempt <= 1 ? base : `${base}:attempt-${attempt}`;
}

/** Every recorded attempt for one inbound message, oldest first. */
function shadowAttempts(activities = [], messageId) {
  const base = shadowEventId(messageId);
  if (!base) return [];
  return activities.filter(row => {
    const eventId = String(row.eventId || '');
    return eventId === base || eventId.startsWith(`${base}:attempt-`)
      || (row.eventType === EVENT_TYPE && parseMetadata(row.metadata).gmailMessageId === String(messageId));
  }).sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
}

/**
 * { latest, attempts, retryDue, final } for one message. `final` means the
 * recorded evaluation stands: it succeeded, failed deterministically, or the
 * retry budget is spent. A transient failure is retried only once its backoff
 * (30 min, then 60 min) has passed.
 */
function shadowRetryState(activities = [], messageId, now = new Date()) {
  const attempts = shadowAttempts(activities, messageId);
  const latest = attempts[attempts.length - 1] || null;
  if (!latest) return { latest: null, attempts: 0, retryDue: false, final: false };
  const status = String(parseMetadata(latest.metadata).status || '');
  if (!RETRYABLE_STATUSES.has(status) || attempts.length >= MAX_SHADOW_ATTEMPTS)
    return { latest, attempts: attempts.length, retryDue: false, final: true };
  const at = Date.parse(latest.occurredAt || '');
  const wait = RETRY_BASE_MS * (2 ** (attempts.length - 1));
  const retryDue = !Number.isFinite(at) || new Date(now).getTime() - at >= wait;
  return { latest, attempts: attempts.length, retryDue, final: false };
}

function existingShadow(activities = [], messageId) {
  return shadowAttempts(activities, messageId).at(-1) || null;
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

function shadowActivity({ lead, message, context, result, production, checkOnly, now, attempt = 1 }) {
  const messageId = String(message.messageId || message.id || '');
  const productionClassification = production.classification;
  const productionAction = production.policyAction;
  const agree = broadlyAgree(productionClassification, result.recommendedAction);
  return {
    eventId: attemptEventId(messageId, attempt),
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
      // Audit only: the model's proposed wording is never sent or drafted.
      replyDraft: String(result.replyDraft || '').slice(0, 600),
      attempt,
      retryable: RETRYABLE_STATUSES.has(result.status),
      status: result.status,
      checkOnly: Boolean(checkOnly),
      authority: ZERO_AUTHORITY,
      autoSendAllowed: false,
      identityMutationAllowed: false,
    }),
  };
}

async function evaluateStaffingConversationShadow({
  lead, message = {}, replyText = '', activities = [], leads = [],
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

  const retry = shadowRetryState(activities, messageId, now || new Date());
  if (retry.latest && !retry.retryDue) {
    return {
      skipped: true, status: 'already_evaluated',
      reason: retry.final ? 'existing shadow evaluation reused' : 'transient shadow failure awaiting retry backoff',
      authority: ZERO_AUTHORITY, result: null, event: retry.latest, reused: true,
    };
  }
  const attempt = retry.attempts + 1;

  const context = buildStaffingAgentContext({ lead, message, replyText, activities, leads });
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
    checkOnly, now, attempt,
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

function pendingStaffingShadowItems({ leads = [], activities = [], productionByMessageId = new Map(), now = new Date() } = {}) {
  const staffing = new Map(leads.filter(isStaffingCampaign).map(lead => [String(lead.id), lead]));
  const shadowed = new Set(
    activities.filter(row => row.eventType === EVENT_TYPE || String(row.eventId || '').startsWith(`${EVENT_TYPE}:`))
      .map(row => String(parseMetadata(row.metadata).gmailMessageId
        || String(row.eventId || '').replace(`${EVENT_TYPE}:`, '').replace(/:attempt-\d+$/, ''))),
  );
  // A message whose transient failure is due for retry is pending again.
  const evaluated = new Set([...shadowed].filter(id => !shadowRetryState(activities, id, now).retryDue));
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

  const pending = pendingStaffingShadowItems({ leads, activities, productionByMessageId, now: now || new Date() });
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
        leads,
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
  shadowAttempts,
  shadowRetryState,
  RETRYABLE_STATUSES,
  MAX_SHADOW_ATTEMPTS,
};
