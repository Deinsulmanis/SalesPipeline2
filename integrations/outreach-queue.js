'use strict';

const { classify } = require('../check-leads');
const { sendSuppressionReason } = require('./pipeline-state');
const { leadHasReply } = require('./reply-analytics');
const { deriveAutomationOwnership } = require('./automation-ownership');
const { isStaffingCampaign, renderStaffingEmail, validateStaffingEmail } = require('./staffing-campaign');

const normalize = value => String(value || '').trim().toLowerCase();

// A pure preflight shared by the queue action and its production-safe dry run.
// Identity is exact ID first, email second; company names never participate.
function queueEligibility(lead, { leads = [], activities = [], boardLeads = [], suppressedEmails = new Set() } = {}) {
  if (!lead.id || !lead.email || classify(lead.email) !== 'CLEAN') return { ok: false, reason: 'invalid identity' };
  if (leads.filter(item => item.id === lead.id).length !== 1
    || leads.filter(item => normalize(item.email) === normalize(lead.email)).length !== 1) {
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
    try {
      for (const step of [1, 2, 3]) {
        const error = validateStaffingEmail(renderStaffingEmail(lead, step), step);
        if (error) return { ok: false, reason: error };
      }
    } catch (error) { return { ok: false, reason: error.message }; }
  }
  return { ok: true, ownership };
}

async function queueSelectedLeads({ ids, senderInboxId, emailTemplateId, campaignVersionId }, {
  loadState, validateSelection, mutate, appendActivity, now = () => new Date().toISOString(),
}) {
  const state = await loadState();
  const selected = state.leads.filter(lead => ids.includes(lead.id));
  if (selected.length !== ids.length) return { status: 409, error: 'One or more selected leads no longer exist or have duplicate identities' };
  if (new Set(selected.map(lead => String(lead.campaign || '').trim())).size !== 1) return { status: 422, error: 'Queue leads from one campaign at a time' };
  // Validate the entire selection before any mutation. A repeated request with
  // exactly the same route is a no-op, not another enrollment/audit event.
  for (const lead of selected) {
    const eligible = queueEligibility(lead, state);
    if (!eligible.ok) return { status: 409, error: `${lead.company || lead.id}: ${eligible.reason}` };
    const route = validateSelection(lead);
    if (!route.ok) return { status: 422, error: route.reason };
  }
  const patch = { stage: 'Queued', senderInboxId, emailTemplateId, routingRequired: 'true', intendedCampaignVersion: campaignVersionId };
  const queuedIds = [];
  let alreadyQueued = 0;
  for (const lead of selected) {
    if (Object.entries(patch).every(([key, value]) => lead[key] === value)) { alreadyQueued++; continue; }
    try {
      await mutate(lead, patch);
      queuedIds.push(lead.id);
      await appendActivity({ lead, occurredAt: now(), patch });
    } catch (error) {
      return { status: 409, error: `Queue stopped: ${error.message}. Refresh before retrying.`, queued: queuedIds.length, queuedIds, alreadyQueued };
    }
  }
  return { queued: queuedIds.length, queuedIds, alreadyQueued, senderInboxId, campaignVersionId, emailTemplateId };
}

module.exports = { queueEligibility, queueSelectedLeads };
