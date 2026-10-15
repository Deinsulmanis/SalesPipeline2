'use strict';
/**
 * Pre-reveal hiring-evidence gate for Jole BTX (campaign
 * jole-btx-employer-acquisition). Pure: judges postings already collected
 * from a public source (LinkedIn's public job pages or the employer's own
 * careers page). Apollo's "has job postings" signal is never evidence, and
 * Apollo's paid job-posting endpoint is not used.
 *
 * An employer is VERIFIED only when at least one posting has all of:
 *   - employer identity: the posting's company is this employer (name match or
 *     the employer's own domain hosts the posting)
 *   - an approved craft role (below), not a helper/apprentice/supervisor role
 *   - a US location (the hiring site)
 *   - a public URL (https)
 *   - a posting date no more than `maxAgeDays` (default 30, the ICP rule) old
 *     and not in the future
 * Otherwise the employer is HELD before any paid email reveal.
 */

// The campaign's approved worker categories. 'skilled trades' is the umbrella
// heading of that list, so only the named categories count; any other trade is
// held for a human decision rather than assumed.
// Checked in order, most specific first ("Pipe Fitter" is a pipefitter, not a fitter).
const CRAFT_CATEGORIES = Object.freeze([
  { id: 'pipefitters', pattern: /\b(pipe ?fitters?|steamfitters?|plumber[- /]pipefitters?)\b/ },
  { id: 'millwrights', pattern: /\b(millwrights?)\b/ },
  { id: 'welders', pattern: /\b(welders?|welding|weld(?:er)?[- ]fabricators?|brazers?)\b/ },
  { id: 'maintenance_technicians', pattern: /\b(maintenance (technicians?|techs?|mechanics?|electricians?)|industrial maintenance|multi[- ]?craft (technicians?|maintenance))\b/ },
  { id: 'machinists_cnc', pattern: /\b(machinists?|cnc (machinists?|operators?|programmers?|setup|set[- ]up|mill|lathe|router))\b/ },
  { id: 'electricians', pattern: /\b(electricians?|electrical (technicians?|maintenance))\b/ },
  { id: 'mechanics', pattern: /\b(mechanics?)\b/ },
  { id: 'instrument_technicians', pattern: /\b(instrument(?:ation)? (technicians?|techs?)|i ?& ?e|e ?& ?i|i ?& ?c|instrument and (electrical|controls?))\b/ },
  { id: 'fabricators_fitters', pattern: /\b(fabricators?|fitters?|shipfitters?|fitter[- ]welders?)\b/ },
]);
// Not the trade itself (mirrors the production role cleaner's NOT_THE_TRADE),
// plus office roles that merely mention a trade.
const NOT_THE_TRADE = /\b(helpers?|apprentices?|trainees?|interns?|supervisors?|foreman|foremen|laborers?|deckhands?|engineers?|managers?|inspectors?|instructors?|sales|coordinators?|planners?|schedulers?|estimators?|recruiters?)\b/;

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const LEGAL = /\b(llc|l l c|inc|incorporated|ltd|corp|corporation|co|company|lp|llp|plc|group|holdings|the|usa|us|na|north america)\b/g;
const DAY = 86400000;

const norm = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const bare = value => norm(value).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
const hostOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } };

/** The approved craft category of a posting title, or null. */
function approvedCraftRole(title) {
  const t = norm(title).replace(/\bi and e\b/g, 'i & e').replace(/\be and i\b/g, 'e & i').replace(/\bi and c\b/g, 'i & c');
  if (!t || NOT_THE_TRADE.test(t)) return null;
  const raw = String(title || '').toLowerCase();
  const hit = CRAFT_CATEGORIES.find(category => category.pattern.test(t) || category.pattern.test(raw));
  return hit ? hit.id : null;
}

/** The US state of a posting location ("Tulsa, OK", "Texas, United States", "United States"). */
function usState(location) {
  const text = String(location || '').trim();
  const code = text.match(/,\s*([A-Z]{2})\b/);
  if (code && US_STATES.has(code[1])) return code[1];
  if (/\bunited states\b/i.test(text)) return 'US';
  return null;
}

