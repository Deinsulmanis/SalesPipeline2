#!/usr/bin/env node
'use strict';

/**
 * Agent v2 replay evaluation over the labeled corpus
 * (test/fixtures/agent-v2-replay-corpus.js). ZERO authority: no ledger, Gmail,
 * Sheets, Supabase or send access; the only network calls are model calls.
 *
 * For each case:
 *   1. the deterministic production decision — the recorded one for
 *      REAL_HISTORICAL cases, otherwise the real classifier + staffing overlay +
 *      reply-response policy, exactly as the reply pass computes them;
 *   2. Phase 1 state → Agent v2 input → guard or model → validation →
 *      Phase 3 permission → Phase 4 wording → canary pre-scope and gate;
 *   3. the Agent v2 outcome (SEND_ALLOWED / HUMAN_REVIEW / NO_ACTION / WAIT)
 *      compared with the labels, with a severity for every disagreement.
 *
 *   node scripts/agent-v2-replay-eval.js --report=<path.json>
 *     ANTHROPIC_AGENT_V2_KEY (or --use-general-key with ANTHROPIC_API_KEY) for
 *     Agent v2, and ANTHROPIC_API_KEY for the production classifier fallback.
 */

const fs = require('node:fs');
const { CASES, activitiesFor } = require('../test/fixtures/agent-v2-replay-corpus');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { guardCode, guarded, validateModelDecision } = require('../integrations/agent-v2-validation');
const { runAgentV2Model } = require('../integrations/agent-v2-model');
const { evaluateAgentV2Permission } = require('../integrations/agent-v2-permission');
const { renderAgentV2Wording } = require('../integrations/agent-v2-wording');
const { canaryPreScope, canaryDecisionGate } = require('../integrations/agent-v2-canary');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { SCHEMA_VERSION, INPUT_VERSION, CATALOG_VERSION, EVENT_TYPE, MODEL, AUTHORITY } = require('../integrations/agent-v2-contract');
const { classifyReplyText } = require('../integrations/canonical-reply');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const { interpretInboundReply, ROUTE } = require('../integrations/reply-decision');
const { decideReplyResponse, numericConfidence } = require('../integrations/reply-response-policy');
const { classifyStaffingReply, overlayStaffingReplyClassification, staffingRepeatReason, staffingReplyHistory,
  staffingHumanTouchBlock } = require('../integrations/staffing-reply-policy');
const { offerForLead } = require('../integrations/offer-config');
const { familyForLead } = require('../integrations/campaign-versions');

const POSITIVE_ROUTES = new Set([ROUTE.INTERESTED, ROUTE.MEETING_REQUEST, ROUTE.SEND_INFO, ROUTE.STAFFING_QUALIFICATION]);
const ROUTE_POLICY = { [ROUTE.UNSUBSCRIBE]: 'SUPPRESS', [ROUTE.NOT_INTERESTED]: 'AUTO_NEGATIVE_CLOSE',
  [ROUTE.OUT_OF_OFFICE]: 'WAIT_OUT_OF_OFFICE', [ROUTE.TIMING]: 'AUTO_TIMING_RECONTACT' };

function targetMessage(c) {
  const entry = c.history.find(h => h.kind === 'inbound' && h.id === c.target);
  return { entry, message: { messageId: c.target, threadId: entry.thread || 't1', senderInboxId: entry.inbox || c.lead.senderInboxId,
    subject: 'Re: employer accounts', fromAddr: c.lead.email, occurredAt: new Date(entry.at).toISOString(), rfcMessageId: `<${c.target}@mail.example>` } };
}

/** What the deterministic production path decides for the target. */
async function productionDecision(c, { classify, activities }) {
  if (c.production) return { ...c.production, source: c.production.recorded ? 'recorded' : 'recorded_route' };
  const { entry, message } = targetMessage(c);
  const text = entry.text;
  const ruleCanonical = classifyReplyText(text, { subject: message.subject, currentEmail: c.lead.email, now: message.occurredAt });
  const { decision, overlay } = await interpretInboundReply({ lead: c.lead, message, replyText: text, ruleCanonical,
    maySend: true, ruleCategory: deterministicReplyCategory, classify: () => classify({ lead: c.lead, text }) });
  const cls = decision.finalClassification;
  const positivePolicy = (classification, canonical, staffingOverlay) => {
    if (staffingHumanTouchBlock({ lead: c.lead, activities, outboundObservationOk: true })) return 'HUMAN_REVIEW';
    if (classifyStaffingReply(text, c.lead).promote === false) return 'HUMAN_REVIEW';
    const effective = staffingOverlay?.classification || classification;
    const effectiveCanonical = staffingOverlay?.canonical || canonical;
    let policy = decideReplyResponse({ classification: effective, canonical: effectiveCanonical,
      confidence: staffingOverlay?.confidence || numericConfidence({ classification: effective, canonical: effectiveCanonical }),
      offer: offerForLead(c.lead), text, family: familyForLead(c.lead), qualificationFit: staffingOverlay?.fit || '' });
    if (policy.send && staffingRepeatReason(policy.action, staffingReplyHistory({ lead: c.lead, activities })))
      policy = { action: 'HUMAN_REVIEW', send: false };
    return policy.send ? policy.action : 'HUMAN_REVIEW';
  };
  let policyAction = ROUTE_POLICY[decision.route] || 'HUMAN_REVIEW';
  let finalClassification = cls;
  if (POSITIVE_ROUTES.has(decision.route)) policyAction = positivePolicy(cls, ruleCanonical, overlay);
  if (decision.route === ROUTE.QUESTION) {
    const questionOverlay = overlayStaffingReplyClassification({ text, lead: c.lead, classification: 'QUESTION', canonical: ruleCanonical });
    if (['SEND_INFO', 'INTERESTED', 'STAFFING_QUALIFICATION'].includes(questionOverlay.classification)) {
      finalClassification = questionOverlay.classification;
      policyAction = positivePolicy(questionOverlay.classification, ruleCanonical, questionOverlay);
    }
  }
  return { finalClassification, policyAction, route: decision.route, source: decision.finalClassificationSource };
}

