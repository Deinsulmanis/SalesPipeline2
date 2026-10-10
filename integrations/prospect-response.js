'use strict';
/**
 * prospect-response.js — the ONE definition of "we have responded to this
 * prospect". PURE: no sends, no writes, no network.
 * ───────────────────────────────────────────────────────────
 * Every CRM derivation that asks "whose move is it?" — Hot waiting-on and
 * staleness, reply operations' answeredAfter, the Inbox Next Action, and the
 * ownership verdict the sender consults — reads the answer from here. Before
 * this module each kept its own event list, and none of them knew that an
 * automated warm reply is recorded as `booking_link_sent`. A prospect answered
 * by automation therefore stayed "waiting on us" forever.
 *
 * Three kinds of evidence answer a prospect, kept apart on purpose:
 *
 *   prospect-facing responses  a message the prospect actually received in
 *                              reply: a human's Gmail reply, or an automated
 *                              warm reply sent BECAUSE they wrote in.
 *   recorded conversations     an operator writing up a conversation that
 *                              happened off-platform (a call, an in-person
 *                              reply). Long-standing CRM semantics; it is NOT a
 *                              prospect-facing message and is never counted as
 *                              one.
 *   meeting events             a booking or reschedule: the meeting, not an
 *                              email, is the answer.
 *
 * What is deliberately NOT here: cold steps, recovery-sequence nudges, the
 * unsolicited demo-intent booking-link email, reservations and failures. They
 * are automated outreach, not answers. "A human intervened" is also a different
 * question (it gates auto-sends and stops sequences) and stays with
 * human-outbound.js / stage-sequences.js.
 */

const { ACTION } = require('./reply-response-policy');

const HUMAN_RESPONSE_EVENT = 'human_response_sent';
const AUTOMATED_RESPONSE_EVENT = 'booking_link_sent';

// The reply-policy actions that SEND a message in response to an inbound one.
// A `booking_link_sent` row counts only when it names one of these. The demo
// intent path writes the same event type with AUTO_DEMO_ENGAGEMENT_RESPONSE,
// and a row recovered after a checkpoint failure carries no action at all;
// neither can prove it answered anything, so both fail toward human attention.
const AUTOMATED_REPLY_ACTIONS = Object.freeze([
  ACTION.AUTO_BOOKING_RESPONSE,
  ACTION.AUTO_MEETING_RESPONSE,
  ACTION.AUTO_QUESTION_RESPONSE,
  ACTION.AUTO_PRICING_RESPONSE,
  ACTION.AUTO_STAFFING_QUALIFY_QUESTION,
  ACTION.AUTO_STAFFING_SEND_INFO,
  ACTION.AUTO_STAFFING_QUALIFIED,
]);

const RECORDED_CONVERSATION_EVENTS = Object.freeze(['conversation_note']);
const MEETING_RESPONSE_EVENTS = Object.freeze(['call_booked', 'meeting_rescheduled']);

function metadataOf(row) {
  const raw = row && row.metadata;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')) || {}; } catch (_) { return {}; }
}

/** A message the prospect actually received in reply to something they sent. */
function isProspectFacingResponse(row) {
  const type = String((row && row.eventType) || '');
  if (type === HUMAN_RESPONSE_EVENT) return true;
  if (type !== AUTOMATED_RESPONSE_EVENT) return false;
  return AUTOMATED_REPLY_ACTIONS.includes(String(metadataOf(row).action || ''));
}

/** Any evidence that the prospect's last message has been answered. */
function isResponseEvidence(row) {
  const type = String((row && row.eventType) || '');
  return isProspectFacingResponse(row)
    || RECORDED_CONVERSATION_EVENTS.includes(type)
    || MEETING_RESPONSE_EVENTS.includes(type);
}

// Same comparison pipeline-state's latestEventAt has always used, so a mix of
// sources cannot order the same instants differently.
function latestAt(activities, predicate) {
  let latest = '';
  for (const row of activities || []) {
    if (!predicate(row)) continue;
    const at = String((row && row.occurredAt) || '');
    if (at > latest) latest = at;
  }
  return latest || null;
}

/** When did we last answer the prospect? Null when nothing has. */
const latestResponseAt = activities => latestAt(activities, isResponseEvidence);

/** When did the prospect last receive a message from us in reply? */
const latestProspectFacingResponseAt = activities => latestAt(activities, isProspectFacingResponse);

module.exports = {
  HUMAN_RESPONSE_EVENT, AUTOMATED_RESPONSE_EVENT, AUTOMATED_REPLY_ACTIONS,
  RECORDED_CONVERSATION_EVENTS, MEETING_RESPONSE_EVENTS,
  isProspectFacingResponse, isResponseEvidence,
  latestResponseAt, latestProspectFacingResponseAt,
};
