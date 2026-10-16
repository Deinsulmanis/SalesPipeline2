'use strict';
/**
 * Free Apollo discovery filters and the post-search sector screen for Jole BTX
 * (campaign jole-btx-employer-acquisition). Pure: builds request parameters and
 * judges text; it calls nothing.
 *
 * Apollo industry codes are a DISCOVERY aid, never proof of ICP fit. Every
 * company a search returns still goes through live dedupe, global suppression,
 * joleExclusionReason, sectorScreen, website validation and verified hiring
 * evidence before any paid reveal.
 *
 * Why the exclusions are narrow: Apollo companies carry several industry codes.
 * Excluding construction (23), mining support (2131), pharma (3254), consumer
 * care (3256) or government (92) at search time removed 12 of the 339 Apollo
 * organizations behind Jorge's approved 689-lead corpus (ONEOK, Targa, Kinetik,
 * DT Midstream, Innophos, PowerSecure, Mitsubishi Chemical, ...). So the search
 * only (a) includes the approved sectors' codes, with chemicals split so 3254
 * (pharma) and 3256 (soap/cosmetics) are never included, and (b) hard-excludes
 * staffing firms. Pharma, contractors, solar installers and governments that
 * still arrive are held or rejected by sectorScreen.
 */

// The seven approved sectors, verbatim from the campaign ICP, each with the
// NAICS prefixes used to discover them (Apollo accepts 2-5 digits).
const JOLE_SECTORS = Object.freeze([
  { id: 'fabrication_machinery', label: 'Industrial fabrication / machinery', naics: ['332', '333'] },
  { id: 'metals_mining_paper', label: 'Metals / mining / paper / heavy industrial', naics: ['331', '212', '322', '327'] },
  // 325 is split: 3254 (pharmaceutical) and 3256 (soap, cleaning, toiletries) are not included.
  { id: 'refining_chemical', label: 'Refining / petrochemical / LNG / chemical', naics: ['324', '3251', '3252', '3253', '3255', '3259'] },
  // 2211 generation/transmission, 2212 natural gas distribution, 2213 water/sewer
  // (Phase 5 approved municipal water utilities). Never the 221 umbrella.
  { id: 'power_utilities', label: 'Power / utilities', naics: ['2211', '2212', '2213'] },
  // 33661 ship and boat building and repair. 4883 is not used: it is mostly port
  // operators and stevedoring (labor services).
  { id: 'shipyard_marine', label: 'Shipyard / marine', naics: ['33661'] },
  { id: 'pipeline_midstream', label: 'Pipeline / midstream', naics: ['486'] },
  // 211 operators only. 213 (support activities: drilling and oilfield service
  // contractors) is contractors-for-hire and is not included.
  { id: 'oil_gas_operators', label: 'Oil & gas producers / operators', naics: ['211'] },
]);

const SEARCH_EXCLUDED_SIC = Object.freeze(['7361', '7363']);
const SEARCH_EXCLUDED_NAICS = Object.freeze(['5613']);

// Approved worker categories → posting titles used to find employers that are
// hiring them. Discovery only; the evidence gate decides what counts.
const CRAFT_JOB_TITLES = Object.freeze([
  'welder', 'maintenance technician', 'maintenance mechanic', 'machinist', 'cnc machinist', 'electrician',
  'industrial electrician', 'mechanic', 'diesel mechanic', 'instrument technician', 'fabricator', 'fitter',
  'millwright', 'pipefitter',
]);

// Approved buyer roles (campaign ICP buyerRoles), as exact Apollo titles, in
// the APPROVED PRIORITY ORDER (operator decision 2026-10-15). No other family.
const BUYER_FAMILIES = Object.freeze([
  { id: 'plant_operations', label: 'Plant / operations / production leadership',
    titles: ['plant manager', 'operations manager', 'production manager', 'director of operations', 'general manager', 'manufacturing manager', 'vice president of operations'] },
  { id: 'hr_talent', label: 'HR / talent acquisition',
    titles: ['human resources manager', 'hr manager', 'talent acquisition manager', 'human resources business partner', 'hr business partner', 'human resources director'] },
  { id: 'maintenance_reliability', label: 'Maintenance / reliability',
    titles: ['maintenance manager', 'reliability manager', 'maintenance superintendent'] },
  { id: 'superintendent_site', label: 'Superintendent / site leadership',
    titles: ['superintendent', 'site manager', 'site director', 'plant superintendent'] },
  { id: 'owner_executive', label: 'Owner / executive (small and mid companies, or site executives)',
    titles: ['owner', 'president', 'ceo', 'founder'] },
]);

