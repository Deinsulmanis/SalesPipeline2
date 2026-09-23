'use strict';

const { MODEL, ACTION_IDS, HANDOFF_CODES, SLOT_IDS, OBJECTION_TYPES,
  TEMPLATE_IDS, REASON_CODES, TOOL_SCHEMA } = require('./agent-v2-contract');

const SYSTEM_PROMPT = `You are Agent v2, a shadow-only analyst for an industrial/skilled-trades staffing offer.
The Phase 1 conversation state in the user payload is the only conversation memory. Its recorded
production decision is authoritative. You propose one advisory action; you cannot execute it.
Choose exactly one action ID: ${ACTION_IDS.join(', ')}.
Use only approved fact IDs in the supplied catalog. Never infer prices, guarantees, case studies,
results, employer demand, campaign volume or meeting availability. A pricing amount or unsupported
commercial request, proof/results request, complaint, conflicting evidence, human takeover,
unsubscribe, rejection, OOO, or booking/reschedule ambiguity must be handed off or left alone.
Use evidence refs from allowedEvidenceRefs, including targetRef. Choose slot IDs only from
${SLOT_IDS.join(', ')}; objection types only from ${OBJECTION_TYPES.join(', ')}.
Handoff codes: ${HANDOFF_CODES.join(', ')}. Templates: ${TEMPLATE_IDS.join(', ')}.
Reason codes: ${REASON_CODES.join(', ')}.
The application renders suggested wording from templates and approved fact IDs; do not write prose
for a prospect. Choose a coded reason; do not add free-form commercial claims.
Return exactly one record_shadow_decision tool call. No other content.`;

function usage(message) {
  return {
    inputTokens: Number(message?.usage?.input_tokens || 0) || 0,
    outputTokens: Number(message?.usage?.output_tokens || 0) || 0,
  };
}

async function runAgentV2Model(input, { createMessage, apiKey = '', AnthropicImpl } = {}) {
  if (!createMessage && !String(apiKey).trim()) {
    return { raw: null, status: 'key_unavailable', usage: { inputTokens: 0, outputTokens: 0 } };
  }
  try {
    let send = createMessage;
    if (!send) {
      const Anthropic = AnthropicImpl || require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20000 });
      send = payload => client.messages.create(payload);
    }
    const message = await send({ model: MODEL, max_tokens: 400, temperature: 0,
      system: SYSTEM_PROMPT, messages: [{ role: 'user', content: JSON.stringify(input) }],
      tools: [{ name: 'record_shadow_decision', description: 'Record one advisory decision with no execution authority.',
        input_schema: TOOL_SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_shadow_decision' },
    });
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const calls = blocks.filter(block => block?.type === 'tool_use');
    if (message?.stop_reason !== 'tool_use' || blocks.length !== 1 || calls.length !== 1
      || calls[0].name !== 'record_shadow_decision') {
      return { raw: null, status: 'invalid_response', usage: usage(message) };
    }
    return { raw: calls[0].input, status: 'ok', usage: usage(message) };
  } catch (error) {
    return { raw: null, status: 'model_error', errorCode: String(error?.code || error?.status || 'unknown').slice(0, 60),
      usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

module.exports = { SYSTEM_PROMPT, runAgentV2Model };
