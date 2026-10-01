'use strict';

const { classify } = require('../check-leads');
const { sendSuppressionReason } = require('./pipeline-state');
const { leadHasReply } = require('./reply-analytics');
const { deriveAutomationOwnership } = require('./automation-ownership');
const { resolveLeadClient } = require('./clients/ownership');
const { isStaffingCampaign, staffingReviewStatus, renderStaffingEmail, validateStaffingEmail } = require('./staffing-campaign');

const normalize = value => String(value || '').trim().toLowerCase();

// A pure preflight shared by the queue action and its production-safe dry run.
// Identity is exact ID first, email second; company names never participate.
function queueEligibility(lead, {
  leads = [], activities = [], boardLeads = [], suppressedEmails = new Set(),
  env, mailingAddress, companyName, website,
} = {}) {
  if (!lead.id || !lead.email || classify(lead.email) !== 'CLEAN') return { ok: false, reason: 'invalid identity' };
  // Email identity is unique per client: another client's lead for the same
  // address is not a duplicate, a second row inside this client (or a row whose
  // owner is unknown) is.
  const owner = resolveLeadClient(lead);
  if (!owner.ok) return { ok: false, reason: owner.reason };
  const sameAddress = leads.filter(item => normalize(item.email) === normalize(lead.email));
  const sameClientAddress = sameAddress.filter(item => {
    const other = resolveLeadClient(item);
    return !other.ok || other.clientId === owner.clientId;
  });
  if (leads.filter(item => item.id === lead.id).length !== 1 || sameClientAddress.length !== 1) {
    return { ok: false, reason: 'ambiguous lead identity' };
  }
  if (!['Import', 'Queued'].includes(lead.stage)) return { ok: false, reason: `stage ${lead.stage || '(blank)'} is not eligible to queue` };
  if (lead.emailStatus || Number(lead.emailStep) > 0 || lead.lastEmailedAt) return { ok: false, reason: 'prior send or sequence status exists' };
  if (leadHasReply(lead)) return { ok: false, reason: 'genuine reply exists' };
  const mine = activities.filter(row => row.sourceLeadId ? row.sourceLeadId === lead.id
    : row.leadId ? [lead.id, `CE-${lead.id}`].includes(row.leadId) : normalize(row.email) === normalize(lead.email));
  if (mine.some(row => /^(positive_reply|negative_reply|question_reply|meeting_requested|late_reply|unsubscribe_reply|wrong_person_reply|needs_human_reply|out_of_office_reply)$/.test(row.eventType))) {
    return { ok: false, reason: 'genuine reply activity exists' };
  }
  if (mine.some(row => /(?:email_sent|follow_up_sent|sequence_step_sent|booking_link_sent|human_response_sent|send_reserved|send_uncertain)/.test(row.eventType))) {
    return { ok: false, reason: 'prior send or pending send reservation exists' };
  }
  const exact = boardLeads.filter(row => [lead.id, `CE-${lead.id}`].includes(row.id));
  const board = exact.length ? exact : boardLeads.filter(row => normalize(row.email) === normalize(lead.email));
  if (board.length > 1) return { ok: false, reason: 'ambiguous Pipeline identity' };
  const ownership = deriveAutomationOwnership({ ...lead, stage: 'Queued' }, {
    boardLead: board[0] || null, activities: mine, coldCadenceDue: true,
    sendingEnabled: true, suppressionReason: item => sendSuppressionReason(item, { suppressedEmails }),
  });
  if (!ownership.sendAllowed || ownership.owner !== 'cold_automation') return { ok: false, reason: ownership.reason, ownership };
  if (normalize(lead.leadNiche).includes('staffing')) {
    if (!isStaffingCampaign(lead)) return { ok: false, reason: 'staffing campaign attribution conflicts' };
    const review = staffingReviewStatus(lead);
    if (review && (review.fit !== 'ICP_CONFIRMED' || !review.routingReady
      || !['SPECIFIC_HIGH', 'BROAD_MEDIUM', 'SAFE_FALLBACK', 'NONE_REQUIRED'].includes(review.personalization)))
      return { ok: false, reason: 'staffing fit or routing review is held' };
    try {
      for (const step of [1, 2, 3]) {
        const error = validateStaffingEmail(renderStaffingEmail(lead, step, {
          env, mailingAddress, companyName, website,
        }), step);
        if (error) return { ok: false, reason: error };
      }
    } catch (error) { return { ok: false, reason: error.message }; }
  }
  return { ok: true, ownership };
}

const QUEUE_STATUSES = Object.freeze(['succeeded', 'unchanged', 'refused', 'conflict', 'failed']);

// senderInboxId === AUTO_SENDER asks for capacity-weighted assignment: each lead
// gets its own inbox from assignSenders(), decided against the same canonical
// state the rest of the selection is validated in. A named inbox still means
// exactly that inbox for every selected lead.
const AUTO_SENDER = 'auto';

