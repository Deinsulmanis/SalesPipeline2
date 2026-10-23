'use strict';

/**
 * Managed-client pipeline: where each of a client's prospects stands, derived
 * from state that already exists — the canonical lead row and the client's
 * meeting ledger. Nothing is stored here and nothing is invented.
 *
 * Stages run from import to a qualified meeting. A lead sits in the most
 * advanced stage its evidence supports; closed/disqualified wins over
 * everything except a qualified held meeting (which is billable history).
 */

const { MEETING_STATUS, CLARIFICATION_STATUS } = require('./ledger');

const PIPELINE_STAGES = Object.freeze([
  Object.freeze({ id: 'imported', label: 'Imported', color: 'var(--text-muted)', rule: 'In the CRM, not yet approved' }),
  Object.freeze({ id: 'approved', label: 'Approved', color: 'var(--info)', rule: 'Campaign, template and sender assigned' }),
  Object.freeze({ id: 'routing_ready', label: 'Routing ready', color: 'var(--info)', rule: 'Passes every routing check' }),
  Object.freeze({ id: 'queued', label: 'Queued', color: 'var(--primary)', rule: 'Waiting for a send window' }),
  Object.freeze({ id: 'contacted', label: 'Contacted', color: 'var(--primary)', rule: 'Cold email sent' }),
  Object.freeze({ id: 'replied', label: 'Replied', color: 'var(--warn)', rule: 'A person replied' }),
  Object.freeze({ id: 'qualifying', label: 'Qualifying', color: 'var(--warn)', rule: 'ScaleLab is qualifying the employer' }),
  Object.freeze({ id: 'awaiting_clarification', label: 'Awaiting clarification', color: 'var(--warn)', rule: 'A question only the client can answer' }),
  Object.freeze({ id: 'meeting_booked', label: 'Meeting booked', color: 'var(--violet)', rule: 'Booked, not held yet' }),
  Object.freeze({ id: 'meeting_held', label: 'Meeting held', color: 'var(--violet)', rule: 'Held, qualification pending or not met' }),
  Object.freeze({ id: 'qualified_held', label: 'Qualified held', color: 'var(--success)', rule: 'Billable qualified meeting' }),
  Object.freeze({ id: 'closed', label: 'Closed / disqualified', color: 'var(--lost, var(--text-muted))', rule: 'Not interested, opted out or outside the target' }),
]);

const text = value => String(value == null ? '' : value).trim();
const CLOSED_CONVERSATIONS = new Set(['closed_not_interested', 'closed_unsubscribed', 'closed_outside_icp', 'closed_lost']);
const QUALIFYING_CONVERSATIONS = new Set(['qualification_in_progress', 'meeting_booking', 'referral_pending', 'future_need', 'needs_review', 'wrong_contact']);

// Sticky reply/bounce tags or an opt-out stage close a lead for good.
function isClosedLead(lead) {
  if (['unsub', 'unsubscribed'].includes(text(lead.stage).toLowerCase())) return true;
  return /\[REPLY: (Not Interested|Unsubscribed)\]|\[BOUNCED/i.test(text(lead.notes));
}

/** The pipeline stage of one lead. */
function pipelineStageFor(lead, { opportunity = null, meetings = [], openClarification = false, routingReady = false } = {}) {
  const statuses = meetings.map(meeting => meeting.meeting_status);
  if (statuses.includes(MEETING_STATUS.QUALIFIED_HELD)) return 'qualified_held';
  if (isClosedLead(lead) || CLOSED_CONVERSATIONS.has(opportunity?.conversation_status)) return 'closed';
  if (statuses.some(status => [MEETING_STATUS.HELD, MEETING_STATUS.DISQUALIFIED_HELD].includes(status))) return 'meeting_held';
  if (statuses.some(status => [MEETING_STATUS.BOOKED, MEETING_STATUS.RESCHEDULED].includes(status))) return 'meeting_booked';
  if (openClarification || opportunity?.conversation_status === 'awaiting_client_clarification') return 'awaiting_clarification';
  if (QUALIFYING_CONVERSATIONS.has(opportunity?.conversation_status)) return 'qualifying';
  const status = text(lead.emailStatus).toLowerCase();
  if (status === 'replied') return 'replied';
  if (Number(lead.emailStep || 0) > 0 || ['emailed', 'done'].includes(status)) return 'contacted';
  if (text(lead.stage) === 'Queued') return 'queued';
  if (routingReady) return 'routing_ready';
  if (text(lead.intendedCampaignVersion) && text(lead.emailTemplateId) && text(lead.senderInboxId)) return 'approved';
  return 'imported';
}

/**
 * Columns for a client's pipeline board.
 * @param leads    the client's leads only (already scoped on the server)
 * @param ledger   { available, opportunities, meetings, clarifications } for this client
 */
function buildClientPipeline({ clientId, leads = [], ledger = { available: false }, routedLeadReady = () => ({ ok: false }), env = process.env }) {
  const opportunityByLead = new Map((ledger.opportunities || []).filter(row => row.client_id === clientId).map(row => [row.lead_id, row]));
  const meetingsByLead = new Map();
  for (const row of (ledger.meetings || []).filter(item => item.client_id === clientId)) {
    if (!meetingsByLead.has(row.lead_id)) meetingsByLead.set(row.lead_id, []);
    meetingsByLead.get(row.lead_id).push(row);
  }
  const openClarifications = new Set((ledger.clarifications || [])
    .filter(row => row.client_id === clientId && row.status === CLARIFICATION_STATUS.OPEN).map(row => row.lead_id));
  const columns = PIPELINE_STAGES.map(stage => ({ ...stage, count: 0, leads: [] }));
  const byId = new Map(columns.map(column => [column.id, column]));
  for (const lead of leads) {
    const stage = pipelineStageFor(lead, {
      opportunity: opportunityByLead.get(lead.id) || null,
      meetings: meetingsByLead.get(lead.id) || [],
      openClarification: openClarifications.has(lead.id),
      routingReady: routedLeadReady(lead, env).ok,
    });
    const column = byId.get(stage);
    column.count += 1;
    if (column.leads.length < 100) {
      column.leads.push({
        id: lead.id, company: text(lead.company), contactName: text(lead.contactName), email: text(lead.email),
        campaign: text(lead.intendedCampaignVersion) || text(lead.campaign), senderInboxId: text(lead.senderInboxId),
        conversationStatus: opportunityByLead.get(lead.id)?.conversation_status || '',
      });
    }
  }
  return { clientId, total: leads.length, ledgerAvailable: Boolean(ledger.available), stages: columns };
}

module.exports = { PIPELINE_STAGES, pipelineStageFor, buildClientPipeline };
