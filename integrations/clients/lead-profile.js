'use strict';

/**
 * A managed client's lead profile: the researched facts its campaign
 * personalises from, stored on the lead's existing `campaign_notes` field as
 * versioned JSON (the column every store already carries; no resolver reads
 * it, so nothing in it can change who owns the lead).
 *
 * The hiring roles keep BOTH forms: `raw` is the posting title exactly as
 * published (evidence), `clean` is what copy may say (hiring-roles.js). A
 * role that does not clean is kept with status `review` and never used.
 *
 * personalization.status:
 *   ready         at least one clean role and a hiring location
 *   needs_review  no usable role or location; a person must decide
 */

const { cleanHiringRole } = require('./hiring-roles');

const SCHEMA = 'client_lead_profile_v1';
const MAX_PROFILE_CHARS = 8000;
const str = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const flag = value => {
  const text = str(value).toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(text)) return true;
  if (['n', 'no', 'false', '0'].includes(text)) return false;
  return null;
};
const int = value => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : null);

/**
 * Build the profile from an import row's `profile` object (research fields as
 * supplied). Unknown keys are ignored; nothing is invented.
 */
function buildLeadProfile({ clientId, profile = {}, verifiedAt } = {}) {
  const p = profile || {};
  const roles = [p.verifiedRole, p.secondaryRole].map(value => str(value)).filter(Boolean)
    .map(raw => { const cleaned = cleanHiringRole(raw); return { raw, clean: cleaned.clean, status: cleaned.status, ...(cleaned.reason ? { reason: cleaned.reason } : {}) }; });
  // Distinct clean roles, first-posted first. Two only when each is a single
  // trade, so the two-role opener never reads "A and B and C".
  const usable = [...new Set(roles.filter(role => role.status === 'clean').map(role => role.clean))];
  const copyRoles = usable.length >= 2 && usable.slice(0, 2).every(role => !/ and /.test(role)) ? usable.slice(0, 2) : usable.slice(0, 1);
  const location = str(p.hiringSite, 120);
  const status = copyRoles.length && location ? 'ready' : 'needs_review';
  return {
    schema: SCHEMA, clientId: str(clientId, 40),
    contact: {
      firstName: str(p.firstName, 80), lastName: str(p.lastName, 80), title: str(p.title, 200),
      buyerType: str(p.buyerType, 80), city: str(p.contactCity, 80), state: str(p.contactState, 40),
      linkedinUrl: str(p.linkedinUrl, 300),
    },
    company: {
      domain: str(p.companyDomain, 120), size: str(p.companySize, 40), phone: str(p.companyPhone, 40),
      sector: str(p.sector, 80), tier: str(p.priorityTier, 20),
    },
    email: { status: str(p.emailStatus, 40), domainCatchAll: flag(p.emailDomainCatchAll), domain: str(p.emailDomain, 120) },
    hiring: {
      site: location, siteTie: str(p.siteTie, 20), roles,
      postingDate: str(p.postingDate, 40), evidenceUrl: str(p.hiringEvidenceUrl, 500),
      relevantRoles30d: int(p.relevantRoles30d), coreTradeRoles30d: int(p.coreTradeRoles30d),
      context: str(p.whyRelevant, 600), verifiedAt: str(verifiedAt || p.verifiedAt, 40),
    },
    source: {
      apolloPersonId: str(p.apolloPersonId, 60), apolloOrganizationId: str(p.apolloOrganizationId, 60),
      corpus: str(p.corpus, 120),
    },
    personalization: {
      status, roles: copyRoles, location,
      ...(status === 'needs_review' ? { reason: !location ? 'no hiring location' : 'no posting title reduces to a usable trade' } : {}),
    },
  };
}

// Research-corpus columns (the employer-research CSV, snake_case headers) →
// buildLeadProfile's input. One mapping for the dashboard upload and batches.
const RESEARCH_COLUMNS = Object.freeze({
  firstName: 'first_name', lastName: 'last_name', title: 'title', buyerType: 'buyer_type',
  contactCity: 'contact_city', contactState: 'contact_state', linkedinUrl: 'linkedin_url',
  companyDomain: 'company_domain', companySize: 'company_size', companyPhone: 'company_contact_number',
  sector: 'sector', priorityTier: 'priority_tier', emailStatus: 'email_status',
  emailDomainCatchAll: 'email_domain_catch_all', emailDomain: 'email_domain',
  hiringSite: 'hiring_site', siteTie: 'site_tie', verifiedRole: 'verified_role', secondaryRole: 'secondary_role',
  postingDate: 'posting_date', hiringEvidenceUrl: 'hiring_evidence_url', relevantRoles30d: 'relevant_roles_30d',
  coreTradeRoles30d: 'core_trade_roles_30d', whyRelevant: 'why_contact_is_relevant',
  apolloPersonId: 'apollo_person_id', apolloOrganizationId: 'apollo_organization_id',
  verifiedAt: 'verified_at', corpus: 'corpus',
});

/** A research row (snake_case keys) → profile input, or null when it carries no research. */
function profileFromResearchRow(research = {}) {
  if (!research || typeof research !== 'object') return null;
  const profile = {};
  for (const [key, column] of Object.entries(RESEARCH_COLUMNS)) {
    const value = research[column] ?? research[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') profile[key] = value;
  }
  return Object.keys(profile).length ? profile : null;
}

function serializeLeadProfile(profile) {
  const text = JSON.stringify(profile);
  if (text.length > MAX_PROFILE_CHARS) throw Object.assign(new Error('lead profile is too large'), { code: 'invalid' });
  return text;
}

/** The profile stored on a lead, or null when it has none (or it is not JSON). */
function readLeadProfile(lead = {}) {
  const raw = lead.campaign_notes ?? lead.campaignNotes;
  if (raw && typeof raw === 'object') return raw.schema === SCHEMA ? raw : null;
  const text = String(raw || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.schema === SCHEMA ? parsed : null;
  } catch (_) { return null; }
}

module.exports = { SCHEMA, RESEARCH_COLUMNS, buildLeadProfile, profileFromResearchRow, serializeLeadProfile, readLeadProfile };
