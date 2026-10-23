'use strict';
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('./config');
const { normalizeInput, fromLead, compareHistorical } = require('./input');
const { collectSources } = require('./sources');
const { createStore } = require('./store');
const { readLead } = require('./read-lead');
const { domain } = require('../staffing-research');
const { RESEARCH_PROMPT, FIT_PROMPT } = require('./prompts');
const { providerFormat } = require('./provider-output');
const { researchSchema, fitSchema, outputSchema, parseMessage, validate, validateResearch, validateFit, emptyResearch } = require('./schema');

function createAgent({ env = process.env, store = createStore({ env }), loadLead = id => readLead(id, { env }),
  research = collectSources, createMessage, logger = console } = {}) {
  async function run(raw) {
    const cfg = config(env);
    if (!cfg.enabled) throw new Error('RESEARCH_DISABLED');
    if (cfg.invalidMode) throw new Error('SHADOW_MODE_REQUIRED');
    // Validate transport input before reserving a run. Rejected requests are not
    // executions. Everything after this point has a durable running record.
    let input = normalizeInput(raw);
    const historicalRequested = raw.historicalDecision;
    compareHistorical(historicalRequested, { classification: '', confidence: 0 });
    if (raw.researchRunId !== undefined && (typeof raw.researchRunId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.researchRunId))) throw new Error('INVALID_INPUT');
    const runId = crypto.randomUUID(), started = Date.now(), startedAt = new Date(started).toISOString();
    await store.start({ run_id: runId, started_at: startedAt, lead_id: input.leadId,
      company: input.company.name, domain: input.company.domain, campaign_id: input.campaign.id,
      agent: cfg.agent, version: cfg.version, mode: cfg.mode, model: cfg.model, status: 'running',
      input_snapshot: input, research_run_id: raw.researchRunId || null, provider_responses: [] });
    let companyResearch = emptyResearch(), sources = [], warnings = [], usage = [], errorCode = null;
    const providerResponses = [];
    let historical = historicalRequested;
    let campaignFit = { campaignId: input.campaign.id, classification: 'INSUFFICIENT_EVIDENCE', confidence: 0,
      reasons: [], disqualifiers: [], evidenceIndexes: [] };
    const fail = (code, classification = 'INSUFFICIENT_EVIDENCE') => {
      errorCode = code; campaignFit = { campaignId: input.campaign.id, classification, confidence: 0,
        reasons: [code], disqualifiers: [], evidenceIndexes: [] };
    };
    try {
      if (input.leadId) {
        let lead;
        try { lead = await loadLead(input.leadId); } catch { throw new Error('LEAD_READ_FAILED'); }
        if (!lead) throw new Error('LEAD_NOT_FOUND');
        // Stored lead identity wins; arbitrary company overrides cannot relabel a historical lead.
        input = normalizeInput(fromLead(lead, raw.campaign));
        historical = historicalRequested ?? lead.historicalDecision ?? lead.researchClassification ?? null;
        if (typeof historical !== 'string' && historical !== null) {
          historical = null;
          warnings.push('HISTORICAL_DECISION_UNREADABLE');
        } else if (historical?.length > 250) {
          historical = null;
          warnings.push('HISTORICAL_DECISION_UNREADABLE');
        }
      }
      campaignFit.campaignId = input.campaign.id;
      if (!cfg.apiKey) throw new Error('MISSING_RESEARCH_API_KEY');
      if (!input.campaign.id || !Object.values(input.campaign.icp).some(v => typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : v && typeof v === 'object' && Object.keys(v).length)) throw new Error('MISSING_CAMPAIGN_ICP');
      let send = createMessage;
      if (!send) {
        const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: 60000 });
        send = payload => client.messages.create(payload);
      }
      const call = async (phase, system, data, schema) => {
        let message;
        try { message = await send({ model: cfg.model, max_tokens: 6500, system,
          output_config: { format: providerFormat(schema) },
          messages: [{ role: 'user', content: JSON.stringify(data) }] }); }
        catch { throw new Error('MODEL_PROVIDER_FAILURE'); }
        // Snapshot before parsing/normalization; retain exact text and provider
        // metadata in the protected audit row, never in ordinary logs/results.
        const audit = { phase, response: structuredClone(message), validation: 'pending' };
        // The SDK attaches this header as a non-enumerable property, so cloning
        // the message alone loses it. Retain it explicitly for provider support.
        if (typeof message?._request_id === 'string') audit.response._request_id = message._request_id;
        providerResponses.push(audit);
        usage.push({ phase, model: typeof message?.model === 'string' ? message.model : cfg.model,
          inputTokens: Number(message?.usage?.input_tokens) || 0, outputTokens: Number(message?.usage?.output_tokens) || 0 });
        try {
          const parsed = parseMessage(message, schema);
          audit.validation = 'schema_validated';
          return parsed;
        } catch (error) {
          audit.validation = error.stage || 'invalid_response';
          throw error;
        }
      };
      if (raw.researchRunId) {
        const previous = await store.get(raw.researchRunId);
        if (!previous || previous.status !== 'succeeded' || previous.version !== cfg.version
          || !input.company.domain || previous.domain !== input.company.domain) throw new Error('INVALID_RESEARCH_REUSE');
        sources = previous.sources;
        companyResearch = validateResearch(structuredClone(previous.output.companyResearch), sources);
        warnings.push('REUSED_RESEARCH_SNAPSHOT_CHECK_AGE');
      } else {
        let retrieved;
        try { retrieved = await research(input.company); } catch { throw new Error('RETRIEVAL_FAILURE'); }
        sources = retrieved.sources;
        warnings.push(...retrieved.warnings);
        if (retrieved.retrievalFailed) throw new Error('RETRIEVAL_FAILURE');
        if (retrieved.insufficient) {
          campaignFit.reasons = ['No substantive company evidence available.'];
          warnings.push('INSUFFICIENT_COMPANY_DATA');
        } else {
          companyResearch = validateResearch(await call('research', RESEARCH_PROMPT, { company: input.company, sources }, researchSchema), sources);
        }
      }
      if (companyResearch.evidence.length) {
        if (companyResearch.domain && input.company.domain && domain(companyResearch.domain) !== input.company.domain) {
          companyResearch = emptyResearch();
          throw new Error('RESEARCH_IDENTITY_CONFLICT');
        }
        campaignFit = validateFit(await call('campaign_fit', FIT_PROMPT, {
          companyResearch, sources, campaign: input.campaign,
        }, fitSchema), input.campaign.id, companyResearch);
        // Retrieval state belongs to the transport, not model opinion.
        if (campaignFit.classification === 'RETRIEVAL_FAILURE') throw new Error('INVALID_MODEL_RETRIEVAL_STATE');
      }
    } catch (error) {
      const allowed = ['LEAD_READ_FAILED', 'LEAD_NOT_FOUND', 'MISSING_RESEARCH_API_KEY', 'MISSING_CAMPAIGN_ICP',
        'MODEL_PROVIDER_FAILURE', 'MALFORMED_MODEL_JSON', 'RETRIEVAL_FAILURE', 'INVALID_RESEARCH_REUSE'];
      const code = allowed.includes(error.message) ? error.message : 'INVALID_MODEL_OUTPUT';
      fail(code, ['LEAD_READ_FAILED', 'LEAD_NOT_FOUND', 'MODEL_PROVIDER_FAILURE', 'RETRIEVAL_FAILURE'].includes(code) ? 'RETRIEVAL_FAILURE' : 'INSUFFICIENT_EVIDENCE');
      warnings.push(code);
    }
    const output = validate({ agent: cfg.agent, version: cfg.version, mode: cfg.mode, companyResearch, campaignFit, warnings }, outputSchema);
    const comparison = compareHistorical(historical, campaignFit);
    const completed = { completed_at: new Date().toISOString(), lead_id: input.leadId,
      company: input.company.name, domain: input.company.domain, campaign_id: input.campaign.id,
      input_snapshot: input, sources, output, classification: campaignFit.classification, confidence: campaignFit.confidence,
      comparison, status: errorCode ? 'failed' : 'succeeded', error_code: errorCode, latency_ms: Date.now() - started, usage,
      provider_responses: providerResponses };
    try { await store.finish(runId, completed); }
    catch { logger.error?.('[research-icp]', { runId, code: 'RESEARCH_STORAGE_UNAVAILABLE' }); throw new Error('RESEARCH_STORAGE_UNAVAILABLE'); }
    logger.info?.('[research-icp]', { runId, status: completed.status, classification: campaignFit.classification });
    return { runId, status: completed.status, errorCode, result: output, comparison, model: cfg.model, usage, latencyMs: completed.latency_ms };
  }
  return { run };
}
module.exports = { createAgent };