function decisionRow(c, production, at) {
  return { eventId: `reply-decision:${c.lead.id}:${c.target}`, leadId: `CE-${c.lead.id}`, sourceLeadId: c.lead.id,
    email: c.lead.email, company: c.lead.company, eventType: 'reply_decision_recorded', occurredAt: new Date(at).toISOString(),
    subject: '', content: '', metadata: JSON.stringify({ inboundMessageId: c.target, leadId: c.lead.id,
      decisionId: `reply-decision:${c.lead.id}:${c.target}`, finalClassification: production.finalClassification,
      policyAction: production.policyAction, executionStatus: 'recorded' }) };
}

function outcomeOf({ decision, permission, sendable }) {
  if (sendable) return 'SEND_ALLOWED';
  // An autoresponder is never answered: Phase 3 denies it whatever the model said.
  if (permission?.verdict === 'DENY' && permission.reasonCode === 'NON_HUMAN_INBOUND') return 'WAIT';
  if (decision.actionId === 'NO_ACTION' && decision.handoffCode === 'OUT_OF_OFFICE') return 'WAIT';
  if (decision.actionId === 'NO_ACTION') return 'NO_ACTION';
  return 'HUMAN_REVIEW';
}

const BUYING = new Set(['POSITIVE', 'PRICING', 'QUALIFICATION_QUESTION', 'BOOKING', 'RESCHEDULING']);
function severityOf(c, actual) {
  const e = c.expected;
  if (e.acceptable.includes(actual.outcome)) return 'AGREE';
  if (actual.outcome === 'SEND_ALLOWED' && !e.autoResponsePermitted) return 'HIGH';
  if ((actual.outcome === 'NO_ACTION' || actual.outcome === 'WAIT') && BUYING.has(c.category)) return 'HIGH';
  if (e.autoResponsePermitted && actual.outcome === 'HUMAN_REVIEW') return 'MEDIUM';
  if (e.allowedAction === 'NO_ACTION' && actual.outcome !== 'NO_ACTION' && actual.outcome !== 'SEND_ALLOWED') return 'LOW';
  if (e.allowedAction === 'WAIT' && actual.outcome !== 'SEND_ALLOWED') return 'LOW';
  if (e.allowedAction === 'HUMAN_REVIEW' && (actual.outcome === 'NO_ACTION' || actual.outcome === 'WAIT')) return 'MEDIUM';
  return 'MEDIUM';
}

