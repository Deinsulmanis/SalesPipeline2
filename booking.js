'use strict';
/**
 * booking.js — the booking link and its call framing, in ONE place.
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WARM-ONLY ASSET. This snippet must never appear in cold outreach.
 *
 * It is reachable from exactly two intent triggers, both of which require the
 * prospect to have done something first:
 *   1. they replied with a question   (runReplyCheckPass → answerQuestion)
 *   2. they played BOTH demo audios   (runIntentTriggerPass)
 *
 * Nothing in the cold sequence — buildPitch(), FOLLOW_UP_SEQUENCE,
 * WARM_FOLLOW_UP_TEMPLATE — may require this module. A cold email carrying a
 * booking link asks for a meeting before earning one, and burns the asset on
 * people who never signalled interest. There is a guard test for this in the
 * verification script; keep it that way.
 *
 * NO PRICING. Not here, not in anything built from here. Price is delivered on
 * the call, by a human. Any drafted reply that touches price must deflect to
 * the call rather than name a number.
 */

// The scheduling provider is Google Calendar's appointment schedule. Configurable
// so the link can be rotated without a code change, but with the real link as the
// default so a missing env var can't silently ship a broken CTA.
const BOOKING_URL = (process.env.BOOKING_URL || 'https://calendar.app.google/h3X8e3WbBKjPrBoVA').trim();

// The host of whatever booking link is configured. The cold-email validator uses
// this to keep the warm-only asset out of cold sends: hard-coding a provider
// domain there would silently become dead the moment the link is rotated, which
// is exactly what happened when this moved off Calendly.
function bookingUrlHost() {
  try { return new URL(BOOKING_URL).host.toLowerCase(); } catch (_) { return ''; }
}

/**
 * Is this body carrying the configured booking link? Matches the full URL or its
 * host, so a shortened or query-decorated variant is still caught.
 */
function containsBookingLink(text) {
  const body = String(text || '');
  if (BOOKING_URL && body.includes(BOOKING_URL)) return true;
  const host = bookingUrlHost();
  return Boolean(host) && body.toLowerCase().includes(host);
}

/**
 * The call-framing block. Sells the CALL as the payoff — what it will catch for
 * *their* clinic — rather than just pasting a link.
 *
 * @param cleanedCompany  Company name ALREADY passed through cleanCompanyName()
 *                        by the caller. This module deliberately does not
 *                        import that helper: it lives in outreach-agent.js and
 *                        server.js and copying it here would make a third copy
 *                        to keep in sync. Callers already have it in scope.
 * @param opts.lead       Optional lead-in sentence placed above the framing.
 */
function bookingSnippet(cleanedCompany, opts = {}) {
  const who = (cleanedCompany || '').trim() || 'your clinic';
  const leadIn = opts.lead ? `${opts.lead}\n\n` : '';
  return `${leadIn}Grab a quick 15 min here and I'll show you exactly what it'd catch for ${who} — and get it set up for you:\n${BOOKING_URL}`;
}

/**
 * Pricing questions never get a number in writing. This is the deflection used
 * by the drafted reply, so the wording stays identical everywhere.
 */
function pricingDeflection(cleanedCompany) {
  const who = (cleanedCompany || '').trim() || 'your clinic';
  return `That's exactly what we cover on a quick call — it depends on how ${who} handles calls now, so quoting a number cold would just be a guess.\n\n${bookingSnippet(who)}`;
}

module.exports = { BOOKING_URL, bookingUrlHost, containsBookingLink, bookingSnippet, pricingDeflection };
