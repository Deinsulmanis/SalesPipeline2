'use strict';

const { BOOKING_URL } = require('../booking');
const { familyForLead } = require('./campaign-versions');

const OFFERS = Object.freeze({
  dental_ai_receptionist: Object.freeze({
    id: 'dental_pay_per_booking_v1',
    name: '24/7 answering and booking software',
    targetCustomer: 'dental practices',
    description: 'It answers missed calls in a natural voice, collects caller details, and books or requests an appointment using the clinic\'s services, hours, and booking preferences.',
    outcome: 'Help turn otherwise missed calls into booked patients.',
    fulfillment: 'A working demo is configured with the clinic\'s real services without touching its live phone line.',
    bookingUrl: BOOKING_URL,
    approvedClaims: Object.freeze([
      'The software can answer calls 24/7.',
      'It confirms unclear details instead of guessing.',
      'It can send SMS and email booking confirmations.',
      'It does not diagnose or give clinical advice.',
      'The active offer charges only for appointments booked through the system.',
    ]),
    prohibitedClaims: Object.freeze(['guaranteed results', 'specific patient volume', 'named clients', 'unconfigured prices', 'legal or privacy guarantees']),
    faq: Object.freeze({
      what: 'It is 24/7 answering and booking software for dental practices that handles missed calls and helps turn them into booked patients.',
      how: 'It is configured with the clinic\'s services, hours, and booking preferences, then answers callers, confirms their details, and books or requests an appointment.',
      next: 'The first step is a short call to confirm fit and show a working clinic-specific demo. It does not touch the live phone line.',
      who: 'It is built for dental practices that want coverage for calls that would otherwise ring out.',
    }),
    pricing: null,
  }),
  roofing_survey: Object.freeze({
    id: 'roofing_survey_v1', name: 'roofing research survey', targetCustomer: 'roofing companies',
    description: 'A short research survey. It is not a sales offer.', outcome: 'Collect operator feedback.',
    fulfillment: 'The approved survey link is sent only after a clear opt-in.', bookingUrl: '',
    approvedClaims: Object.freeze(['This is a research survey.']),
    prohibitedClaims: Object.freeze(['pricing', 'guarantees', 'sales results']), faq: Object.freeze({}), pricing: null,
  }),
});

function parsePricing(raw = process.env.OFFER_PRICING_JSON || '') {
  if (!String(raw).trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { throw new Error('OFFER_PRICING_JSON must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OFFER_PRICING_JSON must be an object');
  return parsed;
}

function offerForLead(lead, env = process.env) {
  const family = familyForLead(lead);
  const base = OFFERS[family];
  if (!base) throw new Error(`No approved offer facts for ${family}`);
  const pricing = parsePricing(env.OFFER_PRICING_JSON)[family] || null;
  if (pricing && (!pricing.approvedWording || typeof pricing.approvedWording !== 'string')) {
    throw new Error(`Pricing for ${family} requires approvedWording`);
  }
  return Object.freeze({ ...base, pricing });
}

function warmResponse({ action, lead, offer, answer = '' }) {
  const company = String(lead.company || '').trim() || 'your clinic';
  const booking = offer.bookingUrl
    ? `Grab a quick 15 min here and I’ll show you how it would work for ${company}:\n${offer.bookingUrl}` : '';
  if (action === 'AUTO_BOOKING_RESPONSE') return `Absolutely — happy to show you.\n\n${booking}`;
  if (action === 'AUTO_MEETING_RESPONSE') return `Yes — the easiest way to pick a time that works is here:\n${offer.bookingUrl}`;
  if (action === 'AUTO_PRICING_RESPONSE') {
    if (!offer.pricing?.approvedWording) throw new Error('approved pricing is not configured');
    return `${offer.pricing.approvedWording.trim()}\n\n${booking}`;
  }
  if (action === 'AUTO_QUESTION_RESPONSE') {
    if (!String(answer).trim()) throw new Error('a grounded answer is required');
    return `${String(answer).trim()}\n\n${booking}`;
  }
  throw new Error(`Unsupported warm response action ${action}`);
}

module.exports = { OFFERS, parsePricing, offerForLead, warmResponse };
