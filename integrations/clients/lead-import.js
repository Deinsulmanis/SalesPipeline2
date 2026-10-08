'use strict';

/**
 * A managed client's lead import: validateClientLeadImport is the dry run and
 * writes nothing; importClientLeads (below) is the write that reuses it.
 *
 * Dry-run validation of a managed client's lead import. Writes nothing.
 *
 * It proposes the exact routing fields a lead would be stored with, then
 * proves each proposed lead resolves to the importing client and to nothing
 * else. Refusals:
 *
 *   cross_client_collision   the address is another client's lead while global
 *                            email uniqueness is still in force (the database
 *                            has not dropped its global index yet). Under
 *                            tenant-scoped uniqueness (OUTREACH_EMAIL_UNIQUENESS
 *                            =client) the same person may be a lead of two
 *                            clients, and this refusal no longer applies.
 *   duplicate                already this client's lead (or a lead whose owner
 *                            is unknown), or repeated in the batch
 *   globally_suppressed      on the global Suppression list
 *   ownership_conflict       a field would make the lead read as another
 *                            client's (e.g. a trade type containing "staffing",
 *                            which ScaleLab's legacy resolvers match anywhere)
 *   invalid                  missing company or unusable email
 *
 * Research spreadsheets are not leads. Nothing here turns a file into a CRM
 * record; an import is a separate, explicit operator action.
 */

const { classify } = require('../../check-leads');
const { getClient } = require('./registry');
const { clientCampaign, CAMPAIGN_STATUS } = require('./campaigns');
const { checkClientConsistency, resolveLeadClient } = require('./ownership');
const { emailTakenFor, emailUniquenessMode } = require('./email-scope');
const { evaluateScopedSuppression } = require('./suppression');

const norm = value => String(value || '').trim().toLowerCase();

function validateClientLeadImport({ clientId, campaignId, rows = [], existingLeads = [], suppressedEmails = new Set(), env = process.env } = {}) {
  const client = getClient(clientId);
  if (client.isDefault) throw Object.assign(new Error('ScaleLab leads use the existing import'), { code: 'use_legacy_import' });
  const campaign = clientCampaign(campaignId);
  if (!campaign || campaign.clientId !== client.id) {
    throw Object.assign(new Error(`campaign ${campaignId || '(blank)'} is not a ${client.displayName} campaign`), { code: 'client_ownership_conflict' });
  }
  const mode = emailUniquenessMode(env);
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  (Array.isArray(rows) ? rows : []).slice(0, 5000).forEach((row, index) => {
    const email = norm(row.email);
    const refuse = (code, reason) => rejected.push({ index, email, company: String(row.company || ''), code, reason });
    if (!String(row.company || '').trim()) return refuse('invalid', 'company is required');
    if (!email || classify(email) !== 'CLEAN') return refuse('invalid', 'email is missing or not deliverable-looking');
    if (seen.has(email)) return refuse('duplicate', 'repeated in this batch');
    seen.add(email);
    if (suppressedEmails.has(email)) return refuse('globally_suppressed', 'address is on the global suppression list');
    const taken = emailTakenFor({ email, clientId: client.id, leads: existingLeads, env });
    if (taken.taken) {
      const existingOwner = resolveLeadClient(taken.existing);
      const sameClient = existingOwner.ok && existingOwner.clientId === client.id;
      return refuse(mode === 'global' && !sameClient ? 'cross_client_collision' : 'duplicate', taken.reason);
    }
    const proposed = {
      company: String(row.company).trim(), contactName: String(row.contactName || '').trim(), email,
      city: String(row.city || '').trim(), website: String(row.website || '').trim(),
      tradeType: String(row.tradeType || '').trim(),
      // ICP evidence travels in siteContext, which no resolver reads.
      siteContext: String(row.evidence || row.siteContext || '').trim().slice(0, 2000),
      stage: 'Import', emailStatus: '', emailStep: '', notes: '',
      campaign: campaign.id, leadNiche: campaign.leadType, emailTemplateId: campaign.emailTemplateId,
      intendedCampaignVersion: campaign.id, routingRequired: 'true', senderInboxId: '',
      // Explicit owner from the first write.
      clientId: client.id,
    };
    const verdict = checkClientConsistency({ lead: proposed, expectedClientId: client.id });
    if (!verdict.ok) return refuse('ownership_conflict', verdict.reason);
    accepted.push(proposed);
  });
  return {
    dryRun: true, writes: 0, clientId: client.id, campaignId: campaign.id, emailUniqueness: mode,
    accepted: accepted.length, rejected: rejected.length, leads: accepted, refusals: rejected,
  };
}

const MAX_IMPORT_ROWS = 5000;

