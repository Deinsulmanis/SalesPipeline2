'use strict';

/**
 * Opportunity / meeting / clarification ledger for managed clients.
 *
 * Billable meetings are recorded as they happen, never reconstructed from
 * Gmail afterwards. Everything here is pure: rules, transitions and billing.
 * Persistence is ledger-store.js; every service function below takes a store
 * and a clientId, and every row it reads back is re-checked for that clientId.
 *
 * MEETING STATES
 *
 *   BOOKED ──► RESCHEDULED ──► HELD ──► QUALIFIED_HELD     (billable)
 *     │  ▲         │  ▲          └────► DISQUALIFIED_HELD  (not billable)
 *     │  └─────────┘  │
 *     ├─► CANCELLED ──┘  (rebooking = RESCHEDULED)
 *     └─► NO_SHOW ────┘
 *
 * Billing derives from HELD + QUALIFIED, never from a booking. A cancelled or
 * no-show meeting bills nothing unless it is rescheduled and then held and
 * qualified. Once invoiced, a qualified meeting's verdict cannot change here.
 */

const { getClient, resolveClientId } = require('./registry');
const { resolveLeadClient } = require('./ownership');

const MEETING_STATUS = Object.freeze({
  BOOKED: 'BOOKED',
  RESCHEDULED: 'RESCHEDULED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  HELD: 'HELD',
  QUALIFIED_HELD: 'QUALIFIED_HELD',
  DISQUALIFIED_HELD: 'DISQUALIFIED_HELD',
});

const TRANSITIONS = Object.freeze({
  BOOKED: Object.freeze(['RESCHEDULED', 'CANCELLED', 'NO_SHOW', 'HELD']),
  RESCHEDULED: Object.freeze(['RESCHEDULED', 'CANCELLED', 'NO_SHOW', 'HELD']),
  CANCELLED: Object.freeze(['RESCHEDULED']),
  NO_SHOW: Object.freeze(['RESCHEDULED']),
  HELD: Object.freeze(['QUALIFIED_HELD', 'DISQUALIFIED_HELD']),
  // A verdict correction, allowed only before an invoice exists.
  QUALIFIED_HELD: Object.freeze(['DISQUALIFIED_HELD']),
  DISQUALIFIED_HELD: Object.freeze(['QUALIFIED_HELD']),
});

const ATTENDEE_STATUS = Object.freeze({ DECISION_MAKER: 'decision_maker', NOT_DECISION_MAKER: 'not_decision_maker', UNKNOWN: 'unknown' });
const EMPLOYER_FIT = Object.freeze({ FIT: 'fit', OUT_OF_ICP: 'out_of_icp', UNKNOWN: 'unknown' });
const QUALIFICATION_STATUS = Object.freeze({ PENDING: 'pending', QUALIFIED: 'qualified', DISQUALIFIED: 'disqualified' });
const INVOICE_STATUS = Object.freeze({ NOT_BILLABLE: 'not_billable', PENDING: 'pending', INVOICED: 'invoiced', PAID: 'paid', VOID: 'void' });

const CONVERSATION_STATUSES = Object.freeze([
  'new', 'qualification_in_progress', 'awaiting_client_clarification', 'meeting_booking',
  'meeting_booked', 'future_need', 'referral_pending', 'wrong_contact', 'needs_review',
  'closed_not_interested', 'closed_unsubscribed', 'closed_outside_icp', 'closed_won', 'closed_lost',
]);
const CLARIFICATION_STATUS = Object.freeze({ OPEN: 'open', ANSWERED: 'answered', CLOSED: 'closed' });

class LedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'LedgerError'; this.code = code; }
}
const fail = (code, message) => { throw new LedgerError(code, message); };
const text = value => String(value == null ? '' : value).trim();
const isoOrNull = value => {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function requireClient(clientId) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) fail(resolved.code, resolved.reason);
  const client = getClient(resolved.clientId);
  if (!client.reporting?.ledger) fail('ledger_not_enabled', `${client.displayName} does not use the meeting ledger`);
  return client;
}

/**
 * Is this held meeting qualified under the client's policy?
 * { qualified, reasons[] } — reasons explain every unmet criterion.
 */
