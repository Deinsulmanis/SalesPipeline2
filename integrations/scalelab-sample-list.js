'use strict';
// ScaleLab "sample employer list" reply capability (Industrial Campaign 3).
// PURE: detection, agency-state parsing, list selection, freshness policy,
// rendering and the auto-send policy. No I/O here; the flow module wires the
// stores, GetLeads and Gmail. Employer data is company-level only.

const INTENT = 'sample_list_request';
const MAX_EMPLOYERS = 10;
const MIN_IN_STATE = 5;
const MIN_OPEN_ROLES = 2;   // owner rule 2026-11-24: only employers with 2+ open hands-on roles
const RECHECK_AFTER_DAYS = 14;
const STORED_FALLBACK_DAYS = 21;
const POSTING_WINDOW_DAYS = 30;
const AUTOSEND_DELAY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The offer appears in our own earlier turn ("Want me to pull a short sample
// list of employers hiring in your market?"). Any wording of it counts.
const SAMPLE_OFFER = /\b(?:sample (?:list|of (?:employers|companies))|(?:short |quick )?list of (?:employers|companies)(?: (?:that are|who are))? hiring|employers (?:that are |who are )?hiring in your (?:market|area|region))\b/i;
const EXPLICIT_REQUEST = /\b(?:send (?:me |us |over |it over )?(?:the |that |a |your |over the )?(?:sample |short |employer )?list|(?:interested in|curious about) (?:the|that|a|your) (?:sample |employer )?list|(?:see|share|pull) (?:the|that|a) (?:sample |short |employer )?list|what (?:does|would) (?:that|the list|it|this) look like|(?:i(?:'|’)?d|we(?:'|’)?d|i would|we would) (?:like|love) to see (?:it|that|the list|a sample|one))\b/i;
const SHORT_AFFIRM = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely|please)(?:[\s,!.]+(?:please|sure|send it|send it over|go ahead|thanks|thank you|why not|do it))*|please do|go ahead|send it(?: over)?|sounds good|why not|let.s see it|sure thing)[\s!.]*$/i;
const NEGATIVE = /\b(?:not interested|no thanks|no thank you|unsubscribe|remove (?:me|us)|take (?:me|us) off|stop (?:emailing|sending|contacting)|do not (?:email|contact)|don(?:'|’)?t (?:email|contact)|not a fit|we(?:'|’)?re (?:all )?set|pass\b|spam)\b/i;
// Anything that adds a second ask, a condition or a commercial question is a
// mixed reply and stays with the owner through the existing routes.
const MIXED = /\b(?:but|however|although|unless|if|price|pricing|cost|costs|how much|fees?|rates?|call|phone|meeting|meet|schedule|book|calendar|zoom|contract|who are you|how did you|which (?:company|agency)|already|currently|not sure|maybe)\b/i;
const SIGN_OFF = /^(?:thanks|thank you|best|regards|cheers|sincerely|sent from|get outlook|--)/i;

const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'Washington, DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});
const NAME_TO_CODE = new Map(Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));

const NEIGHBORS = Object.freeze({
  AL: ['FL', 'GA', 'MS', 'TN'], AK: [], AZ: ['CA', 'CO', 'NM', 'NV', 'UT'], AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'],
  CA: ['AZ', 'NV', 'OR'], CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'], CT: ['MA', 'NY', 'RI'], DC: ['MD', 'VA'],
  DE: ['MD', 'NJ', 'PA'], FL: ['AL', 'GA'], GA: ['AL', 'FL', 'NC', 'SC', 'TN'], HI: [], ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'],
  IL: ['IA', 'IN', 'KY', 'MO', 'WI'], IN: ['IL', 'KY', 'MI', 'OH'], IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'],
  KS: ['CO', 'MO', 'NE', 'OK'], KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'], LA: ['AR', 'MS', 'TX'], ME: ['NH'],
  MD: ['DC', 'DE', 'PA', 'VA', 'WV'], MA: ['CT', 'NH', 'NY', 'RI', 'VT'], MI: ['IN', 'OH', 'WI'],
  MN: ['IA', 'ND', 'SD', 'WI'], MS: ['AL', 'AR', 'LA', 'TN'], MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'],
  MT: ['ID', 'ND', 'SD', 'WY'], NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'], NV: ['AZ', 'CA', 'ID', 'OR', 'UT'],
  NH: ['MA', 'ME', 'VT'], NJ: ['DE', 'NY', 'PA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'], NY: ['CT', 'MA', 'NJ', 'PA', 'VT'],
  NC: ['GA', 'SC', 'TN', 'VA'], ND: ['MN', 'MT', 'SD'], OH: ['IN', 'KY', 'MI', 'PA', 'WV'], OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'],
  OR: ['CA', 'ID', 'NV', 'WA'], PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'], RI: ['CT', 'MA'], SC: ['GA', 'NC'],
  SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'], TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'],
  TX: ['AR', 'LA', 'NM', 'OK'], UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'], VT: ['MA', 'NH', 'NY'],
  VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'], WA: ['ID', 'OR'], WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
  WI: ['IA', 'IL', 'MI', 'MN'], WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
});

