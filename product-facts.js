'use strict';
/**
 * product-facts.js — the ONLY thing the reply-answering model may state as fact.
 * ─────────────────────────────────────────────────────────────────────────────
 * Haiku answers inbound questions strictly from this file. If a question cannot
 * be answered from what is here, the answer is not invented — the reply is
 * drafted for human review instead (see answerQuestion in outreach-agent.js).
 *
 * Two hard rules encoded here rather than left to the prompt:
 *   1. NO PRICING. There is deliberately no price anywhere in this file, so the
 *      model has nothing to quote even if asked directly.
 *   2. NO NEW CAPABILITIES. Adding a claim here is the only way to make the
 *      assistant able to make it. Keep every line something that is actually
 *      true of the product today.
 *
 * Facts are offer-scoped. Unknown / unrouted leads must not inherit dental
 * facts. Staffing never receives dental or clinic language.
 */

const { CAMPAIGN_FAMILY, familyForLead, resolveLeadFamily } = require('./integrations/campaign-versions');

const DENTAL_PRODUCT_FACTS = [
  '# What it is',
  '24/7 answering and booking software for dental practices that handles missed calls and helps turn them into booked patients.',
  'It answers in a natural voice, takes the caller\'s details, and books or requests an appointment.',
  'It is set up with the clinic\'s own services, hours and booking preferences, so it answers like it already works there.',
  '',
  '# The demo',
  'The demo build is free and configured with the clinic\'s real services — it is a working sample, not a generic recording.',
  'It never touches the clinic\'s real phone line, so there is no risk to existing calls and nothing to switch over to try it.',
  '',
  '# Accents and unclear audio',
  'When a caller has a strong accent or the line is unclear, it confirms details back to the caller rather than guessing — names, phone numbers and appointment times are read back for confirmation.',
  'If it still is not confident after confirming, it escalates: it takes a message and flags the call for a human to follow up, instead of booking something wrong.',
  '',
  '# Booking confirmation',
  'Once a booking is taken, the caller gets both an SMS and an email confirmation.',
  'Two channels are used on purpose — it is the reliability check. If one fails to reach them, the other still lands, and the clinic has a record either way.',
  '',
  '# What it does NOT do',
  'It does not replace the front desk. It covers the calls that would otherwise ring out.',
  'It does not diagnose, give clinical advice, or discuss treatment specifics.',
].join('\n');

const STAFFING_PRODUCT_FACTS = [
  '# What it is',
  'This is employer acquisition for industrial staffing agencies, not candidate sourcing.',
  'ScaleLab handles prospecting, outreach and qualification.',
  'Interested employers are placed on the agency\'s calendar.',
  '',
  '# The pilot',
  'It is a 30-day employer acquisition pilot built around the roles and geographies the staffing agency already serves.',
  'The model is performance-based around qualified employer meetings.',
  'If no qualified employer meetings are generated, there are no meeting fees.',
  '',
  '# What it does NOT do',
  'It does not source, place, or recruit candidates.',
  'It does not answer phones or sell call-answering software.',
  'It does not quote a price, guarantee a volume of meetings, or name clients.',
].join('\n');

const ROOFING_PRODUCT_FACTS = [
  '# What it is',
  'This is a short research survey for roofing companies. It is not a sales offer.',
  'The approved survey link is sent only after a clear opt-in.',
].join('\n');

const FAMILY_FACTS = Object.freeze({
  [CAMPAIGN_FAMILY.DENTAL]: Object.freeze({
    facts: DENTAL_PRODUCT_FACTS,
    audience: 'dental clinics',
    companyFallback: 'your clinic',
    systemRole: 'You draft short replies on behalf of Deins, who sells 24/7 answering and booking software to dental clinics.',
  }),
  [CAMPAIGN_FAMILY.STAFFING]: Object.freeze({
    facts: STAFFING_PRODUCT_FACTS,
    audience: 'industrial staffing agencies',
    companyFallback: 'your agency',
    systemRole: 'You draft short replies on behalf of Deins, who sells employer-acquisition help to industrial staffing agencies. Never mention dental, clinics, patients, receptionists, or call answering.',
  }),
  [CAMPAIGN_FAMILY.ROOFING]: Object.freeze({
    facts: ROOFING_PRODUCT_FACTS,
    audience: 'roofing companies',
    companyFallback: 'your business',
    systemRole: 'You draft short replies on behalf of Deins about a roofing research survey. It is not a sales offer. Do not invent pricing or product claims.',
  }),
});

// Topics that must NEVER be auto-answered, regardless of model confidence.
const NEVER_AUTO_ANSWER = [
  'pricing, cost, fees, discounts, contract length, or billing',
  'legal, privacy/PIPEDA/HIPAA, or data-handling commitments',
  'medical or clinical questions',
  'anything that reads as an objection, complaint, or pushback rather than a question',
  'guaranteed results, named clients, or unconfigured prices',
];

const STAFFING_NEVER_AUTO_ANSWER = [
  ...NEVER_AUTO_ANSWER,
  'candidate sourcing, job placement, recruiting software, or talent-pool claims',
  'specific employer volume or meeting-count promises',
];

function factsForFamily(family) {
  return FAMILY_FACTS[family] || null;
}

function factsForLead(lead = {}) {
  const resolved = resolveLeadFamily(lead);
  const scoped = factsForFamily(resolved.family);
  if (!scoped || resolved.family === CAMPAIGN_FAMILY.UNROUTED || !resolved.confident) {
    return {
      ok: false, family: CAMPAIGN_FAMILY.UNROUTED,
      reason: resolved.reason || 'unknown niche must not inherit dental facts',
      facts: '', audience: '', companyFallback: 'your business', systemRole: '',
      neverAutoAnswer: NEVER_AUTO_ANSWER,
    };
  }
  return {
    ok: true, family: resolved.family, reason: '',
    ...scoped,
    neverAutoAnswer: resolved.family === CAMPAIGN_FAMILY.STAFFING
      ? STAFFING_NEVER_AUTO_ANSWER : NEVER_AUTO_ANSWER,
  };
}

// Back-compat export: dental facts only. New callers must use factsForLead.
const PRODUCT_FACTS = DENTAL_PRODUCT_FACTS;

module.exports = {
  PRODUCT_FACTS, DENTAL_PRODUCT_FACTS, STAFFING_PRODUCT_FACTS, ROOFING_PRODUCT_FACTS,
  NEVER_AUTO_ANSWER, STAFFING_NEVER_AUTO_ANSWER, FAMILY_FACTS,
  factsForFamily, factsForLead, familyForLead,
};
