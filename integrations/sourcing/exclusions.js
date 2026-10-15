'use strict';
/**
 * Pre-reveal sourcing exclusions. Pure functions: no network, no CRM, no
 * provider. A candidate that matches is rejected BEFORE any paid email reveal.
 *
 *   nationalBrandMatch   national staffing brands and their branches/franchises.
 *                        LEGACY_NATIONAL is the Batch 3 list (qualify_lib.py
 *                        NATIONAL), verbatim; it is evaluated first and is never
 *                        narrowed. The additions only catch a branch/franchise
 *                        whose name drops part of the brand ("Express
 *                        Employment Omaha"), writes it as one word
 *                        ("ExpressPros"), or uses the brand's own domain.
 *   joleExclusionReason  Jole BTX's approved ICP exclusions
 *                        (campaign jole-btx-employer-acquisition): staffing,
 *                        recruiting and labor-service firms; SpaceX family;
 *                        Kiewit family / KOS; Karpower; current Jole clients.
 *
 * Every added pattern is a multi-word brand core, a distinctive single brand
 * token, or a brand-owned domain. Generic words alone (express, integrity,
 * kelly, volt, space, kos) never exclude a company.
 */

// qualify_lib.py NATIONAL, verbatim (Python `(?:` groups are valid JS).
const LEGACY_NATIONAL = new RegExp(
  '\\b('
  + 'randstad|manpower(?:group)?|adecco|employbridge|trueblue|aerotek|actalent|'
  + 'kelly services|kellyservices|insight global|insightglobal|\\bkforce\\b|'
  + 'robert half|roberthalf|labor ready|peopleready|people ready|'
  + 'staffmark|teksystems|tek systems|allegis|apex systems|'
  + 'express employment professionals|express personnel|'
  + 'on assignment|\\basgn\\b|yoh\\b|volt workforce|snelling|'
  + 'pds tech|spheric|proman(?: group)?|prostar staffing|'
  + 'integrity staffing services|\\batr\\b|atr international|'
  + 'appleone|laborfinders|labor finders|elwood staffing|'
  + 'pridestaff|pride staff|spherion|robert half'
  + ')\\b',
  'i',
);

// Branch/franchise forms of brands already on the legacy list. `phrases` are
// whole-token sequences matched anywhere in the normalised name (so a city or
// "of <city>" before or after does not matter); `joined` are one-word spellings
// matched as a whole token; `domains` are brand-owned registrable domains.
const BRANCH_FORMS = Object.freeze([
  { brand: 'Express Employment Professionals',
    phrases: ['express employment', 'express pros', 'express personnel'],
    joined: ['expresspros', 'expressemployment'],
    domains: ['expresspros.com', 'expressfranchising.com'] },
  { brand: 'Integrity Staffing Solutions',
    phrases: ['integrity staffing services', 'integrity staffing solutions'],
    joined: [],
    domains: ['integritystaffing.com'] },
  { brand: 'PeopleReady / Labor Ready', phrases: ['people ready', 'labor ready'], joined: ['peopleready', 'laborready'], domains: ['peopleready.com'] },
  { brand: 'Labor Finders', phrases: ['labor finders'], joined: ['laborfinders'], domains: ['laborfinders.com'] },
  { brand: 'PrideStaff', phrases: ['pride staff'], joined: ['pridestaff'], domains: ['pridestaff.com'] },
  { brand: 'Snelling', phrases: ['snelling staffing', 'snelling personnel'], joined: [], domains: ['snelling.com'] },
  { brand: 'Spherion', phrases: ['spherion staffing'], joined: ['spherion'], domains: ['spherion.com'] },
  { brand: 'Elwood Staffing', phrases: ['elwood staffing'], joined: ['elwoodstaffing'], domains: ['elwoodstaffing.com'] },
  { brand: 'AppleOne', phrases: ['apple one employment', 'appleone employment'], joined: ['appleone'], domains: ['appleone.com'] },
  { brand: 'Kelly Services', phrases: ['kelly services'], joined: ['kellyservices'], domains: ['kellyservices.com'] },
  { brand: 'Manpower', phrases: [], joined: ['manpower', 'manpowergroup'], domains: ['manpower.com', 'manpowergroup.com', 'manpowergroupusa.com'] },
  { brand: 'Randstad', phrases: [], joined: ['randstad'], domains: ['randstad.com', 'randstadusa.com'] },
  { brand: 'Adecco', phrases: [], joined: ['adecco'], domains: ['adecco.com', 'adeccousa.com'] },
  { brand: 'Staffmark', phrases: [], joined: ['staffmark'], domains: ['staffmark.com'] },
  { brand: 'Robert Half', phrases: ['robert half'], joined: ['roberthalf'], domains: ['roberthalf.com'] },
  { brand: 'Aerotek', phrases: [], joined: ['aerotek'], domains: ['aerotek.com'] },
  { brand: 'EmployBridge', phrases: [], joined: ['employbridge'], domains: ['employbridge.com'] },
  { brand: 'TrueBlue', phrases: [], joined: ['trueblue'], domains: ['trueblue.com'] },
]);

