'use strict';

// Which lead did a demo play belong to?
//
// DemoPlays rows used to be matched to leads by company name alone. Locations of
// one brand share a cleaned company name, so one listener on one location's
// proposal page produced a demo pair — and a queued booking-link email — for
// every location. A company name is not an identity.
//
// Attribution is now:
//
//   1. EXACT. Every proposal link carries the lead's token (/p/<token>). The
//      tracker forwards it to the page as `lt`, the page sends it on each play
//      pixel, and /demo-played stores it in DemoPlays column G. A token resolves
//      to exactly one lead, or to nothing.
//
//   2. LEGACY, fail closed. A row without a token — an older cached page, or a
//      link sent before tokens reached the page — may match by company key only
//      when that key belongs to exactly ONE lead in the whole corpus. Two or more
//      is ambiguous: it is reported and creates no pair.
//
// The two kinds of evidence never combine. A row with a token never feeds the
// company match, and a lead with any token evidence ignores company evidence, so
// half a pair from each cannot add up to a pair.
//
// PURE: no Sheets, no Gmail, no agent import. The caller injects the company key
// and the row filter; this module decides attribution and nothing else.

const crypto = require('node:crypto');

const LEAD_TOKEN_PATTERN = /^[0-9a-f]{10}$/;

/** sha1(lead id), first 10 hex characters: the <token> in /p/<token>. */
function proposalTokenFor(leadId) {
  return crypto.createHash('sha1').update(String(leadId)).digest('hex').slice(0, 10);
}

/** A well-formed lead token, or ''. Nothing else may reach a sheet cell or a match. */
function normalizeLeadToken(raw) {
  const token = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  return LEAD_TOKEN_PATTERN.test(token) ? token : '';
}

function addPlay(bucket, key, type, at) {
  if (!bucket.has(key)) bucket.set(key, { intro: 0, demo: 0, last: '', introPlayedAt: '', demoPlayedAt: '' });
  const play = bucket.get(key);
  play[type]++;                                   // repeat plays collapse in the pair test
  if (at > play.last) play.last = at;
  if (!play[`${type}PlayedAt`] || at < play[`${type}PlayedAt`]) play[`${type}PlayedAt`] = at;
}

/**
 * DemoPlays rows, header first, to { byToken, byCompany } of real plays.
 *
 * Columns: A timestamp, B company, C niche, D ip, E user agent, F audio_type,
 * G lead token. Rows written before column G existed have no token and are
 * legacy evidence.
 */
function aggregateDemoPlays(rows, { companyKey, isExcluded = () => false } = {}) {
  if (typeof companyKey !== 'function') throw new Error('aggregateDemoPlays requires a companyKey function');
  const byToken = new Map();
  const byCompany = new Map();
  for (const row of (rows || []).slice(1)) {
    const [timestamp, company, , ip, userAgent, audioType, leadToken] = row || [];
    if (isExcluded({ ip: String(ip || '').trim(), userAgent: String(userAgent || '') })) continue;
    // Blank column F predates the intro and was always a receptionist demo.
    const type = String(audioType || '').trim().toLowerCase() === 'intro' ? 'intro' : 'demo';
    const token = normalizeLeadToken(leadToken);
    if (token) { addPlay(byToken, token, type, String(timestamp || '')); continue; }
    const key = companyKey(company || '');
    if (key) addPlay(byCompany, key, type, String(timestamp || ''));
  }
  return { byToken, byCompany };
}

function addOwner(owners, key, leadId) {
  if (!owners.has(key)) owners.set(key, new Set());
  owners.get(key).add(leadId);
}

/**
 * Resolve aggregated plays to leads.
 *
 * `corpus` must be the WHOLE lead corpus. A filtered or targeted subset makes a
 * shared company key look unique, which is exactly the fan-out this prevents.
 *
 * @returns {{
 *   byLeadId: Map<string, { play: object, via: 'lead_token' | 'legacy_company' }>,
 *   ambiguous: Array<{ via: string, key: string, leadIds: string[] }>,
 *   unmatchedTokens: number,
 * }}
 */
function attributeDemoPlays(corpus, plays, { companyKey } = {}) {
  if (typeof companyKey !== 'function') throw new Error('attributeDemoPlays requires a companyKey function');
  const tokenOwners = new Map();
  const companyOwners = new Map();
  for (const lead of corpus || []) {
    const id = String((lead && lead.id) || '').trim();
    if (!id) continue;
    addOwner(tokenOwners, proposalTokenFor(id), id);
    const key = companyKey(lead.company || '');
    if (key) addOwner(companyOwners, key, id);
  }

  const byLeadId = new Map();
  const ambiguous = [];
  const hasTokenEvidence = new Set();
  let unmatchedTokens = 0;

  for (const [token, play] of (plays && plays.byToken) || []) {
    const owners = [...(tokenOwners.get(token) || [])].sort();
    owners.forEach(id => hasTokenEvidence.add(id));
    if (!owners.length) { unmatchedTokens++; continue; }
    if (owners.length > 1) { ambiguous.push({ via: 'lead_token', key: token, leadIds: owners }); continue; }
    byLeadId.set(owners[0], { play, via: 'lead_token' });
  }

  for (const [key, play] of (plays && plays.byCompany) || []) {
    const owners = [...(companyOwners.get(key) || [])].sort();
    if (owners.length > 1) { ambiguous.push({ via: 'legacy_company', key, leadIds: owners }); continue; }
    if (!owners.length || hasTokenEvidence.has(owners[0])) continue;
    byLeadId.set(owners[0], { play, via: 'legacy_company' });
  }

  return { byLeadId, ambiguous, unmatchedTokens };
}

/** The play attributed to one lead, or null. */
function demoPlayForLead(attribution, leadId) {
  const hit = attribution && attribution.byLeadId.get(String(leadId || '').trim());
  return hit ? hit.play : null;
}

module.exports = {
  LEAD_TOKEN_PATTERN,
  proposalTokenFor,
  normalizeLeadToken,
  aggregateDemoPlays,
  attributeDemoPlays,
  demoPlayForLead,
};