// Hands-on industrial titles. Supervisory, office and engineering roles do
// not count toward "open roles".
const HANDS_ON = /\bweld|fabricat|fitter|boilermaker|brazer|solder|ironworker|sheet ?metal|pipefitter|machinist|\bcnc\b|lathe|grinder|tool ?(?:and|&) ?die|toolmaker|mainten|mechanic|electrician|electrical tech|electric tech|millwright|hvac|instrument tech|e&i|repair|carpenter|laborer|rigger|crane|equipment operator|painter|blaster|insulator|mason|concrete|plumber|lineman|scaffold|warehouse|forklift|material handler|shipping|receiving|picker|packer|loader|cdl|driver|production|assembl|machine operator|operator|manufactur|press|packag|molder|extrusion|furnace|general labor|helper|finisher|coater|cutter|technician|team member|utility tech/i;
const NOT_HANDS_ON = /foreman|\blead\b|manager|director|supervisor|superintendent|engineer|planner|scheduler|analyst|buyer|coordinator|intern\b|accountant|sales|recruit|human resources|\bhr\b|estimator|president|\bvp\b|administrat|clerk|purchas|inspector|chemist|scientist|program|project|opportunit|service provider|trainer|specialist/i;

const norm = value => String(value || '').trim();
const noDashes = value => String(value || '').replace(/[‒–—―−]/g, '-');

function isHandsOnTitle(title) {
  const text = norm(title);
  return Boolean(text) && HANDS_ON.test(text) && !NOT_HANDS_ON.test(text);
}

function cleanTitle(title) {
  let text = noDashes(norm(title));
  text = text.replace(/\s*[([].*?[)\]]/g, '');
  text = text.replace(/\s+-\s+(?:\d(?:st|nd|rd|th)|first|second|third|night|day|days|weekend|[a-d]-?shift|entry).*$/i, '');
  text = text.replace(/\s*[-|,]\s*(?:\$|\d).*$/, '');
  text = text.replace(/\s*-\s+.*$/, '').replace(/\s+(?:19|20)\d{2}$/, '');
  text = text.replace(/\b(?:1st|2nd|3rd|first|second|third|weekend|night)\s+shift\b/ig, '');
  text = text.replace(/\s+/g, ' ').replace(/^[\s\-|,]+|[\s\-|,]+$/g, '');
  if (text && text === text.toUpperCase()) text = text.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  return text.slice(0, 48);
}

