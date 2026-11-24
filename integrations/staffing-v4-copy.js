'use strict';

/**
 * Industrial Staffing V4: the approved copy, the evidence-based Email 1 variant
 * selector, variable validation and the copy renderer.
 *
 * ONE campaign (industrial_staffing_employer_acquisition_v4) with three touches:
 * Email 1 is one of six variants (COPY_A..COPY_F), Email 2 and Email 3 are
 * shared by every variant. The variant is chosen from verified evidence only,
 * in a fixed precedence, and never from the demand score:
 *
 *   1. COPY_A  current employer-acquisition ads (ad class MIXED alone is not
 *              enough; a stale or undated ad never counts)
 *   2. COPY_D  verified internal sales / BD hiring for the agency's own team
 *   3. COPY_E  verified market or branch expansion
 *   4. COPY_F  verified new senior commercial leader who is the recipient and
 *              holds the role now
 *   5. COPY_B  verified current candidate-recruitment ads (role + location)
 *   6. COPY_C  no qualifying signal, only with a verified specialization
 *   otherwise  HOLD (nothing renders)
 *
 * A variant whose evidence exists but whose variables cannot be validated
 * falls through to the next one, so a missing value is never rendered and
 * nothing is invented to fill it. This module is pure: no I/O, no model calls.
 *
 * Buying-signal priority (the V4 tag's STANDARD / HIGH_PRIORITY / LOW_SIGNAL)
 * and the personalization Tier A/B are different things. Nothing here maps
 * one onto the other, and the tag's COPY_TIER_PENDING segment is left as it is.
 */

const SIGNATURE = 'Deins';

const PERFORMANCE_SENTENCE = 'We only get paid when we generate qualified employer meetings for you. No qualified meetings, no fees.';
const EMAIL_2_BOLD = "It's entirely performance based. We only get paid for the qualified employer meetings we generate.";
const EMAIL_3_BOLD = "We only get paid when we generate qualified employer meetings, so there's no meeting fee if we don't deliver results.";

const VARIANTS = Object.freeze(['COPY_A', 'COPY_D', 'COPY_E', 'COPY_F', 'COPY_B', 'COPY_C']);

// Approved 2026-11-20. Verbatim, with {{variable}} placeholders in the owner's
// own names. Body text ends at the sign-off; the compliance footer is appended
// by the caller (staffing-compliance.js), never written here.
const EMAIL_1 = Object.freeze({
  COPY_A: Object.freeze({
    subject: 'Employer accounts for {{company}}',
    body: "Hi {{first_name}},\n\nSaw you were running ads to reach employers looking for staffing support.\n\nAre you looking to bring in more employer accounts beyond what you're getting through advertising?\n\nI help industrial staffing agencies generate qualified employer meetings by handling the prospecting, outreach, and qualification.\n\n"
      + `${PERFORMANCE_SENTENCE}\n\nWould adding another employer acquisition channel be worth exploring?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company']),
  }),
  COPY_B: Object.freeze({
    subject: 'Employer accounts for {{company}}',
    body: 'Hi {{first_name}},\n\nSaw you were advertising {{verified_role}} positions in {{location}}.\n\nAre you also looking to bring in more employer accounts that regularly hire for those roles?\n\nI help industrial staffing agencies reach companies hiring the trades they already place and turn those conversations into qualified meetings.\n\n'
      + `${PERFORMANCE_SENTENCE}\n\nWorth seeing how we'd approach this for {{company}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'verified_role', 'location']),
  }),
  COPY_C: Object.freeze({
    subject: 'More employer accounts for {{company}}',
    body: "Hi {{first_name}},\n\nSaw you were helping employers with {{verified_specialization}} staffing.\n\nIs bringing in more employer accounts something you're focused on right now?\n\nI help industrial staffing agencies generate qualified employer meetings. We handle everything from finding potential employer clients to outreach and qualification.\n\n"
      + `${PERFORMANCE_SENTENCE}\n\nOpen to seeing how this could work for {{company}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'verified_specialization']),
  }),
  COPY_D: Object.freeze({
    subject: 'Growing your employer accounts',
    body: 'Hi {{first_name}},\n\nSaw you were hiring a {{sales_position}} focused on bringing in new employer accounts.\n\nAre you looking to accelerate employer acquisition right now?\n\nI help industrial staffing agencies generate qualified employer meetings through targeted outbound outreach. We handle the prospecting and qualification so your team can focus on closing new accounts.\n\n'
      + `${PERFORMANCE_SENTENCE}\n\nWould it be worth exploring alongside your internal sales efforts?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'sales_position']),
  }),
  COPY_E: Object.freeze({
    subject: 'Employer accounts in {{market}}',
    body: 'Hi {{first_name}},\n\nSaw you were expanding into {{market}}.\n\nAre you currently focused on bringing in new employer accounts in that area?\n\nI help industrial staffing agencies connect with companies hiring skilled tradespeople and turn those conversations into qualified meetings.\n\n'
      + `${PERFORMANCE_SENTENCE}\n\nWorth seeing how we'd approach employer acquisition in {{market}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'market']),
  }),
  COPY_F: Object.freeze({
    subject: 'Employer growth at {{company}}',
    body: "Hi {{first_name}},\n\nSaw you were recently appointed {{verified_title}} at {{company}}.\n\nIs growing the company's employer accounts one of your priorities?\n\nI help industrial staffing agencies generate qualified meetings with companies looking for the trades they already supply.\n\nWe handle the prospecting, outreach, and qualification.\n\n"
      + `${PERFORMANCE_SENTENCE}\n\nOpen to seeing what this could look like for {{company}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'verified_title']),
  }),
});