async function evaluateCase(c, { callModel, classify }) {
  const baseRows = activitiesFor(c.lead, c.history);
  const production = await productionDecision(c, { classify, activities: baseRows });
  const now = new Date((c.evaluatedAt || c.at) + 60000);
  const activities = production.recorded === false && c.production ? baseRows
    : [...baseRows, decisionRow(c, production, c.at + 30000)];
  const state = buildConversationState({ lead: c.lead, activities, now: now.toISOString(),
    config: { sequencesEnabled: true, sendingEnabled: true } });
  const input = buildAgentV2Input(state, c.target);
  const forced = guardCode(input);
  let modelResult = { status: 'guarded', raw: null, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
  if (!forced) modelResult = await callModel(input);
  const decision = forced ? guarded(input, forced) : validateModelDecision(modelResult.raw, input);
  const record = { decisionId: decisionIdFor(input.leadId, input.messageId), eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION,
    inputVersion: INPUT_VERSION, catalogVersion: CATALOG_VERSION, leadId: input.leadId, messageId: input.messageId,
    stateDigest: input.stateDigest, inputDigest: input.inputDigest, stateAsOf: input.asOf, createdAt: now.toISOString(),
    decision, model: modelResult.model || MODEL, modelStatus: modelResult.status, authority: AUTHORITY };
  let permission = null; let wording = null;
  try { permission = evaluateAgentV2Permission(state, record); wording = renderAgentV2Wording({ state, record, permission }); }
  catch (error) { permission = { verdict: 'DENY', reasonCode: `PERMISSION_ERROR:${error.message}` }; }
  const { message } = targetMessage(c);
  const scope = canaryPreScope({ lead: c.lead, message, policy: { action: production.policyAction,
    send: production.policyAction === 'AUTO_STAFFING_QUALIFY_QUESTION' }, activities: baseRows, now });
  const gate = canaryDecisionGate({ record, state, input });
  const sendable = Boolean(scope.inScope && permission?.verdict === 'ALLOW' && decision.actionId === 'SUGGEST_QUALIFICATION'
    && gate.allowed && wording?.status === 'RENDERED');
  const actual = { outcome: outcomeOf({ decision, permission, sendable }), sendable };
  const severity = severityOf(c, actual);
  return { id: c.id, label: c.label, category: c.category, description: c.description,
    production: { finalClassification: production.finalClassification, policyAction: production.policyAction, source: production.source },
    agent: { guard: forced || null, modelStatus: modelResult.status, actionId: decision.actionId, handoffCode: decision.handoffCode,
      reasonCode: decision.reasonCode, confidence: decision.confidence, slotIds: decision.slotIds, decisionStatus: decision.status,
      validationError: decision.validationError || null, riskFlags: input.riskFlags,
      client: input.client.clientId, sender: message.senderInboxId,
      tokens: modelResult.usage, latencyMs: Math.round(Number(modelResult.latencyMs || 0)) },
    permission: permission ? { verdict: permission.verdict, reasonCode: permission.reasonCode } : null,
    wording: wording ? { status: wording.status, reasonCode: wording.reasonCode, text: wording.wording || null } : null,
    canary: { preScope: scope.code || 'in_scope', gate: gate.code || 'allowed' },
    expected: c.expected, actual, severity };
}

async function evaluateCorpus({ callModel, classify, cases = CASES } = {}) {
  const results = [];
  for (const c of cases) results.push(await evaluateCase(c, { callModel, classify }));
  return { results, summary: summarize(results) };
}

function summarize(results) {
  const count = pred => results.filter(pred).length;
  const by = cat => results.filter(r => r.category === cat);
  const allCorrect = rows => rows.every(r => r.severity === 'AGREE');
  const sends = results.filter(r => r.actual.sendable);
  return {
    total: results.length,
    realHistorical: count(r => r.label === 'REAL_HISTORICAL'),
    synthetic: count(r => r.label === 'SYNTHETIC_TEST_FIXTURE'),
    genuineHumanStyle: count(r => r.category !== 'OUT_OF_OFFICE'),
    agree: count(r => r.severity === 'AGREE'),
    low: count(r => r.severity === 'LOW'), medium: count(r => r.severity === 'MEDIUM'), high: count(r => r.severity === 'HIGH'),
    sendsAllowed: sends.map(r => r.id),
    unauthorizedSends: sends.filter(r => !r.expected.autoResponsePermitted).map(r => r.id),
    ooo100: allCorrect(by('OUT_OF_OFFICE')),
    unsubscribe100: allCorrect(by('UNSUBSCRIBE')),
    priorHuman100: allCorrect(results.filter(r => r.expected.humanTakeoverRequired || r.category === 'THREAD_WITH_PRIOR_HUMAN_RESPONSE')),
    clientScoping100: allCorrect(by('CROSS_CLIENT')) && results.every(r => r.category === 'CROSS_CLIENT' || r.agent.client === 'scalelab'),
    senderThread100: allCorrect([...by('CROSS_INBOX'), ...by('MULTI_MESSAGE_THREAD')]),
    stale100: allCorrect(by('STALE')),
    modelCalls: count(r => !r.agent.guard),
    modelFailures: count(r => !r.agent.guard && r.agent.modelStatus !== 'ok'),
    inputTokens: results.reduce((n, r) => n + Number(r.agent.tokens?.inputTokens || 0), 0),
    outputTokens: results.reduce((n, r) => n + Number(r.agent.tokens?.outputTokens || 0), 0),
  };
}

async function main(argv = process.argv.slice(2)) {
  require('dotenv').config({ quiet: true, path: process.env.DOTENV_PATH || undefined });
  const options = Object.fromEntries(argv.map(arg => arg.replace(/^--/, '').split('=')).map(([k, ...v]) => [k, v.join('=') || true]));
  const agentKey = process.env.ANTHROPIC_AGENT_V2_KEY || (options['use-general-key'] ? process.env.ANTHROPIC_API_KEY : '');
  if (!agentKey) throw new Error('ANTHROPIC_AGENT_V2_KEY (or --use-general-key) is required');
  const { classifyReplyDetailed } = require('../integrations/reply-classifier');
  const out = await evaluateCorpus({
    callModel: input => runAgentV2Model(input, { apiKey: agentKey }),
    classify: ({ lead, text }) => classifyReplyDetailed({ lead, plainTextReply: text, subject: 'Re: employer accounts',
      apiKey: process.env.ANTHROPIC_API_KEY }),
  });
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
  return out;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = { evaluateCase, evaluateCorpus, summarize, productionDecision, outcomeOf, severityOf };
