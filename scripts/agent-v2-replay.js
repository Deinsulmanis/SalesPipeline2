#!/usr/bin/env node
'use strict';

/**
 * Standalone Agent v2 replay / shadow worker. Default: no model call, no write.
 * --live reads one Sheets snapshot with a read-only scope. --model permits model
 * evaluation, still read-only. --persist additionally requires the shadow-only
 * feature flag and writes ONLY agent_v2_shadow_decisions in Supabase Postgres.
 *
 * node scripts/agent-v2-replay.js --snapshot=fixtures/snapshot.json --now=2026-09-23T00:00:00Z
 * node scripts/agent-v2-replay.js --live --limit=50
 * AGENT_V2_SHADOW_ENABLED=true node scripts/agent-v2-replay.js --live --model --persist --lead=<id> --message=<provider-id>
 */

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { buildConversationState } = require('../integrations/conversation-state');
const { indexConversationEvidence, selectConversationEvidence } = require('../integrations/conversation-evidence');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { guardCode, guarded, validateModelDecision } = require('../integrations/agent-v2-validation');
const { runAgentV2Model } = require('../integrations/agent-v2-model');
const { evaluateAgentV2Shadow } = require('../integrations/agent-v2-shadow');
const { createPgAgentV2Store, assertSupabaseSessionConnectionString } = require('../integrations/agent-v2-store');
const { COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');

const CE_COLUMNS = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage', 'emailStatus',
  'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier', 'siteContext', 'campaign', 'campaign_notes',
  'enrichment_attempted', 'leadNiche', 'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];
const BOARD_COLUMNS = ['id', 'type', 'first', 'last', 'brokerage', 'tradeType', 'company', 'city', 'cityTrade', 'phone',
  'email', 'website', 'stage', 'priority', 'followup', 'notes', 'created'];

function optionsFrom(argv) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const [key, ...parts] = arg.slice(2).split('=');
    if (!['snapshot', 'now', 'lead', 'message', 'limit', 'live', 'model', 'persist'].includes(key))
      throw new Error(`unknown option: ${key}`);
    options[key] = parts.length ? parts.join('=') : true;
  }
  if (Boolean(options.snapshot) === Boolean(options.live)) throw new Error('choose exactly one of --snapshot or --live');
  if (options.snapshot && !options.now) throw new Error('--now is required for deterministic snapshot replay');
  if (options.persist && (!options.live || !options.model || process.env.AGENT_V2_SHADOW_ENABLED !== 'true'))
    throw new Error('--persist requires --live --model and AGENT_V2_SHADOW_ENABLED=true');
  if (options.persist && (!options.lead || !options.message || options.limit))
    throw new Error('--persist requires one --lead and --message, without --limit');
  if (options.persist && (!process.env.ANTHROPIC_AGENT_V2_KEY || !process.env.AGENT_V2_SUPABASE_DATABASE_URL))
    throw new Error('shadow model key and database URL required for persistence');
  if (options.persist) assertSupabaseSessionConnectionString(
    process.env.AGENT_V2_SUPABASE_DATABASE_URL, process.env.SUPABASE_URL);
  if (options.model && !process.env.ANTHROPIC_AGENT_V2_KEY)
    throw new Error('ANTHROPIC_AGENT_V2_KEY required for --model');
  if (options.limit && (!Number.isInteger(Number(options.limit)) || Number(options.limit) < 1))
    throw new Error('--limit must be a positive integer');
  return options;
}

async function liveSnapshot() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X', 'Leads!A:W', 'ColdCallActivity!A:J', 'Suppression!A:A'],
  });
  const [ce, board, activity, suppression] = response.data.valueRanges.map(range => range.values || []);
  const objects = (rows, header) => rows.slice(1).map(row =>
    Object.fromEntries(header.map((field, i) => [field, row[i] || ''])));
  return {
    leads: objects(ce, CE_COLUMNS).filter(lead => lead.id),
    boardLeads: board.slice(1).map(row => ({ ...Object.fromEntries(BOARD_COLUMNS.map((field, i) => [field, row[i] || ''])),
      meetingAt: row[20] || '', outcome: row[21] || '', conversationContext: row[22] || '' })).filter(lead => lead.id),
    activities: objects(activity, COLD_CALL_ACTIVITY_HEADER),
    suppressedEmails: suppression.slice(1).map(row => String(row[0] || '').trim().toLowerCase()).filter(Boolean),
  };
}

