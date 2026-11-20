'use strict';
const { createHash } = require('node:crypto');
const { routingCandidate, planScaleLabRoute, executeScaleLabRoute, FINAL_STEPS } = require('./scalelab-reply-router');
const { classifyScaleLabWithHaiku, modelReview } = require('./scalelab-reply-haiku');

const CLAIM_EXPIRY_MS = 60000;

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

async function resolveScaleLabVerdict(candidate, state, { store, classify = classifyScaleLabWithHaiku, now = new Date() }) {
  if (!candidate.verdict.requiresModel) return candidate.verdict;
  if (!state.current?.trim() || !state.context?.length) return modelReview('thread_evidence_unavailable');
  const id = createHash('sha256').update(JSON.stringify(['scalelab', candidate.senderInboxId, candidate.messageId, candidate.leadId])).digest('hex');
  const { acquired, record } = await store.claimClassification(id, candidate, now);
  if (record.status === 'finished') return record.verdict;
  if (!acquired) {
    // A crashed worker may have reached the provider. Finalize as review after
    // expiry rather than spending again or guessing an outcome.
    if (now.getTime() - Date.parse(record.started_at) < CLAIM_EXPIRY_MS) return null;
    return store.finishClassification(record, modelReview('classification_attempt_unconfirmed'));
  }
  const verdict = await classify({ current: state.current, context: state.context, subject: state.subject,
    firstPass: candidate.verdict, candidate, lead: state.lead });
  return store.finishClassification(record, verdict);
}

async function runScaleLabReplyRouting({ config, activities, leads, store, readState, owns, hold, appendCard,
  publishTask, onError, classify, now }) {
  const known = new Map((await store.listSince(config.mode, new Date(config.since).toISOString()))
    .map(row => [row.action_id, row]));
  const byId = new Map(leads.map(lead => [lead.id, lead]));
  for (const event of activities) {
    const lead = byId.get(event.sourceLeadId);
    let candidate = routingCandidate(event, lead, config);
    if (!candidate || !owns(lead, candidate.senderInboxId)) continue;
    const previous = known.get(candidate.id);
    if (previous && (config.mode === 'shadow' || FINAL_STEPS.has(previous.step))) continue;
    try {
      if (!previous) {
        let state = await readState(candidate);
        if (candidate.verdict.requiresModel) {
          let verdict;
          if (config.mode === 'shadow') verdict = modelReview('shadow_model_deferred');
          else if (state.unsafe || state.newer || candidate.historical) verdict = modelReview('route_ineligible');
          else verdict = await resolveScaleLabVerdict(candidate, state, { store, classify, now });
          if (!verdict) continue;
          candidate = { ...candidate, verdict };
          if (config.mode === 'apply' && verdict.confidence === 'high') state = await readState(candidate);
        }
        let plan = planScaleLabRoute(candidate, state);
        if (state.unsafe) plan = { action: 'review', reason: state.unsafe };
        known.set(candidate.id, await store.record(candidate, plan, config.mode));
      } else candidate = { ...candidate, verdict: previous.verdict };
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
module.exports = { activityMetadata, laterEvidence, resolveScaleLabVerdict, runScaleLabReplyRouting, ownsActionMessage };
