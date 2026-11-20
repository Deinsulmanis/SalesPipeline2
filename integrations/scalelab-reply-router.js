'use strict';
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { scaleLabOwner, VERSION } = require('./scalelab-response-classification');
const { isArchivedLead } = require('./lead-archive');
const { displayStageFor } = require('./cold-call-pipeline');
const { resolvePromotionIdentity, promotionSuppressionReason } = require('./promotion-policy');
const { hasManualHold, resumeAtFromNotes } = require('./pipeline-state');

const TASK_EVENT = 'scalelab_reply_follow_up_task';
const ROUTABLE = new Set(['interest', 'meeting_request', 'reschedule_request', 'information_request', 'pricing_request', 'future_contact']);
const FINAL_STEPS = new Set(['complete', 'review']);
const POLICY_VERSION = 'scalelab_follow_up_v1';
const skillPath = join(__dirname, '..', 'docs', 'skills', 'scalelab-crm-routing', 'SKILL.md');
const norm = value => String(value || '').trim().toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');

function routingConfig(env = process.env) {
  const mode = env.SCALELAB_REPLY_ROUTING_MODE;
  const since = Date.parse(env.SCALELAB_REPLY_ROUTING_SINCE || '');
  if (!['shadow', 'apply'].includes(mode) || !Number.isFinite(since)) return null;
  return { mode, since, draftsEnabled: mode === 'apply' && env.SCALELAB_REPLY_DRAFTS_ENABLED === 'true'
    && env.AGENT_V2_EXECUTION_ENABLED !== 'true' };
}

function routingCandidate(event, lead, config) {
  if (!config || !scaleLabOwner(lead) || event.sourceLeadId !== lead.id
      || Date.parse(event.occurredAt) < config.since
      || !Number.isFinite(Date.parse(event.occurredAt))) return null;
  let meta;
  try { meta = JSON.parse(event.metadata || '{}'); } catch { return null; }
  const messageId = meta.gmailMessageId || meta.scopedMessageId;
  const expected = meta.scopedMessageId
    ? `scalelab-delivery-review:${meta.senderInboxId}:${messageId}:${lead.id}`
    : `gmail-reply:${messageId}`;
  if (meta.clientId !== 'scalelab' || meta.matchedColdEmailId !== lead.id
      || !meta.senderInboxId || !meta.gmailThreadId || !messageId || event.eventId !== expected
      || meta.scalelabReply?.version !== VERSION || meta.scalelabMode !== config.mode
      || norm(event.email) !== norm(lead.email)) return null;
  return { id: digest(JSON.stringify(['scalelab', config.mode, meta.senderInboxId, messageId, lead.id])),
    leadId: lead.id, senderInboxId: meta.senderInboxId, messageId,
    threadId: meta.gmailThreadId, eventId: event.eventId, at: event.occurredAt,
    verdict: meta.scalelabReply, historical: meta.recoveredDuringOutage === true };
}

function planScaleLabRoute(candidate, { lead, boards, suppressed, twins = 1, newer = false }) {
  if (!scaleLabOwner(lead) || candidate.leadId !== lead.id) return { action: 'review', reason: 'client_scope' };
  if (isArchivedLead(lead) || promotionSuppressionReason(lead, suppressed)) return { action: 'review', reason: 'protected_lead' };
  if (resumeAtFromNotes(lead.notes) !== null) return { action: 'review', reason: 'existing_reactivation' };
  if (newer || candidate.historical) return { action: 'review', reason: 'stale_or_recovered_message' };
  if (!ROUTABLE.has(candidate.verdict.intent)) return { action: 'review', reason: candidate.verdict.intent };
  if (candidate.verdict.intent === 'future_contact' && Date.parse(candidate.verdict.revisitDate) <= Date.parse(candidate.at)) {
    return { action: 'review', reason: 'recontact_date_not_proven' };
  }
  if (candidate.verdict.intent === 'future_contact' && !Number.isFinite(Date.parse(candidate.verdict.revisitDate))) {
    return { action: 'review', reason: 'recontact_date_not_proven' };
  }
  if (!Array.isArray(boards) || twins !== 1) return { action: 'review', reason: 'board_identity_unavailable' };
  const identity = resolvePromotionIdentity(lead, boards, { coldEmailTwinCount: twins });
  if (identity.status === 'conflict') return { action: 'review', reason: 'board_identity_conflict' };
  const board = identity.boardLead;
  if (board && (isArchivedLead(board) || ['closed_won', 'closed_lost'].includes(displayStageFor(board.stage)))) {
    return { action: 'review', reason: 'protected_stage' };
  }
  return { action: board ? 'attach_task' : 'create_follow_up', boardId: board?.id || `CE-${lead.id}`,
    priorStage: board?.stage || null, targetStage: board?.stage || 'follow_up',
    dueAt: candidate.verdict.intent === 'future_contact' ? candidate.verdict.revisitDate : candidate.at };
}

