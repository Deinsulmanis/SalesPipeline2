'use strict';
/**
 * canonical-reply.js — what a reply actually IS. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * The CRM previously answered "did this lead reply, and how did they feel?" by
 * reading `[REPLY: ...]` tags out of a notes column, and — when no tag existed —
 * by looking at the lead's CRM stage. That second path is the dangerous one: a
 * stage records what a human did to a row, not what a prospect said. Two real
 * production leads are classified Negative today with no reply evidence of any
 * kind, purely because someone once set their stage to "Unsubscribed".
 *
 * This module replaces guessing with evidence. It answers three questions and
 * refuses to answer any of them without something to point at:
 *
 *   1. Is there trustworthy evidence a reply happened at all?
 *   2. If so, was it a human or a machine?
 *   3. If human, what is the COMMERCIAL intent — not the sentiment?
 *
 * Point 3 matters more than it sounds. A prospect who calls AI email "obviously
 * robotic garbage" and then asks for pricing and a trial is a live opportunity,
 * not a rejection. The old classifier matched "not interested" anywhere in the
 * text and stopped reading. Buying intent therefore outranks negative wording
 * here, deliberately and by design.
 *
 * Nothing in this file performs I/O, mutates a lead, or rewrites history.
 */

// ── CANONICAL STATES ────────────────────────────────────────────────────────
// Deliberately small. Every value is something we can defend from evidence.
const REPLY_STATE = Object.freeze({
  POSITIVE: 'positive',                       // genuine human, commercial intent
  NEGATIVE: 'negative',                       // genuine human, explicit rejection/opt-out
  NEEDS_HUMAN: 'needs_human',                 // genuine human, needs a person to read it
  AUTOMATED_REPLY: 'automated_reply',         // a machine answered, not a person
  CONTACT_CHANGE_REVIEW: 'contact_change_review', // "we moved, write to X instead"
  UNKNOWN: 'unknown',                         // insufficient evidence — NOT a sentiment
});

// Why a machine answered. Useful because a temporary closure is a "come back
// later", while a mailbox migration is a "this address is dead".
const AUTOMATED_SUBTYPE = Object.freeze({
  AUTORESPONDER: 'autoresponder',             // generic "we got your message"
  OUT_OF_OFFICE: 'out_of_office',             // a person is away
  TEMPORARY_CLOSURE: 'temporary_closure',     // the business is shut for a period
  MAILBOX_MIGRATION: 'mailbox_migration',     // the mailbox itself is going away
});

// Why a human message still needs a person. Kept short on purpose.
const NEEDS_HUMAN_REASON = Object.freeze({
  FORWARDED_TO_DECISION_MAKER: 'forwarded_to_decision_maker',
  QUESTION_OR_OBJECTION: 'question_or_objection',
  ADMINISTRATIVE_RESPONSE: 'administrative_response',
  UNCLEAR_INTENT: 'unclear_intent',
});

// Where a classification came from. The whole point of this pass is that these
// stay distinguishable forever rather than collapsing into one opaque category.
const EVIDENCE_SOURCE = Object.freeze({
  MANUAL_OVERRIDE: 'manual_override',         // a human explicitly corrected it
  CANONICAL_ACTIVITY: 'canonical_activity',   // a stored inbound-reply event
  LEGACY_TAG: 'legacy_tag',                   // a historical [REPLY: ...] note
  NONE: 'none',                               // nothing to point at
});

// Bumped whenever the rules below change meaning, so a stored classification
// can always be traced to the logic that produced it.
const CLASSIFIER_VERSION = 'reply_v2_evidence';

/**
 * The instant canonical reply ingestion became LIVE in production.
 *
 * This is a historical fact, not a setting, so it is committed to source rather
 * than left to an environment variable that could be lost on a restart or a new
 * environment. It is the moment Railway deployment
 * 69810784-33d6-4a77-a5f5-659ff18510d7 (commit a190c22, "classify replies from
 * evidence instead of CRM state") reached SUCCESS and began serving:
 *
 *   git commit a190c22   2026-08-27T23:33:39Z
 *   build started        2026-08-27T23:33:57.290Z
 *   reached SUCCESS      2026-08-27T23:34:39.552Z   <- the boundary
 *
 * The SUCCESS instant is used, not the commit or build-start time: until the
 * deployment was actually serving, replies were processed by the OLD code,
 * which had no canonical writer at all. Choosing the latest of the three is
 * also the conservative choice — it can only ever suppress a false ingestion
 * failure, never invent one.
 *
 * An env override exists for tests and for future re-deployments of the writer.
 */
