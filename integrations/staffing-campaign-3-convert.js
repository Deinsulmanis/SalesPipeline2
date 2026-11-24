'use strict';

/**
 * Industrial Campaign 3 conversion (2026-11-24).
 *
 * A lead that already exists as a never-contacted Staffing Outreach Campaign 2 or
 * Industrial Staffing Agency (V1) row cannot take the Campaign 3 import: its own
 * row makes the import refuse it (duplicate_email / duplicate_company), and
 * archiving that row would not help because the import reads the whole corpus.
 * Conversion seals the same V4 profile the import would write onto that ONE
 * existing row, under Campaign 3's identity, so no second row is ever created.
 *
 * Every record passes the import's own checks: deliverable, non-personal address,
 * not on the global Suppression list, and evidence that selects a verified
 * variant (selectV4Variant), sealed by the same profile builder. Nothing is
 * inferred: the record names its lead id and that lead's own address, and a lead
 * that is not exactly one untouched, unsuppressed, unrouted Import-stage V1 or
 * Campaign 2 row is refused and keeps its hold. A [MANUAL HOLD] is released only
 * when the record asks for it AND the payload carries the owner's send-ready
 * approval; opt-out, bounce and reply markers are never released here.
 *
 * Pure planning: reads nothing, writes nothing. The caller commits each patch
 * through applyLeadChanges (one compare-and-set per lead) and mirrors it.
 */

const { classify } = require('../check-leads');
const { resolveLeadClient } = require('./clients/ownership');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V4, CAMPAIGN_3_CONVERSION_PREFIX,
  staffingCampaignFor, staffingV4SendBlock, staffingV2CampaignNotesRefusal,
} = require('./staffing-campaign');
const { selectV4Variant } = require('./staffing-v4-copy');
const {
  buildStaffingV4Profile, serializeStaffingV4Profile, readStaffingV4Profile, hasStaffingV4ProfileMarker,
} = require('./staffing-v4-profile');
const { hasStaffingV2ProfileMarker } = require('./staffing-v2-profile');
const { hasStaffingHoldMarker } = require('./staffing-hold');
const { sendSuppressionReason, MANUAL_HOLD_TAG, releaseHoldFromNotes } = require('./pipeline-state');