function qualificationVerdict(meeting, client) {
  const policy = client.qualification || {};
  const reasons = [];
  if (!isoOrNull(meeting.held_at)) reasons.push('the meeting has no held timestamp');
  if (policy.requireIcpFit && meeting.employer_fit !== EMPLOYER_FIT.FIT) reasons.push('the employer is not confirmed inside the target market');
  if (policy.requireDecisionMaker && meeting.attendee_status !== ATTENDEE_STATUS.DECISION_MAKER) reasons.push('the attendee is not a confirmed decision-maker');
  const areas = Array.isArray(meeting.decision_areas) ? meeting.decision_areas : [];
  if (policy.requireDecisionMaker && policy.decisionMakerAreas?.length
    && !areas.some(area => policy.decisionMakerAreas.includes(area))) {
    reasons.push(`the attendee's responsibility is not one of: ${policy.decisionMakerAreas.join(', ')}`);
  }
  if (policy.acceptedUseCases?.length && !policy.acceptedUseCases.includes(meeting.use_case)) {
    reasons.push(`no legitimate staffing use case (${policy.acceptedUseCases.join(', ')}) is recorded`);
  }
  if (!text(meeting.qualification_basis)) reasons.push('the qualification basis is not written down');
  return { qualified: reasons.length === 0, reasons };
}

/** Billing is derived, never entered. */
function deriveMeetingBilling(meeting, client) {
  if (client.billing?.model !== 'per_qualified_held_meeting') {
    return { billable: false, billable_reason: 'client has no performance billing', performance_fee_cents: 0, currency: null };
  }
  const reasonByStatus = {
    BOOKED: 'booked, not held', RESCHEDULED: 'rescheduled, not held yet', CANCELLED: 'cancelled',
    NO_SHOW: 'no-show', HELD: 'held, qualification not decided', DISQUALIFIED_HELD: 'held but not qualified',
  };
  if (meeting.meeting_status !== MEETING_STATUS.QUALIFIED_HELD) {
    return { billable: false, billable_reason: reasonByStatus[meeting.meeting_status] || 'not billable', performance_fee_cents: 0, currency: client.billing.currency };
  }
  const verdict = qualificationVerdict(meeting, client);
  if (!verdict.qualified) return { billable: false, billable_reason: verdict.reasons.join('; '), performance_fee_cents: 0, currency: client.billing.currency };
  // The fee is the one snapshotted at qualification; config is the fallback
  // only for a row that predates the snapshot.
  const fee = Number.isInteger(meeting.performance_fee_cents) && meeting.performance_fee_cents > 0
    ? meeting.performance_fee_cents : client.billing.performanceFeeCents;
  return { billable: true, billable_reason: 'qualified employer meeting held', performance_fee_cents: fee, currency: client.billing.currency };
}

function invoiceStatusFor(meeting, billing) {
  const current = text(meeting.invoice_status);
  if (!billing.billable) return current === INVOICE_STATUS.VOID ? current : INVOICE_STATUS.NOT_BILLABLE;
  if ([INVOICE_STATUS.INVOICED, INVOICE_STATUS.PAID].includes(current)) return current;
  return INVOICE_STATUS.PENDING;
}

function withBilling(meeting, client) {
  const billing = deriveMeetingBilling(meeting, client);
  return { ...meeting, ...billing, invoice_status: invoiceStatusFor(meeting, billing) };
}

/**
 * Pure transition. Returns the next meeting row (billing re-derived) or throws
 * LedgerError. `patch` carries the facts the transition needs.
 */
