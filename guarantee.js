'use strict';
/**
 * guarantee.js — the performance guarantee, as a FIXED literal.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a commercial promise. The number (3), the window (30 days), the
 * remedy (you don't pay for that month) and the stipulation (normal call
 * volume) are contractual — an LLM must never generate, paraphrase, soften or
 * re-state any of it. Same lock as pricing: the model has no path to producing
 * this text, because the text is assembled here and only checked afterwards.
 *
 * Why this is NOT in booking.js: booking.js is the warm-only Calendly asset and
 * the cold templates are guarded against importing it. The guarantee belongs in
 * the COLD email, so it needs its own home or that guard would have to be
 * weakened.
 *
 * NO PRICING here either. The guarantee says what happens if we miss, not what
 * it costs — price is delivered on the call (see pricingDeflection).
 */

// The one true wording. {{company}} is the only substitution permitted.
const GUARANTEE_TEMPLATE =
  "If our AI receptionist doesn't book at least 3 new patient appointments for {{company}} in the first 30 days, you don't pay for that month — as long as your call volume is in a normal range.";

/** Merge the company in. Throws rather than emitting a half-merged promise. */
function guaranteeFor(company) {
  const co = String(company || '').trim();
  if (!co) throw new Error('guaranteeFor: company is required — refusing to build a guarantee with an unresolved merge field');
  return GUARANTEE_TEMPLATE.split('{{company}}').join(co);
}

/**
 * Is the exact guarantee present, verbatim, for this company?
 * Used as a pre-send gate: a body that fails this must be drafted, not sent.
 * Substring rather than equality because the guarantee is one sentence inside
 * a longer body.
 */
function hasIntactGuarantee(body, company) {
  if (!body) return false;
  let expected;
  try { expected = guaranteeFor(company); } catch (_e) { return false; }
  return String(body).includes(expected);
}

module.exports = { GUARANTEE_TEMPLATE, guaranteeFor, hasIntactGuarantee };
