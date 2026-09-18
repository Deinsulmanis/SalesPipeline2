'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const {
  MODEL, OPERATION, AGENT_VERSION, PROMPT_VERSION,
  staffingAgentApiKey, staffingConversationAgentConfig,
  normalizeAgentOutput, failClosedResult, RECOMMENDED_ACTIONS,
} = require('./staffing-agent-schema');
const { compactAgentUserPayload } = require('./staffing-agent-context');

const SYSTEM_PROMPT = `You handle inbound replies from industrial staffing-agency prospects for ScaleLab’s employer-acquisition offer.
The offer is employer acquisition, not candidate sourcing.
Understand the conversation and recommend the single best next action. Do not execute anything.

Goals: move genuinely qualified staffing agencies toward a sales call; answer reasonable information requests; avoid unnecessary friction, aggression, or repetition; escalate uncertainty rather than guessing.

Choose exactly one action: ${RECOMMENDED_ACTIONS.join(', ')}.
Never invent pricing, company facts, contact identities, referral contact information, or permissions.
Never claim a meeting is booked unless the supplied facts say so.
Never recommend emailing a referred third party automatically.

Rules:
- explicit unsubscribe → UNSUBSCRIBE
- clear rejection → MARK_NOT_INTERESTED
- timing objection → HOLD_FOR_LATER
- explicit request for information or a website → SEND_INFO
- interest without qualification context → ASK_QUALIFICATION
- qualification answer that clearly fits, and qualification was already asked → SEND_BOOKING
- qualification-like answer when qualification was never asked → ESCALATE_HUMAN
- existing internal BD/provider → ALREADY_HANDLED
- referral/wrong person → STORE_REFERRAL
- uncertain/ambiguous → ESCALATE_HUMAN

Return JSON only:
{"intent":"INTERESTED","confidence":0.94,"fit":"UNKNOWN","recommendedAction":"ASK_QUALIFICATION","reason":"short reason","replyDraft":"short draft"}
intent must be one of INTERESTED, NOT_INTERESTED, QUESTION, UNSUBSCRIBE, TIMING, REFERRAL, EXISTING_PROVIDER, AMBIGUOUS, OTHER.
fit must be one of FIT, UNCLEAR, MISMATCH, UNKNOWN.
confidence is a number from 0 to 1.`;

function usageFromMessage(message) {
  const usage = message?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || usage.inputTokens || 0) || 0,
    outputTokens: Number(usage.output_tokens || usage.outputTokens || 0) || 0,
  };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let depth = 0, quoted = false, escaped = false, end = -1;
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('malformed JSON');
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('malformed JSON');
  const value = JSON.parse(raw.slice(start, end));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed JSON');
  return value;
}

function createStaffingAgentClient({ env = process.env, AnthropicImpl = Anthropic } = {}) {
  const apiKey = staffingAgentApiKey(env);
  if (!apiKey) return null;
  return new AnthropicImpl({ apiKey, maxRetries: 1, timeout: 20000 });
}

async function runStaffingConversationAgent({ context, env = process.env, createMessage, AnthropicImpl = Anthropic } = {}) {
  const config = staffingConversationAgentConfig(env);
  if (!config.enabled) return failClosedResult('staffing conversation agent disabled', { status: 'disabled' });
  if (!staffingAgentApiKey(env)) {
    return failClosedResult('dedicated staffing conversation agent key missing', { status: 'unavailable' });
  }

  const send = createMessage || (payload => createStaffingAgentClient({ env, AnthropicImpl }).messages.create(payload));
  try {
    const message = await send({
      model: MODEL,
      max_tokens: 280,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(compactAgentUserPayload(context)) }],
    });
    const usage = usageFromMessage(message);
    const extras = { model: MODEL, usage };
    try {
      const text = Array.isArray(message?.content)
        ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        : String(message?.content?.[0]?.text || message?.content || '');
      return normalizeAgentOutput(parseJsonObject(text), extras);
    } catch (error) {
      return failClosedResult(error.message || 'invalid response', { ...extras, status: 'invalid_response' });
    }
  } catch (error) {
    const detail = String(error.message || error.status || 'api error').slice(0, 200);
    const status = /rate.?limit/i.test(detail) ? 'rate_limited'
      : /credit|insufficient/i.test(detail) ? 'credits'
        : /time.?out/i.test(detail) ? 'timeout'
          : 'api_error';
    return failClosedResult(`Anthropic ${status}: ${detail}`, {
      status,
      extra: { operation: OPERATION, agentVersion: AGENT_VERSION, promptVersion: PROMPT_VERSION },
    });
  }
}

module.exports = {
  SYSTEM_PROMPT, MODEL, createStaffingAgentClient, runStaffingConversationAgent, parseJsonObject,
};
