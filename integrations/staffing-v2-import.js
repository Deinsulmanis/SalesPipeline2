'use strict';

/**
 * Industrial Staffing V2 lead import — the only way a V2 lead enters storage.
 *
 * It is a separate path, not a mode of the legacy ColdEmail import: the legacy
 * import keeps 11 flat columns and stamps nothing but a campaign name, which
 * would lose V2's roles/market, buyer cohort, randomization and provenance and
 * let a lead fall into V1 through the generic `industrial_staffing` niche.
 *
 * What it does:
 *  - requires an explicit V2 campaign + template identity on the request and on
 *    every record, and refuses V1's (or anything else) outright;
 *  - accepts only the sourcing system's finished `V2_READY` records, with every
 *    gate passed, structured roles + market, and a buyer cohort the run allowed;
 *  - checks every address against suppression and every client's leads, and
 *    every company/domain/Apollo identity against ScaleLab's existing leads;
 *  - writes Import-stage leads that carry their full V2 identity (campaign,
 *    template, version) and their typed sourcing profile (staffing-v2-profile.js).
 *
 * What it never does: queue, assign a sender, reserve, schedule, create sequence
 * state, activate V2 or touch STAFFING_V2_LIVE. A written lead has stage Import
 * and a blank sender; the agent sends only Queued leads, and queueing remains a
 * separate, reviewed operator action that re-checks everything.
 *
 * Retry-safe: each record's import key (campaign id + email + Apollo person id)
 * is stored in its profile. Re-submitting the same record finds its own lead and
 * reports it as already imported instead of writing it twice. A stored profile
 * that fails its integrity check is refused, never overwritten or repaired.
 */

const crypto = require('node:crypto');
const { classify } = require('../check-leads');
const { resolveLeadClient } = require('./clients/ownership');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2 } = require('./staffing-campaign');
const {
  ENUMS, PROFILE_INTEGRITY_FAILED, normalizeRecord, serializeStaffingV2Profile, hasStaffingV2ProfileMarker,
  readStaffingV2Profile,
} = require('./staffing-v2-profile');

const IMPORT_SCHEMA = 'staffing_v2_import_v1';
const V2_ID = STAFFING_CAMPAIGN_V2.id;
const V2_TEMPLATE = STAFFING_CAMPAIGN_V2.emailTemplateId;
const MAX_RECORDS = 500;
const BUYER_COHORTS = ENUMS.buyer_cohort.filter(cohort => cohort !== 'NOT_A_BUYER');

// Cohort → the priority, buyer score and assignment methods the locked V2 skill pairs with it.
const COHORT_RULES = Object.freeze({
  P1A_OWNER_EXEC: { priority: 'P1', buyerScore: 20, methods: ['RANDOMIZED_P1A', 'FALLBACK_P1A', 'ONLY_P1A'] },
  P1B_REVENUE: { priority: 'P1', buyerScore: 20, methods: ['RANDOMIZED_P1B', 'FALLBACK_P1B', 'ONLY_P1B'] },
  P2_COMMERCIAL: { priority: 'P2', buyerScore: 17, methods: ['P2_FALLBACK'] },
  P3_BRANCH_COMMERCIAL: { priority: 'P3', buyerScore: 12, methods: ['P3_REVIEW'] },
  P4_OPERATIONS_COMMERCIAL: { priority: 'P4', buyerScore: 7, methods: ['P4_REVIEW'] },
});
// The score anchors a V2_READY record can carry (SKILL.md, 100-point ICP score).
const SCORE_ANCHORS = Object.freeze({
  staffing_model_score: [25, 20, 15], vertical_score: [15, 12, 8], buyer_score: [20, 17, 12, 7],
  evidence_score: [15, 12, 8], economics_score: [10, 7, 3, 0], company_profile_score: [10, 8, 7, 5, 3],
  email_quality_score: [5, 3],
});
const PRE_REVEAL_SCORES = ['staffing_model_score', 'vertical_score', 'buyer_score', 'evidence_score',
  'economics_score', 'company_profile_score'];
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
const bareDomain = value => text(value).toLowerCase().replace(/^www\./, '');
const workDomains = domains => [...new Set(domains.map(bareDomain).filter(domain => domain && !PERSONAL_DOMAINS.has(domain)))];
// An existing lead's company domains (website host, email domain), and a record's.
const companyDomainsOf = lead => workDomains([hostOf(lead.website), emailDomain(lead.email)]);
const companyDomains = (profile, email) => workDomains([profile.company_domain, emailDomain(email)]);
// Text that is merged into an email or a sheet cell: no line breaks, template
// braces, markup or links.
const UNSAFE_TEXT = /[\r\n<>]|{{|}}|https?:\/\/|www\./i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function importKeyFor(email, apolloPersonId) {
  return crypto.createHash('sha256').update(`${V2_ID}|${normalizeEmail(email)}|${text(apolloPersonId)}`).digest('hex').slice(0, 32);
}