// Title → approved family. Checked in this order so "Maintenance
// Superintendent" is maintenance, "HR Operations Manager" is HR and "Vice
// President of Operations" is operations, not owner/executive.
const FAMILY_PATTERNS = Object.freeze([
  ['maintenance_reliability', /\b(maintenance|reliability)\b/],
  ['hr_talent', /\b(human resources?|hr|talent acquisition|people operations)\b/],
  ['plant_operations', /\b(plant manager|operations|production|manufacturing|general manager)\b/],
  ['superintendent_site', /\b(superintendent|site (manager|director|leader|lead))\b/],
  ['owner_executive', /\b(owner|president|ceo|chief executive|founder)\b/],
]);
// Apollo's exact-title search still returns these (2026-10-15 validation:
// "Sales Operations Manager", "Finance Operations Manager", "IT Site Manager",
// "Maintenance Manager (Retired)"); none is an approved buyer.
const NOT_A_BUYER = /\b(assistant|asst|customer|intern|coordinator|specialist|generalist|recruiter|analyst|clerk|technician|engineer|sales|marketing|finance|financial|treasury|accounting|it|technology|retired|former|business operations|business development)\b/;
// Small and mid-sized employers: up to 1,000 employees (the Phase 5 size bands
// 1-200 and 201-1000).
const SMALL_MID_MAX_EMPLOYEES = 1000;
const SITE_EXECUTIVE = /\b(plant|site|mill|facility|refinery|shipyard|terminal|works)\b/;
const SITE_TIE_ORDER = Object.freeze(['EXACT', 'REGION', 'STATE']);

/** A General Manager title that is the site/plant/operations executive itself. */
function siteGeneralManager(title) {
  const t = String(title || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(senior |sr )?general manager$/.test(t)) return true;
  return /\b(plant|site|mill|facility|refinery|works|operations|manufacturing|production)\b/.test(t.replace(/\bgeneral manager\b/, ''));
}

/** The approved buyer family of a title, or null (never a new family). */
function buyerFamilyOf(title) {
  const t = String(title || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t || NOT_A_BUYER.test(t)) return null;
  const hit = FAMILY_PATTERNS.find(([, pattern]) => pattern.test(t));
  return hit ? hit[0] : null;
}

/**
 * EXACT (same city and state as the hiring site) or STATE (same state).
 * REGION — within the site's commuting area (`geo.js`, 50 miles), possibly
 * across a state line — is supplied by the caller (location-filtered search).
 */
function siteTieOf(contact = {}, site = {}) {
  if (contact.siteTie && SITE_TIE_ORDER.includes(contact.siteTie)) return contact.siteTie;
  const city = value => String(value || '').toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\bsaint\b/g, 'st').trim();
  if (contact.state && site.state && contact.state === site.state) {
    return city(contact.city) && city(contact.city) === city(site.city) ? 'EXACT' : 'STATE';
  }
  return null;
}

/**
 * Approved deterministic contact order for one company (operator-confirmed
 * 2026-10-16): location tier first — EXACT → REGION → STATE → no tie — then
 * the family order above within each tier, then non-catch-all before
 * catch-all (unknown last), then a stable key. Owner / executive is eligible only at companies of ≤1,000 employees or
 * for a true site executive; otherwise the contact is returned as ineligible.
 * At employers over 1,000 employees (or of unknown size) only EXACT and
 * REGION contacts are eligible: same-state alone is no connection to the site.
 * Returns { ranked, ineligible }.
 */
