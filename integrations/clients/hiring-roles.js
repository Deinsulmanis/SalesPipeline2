'use strict';

/**
 * Raw job-posting titles → the worker role a sentence can name.
 *
 *   "Welder - 2nd Shift"                     → "Welders"
 *   "CNC Machinist II - Nights"              → "CNC Machinists"
 *   "Electrical & Instrumentation Technician" → "I&E Technicians"
 *
 * Only noise is removed: shift and schedule, level and grade, pay and bonus,
 * location, employer, union and job-id codes, and seniority. The trade itself
 * always comes from the posting; nothing maps one trade to another or invents
 * one. A title that does not reduce to a recognised trade — or that names a
 * helper, apprentice, supervisor or a bare "Technician" — is returned as
 * `review`, never guessed. The raw title is always kept alongside as evidence.
 *
 * Pure and deterministic: the same posting always reads the same way.
 */

// Singular trade nouns a cleaned role must end in, with their plural.
const TRADE_NOUNS = Object.freeze({
  welder: 'Welders', welders: 'Welders', machinist: 'Machinists', technician: 'Technicians', tech: 'Technicians',
  mechanic: 'Mechanics', electrician: 'Electricians', fabricator: 'Fabricators', fitter: 'Fitters',
  pipefitter: 'Pipefitters', steamfitter: 'Steamfitters', shipfitter: 'Shipfitters', millwright: 'Millwrights',
  operator: 'Operators', assembler: 'Assemblers', boilermaker: 'Boilermakers', ironworker: 'Ironworkers',
  plumber: 'Plumbers', insulator: 'Insulators', outfitter: 'Outfitters', brazer: 'Brazers',
  serviceman: 'Servicemen', craftsperson: 'Craftspeople', craftsman: 'Craftsmen', rigger: 'Riggers',
  tradesman: 'Tradesmen',
});
// A bare one of these does not say which trade; it needs a qualifier.
const GENERIC = new Set(['technician', 'tech', 'operator', 'tradesman']);
// Not the skilled trade itself: never promoted to it.
const NOT_THE_TRADE = /\b(?:helper|apprentice|trainee|supervisor|foreman|leader|laborer|deckhand|itinerant)\b/i;
// Whole-title equivalences: variants of ONE trade → its industry name.
const SYNONYMS = Object.freeze([
  [/\b(?:instrument(?:ation)?\s*(?:&|and)\s*electric(?:al|ian)|electric(?:al)?\s*(?:&|and)\s*instrument(?:ation|al)?|instrumentation,?\s*controls?\s*(?:&|and)\s*electrical|electrical,\s*instrumentation,?\s*and\s*controls|e\s*&\s*i|i\s*&\s*e|i\/e|instrument electrician|instrumentation\/electrician|ice)\s+(?:technician|tech)\b/i, 'I&E Technicians'],
  [/^technician,\s*i\s*&\s*e\b/i, 'I&E Technicians'],
  [/\b(?:e\s*&\s*i|i\s*&\s*e)\s+electrician\b|\belectrician\s+e\s*&\s*i\b/i, 'I&E Electricians'],
  [/^instrumentation\s*&\s*electrician$/i, 'I&E Technicians'],
  [/\b(?:i\s*&\s*c|instrument(?:ation)?\s*(?:&|and)\s*controls?)(?:\s+plant)?\s+(?:technician|tech)\b/i, 'I&C Technicians'],
  [/^instrument\s*&\s*calibration technician\b/i, 'Instrument Calibration Technicians'],
  [/^(?:sr\.?\s+|senior\s+)?technician(?:\s+sr)?,\s*maintenance\b/i, 'Maintenance Technicians'],
  [/^computer numerical control machinist$/i, 'CNC Machinists'],
  [/^machinist\s*\(?cnc\)?$/i, 'CNC Machinists'],
  [/^cnc mill(?:ing)? machinist$/i, 'CNC Mill Machinists'],
  [/^(?:\w+\s+)?welding(?: department)?$/i, 'Welders'],
]);
const KEEP_CAPS = new Set(['CNC', 'MIG', 'TIG', 'HVAC', 'PLC', 'VMC', 'VTL', 'ASME', 'I&E', 'E&I', 'I&C', 'DOT', 'FAA', 'LNG', 'PM']);
const SMALL = new Set(['and', 'or', 'of']);
const SHIFT_WORD = String.raw`(?:1st|2nd|3rd|first|second|third|day|days|dayshift|night|nights|nightshift|overnight|evening|evenings|swing|weekend|weekends|off|afternoon)`;
const WELD_PROCESS = /\b(?:[1-6]g|mig|tig|fcaw|gmaw|smaw|gtaw|arc|stick)\b/ig;