/**
 * Does this posting belong to the employer? The posting company equals the
 * employer's name (legal suffixes ignored), or the employer's own domain hosts
 * the posting. A shorter OR longer name is never enough: "Koch" (Koch
 * Industries, kochinc.com) is not "KOCH Finishing Systems".
 */
function sameEmployer(posting, employer) {
  const a = bare(posting.company);
  const b = bare(employer.name);
  if (a && b && a === b) return true;
  const domain = String(employer.domain || '').toLowerCase().replace(/^www\./, '');
  const host = hostOf(posting.url);
  return Boolean(domain && host && (host === domain || host.endsWith(`.${domain}`)));
}

function judgePosting(posting, employer, { now, maxAgeDays }) {
  if (!sameEmployer(posting, employer)) return 'identity_mismatch';
  const role = approvedCraftRole(posting.title);
  if (!role) return 'role_not_approved';
  if (!usState(posting.location)) return 'location_not_us';
  if (!/^https:\/\//i.test(String(posting.url || ''))) return 'no_public_url';
  const posted = Date.parse(posting.postedAt || '');
  if (!Number.isFinite(posted)) return 'undated';
  if (posted - now > DAY) return 'future_dated';
  if (now - posted > maxAgeDays * DAY) return 'stale';
  return null;
}

/**
 * { status: 'verified'|'hold', reason, evidence?, considered }.
 * `evidence` is the freshest qualifying posting: employer, role, raw title,
 * site, state, url, postedAt, verifiedAt.
 */
function evaluateHiringEvidence({ employer = {}, postings = [], now = Date.now(), maxAgeDays = 30 } = {}) {
  if (!employer.name && !employer.domain) return { status: 'hold', reason: 'no_employer_identity', considered: 0 };
  const verdicts = postings.map(posting => ({ posting, reason: judgePosting(posting, employer, { now, maxAgeDays }) }));
  const good = verdicts.filter(item => !item.reason).map(item => item.posting)
    .sort((x, y) => Date.parse(y.postedAt) - Date.parse(x.postedAt));
  if (!good.length) {
    const ours = verdicts.filter(item => item.reason !== 'identity_mismatch');
    const reason = !postings.length ? 'no_public_postings_found'
      : !ours.length ? 'no_postings_for_this_employer'
        : `no_qualifying_posting:${[...new Set(ours.map(item => item.reason))].sort().join('+')}`;
    return { status: 'hold', reason, considered: postings.length };
  }
  const best = good[0];
  return {
    status: 'verified', reason: 'verified_public_posting', considered: postings.length,
    roles: [...new Set(good.map(posting => approvedCraftRole(posting.title)))],
    qualifyingPostings: good.length,
    evidence: {
      employer: employer.name || '', postingCompany: best.company || '', role: approvedCraftRole(best.title), title: best.title,
      site: best.location || '', state: usState(best.location), url: best.url, postedAt: best.postedAt,
      verifiedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * Public-search keywords for one employer, in order. A name-only search of a
 * large employer returns mostly office roles (Lennox: analysts and managers,
 * no welders), so the second query adds the approved craft words. Both feed
 * the same evaluateHiringEvidence rule; the extra query widens recall, not
 * the ICP. Run each with location "United States" and a 30-day window.
 */
const CRAFT_SEARCH_WORDS = Object.freeze(['welder', 'millwright', 'machinist', 'electrician', 'mechanic', 'technician', 'pipefitter', 'fabricator', 'fitter']);
function evidenceSearchKeywords(employerName) {
  const quoted = `"${String(employerName || '').replace(/[,.]?\s*(inc|llc|ltd|corporation|corp|co|plc|group|company)\.?$/i, '').trim()}"`;
  return [quoted, `${quoted} ${CRAFT_SEARCH_WORDS.join(' OR ')}`];
}

module.exports = { CRAFT_CATEGORIES, CRAFT_SEARCH_WORDS, approvedCraftRole, usState, sameEmployer, evaluateHiringEvidence, evidenceSearchKeywords };