// GetLeads postings -> { hiring, openRoles, exampleRoles, newestPosting }.
function summarizePostings(postings = [], { now = new Date(), state = '' } = {}) {
  const cutoff = new Date(now).getTime() - POSTING_WINDOW_DAYS * DAY_MS;
  const fresh = postings.filter(post => {
    const at = Date.parse(String(post.posted_at || post.posted || '').slice(0, 10));
    return Number.isFinite(at) && at >= cutoff && isHandsOnTitle(post.title);
  });
  // The list shows "City, State", so only postings in the stored state count.
  const use = state ? fresh.filter(post => norm(post.geo_admin_district || post.state).toUpperCase() === state) : fresh;
  const titles = [];
  for (const post of [...use].sort((a, b) => String(b.posted_at || b.posted).localeCompare(String(a.posted_at || a.posted)))) {
    const title = cleanTitle(post.title);
    if (title && !titles.some(seen => seen.toLowerCase() === title.toLowerCase())) titles.push(title);
  }
  return {
    hiring: use.length > 0,
    openRoles: use.length,
    exampleRoles: titles.slice(0, 3),
    newestPosting: use.length ? use.map(post => String(post.posted_at || post.posted).slice(0, 10)).sort().pop() : null,
  };
}

// The prospect's own ask: the lines before a sign-off, at most three.
function askLines(body) {
  const lines = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (lines.length) break; continue; }
    if (SIGN_OFF.test(line)) break;
    lines.push(line);
    if (lines.length >= 3) break;
  }
  // An inline courtesy and name ("Yes please. Thanks, Pat") is dropped only
  // when nothing else follows it; any other trailing text stays in the ask.
  const ask = lines.join(' ').trim();
  const tail = ask.match(/^(.*?\S)[\s.,!]+(?:thanks|thank you|cheers|best|regards)\b([^?]*)$/i);
  if (tail && tail[2].trim().split(/\s+/).filter(Boolean).length <= 3 && !MIXED.test(tail[2])
      && !/\b(?:and|also|plus|then)\b/i.test(tail[2])) return tail[1].trim();
  return ask;
}

function offeredSampleList(context = []) {
  return context.some(turn => turn && turn.actor === 'scalelab'
    && (turn.offersSampleList === true || SAMPLE_OFFER.test(String(turn.text || ''))));
}

/**
 * Returns { match: true, confidence: 'high', reason } only for a clear yes to
 * our sample-list offer. Mixed, conditional or negative replies return
 * { match: false } so the existing routes (human review) decide them.
 */
function detectSampleListRequest(body, context = []) {
  if (!offeredSampleList(context)) return { match: false, reason: 'no_sample_offer_in_thread' };
  const ask = askLines(body);
  if (!ask) return { match: false, reason: 'empty' };
  if (NEGATIVE.test(ask)) return { match: false, reason: 'negative_signal' };
  const words = ask.split(/\s+/).filter(Boolean).length;
  const explicit = EXPLICIT_REQUEST.exec(ask);
  // The explicit phrase may itself be a question ("what does that look like?").
  const remainder = explicit ? ask.replace(explicit[0], ' ').replace(/^[\s,.!?]+|[\s,.!?]+$/g, '') : ask.trim();
  if (words > 30 || MIXED.test(remainder) || /\?/.test(remainder)) {
    return { match: false, reason: 'mixed_reply' };
  }
  if (explicit) return { match: true, confidence: 'high', reason: 'explicit_sample_list_request' };
  if (SHORT_AFFIRM.test(ask)) return { match: true, confidence: 'high', reason: 'affirmed_sample_list_offer' };
  return { match: false, reason: 'not_a_clear_yes' };
}

function stateCode(value) {
  const text = norm(value).replace(/,?\s*(?:united states(?: of america)?|usa|u\.s\.a?\.?|us)\s*$/i, '').trim();
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text) && STATE_NAMES[text.toUpperCase()]) return text.toUpperCase();
  const named = NAME_TO_CODE.get(text.toLowerCase());
  if (named) return named;
  const trailing = text.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (trailing && STATE_NAMES[trailing[1]]) return trailing[1];
  for (const [name, code] of NAME_TO_CODE) {
    if (new RegExp(`(?:^|,\\s*)${name}\\s*$`, 'i').test(text)) return code;
  }
  return null;
}

/**
 * The agency's HQ and branch states from its own lead record, in order of
 * authority. Unknown returns []. Never guessed from the employer data.
 */
