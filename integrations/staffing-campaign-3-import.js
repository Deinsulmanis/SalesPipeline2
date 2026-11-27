'use strict';

/**
 * Industrial Campaign 3 (staffing V4) import.
 *
 * Writes new Import-stage ScaleLab leads, each carrying its sealed V4 profile
 * (staffing-v4-profile.js) in campaign_notes. The Email 1 variant is selected
 * HERE, server side, from the submitted evidence (staffing-v4-copy.js); the
 * caller cannot name a variant. Dedupe and suppression follow the V2 import:
 *
 *   - an address on the global Suppression list is refused;
 *   - an address already in the lead database (any client) is refused, except
 *     the identical Campaign 3 record, which is a safe no-op;
 *   - a company domain that already has a ScaleLab lead (V1, Campaign 2, V2,
 *     Campaign 4, anything) is refused, so no previously contacted company is re-mailed;
 *     the one exception is an owner-approved SECOND BUYER (below);
 *   - a record whose selection is HOLD (no verified variant, unresolved email,
 *     contact QC not READY_FOR_REVIEW) is refused, never written.
 *
 * Second buyer (owner decision 2026-11-24): with `owner_approved_second_buyer:
 * true` on the request, a record carrying `second_buyer.prior_lead_ids` may add a
 * DIFFERENT person at a company ScaleLab already emailed, only when every
 * existing ScaleLab lead at that company is declared in prior_lead_ids and each
 * one finished or stopped its sequence at least 14 days ago (owner decision
 * 2026-11-26; was 30) with no reply (an
 * out-of-office is not a reply), no opt-out, no non-bounce suppression, is not
 * queued or in a pipeline stage, and the company has no Campaign 3 lead yet. The
 * prior rows are never read for copy and never written. Anything else stays
 * `duplicate_company` or a specific second_buyer_* refusal.
 *
 * Franchise location (owner decision 2026-11-25): an address or company domain
 * on a shared franchise domain (expresspros.com, pridestaff.com, ...; see
 * staffing-franchise.js) is never deduped by that domain. It needs
 * `owner_approved_franchise: true` on the request and `row.franchise`
 * {brand, owner_key, territory, city}; it is refused when the same owner or the
 * same brand + territory already has a ScaleLab lead or repeats in the batch.
 * The identity is sealed into the profile; `city` feeds the v2 city line.
 *
 * `owner_approved_send_ready: true` records the owner's explicit approval and
 * seals review_status SEND_READY; without it the profile is REVIEW_READY and
 * the lead cannot be queued. The import never queues, routes or sends: that is
 * the existing queue endpoint's job, behind every existing gate.
 */

const crypto = require('node:crypto');
const { classify } = require('../check-leads');
const { resolveLeadClient } = require('./clients/ownership');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const { STAFFING_CAMPAIGN_V4, isCampaign4Marked } = require('./staffing-campaign');
const { selectV4Variant, CURRENT_COPY_VERSION } = require('./staffing-v4-copy');
const { franchiseBrandOfDomain, franchiseIdentityProblem, franchiseKeys } = require('./staffing-franchise');
const {
  buildStaffingV4Profile, serializeStaffingV4Profile, readStaffingV4Profile, hasStaffingV4ProfileMarker,
} = require('./staffing-v4-profile');

