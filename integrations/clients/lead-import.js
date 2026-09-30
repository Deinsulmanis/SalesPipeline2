'use strict';

/**
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
const { clientCampaign } = require('./campaigns');
const { checkClientConsistency, resolveLeadClient } = require('./ownership');
const { emailTakenFor, emailUniquenessMode } = require('./email-scope');

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

module.exports = { validateClientLeadImport };