const CANONICAL_REPLY_BOUNDARY = '2026-08-27T23:34:39.552Z';

/**
 * Resolve the boundary, failing SAFE.
 *
 * Semantics are strict: a reply counts as post-boundary only when it occurred
 * STRICTLY AFTER the boundary instant. A reply landing exactly on it is
 * ambiguous — it could have been handled by either build — so it is treated as
 * historical. Ambiguity must never manufacture an ingestion failure.
 *
 * An unparseable override is reported rather than silently ignored, because a
 * boundary that quietly stops working would disable the detection it exists for.
 */
function resolveCanonicalReplyBoundary(override) {
  const raw = override === undefined || override === null || override === ''
    ? CANONICAL_REPLY_BOUNDARY
    : String(override);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { at: null, source: 'invalid', configured: raw, error: `"${raw}" is not a parseable timestamp` };
  }
  return {
    at: new Date(ms).toISOString(),
    source: override ? 'override' : 'built_in',
    configured: raw, error: null,
  };
}

/** Strictly after the boundary. Equal instants are historical (fail safe). */
function isAfterBoundary(occurredAt, boundaryAt) {
  if (!boundaryAt) return false;
  const at = Date.parse(occurredAt || '');
  if (!Number.isFinite(at)) return false;   // no timestamp -> cannot be proven post-boundary
  return at > Date.parse(boundaryAt);
}

const GENUINE_HUMAN_STATES = Object.freeze([
  REPLY_STATE.POSITIVE, REPLY_STATE.NEGATIVE, REPLY_STATE.NEEDS_HUMAN,
]);

const lower = value => String(value || '').toLowerCase();

// ── IDENTITY ────────────────────────────────────────────────────────────────

/**
 * Is this address structurally usable as a reply identity?
 *
 * Production contains `-687-1887silverspringsspa@gmail.com` — a phone number
 * fused onto a mailbox name by an import. Mail to it goes nowhere, so anything
 * "matched" through it is fiction. A malformed address must never be allowed to
 * manufacture reply evidence, so this is checked before any classification.
 */
function malformedEmailReason(email) {
  const value = String(email || '').trim();
  if (!value) return 'no email address';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'not a syntactically valid address';
  const localPart = value.split('@')[0];
  // A real local part does not begin with punctuation, and an import that
  // concatenated a phone number leaves a long digit run at the front.
  if (/^[^a-z0-9]/i.test(localPart)) return 'local part starts with punctuation';
  if (/^\d{3,}/.test(localPart)) return 'local part starts with a digit run, likely a fused phone number';
  if (/\.\./.test(value)) return 'consecutive dots';
  return '';
}

const isUsableReplyIdentity = email => malformedEmailReason(email) === '';

// ── TEXT SIGNALS ────────────────────────────────────────────────────────────
// Each group is a list of [name, pattern] so a match can be REPORTED, not just
// acted on. Explaining a classification is as important as making it.

// A machine wrote this. Checked first: an autoresponder that happens to contain
// the word "pricing" is still an autoresponder.
const AUTOMATED_MARKERS = [
  ['auto_reply_phrase', /\b(?:this is an )?(?:auto(?:mated|matic)?[- ]?(?:reply|response|message)|autoreply)\b/i],
  ['do_not_reply', /\b(?:do not reply|no-?reply to this)\b/i],
  ['acknowledgement', /\b(?:we (?:have )?received your (?:message|email|inquiry)|thank you for (?:contacting|reaching out to) us)\b.*\b(?:will (?:get back|respond|reply)|as soon as)\b/is],
];

const OUT_OF_OFFICE_MARKERS = [
  ['ooo_phrase', /\b(?:out of (?:the )?office|on (?:vacation|holiday|leave|annual leave)|away from (?:my|the) (?:desk|office))\b/i],
  ['currently_away', /\b(?:i am|i'?m|we are|we'?re) (?:currently )?away\b/i],
];

const TEMPORARY_CLOSURE_MARKERS = [
  ['closure_phrase', /\b(?:closed|clinic is closed|office is closed|shut(?:ting)? down|closure)\b.*\b(?:until|from|for|reopen|re-?open|back|resum)/is],
  ['break_phrase', /\b(?:summer|winter|holiday|christmas|seasonal) break\b/i],
  ['reopen_phrase', /\b(?:we (?:will )?re-?open|reopening|will resume|back in (?:the )?office)\b/i],
];