function rankJoleContacts(contacts = [], { site = {}, employeeCount = null, siteFirst = true } = {}) {
  const smallMid = Number.isFinite(employeeCount) && employeeCount <= SMALL_MID_MAX_EMPLOYEES;
  const ranked = [];
  const ineligible = [];
  for (const contact of contacts) {
    const family = buyerFamilyOf(contact.title);
    if (!family) { ineligible.push({ contact, reason: 'not_an_approved_buyer' }); continue; }
    if (family === 'owner_executive' && !smallMid && !SITE_EXECUTIVE.test(String(contact.title || '').toLowerCase())) {
      ineligible.push({ contact, reason: Number.isFinite(employeeCount) ? 'owner_executive_large_company' : 'owner_executive_size_unknown' });
      continue;
    }
    // Large employers: a General Manager counts only as an operational/site
    // executive ("General Manager", "Plant General Manager", "General Manager
    // Operations"); a functional or other-business GM ("GM, Land & Water",
    // "GM - Film") has no reasonable remit over the hiring site's workforce.
    if (!smallMid && family === 'plant_operations' && /\bgeneral manager\b/i.test(String(contact.title || '')) && !siteGeneralManager(contact.title)) {
      ineligible.push({ contact, reason: 'functional_gm_large_employer' });
      continue;
    }
    const tie = siteTieOf(contact, site);
    // Large (or unknown-size) employers: a buyer must be at the hiring site or
    // in its commuting region, not merely somewhere in the same state.
    if (!smallMid && tie !== 'EXACT' && tie !== 'REGION') {
      ineligible.push({ contact, reason: 'no_site_connection_large_employer' });
      continue;
    }
    ranked.push({ contact, family, siteTie: tie,
      key: [BUYER_FAMILIES.findIndex(f => f.id === family), tie ? SITE_TIE_ORDER.indexOf(tie) : 3,
        contact.catchAll === false ? 0 : contact.catchAll === true ? 1 : 2, String(contact.id || contact.title || '')] });
  }
  // Final Jole order (operator-confirmed 2026-10-16): exact site, then the
  // 50-mile region, then state (only where permitted), then no tie; the
  // approved family order applies within each tier. siteFirst: false keeps
  // the earlier family-first order for comparison only.
  const order = siteFirst ? [1, 0, 2] : [0, 1, 2];
  ranked.sort((a, b) => {
    for (const i of order) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.key[3] < b.key[3] ? -1 : a.key[3] > b.key[3] ? 1 : 0;
  });
  return { ranked: ranked.map(({ key, ...item }) => item), ineligible };
}

const ymd = date => new Date(date).toISOString().slice(0, 10);

/**
 * Free company discovery (apollo_organizations_lookup) for one approved sector.
 * Geography is the HIRING SITE: organization_job_locations, not headquarters.
 */
// Employer-size bands for discovery. Unbanded, Apollo returns the largest
// employers first: the 2026-10-15 sample was 87% 1,001+ employees vs 47% in
// the approved 689. Query each band separately so the pool keeps the approved
// mix (Phase 5 companies: 1-200 24%, 201-1000 29%, 1001+ 47%). Discovery only;
// the ICP is unchanged.
const EMPLOYEE_BANDS = Object.freeze({ small: '1,200', mid: '201,1000', large: '1001,1000000' });

function joleCompanyDiscoveryParams({ sectorId, page = 1, perPage = 100, now = Date.now(), evidenceDays = 30, sizeBand = null } = {}) {
  const sector = JOLE_SECTORS.find(item => item.id === sectorId);
  if (!sector) throw new Error(`unknown Jole sector ${sectorId}`);
  if (sizeBand != null && !EMPLOYEE_BANDS[sizeBand]) throw new Error(`unknown size band ${sizeBand}`);
  return {
    ...(sizeBand ? { organization_num_employees_ranges: [EMPLOYEE_BANDS[sizeBand]] } : {}),
    organization_naics_codes: [...sector.naics],
    not_organization_naics_codes: [...SEARCH_EXCLUDED_NAICS],
    not_organization_sic_codes: [...SEARCH_EXCLUDED_SIC],
    q_organization_job_titles: [...CRAFT_JOB_TITLES],
    organization_job_locations: ['United States'],
    organization_job_posted_at_range: { min: ymd(now - evidenceDays * 86400000), max: ymd(now) },
    page, per_page: perPage,
  };
}

