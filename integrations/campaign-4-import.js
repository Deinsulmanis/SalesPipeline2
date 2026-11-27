'use strict';

/**
 * Campaign 4 "HOLD Company Test" import (owner brief 2026-11-27).
 *
 * Writes new Import-stage ScaleLab leads, each carrying its sealed Campaign 4
 * profile (campaign-4-profile.js) in campaign_notes. Dedupe is strict, with no
 * second-buyer or franchise exception:
 *
 *   - an address on the global Suppression list is refused;
 *   - an address already in the lead database (any client, any campaign) is
 *     refused, except the identical Campaign 4 record, which is a safe no-op;
 *   - a company domain (the record's domain or its email domain) that already
 *     has ANY ScaleLab lead is refused: Campaign 3, Campaign 2, V1, V2 or an
 *     earlier Campaign 4 lead. So a company is never in Campaign 3 and
 *     Campaign 4, and no company ScaleLab already emailed is mailed again;
 *   - a shared franchise domain (expresspros.com, ...) is refused outright;
 *   - a record whose contact status is not VALID is refused, never written;
 *   - a record whose evidence supports no Campaign 3 copy v2 variant is refused
 *     (`held`), never written: Campaign 4 sends Campaign 3's copy exactly, so
 *     the Email 1 variant is selected HERE, server side, by the same selector
 *     (staffing-v4-copy.js selectV4Variant, copy v2) from the submitted
 *     evidence. The caller cannot name a variant, and nothing unverified is
 *     ever stated: without a verified specialization there is no COPY_C.
 *
 * `owner_approved_send_ready: true` records the owner's explicit approval and
 * seals review_status SEND_READY; without it the profile is REVIEW_READY and
 * the lead cannot be queued. The import never queues, routes or sends.
 */

const crypto = require('node:crypto');
const { classify } = require('../check-leads');
const { resolveLeadClient } = require('./clients/ownership');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const { STAFFING_CAMPAIGN_C4, STAFFING_CAMPAIGN_V4, isCampaign4Marked, isStaffingV4Marked } = require('./staffing-campaign');
const { variableProblem, selectV4Variant } = require('./staffing-v4-copy');
const { franchiseBrandOfDomain } = require('./staffing-franchise');
const { serializeC4Profile, readC4Profile, hasC4ProfileMarker, C4_VARIABLE_NAMES } = require('./campaign-4-profile');
const SELECTOR_VERSION = 'v4_variant_selector_2026_11_24_copy_v2'; // Campaign 3's v2 selector

const C4_IMPORT_SCHEMA = 'hold_company_test_campaign_4_import_v1';
const MAX_RECORDS = 500;
const US_STATE = /^[A-Z]{2}$/;
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com']);

const text = value => (value === null || value === undefined ? '' : String(value).trim());
const normalizeEmail = value => text(value).toLowerCase();
const emailDomain = email => normalizeEmail(email).split('@')[1] || '';
const normalizeDomain = value => text(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const hostOf = value => {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  try { return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
};
const workDomains = domains => [...new Set(domains.map(normalizeDomain).filter(d => d && !PERSONAL_DOMAINS.has(d)))];
const companyDomainsOf = lead => {
  const sealed = hasC4ProfileMarker(lead) ? readC4Profile(lead) : null;
  return workDomains([hostOf(lead.website), emailDomain(lead.email), sealed?.ok ? sealed.profile.company_domain : '']);
};

function c4ImportKeyFor(email) {
  return crypto.createHash('sha256').update(`${STAFFING_CAMPAIGN_C4.id}|${normalizeEmail(email)}`).digest('hex').slice(0, 32);
}

function validateC4Payload(payload = {}) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_payload' }); };
  if (!payload || typeof payload !== 'object') fail('payload must be an object');
  if (payload.schema !== C4_IMPORT_SCHEMA) fail(`schema must be ${C4_IMPORT_SCHEMA}`);
  if (!Array.isArray(payload.records) || !payload.records.length) fail('records must be a non-empty array');
  if (payload.records.length > MAX_RECORDS) fail(`at most ${MAX_RECORDS} records per request`);
  if (!text(payload.sourcing_run_id)) fail('sourcing_run_id is required');
  return { records: payload.records, sourcingRunId: text(payload.sourcing_run_id), sendReady: payload.owner_approved_send_ready === true };
}

/** Which campaign an existing ScaleLab lead belongs to, for the refusal code. */
function campaignOf(lead) {
  if (isCampaign4Marked(lead)) return 'campaign_4';
  if (isStaffingV4Marked(lead) || text(lead.campaign) === STAFFING_CAMPAIGN_V4.name) return 'campaign_3';
  return 'earlier_scalelab';
}

function indexCorpus(leads = []) {
  const byEmail = new Map();
  const scalelabDomains = new Map();
  for (const lead of leads) {
    const email = normalizeEmail(lead.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), lead]);
    const owner = resolveLeadClient(lead);
    if (!owner.ok || owner.clientId === DEFAULT_CLIENT_ID) {
      for (const domain of companyDomainsOf(lead)) scalelabDomains.set(domain, [...(scalelabDomains.get(domain) || []), lead]);
    }
  }
  return { byEmail, scalelabDomains };
}