/** The request's own identity and run policy, or a thrown `invalid_payload`. */
function validatePayload(payload = {}) {
  const invalid = reason => Object.assign(new Error(reason), { code: 'invalid_payload' });
  if (!payload || typeof payload !== 'object') throw invalid('request body must be a V2 import object');
  if (payload.schema !== IMPORT_SCHEMA) throw invalid(`schema must be ${IMPORT_SCHEMA}`);
  const campaignId = text(payload.campaign_id);
  const templateId = text(payload.template_id);
  if (!campaignId || !templateId) throw invalid('campaign_id and template_id are required: a V2 import never infers its campaign');
  if (campaignId === STAFFING_CAMPAIGN.id || templateId === STAFFING_CAMPAIGN.emailTemplateId) {
    throw invalid('V1 campaign identity cannot enter the V2 import');
  }
  if (campaignId !== V2_ID) throw invalid(`campaign_id must be ${V2_ID}`);
  if (templateId !== V2_TEMPLATE) throw invalid(`template_id must be ${V2_TEMPLATE}`);
  const run = payload.run;
  if (!run || typeof run !== 'object') throw invalid('run policy is required');
  if (!text(run.sourcing_run_id)) throw invalid('run.sourcing_run_id is required');
  if (typeof run.catch_all_allowed !== 'boolean') throw invalid('run.catch_all_allowed must be true or false');
  if (run.allow_over_500_ready !== undefined && typeof run.allow_over_500_ready !== 'boolean') {
    throw invalid('run.allow_over_500_ready must be true or false');
  }
  const cohorts = Array.isArray(run.allowed_buyer_cohorts) ? run.allowed_buyer_cohorts.map(text) : [];
  if (!cohorts.length || cohorts.some(cohort => !BUYER_COHORTS.includes(cohort))) {
    throw invalid(`run.allowed_buyer_cohorts must list buyer cohorts from ${BUYER_COHORTS.join(', ')}`);
  }
  if (!Array.isArray(payload.records) || !payload.records.length) throw invalid('records must be a non-empty array');
  if (payload.records.length > MAX_RECORDS) throw invalid(`at most ${MAX_RECORDS} records per request`);
  return {
    campaignId, templateId, records: payload.records,
    run: { sourcingRunId: text(run.sourcing_run_id), catchAllAllowed: run.catch_all_allowed,
      allowOver500Ready: run.allow_over_500_ready === true, allowedBuyerCohorts: cohorts },
  };
}