/**
 * The write half of a managed client's import. Writes only Import-stage leads
 * that have no sender; it never queues, routes, reserves or sends.
 *
 * It re-runs validateClientLeadImport against a FRESH read of the
 * authoritative corpus (never a cache), then applies the client's own
 * suppression list on top of the global one, and appends only what both
 * accepted. Retrying is safe: a row an earlier attempt wrote is now this
 * client's lead and is refused as a duplicate, so it is never written twice.
 *
 * Storage is the caller's (server.js owns Sheets and the Supabase mirror):
 *   readCorpus()                  → { leads, suppressedEmails }, fresh; throws when unreadable
 *   readClientSuppressions(id)    → { available, entries } (or { error })
 *   appendLeads(leads)            → the authoritative write of full ColdEmail rows
 *   mirrorLeads(leads)            → optional, after the append; reported, never trusted for dedupe
 */
async function importClientLeads({
  clientId, campaignId, rows, dryRun = false, readCorpus, readClientSuppressions, appendLeads,
  mirrorLeads = null, newId, env = process.env,
} = {}) {
  const client = getClient(clientId);
  if (client.isDefault) throw Object.assign(new Error('ScaleLab leads use the existing import'), { code: 'use_legacy_import' });
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('rows must be a non-empty array'), { code: 'invalid_rows' });
  // The validator considers only the first 5000 rows; a write must not drop the rest silently.
  if (rows.length > MAX_IMPORT_ROWS) throw Object.assign(new Error(`at most ${MAX_IMPORT_ROWS} rows per import`), { code: 'too_many_rows' });
  // Leads land only where the client's senders may one day send them: a
  // disabled campaign, or one outside the client's sender allowlist, would
  // strand them (and invite repurposing a campaign written for another ICP).
  const campaign = clientCampaign(campaignId);
  const allowed = client.senderPolicy?.allowedCampaignIds;
  if (campaign && campaign.clientId === client.id
    && (campaign.status === CAMPAIGN_STATUS.DISABLED || (Array.isArray(allowed) && allowed.length && !allowed.includes(campaign.id)))) {
    throw Object.assign(new Error(`${campaign.id} does not accept ${client.displayName} imports`), { code: 'campaign_not_importable' });
  }

  const corpus = await readCorpus();
  const suppressedEmails = corpus.suppressedEmails || new Set();
  const clientEntries = await readClientSuppressions(client.id);
  if (client.sending.clientSuppressionRequired && clientEntries?.available !== true) {
    throw Object.assign(new Error(`${client.displayName} requires its suppression list, which is not available${clientEntries?.error ? `: ${clientEntries.error}` : ''}`),
      { code: 'client_suppression_unavailable' });
  }

  const validation = validateClientLeadImport({
    clientId: client.id, campaignId, rows, existingLeads: corpus.leads || [], suppressedEmails, env,
  });
  const firstIndex = new Map();
  rows.forEach((row, index) => { const email = norm(row?.email); if (email && !firstIndex.has(email)) firstIndex.set(email, index); });
  const refusals = [...validation.refusals];
  const leads = [];
  for (const proposed of validation.leads) {
    const verdict = evaluateScopedSuppression(proposed, { clientId: client.id, suppressedEmails, clientEntries });
    if (verdict) {
      refusals.push({ index: firstIndex.get(proposed.email), email: proposed.email, company: proposed.company,
        code: verdict.code === 'global' ? 'globally_suppressed' : verdict.code, reason: verdict.reason });
      continue;
    }
    // Every ColdEmail column, explicitly: nothing sent, nothing scheduled, no sender.
    leads.push({
      ...proposed, id: newId(), lastEmailedAt: '', reviewCount: '', rating: '', tier: '',
      campaign_notes: '', enrichment_attempted: '',
    });
  }
  // Last line of defence before the write: each lead must be this client's,
  // in this campaign, at Import, with no send state at all.
  for (const lead of leads) {
    const unsafe = lead.clientId !== client.id || lead.campaign !== validation.campaignId || lead.stage !== 'Import'
      || lead.senderInboxId || lead.emailStatus || lead.emailStep || lead.lastEmailedAt || !lead.id;
    if (unsafe) throw Object.assign(new Error(`refusing to write ${lead.email}: not a clean Import lead of ${client.id}`), { code: 'client_isolation_violation' });
  }

  const byCode = {};
  for (const refusal of refusals) byCode[refusal.code] = (byCode[refusal.code] || 0) + 1;
  const result = {
    dryRun: Boolean(dryRun), clientId: client.id, campaignId: validation.campaignId, emailUniqueness: validation.emailUniqueness,
    received: rows.length, accepted: leads.length, rejected: refusals.length, duplicates: byCode.duplicate || 0,
    refusalsByCode: byCode, written: 0, mirror: null, refusals,
  };
  if (dryRun || !leads.length) return result;

  await appendLeads(leads);
  result.written = leads.length;
  result.leads = leads.map(lead => ({ id: lead.id, email: lead.email }));
  if (mirrorLeads) {
    try { result.mirror = await mirrorLeads(leads); } catch (error) { result.mirror = { failed: leads.length, reason: error.message }; }
  }
  return result;
}

module.exports = { validateClientLeadImport, importClientLeads, MAX_IMPORT_ROWS };