const LEGAL_SUFFIX = /\b(llc|l l c|inc|incorporated|ltd|corp|corporation|co|company|lp|llp|pllc)\b/g;

function normalizeName(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function registrableDomain(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  host = host.replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '');
  if (host.includes('@')) host = host.split('@').pop();
  return host;
}

const hasPhrase = (normalized, phrase) => ` ${normalized} `.includes(` ${phrase} `);
const hasToken = (normalized, token) => normalized.split(' ').includes(token);
const domainIs = (domain, owned) => domain === owned || domain.endsWith(`.${owned}`);

/** The national staffing brand this company belongs to, or null. */
function nationalBrandMatch({ name = '', domain = '' } = {}) {
  const legacy = String(name || '').match(LEGACY_NATIONAL);
  if (legacy) return { brand: legacy[1], rule: 'legacy_national' };
  const normalized = normalizeName(name);
  // The legacy list again on the normalised name: "Pride-Staff", "Robert-Half".
  const legacyNormalized = normalized.match(LEGACY_NATIONAL);
  if (legacyNormalized) return { brand: legacyNormalized[1], rule: 'legacy_national_normalized' };
  const host = registrableDomain(domain);
  for (const form of BRANCH_FORMS) {
    if (form.phrases.some(phrase => hasPhrase(normalized, phrase))) return { brand: form.brand, rule: 'branch_phrase' };
    if (form.joined.some(token => hasToken(normalized, token))) return { brand: form.brand, rule: 'branch_joined' };
    if (host && form.domains.some(owned => domainIs(host, owned))) return { brand: form.brand, rule: 'brand_domain' };
  }
  return null;
}

// ── Jole BTX approved ICP exclusions ──────────────────────────────────────────
const STAFFING_SIC = new Set(['7361', '7363']);
const STAFFING_NAICS_PREFIX = '5613';
// "Staffing, recruiting and labor-service firms" by name. Each alternative
// names the service itself, never a bare industry word ("workforce",
// "employment", "personnel" alone are not enough).
const STAFFING_FIRM_NAME = /\b(staffing|recruiting|recruiters|recruitment|headhunters?|temp agency|temporary (help|staffing|services)|employment (agency|services|solutions)|personnel (services|solutions)|labor (services?|solutions|source|pool|staffing))\b/;

const JOLE_FAMILIES = Object.freeze([
  { family: 'SpaceX', phrases: ['space exploration technologies'], tokens: ['spacex', 'starlink'], domains: ['spacex.com', 'starlink.com'] },
  { family: 'Kiewit / KOS', phrases: ['kiewit offshore services'], tokens: ['kiewit'], domains: ['kiewit.com'], exactNames: ['kos'] },
  { family: 'Karpower', phrases: [], tokens: ['karpower', 'karpowership'], domains: ['karpowership.com', 'karpower.com'] },
]);

const withoutLegalSuffix = normalized => normalized.replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();

function familyMatch(normalized, host) {
  const bare = withoutLegalSuffix(normalized);
  for (const f of JOLE_FAMILIES) {
    if (f.phrases.some(phrase => hasPhrase(normalized, phrase))
      || f.tokens.some(token => hasToken(normalized, token))
      || (f.exactNames || []).includes(bare)
      || (host && f.domains.some(owned => domainIs(host, owned)))) return f.family;
  }
  return null;
}

/**
 * Why Jole's ICP excludes this company, or null if it is not excluded.
 * `currentClients` is REQUIRED (Jole's existing-client list: names and/or
 * domains); an absent list throws so a run cannot silently skip that rule.
 */
function joleExclusionReason({ name = '', domain = '', sicCodes = [], naicsCodes = [] } = {}, { currentClients } = {}) {
  if (!Array.isArray(currentClients)) {
    throw new Error('Jole current-client exclusion list is required (pass [] only when Jorge has confirmed there are none)');
  }
  const normalized = normalizeName(name);
  const host = registrableDomain(domain);
  if ([].concat(sicCodes || []).some(code => STAFFING_SIC.has(String(code)))) return 'staffing_firm_sic';
  if ([].concat(naicsCodes || []).some(code => String(code).startsWith(STAFFING_NAICS_PREFIX))) return 'staffing_firm_naics';
  const brand = nationalBrandMatch({ name, domain });
  if (brand) return `staffing_firm_national_brand:${brand.brand}`;
  if (STAFFING_FIRM_NAME.test(normalized)) return 'staffing_firm_name';
  const family = familyMatch(normalized, host);
  if (family) return `excluded_family:${family}`;
  const bare = withoutLegalSuffix(normalized);
  for (const client of currentClients) {
    const isObject = client && typeof client === 'object';
    const clientName = withoutLegalSuffix(normalizeName(isObject ? client.name : client));
    const clientDomain = registrableDomain(isObject ? client.domain : (String(client).includes('.') ? client : ''));
    if (clientDomain && host && domainIs(host, clientDomain)) return 'current_jole_client';
    if (clientName && bare && clientName === bare) return 'current_jole_client';
  }
  return null;
}

module.exports = {
  LEGACY_NATIONAL, BRANCH_FORMS, JOLE_FAMILIES,
  normalizeName, registrableDomain, nationalBrandMatch, joleExclusionReason,
};