const CONVERT_SCHEMA = 'industrial_campaign_3_convert_v1';
const MAX_RECORDS = 200;
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com']);
// Markers that end a conversation or record a bounce. Never converted, never released.
const TERMINAL_MARKERS = /\[(REPLY:|BOUNCED)/i;

const text = value => (value === null || value === undefined ? '' : String(value).trim());
const normalizeEmail = value => text(value).toLowerCase();
const emailDomain = email => normalizeEmail(email).split('@')[1] || '';
const hostOf = value => {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  try { return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
};
const workDomains = domains => [...new Set(domains.map(d => text(d).toLowerCase().replace(/^www\./, '')).filter(d => d && !PERSONAL_DOMAINS.has(d)))];
const companyDomainsOf = lead => workDomains([hostOf(lead.website), emailDomain(lead.email)]);
const neverContacted = lead => !text(lead.lastEmailedAt) && !text(lead.emailStatus) && !(Number(lead.emailStep) > 0)
  && !text(lead.senderInboxId);
// For the duplicate-domain index a lead whose ownership cannot be resolved still counts (fail safe).
const maybeScaleLab = lead => { const owner = resolveLeadClient(lead); return !owner.ok || owner.clientId === DEFAULT_CLIENT_ID; };

function validatePayload(payload = {}) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_payload' }); };
  if (!payload || typeof payload !== 'object') fail('payload must be an object');
  if (payload.schema !== CONVERT_SCHEMA) fail(`schema must be ${CONVERT_SCHEMA}`);
  if (!Array.isArray(payload.records) || !payload.records.length) fail('records must be a non-empty array');
  if (payload.records.length > MAX_RECORDS) fail(`at most ${MAX_RECORDS} records per request`);
  if (!text(payload.sourcing_run_id)) fail('sourcing_run_id is required');
  return { records: payload.records, sourcingRunId: text(payload.sourcing_run_id), sendReady: payload.owner_approved_send_ready === true };
}

/** Plan the conversion. Returns per-lead changes, the leads already converted, and every refusal. */
function planCampaign3Conversion(payload, { leads = [], suppressedEmails = new Set() } = {}, { now = () => new Date().toISOString() } = {}) {
  const request = validatePayload(payload);
  const byId = new Map();
  const byEmail = new Map();
  const byDomain = new Map();
  for (const lead of leads) {
    const id = text(lead.id);
    if (id) byId.set(id, [...(byId.get(id) || []), lead]);
    const email = normalizeEmail(lead.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), lead]);
    if (maybeScaleLab(lead)) for (const d of companyDomainsOf(lead)) byDomain.set(d, [...(byDomain.get(d) || []), lead]);
  }
  const conversions = [];
  const alreadyConverted = [];
  const refusals = [];
  const seenIds = new Set();
  const seenEmails = new Set();
  request.records.forEach((record, index) => {
    const row = record?.row || {};
    const evidence = record?.evidence || {};
    const leadId = text(record?.lead_id);
    const email = normalizeEmail(row.email);
    const domain = text(row.company_domain).toLowerCase().replace(/^www\./, '');
    const company = text(evidence.company) || text(row.company_name);
    const refuse = (code, reason) => refusals.push({ index, leadId, email, company, code, reason });
    if (!leadId) return refuse('missing_lead_id', 'lead_id is required');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || classify(email) !== 'CLEAN') return refuse('invalid_email', 'email is missing or not deliverable-looking');
    if (PERSONAL_DOMAINS.has(emailDomain(email))) return refuse('personal_mailbox', 'a personal mailbox is not a company buyer');
    if (!domain) return refuse('missing_domain', 'company_domain is required');
    if (seenIds.has(leadId) || seenEmails.has(email)) return refuse('duplicate_in_batch', 'lead id or address repeats inside this request');
    seenIds.add(leadId); seenEmails.add(email);
    const matches = byId.get(leadId) || [];
    if (matches.length !== 1) return refuse(matches.length ? 'ambiguous_lead' : 'no_lead', matches.length ? 'this id names more than one lead' : 'no lead has this id');
    const [lead] = matches;
    if (normalizeEmail(lead.email) !== email) return refuse('email_mismatch', "the record's address is not this lead's address");
    // The lead being converted must resolve to ScaleLab positively; a conflict is never converted (fail closed).
    const owner = resolveLeadClient(lead);
    if (!owner.ok) return refuse('ownership_conflict', owner.reason || 'lead ownership is unresolved');
    if (owner.clientId !== DEFAULT_CLIENT_ID) return refuse('cross_client', 'lead belongs to another client');
    // Idempotent: the same conversion already sealed on this lead is a safe no-op.
    if (hasStaffingV4ProfileMarker(lead)) {
      const read = readStaffingV4Profile(lead);
      if (read.ok && normalizeEmail(read.profile.email) === email && staffingCampaignFor(lead) === STAFFING_CAMPAIGN_V4
        && text(read.profile.sourcing_run_id).startsWith(CAMPAIGN_3_CONVERSION_PREFIX)) {
        alreadyConverted.push({ index, leadId, email });
        return undefined;
      }
      return refuse('profile_present', 'lead already carries a Campaign 3 profile; it is never replaced');
    }
    const source = staffingCampaignFor(lead);
    if (source !== STAFFING_CAMPAIGN && source !== STAFFING_CAMPAIGN_2) {
      return refuse('not_convertible', `only a V1 or Campaign 2 lead converts (this lead is in ${lead.campaign || '(no campaign)'})`);
    }
    if (hasStaffingV2ProfileMarker(lead)) return refuse('profile_present', 'lead carries a V2 sourcing profile');
    if (text(lead.stage) !== 'Import' || !neverContacted(lead)) return refuse('contacted', 'lead is past Import or has a send, sequence or sender assignment');
    const notes = String(lead.notes || '');
    if (TERMINAL_MARKERS.test(notes)) return refuse('terminal_marker', 'lead carries a reply or bounce marker');
    const releaseManualHold = record?.release_manual_hold === true;
    const held = notes.includes(MANUAL_HOLD_TAG);
    if (held && !releaseManualHold) return refuse('manual_hold', 'lead is on manual hold; set release_manual_hold with owner approval to release it');
    if (held && !request.sendReady) return refuse('manual_hold', 'releasing a manual hold requires owner_approved_send_ready');
    const suppression = sendSuppressionReason({ ...lead, notes: held ? releaseHoldFromNotes(notes) : notes }, { suppressedEmails });
    if (suppression || suppressedEmails.has(email)) return refuse('suppressed', `lead is suppressed (${suppression || 'suppression-list'})`);
    const others = (byEmail.get(email) || []).filter(other => other !== lead);
    if (others.length) return refuse('duplicate_email', 'this address also belongs to another lead');
    const domainOthers = workDomains([domain, emailDomain(email)]).flatMap(d => byDomain.get(d) || []).filter(other => other !== lead);
    if (domainOthers.length) return refuse('duplicate_company', 'another ScaleLab lead exists for this company domain');
    let selection;
    try { selection = selectV4Variant(evidence); } catch (error) { return refuse('invalid_evidence', error.message); }
    if (selection.status !== 'SELECTED') return refuse('held', selection.holds.join('; ') || 'no verified variant');
    const profile = buildStaffingV4Profile({
      row: { company, company_domain: domain, contact_name: text(evidence.contactName) || text(lead.contactName), email,
        v4_tag: row.v4_tag, demand_score: row.demand_score, signal_priority: row.signal_priority, ad_class: row.ad_class,
        contact_status: row.contact_status },
      selection, selectedAt: now(), sourcingRunId: `${CAMPAIGN_3_CONVERSION_PREFIX}${request.sourcingRunId}`,
    });
    if (request.sendReady) profile.review_status = 'SEND_READY';
    const campaignNotes = serializeStaffingV4Profile(profile);
    const sealed = readStaffingV4Profile({ campaign_notes: campaignNotes });
    if (!sealed.ok) return refuse('profile_integrity_failed', sealed.detail || sealed.reason);
    const patch = {
      campaign: STAFFING_CAMPAIGN_V4.name, campaign_notes: campaignNotes, leadNiche: STAFFING_CAMPAIGN_V4.niche,
      emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id,
      routingRequired: 'true',
    };
    if (!text(lead.company)) patch.company = company;
    if (!text(lead.website)) patch.website = `https://${domain}`;
    if (held) patch.notes = releaseHoldFromNotes(notes);
    const refusal = staffingV2CampaignNotesRefusal(lead, campaignNotes);
    if (refusal) return refuse('notes_refused', refusal);
    const after = { ...lead, ...patch };
    if (staffingCampaignFor(after) !== STAFFING_CAMPAIGN_V4) return refuse('identity', 'converted lead does not resolve to Campaign 3');
    if (hasStaffingHoldMarker(after)) return refuse('hold_marker', 'converted lead still carries a staffing hold record');
    const block = staffingV4SendBlock(after);
    if (request.sendReady && block) return refuse('not_sendable', block);
    conversions.push({
      index, leadId, email, company: text(lead.company) || company, variant: selection.variant, fromCampaign: source.name,
      releaseManualHold: held,
      expectedState: {
        campaign: String(lead.campaign || ''), campaign_notes: String(lead.campaign_notes || ''), stage: String(lead.stage || ''),
        emailStep: String(lead.emailStep || ''), senderInboxId: String(lead.senderInboxId || ''),
      },
      patch,
    });
    return undefined;
  });
  const refusalsByCode = {};
  for (const refusal of refusals) refusalsByCode[refusal.code] = (refusalsByCode[refusal.code] || 0) + 1;
  return { request, conversions, alreadyConverted, refusals, refusalsByCode };
}