/** Why this record is not an importable V2_READY lead, or null. Pure. */
function recordProblem(profile, unknown, run) {
  const refuse = (code, reason) => ({ code, reason });
  if (unknown.length) return refuse('unknown_field', `unknown field(s): ${unknown.slice(0, 5).join(', ')}`);
  // Explicit identity on the record itself: never inferred, never V1.
  if (!profile.campaign_id || !profile.template_id) return refuse('campaign_identity_missing', 'campaign_id and template_id are required on every record');
  if (profile.campaign_id === STAFFING_CAMPAIGN.id || profile.template_id === STAFFING_CAMPAIGN.emailTemplateId) {
    return refuse('v1_identity_refused', 'V1 campaign identity cannot enter the V2 import');
  }
  if (profile.campaign_id !== V2_ID || profile.template_id !== V2_TEMPLATE) {
    return refuse('campaign_identity_mismatch', `record must name ${V2_ID} / ${V2_TEMPLATE}`);
  }
  // Identity.
  const email = normalizeEmail(profile.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || classify(email) !== 'CLEAN') return refuse('invalid_email', 'email is missing or not deliverable-looking');
  if (PERSONAL_DOMAINS.has(emailDomain(email))) return refuse('personal_email', 'a personal mailbox is not a V2 work email');
  if (!profile.company || UNSAFE_TEXT.test(profile.company)) return refuse('company_missing', 'company is required');
  if (!profile.first_name || !profile.last_name || UNSAFE_TEXT.test(profile.first_name) || UNSAFE_TEXT.test(profile.last_name)) {
    return refuse('contact_missing', 'first_name and last_name are required');
  }
  const contactName = `${profile.first_name} ${profile.last_name}`;
  if (profile.contact_name && profile.contact_name.toLowerCase() !== contactName.toLowerCase()) {
    return refuse('contact_mismatch', 'contact_name does not match first_name + last_name');
  }
  if (profile.company_domain && !DOMAIN.test(profile.company_domain.toLowerCase().replace(/^www\./, ''))) {
    return refuse('invalid_domain', 'company_domain is not a domain');
  }
  if (profile.country !== 'US') return refuse('not_us', 'the initial V2 campaign is United States only');
  // Roles + market, structured. No fallback, no inference.
  if (!profile.roles.length) return refuse('roles_missing', 'roles are required for V2 Touch 1');
  if (profile.roles.length > 3 || profile.roles.some(role => role.length > 60 || UNSAFE_TEXT.test(role))
    || (profile.roles.length > 1 && profile.roles.some(role => / and /i.test(role)))) {
    return refuse('roles_invalid', 'roles must be 1–3 short worker roles');
  }
  if (!profile.market) return refuse('market_missing', 'market is required for V2 Touch 1');
  if (profile.market.length > 120 || UNSAFE_TEXT.test(profile.market)) return refuse('market_invalid', 'market must be a short employer description');
  // The stored proof that the agency places these roles for that market.
  if (!profile.roles_evidence || !profile.market_evidence || !profile.role_market_evidence_source) {
    return refuse('evidence_missing', 'roles_evidence, market_evidence and role_market_evidence_source are required');
  }
  // Only finished, ready records.
  if (profile.v2_status !== 'V2_READY') return refuse('not_v2_ready', `v2_status is ${profile.v2_status || '(blank)'}; only V2_READY imports`);
  for (const gate of ['hard_gate_status', 'pre_reveal_gate_status', 'post_reveal_gate_status']) {
    if (profile[gate] !== 'PASS') return refuse('gate_not_passed', `${gate} is ${profile[gate] || '(blank)'}`);
  }
  if (profile.hard_gate_failures.length) return refuse('gate_not_passed', 'hard_gate_failures is not empty');
  const statuses = { company_fit_status: 'ICP_CONFIRMED', copy_readiness_status: 'ROLE_MARKET_VERIFIED', buyer_status: 'BUYER_CONFIRMED' };
  for (const [field, expected] of Object.entries(statuses)) {
    if (profile[field] !== expected) return refuse('status_not_ready', `${field} is ${profile[field] || '(blank)'}`);
  }
  if (profile.duplicate_status !== 'CLEAR') return refuse('declared_duplicate', `duplicate_status is ${profile.duplicate_status || '(blank)'}`);
  if (profile.suppression_status !== 'CLEAR') return refuse('declared_suppressed', `suppression_status is ${profile.suppression_status || '(blank)'}`);
  // ICP lane, band and enumerated attributes.
  if (!ENUMS.icp_lane.includes(profile.icp_lane)) return refuse('invalid_lane', 'icp_lane must be TIER_A_STAFFING or TIER_B_RECRUITING');
  if (!['PRIORITY_A', 'PRIORITY_B'].includes(profile.icp_priority_band)) return refuse('invalid_band', `icp_priority_band ${profile.icp_priority_band || '(blank)'} is not importable`);
  if (!ENUMS.staffing_model.includes(profile.staffing_model) || !ENUMS.vertical.includes(profile.vertical) || profile.vertical === 'NOT_APPROVED') {
    return refuse('invalid_icp', 'staffing_model and vertical must be approved V2 values');
  }
  if (profile.vertical_sublane && !ENUMS.vertical_sublane.includes(profile.vertical_sublane)) return refuse('invalid_icp', 'vertical_sublane is not a V2 value');
  if (profile.specialty_tags.some(tag => !ENUMS.specialty_tags.includes(tag))) return refuse('invalid_icp', 'specialty_tags contains an unknown tag');
  // Buyer cohort, priority, family and assignment.
  const rules = COHORT_RULES[profile.buyer_cohort];
  if (!rules) return refuse('invalid_buyer', `buyer_cohort ${profile.buyer_cohort || '(blank)'} is not an importable buyer`);
  if (!run.allowedBuyerCohorts.includes(profile.buyer_cohort)) return refuse('cohort_not_allowed', `${profile.buyer_cohort} is not allowed by this run`);
  if (profile.buyer_priority !== rules.priority) return refuse('invalid_buyer', `buyer_priority must be ${rules.priority} for ${profile.buyer_cohort}`);
  if (!ENUMS.buyer_family.includes(profile.buyer_family) || ['RECRUITING_DELIVERY', 'INTERNAL_SUPPORT'].includes(profile.buyer_family)) {
    return refuse('invalid_buyer', 'buyer_family is not a commercial buyer');
  }
  if (!rules.methods.includes(profile.buyer_assignment_method)) {
    return refuse('invalid_assignment', `buyer_assignment_method ${profile.buyer_assignment_method || '(blank)'} does not fit ${profile.buyer_cohort}`);
  }
  if (!['', '0', '1'].includes(profile.buyer_randomization_bucket)) return refuse('invalid_assignment', 'buyer_randomization_bucket must be 0, 1 or blank');
  // Each alternate is one whole entry. Pipe-separated text would split an entry
  // into its parts, so only an array of entries can carry them.
  if (profile.alternate_buyers.some(entry => {
    const parts = entry.split('|').map(part => part.trim());
    return parts.length !== 4 || !parts[0] || !BUYER_COHORTS.includes(parts[2]);
  })) return refuse('invalid_buyer', 'alternate_buyers must be an array of "name | title | cohort | apollo_person_id" entries');
  const randomized = { RANDOMIZED_P1A: '0', RANDOMIZED_P1B: '1' }[profile.buyer_assignment_method];
  if (randomized && profile.buyer_randomization_bucket !== randomized) {
    return refuse('invalid_assignment', `${profile.buyer_assignment_method} requires bucket ${randomized}`);
  }
  // Email under the run's declared policy.
  if (profile.email_status.toLowerCase() !== 'verified') return refuse('email_not_verified', `email_status is ${profile.email_status || '(blank)'}`);
  if (!['Y', 'N'].includes(profile.catch_all_status)) return refuse('email_not_ready', 'catch_all_status must be Y or N');
  if (profile.catch_all_status === 'Y' && !run.catchAllAllowed) return refuse('catch_all_not_allowed', 'this run does not allow catch-all emails');
  const expectedReadiness = profile.catch_all_status === 'Y' ? 'EMAIL_CATCH_ALL' : 'EMAIL_READY';
  if (profile.email_readiness_status !== expectedReadiness) return refuse('email_not_ready', `email_readiness_status must be ${expectedReadiness}`);
  if (profile.reveal_result !== 'MATCHED_EMAIL') return refuse('email_not_ready', 'reveal_result must be MATCHED_EMAIL');
  if (![0, 1].includes(profile.reveal_credit_cost)) return refuse('invalid_provenance', 'reveal_credit_cost must be 0 or 1');
  // Scores: the locked anchors, consistent sums and band.
  for (const [field, anchors] of Object.entries(SCORE_ANCHORS)) {
    if (!anchors.includes(profile[field])) return refuse('invalid_score', `${field} ${profile[field] ?? '(blank)'} is not a V2_READY anchor`);
  }
  if (profile.buyer_score !== rules.buyerScore) return refuse('invalid_score', `buyer_score must be ${rules.buyerScore} for ${profile.buyer_cohort}`);
  if (profile.email_quality_score !== (profile.catch_all_status === 'Y' ? 3 : 5)) return refuse('invalid_score', 'email_quality_score does not match catch_all_status');
  const subtotal = PRE_REVEAL_SCORES.reduce((sum, field) => sum + profile[field], 0);
  if (profile.pre_reveal_subtotal !== subtotal) return refuse('invalid_score', 'pre_reveal_subtotal is not the sum of the pre-reveal scores');
  if (subtotal < 70) return refuse('invalid_score', 'pre_reveal_subtotal is below 70');
  if (profile.total_icp_score !== subtotal + profile.email_quality_score) return refuse('invalid_score', 'total_icp_score is not the sum of all scores');
  const band = profile.total_icp_score >= 85 ? 'PRIORITY_A' : profile.total_icp_score >= 75 ? 'PRIORITY_B' : null;
  if (band !== profile.icp_priority_band) return refuse('invalid_score', `total ${profile.total_icp_score} does not match ${profile.icp_priority_band}`);
  // Run-level restrictions.
  if (Number.isNaN(profile.employee_count) || (profile.employee_count !== null && profile.employee_count < 0)) {
    return refuse('invalid_icp', 'employee_count must be a whole number or blank');
  }
  if (profile.employee_count !== null && profile.employee_count > 500 && !run.allowOver500Ready) {
    return refuse('run_restriction', 'companies over 500 employees are V2_REVIEW only in this run');
  }
  // Provenance.
  if (profile.sourcing_run_id !== run.sourcingRunId) return refuse('invalid_provenance', 'sourcing_run_id does not match the run');
  if (!profile.source || !profile.source_checked_at || Number.isNaN(Date.parse(profile.source_checked_at))) {
    return refuse('invalid_provenance', 'source and a dated source_checked_at are required');
  }
  return null;
}