const TRADE_HYPHEN = new RegExp(String.raw`\b(${Object.keys(TRADE_NOUNS).join('|')})-(?=\S)`, 'ig');

const nounOf = word => {
  const lower = String(word || '').toLowerCase();
  return TRADE_NOUNS[lower] ? lower : TRADE_NOUNS[lower.split('-').pop()] ? lower.split('-').pop() : null;
};

function titleWord(word) {
  if (word.includes('/')) return word.split('/').map(titleWord).join('/');
  return word.split('-').map(part => {
    if (KEEP_CAPS.has(part.toUpperCase())) return part.toUpperCase();
    if (SMALL.has(part.toLowerCase())) return part.toLowerCase();
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join('-');
}

function pluralize(phrase) {
  const words = phrase.split(' ').filter(Boolean);
  const last = words[words.length - 1];
  const noun = nounOf(last);
  if (!noun) return null;
  const prefix = last.includes('-') && last.toLowerCase() !== noun ? `${titleWord(last.slice(0, last.toLowerCase().lastIndexOf(noun) - 1))}-` : '';
  return [...words.slice(0, -1).map(titleWord), prefix + TRADE_NOUNS[noun]].join(' ');
}

function normalizeText(raw) {
  return String(raw || '').normalize('NFKC')
    .replace(/\s\uFFFD\s/g, ' - ').replace(/\uFFFD/g, ' ').replace(/[\u2013\u2014]/g, '-')
    .replace(/\([^)]*\)?/g, ' ').replace(/\*[^*]*\*?/g, ' ')
    .replace(/([a-z])(\d(?:st|nd|rd)\b)/ig, '$1 $2')
    // "Plumber-Pipefitter" names two trades.
    .replace(/\b([a-z]+)-([a-z]+)\b/ig, (m, a, b) => (nounOf(a) && nounOf(b) ? `${a}/${b}` : m))
    // A hyphen straight after the trade starts a qualifier: "Welder-2nd Shift", "Electrician-Master".
    .replace(TRADE_HYPHEN, (m, noun) => `${noun} - `)
    .replace(/\s+/g, ' ').trim();
}

// Remove schedule, grade, pay, seniority and code noise from one segment.
function stripNoise(segment) {
  let s = ` ${segment} `;
  s = s.replace(/\$[\d,.]+\S*|\b\d+\s*(?:hours?|hrs?)\b|\bm-f\b.*$|\b\d{1,2}(?::\d\d)?\s*(?:am|pm)\b.*$/ig, ' ');
  s = s.replace(/(?:^|\s)(?:entry[- ]level|full[- ]time|part[- ]time)(?=\s|$)/ig, ' ');
  s = s.replace(/\b(?:\d(?:st|nd|rd)\s+class|class\s+[abc]|[abc]\s+class|level\s+\S+|associate\s+\d|journey(?:man)?\s+level|journey\s+only)\b/ig, ' ');
  s = s.replace(new RegExp(String.raw`\b${SHIFT_WORD}(?:\s*(?:/|or|and|&)\s*${SHIFT_WORD})*(?:\s+shifts?)?\b`, 'ig'), ' ');
  s = s.replace(/\bshifts?\b/ig, ' ');
  s = s.replace(/(?:^|\s)(?:full[- ]time|part[- ]time|entry[- ]level|experienced|senior|sr\.?|junior|lead|general|certified|apprentice or|skilled|basic|master)(?=\s|$)/ig, ' ');
  s = s.replace(/(?:^|\s)(?:[a-z]{1,3}\d+[a-z]?|j\d|t-|ilus|[a-z]{3}\d{3})(?=\s)/ig, ' ');   // site/union/job codes
  // A short ALL-CAPS token ahead of the trade is a site or union code ("CCF",
  // "EL", "OK", "MECH") unless it is a known abbreviation such as CNC or PLC.
  s = s.replace(/^\s*([A-Z]{2,4})(?=\s)/, (m, code) => (KEEP_CAPS.has(code) ? m : ' '));
  s = s.replace(/[\s,]+-?us\s*$/i, ' ');
  for (let i = 0; i < 3; i += 1) {
    s = s.replace(/[\s/]+(?:[ivx]+(?:\/[ivx]+)*|\d+(?:\/c)?|[abcd](?:-[abcd])?|l|p\d?|lg|na|skid|journeyman)\s*$/i, ' ');
  }
  return s.replace(/\s+/g, ' ').replace(/^[\s,/&-]+|[\s,/&-]+$/g, '').trim();
}

/** { raw, clean, status: 'clean'|'review', reason? } — clean is null when status is review. */
function cleanHiringRole(raw) {
  const original = String(raw || '').trim();
  const review = reason => ({ raw: original, clean: null, status: 'review', reason });
  if (!original) return review('no role');
  if (NOT_THE_TRADE.test(original)) return review('names a helper, apprentice, supervisor or similar, not the trade');
  let text = normalizeText(original);
  const synonym = value => SYNONYMS.find(([pattern]) => pattern.test(String(value).replace(/\bsr\.?\s+/i, '')));
  const early = synonym(text);
  if (early) return { raw: original, clean: early[1], status: 'clean' };
  // A list of welding processes ("MIG/TIG", "FCAW / GMAW / Arc") qualifies the
  // welder; it is not a list of trades. A single process ("TIG Welder") stays.
  if (/\bweld(?:er|ers)\b/i.test(text) && (text.match(WELD_PROCESS) || []).length >= 2) text =text.replace(WELD_PROCESS, ' ').replace(/(?:^|\s)[/&](?=\s|$)|\s*\/\s*(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const segments = text.split(/\s+\|\s+|\s*-{1,2}\s+|\s+-{1,2}\s*|\s*:\s*|,\s*/).map(stripNoise);
  let core = segments[0] || '';
  // A generic head ("Lead Mechanic", "Technician") with the trade in the
  // qualifier ("- Shipfitter", "-Pipeline") reads as the qualifier's trade.
  const headNoun = nounOf(core.split(' ').pop());
  const next = segments[1] || '';
  if ((!core || !headNoun || GENERIC.has(headNoun) || headNoun === 'mechanic') && next && next.split(' ').length <= 2 && nounOf(next.split(' ').pop()) && !GENERIC.has(nounOf(next.split(' ').pop()))) core = next;
  if (!core) return review('nothing left after removing qualifiers');
  const late = synonym(core);
  if (late) return { raw: original, clean: late[1], status: 'clean' };
  // Cut a trailing qualifier after the trade noun: "Machinist Lathe", "Millwright Maintenance".
  const words = core.split(' ');
  const lastNoun = words.map(nounOf).lastIndexOf(words.map(nounOf).filter(Boolean).pop());
  if (lastNoun >= 0 && lastNoun < words.length - 1 && words.length - 1 - lastNoun <= 2 && !/[/&]/.test(words.slice(lastNoun + 1).join(' '))) core = words.slice(0, lastNoun + 1).join(' ');
  // Two trades named together: "Welder/Fabricator", "Fitter & Welder".
  const parts = core.split(/\s*(?:\/|&|\band\b)\s*/i).filter(Boolean);
  if (parts.length === 2 && parts.every(part => nounOf(part.split(' ').pop()))) {
    const both = parts.map(pluralize);
    if (both.some(part => /^(?:Technicians|Operators|Tradesmen)$/.test(part))) return review(`"${core}" does not name a specific trade`);
    return { raw: original, clean: both[0] === both[1] ? both[0] : `${both[0]} and ${both[1]}`, status: 'clean' };
  }
  if (parts.length > 2) return review(`"${core}" names more than two roles`);
  if (/\d/.test(core) || core.split(' ').length > 5) return review(`could not reduce "${core}" to one trade`);
  const clean = pluralize(core.replace(/\s*&\s*/g, ' & ').replace(/\s*\/\s*/g, '/'));
  if (!clean) return review(`"${core}" does not name a trade`);
  if (/^(?:Technicians|Operators|Tradesmen)$/.test(clean)) return review(`"${core}" does not name a specific trade`);
  return { raw: original, clean, status: 'clean' };
}

module.exports = { cleanHiringRole, TRADE_NOUNS };