function loadRoutingPolicy() {
  const source = readFileSync(skillPath, 'utf8');
  const rule = JSON.parse(source.match(/\x60\x60\x60json\s+({[^}]+})\s+\x60\x60\x60/)?.[1] || 'null');
  if (rule?.version !== POLICY_VERSION || rule.newStage !== 'follow_up' || rule.owner !== 'human'
      || rule.enrollSequence !== false) throw new Error('ScaleLab routing skill does not match safety policy');
  return { ...rule, digest: digest(source) };
}

// The adapter only appends a card or task with a provider-enforced stable key.
// It never writes an existing board stage. A competing operator update wins.
async function executeScaleLabRoute(candidate, { store, readState, hold, appendCard, publishTask }) {
  let record = await store.get(candidate.id);
  if (!record) throw new Error('ScaleLab action must be recorded before applying');
  if (FINAL_STEPS.has(record.step)) return record;
  const initial = record.plan;
  const stop = reason => store.advance(record, 'review', { reason });
  if (initial.action === 'review') return stop(initial.reason);

  const current = async () => {
    const state = await readState(candidate);
    if (state.unsafe) return state;
    const plan = planScaleLabRoute(candidate, state);
    if (plan.action === 'review') return { ...state, unsafe: plan.reason };
    if (plan.boardId !== initial.boardId) return { ...state, unsafe: 'board_identity_changed' };
    if (plan.action === 'create_follow_up' && initial.action === 'attach_task') {
      return { ...state, unsafe: 'board_card_disappeared' };
    }
    return { ...state, plan };
  };
  let state = await current();
  if (state.unsafe) return stop(state.unsafe);
  if (record.step === 'planned') {
    if (!hasManualHold(state.lead.notes)) await hold(state.lead);
    state = await current();
    if (state.unsafe) return stop(state.unsafe);
    if (!hasManualHold(state.lead.notes)) throw new Error('ScaleLab cold hold not verified');
    record = await store.advance(record, 'held', {});
  }
  if (FINAL_STEPS.has(record.step)) return record;
  if (record.step !== 'held') throw new Error('Unrecognized ScaleLab routing step');
  state = await current();
  if (state.unsafe) return stop(state.unsafe);
  if (!hasManualHold(state.lead.notes)) return stop('hold_released');
  if (state.plan.action === 'create_follow_up') {
    await appendCard(state.lead, initial.boardId);
    state = await current();
    if (state.unsafe) return stop(state.unsafe);
    if (state.plan.action !== 'attach_task') throw new Error('ScaleLab board append not verified');
  }
  if (!hasManualHold(state.lead.notes)) return stop('hold_released');
  await publishTask({ eventId: `scalelab-task:${candidate.id}`, eventType: TASK_EVENT,
    leadId: state.plan.boardId, sourceLeadId: candidate.leadId, email: state.lead.email,
    company: state.lead.company, occurredAt: candidate.at, subject: 'ScaleLab follow-up task',
    content: '', metadata: JSON.stringify({ clientId: 'scalelab', routingActionId: candidate.id,
      inboundMessageId: candidate.messageId, sourceEventId: candidate.eventId, intent: candidate.verdict.intent,
      dueAt: initial.dueAt, owner: 'human', autoSendAllowed: false, policyVersion: POLICY_VERSION }) });
  return store.advance(record, 'complete', { boardId: state.plan.boardId, stage: state.plan.targetStage });
}

module.exports = { TASK_EVENT, POLICY_VERSION, routingConfig, routingCandidate, planScaleLabRoute,
  loadRoutingPolicy, executeScaleLabRoute, FINAL_STEPS };