// Dedupe also reads a stored profile that fails its integrity check: unverified
// data may only add refusals here, never admit a record.
function dedupeProfileOf(lead) {
  const read = readStaffingV2Profile(lead);
  if (read.ok) return read.profile;
  try {
    const parsed = JSON.parse(String(lead.campaign_notes ?? lead.campaignNotes ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

/** Index the existing corpus once: emails (every client), ScaleLab companies, V2 identities. */
function indexCorpus(leads = []) {
  const byEmail = new Map();
  const scalelabDomains = new Map();
  const v2Persons = new Map();
  const v2Organizations = new Map();
  for (const lead of leads) {
    const email = normalizeEmail(lead.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), lead]);
    const owner = resolveLeadClient(lead);
    if (!owner.ok || owner.clientId === DEFAULT_CLIENT_ID) {
      for (const domain of companyDomainsOf(lead)) scalelabDomains.set(domain, [...(scalelabDomains.get(domain) || []), lead]);
    }
    if (hasStaffingV2ProfileMarker(lead)) {
      const profile = dedupeProfileOf(lead);
      if (profile) {
        const add = (map, key) => key && map.set(key, [...(map.get(key) || []), { lead, profile }]);
        add(v2Persons, text(profile.apollo_person_id));
        add(v2Organizations, text(profile.apollo_organization_id));
      }
    }
  }
  return { byEmail, scalelabDomains, v2Persons, v2Organizations };
}

const importKeyOf = lead => {
  const read = readStaffingV2Profile(lead);
  return read.ok ? text(read.profile.import_key) : '';
};

/**
 * Validate a V2 import against the current corpus. Pure: no reads, no writes.
 * Returns the leads to write, the records already imported, and every refusal.
 */
function evaluateStaffingV2Import(payload, { leads = [], suppressedEmails = new Set() } = {}, { now = () => new Date().toISOString(), newId } = {}) {
  const request = validatePayload(payload);
  const index = indexCorpus(leads);
  const evaluated = request.records.map((record, position) => {
    const { profile, unknown } = normalizeRecord(record && typeof record === 'object' ? record : {});
    const email = normalizeEmail(profile.email);
    return { position, profile, email, problem: recordProblem(profile, unknown, request.run) };
  });
  // Among otherwise-valid records, an identity repeated inside one request is
  // ambiguous (one buyer per company): every record sharing it is refused.
  const identityKeys = ({ profile, email }) => [...new Set([
    `email:${email}`,
    ...companyDomains(profile, email).map(domain => `domain:${domain}`),
    profile.apollo_person_id && `person:${profile.apollo_person_id}`,
    profile.apollo_organization_id && `organization:${profile.apollo_organization_id}`,
  ].filter(Boolean))];
  const keyCounts = new Map();
  for (const item of evaluated.filter(entry => !entry.problem)) {
    for (const key of identityKeys(item)) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }

  const accepted = [];
  const alreadyImported = [];
  const refusals = [];
  for (const item of evaluated) {
    const { profile, position, email } = item;
    const refuse = (code, reason) => refusals.push({ index: position, email, company: profile.company, code, reason });
    if (item.problem) { refuse(item.problem.code, item.problem.reason); continue; }
    if (suppressedEmails.has(email)) { refuse('suppressed', 'address is on the global suppression list'); continue; }
    if (identityKeys(item).some(key => keyCounts.get(key) > 1)) {
      refuse('duplicate_in_batch', 'email, company domain or Apollo identity repeats inside this request'); continue;
    }
    const importKey = importKeyFor(email, profile.apollo_person_id);
    // Same address already stored: the identical V2 record is a safe no-op; anything else is a duplicate.
    const sameEmail = index.byEmail.get(email) || [];
    if (sameEmail.some(lead => hasStaffingV2ProfileMarker(lead) && !readStaffingV2Profile(lead).ok)) {
      refuse(PROFILE_INTEGRITY_FAILED, 'the stored V2 lead for this address fails its profile integrity check; it is held, never repaired by re-import');
      continue;
    }
    if (sameEmail.length) {
      const ids = new Set(sameEmail.map(lead => text(lead.id)));
      if (ids.size === 1 && sameEmail.every(lead => importKeyOf(lead) === importKey)) {
        alreadyImported.push({ index: position, email, company: profile.company, leadId: [...ids][0] });
        continue;
      }
      const otherClient = sameEmail.some(lead => { const owner = resolveLeadClient(lead); return owner.ok && owner.clientId !== DEFAULT_CLIENT_ID; });
      refuse(otherClient ? 'cross_client_duplicate' : 'duplicate_email', 'this address already exists in the lead database');
      continue;
    }
    if (companyDomains(profile, email).some(domain => index.scalelabDomains.has(domain))) {
      refuse('duplicate_company', 'a ScaleLab lead already exists for this company domain (V1 companies are duplicates for V2)'); continue;
    }
    if (profile.apollo_person_id && index.v2Persons.has(profile.apollo_person_id)) { refuse('duplicate_person', 'this Apollo person is already a V2 lead'); continue; }
    if (profile.apollo_organization_id && index.v2Organizations.has(profile.apollo_organization_id)) {
      refuse('duplicate_company', 'this Apollo organization already has a V2 lead'); continue;
    }
    const contactName = `${profile.first_name} ${profile.last_name}`;
    let campaignNotes;
    try {
      campaignNotes = serializeStaffingV2Profile({ ...profile, email, contact_name: contactName,
        company_domain: profile.company_domain.toLowerCase().replace(/^www\./, '') },
      { import_schema: IMPORT_SCHEMA, import_key: importKey, imported_at: now() });
    } catch (error) { refuse(error.code || 'invalid_profile', error.message); continue; }
    // The sealed profile must read back exactly as every later reader will see it.
    const sealed = readStaffingV2Profile({ campaign_notes: campaignNotes });
    if (!sealed.ok) { refuse(PROFILE_INTEGRITY_FAILED, sealed.detail || sealed.reason); continue; }
    const domain = profile.company_domain.toLowerCase().replace(/^www\./, '');
    accepted.push({
      index: position, importKey,
      lead: {
        id: newId ? newId() : '', company: profile.company, contactName, email, city: profile.city,
        // Legacy columns with V1 meanings stay blank: tradeType is a family signal to
        // routing, tier/siteContext/notes were V1 personalization and buyer labels.
        tradeType: '', website: domain ? `https://${domain}` : '',
        stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '', notes: '',
        reviewCount: '', rating: '', tier: '', siteContext: '',
        campaign: STAFFING_CAMPAIGN_V2.name, campaign_notes: campaignNotes, enrichment_attempted: '',
        leadNiche: STAFFING_CAMPAIGN_V2.niche,
        // Explicit V2 identity from the first write; no sender, nothing routed.
        senderInboxId: '', emailTemplateId: V2_TEMPLATE, routingRequired: 'true', intendedCampaignVersion: V2_ID,
        clientId: DEFAULT_CLIENT_ID,
      },
    });
  }
  const refusalsByCode = {};
  for (const refusal of refusals) refusalsByCode[refusal.code] = (refusalsByCode[refusal.code] || 0) + 1;
  return { request, accepted, alreadyImported, refusals, refusalsByCode };
}

/**
 * The V2 import. `dryRun` (the default) writes nothing. A write appends only
 * the accepted Import-stage leads, then schedules the Supabase mirror, through
 * the same storage primitives as every other ColdEmail import.
 */
async function importStaffingV2Leads({ payload, dryRun = true, readCorpus, appendLeads, mirrorLeads, newId, now } = {}) {
  if (!readCorpus || !appendLeads || !mirrorLeads || !newId) throw new Error('staffing V2 import requires readCorpus, appendLeads, mirrorLeads and newId');
  validatePayload(payload);
  const corpus = await readCorpus();
  const result = evaluateStaffingV2Import(payload, corpus, { now, newId });
  const leads = result.accepted.map(item => item.lead);
  let written = 0;
  let mirror = null;
  if (!dryRun && leads.length) {
    await appendLeads(leads);
    written = leads.length;
    mirror = await mirrorLeads(leads);
  }
  return {
    dryRun: Boolean(dryRun), campaignId: V2_ID, templateId: V2_TEMPLATE, sourcingRunId: result.request.run.sourcingRunId,
    received: result.request.records.length, accepted: leads.length, alreadyImported: result.alreadyImported.length,
    refused: result.refusals.length, written, mirror,
    leads: result.accepted.map(item => ({ index: item.index, id: item.lead.id, email: item.lead.email, company: item.lead.company, importKey: item.importKey })),
    alreadyImportedLeads: result.alreadyImported, refusals: result.refusals, refusalsByCode: result.refusalsByCode,
  };
}

module.exports = {
  IMPORT_SCHEMA, MAX_RECORDS, COHORT_RULES, SCORE_ANCHORS,
  validatePayload, recordProblem, evaluateStaffingV2Import, importStaffingV2Leads, importKeyFor,
};