const IMPORT_SCHEMA = 'industrial_campaign_3_import_v1';
const SECOND_BUYER_MIN_DAYS = 14; // owner decision 2026-11-26 (was 30)
const SECOND_BUYER_PRIOR_STAGES = new Set(['Done', 'Contacted', 'Review', 'Archived']);
const OPT_OUT_MARKER = /\[REPLY:\s*(?:Unsubscribed|Not Interested)/i;
const REPLY_MARKER = /\[REPLY(?: PRIORITY)?:(?!\s*OOO)/i; // any reply marker except out-of-office
const BOUNCE_MARKER = /\[BOUNCED/i;
const MAX_RECORDS = 200;
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com']);

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

function importKeyFor(email) {
  return crypto.createHash('sha256').update(`${STAFFING_CAMPAIGN_V4.id}|${normalizeEmail(email)}`).digest('hex').slice(0, 32);
}

function validatePayload(payload = {}) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_payload' }); };
  if (!payload || typeof payload !== 'object') fail('payload must be an object');
  if (payload.schema !== IMPORT_SCHEMA) fail(`schema must be ${IMPORT_SCHEMA}`);
  if (!Array.isArray(payload.records) || !payload.records.length) fail('records must be a non-empty array');
  if (payload.records.length > MAX_RECORDS) fail(`at most ${MAX_RECORDS} records per request`);
  if (!text(payload.sourcing_run_id)) fail('sourcing_run_id is required');
  return {
    records: payload.records, sourcingRunId: text(payload.sourcing_run_id),
    sendReady: payload.owner_approved_send_ready === true,
    secondBuyerApproved: payload.owner_approved_second_buyer === true,
    franchiseApproved: payload.owner_approved_franchise === true,
  };
}

function indexCorpus(leads = []) {
  const byEmail = new Map();
  const scalelabDomains = new Map();
  const franchiseKeySet = new Set();
  for (const lead of leads) {
    const email = normalizeEmail(lead.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), lead]);
    const owner = resolveLeadClient(lead);
    if (!owner.ok || owner.clientId === DEFAULT_CLIENT_ID) {
      for (const domain of companyDomainsOf(lead)) scalelabDomains.set(domain, [...(scalelabDomains.get(domain) || []), lead]);
      // Franchise identity of an existing lead: its sealed profile, else (a
      // lead from before the franchise rule) brand + its contact name.
      const brand = companyDomainsOf(lead).map(franchiseBrandOfDomain).find(Boolean);
      if (brand) {
        const sealed = hasStaffingV4ProfileMarker(lead) ? readStaffingV4Profile(lead) : null;
        if (sealed?.ok && sealed.profile.franchise_owner_key) {
          for (const key of franchiseKeys({ owner_key: sealed.profile.franchise_owner_key, territory: sealed.profile.franchise_territory })) franchiseKeySet.add(key);
        } else {
          const [first = '', ...rest] = text(lead.contactName || lead.contact_name).toLowerCase().split(/\s+/);
          if (first && rest.length) franchiseKeySet.add(franchiseKeys({ owner_key: `${brand}|${first}|${rest[rest.length - 1]}` })[0]);
        }
      }
    }
  }
  return { byEmail, scalelabDomains, franchiseKeys: franchiseKeySet };
}

/**
 * Pure: may this record be a second buyer at a company that already has ScaleLab leads?
 * Returns null when allowed, else { code, reason }.
 */
function secondBuyerRefusal(record, domainLeads, request, suppressedEmails, nowIso) {
  const declared = new Set((Array.isArray(record?.second_buyer?.prior_lead_ids) ? record.second_buyer.prior_lead_ids : [])
    .map(text).filter(Boolean));
  if (!request.secondBuyerApproved || !declared.size) {
    return { code: 'duplicate_company', reason: 'a ScaleLab lead already exists for this company domain' };
  }
  const priors = [...new Map(domainLeads.map(lead => [text(lead.id), lead])).values()];
  const undeclared = priors.filter(lead => !declared.has(text(lead.id)));
  if (undeclared.length) return { code: 'second_buyer_undeclared_prior', reason: 'the company has a ScaleLab lead that was not declared as a prior contact' };
  const nowMs = Date.parse(nowIso);
  for (const prior of priors) {
    const notes = text(prior.notes);
    const stage = text(prior.stage);
    if (hasStaffingV4ProfileMarker(prior) || text(prior.campaign) === STAFFING_CAMPAIGN_V4.name) {
      return { code: 'second_buyer_company_in_campaign_3', reason: 'the company already has a Campaign 3 lead' };
    }
    // Campaign 4 (HOLD Company Test) and Campaign 3 never share a company.
    if (isCampaign4Marked(prior)) {
      return { code: 'second_buyer_company_in_campaign_4', reason: 'the company already has a Campaign 4 (HOLD Company Test) lead' };
    }
    if (OPT_OUT_MARKER.test(notes) || stage === 'Unsub') return { code: 'second_buyer_prior_opted_out', reason: 'a prior contact opted out' };
    if (REPLY_MARKER.test(notes) || text(prior.emailStatus).toLowerCase() === 'replied') {
      return { code: 'second_buyer_prior_replied', reason: 'a prior contact replied' };
    }
    if (suppressedEmails.has(normalizeEmail(prior.email)) && !BOUNCE_MARKER.test(notes)) {
      return { code: 'second_buyer_prior_suppressed', reason: 'a prior contact is suppressed for a reason other than a bounce' };
    }
    if (!SECOND_BUYER_PRIOR_STAGES.has(stage)) return { code: 'second_buyer_prior_active', reason: `a prior contact is in stage ${stage || 'unknown'}` };
    const last = Date.parse(text(prior.lastEmailedAt));
    if (!Number.isFinite(last) || !Number.isFinite(nowMs) || nowMs - last < SECOND_BUYER_MIN_DAYS * 86400000) {
      return { code: 'second_buyer_prior_recent', reason: `a prior contact was emailed less than ${SECOND_BUYER_MIN_DAYS} days ago (or never)` };
    }
  }
  const found = new Set(priors.map(lead => text(lead.id)));
  if ([...declared].some(id => !found.has(id))) return { code: 'second_buyer_prior_mismatch', reason: 'a declared prior lead is not at this company' };
  return null;
}