async function queueSelectedLeads({ ids, senderInboxId, emailTemplateId, campaignVersionId }, {
  loadState, validateSelection, applyChanges, appendActivity, appendActivities, assignSenders,
  now = () => new Date().toISOString(),
}) {
  const state = await loadState();
  const selected = state.leads.filter(lead => ids.includes(lead.id));
  if (selected.length !== ids.length) return { status: 409, error: 'One or more selected leads no longer exist or have duplicate identities' };
  if (new Set(selected.map(lead => String(lead.campaign || '').trim())).size !== 1) return { status: 422, error: 'Queue leads from one campaign at a time' };
  let assignments = null;
  if (senderInboxId === AUTO_SENDER) {
    if (!assignSenders) return { status: 422, error: 'Automatic sender assignment is unavailable' };
    const assigned = assignSenders(selected.map(lead => ({ ...lead, emailTemplateId, intendedCampaignVersion: campaignVersionId })), state);
    const refused = assigned.refused || [];
    if (refused.length) return { status: 422, error: `${refused[0].leadId}: ${refused[0].reason}` };
    assignments = assigned.assignments;
  }
  const senderFor = lead => (assignments ? assignments.get(lead.id) : senderInboxId);
  // Validate the entire selection before any mutation. A repeated request with
  // exactly the same route is a no-op, not another enrollment/audit event.
  for (const lead of selected) {
    const eligible = queueEligibility(lead, state);
    if (!eligible.ok) return { status: 409, error: `${lead.company || lead.id}: ${eligible.reason}` };
    const route = validateSelection(lead, senderFor(lead));
    if (!route.ok) return { status: 422, error: route.reason };
  }
  const patchFor = lead => ({ stage: 'Queued', senderInboxId: senderFor(lead), emailTemplateId, routingRequired: 'true', intendedCampaignVersion: campaignVersionId });

  // Leads are independent: nothing is all-or-nothing across them, so each gets
  // its own verdict from the canonical mutation path. A refused or failed lead
  // never rewrites another, and retrying is safe — a lead already queued with
  // this route comes back unchanged.
  const results = [];
  const auditBatch = [];
  const pending = [];
  for (const lead of selected) {
    if (Object.entries(patchFor(lead)).every(([key, value]) => lead[key] === value)) {
      results.push({ leadId: lead.id, status: 'unchanged', reason: 'already queued with this route' });
    } else {
      pending.push(lead);
    }
  }
  if (pending.length) {
    let applied;
    try {
      applied = await applyChanges(pending.map(lead => ({ lead, patch: patchFor(lead) })));
    } catch (error) {
      applied = pending.map(lead => ({ leadId: lead.id, status: 'failed', reason: error.message }));
    }
    const byId = new Map((applied || []).map(result => [result.leadId, result]));
    for (const lead of pending) {
      const result = { ...(byId.get(lead.id) || { leadId: lead.id, status: 'failed', reason: 'no verdict was returned for this lead' }) };
      if (!QUEUE_STATUSES.includes(result.status)) Object.assign(result, { status: 'failed', reason: `unrecognised verdict ${result.status}` });
      if (result.status === 'succeeded') {
        const event = { lead, occurredAt: now(), patch: patchFor(lead) };
        if (appendActivities) auditBatch.push({ result, event });
        else {
          try { await appendActivity(event); }
          catch (error) { Object.assign(result, { activityRecorded: false, activityError: error.message }); }
        }
      }
      results.push(result);
    }
  }

  // One audit append for the successful canonical commits. A 102-lead launch
  // must not spend 102 Sheets writes and exhaust the per-minute write quota.
  if (auditBatch.length) {
    try { await appendActivities(auditBatch.map(item => item.event)); }
    catch (error) { for (const { result } of auditBatch) Object.assign(result, { activityRecorded: false, activityError: error.message }); }
  }

  const count = status => results.filter(result => result.status === status).length;
  const summary = {
    requested: ids.length, succeeded: count('succeeded'), unchanged: count('unchanged'),
    refused: count('refused'), conflict: count('conflict'), failed: count('failed'),
    activityFailures: results.filter(result => result.activityRecorded === false).length,
  };
  const response = {
    ...summary, queued: summary.succeeded, alreadyQueued: summary.unchanged,
    queuedIds: results.filter(result => result.status === 'succeeded').map(result => result.leadId),
    results, senderInboxId, campaignVersionId, emailTemplateId,
    ...(assignments ? { assignedSenders: Object.fromEntries(assignments) } : {}),
  };
  const notQueued = summary.refused + summary.conflict + summary.failed;
  if (!notQueued && !summary.activityFailures) return response;
  return { ...response, status: 409,
    error: `${summary.succeeded} queued, ${summary.unchanged} already queued, ${notQueued} not queued `
      + `(${summary.refused} refused, ${summary.conflict} conflict, ${summary.failed} failed). `
      + (summary.activityFailures ? `${summary.activityFailures} queue audit events could not be confirmed; keep sending paused and review the committed leads. ` : '')
      + 'Review each lead; retrying does not re-enroll committed leads.' };
}

module.exports = { AUTO_SENDER, queueEligibility, queueSelectedLeads };