function agencyStates(lead = {}) {
  let notes = {};
  try { notes = String(lead.campaign_notes || lead.campaignNotes || '').trim().startsWith('{')
    ? JSON.parse(lead.campaign_notes || lead.campaignNotes) : {}; } catch (_) { notes = {}; }
  const branchList = Array.isArray(notes.branch_states) ? notes.branch_states : [];
  // Backfilled HQ/branch states (scalelab_agency_states) come after the lead
  // record's own fields, which keep precedence.
  const backfilled = Array.isArray(lead.agency_states) ? lead.agency_states : [];
  const candidates = [notes.hq_state, notes.state, notes.var_location, notes.location, notes.var_market,
    notes.market, lead.state, lead.city, ...branchList, ...backfilled];
  const out = [];
  for (const value of candidates) {
    const code = stateCode(value);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

const ageDays = (iso, now) => (new Date(now).getTime() - Date.parse(iso)) / DAY_MS;
const rank = (a, b) => (b.openRoles - a.openRoles)
  || String(b.newestPosting || '').localeCompare(String(a.newestPosting || ''))
  || a.company.localeCompare(b.company);

// The market named in the email must describe the rows actually listed.
function marketLabel(picked, primary) {
  if (!primary) return 'the U.S.';
  const states = new Set(picked.map(item => item.state));
  const name = STATE_NAMES[primary];
  if ([...states].every(code => code === primary)) return name;
  const near = new Set([primary, ...(NEIGHBORS[primary] || [])]);
  if ([...states].every(code => near.has(code))) return `${name} and nearby states`;
  if (!states.has(primary)) return 'the U.S.';
  return `${name} and other U.S. markets`;
}

/**
 * Up to 10 still-hiring employers. In-state first; if fewer than 5 qualify in
 * the agency's states, fill from neighboring states, then the national list.
 */
function selectSampleList({ employers = [], states = [], exclude = new Set(), max = MAX_EMPLOYERS } = {}) {
  const hiring = employers.filter(item => item.status === 'hiring' && item.domain && !exclude.has(item.domain)
    && Number(item.openRoles) >= MIN_OPEN_ROLES);
  const home = states.filter(code => STATE_NAMES[code]);
  const primary = home[0] || null;
  // The agency's primary state first, then its branch states.
  const inState = hiring.filter(item => home.includes(item.state))
    .sort((a, b) => (a.state === primary ? 0 : 1) - (b.state === primary ? 0 : 1) || rank(a, b));
  if (primary && inState.length >= MIN_IN_STATE) {
    const picked = inState.slice(0, max);
    return { employers: picked, scope: 'state', state: primary, market: marketLabel(picked, primary) };
  }
  const picked = [...inState];
  const taken = () => new Set(picked.map(item => item.domain));
  let usedNeighbors = false;
  if (primary) {
    const near = new Set(home.flatMap(code => NEIGHBORS[code] || []).filter(code => !home.includes(code)));
    for (const item of hiring.filter(e => near.has(e.state)).sort(rank)) {
      if (picked.length >= max) break;
      if (!taken().has(item.domain)) { picked.push(item); usedNeighbors = true; }
    }
  }
  let usedNational = false;
  const national = hiring.filter(item => Number.isFinite(item.nationalRank))
    .sort((a, b) => a.nationalRank - b.nationalRank);
  for (const item of national) {
    if (picked.length >= max) break;
    if (!taken().has(item.domain)) { picked.push(item); usedNational = true; }
  }
  const scope = !primary ? 'national_state_unknown'
    : usedNational ? 'state_neighbors_national' : usedNeighbors ? 'state_neighbors' : 'state';
  const final = picked.slice(0, max);
  return { employers: final, scope, state: primary, market: marketLabel(final, primary) };
}

/**
 * Re-check stale employers ONE AT A TIME (GetLeads rejects concurrent
 * queries). The first failure stops further calls. On failure the stored data
 * is used only if every unchecked stale employer was checked within 21 days.
 */
async function freshenEmployers({ employers, now = new Date(), recheck }) {
  const kept = [];
  const updates = [];
  const dropped = [];
  let failure = null;
  for (const item of employers) {
    const stale = !item.checkedAt || ageDays(item.checkedAt, now) > RECHECK_AFTER_DAYS;
    if (!stale) { kept.push(item); continue; }
    if (failure) {
      if (item.checkedAt && ageDays(item.checkedAt, now) <= STORED_FALLBACK_DAYS) { kept.push(item); continue; }
      return { status: 'review', reason: 'freshness_unavailable', detail: failure, updates, dropped };
    }
    let result;
    try {
      result = await recheck(item);
    } catch (error) {
      failure = String(error.code || error.message || 'getleads_failed').slice(0, 120);
      if (item.checkedAt && ageDays(item.checkedAt, now) <= STORED_FALLBACK_DAYS) { kept.push(item); continue; }
      return { status: 'review', reason: 'freshness_unavailable', detail: failure, updates, dropped };
    }
    const checkedAt = new Date(now).toISOString();
    updates.push({ domain: item.domain, checkedAt, ...result });
    // Still hiring but below the 2-role bar: kept as hiring in storage, not listed.
    if (!result.hiring || result.openRoles < MIN_OPEN_ROLES) { dropped.push(item.domain); continue; }
    kept.push({ ...item, checkedAt, status: 'hiring', openRoles: result.openRoles,
      exampleRoles: result.exampleRoles.length ? result.exampleRoles : item.exampleRoles,
      newestPosting: result.newestPosting || item.newestPosting });
  }
  return { status: 'ok', employers: kept, updates, dropped, usedStoredFallback: Boolean(failure), failure };
}

/** Select, freshen, and re-select around dropped employers (bounded). */
async function buildSampleList({ employers, lead, now = new Date(), recheck, rounds = 3 }) {
  const states = agencyStates(lead);
  const pool = new Map(employers.map(item => [item.domain, { ...item }]));
  const exclude = new Set();
  const allUpdates = [];
  let usedStoredFallback = false;
  let last = null;
  for (let round = 0; round < rounds; round += 1) {
    const selection = selectSampleList({ employers: [...pool.values()], states, exclude });
    const fresh = await freshenEmployers({ employers: selection.employers, now, recheck });
    allUpdates.push(...fresh.updates);
    if (fresh.status === 'review') return { status: 'review', reason: fresh.reason, detail: fresh.detail, updates: allUpdates, states };
    usedStoredFallback ||= fresh.usedStoredFallback;
    for (const item of fresh.employers) pool.set(item.domain, item);
    for (const domain of fresh.dropped) {
      exclude.add(domain);
      const update = fresh.updates.find(item => item.domain === domain);
      pool.set(domain, { ...pool.get(domain), status: update?.hiring ? 'hiring' : 'not_hiring', openRoles: update?.openRoles || 0 });
    }
    last = { ...selection, employers: fresh.employers };
    // Once GetLeads failed, stop calling it: use what the stored rules allow.
    if (!fresh.dropped.length || fresh.failure) break;
  }
  if (!last || !last.employers.length) return { status: 'review', reason: 'no_employers_available', updates: allUpdates, states };
  return { status: 'ready', ...last, updates: allUpdates, usedStoredFallback, states };
}

function rolesLabel(item) {
  return item.openRolesLabel || String(item.openRoles);
}

function renderTable(employers) {
  const rows = [['Company', 'City, State', 'Open roles', 'Example roles'],
    ...employers.map(item => [noDashes(item.company), noDashes(`${item.city}, ${item.state}`), rolesLabel(item),
      noDashes([...new Set(item.exampleRoles.map(cleanTitle).filter(Boolean))].slice(0, 3).join(', '))])];
  const width = [0, 1, 2].map(col => Math.max(...rows.map(row => row[col].length)));
  const line = row => `${row[0].padEnd(width[0])} | ${row[1].padEnd(width[1])} | ${row[2].padEnd(width[2])} | ${row[3]}`;
  const header = line(rows[0]);
  return [header, '-'.repeat(header.length), ...rows.slice(1).map(line)].join('\n');
}

/** The plain-text body before the compliance footer. */
function renderSampleListBody({ firstName, company, market, employers }) {
  if (!employers?.length || employers.length > MAX_EMPLOYERS) throw new Error('sample list must hold 1 to 10 employers');
  const greeting = norm(firstName) ? `Hi ${noDashes(norm(firstName))},` : 'Hi there,';
  const agency = noDashes(norm(company)) || 'your agency';
  const body = `${greeting}\n\nHere are ${employers.length} employers in ${noDashes(market)} hiring the trades you place right now:\n\n`
    + `${renderTable(employers)}\n\n`
    + `These are the kinds of companies we'd reach and book meetings with for ${agency}.\n\n`
    + "Worth a 15-minute call to walk through how we'd approach them?\n\nDeins";
  const problem = sampleListBodyProblem(body);
  if (problem) throw new Error(problem);
  return body;
}

function sampleListBodyProblem(body) {
  const text = String(body || '');
  if (/[‒-―−]/.test(text)) return 'sample list body contains an en or em dash';
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us)\b/i.test(text)) return 'sample list body contains a link or domain';
  if (/@/.test(text)) return 'sample list body contains an email address';
  return null;
}