const FOLLOW_UPS = Object.freeze([
  Object.freeze({
    step: 2,
    subject: 'Employer acquisition',
    body: "Hi {{first_name}},\n\nWe focus specifically on helping industrial staffing agencies bring in new employer accounts, not sourcing candidates.\n\nWe identify companies hiring the trades you place, reach their decision makers, and generate qualified employer meetings.\n\n"
      + `${EMAIL_2_BOLD}\n\nWould bringing in more employer accounts be relevant for {{company}}?\n\n${SIGNATURE}`,
    bold: EMAIL_2_BOLD,
    variables: Object.freeze(['first_name', 'company']),
  }),
  Object.freeze({
    step: 3,
    subject: 'Employer accounts',
    body: "Hi {{first_name}},\n\nQuick question, is bringing in more employer accounts something you're focused on right now?\n\n"
      + `${EMAIL_3_BOLD}\n\nWorth exploring, or better left for another time?\n\n${SIGNATURE}`,
    bold: EMAIL_3_BOLD,
    variables: Object.freeze(['first_name']),
  }),
]);

// ── Copy v2 (owner-approved copy change, 2026-11-24) ────────────────────────
//
// v2 replaces all six Email 1 variants and both shared follow-ups. v1 above
// stays exactly as approved on 2026-11-20 so every lead whose Email 1 went out
// on v1 finishes its sequence on v1 Emails 2 and 3 (staffing-v4-copy-version.js
// pins the version per lead). Precedence is unchanged: A > D > E > F > B > C.
//
// Locked text (validated on every render and before every send):
//   Email 1  "only get paid for the meetings we book" exactly once; no bold
//   Email 2  "We only get paid for the qualified meetings we book." exactly
//            once, bold in HTML
//   Email 3  reply "later" exactly once; no performance line; no bold
//
// COPY_C has two forms. Primary needs specialty_line ("<roles> for <client
// type>", quote-backed by the company's own site). When that cannot be
// validated it falls back to verified_specialization; with neither, HOLD.
const COPY_VERSIONS = Object.freeze(['v1', 'v2']);
const CURRENT_COPY_VERSION = 'v2';
const V2_EMAIL_1_LOCK = 'only get paid for the meetings we book';
const V2_EMAIL_2_BOLD = 'We only get paid for the qualified meetings we book.';
const V2_EMAIL_3_LOCK = 'reply "later"';

