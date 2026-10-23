'use strict';

/**
 * Agent v2 production SHADOW hook.
 *
 * Runs after the reply pass has routed every inbound message and persisted its
 * reply decision. For each genuine-human reply from a ScaleLab industrial
 * staffing lead it builds that lead's Phase 1 conversation state, runs the
 * Agent v2 decision worker once, and persists the result (with what Phase 3
 * permission and Phase 4 wording WOULD have said) to the dedicated Supabase
 * shadow ledger. It also retries, a bounded number of times, evaluations that
 * failed for a transient provider reason.
 *
 * Authority: none. This module imports no send, draft, CRM, stage, queue,
 * suppression, booking or sender code; it never writes to Google Sheets; its
 * only write is the shadow ledger. It runs whether or not
 * AGENT_V2_EXECUTION_ENABLED is set, and its result is never read by routing.
 */

const { isStaffingCampaign } = require('./staffing-campaign');
const { tenantOf } = require('./clients/email-scope');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const { isArchivedLead } = require('./lead-archive');
const { decisionIdFor } = require('./agent-v2-store');
const { buildAgentV2Input } = require('./agent-v2-input');
const { evaluateAgentV2Shadow } = require('./agent-v2-shadow');
const { evaluateAgentV2Permission } = require('./agent-v2-permission');
const { renderAgentV2Wording } = require('./agent-v2-wording');
const { MODEL, AUTHORITY } = require('./agent-v2-contract');

const DEFAULT_MAX_EVALUATIONS = 5;
const DEFAULT_RETRY_LIMIT = 3;
// RFC 2606 / 6761 reserved names: never a real prospect.
const RESERVED_TEST_DOMAIN = /(?:^|\.)(?:example(?:\.(?:com|org|net))?|test|invalid|localhost)$/i;

const flag = (env, name) => String(env[name] || '').trim().toLowerCase() === 'true';

/** Safe, secret-free configuration summary for boot logs and the ops endpoint. */
function agentV2ShadowConfig(env = process.env) {
  const shadowEnabled = flag(env, 'AGENT_V2_SHADOW_ENABLED');
  const executionEnabled = flag(env, 'AGENT_V2_EXECUTION_ENABLED');
  const keyConfigured = Boolean(String(env.ANTHROPIC_AGENT_V2_KEY || '').trim());
  const ledgerConfigured = Boolean(String(env.AGENT_V2_SUPABASE_DATABASE_URL || '').trim()
    && String(env.AGENT_V2_SUPABASE_CA_CERT || '').trim() && String(env.SUPABASE_URL || '').trim());
  return Object.freeze({
    shadowEnabled, executionEnabled, keyConfigured, ledgerConfigured, model: MODEL,
    shadowActive: shadowEnabled && keyConfigured && ledgerConfigured,
    // The Phase 6 delivery path's own preconditions (outreach-agent.js
    // deliverAgentV2Qualification). False means Agent v2 cannot send at all.
    effectiveSendAuthority: executionEnabled && shadowEnabled && keyConfigured && ledgerConfigured,
    scope: `${DEFAULT_CLIENT_ID}/industrial_staffing`,
    shadowAuthority: AUTHORITY,
  });
}

function domainOf(address) {
  const at = String(address || '').trim().toLowerCase().lastIndexOf('@');
  return at < 0 ? '' : String(address).trim().toLowerCase().slice(at + 1);
}

/**
 * Cheap pre-check on what the reply pass already holds. Final eligibility
 * (genuine human, latest inbound, staffing family) is decided again on the
 * fresh Phase 1 state before any model call.
 */
function shadowCandidate({ lead, message = {}, decision = {}, internalDomains = [] } = {}) {
  const skip = reason => ({ eligible: false, reason });
  if (!lead || !lead.id) return skip('no_lead');
  if (!message.messageId) return skip('no_message_id');
  if (!isStaffingCampaign(lead)) return skip('not_staffing');
  if (tenantOf(lead) !== DEFAULT_CLIENT_ID) return skip('not_scalelab_client');
  if (isArchivedLead(lead)) return skip('archived');
  if (/^SYNTHETIC/i.test(String(lead.id)) || RESERVED_TEST_DOMAIN.test(domainOf(lead.email))) return skip('test_lead');
  const from = domainOf(message.fromAddr || lead.email);
  if (from && internalDomains.map(item => String(item).toLowerCase()).includes(from)) return skip('internal_sender');
  if (decision.canonicalState === 'automated_reply' || decision.finalClassification === 'OUT_OF_OFFICE')
    return skip('automated_reply');
  return { eligible: true, reason: null, item: {
    leadId: String(lead.id), messageId: String(message.messageId), source: 'reply_pass',
    threadId: message.threadId || null, senderInboxId: message.senderInboxId || null,
    campaign: lead.campaign || null, productionRoute: decision.route || null,
  } };
}

/** Phase 1 eligibility: one genuine human message that is still the latest. */
function stateEligibility(state, messageId) {
  if (!state || state.identity?.family !== 'industrial_staffing') return 'not_staffing_state';
  if (state.identity?.clientId !== DEFAULT_CLIENT_ID) return 'not_scalelab_client';
  const target = (state.turns || []).find(turn => turn.direction === 'inbound' && turn.messageId === messageId);
  if (!target) return 'inbound_absent';
  if (target.automatedReply || target.genuineHuman !== true) return 'not_genuine_human';
  return null;
}

function assessAdvisory(state, record) {
  const permission = evaluateAgentV2Permission(state, record);
  const wording = renderAgentV2Wording({ state, record, permission });
  return {
    permission: { verdict: permission.verdict, reasonCode: permission.reasonCode },
    wording: { status: wording.status, reasonCode: wording.reasonCode, text: wording.wording || null },
  };
}