async function replay({ snapshot, now, leadId = '', messageId = '', limit = Infinity, model = false, persist = false,
  store = null, callModel = runAgentV2Model, apiKey = '' }) {
  if (persist && (!leadId || !messageId)) throw new Error('persistent shadow evaluation requires lead and message identity');
  const index = indexConversationEvidence(snapshot);
  const counts = { conversations: 0, inbound: 0, inputsBuilt: 0, evaluated: 0,
    attempted: 0, completed: 0, modelNotCalled: 0, persisted: 0, reused: 0, busy: 0,
    guarded: 0, modelCalls: 0, modelFailures: 0, validationFailures: 0,
    inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCostUsd: 0,
    apiCostUsd: 0, apiCostReports: 0, errors: 0,
    actions: {}, handoffs: {}, productionComparison: {}, errorsByCode: {} };
  const add = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
  for (const lead of snapshot.leads || []) {
    if (leadId && String(lead.id) !== leadId) continue;
    const selected = selectConversationEvidence(index, lead.id);
    if (!selected.lead) continue;
    let state;
    try {
      state = buildConversationState({ lead: selected.lead, boardLead: selected.boardLead,
        activities: selected.activities, selection: selected.selection,
        suppressedEmails: new Set(snapshot.suppressedEmails || []),
        config: { sequencesEnabled: true, sendingEnabled: true }, now });
    } catch (_) { counts.errors++; add(counts.errorsByCode, 'STATE_BUILD_FAILED'); continue; }
    if (state.identity.family !== 'industrial_staffing') continue;
    counts.conversations++;
    const inbound = state.turns.filter(turn => turn.direction === 'inbound');
    if (persist && (inbound[inbound.length - 1]?.messageId !== messageId
      || inbound[inbound.length - 1]?.decision?.status !== 'recorded'))
      throw new Error('target must be the latest inbound with a recorded production decision');
    for (const turn of inbound) {
      if (messageId && turn.messageId !== messageId) continue;
      counts.inbound++;
      if (!turn.messageId) { counts.errors++; add(counts.errorsByCode, 'MISSING_PROVIDER_ID'); continue; }
      try {
        counts.attempted++;
        let decision;
        if (persist) {
          const result = await evaluateAgentV2Shadow({ state, messageId: turn.messageId,
            store, model: callModel, apiKey, now });
          counts.inputsBuilt++;
          if (result.busy) { counts.busy++; return counts; }
          decision = result.record.decision;
          if (result.reused) counts.reused++;
          else { counts.persisted++; counts.completed++; }
          if (result.calledModel) counts.modelCalls++;
          if (!result.reused) {
            counts.inputTokens += Number(result.record.usage?.inputTokens || 0);
            counts.outputTokens += Number(result.record.usage?.outputTokens || 0);
            counts.latencyMs += Number(result.record.latencyMs || 0);
            counts.estimatedCostUsd += Number(result.record.estimatedCostUsd || 0);
            if (result.record.apiCostUsd != null) {
              counts.apiCostUsd += Number(result.record.apiCostUsd);
              counts.apiCostReports++;
            }
            if (['model_error', 'invalid_response', 'model_mismatch', 'key_unavailable',
              'previous_model_attempt_unresolved'].includes(result.record.modelStatus)) counts.modelFailures++;
            if (decision.status === 'invalid_model_output') counts.validationFailures++;
          }
          const production = result.record.productionDecision?.policyAction || 'MISSING';
          const policyActions = new Set(Object.values(require('../integrations/reply-response-policy').ACTION));
          add(counts.productionComparison, `${policyActions.has(production) ? production : 'OTHER'}:${decision.actionId}`);
        } else {
          const input = buildAgentV2Input(state, turn.messageId);
          counts.inputsBuilt++;
          const forced = guardCode(input);
          if (forced) decision = guarded(input, forced);
          else if (model) {
            const result = await callModel(input, { apiKey });
            counts.modelCalls++;
            counts.inputTokens += Number(result.usage?.inputTokens || 0);
            counts.outputTokens += Number(result.usage?.outputTokens || 0);
            counts.latencyMs += Number(result.latencyMs || 0);
            counts.estimatedCostUsd += Number(result.estimatedCostUsd || 0);
            if (result.apiCostUsd != null) { counts.apiCostUsd += Number(result.apiCostUsd); counts.apiCostReports++; }
            if (['model_error', 'invalid_response', 'model_mismatch', 'key_unavailable'].includes(result.status)) counts.modelFailures++;
            decision = validateModelDecision(result.raw, input);
            if (decision.status === 'invalid_model_output') counts.validationFailures++;
          } else {
            counts.modelNotCalled++;
            if (counts.inbound >= limit) return counts;
            continue;
          }
        }
        counts.evaluated++;
        if (decision.status !== 'valid') counts.guarded++;
        add(counts.actions, decision.actionId);
        if (decision.handoffCode !== 'NONE') add(counts.handoffs, decision.handoffCode);
      } catch (_) { counts.errors++; add(counts.errorsByCode, 'SHADOW_EVALUATION_FAILED'); }
      if (persist) return counts;
      if (counts.inbound >= limit) return counts;
    }
  }
  if (persist && counts.inbound !== 1) throw new Error('target inbound not found in live snapshot');
  return counts;
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const snapshot = options.live ? await liveSnapshot() : JSON.parse(fs.readFileSync(options.snapshot, 'utf8'));
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('invalid --now');
  const store = options.persist ? createPgAgentV2Store({ connectionString: process.env.AGENT_V2_SUPABASE_DATABASE_URL }) : null;
  try {
    if (store) {
      await store.verifySessionLock();
      await store.ensureSchema();
      await store.verifyPrivileges();
    }
    const result = await replay({ snapshot, now, leadId: String(options.lead || ''),
      messageId: String(options.message || ''),
      limit: options.limit ? Number(options.limit) : Infinity, model: Boolean(options.model),
      persist: Boolean(options.persist), store, apiKey: process.env.ANTHROPIC_AGENT_V2_KEY || '' });
    process.stdout.write(`${JSON.stringify({ shadowOnly: true, writes: options.persist ? 'agent_v2_shadow_decisions only' : 'none',
      sheetsReadRequests: options.live ? 1 : 0, gmailReads: 0, ...result })}\n`);
    if (result.errors) process.exitCode = 1;
  } finally { if (store) await store.close(); }
}

if (require.main === module) main().catch(error => {
  console.error(`agent v2 replay failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { optionsFrom, liveSnapshot, replay };