function transitionMeeting(meeting, toStatus, patch = {}, { client, now = new Date().toISOString() } = {}) {
  const from = meeting.meeting_status;
  if (!MEETING_STATUS[toStatus]) fail('invalid_meeting_status', `unknown meeting status ${toStatus}`);
  if (!(TRANSITIONS[from] || []).includes(toStatus)) fail('invalid_meeting_transition', `a ${from} meeting cannot become ${toStatus}`);
  if ([INVOICE_STATUS.INVOICED, INVOICE_STATUS.PAID].includes(meeting.invoice_status)) {
    fail('meeting_invoiced', 'an invoiced meeting cannot change state; void the invoice first');
  }
  const next = { ...meeting, meeting_status: toStatus, updated_at: now };
  if (toStatus === 'RESCHEDULED') {
    const scheduled = isoOrNull(patch.scheduled_for);
    if (!scheduled) fail('scheduled_for_required', 'a rescheduled meeting needs its new time');
    Object.assign(next, { scheduled_for: scheduled, held_at: null, reschedule_count: (meeting.reschedule_count || 0) + 1 });
  }
  if (toStatus === 'CANCELLED') next.cancelled_at = isoOrNull(patch.cancelled_at) || now;
  if (toStatus === 'NO_SHOW') next.no_show_at = isoOrNull(patch.no_show_at) || now;
  if (toStatus === 'HELD') {
    const held = isoOrNull(patch.held_at) || now;
    Object.assign(next, { held_at: held, qualification_status: QUALIFICATION_STATUS.PENDING });
  }
  for (const key of ['attendee_name', 'attendee_title', 'attendee_email', 'attendee_status', 'employer_fit',
    'decision_areas', 'use_case', 'qualification_basis', 'notes']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (toStatus === 'QUALIFIED_HELD') {
    const verdict = qualificationVerdict(next, client);
    if (!verdict.qualified) fail('qualification_unmet', `cannot qualify: ${verdict.reasons.join('; ')}`);
    Object.assign(next, {
      qualification_status: QUALIFICATION_STATUS.QUALIFIED, qualified_at: now,
      performance_fee_cents: client.billing.performanceFeeCents, currency: client.billing.currency,
    });
  }
  if (toStatus === 'DISQUALIFIED_HELD') {
    if (!text(patch.qualification_basis || next.qualification_basis)) fail('disqualification_reason_required', 'record why the meeting did not qualify');
    Object.assign(next, { qualification_status: QUALIFICATION_STATUS.DISQUALIFIED, qualified_at: null, performance_fee_cents: 0 });
  }
  return withBilling(next, client);
}

function validateAttendee(patch) {
  if (patch.attendee_status !== undefined && !Object.values(ATTENDEE_STATUS).includes(patch.attendee_status)) fail('invalid_attendee_status', 'invalid attendee status');
  if (patch.employer_fit !== undefined && !Object.values(EMPLOYER_FIT).includes(patch.employer_fit)) fail('invalid_employer_fit', 'invalid employer fit');
  if (patch.decision_areas !== undefined && !Array.isArray(patch.decision_areas)) fail('invalid_decision_areas', 'decision_areas must be a list');
}

const ids = {
  opportunity: (clientId, leadId) => `opp:${clientId}:${leadId}`,
  meeting: (clientId, leadId, bookedAt) => `mtg:${clientId}:${leadId}:${Date.parse(bookedAt)}`,
  clarification: (clientId, leadId, key) => `clar:${clientId}:${leadId}:${key}`,
  event: (entityId, type, at) => `evt:${entityId}:${type}:${Date.parse(at)}`,
};

function assertRowClient(row, clientId, what) {
  if (!row) return row;
  if (row.client_id !== clientId) fail('client_isolation_violation', `${what} ${row.opportunity_id || row.meeting_id || row.clarification_id || ''} belongs to another client`);
  return row;
}

/**
 * Prove a lead the service is about to attach ledger rows to is this client's,
 * from the lead's own fields. (Sender agreement is a send-time check; the reply
 * path has already proven it before a reply reaches the ledger.)
 */
function assertLeadForClient(lead, client) {
  if (!lead || !text(lead.id)) fail('lead_required', 'a lead is required');
  const owner = resolveLeadClient(lead);
  if (!owner.ok) fail('client_isolation_violation', owner.reason);
  if (owner.clientId !== client.id) fail('client_isolation_violation', `lead ${lead.id} belongs to ${owner.clientId}, not ${client.id}`);
  return lead;
}

async function appendEvent(store, clientId, entityType, entityId, eventType, payload, now) {
  await store.appendEvent({
    event_id: ids.event(entityId, eventType, now), client_id: clientId, entity_type: entityType,
    entity_id: entityId, event_type: eventType, payload, occurred_at: now,
  });
}

// ── Service functions ───────────────────────────────────────────────────────

async function upsertOpportunity(store, { clientId, lead, conversationStatus, contactTitle, notes, by = 'operator', now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  assertLeadForClient(lead, client);
  if (conversationStatus && !CONVERSATION_STATUSES.includes(conversationStatus)) fail('invalid_conversation_status', `unknown conversation status ${conversationStatus}`);
  const opportunityId = ids.opportunity(client.id, lead.id);
  const existing = assertRowClient(await store.getOpportunity(client.id, opportunityId), client.id, 'opportunity');
  const row = {
    ...(existing || {
      opportunity_id: opportunityId, client_id: client.id, lead_id: lead.id,
      created_at: now, qualification_status: QUALIFICATION_STATUS.PENDING, conversation_status: 'new',
    }),
    campaign_id: text(lead.intendedCampaignVersion) || existing?.campaign_id || '',
    source_campaign: text(lead.campaign) || existing?.source_campaign || '',
    employer: text(lead.company) || existing?.employer || '',
    contact_name: text(lead.contactName) || existing?.contact_name || '',
    contact_email: text(lead.email).toLowerCase() || existing?.contact_email || '',
    ...(contactTitle !== undefined ? { contact_title: text(contactTitle) } : {}),
    ...(conversationStatus ? { conversation_status: conversationStatus } : {}),
    ...(notes !== undefined ? { notes: String(notes).slice(0, 10000) } : {}),
    updated_at: now,
  };
  await store.upsertOpportunity(row);
  await appendEvent(store, client.id, 'opportunity', opportunityId, existing ? 'opportunity_updated' : 'opportunity_created',
    { conversationStatus: row.conversation_status, by }, now);
  return row;
}

async function recordMeetingBooked(store, { clientId, lead, bookedAt, scheduledFor, attendee = {}, notes = '', by = 'operator', now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  assertLeadForClient(lead, client);
  const booked = isoOrNull(bookedAt) || now;
  const scheduled = isoOrNull(scheduledFor);
  if (!scheduled) fail('scheduled_for_required', 'a booked meeting needs its scheduled time');
  validateAttendee(attendee);
  const opportunity = await upsertOpportunity(store, { clientId: client.id, lead, conversationStatus: 'meeting_booked', by, now });
  const meeting = withBilling({
    meeting_id: ids.meeting(client.id, lead.id, booked), client_id: client.id, opportunity_id: opportunity.opportunity_id,
    lead_id: lead.id, campaign_id: opportunity.campaign_id, meeting_status: MEETING_STATUS.BOOKED,
    booked_at: booked, scheduled_for: scheduled, held_at: null, reschedule_count: 0,
    attendee_name: text(attendee.attendee_name), attendee_title: text(attendee.attendee_title),
    attendee_email: text(attendee.attendee_email).toLowerCase(),
    attendee_status: attendee.attendee_status || ATTENDEE_STATUS.UNKNOWN,
    employer_fit: attendee.employer_fit || EMPLOYER_FIT.UNKNOWN,
    decision_areas: attendee.decision_areas || [], use_case: attendee.use_case || '',
    qualification_status: QUALIFICATION_STATUS.PENDING, qualification_basis: '',
    performance_fee_cents: 0, currency: client.billing.currency, invoice_status: INVOICE_STATUS.NOT_BILLABLE,
    notes: String(notes || '').slice(0, 10000), created_at: now, updated_at: now,
  }, client);
  await store.insertMeeting(meeting);
  await appendEvent(store, client.id, 'meeting', meeting.meeting_id, 'meeting_booked', { scheduledFor: scheduled, by }, now);
  return meeting;
}

async function updateMeeting(store, { clientId, meetingId, toStatus, patch = {}, by = 'operator', now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  validateAttendee(patch);
  const meeting = assertRowClient(await store.getMeeting(client.id, meetingId), client.id, 'meeting');
  if (!meeting) fail('meeting_not_found', `meeting ${meetingId} does not exist for ${client.displayName}`);
  const next = transitionMeeting(meeting, toStatus, patch, { client, now });
  await store.updateMeeting(next);
  await appendEvent(store, client.id, 'meeting', meetingId, `meeting_${toStatus.toLowerCase()}`,
    { from: meeting.meeting_status, to: toStatus, billable: next.billable, by }, now);
  if (toStatus === 'QUALIFIED_HELD' || toStatus === 'DISQUALIFIED_HELD') {
    const opportunity = assertRowClient(await store.getOpportunity(client.id, meeting.opportunity_id), client.id, 'opportunity');
    if (opportunity) {
      await store.upsertOpportunity({
        ...opportunity, qualification_status: next.qualification_status,
        qualification_basis: next.qualification_basis || opportunity.qualification_basis || '', updated_at: now,
      });
    }
  }
  return next;
}

async function setInvoiceStatus(store, { clientId, meetingId, invoiceStatus, by = 'operator', now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  const meeting = assertRowClient(await store.getMeeting(client.id, meetingId), client.id, 'meeting');
  if (!meeting) fail('meeting_not_found', `meeting ${meetingId} does not exist for ${client.displayName}`);
  if (!Object.values(INVOICE_STATUS).includes(invoiceStatus)) fail('invalid_invoice_status', 'invalid invoice status');
  const billing = deriveMeetingBilling(meeting, client);
  if (!billing.billable && [INVOICE_STATUS.PENDING, INVOICE_STATUS.INVOICED, INVOICE_STATUS.PAID].includes(invoiceStatus)) {
    fail('meeting_not_billable', `meeting is not billable: ${billing.billable_reason}`);
  }
  const next = { ...meeting, invoice_status: invoiceStatus, updated_at: now };
  await store.updateMeeting(next);
  await appendEvent(store, client.id, 'meeting', meetingId, 'invoice_status_changed', { from: meeting.invoice_status, to: invoiceStatus, by }, now);
  return next;
}

async function openClarification(store, { clientId, lead, question, topics = [], sourceMessageId = '', by = 'system', now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  if (!client.conversationOwnership?.clarificationWorkflow) fail('clarification_not_enabled', `${client.displayName} has no clarification workflow`);
  assertLeadForClient(lead, client);
  if (!text(question)) fail('question_required', 'record the exact question that needs the client');
  const opportunity = await upsertOpportunity(store, { clientId: client.id, lead, conversationStatus: 'awaiting_client_clarification', by, now });
  const key = text(sourceMessageId) || String(Date.parse(now));
  const clarificationId = ids.clarification(client.id, lead.id, key);
  const existing = assertRowClient(await store.getClarification(client.id, clarificationId), client.id, 'clarification');
  if (existing) return existing;   // the same inbound message never opens two
  const row = {
    clarification_id: clarificationId, client_id: client.id, opportunity_id: opportunity.opportunity_id,
    lead_id: lead.id, question: String(question).slice(0, 2000), topics: [...topics],
    source_message_id: text(sourceMessageId), status: CLARIFICATION_STATUS.OPEN,
    answer: '', answered_by: '', answered_at: null, created_at: now, updated_at: now,
  };
  await store.insertClarification(row);
  await appendEvent(store, client.id, 'clarification', clarificationId, 'clarification_opened', { topics, by }, now);
  return row;
}

async function answerClarification(store, { clientId, clarificationId, answer, answeredBy, now = new Date().toISOString() }) {
  const client = requireClient(clientId);
  if (!text(answer)) fail('answer_required', 'record the answer obtained from the client');
  if (!text(answeredBy)) fail('answered_by_required', 'record which operator entered the answer');
  const row = assertRowClient(await store.getClarification(client.id, clarificationId), client.id, 'clarification');
  if (!row) fail('clarification_not_found', `clarification ${clarificationId} does not exist for ${client.displayName}`);
  if (row.status !== CLARIFICATION_STATUS.OPEN) fail('clarification_not_open', `clarification is ${row.status}`);
  const next = { ...row, status: CLARIFICATION_STATUS.ANSWERED, answer: String(answer).slice(0, 5000), answered_by: text(answeredBy), answered_at: now, updated_at: now };
  await store.updateClarification(next);
  // ScaleLab continues the employer conversation; qualification resumes
  // unless another question for this opportunity is still open.
  const open = (await store.listClarifications(client.id, { opportunityId: row.opportunity_id, status: CLARIFICATION_STATUS.OPEN }))
    .filter(item => assertRowClient(item, client.id, 'clarification').clarification_id !== clarificationId);
  const opportunity = assertRowClient(await store.getOpportunity(client.id, row.opportunity_id), client.id, 'opportunity');
  if (opportunity && !open.length && opportunity.conversation_status === 'awaiting_client_clarification') {
    await store.upsertOpportunity({ ...opportunity, conversation_status: 'qualification_in_progress', updated_at: now });
  }
  await appendEvent(store, client.id, 'clarification', clarificationId, 'clarification_answered', { by: answeredBy }, now);
  return next;
}

/** Billing summary from the client's meetings. Pure. */
function billingSummary(meetings = [], client) {
  const rows = meetings.filter(row => row.client_id === client.id).map(row => withBilling(row, client));
  const billable = rows.filter(row => row.billable);
  const byInvoice = {};
  for (const row of billable) byInvoice[row.invoice_status] = (byInvoice[row.invoice_status] || 0) + 1;
  return {
    model: client.billing.model,
    configuredFeeCents: client.billing.performanceFeeCents || 0,
    currency: client.billing.currency || null,
    billableMeetings: billable.length,
    accruedCents: billable.reduce((sum, row) => sum + (row.performance_fee_cents || 0), 0),
    invoicedCents: billable.filter(row => [INVOICE_STATUS.INVOICED, INVOICE_STATUS.PAID].includes(row.invoice_status))
      .reduce((sum, row) => sum + (row.performance_fee_cents || 0), 0),
    byInvoiceStatus: byInvoice,
  };
}

module.exports = {
  MEETING_STATUS, TRANSITIONS, ATTENDEE_STATUS, EMPLOYER_FIT, QUALIFICATION_STATUS, INVOICE_STATUS,
  CONVERSATION_STATUSES, CLARIFICATION_STATUS, LedgerError, ids,
  qualificationVerdict, deriveMeetingBilling, withBilling, transitionMeeting, billingSummary,
  upsertOpportunity, recordMeetingBooked, updateMeeting, setInvoiceStatus,
  openClarification, answerClarification, requireClient,
};