// Deliberately narrow. An earlier, looser version matched "please use the
// emergency line" in a dental clinic's autoresponder and routed it to
// contact-change review — a redirect claim has to be about a MAILBOX.
const MAILBOX_MIGRATION_MARKERS = [
  ['no_longer_monitored', /\b(?:this (?:e-?mail|address|inbox) is no longer (?:monitored|in use|active)|we will no longer (?:reply|respond) from this)\b/i],
  ['address_changed', /\b(?:new (?:e-?mail|email) address|(?:e-?mail|email) address has changed|we (?:have )?moved|now reach us at|(?:write to|contact) us at)\b/i],
];

// EXPLICIT commercial intent. This is the list that outranks negative wording,
// so it is restricted to things a buyer actually does — never vague positivity.
const BUYING_INTENT_MARKERS = [
  ['pricing', /\b(?:pricing|price|prices|how much|cost|quote|rates?|monthly fee|subscription cost)\b/i],
  ['trial', /\b(?:try it|test it|trial|test access|demo account|try this out|give it a (?:try|go)|see it in action)\b/i],
  ['how_it_works', /\b(?:how does (?:it|this) work|how would (?:it|this) work|what does it do|tell me more about how)\b/i],
  ['send_info', /\b(?:send (?:me )?(?:more )?(?:info|information|details)|more (?:info|information|details)|email me the details)\b/i],
  ['next_steps', /\b(?:next steps?|what(?:'?s| is) the next step|how do we (?:start|proceed)|where do we go from here)\b/i],
  ['meeting', /\b(?:book a (?:call|demo|meeting)|schedule a (?:call|demo|meeting)|set up a (?:call|demo|meeting)|happy to (?:chat|talk|meet)|video call|zoom)\b/i],
  ['willing_to_evaluate', /\b(?:willing to (?:try|test|look|evaluate)|open to (?:trying|testing|seeing)|would consider|interested in seeing)\b/i],
  // Plain expressed interest. The subject pattern is required so this can never
  // fire on "we are NOT interested" — the negation sits exactly where the
  // optional intensifier would be, so the match simply fails.
  ['expressed_interest', /\b(?:i am|i'?m|we are|we'?re)\s+(?:very\s+|quite\s+|really\s+)?interested\b|\btell me more\b|\b(?:sounds|looks) (?:good|great|interesting)\b|\byes,?\s*please\b/i],
];

// Explicit rejection. Note what is NOT here: criticism of AI, doubts about
// accents, worries about reliability. Those are objections, not refusals.
const REJECTION_MARKERS = [
  ['not_interested', /\b(?:not interested|no(?:t)? a fit|not for us|we'?re (?:all set|good)|no thank(?:s| you)|pass on this|we'?ll pass)\b/i],
  ['stop_contact', /\b(?:stop (?:emailing|contacting)|don'?t contact|do not contact|leave us alone)\b/i],
];

const UNSUBSCRIBE_MARKERS = [
  ['unsubscribe', /\b(?:unsubscribe|remove me|take me off|opt[- ]?out)\b/i],
];

// A human replied but routed the message onward rather than engaging.
const FORWARDED_MARKERS = [
  ['forwarded', /\b(?:forward(?:ed|ing)? (?:this |it |your (?:email|message) )?(?:on |along )?to|pass(?:ed|ing)? (?:this|it) (?:on )?to|will (?:let|tell)|when (?:she|he|they) (?:returns?|is back|are back)|office manager|practice manager|the owner|decision maker)\b/i],
];

const WRONG_PERSON_MARKERS = [
  ['wrong_person', /\b(?:wrong person|not the right person|i (?:don'?t|do not) handle|i'?m not the one who)\b/i],
];

const firstMatch = (markers, text) => {
  for (const [name, pattern] of markers) if (pattern.test(text)) return name;
  return '';
};

// ── DATE EXTRACTION ─────────────────────────────────────────────────────────

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTH_RE = MONTHS.join('|');

/**
 * A return date, but only when it is unambiguous.
 *
 * "back July 21" is confident. "back next week", "back shortly", or a bare
 * "21st" is not, and returns ''. Inventing a date here would silently schedule
 * real outreach at a real business on a guess, so ambiguity always loses.
 */
function extractReturnDate(text, { year } = {}) {
  const value = String(text || '');
  // Anchored to an explicit return/reopen phrase so a random date in a
  // signature or an appointment reminder is never mistaken for a return.
  const anchored = new RegExp(
    `(?:until|back(?: in the office)?(?: on)?|re-?open(?:s|ing)?(?: on)?|resum\\w*(?: on)?|return(?:s|ing)?(?: on)?)\\s+` +
    `(?:the\\s+)?(?:(${MONTH_RE})\\s+(\\d{1,2})|(\\d{1,2})\\s+(${MONTH_RE}))`,
    'i');
  const match = anchored.exec(value);
  if (!match) return '';
  const monthName = lower(match[1] || match[4]);
  const day = Number(match[2] || match[3]);
  const monthIndex = MONTHS.indexOf(monthName);
  if (monthIndex < 0 || !Number.isInteger(day) || day < 1 || day > 31) return '';
  // A year is only used when supplied by the caller; we never guess one.
  if (!year) return '';
  const iso = new Date(Date.UTC(year, monthIndex, day));
  if (iso.getUTCMonth() !== monthIndex || iso.getUTCDate() !== day) return '';
  return iso.toISOString().slice(0, 10);
}

/**
 * An email address the sender is redirecting us to. Returned as EVIDENCE only —
 * this module never swaps a lead's identity, and nothing downstream may either
 * without a human approving it.
 */
function extractProposedEmail(text, { currentEmail = '' } = {}) {
  const found = String(text || '').match(/[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const current = lower(currentEmail);
  for (const candidate of found) {
    const value = lower(candidate);
    if (value === current) continue;
    if (/(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster)/.test(value)) continue;
    if (!isUsableReplyIdentity(value)) continue;
    return value;
  }
  return '';
}

// ── CLASSIFICATION ──────────────────────────────────────────────────────────

/**
 * Classify the TEXT of an inbound message. Text only — no stage, no company
 * name, no CRM state of any kind reaches this function.
 *
 * Order matters and encodes the policy:
 *   machine before human, opt-out before intent, intent before sentiment.
 */
function classifyReplyText(text, { subject = '', currentEmail = '', year = null } = {}) {
  const body = `${subject}\n${String(text || '')}`.trim();
  const signals = [];
  const result = (state, extra = {}) => ({
    state, signals, classifierVersion: CLASSIFIER_VERSION,
    subtype: null, reason: null, genuineHuman: GENUINE_HUMAN_STATES.includes(state),
    ...extra,
  });

  if (!body) return result(REPLY_STATE.UNKNOWN, { confidence: 'none', note: 'no message text to classify' });

  // 1. A redirect to a different mailbox. Checked before generic automation
  //    because it needs a human decision, not a "come back later".
  const migration = firstMatch(MAILBOX_MIGRATION_MARKERS, body);
  const proposedEmail = migration ? extractProposedEmail(body, { currentEmail }) : '';
  // A redirect claim needs corroboration: either a replacement address to point
  // at, or an explicit statement that this mailbox is dead. Otherwise it is
  // just a sentence, and treating it as a contact change would strand the lead.
  if (migration && (proposedEmail || migration === 'no_longer_monitored')) {
    signals.push(migration);
    return result(REPLY_STATE.CONTACT_CHANGE_REVIEW, {
      subtype: AUTOMATED_SUBTYPE.MAILBOX_MIGRATION,
      proposedEmail: proposedEmail || null,
      // Explicitly recorded so no downstream code mistakes evidence for consent.
      identityMutationAllowed: false,
      confidence: proposedEmail ? 'high' : 'medium',
    });
  }

  // 2. A machine answered.
  const closure = firstMatch(TEMPORARY_CLOSURE_MARKERS, body);
  const ooo = firstMatch(OUT_OF_OFFICE_MARKERS, body);
  const auto = firstMatch(AUTOMATED_MARKERS, body);
  if (closure || ooo || auto) {
    const subtype = closure ? AUTOMATED_SUBTYPE.TEMPORARY_CLOSURE
      : ooo ? AUTOMATED_SUBTYPE.OUT_OF_OFFICE
        : AUTOMATED_SUBTYPE.AUTORESPONDER;
    signals.push(closure || ooo || auto);
    const returnDate = extractReturnDate(body, { year });
    return result(REPLY_STATE.AUTOMATED_REPLY, {
      subtype, returnDate: returnDate || null,
      confidence: returnDate ? 'high' : 'medium',
    });
  }

  // 3. An explicit opt-out is unambiguous and outranks everything human.
  const unsubscribe = firstMatch(UNSUBSCRIBE_MARKERS, body);
  if (unsubscribe) {
    signals.push(unsubscribe);
    return result(REPLY_STATE.NEGATIVE, { reason: 'unsubscribe_request', confidence: 'high' });
  }

  // 4. Commercial intent — BEFORE rejection wording, which is the whole fix.
  //    A prospect may criticise the product at length and still be buying.
  const intent = firstMatch(BUYING_INTENT_MARKERS, body);
  const rejection = firstMatch(REJECTION_MARKERS, body);
  if (intent) {
    signals.push(intent);
    if (rejection) signals.push(`overridden:${rejection}`);
    return result(REPLY_STATE.POSITIVE, {
      reason: 'explicit_evaluation_intent',
      // Lower confidence when the same message also rejects: a human should
      // still see it, even though the funnel counts it as a live opportunity.
      confidence: rejection ? 'medium' : 'high',
    });
  }

  // 5. Rejection with no intent attached.
  if (rejection) {
    signals.push(rejection);
    return result(REPLY_STATE.NEGATIVE, { reason: 'explicit_rejection', confidence: 'high' });
  }

  // 6. Genuine human, but a person needs to read it.
  const wrongPerson = firstMatch(WRONG_PERSON_MARKERS, body);
  const forwarded = firstMatch(FORWARDED_MARKERS, body);
  if (forwarded || wrongPerson) {
    signals.push(forwarded || wrongPerson);
    return result(REPLY_STATE.NEEDS_HUMAN, {
      reason: NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER, confidence: 'medium',
    });
  }
  if (/\?/.test(body)) {
    signals.push('question_mark');
    return result(REPLY_STATE.NEEDS_HUMAN, {
      reason: NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION, confidence: 'medium',
    });
  }
  return result(REPLY_STATE.NEEDS_HUMAN, {
    reason: NEEDS_HUMAN_REASON.UNCLEAR_INTENT, confidence: 'low',
  });
}

// ── EVIDENCE HIERARCHY ──────────────────────────────────────────────────────

// Legacy `[REPLY: ...]` labels, mapped to canonical states. These stay usable
// as FALLBACK evidence — they were written by a real process about a real
// message — but they never outrank a verified inbound activity.
const LEGACY_TAG_STATE = [
  [/^unsubscribed?$/i, REPLY_STATE.NEGATIVE, 'unsubscribe_request'],
  [/^not interested$/i, REPLY_STATE.NEGATIVE, 'explicit_rejection'],
  [/^(?:interested|meeting requested)$/i, REPLY_STATE.POSITIVE, 'legacy_interest_tag'],
  [/^(?:ooo|out of office)/i, REPLY_STATE.AUTOMATED_REPLY, AUTOMATED_SUBTYPE.OUT_OF_OFFICE],
  [/^wrong person/i, REPLY_STATE.NEEDS_HUMAN, NEEDS_HUMAN_REASON.ADMINISTRATIVE_RESPONSE],
  [/^question/i, REPLY_STATE.NEEDS_HUMAN, NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION],
  [/^needs human$/i, REPLY_STATE.NEEDS_HUMAN, NEEDS_HUMAN_REASON.UNCLEAR_INTENT],
];

function legacyTagsFrom(notes) {
  return [...String(notes || '').matchAll(/\[REPLY:\s*([^\]]+)\]/gi)]
    .map(match => String(match[1] || '').split(/[—|]/)[0].trim())
    .filter(Boolean);
}

function stateFromLegacyTag(label) {
  for (const [pattern, state, reason] of LEGACY_TAG_STATE) {
    if (pattern.test(String(label || '').trim())) return { state, reason };
  }
  return null;
}

const INBOUND_REPLY_EVENT = 'inbound_reply';
// Event types that constitute verified inbound evidence. The canonical event is
// preferred; the older per-category names remain valid evidence of a real
// message and are read, never rewritten.
const LEGACY_REPLY_EVENT_TYPES = Object.freeze([
  'inbound_reply', 'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply',
  'out_of_office_reply',
]);

const parseMetadata = value => {
  try { return JSON.parse(value || '{}') || {}; } catch (_) { return {}; }
};

/**
 * The single question the rest of the CRM should ask: what do we actually know
 * about this lead's reply state, and on what basis?
 *
 * Precedence, strongest first:
 *   1. an explicit human override
 *   2. a stored inbound-reply activity (verified provider evidence)
 *   3. a legacy [REPLY: ...] tag
 *   4. nothing → UNKNOWN
 *
 * A CRM stage is NOT on that list at any position. That omission is the point
 * of this module: `emailStatus: replied` and `stage: Unsubscribed` describe
 * spreadsheet cells, not messages, and two production leads are mislabelled
 * Negative today purely because the old code treated them as proof.
 */
function resolveReplyState(lead = {}, { activities = [], manualOverride = null } = {}) {
  const base = {
    state: REPLY_STATE.UNKNOWN, source: EVIDENCE_SOURCE.NONE, subtype: null, reason: null,
    genuineHuman: false, classifierVersion: CLASSIFIER_VERSION,
    identityIssue: malformedEmailReason(lead.email) || null,
  };

  // 1. A human said so.
  if (manualOverride && manualOverride.state) {
    return {
      ...base, state: manualOverride.state, source: EVIDENCE_SOURCE.MANUAL_OVERRIDE,
      subtype: manualOverride.subtype || null, reason: manualOverride.reason || null,
      genuineHuman: GENUINE_HUMAN_STATES.includes(manualOverride.state),
      overriddenBy: manualOverride.by || null, overriddenAt: manualOverride.at || null,
    };
  }

  // 2. Verified inbound activity. A malformed identity cannot carry evidence,
  //    so it is rejected before any activity is trusted.
  if (!base.identityIssue) {
    const inbound = activities
      .filter(row => LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || '')))
      .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
    // The most recent GENUINE human message wins, so a later real reply is not
    // masked by an autoresponder that arrived first.
    const genuine = inbound.find(row => {
      const meta = parseMetadata(row.metadata);
      const state = meta.canonicalState || '';
      return state ? GENUINE_HUMAN_STATES.includes(state) : String(row.eventType) !== 'out_of_office_reply';
    });
    const chosen = genuine || inbound[0];
    if (chosen) {
      const meta = parseMetadata(chosen.metadata);
      const state = meta.canonicalState
        || (String(chosen.eventType) === 'out_of_office_reply' ? REPLY_STATE.AUTOMATED_REPLY : null);
      if (state) {
        return {
          ...base, state, source: EVIDENCE_SOURCE.CANONICAL_ACTIVITY,
          subtype: meta.subtype || null, reason: meta.reason || null,
          genuineHuman: GENUINE_HUMAN_STATES.includes(state),
          providerMessageId: meta.gmailMessageId || null,
          providerThreadId: meta.gmailThreadId || null,
          occurredAt: chosen.occurredAt || null,
        };
      }
    }
  }

  // 3. Legacy tags — real evidence, weaker provenance.
  if (!base.identityIssue) {
    for (const label of legacyTagsFrom(lead.notes)) {
      const mapped = stateFromLegacyTag(label);
      if (!mapped) continue;
      return {
        ...base, state: mapped.state, source: EVIDENCE_SOURCE.LEGACY_TAG,
        reason: mapped.reason, legacyTag: label,
        genuineHuman: GENUINE_HUMAN_STATES.includes(mapped.state),
      };
    }
  }

  // 4. Nothing. Say so, rather than inventing a sentiment from a stage.
  return {
    ...base,
    note: base.identityIssue
      ? 'lead identity is malformed, so no reply evidence can be trusted'
      : 'no reply evidence: no inbound activity and no reply tag',
  };
}

/** Did a real person send us a message? The denominator for genuine analytics. */
const isGenuineHumanReply = resolved => Boolean(resolved && resolved.genuineHuman);

/** Did any inbound message arrive, human or machine? Operational statistic only. */
const isInboundMessage = resolved =>
  Boolean(resolved) && resolved.state !== REPLY_STATE.UNKNOWN;

module.exports = {
  REPLY_STATE, AUTOMATED_SUBTYPE, NEEDS_HUMAN_REASON, EVIDENCE_SOURCE,
  CLASSIFIER_VERSION, GENUINE_HUMAN_STATES, INBOUND_REPLY_EVENT, LEGACY_REPLY_EVENT_TYPES,
  CANONICAL_REPLY_BOUNDARY, resolveCanonicalReplyBoundary, isAfterBoundary,
  classifyReplyText, resolveReplyState, isGenuineHumanReply, isInboundMessage,
  extractReturnDate, extractProposedEmail, malformedEmailReason, isUsableReplyIdentity,
  legacyTagsFrom, stateFromLegacyTag,
};