/** Pure: which records would be written, which are already imported, and why the rest are refused. */
function evaluateCampaign4Import(payload, { leads = [], suppressedEmails = new Set() } = {}, { now = () => new Date().toISOString(), newId } = {}) {
  const request = validateC4Payload(payload);
  const index = indexCorpus(leads);
  const accepted = [];
  const alreadyImported = [];
  const refusals = [];
  const seen = new Map();
  const keysOf = record => {
    const row = record?.row || {};
    const email = normalizeEmail(row.email);
    return [`email:${email}`, ...workDomains([row.company_domain, emailDomain(email)]).map(d => `domain:${d}`)];
  };
  request.records.forEach(record => { for (const key of new Set(keysOf(record))) seen.set(key, (seen.get(key) || 0) + 1); });
  request.records.forEach((record, position) => {
    const row = record?.row || {};
    const email = normalizeEmail(row.email);
    const domain = normalizeDomain(row.company_domain);
    const company = text(row.company_name);
    const firstName = text(row.first_name);
    const state = text(row.state).toUpperCase();
    const refuse = (code, reason) => refusals.push({ index: position, email, company, code, reason });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || classify(email) !== 'CLEAN') return refuse('invalid_email', 'email is missing or not deliverable-looking');
    if (PERSONAL_DOMAINS.has(emailDomain(email))) return refuse('personal_mailbox', 'a personal mailbox is not a company buyer');
    if (!domain) return refuse('missing_domain', 'company_domain is required');
    if (text(row.contact_status) !== 'VALID') return refuse('contact_not_valid', 'only VALID contacts are imported');
    if (suppressedEmails.has(email)) return refuse('suppressed', 'address is on the global suppression list');
    if (workDomains([domain, emailDomain(email)]).some(franchiseBrandOfDomain)) return refuse('franchise_domain', 'a shared franchise domain is not part of the HOLD test');
    if ([...new Set(keysOf(record))].some(key => seen.get(key) > 1)) return refuse('duplicate_in_batch', 'email or company domain repeats inside this request');
    const varProblem = ['first_name', 'company'].map(name => variableProblem(name, { first_name: firstName, company }[name])).find(Boolean);
    if (varProblem) return refuse('invalid_variable', varProblem);
    if (state && !US_STATE.test(state)) return refuse('invalid_state', 'state must be a two-letter US state code');
    const sameEmail = index.byEmail.get(email) || [];
    if (sameEmail.length) {
      const sameRecord = sameEmail.every(lead => {
        const read = readC4Profile(lead, { campaignId: STAFFING_CAMPAIGN_C4.id });
        return read.ok && normalizeEmail(read.profile.email) === email;
      });
      if (sameRecord && new Set(sameEmail.map(lead => text(lead.id))).size === 1) {
        alreadyImported.push({ index: position, email, company, leadId: text(sameEmail[0].id) });
        return undefined;
      }
      const otherClient = sameEmail.some(lead => { const owner = resolveLeadClient(lead); return owner.ok && owner.clientId !== DEFAULT_CLIENT_ID; });
      if (otherClient) return refuse('cross_client_duplicate', 'this address already exists in the lead database');
      const where = campaignOf(sameEmail[0]);
      return refuse(where === 'campaign_3' ? 'email_in_campaign_3' : where === 'campaign_4' ? 'duplicate_email' : 'email_in_earlier_campaign',
        'this address already exists in the lead database');
    }
    const domainLeads = workDomains([domain, emailDomain(email)]).flatMap(d => index.scalelabDomains.get(d) || []);
    if (domainLeads.length) {
      const where = domainLeads.map(campaignOf);
      const code = where.includes('campaign_3') ? 'company_in_campaign_3'
        : where.includes('campaign_4') ? 'company_in_campaign_4' : 'company_in_earlier_campaign';
      return refuse(code, 'a ScaleLab lead already exists for this company domain');
    }
    // Campaign 3's selector over the submitted evidence. Name, company and the
    // contact come from the row; contact QC is the VALID check above.
    const evidence = record?.evidence && typeof record.evidence === 'object' ? record.evidence : {};
    const { contactStatus: _ignored, franchise: _noFranchise, ...given } = evidence;
    let selection;
    try {
      selection = selectV4Variant({ ...given, firstName, company, contactName: text(`${firstName} ${text(row.last_name)}`), emailResolved: true },
        { copyVersion: 'v2' });
    } catch (error) { return refuse('invalid_evidence', error.message); }
    if (selection.status !== 'SELECTED') return refuse('held', selection.holds.join('; ') || 'no verified variant');
    const vars = selection.vars || {};
    const used = selection.evidence || {};
    const profile = {
      campaign_id: STAFFING_CAMPAIGN_C4.id, company, company_domain: domain,
      contact_name: text(`${firstName} ${text(row.last_name)}`), email,
      hq_state: state, hold_reason: text(row.hold_reason).slice(0, 300), source: text(row.source).slice(0, 80),
      gate_run: text(row.gate_run).slice(0, 80), contact_status: 'VALID',
      review_status: request.sendReady ? 'SEND_READY' : 'REVIEW_READY', copy_version: 'v2',
      copy_status: 'SELECTED', copy_variant: selection.variant,
      ...Object.fromEntries(C4_VARIABLE_NAMES.map(name => [`var_${name}`, typeof vars[name] === 'string' ? vars[name] : ''])),
      evidence_kind: selection.form ? `${selection.variant}_${selection.form}` : selection.variant,
      evidence_url: text(used.url), evidence_quote: text(used.quote || used.text).slice(0, 600),
      evidence_observed_at: text(used.lastSeen || used.observedAt || used.announcedAt || used.appointedAt),
      selection_considered: (selection.considered || []).map(item => `${item.variant}: ${item.outcome} (${item.detail})`),
      selector_version: SELECTOR_VERSION,
      sourcing_run_id: request.sourcingRunId, imported_at: String(now()),
    };
    let campaignNotes;
    try { campaignNotes = serializeC4Profile(profile); } catch (error) { return refuse('profile_invalid', error.message); }
    const sealed = readC4Profile({ campaign_notes: campaignNotes }, { campaignId: STAFFING_CAMPAIGN_C4.id });
    if (!sealed.ok) return refuse('profile_integrity_failed', sealed.detail || sealed.reason);
    accepted.push({
      index: position, importKey: c4ImportKeyFor(email), variant: selection.variant, form: selection.form || '',
      lead: {
        id: newId ? newId() : '', company, contactName: profile.contact_name, email, city: '',
        tradeType: '', website: `https://${domain}`,
        stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '',
        notes: '', reviewCount: '', rating: '', tier: '', siteContext: '',
        campaign: STAFFING_CAMPAIGN_C4.name, campaign_notes: campaignNotes, enrichment_attempted: '',
        leadNiche: STAFFING_CAMPAIGN_C4.niche,
        // Explicit Campaign 4 identity from the first write; no sender, nothing routed.
        senderInboxId: '', emailTemplateId: STAFFING_CAMPAIGN_C4.emailTemplateId, routingRequired: 'true',
        intendedCampaignVersion: STAFFING_CAMPAIGN_C4.id, clientId: DEFAULT_CLIENT_ID,
      },
    });
    return undefined;
  });
  const refusalsByCode = {};
  for (const refusal of refusals) refusalsByCode[refusal.code] = (refusalsByCode[refusal.code] || 0) + 1;
  return { request, accepted, alreadyImported, refusals, refusalsByCode };
}

