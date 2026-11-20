'use strict';

/**
 * Staffing Outreach Campaign 2 adoption (2026-10-23).
 *
 * Campaign 2's leads were imported as plain rows, before the campaign was set
 * to send V2's Tier A / Tier B copy. Their Touch 1 needs the sealed V2 sourcing
 * profile that the prepared V2 import (schema staffing_v2_import_v2) would have
 * written on a new row. Adoption seals that same record onto the one existing,
 * never-contacted Campaign 2 row with the same address, under Campaign 2's own
 * campaign and template identity.
 *
 * Every record must pass the V2 import's own readiness checks (recordProblem)
 * unchanged. Nothing is inferred: a record that does not match exactly one
 * untouched Campaign 2 row is refused, and that row keeps its hold.
 *
 * Pure: planning reads nothing and writes nothing. The patches it returns are
 * committed by the caller through applyLeadChanges (compare-and-set).
 */

const crypto = require('node:crypto');
const {
  STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_2_ADOPTION_SCHEMA, staffingCampaignFor,
  staffingCampaign2SendBlock, staffingV2CampaignNotesRefusal, renderStaffingEmail, validateStaffingEmail,
} = require('./staffing-campaign');
const { normalizeRecord, serializeStaffingV2Profile, readStaffingV2Profile, hasStaffingV2ProfileMarker } = require('./staffing-v2-profile');
const { validatePayload, recordProblem } = require('./staffing-v2-import');

const text = value => (value === null || value === undefined ? '' : String(value).trim());
const normalizeEmail = value => text(value).toLowerCase();

function adoptionKeyFor(email, apolloPersonId) {
  return crypto.createHash('sha256').update(`${STAFFING_CAMPAIGN_2.id}|${normalizeEmail(email)}|${text(apolloPersonId)}`)
    .digest('hex').slice(0, 32);
}

const neverContacted = lead => !text(lead.lastEmailedAt) && !text(lead.emailStatus) && !(Number(lead.emailStep) > 0)
  && !text(lead.senderInboxId);

/**
 * Plan adoption of a prepared V2 import payload onto the existing Campaign 2
 * rows. Returns the per-lead patches, the rows already adopted, and every refusal.
 */
function planCampaign2Adoption(payload, { leads = [], suppressedEmails = new Set() } = {}, { now = () => new Date().toISOString(), renderOptions = {} } = {}) {
  const request = validatePayload(payload);
  const byEmail = new Map();
  for (const lead of leads) {
    const email = normalizeEmail(lead.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), lead]);
  }
  const adoptions = [];
  const alreadyAdopted = [];
  const refusals = [];
  const seen = new Set();
  request.records.forEach((record, index) => {
    const { profile, unknown } = normalizeRecord(record && typeof record === 'object' ? record : {});
    const email = normalizeEmail(profile.email);
    const refuse = (code, reason, leadId = '') => refusals.push({ index, email, company: profile.company, leadId, code, reason });
    const problem = recordProblem(profile, unknown, request.run);
    if (problem) return refuse(problem.code, problem.reason);
    if (seen.has(email)) return refuse('duplicate_in_batch', 'address repeats inside this payload');
    seen.add(email);
    if (suppressedEmails.has(email)) return refuse('suppressed', 'address is on the global suppression list');
    const matches = byEmail.get(email) || [];
    if (matches.length !== 1) {
      return refuse(matches.length ? 'duplicate_email' : 'no_campaign_2_lead',
        matches.length ? 'this address belongs to more than one lead' : 'no lead has this address');
    }
    const [lead] = matches;
    if (text(lead.campaign) !== STAFFING_CAMPAIGN_2.name) return refuse('not_campaign_2', `lead is in ${lead.campaign || '(no campaign)'}`, lead.id);
    if (text(lead.clientId || 'scalelab').toLowerCase() !== 'scalelab') return refuse('cross_client_duplicate', 'lead belongs to another client', lead.id);
    const importKey = adoptionKeyFor(email, profile.apollo_person_id);
    if (hasStaffingV2ProfileMarker(lead)) {
      const read = readStaffingV2Profile(lead);
      if (read.ok && read.profile.import_key === importKey && !staffingCampaign2SendBlock(lead)) {
        alreadyAdopted.push({ index, email, leadId: lead.id });
        return undefined;
      }
      return refuse('profile_present', 'lead already carries a different V2 profile; it is never replaced', lead.id);
    }
    if (text(lead.stage) !== 'Import' || !neverContacted(lead)) return refuse('contacted', 'lead has a send, sequence or sender assignment', lead.id);
    const domain = profile.company_domain.toLowerCase().replace(/^www\./, '');
    let campaignNotes;
    try {
      campaignNotes = serializeStaffingV2Profile({
        ...profile, email, contact_name: `${profile.first_name} ${profile.last_name}`, company_domain: domain,
        campaign_id: STAFFING_CAMPAIGN_2.id, template_id: STAFFING_CAMPAIGN_2.emailTemplateId,
      }, { import_schema: STAFFING_CAMPAIGN_2_ADOPTION_SCHEMA, import_key: importKey, imported_at: now() });
    } catch (error) { return refuse(error.code || 'invalid_profile', error.message, lead.id); }
    const patch = {
      company: profile.company, campaign_notes: campaignNotes, leadNiche: STAFFING_CAMPAIGN_2.niche,
      emailTemplateId: STAFFING_CAMPAIGN_2.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN_2.id,
    };
    const refusal = staffingV2CampaignNotesRefusal(lead, campaignNotes);
    if (refusal) return refuse('notes_refused', refusal, lead.id);
    const after = { ...lead, ...patch };
    if (staffingCampaignFor(after) !== STAFFING_CAMPAIGN_2) return refuse('identity', 'adopted lead does not resolve to Campaign 2', lead.id);
    const block = staffingCampaign2SendBlock(after);
    if (block) return refuse('not_sendable', block, lead.id);
    // Every touch must render and validate exactly as the sender will.
    for (const step of [1, 2, 3]) {
      try {
        const rendered = renderStaffingEmail(after, step, renderOptions);
        const error = validateStaffingEmail(rendered, step);
        if (error) return refuse('render_invalid', `Email ${step}: ${error}`, lead.id);
      } catch (error) { return refuse('render_failed', `Email ${step}: ${error.message}`, lead.id); }
    }
    adoptions.push({
      index, leadId: lead.id, email, company: profile.company, tier: profile.icp_tier, copyVariant: profile.copy_variant,
      expectedState: { campaign_notes: String(lead.campaign_notes || ''), stage: String(lead.stage || ''), company: String(lead.company || '') },
      patch,
    });
    return undefined;
  });
  const refusalsByCode = {};
  for (const refusal of refusals) refusalsByCode[refusal.code] = (refusalsByCode[refusal.code] || 0) + 1;
  return { request, adoptions, alreadyAdopted, refusals, refusalsByCode };
}

module.exports = { adoptionKeyFor, planCampaign2Adoption };