/** Pure: which records would be written, which are already imported, and why the rest are refused. */
function evaluateCampaign3Import(payload, { leads = [], suppressedEmails = new Set() } = {}, { now = () => new Date().toISOString(), newId } = {}) {
  const request = validatePayload(payload);
  const index = indexCorpus(leads);
  const accepted = [];
  const alreadyImported = [];
  const refusals = [];
  const seen = new Map();
  const sharedFranchiseDomains = (domain, email) => workDomains([domain, emailDomain(email)]).filter(franchiseBrandOfDomain);
  const batchKeys = record => {
    const email = normalizeEmail(record?.row?.email);
    const domain = text(record?.row?.company_domain).toLowerCase().replace(/^www\./, '');
    // A shared franchise domain is not a company: its records are keyed by owner and territory instead.
    const franchise = sharedFranchiseDomains(domain, email).length;
    return [`email:${email}`, ...(franchise ? franchiseKeys(record?.row?.franchise || {}) : [`domain:${domain}`])];
  };
  request.records.forEach(record => {
    for (const key of batchKeys(record)) seen.set(key, (seen.get(key) || 0) + 1);
  });
  request.records.forEach((record, position) => {
    const row = record?.row || {};
    const evidence = record?.evidence || {};
    const email = normalizeEmail(row.email);
    const domain = text(row.company_domain).toLowerCase().replace(/^www\./, '');
    const company = text(evidence.company) || text(row.company_name);
    const refuse = (code, reason) => refusals.push({ index: position, email, company, code, reason });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || classify(email) !== 'CLEAN') return refuse('invalid_email', 'email is missing or not deliverable-looking');
    if (PERSONAL_DOMAINS.has(emailDomain(email))) return refuse('personal_mailbox', 'a personal mailbox is not a company buyer');
    if (!domain) return refuse('missing_domain', 'company_domain is required');
    if (suppressedEmails.has(email)) return refuse('suppressed', 'address is on the global suppression list');
    if (batchKeys(record).some(key => seen.get(key) > 1)) return refuse('duplicate_in_batch', 'email, company domain or franchise owner/territory repeats inside this request');
    const sharedDomains = sharedFranchiseDomains(domain, email);
    const franchise = sharedDomains.length ? row.franchise : null;
    if (sharedDomains.length) {
      if (!request.franchiseApproved) return refuse('franchise_not_approved', 'a shared franchise domain needs owner_approved_franchise');
      const problem = franchiseIdentityProblem(franchise, sharedDomains);
      if (problem) return refuse('franchise_identity_missing', problem);
      if (franchiseKeys(franchise).some(key => index.franchiseKeys.has(key))) return refuse('duplicate_franchise', 'this franchise owner or territory already has a ScaleLab lead');
    }
    const importKey = importKeyFor(email);
    const sameEmail = index.byEmail.get(email) || [];
    if (sameEmail.length) {
      const sameRecord = sameEmail.every(lead => hasStaffingV4ProfileMarker(lead) && readStaffingV4Profile(lead).ok
        && normalizeEmail(readStaffingV4Profile(lead).profile.email) === email);
      if (sameRecord && new Set(sameEmail.map(lead => text(lead.id))).size === 1) {
        alreadyImported.push({ index: position, email, company, leadId: text(sameEmail[0].id) });
        return undefined;
      }
      const otherClient = sameEmail.some(lead => { const owner = resolveLeadClient(lead); return owner.ok && owner.clientId !== DEFAULT_CLIENT_ID; });
      return refuse(otherClient ? 'cross_client_duplicate' : 'duplicate_email', 'this address already exists in the lead database');
    }
    // Shared franchise domains are deduped by owner/territory above, never as one company.
    const companyDomains = workDomains([domain, emailDomain(email)]).filter(d => !franchiseBrandOfDomain(d));
    let secondBuyer = null;
    if (companyDomains.some(d => index.scalelabDomains.has(d))) {
      const domainLeads = companyDomains.flatMap(d => index.scalelabDomains.get(d) || []);
      const blocked = secondBuyerRefusal(record, domainLeads, request, suppressedEmails, now());
      if (blocked) return refuse(blocked.code, blocked.reason);
      secondBuyer = [...new Set(domainLeads.map(lead => text(lead.id)))];
    }
    let selection;
    const selectionEvidence = franchise ? { ...evidence, franchise: { city: text(franchise.city) } } : evidence;
    try { selection = selectV4Variant(selectionEvidence, { copyVersion: CURRENT_COPY_VERSION }); } catch (error) { return refuse('invalid_evidence', error.message); }
    if (selection.status !== 'SELECTED') return refuse('held', selection.holds.join('; ') || 'no verified variant');
    const profile = buildStaffingV4Profile({
      row: { company, company_domain: domain, contact_name: evidence.contactName, email,
        v4_tag: row.v4_tag, demand_score: row.demand_score, signal_priority: row.signal_priority, ad_class: row.ad_class,
        contact_status: row.contact_status,
        ...(franchise ? { franchise: { brand: text(franchise.brand), owner_key: text(franchise.owner_key), territory: text(franchise.territory) } } : {}) },
      selection, selectedAt: now(), sourcingRunId: request.sourcingRunId,
    });
    if (request.sendReady) profile.review_status = 'SEND_READY';
    const campaignNotes = serializeStaffingV4Profile(profile);
    const sealed = readStaffingV4Profile({ campaign_notes: campaignNotes });
    if (!sealed.ok) return refuse('profile_integrity_failed', sealed.detail || sealed.reason);
    accepted.push({
      index: position, importKey, variant: selection.variant, secondBuyer: Boolean(secondBuyer), franchise: Boolean(franchise),
      lead: {
        id: newId ? newId() : '', company, contactName: text(evidence.contactName), email, city: franchise ? text(franchise.city) : '',
        tradeType: '', website: `https://${domain}`,
        stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '',
        notes: secondBuyer ? `Second buyer; prior ScaleLab lead ids: ${secondBuyer.join(', ')}` : '',
        reviewCount: '', rating: '', tier: '', siteContext: '',
        campaign: STAFFING_CAMPAIGN_V4.name, campaign_notes: campaignNotes, enrichment_attempted: '',
        leadNiche: STAFFING_CAMPAIGN_V4.niche,
        // Explicit Campaign 3 identity from the first write; no sender, nothing routed.
        senderInboxId: '', emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, routingRequired: 'true',
        intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id, clientId: DEFAULT_CLIENT_ID,
      },
    });
    return undefined;
  });
  const refusalsByCode = {};
  for (const refusal of refusals) refusalsByCode[refusal.code] = (refusalsByCode[refusal.code] || 0) + 1;
  return { request, accepted, alreadyImported, refusals, refusalsByCode };
}

