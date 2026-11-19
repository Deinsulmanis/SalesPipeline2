'use strict';
const { routingCandidate, planScaleLabRoute, executeScaleLabRoute, FINAL_STEPS } = require('./scalelab-reply-router');

function activityMetadata(row) {
  try { return JSON.parse(row.metadata || '{}'); } catch { return {}; }
}

function laterEvidence(events, candidate, board) {
  const at = Date.parse(candidate.at);
  return events.some(row => {
    if (row.sourceLeadId !== candidate.leadId && (!board || row.leadId !== board.id)) return false;
    const when = Date.parse(row.occurredAt);
    if (!Number.isFinite(when) || when < at || row.eventId === candidate.eventId) return false;
    if (row.eventId.startsWith('gmail-reply:') || row.eventType === 'scalelab_delivery_review') return true;
    return ['human_response_sent', 'automation_hold_released', 'next_action_override',
      'sequence_enrolled', 'sequence_resumed'].includes(row.eventType);
  });
}

async function runScaleLabReplyRouting({ config, activities, leads, store, readState, owns, hold, appendCard,
  publishTask, onError }) {
  const known = new Map((await store.listSince(config.mode, new Date(config.since).toISOString()))
    .map(row => [row.action_id, row]));
  const byId = new Map(leads.map(lead => [lead.id, lead]));
  for (const event of activities) {
    const lead = byId.get(event.sourceLeadId);
    const candidate = routingCandidate(event, lead, config);
    if (!candidate || !owns(lead, candidate.senderInboxId)) continue;
    const previous = known.get(candidate.id);
    if (previous && (config.mode === 'shadow' || FINAL_STEPS.has(previous.step))) continue;
    try {
      if (!previous) {
        const state = await readState(candidate);
        let plan = planScaleLabRoute(candidate, state);
        if (state.unsafe) plan = { action: 'review', reason: state.unsafe };
        known.set(candidate.id, await store.record(candidate, plan, config.mode));
      }
      if (config.mode === 'apply') {
        known.set(candidate.id, await executeScaleLabRoute(candidate, { store, readState, hold, appendCard, publishTask }));
      }
    } catch (error) {
      onError(candidate.id, error);
    }
  }
  return known;
}

function ownsActionMessage(rows, lead, messageId, config) {
  if (config?.mode !== 'apply') return null;
  const event = rows.find(row => row.eventId === 'gmail-reply:' + messageId && row.sourceLeadId === lead.id);
  return event ? routingCandidate(event, lead, config) : null;
}
module.exports = { activityMetadata, laterEvidence, runScaleLabReplyRouting, ownsActionMessage };
