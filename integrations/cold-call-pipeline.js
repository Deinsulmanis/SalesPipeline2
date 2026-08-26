'use strict';

const COLD_CALL_STAGES = Object.freeze([
  { id: 'follow_up', label: 'Follow Up' },
  { id: 'hot', label: 'Hot' },
  { id: 'call_booked', label: 'Call Booked' },
  { id: 'closed_won', label: 'Closed / Won' },
  { id: 'closed_lost', label: 'Closed / Lost' },
]);

const COLD_CALL_STAGE_IDS = new Set(COLD_CALL_STAGES.map(stage => stage.id));

// Existing rows are deliberately not migrated. These aliases keep every legacy
// card visible in the new view until the user explicitly changes it.
//
// NOTE: legacy 'closed' stays mapped to closed_lost on purpose. Two live leads
// (suresky.inc, tradeselect) store the bare value 'closed'; re-pointing it at
// the new closed_won column would silently move them, which is exactly what
// adding this stage must not do. Won deals are set explicitly by a human.
function displayStageFor(stage) {
  const value = String(stage || '').trim().toLowerCase();
  if (COLD_CALL_STAGE_IDS.has(value)) return value;
  if (value === 'hot') return 'hot';
  if (['closed', 'lost'].includes(value)) return 'closed_lost';
  if (value === 'proposal') return 'call_booked';
  return 'follow_up';
}

const COLD_CALL_ACTIVITY_SHEET = 'ColdCallActivity';
const COLD_CALL_ACTIVITY_HEADER = Object.freeze([
  'eventId', 'leadId', 'sourceLeadId', 'email', 'company', 'eventType',
  'occurredAt', 'subject', 'content', 'metadata',
]);

function scoreColdCallLead(lead = {}, activities = []) {
  const types = new Set(activities.map(row => String(row.eventType || '')));
  let score = 10;
  if (types.has('initial_email_sent')) score += 10;
  if (types.has('demo_pair_played')) score += 25;
  if (types.has('booking_link_sent')) score += 15;
  if (types.has('positive_reply')) score += 25;
  if (lead.meetingAt || types.has('call_booked')) score += 15;
  return Math.min(100, score);
}

module.exports = {
  COLD_CALL_STAGES,
  COLD_CALL_STAGE_IDS,
  COLD_CALL_ACTIVITY_SHEET,
  COLD_CALL_ACTIVITY_HEADER,
  displayStageFor,
  scoreColdCallLead,
};
