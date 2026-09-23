'use strict';

const { buildAgentV2Input } = require('./agent-v2-input');
const { guardCode, guarded, validateModelDecision } = require('./agent-v2-validation');
const { runAgentV2Model } = require('./agent-v2-model');
const { decisionIdFor } = require('./agent-v2-store');
const { SCHEMA_VERSION, INPUT_VERSION, CATALOG_VERSION, EVENT_TYPE, MODEL, AUTHORITY } = require('./agent-v2-contract');

// The only side effect permitted here is an insert into the dedicated shadow
// table. Callers never receive an executable action or a send authorization.
async function evaluateAgentV2Shadow({ state, messageId, store, model = runAgentV2Model,
  apiKey = '', createMessage, now = new Date() } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.putIfAbsent !== 'function')
    throw new Error('shadow decision store required');
  const input = buildAgentV2Input(state, messageId);
  const decisionId = decisionIdFor(input.leadId, input.messageId);
  const previous = await store.get(decisionId);
  if (previous) {
    if (previous.leadId !== input.leadId || previous.messageId !== input.messageId)
      throw new Error('shadow decision identity conflict');
    return { persisted: true, reused: true, calledModel: false, record: previous };
  }
  let modelResult = { raw: null, status: 'guarded', usage: { inputTokens: 0, outputTokens: 0 } };
  const forced = guardCode(input);
  if (!forced) modelResult = await model(input, { apiKey, createMessage });
  const decision = forced ? guarded(input, forced) : validateModelDecision(modelResult?.raw, input);
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const record = {
    decisionId, eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION,
    inputVersion: INPUT_VERSION, catalogVersion: CATALOG_VERSION,
    leadId: input.leadId, messageId: input.messageId,
    stateDigest: input.stateDigest, inputDigest: input.inputDigest,
    createdAt, decision, model: MODEL,
    modelStatus: modelResult?.status || 'model_error',
    usage: modelResult?.usage || { inputTokens: 0, outputTokens: 0 },
    authority: AUTHORITY,
  };
  const saved = await store.putIfAbsent(record);
  if (!saved?.record || saved.record.decisionId !== decisionId)
    throw new Error('shadow decision persistence not confirmed');
  return { persisted: true, reused: !saved.inserted,
    calledModel: !forced && modelResult?.status !== 'key_unavailable', record: saved.record };
}

module.exports = { evaluateAgentV2Shadow };