/** The import. `dryRun` (the default) writes nothing. */
async function importCampaign4Leads({ payload, dryRun = true, readCorpus, appendLeads, mirrorLeads, newId, now } = {}) {
  if (!readCorpus || !appendLeads || !mirrorLeads || !newId) throw new Error('Campaign 4 import requires readCorpus, appendLeads, mirrorLeads and newId');
  validateC4Payload(payload);
  const corpus = await readCorpus();
  const result = evaluateCampaign4Import(payload, corpus, { now, newId });
  const leads = result.accepted.map(item => item.lead);
  let written = 0;
  let mirror = null;
  if (!dryRun && leads.length) {
    await appendLeads(leads);
    written = leads.length;
    mirror = await mirrorLeads(leads);
  }
  return {
    dryRun: Boolean(dryRun), campaignId: STAFFING_CAMPAIGN_C4.id, campaign: STAFFING_CAMPAIGN_C4.name,
    templateId: STAFFING_CAMPAIGN_C4.emailTemplateId, sourcingRunId: result.request.sourcingRunId, sendReady: result.request.sendReady,
    received: result.request.records.length, accepted: leads.length, alreadyImported: result.alreadyImported.length,
    refused: result.refusals.length, written, mirror,
    byVariant: result.accepted.reduce((acc, item) => { const key = item.form ? `${item.variant}_${item.form}` : item.variant; acc[key] = (acc[key] || 0) + 1; return acc; }, {}),
    leads: result.accepted.map(item => ({ index: item.index, id: item.lead.id, email: item.lead.email, company: item.lead.company, variant: item.variant })),
    alreadyImportedLeads: result.alreadyImported, refusals: result.refusals, refusalsByCode: result.refusalsByCode,
  };
}

module.exports = { C4_IMPORT_SCHEMA, MAX_RECORDS, validateC4Payload, evaluateCampaign4Import, importCampaign4Leads, c4ImportKeyFor };