/**
 * Auto-send policy. Built OFF: SCALELAB_SAMPLE_LIST_AUTOSEND must be exactly
 * "true". Even then only a high-confidence request with a fresh list, a known
 * agency state, no negative signal, and 10 minutes after drafting.
 */
function autoSendDecision({ env = process.env, verdict, list, replyText = '', draftedAt, now = new Date() }) {
  if (env.SCALELAB_SAMPLE_LIST_AUTOSEND !== 'true') return { send: false, reason: 'autosend_off' };
  if (verdict?.intent !== INTENT || verdict.confidence !== 'high' || verdict.requiresModel) return { send: false, reason: 'not_high_confidence' };
  if (!list || list.status !== 'ready' || list.usedStoredFallback) return { send: false, reason: 'list_not_fresh' };
  if (!list.state || list.scope === 'national_state_unknown') return { send: false, reason: 'agency_state_unknown' };
  if (NEGATIVE.test(String(replyText))) return { send: false, reason: 'negative_signal' };
  const drafted = Date.parse(draftedAt || '');
  if (!Number.isFinite(drafted)) return { send: false, reason: 'draft_time_unknown' };
  if (new Date(now).getTime() - drafted < AUTOSEND_DELAY_MS) return { send: false, reason: 'delay_pending' };
  return { send: true, reason: 'autosend_policy_met' };
}