/** Free people search (apollo_mixed_people_api_search) for one buyer family at given companies. */
function joleBuyerSearchParams({ organizationIds, familyId, perPage = 1 } = {}) {
  const family = BUYER_FAMILIES.find(item => item.id === familyId);
  if (!family) throw new Error(`unknown buyer family ${familyId}`);
  return {
    organization_ids: [...organizationIds], person_locations: ['United States'],
    person_titles: [...family.titles], include_similar_titles: false, per_page: perPage,
  };
}

// ── Post-search sector screen ────────────────────────────────────────────────
const PHARMA_CARE = /\b(pharma|pharmaceuticals?|biopharma|biotech|biologics|therapeutics|biosciences?|life sciences|vaccines?|diagnostics|cosmetics?|skin ?care|beauty|personal care|fragrances?)\b/;
const SOLAR = /\bsolar\b/;
const SOLAR_INSTALL = /\b(residential solar|solar install(?:er|ers|ation)|rooftop solar|homeowners?|solar for your home)\b/;
const GOVERNMENT_NAME = /^(city|county|town|village|borough|township|state|commonwealth|parish) of\b/;
const CONTRACTOR_NAME = /\b(construction|constructors?|contractors?|contracting|builders|homes|roofing|gutters?|remodel(?:ing)?|paving|excavating|landscaping)\b/;
const CONTRACTOR_SITE = /\b(general contractor|construction services|design[- ]build|construction management|we build homes|home improvement)\b/;
const INDUSTRIAL_SITE = /\b(manufactur\w*|fabricat\w*|machin\w*|weld\w*|plant|mill|refin\w*|chemicals?|power|utilit\w*|steel|metals?|foundry|paper|mining|shipyard|shipbuild\w*|marine|pipeline|midstream|energy|industrial|equipment|production)\b/;

const normalized = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * { decision: 'pass'|'reject'|'hold', reason }. Name/domain decide categories
 * outright; website text only HOLDS (a chemical maker's site may mention pharma
 * customers). A site without industrial evidence is held, never passed.
 */
function sectorScreen({ name = '', domain = '', siteText = null } = {}) {
  const n = normalized(name);
  const d = String(domain || '').toLowerCase();
  if (PHARMA_CARE.test(n) || /pharma|biotech|therapeutic|cosmetic|beauty/.test(d)) return { decision: 'reject', reason: 'sector_pharma_biotech_consumer_care' };
  if (GOVERNMENT_NAME.test(n) || /\.gov$|\.gov\.\w+$/.test(d)) return { decision: 'reject', reason: 'sector_government' };
  const site = siteText == null ? null : normalized(siteText);
  if (SOLAR.test(n) || SOLAR.test(d)) {
    if (site && SOLAR_INSTALL.test(site)) return { decision: 'reject', reason: 'sector_solar_installer' };
    return { decision: 'hold', reason: 'sector_solar_review' };
  }
  if (CONTRACTOR_NAME.test(n)) return { decision: 'hold', reason: 'sector_contractor_review' };
  if (site == null) return { decision: 'hold', reason: 'website_not_checked' };
  if (CONTRACTOR_SITE.test(site)) return { decision: 'hold', reason: 'sector_contractor_review' };
  if (!INDUSTRIAL_SITE.test(site)) return { decision: 'hold', reason: 'website_no_industrial_evidence' };
  return { decision: 'pass', reason: 'industrial_employer' };
}

module.exports = {
  JOLE_SECTORS, SEARCH_EXCLUDED_SIC, SEARCH_EXCLUDED_NAICS, CRAFT_JOB_TITLES, BUYER_FAMILIES, SMALL_MID_MAX_EMPLOYEES, EMPLOYEE_BANDS,
  joleCompanyDiscoveryParams, joleBuyerSearchParams, sectorScreen, buyerFamilyOf, siteTieOf, siteGeneralManager, rankJoleContacts,
};