/** The import. `dryRun` (the default) writes nothing. */
async function importCampaign3Leads({ payload, dryRun = true, readCorpus, appendLeads, mirrorLeads, newId, now } = {}) {
  if (!readCorpus || !appendLeads || !mirrorLeads || !newId) throw new Error('Campaign 3 import requires readCorpus, appendLeads, mirrorLeads and newId');
  validatePayload(payload);
  const corpus = await readCorpus();
  const result = evaluateCampaign3Import(payload, corpus, { now, newId });
  const leads = result.accepted.map(item => item.lead);
  let written = 0;
  let mirror = null;
  if (!dryRun && leads.length) {
    await appendLeads(leads);
    written = leads.length;
    mirror = await mirrorLeads(leads);
  }
  const byVariant = {};
  for (const item of result.accepted) byVariant[item.variant] = (byVariant[item.variant] || 0) + 1;
  return {
    dryRun: Boolean(dryRun), campaignId: STAFFING_CAMPAIGN_V4.id, templateId: STAFFING_CAMPAIGN_V4.emailTemplateId,
    sourcingRunId: result.request.sourcingRunId, sendReady: result.request.sendReady,
    received: result.request.records.length, accepted: leads.length, alreadyImported: result.alreadyImported.length,
    refused: result.refusals.length, written, mirror, byVariant,
    secondBuyers: result.accepted.filter(item => item.secondBuyer).length,
    franchiseLeads: result.accepted.filter(item => item.franchise).length,
    leads: result.accepted.map(item => ({ index: item.index, id: item.lead.id, email: item.lead.email, company: item.lead.company, variant: item.variant, secondBuyer: item.secondBuyer })),
    alreadyImportedLeads: result.alreadyImported, refusals: result.refusals, refusalsByCode: result.refusalsByCode,
  };
}

module.exports = { IMPORT_SCHEMA, MAX_RECORDS, SECOND_BUYER_MIN_DAYS, validatePayload, evaluateCampaign3Import, importCampaign3Leads, importKeyFor };