/**
 * One bounded shadow pass. Never throws; returns counts for logging.
 *   candidates   items from shadowCandidate() for messages decided this pass
 *   createStore  () => Agent v2 Postgres store (restricted worker role)
 *   loadEvidence (leadId) => { lead, state } built from one fresh snapshot
 */
async function runAgentV2ShadowPass({ candidates = [], env = process.env, createStore, loadEvidence,
  model, createMessage, now, log = () => {}, maxEvaluations = DEFAULT_MAX_EVALUATIONS,
  retryLimit = DEFAULT_RETRY_LIMIT } = {}) {
  const config = agentV2ShadowConfig(env);
  const summary = { status: 'ok', considered: 0, evaluated: 0, reused: 0, calledModel: 0,
    retried: 0, skipped: 0, failed: 0, busy: 0 };
  if (!config.shadowEnabled) return { ...summary, status: 'disabled' };
  if (!config.keyConfigured || !config.ledgerConfigured) {
    log({ event: 'agent_v2_shadow_unconfigured', keyConfigured: config.keyConfigured,
      ledgerConfigured: config.ledgerConfigured });
    return { ...summary, status: 'unconfigured' };
  }
  if (typeof createStore !== 'function' || typeof loadEvidence !== 'function')
    return { ...summary, status: 'unavailable' };
  let store;
  try {
    store = createStore();
    const queue = new Map();
    for (const item of candidates) {
      if (!item?.leadId || !item?.messageId) continue;
      queue.set(decisionIdFor(item.leadId, item.messageId), item);
    }
    let retryRows = [];
    try { retryRows = await store.listRetryable({ limit: retryLimit }); }
    catch (error) { log({ event: 'agent_v2_shadow_retry_list_failed', error: String(error.message || '').slice(0, 160) }); }
    for (const row of retryRows) {
      const id = decisionIdFor(row.lead_id, row.message_id);
      if (!queue.has(id)) queue.set(id, { leadId: row.lead_id, messageId: row.message_id, source: 'retry' });
    }
    const items = [...queue.values()].slice(0, Math.max(0, maxEvaluations));
    if (!items.length) return summary;
    await store.verifyPrivileges();
    for (const item of items) {
      summary.considered += 1;
      let evidence;
      try { evidence = await loadEvidence(item.leadId); }
      catch (error) {
        summary.skipped += 1;
        log({ event: 'agent_v2_shadow_skipped', lead_id: item.leadId, message_id: item.messageId,
          source: item.source, reason: 'evidence_unavailable' });
        continue;
      }
      // A retry of an already-claimed message goes back through the worker
      // even if it is no longer eligible: the worker's deterministic guards
      // then finalize it. One whose input can no longer be built at all is
      // closed, so a stale retry cannot be listed forever.
      if (item.source === 'retry') {
        try { buildAgentV2Input(evidence?.state, item.messageId); }
        catch (error) {
          summary.skipped += 1;
          let closed = false;
          try { closed = await store.abandonRetry(decisionIdFor(item.leadId, item.messageId), 'input_unbuildable'); }
          catch (_) { /* listed again next pass */ }
          log({ event: 'agent_v2_shadow_retry_abandoned', lead_id: item.leadId, message_id: item.messageId,
            reason: 'input_unbuildable', closed });
          continue;
        }
      }
      const reason = item.source === 'retry' ? null : stateEligibility(evidence?.state, item.messageId);
      if (reason) {
        summary.skipped += 1;
        log({ event: 'agent_v2_shadow_skipped', lead_id: item.leadId, message_id: item.messageId,
          source: item.source, reason });
        continue;
      }
      try {
        const result = await evaluateAgentV2Shadow({ state: evidence.state, messageId: item.messageId,
          store, model, createMessage, apiKey: env.ANTHROPIC_AGENT_V2_KEY, now: now || new Date(),
          evidence: { source: item.source, threadId: item.threadId, senderInboxId: item.senderInboxId,
            campaign: item.campaign || evidence.lead?.campaign || null, productionRoute: item.productionRoute },
          assess: assessAdvisory });
        if (result.busy) summary.busy += 1;
        else if (result.reused) summary.reused += 1;
        else summary.evaluated += 1;
        if (result.calledModel) summary.calledModel += 1;
        if (item.source === 'retry' && !result.reused && !result.busy) summary.retried += 1;
        const record = result.record || {};
        log({ event: 'agent_v2_shadow', lead_id: item.leadId, message_id: item.messageId,
          source: item.source, reused: Boolean(result.reused), busy: Boolean(result.busy),
          called_model: Boolean(result.calledModel), model_status: record.modelStatus || null,
          action: record.decision?.actionId || null, decision_status: record.decision?.status || null,
          permission: record.shadow?.permission?.verdict || null, retryable: Boolean(record.retryable),
          error_category: record.errorCategory || null, attempt: record.attempt || null,
          latency_ms: Math.round(Number(record.latencyMs || 0)) || null, send_authority: false });
      } catch (error) {
        summary.failed += 1;
        log({ event: 'agent_v2_shadow_failed', lead_id: item.leadId, message_id: item.messageId,
          source: item.source, error: String(error.message || '').slice(0, 160) });
      }
    }
    return summary;
  } catch (error) {
    log({ event: 'agent_v2_shadow_pass_failed', error: String(error.message || '').slice(0, 160) });
    return { ...summary, status: 'failed' };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

module.exports = { agentV2ShadowConfig, shadowCandidate, stateEligibility, runAgentV2ShadowPass,
  DEFAULT_MAX_EVALUATIONS, DEFAULT_RETRY_LIMIT };