/** The conversion. `dryRun` (the default) writes nothing. */
async function convertCampaign3Leads({ payload, dryRun = true, readCorpus, applyChanges, now } = {}) {
  if (!readCorpus || !applyChanges) throw new Error('Campaign 3 conversion requires readCorpus and applyChanges');
  validatePayload(payload);
  const corpus = await readCorpus();
  const plan = planCampaign3Conversion(payload, corpus, { now });
  let outcomes = [];
  if (!dryRun && plan.conversions.length) {
    outcomes = await applyChanges(plan.conversions.map(item => ({
      leadId: item.leadId, patch: item.patch, expectedState: item.expectedState,
      releaseMarkers: item.releaseManualHold ? [MANUAL_HOLD_TAG] : [],
    })));
  }
  const byVariant = {};
  for (const item of plan.conversions) byVariant[item.variant] = (byVariant[item.variant] || 0) + 1;
  const written = outcomes.filter(o => o.status === 'succeeded').length;
  return {
    dryRun: Boolean(dryRun), campaignId: STAFFING_CAMPAIGN_V4.id, templateId: STAFFING_CAMPAIGN_V4.emailTemplateId,
    sourcingRunId: plan.request.sourcingRunId, sendReady: plan.request.sendReady,
    received: plan.request.records.length, planned: plan.conversions.length, alreadyConverted: plan.alreadyConverted.length,
    refused: plan.refusals.length, written, byVariant,
    leads: plan.conversions.map(item => ({ index: item.index, id: item.leadId, email: item.email, company: item.company,
      variant: item.variant, fromCampaign: item.fromCampaign, releaseManualHold: item.releaseManualHold })),
    outcomes, alreadyConvertedLeads: plan.alreadyConverted, refusals: plan.refusals, refusalsByCode: plan.refusalsByCode,
  };
}

module.exports = { CONVERT_SCHEMA, MAX_RECORDS, validatePayload, planCampaign3Conversion, convertCampaign3Leads };
