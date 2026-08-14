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
 */

const PRODUCT_FACTS = [
  '# What it is',
  'An AI receptionist that answers the clinic\'s phone when nobody picks up — after hours, during lunch, or when the front desk is already on another call.',
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

// Topics that must NEVER be auto-answered, regardless of model confidence.
// Pricing is commercial and belongs on the call; the rest are judgement calls
// where a wrong automated answer is worse than a slower human one.
const NEVER_AUTO_ANSWER = [
  'pricing, cost, fees, discounts, contract length, or billing',
  'legal, privacy/PIPEDA/HIPAA, or data-handling commitments',
  'medical or clinical questions',
  'anything that reads as an objection, complaint, or pushback rather than a question',
];

module.exports = { PRODUCT_FACTS, NEVER_AUTO_ANSWER };