/**
 * Outcome of a sent list from later activity on the same lead:
 * call_booked > declined > replied (open) > no_reply after 14 days.
 */
function sampleListOutcome({ sentAt, activities = [], leadId, now = new Date() }) {
  const at = Date.parse(sentAt || '');
  if (!Number.isFinite(at)) return null;
  const later = activities.filter(row => (row.sourceLeadId === leadId || row.leadId === `CE-${leadId}`)
    && Date.parse(row.occurredAt) > at);
  if (later.some(row => row.eventType === 'call_booked' || row.eventType === 'meeting_booked')) return 'call_booked';
  const meta = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
  const replies = later.filter(row => String(row.eventId || '').startsWith('gmail-reply:'));
  if (replies.some(row => ['opt_out', 'explicit_rejection'].includes(meta(row).scalelabReply?.intent)
    || /unsubscribe|not_interested|explicit_rejection/i.test(String(row.eventType)))) return 'declined';
  if (replies.length) return 'replied';
  if (new Date(now).getTime() - at >= 14 * DAY_MS) return 'no_reply';
  return null;
}

module.exports = {
  INTENT, MAX_EMPLOYERS, MIN_IN_STATE, MIN_OPEN_ROLES, RECHECK_AFTER_DAYS, STORED_FALLBACK_DAYS, POSTING_WINDOW_DAYS,
  AUTOSEND_DELAY_MS, SAMPLE_OFFER, STATE_NAMES, NEIGHBORS,
  isHandsOnTitle, cleanTitle, summarizePostings, offeredSampleList, detectSampleListRequest,
  stateCode, agencyStates, selectSampleList, freshenEmployers, buildSampleList,
  renderTable, renderSampleListBody, sampleListBodyProblem, autoSendDecision, sampleListOutcome, noDashes,
};
