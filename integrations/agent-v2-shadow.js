'use strict';

const { buildAgentV2Input } = require('./agent-v2-input');
const { guardCode, guarded, validateModelDecision } = require('./agent-v2-validation');
const { runAgentV2Model } = require('./agent-v2-model');
const { decisionIdFor } = require('./agent-v2-store');
const { SCHEMA_VERSION, INPUT_VERSION, CATALOG_VERSION, EVENT_TYPE, MODEL, AUTHORITY } = require('./agent-v2-contract');

// Side effects are confined to claim and completion writes in the dedicated
// shadow table. Callers never receive an executable action or send authorization.
async function evaluateAgentV2Shadow({ state, messageId, store, model = runAgentV2Model,
  apiKey = '', createMessage, now = new Date() } = {}) {
  if (!store || typeof store.claim !== 'function')
    throw new Error('shadow decision store required');
  const input = buildAgentV2Input(state, messageId);
  const decisionId = decisionIdFor(input.leadId, input.messageId);
  const claim = await store.claim({ decisionId, leadId: input.leadId, messageId: input.messageId });
  if (claim.status === 'busy') return { persisted: false, busy: true, reused: false, calledModel: false };
  if (claim.status === 'complete') return { persisted: true, reused: true, calledModel: false, record: claim.record };
  if (claim.status !== 'claimed') throw new Error('shadow claim not confirmed');
  try {
    let modelResult = { raw: null, status: 'guarded', usage: { inputTokens: 0, outputTokens: 0 } };
    const forced = guardCode(input);
    if (!forced && claim.priorModelAttempt) {
      modelResult.status = 'previous_model_attempt_unresolved';
    } else if (!forced) {
      await claim.markModelStarted();
      try { modelResult = await model(input, { apiKey, createMessage, signal: claim.signal }); }
      catch (_) { modelResult = { raw: null, status: 'model_error', usage: { inputTokens: 0, outputTokens: 0 } }; }
    }
    if (claim.signal?.aborted) throw new Error('shadow claim lost during model call');
    const decision = forced ? guarded(input, forced)
      : claim.priorModelAttempt ? guarded(input, 'MODEL_ERROR', 'unresolved_model_attempt')
        : validateModelDecision(modelResult?.raw, input);
    const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const record = {
      decisionId, eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION,
      inputVersion: INPUT_VERSION, catalogVersion: CATALOG_VERSION,
      leadId: input.leadId, messageId: input.messageId,
      stateDigest: input.stateDigest, inputDigest: input.inputDigest,
      createdAt, decision, model: modelResult?.model || MODEL,
      modelStatus: modelResult?.status || 'model_error',
      usage: modelResult?.usage || { inputTokens: 0, outputTokens: 0 },
      latencyMs: Number(modelResult?.latencyMs || 0),
      estimatedCostUsd: modelResult?.estimatedCostUsd ?? null,
      apiCostUsd: modelResult?.apiCostUsd ?? null,
      productionDecision: input.currentState?.productionDecision || null,
      authority: AUTHORITY,
    };
    const saved = await claim.complete(record);
    if (!saved || saved.decisionId !== decisionId) throw new Error('shadow decision persistence not confirmed');
    return { persisted: true, reused: false, calledModel: !forced && !claim.priorModelAttempt, record: saved };
  } finally { await claim.release(); }
}

module.exports = { evaluateAgentV2Shadow };