const EMAIL_1_V2 = Object.freeze({
  COPY_A: Object.freeze({
    subject: 'Employer accounts for {{company}}',
    body: "Hi {{first_name}},\n\nSaw you're running ads to win new employer clients.\n\nWe give industrial staffing agencies a second channel: we find employers hiring the trades you place and book qualified meetings with them. We only get paid for the meetings we book.\n\n"
      + `Worth a look alongside your ads?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company']),
  }),
  COPY_D: Object.freeze({
    subject: 'Growing your employer accounts',
    body: "Hi {{first_name}},\n\nSaw you're hiring a {{sales_position}} to bring in new employer accounts.\n\nWe can keep their calendar full while they ramp up. We book qualified employer meetings for industrial staffing agencies, and we only get paid for the meetings we book.\n\n"
      + `Worth comparing notes?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'sales_position']),
  }),
  COPY_E: Object.freeze({
    subject: 'Employer accounts in {{market}}',
    body: "Hi {{first_name}},\n\nSaw you're expanding into {{market}}.\n\nA new market is where employer accounts are hardest to win. We book qualified employer meetings for industrial staffing agencies there, and we only get paid for the meetings we book.\n\n"
      + `Worth a look for {{market}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'market']),
  }),
  COPY_F: Object.freeze({
    subject: 'Employer growth at {{company}}',
    body: 'Hi {{first_name}},\n\nCongrats on the {{verified_title}} role at {{company}}.\n\nIf growing employer accounts is on your list, we book qualified employer meetings for industrial staffing agencies, and we only get paid for the meetings we book.\n\n'
      + `Worth a quick look?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'verified_title']),
  }),
  COPY_B: Object.freeze({
    subject: 'Employer accounts for {{company}}',
    body: "Hi {{first_name}},\n\nSaw you're recruiting for {{verified_role}} roles in {{location}} right now.\n\nAgencies hiring that actively can usually take on more employer accounts. We find those employers, reach the decision makers and book qualified meetings, and we only get paid for the meetings we book.\n\n"
      + `Worth a look for {{company}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'verified_role', 'location']),
  }),
  // Primary form. The fallback form below differs only in its first line.
  COPY_C: Object.freeze({
    subject: 'Employer accounts for {{company}}',
    body: "Hi {{first_name}},\n\nSaw you place {{specialty_line}}.\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings, and we only get paid for the meetings we book.\n\n"
      + `Worth seeing how we'd do this for {{company}}?\n\n${SIGNATURE}`,
    variables: Object.freeze(['first_name', 'company', 'specialty_line']),
  }),
});
const COPY_C_V2_FALLBACK = Object.freeze({
  subject: EMAIL_1_V2.COPY_C.subject,
  body: EMAIL_1_V2.COPY_C.body.replace('Saw you place {{specialty_line}}.', 'Saw {{company}} focuses on {{verified_specialization}} staffing.'),
  variables: Object.freeze(['first_name', 'company', 'verified_specialization']),
});

const FOLLOW_UPS_V2 = Object.freeze([
  Object.freeze({
    step: 2,
    subject: 'Employer acquisition',
    body: 'Hi {{first_name}},\n\nQuick version of how it works:\n\n'
      + '1. We build a list of employers in your area hiring the roles you place.\n'
      + '2. We reach their plant, operations and hiring managers.\n'
      + '3. You only talk to the ones who want staffing help, booked on your calendar.\n\n'
      + `No retainer. ${V2_EMAIL_2_BOLD}\n\nWant me to pull a short sample list of employers hiring in your market, so you can see the fit?\n\n${SIGNATURE}`,
    bold: V2_EMAIL_2_BOLD,
    lock: V2_EMAIL_2_BOLD,
    variables: Object.freeze(['first_name']),
  }),
  Object.freeze({
    step: 3,
    subject: 'Employer accounts',
    body: "Hi {{first_name}},\n\nI'll close the loop here so I'm not cluttering your inbox.\n\n"
      + `If bringing in more employer accounts becomes a priority, just ${V2_EMAIL_3_LOCK} and I'll check back next quarter.\n\n${SIGNATURE}`,
    bold: null,
    lock: V2_EMAIL_3_LOCK,
    variables: Object.freeze(['first_name']),
  }),
]);

const EMAIL_1_BY_VERSION = Object.freeze({ v1: EMAIL_1, v2: EMAIL_1_V2 });
const FOLLOW_UPS_BY_VERSION = Object.freeze({ v1: FOLLOW_UPS, v2: FOLLOW_UPS_V2 });

// Variables a v1 profile carries; v2 adds specialty_line.
const V1_VARIABLE_NAMES = Object.freeze(['first_name', 'company', 'verified_role', 'location',
  'verified_specialization', 'sales_position', 'market', 'verified_title']);
const V2_VARIABLE_NAMES = Object.freeze(['specialty_line']);
const VARIABLE_NAMES = Object.freeze([...V1_VARIABLE_NAMES, ...V2_VARIABLE_NAMES]);

// ── Variables ────────────────────────────────────────────────────────────────

const DASHES = /[‒–—―−]/; // figure, en, em, horizontal bar, minus
const UNSAFE = /[\r\n\t{}<>|\\]/;
const PLACEHOLDER_WORDS = /^(?:undefined|null|nan|n\/a|na|none|unknown|tbd|tba|todo|placeholder|test|-+|\.+|\?+)$/i;
const MAX_VARIABLE = Object.freeze({
  first_name: 30, company: 60, verified_role: 50, location: 50, verified_specialization: 60,
  sales_position: 60, market: 50, verified_title: 60, specialty_line: 90,
});

/** Why a variable value cannot be merged, or null when it is safe. Pure. */
function variableProblem(name, value) {
  if (!VARIABLE_NAMES.includes(name)) return `unknown variable ${name}`;
  if (value === null || value === undefined) return `${name} is missing`;
  if (typeof value !== 'string') return `${name} is not text`;
  const text = value.trim();
  if (!text) return `${name} is blank`;
  if (text !== value) return `${name} has surrounding whitespace`;
  if (PLACEHOLDER_WORDS.test(text) || /\b(?:undefined|null)\b/i.test(text)) return `${name} is a placeholder`;
  if (UNSAFE.test(text)) return `${name} contains an unsafe character`;
  if (DASHES.test(text)) return `${name} contains an en or em dash`;
  if (/\s{2,}/.test(text)) return `${name} has repeated spaces`;
  if (text.length > MAX_VARIABLE[name]) return `${name} is longer than ${MAX_VARIABLE[name]} characters`;
  if (name === 'first_name' && !/^[A-Za-z][A-Za-z'.]*(?:-[A-Za-z][A-Za-z'.]*)?(?: [A-Za-z][A-Za-z'.]*)?$/.test(text)) return 'first_name is not a plain first name';
  if (name === 'first_name' && text.length < 2) return 'first_name is an initial';
  // A hyphen is kept only inside a proper name (RJ-Staffing, Ameri-Force); a
  // free-standing or trailing hyphen is an "unnecessary hyphen".
  if (/(?:^|\s)-|-(?:\s|$)/.test(text)) return `${name} has a free-standing hyphen`;
  if (name === 'specialty_line') return specialtyLineShapeProblem(text);
  return null;
}

/**
 * specialty_line must read correctly after "Saw you place ": 2 or 3 plural
 * roles, " for ", a client type. Lowercase words only, except upper-case
 * acronyms (CNC, HVAC); a proper noun makes it fall back rather than risk a
 * title-cased line. No trailing period. Quote-backing is checked by the
 * selector against the evidence quote. Pure.
 */
function specialtyLineShapeProblem(text) {
  if (!/^[A-Za-z0-9 ,'&-]+$/.test(text)) return 'specialty_line has punctuation other than commas';
  const words = text.split(' ');
  if (words.some(word => !/^[a-z0-9][a-z0-9'&-]*,?$/.test(word) && !/^[A-Z0-9]{2,5},?$/.test(word))) return 'specialty_line is not lowercase';
  const parts = text.split(' for ');
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return 'specialty_line is not "<roles> for <client type>"';
  const roles = parts[0].split(/,\s*(?:and\s+)?|\s+and\s+|\s+&\s+/).map(item => item.trim()).filter(Boolean);
  if (roles.length < 2 || roles.length > 3) return 'specialty_line must name 2 or 3 roles';
  if (!/s$/.test(parts[0].trim())) return 'specialty_line roles must be plural';
  return null;
}

/** All problems for the variables a template needs, in template order. */
function missingVariables(names, vars = {}) {
  return names.map(name => variableProblem(name, vars[name])).filter(Boolean);
}

// ── Evidence and selection ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = Object.freeze({
  adCurrentDays: 30, // an ad counts only if seen within 30 days (the V4 scoring window)
  salesHiringDays: 30, // a sales/BD posting must be open now (observed within 30 days)
  expansionDays: 180, // an expansion announced within about six months
  appointmentDays: 180, // "recently appointed"
});
const MIN_EMPLOYER_P = 0.7;
const MIN_ATTRIBUTION_P = 0.7;
const SENIOR_COMMERCIAL_TITLE = /\b(?:owner|founder|president|ceo|chief|cro|coo|vice president|vp|svp|evp|head of|director of (?:sales|business development|growth)|sales director|general manager|managing (?:partner|director))\b/i;
const SALES_POSITION = /\b(?:sales|business development|account (?:executive|manager)|bdm|bdr|sdr|growth)\b/i;

const parseDay = value => {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(String(value).length === 10 ? `${value}T00:00:00Z` : String(value));
};
const ageDays = (value, asOf) => {
  const at = parseDay(value);
  return Number.isFinite(at) ? (parseDay(asOf) - at) / DAY_MS : Infinity;
};
const isHttpUrl = value => /^https?:\/\/\S+$/i.test(String(value || ''));
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const LINE_STOPWORDS = new Set(['and', 'for', 'the', 'of', 'in']);
// "welders" backs "welder" and vice versa; "industries" backs "industry".
const stem = word => word.replace(/ies$/, 'y').replace(/(?:es|s)$/, '');
/**
 * Every content word of a specialty_line must appear in its first-party quote
 * (singular or plural), so the line can only restate what the site says.
 */
function quoteBacksLine(line, quote) {
  const have = new Set(norm(quote).split(' ').filter(Boolean).map(stem));
  const need = norm(line).split(' ').filter(word => word && !LINE_STOPWORDS.has(word)).map(stem);
  return need.length > 0 && need.every(word => have.has(word));
}

/**
 * Selects the Email 1 variant for one lead from its evidence record.
 *
 * evidence = {
 *   asOf, firstName, company, contactName, contactStatus, emailResolved,
 *   attributionP,
 *   employerAds:  [{ url, text, current, employerFacingP, lastSeen }],
 *   salesHiring:  [{ url, quote, salesPosition, ownCommercialTeam, current, observedAt }],
 *   expansion:    [{ url, quote, market, announcedAt }],
 *   leadership:   [{ url, quote, personName, title, appointedAt, current }],
 *   candidateAds: [{ url, quote, role, location, current, lastSeen }],
 *   specialization: { phrase, url, quote } | null,
 * }
 *
 * Returns { status: 'SELECTED' | 'HOLD', variant, vars, evidence, considered,
 * holds }. `considered` explains every variant that was passed over. A HOLD has
 * no variant, so nothing can render. The demand score is not an input.
 */
function selectV4Variant(evidence = {}, { copyVersion = CURRENT_COPY_VERSION } = {}) {
  const asOf = evidence.asOf;
  if (!Number.isFinite(parseDay(asOf))) throw new Error('V4 variant selection needs an asOf date');
  if (!COPY_VERSIONS.includes(copyVersion)) throw new Error(`unknown V4 copy version ${copyVersion || '(blank)'}`);
  const templates = EMAIL_1_BY_VERSION[copyVersion];
  const v2 = copyVersion === 'v2';
  let form = '';
  const base = { first_name: evidence.firstName, company: evidence.company };
  const considered = [];
  const holds = [];
  const pass = (variant, vars, used) => ({ variant, vars: { ...vars }, evidence: used });
  // Emails 2 and 3 merge first_name and company for every variant, so those are
  // required whichever Email 1 is chosen.
  const shared = [...new Set(FOLLOW_UPS_BY_VERSION[copyVersion].flatMap(item => item.variables))];
  const tryVariant = (variant, candidates, toVars, template = templates[variant]) => {
    if (!candidates.length) return null;
    const needed = [...new Set([...template.variables, ...shared])];
    for (const item of candidates) {
      const vars = { ...base, ...toVars(item) };
      const problems = missingVariables(needed, vars);
      if (!problems.length) return pass(variant, Object.fromEntries(needed.map(n => [n, vars[n]])), item);
      considered.push({ variant, outcome: 'evidence found, variables incomplete', detail: problems.join('; ') });
    }
    return null;
  };

  // 1. COPY_A: an attributed, employer-facing ad that is current.
  const attributed = Number(evidence.attributionP) >= MIN_ATTRIBUTION_P;
  const employerAds = (evidence.employerAds || []).filter(ad => isHttpUrl(ad.url)
    && Number(ad.employerFacingP) >= MIN_EMPLOYER_P && ad.current === true
    && ageDays(ad.lastSeen, asOf) <= WINDOWS.adCurrentDays);
  let chosen = attributed ? tryVariant('COPY_A', employerAds, () => ({})) : null;
  if (!chosen) {
    const anyEmployer = (evidence.employerAds || []).some(ad => Number(ad.employerFacingP) >= MIN_EMPLOYER_P);
    considered.push({ variant: 'COPY_A', outcome: 'not eligible',
      detail: !attributed && (evidence.employerAds || []).length ? 'ads are not attributed to this company'
        : anyEmployer ? 'employer-facing ads exist but none is current (stale or undated ads do not count)'
          : 'no current employer-facing ad (an ad class of MIXED alone is not evidence)' });
  }
  // 2. COPY_D: open sales/BD hiring for the agency's own commercial team.
  if (!chosen) {
    const hiring = (evidence.salesHiring || []).filter(item => isHttpUrl(item.url) && item.quote
      && item.ownCommercialTeam === true && item.current === true
      && ageDays(item.observedAt, asOf) <= WINDOWS.salesHiringDays
      && SALES_POSITION.test(String(item.salesPosition || '')));
    chosen = tryVariant('COPY_D', hiring, item => ({ sales_position: item.salesPosition }));
    if (!chosen && !hiring.length) considered.push({ variant: 'COPY_D', outcome: 'not eligible', detail: 'no verified current internal sales or BD hiring' });
  }
  // 3. COPY_E: a verified market or branch expansion.
  if (!chosen) {
    const expansion = (evidence.expansion || []).filter(item => isHttpUrl(item.url) && item.quote
      && ageDays(item.announcedAt, asOf) <= WINDOWS.expansionDays && ageDays(item.announcedAt, asOf) >= 0
      && norm(item.quote).includes(norm(item.market)));
    chosen = tryVariant('COPY_E', expansion, item => ({ market: item.market }));
    if (!chosen && !expansion.length) considered.push({ variant: 'COPY_E', outcome: 'not eligible', detail: 'no verified recent market or branch expansion' });
  }
  // 4. COPY_F: the recipient is a recently appointed senior commercial leader.
  if (!chosen) {
    const leader = (evidence.leadership || []).filter(item => isHttpUrl(item.url) && item.quote
      && item.current === true && norm(item.personName) && norm(item.personName) === norm(evidence.contactName)
      && ageDays(item.appointedAt, asOf) <= WINDOWS.appointmentDays && ageDays(item.appointedAt, asOf) >= 0
      && SENIOR_COMMERCIAL_TITLE.test(String(item.title || '')));
    chosen = tryVariant('COPY_F', leader, item => ({ verified_title: item.title }));
    if (!chosen && !leader.length) considered.push({ variant: 'COPY_F', outcome: 'not eligible', detail: 'no verified recent appointment of this recipient to a senior commercial role' });
  }
  // 5. COPY_B: a current candidate-recruitment ad naming the role and location.
  if (!chosen) {
    const ads = (evidence.candidateAds || []).filter(ad => isHttpUrl(ad.url) && ad.quote && ad.current === true
      && ageDays(ad.lastSeen, asOf) <= WINDOWS.adCurrentDays
      && norm(ad.quote).includes(norm(ad.role).replace(/s$/, ''))
      && norm(ad.quote).includes(norm(String(ad.location || '').split(',')[0])));
    chosen = tryVariant('COPY_B', ads, ad => ({ verified_role: ad.role, location: ad.location }));
    if (!chosen && !ads.length) {
      const any = (evidence.candidateAds || []).length;
      considered.push({ variant: 'COPY_B', outcome: 'not eligible',
        detail: any ? 'candidate ads lack a current, quoted role and location' : 'no candidate-recruitment ad with a role and location' });
    }
  }
  // 6. COPY_C (v2 primary): a quote-backed specialty_line from the company's own site.
  if (!chosen && v2) {
    const line = evidence.specialtyLine;
    const backed = line && isHttpUrl(line.url) && line.quote && typeof line.line === 'string' && quoteBacksLine(line.line, line.quote);
    chosen = backed ? tryVariant('COPY_C', [line], item => ({ specialty_line: item.line })) : null;
    if (chosen) form = 'primary';
    else if (!backed) {
      considered.push({ variant: 'COPY_C', outcome: 'primary not eligible',
        detail: line ? 'specialty_line is not backed word for word by its first-party quote' : 'no specialty_line from first-party site evidence' });
    }
  }
  // 6. COPY_C (v1; v2 fallback): a verified specialization, else HOLD.
  if (!chosen) {
    const spec = evidence.specialization;
    const ok = spec && isHttpUrl(spec.url) && spec.quote && spec.phrase;
    chosen = ok ? tryVariant('COPY_C', [spec], item => ({ verified_specialization: item.phrase }), v2 ? COPY_C_V2_FALLBACK : templates.COPY_C) : null;
    if (chosen && v2) form = 'fallback';
    if (!chosen && !ok) considered.push({ variant: 'COPY_C', outcome: 'not eligible', detail: 'specialization is not verified' });
  }

  if (!chosen) holds.push('no variant has verified evidence and complete variables');
  // Lead-level holds. They do not change which variant the evidence supports,
  // but they stop it from rendering for a send.
  if (evidence.emailResolved === false) holds.push('buyer email is unresolved');
  if (evidence.contactStatus && evidence.contactStatus !== 'READY_FOR_REVIEW') holds.push(`contact status is ${evidence.contactStatus}`);
  return {
    status: chosen && !holds.length ? 'SELECTED' : 'HOLD',
    copyVersion,
    // COPY_C under v2: 'primary' (specialty_line) or 'fallback' (verified_specialization).
    form: chosen && chosen.variant === 'COPY_C' && v2 ? form : '',
    variant: chosen ? chosen.variant : '',
    vars: chosen ? chosen.vars : {},
    evidence: chosen ? chosen.evidence : null,
    considered,
    holds,
  };
}

// ── V4 tag ───────────────────────────────────────────────────────────────────

const TAG = /^V4\|PASS\|([A-Z_]+)\|([A-Z_]+)\|([A-Z_]+)$/;
/** The existing V4 tag's parts, or null. It is read, never rewritten. */
function parseV4Tag(tag) {
  const match = TAG.exec(String(tag || '').trim());
  return match ? { tag: match[0], priority: match[1], adClass: match[2], copyTier: match[3] } : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function templateFor(variant, step, copyVersion = 'v1', vars = {}) {
  if (!COPY_VERSIONS.includes(copyVersion)) throw new Error(`unknown V4 copy version ${copyVersion || '(blank)'}`);
  const v2 = copyVersion === 'v2';
  if (step === 1) {
    let email = EMAIL_1_BY_VERSION[copyVersion][variant];
    if (!email) throw new Error(`unknown V4 copy variant ${variant || '(blank)'}`);
    // v2 COPY_C renders its primary form only with a sealed specialty_line.
    if (v2 && variant === 'COPY_C' && !vars.specialty_line) email = COPY_C_V2_FALLBACK;
    return { subject: email.subject, body: email.body, variables: email.variables,
      bold: v2 ? null : PERFORMANCE_SENTENCE, lock: v2 ? V2_EMAIL_1_LOCK : PERFORMANCE_SENTENCE };
  }
  const follow = FOLLOW_UPS_BY_VERSION[copyVersion].find(item => item.step === step);
  if (!follow) throw new Error('Invalid V4 sequence step');
  if (!VARIANTS.includes(variant)) throw new Error(`unknown V4 copy variant ${variant || '(blank)'}`);
  return { ...follow, lock: follow.lock || follow.bold };
}

function mergeStrict(template, vars) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    const problem = variableProblem(key, vars[key]);
    if (problem) throw new Error(`V4 variable refused: ${problem}`);
    return vars[key];
  });
}

/**
 * The copy for one touch, merged. `appendFooter(text)` adds the compliance
 * footer (the caller passes the existing ScaleLab one). Returns the plain body,
 * an HTML body that bolds only the approved performance sentence, the approved
 * standalone subject, and the variables used. Throws on any unresolved value.
 */
function renderV4Copy({ variant, step, vars = {}, appendFooter, resumeLine = '', copyVersion = 'v1' }) {
  if (typeof appendFooter !== 'function') throw new Error('V4 render needs the compliance footer');
  const template = templateFor(variant, step, copyVersion, vars);
  const problems = missingVariables(template.variables, vars);
  if (problems.length) throw new Error(`V4 Email ${step} refused: ${problems.join('; ')}`);
  let copy = mergeStrict(template.body, vars);
  // The first follow-up after an out-of-office return opens with the shared
  // one-line context after the greeting; the rest of the touch is unchanged.
  if (resumeLine) {
    if (step === 1) throw new Error('only a V4 follow-up can carry the out-of-office resume line');
    const at = copy.indexOf('\n\n');
    copy = `${copy.slice(0, at)}\n\n${resumeLine}${copy.slice(at)}`;
  }
  if (DASHES.test(copy)) throw new Error('V4 copy contains an en or em dash');
  const body = appendFooter(copy);
  const subject = mergeStrict(template.subject, vars);
  if (body.split(template.lock).length !== 2) throw new Error('V4 copy must contain its locked sentence exactly once');
  const phrase = template.bold;
  let html = phrase
    ? body.split(phrase).map(escapeHtml).join(`<strong>${escapeHtml(phrase)}</strong>`)
    : escapeHtml(body);
  html = html.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject, body, html, copy, bold: phrase, copyVersion };
}

/** Why a rendered V4 touch is unsafe, or null. Checks only V4's own copy rules. */
/**
 * Which copy version a rendered V4 touch carries, from its locked text. Used
 * only when a caller validates a body without naming the version; both
 * versions' checks stay strict, so a wrong guess can only refuse a send.
 */
function inferV4CopyVersion(body, step) {
  const text = String(body || '');
  const v2Lock = step === 1 ? V2_EMAIL_1_LOCK : (FOLLOW_UPS_V2.find(item => item.step === step) || {}).lock;
  return v2Lock && text.includes(v2Lock) ? 'v2' : 'v1';
}

function v4CopyProblem({ body, subject, copyVersion } = {}, step) {
  const text = String(body || '');
  if (!text.trim()) return 'staffing V4 body is empty';
  if (/{{|}}/.test(text) || /{{|}}/.test(String(subject || ''))) return 'staffing V4 email still contains an unmerged placeholder';
  if (/\b(?:undefined|null|NaN)\b/.test(text)) return 'staffing V4 body contains an unresolved value';
  const version = copyVersion || inferV4CopyVersion(text, step);
  if (!COPY_VERSIONS.includes(version)) return `unknown V4 copy version ${version}`;
  const v2 = version === 'v2';
  const follow = FOLLOW_UPS_BY_VERSION[version].find(item => item.step === step);
  const lock = step === 1 ? (v2 ? V2_EMAIL_1_LOCK : PERFORMANCE_SENTENCE) : follow && (follow.lock || follow.bold);
  if (!lock) return 'Invalid V4 sequence step';
  if (text.split(lock).length !== 2) return 'staffing V4 body is missing its locked sentence';
  // A v2 touch never carries v1's locked lines, and v1 never carries v2's.
  const foreign = v2 ? [PERFORMANCE_SENTENCE, EMAIL_2_BOLD, EMAIL_3_BOLD] : [V2_EMAIL_1_LOCK, V2_EMAIL_2_BOLD, V2_EMAIL_3_LOCK];
  if (foreign.some(line => text.includes(line))) return `staffing V4 body mixes copy versions (expected ${version})`;
  const copy = text.split(`\n\n${SIGNATURE}\n\n`)[0];
  if (DASHES.test(copy)) return 'staffing V4 copy contains an en or em dash';
  if (!text.includes(`\n\n${SIGNATURE}\n\n`)) return 'staffing V4 body must sign off as Deins before the footer';
  if (step === 1) {
    const subjects = Object.values(EMAIL_1_BY_VERSION[version]).map(item => item.subject.split('{{')[0]);
    if (!subjects.some(prefix => String(subject || '').startsWith(prefix))) return 'staffing V4 step 1 subject is not an approved subject';
  }
  return null;
}

module.exports = {
  SIGNATURE, PERFORMANCE_SENTENCE, EMAIL_2_BOLD, EMAIL_3_BOLD, VARIANTS, EMAIL_1, FOLLOW_UPS, VARIABLE_NAMES,
  COPY_VERSIONS, CURRENT_COPY_VERSION, EMAIL_1_V2, COPY_C_V2_FALLBACK, FOLLOW_UPS_V2, EMAIL_1_BY_VERSION, FOLLOW_UPS_BY_VERSION,
  V2_EMAIL_1_LOCK, V2_EMAIL_2_BOLD, V2_EMAIL_3_LOCK, V1_VARIABLE_NAMES, V2_VARIABLE_NAMES,
  WINDOWS, MIN_EMPLOYER_P, MIN_ATTRIBUTION_P,
  variableProblem, missingVariables, selectV4Variant, parseV4Tag, renderV4Copy, v4CopyProblem, inferV4CopyVersion,
  quoteBacksLine, specialtyLineShapeProblem,
};
