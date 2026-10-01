'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../integrations/clients/ledger');
const { createMemoryLedgerStore, createSupabaseLedgerStore } = require('../integrations/clients/ledger-store');
const { getClient } = require('../integrations/clients/registry');

const { activateJoleForTest } = require('../test-support/client-lifecycle');

// Everything below models Jole after onboarding and an explicit activation.
let restoreActivation;
test.before(() => { restoreActivation = activateJoleForTest(); });
test.after(() => restoreActivation());
const JOLE_CFG = () => getClient('jole');
const joleLead = (id = 'jole-lead-1', extra = {}) => ({
  id, company: 'Voltline Mission Critical LLC', contactName: 'Pat Rivera', email: `${id}@voltline-test.invalid`,
  leadNiche: 'jole_employer', emailTemplateId: 'jole-dc-mission-critical-v1', intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL',
  campaign: 'JOLE_DC_MISSION_CRITICAL', senderInboxId: '', tradeType: '', ...extra,
});
const scalelabLead = { id: 'sl-1', email: 'a@b-test.invalid', leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' };
const qualifiedFacts = {
  attendee_name: 'Dana Ops', attendee_title: 'VP Operations', attendee_status: 'decision_maker',
  employer_fit: 'fit', decision_areas: ['operations', 'hiring'], use_case: 'project_based',
  qualification_basis: 'Runs field hiring for two data-center builds starting Q1; uses staffing for electricians.',
};

async function booked(store, id = 'jole-lead-1') {
  return ledger.recordMeetingBooked(store, {
    clientId: 'jole', lead: joleLead(id), bookedAt: '2026-10-01T15:00:00.000Z', scheduledFor: '2026-10-08T16:00:00.000Z',
    attendee: { attendee_name: 'Dana Ops', attendee_title: 'VP Operations' }, now: '2026-10-01T15:00:00.000Z',
  });
}

test('meetings: BOOKED ONLY is not billable', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  assert.equal(meeting.meeting_status, 'BOOKED');
  assert.equal(meeting.billable, false);
  assert.equal(meeting.invoice_status, 'not_billable');
  assert.equal(ledger.billingSummary(await store.listMeetings('jole'), JOLE_CFG()).billableMeetings, 0);
});

test('meetings: CANCELLED is not billable', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  const next = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'CANCELLED' });
  assert.equal(next.billable, false); assert.equal(next.billable_reason, 'cancelled');
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD' }), error => error.code === 'invalid_meeting_transition');
});

test('meetings: NO SHOW is not billable', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  const next = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'NO_SHOW' });
  assert.equal(next.billable, false); assert.equal(next.billable_reason, 'no-show');
});

test('meetings: RESCHEDULED → HELD → QUALIFIED is billable at the configured fee', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'CANCELLED' });
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'RESCHEDULED', patch: { scheduled_for: '2026-10-15T16:00:00.000Z' } });
  const held = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD', patch: { held_at: '2026-10-15T16:05:00.000Z' } });
  assert.equal(held.billable, false); assert.equal(held.billable_reason, 'held, qualification not decided');
  const qualified = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD', patch: qualifiedFacts });
  assert.equal(qualified.billable, true);
  assert.equal(qualified.performance_fee_cents, JOLE_CFG().billing.performanceFeeCents);
  assert.equal(qualified.currency, 'USD');
  assert.equal(qualified.invoice_status, 'pending');
  assert.equal(qualified.reschedule_count, 1);
  const summary = ledger.billingSummary(await store.listMeetings('jole'), JOLE_CFG());
  assert.equal(summary.billableMeetings, 1);
  assert.equal(summary.accruedCents, 35000);
  const opportunity = (await store.listOpportunities('jole'))[0];
  assert.equal(opportunity.qualification_status, 'qualified');
});

test('meetings: HELD + wrong attendee is not billable', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD' });
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD',
    patch: { ...qualifiedFacts, attendee_status: 'not_decision_maker' } }), error => error.code === 'qualification_unmet' && /decision-maker/.test(error.message));
  const dq = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'DISQUALIFIED_HELD',
    patch: { attendee_status: 'not_decision_maker', qualification_basis: 'Attendee was a project engineer with no hiring role.' } });
  assert.equal(dq.billable, false);
});

test('meetings: HELD + out-of-ICP employer is not billable', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD' });
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD',
    patch: { ...qualifiedFacts, employer_fit: 'out_of_icp' } }), error => error.code === 'qualification_unmet' && /target market/.test(error.message));
  // A decision-maker whose role is not staffing-related is not enough either.
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD',
    patch: { ...qualifiedFacts, decision_areas: ['marketing'] } }), error => error.code === 'qualification_unmet');
  // No staffing use case recorded.
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD',
    patch: { ...qualifiedFacts, use_case: '' } }), error => error.code === 'qualification_unmet');
});

test('meetings: HELD + correct employer + legitimate decision-maker is billable; no open requisition or purchase needed', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD' });
  const q = await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD',
    patch: { ...qualifiedFacts, use_case: 'recurring' } });
  assert.equal(q.billable, true);
  assert.equal(JOLE_CFG().qualification.openRequisitionRequired, false);
  assert.equal(JOLE_CFG().qualification.purchaseRequired, false);
});

test('meetings: invoicing only for billable meetings, and an invoiced verdict is frozen', async () => {
  const store = createMemoryLedgerStore();
  const meeting = await booked(store);
  await assert.rejects(ledger.setInvoiceStatus(store, { clientId: 'jole', meetingId: meeting.meeting_id, invoiceStatus: 'invoiced' }), error => error.code === 'meeting_not_billable');
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'HELD' });
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'QUALIFIED_HELD', patch: qualifiedFacts });
  const invoiced = await ledger.setInvoiceStatus(store, { clientId: 'jole', meetingId: meeting.meeting_id, invoiceStatus: 'invoiced' });
  assert.equal(invoiced.invoice_status, 'invoiced');
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'DISQUALIFIED_HELD', patch: { qualification_basis: 'x' } }), error => error.code === 'meeting_invoiced');
  assert.equal(ledger.billingSummary(await store.listMeetings('jole'), JOLE_CFG()).invoicedCents, 35000);
});

test('meetings: the fee is configuration, snapshotted at qualification', () => {
  const repriced = { ...JOLE_CFG(), billing: { ...JOLE_CFG().billing, performanceFeeCents: 50000 } };
  const held = { meeting_status: 'HELD', held_at: '2026-10-01T00:00:00Z', invoice_status: 'not_billable', ...qualifiedFacts };
  const qualified = ledger.transitionMeeting(held, 'QUALIFIED_HELD', {}, { client: repriced, now: '2026-10-01T01:00:00Z' });
  assert.equal(qualified.performance_fee_cents, 50000);
  // Later config changes do not rewrite an already qualified meeting.
  assert.equal(ledger.deriveMeetingBilling(qualified, JOLE_CFG()).performance_fee_cents, 50000);
});

test('MIXED CLIENT MEETING ASSOCIATION is impossible', async () => {
  const store = createMemoryLedgerStore();
  // A ScaleLab lead cannot get a Jole meeting.
  await assert.rejects(ledger.recordMeetingBooked(store, { clientId: 'jole', lead: scalelabLead, scheduledFor: '2026-10-08T16:00:00Z' }), error => error.code === 'client_isolation_violation');
  // ScaleLab has no meeting ledger at all.
  await assert.rejects(ledger.recordMeetingBooked(store, { clientId: 'scalelab', lead: scalelabLead, scheduledFor: '2026-10-08T16:00:00Z' }), error => error.code === 'ledger_not_enabled');
  // The store refuses a meeting whose opportunity belongs to another client (the database FK).
  const meeting = await booked(store);
  await assert.rejects(store.insertMeeting({ ...meeting, meeting_id: 'mtg:forged', client_id: 'scalelab' }), error => error.code === 'client_isolation_violation');
  // A client never reads another client's meeting.
  assert.equal(await store.getMeeting('scalelab', meeting.meeting_id), null);
  assert.deepEqual(await store.listMeetings('scalelab'), []);
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'scalelab', meetingId: meeting.meeting_id, toStatus: 'HELD' }), error => error.code === 'ledger_not_enabled');
});

test('clarifications: open → answered returns the opportunity to qualification', async () => {
  const store = createMemoryLedgerStore();
  const lead = joleLead();
  const opened = await ledger.openClarification(store, { clientId: 'jole', lead, question: 'Do your electricians carry OSHA 30?', topics: ['credentials'], sourceMessageId: 'gm-9' });
  assert.equal(opened.status, 'open');
  assert.equal((await ledger.openClarification(store, { clientId: 'jole', lead, question: 'dup', sourceMessageId: 'gm-9' })).clarification_id, opened.clarification_id);
  await assert.rejects(ledger.answerClarification(store, { clientId: 'jole', clarificationId: opened.clarification_id, answer: 'Yes', answeredBy: '' }), error => error.code === 'answered_by_required');
  const answered = await ledger.answerClarification(store, { clientId: 'jole', clarificationId: opened.clarification_id, answer: 'Yes — every journeyman holds OSHA 30 (per Jorge, 2026-10-02).', answeredBy: 'deins' });
  assert.equal(answered.status, 'answered');
  assert.equal((await store.listOpportunities('jole'))[0].conversation_status, 'qualification_in_progress');
  await assert.rejects(ledger.answerClarification(store, { clientId: 'jole', clarificationId: opened.clarification_id, answer: 'again', answeredBy: 'deins' }), error => error.code === 'clarification_not_open');
  await assert.rejects(ledger.openClarification(store, { clientId: 'jole', lead: scalelabLead, question: 'q' }), error => error.code === 'client_isolation_violation');
});

test('supabase store: every read is filtered by client_id in the query and rows are re-checked', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method });
    const body = url.includes('client_meetings') ? [{ meeting_id: 'm', client_id: 'scalelab' }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const store = createSupabaseLedgerStore({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TESTONLY', CLIENT_LEDGER_ENABLED: 'true' }, fetchImpl,
  });
  await store.listOpportunities('jole');
  assert.match(requests[0].url, /client_opportunities\?select=\*&client_id=eq\.jole/);
  // A row for another client coming back is an isolation violation, not data.
  await assert.rejects(store.listMeetings('jole'), error => error.code === 'client_isolation_violation');
  await assert.rejects(store.listOpportunities('acme'), error => error.code === 'client_unknown');
  const suppressions = await store.clientSuppressionsFor('jole', { email: 'p@voltline-test.invalid', company: 'Voltline LLC' });
  assert.equal(suppressions.available, true);
  assert.match(decodeURIComponent(requests.at(-1).url), /client_id=eq\.jole&active=is\.true&or=\(and\(match_type\.eq\.email/);
});

test('supabase store: disabled until CLIENT_LEDGER_ENABLED=true; a disabled store never throws on suppression reads', async () => {
  const store = createSupabaseLedgerStore({ env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TESTONLY' }, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.clientSuppressionsFor('jole', { email: 'a@b.co' }), { available: false, reason: 'CLIENT_LEDGER_ENABLED is not true' });
  await assert.rejects(store.listMeetings('jole'), error => error.code === 'ledger_unavailable');
  const failing = createSupabaseLedgerStore({ env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'k', CLIENT_LEDGER_ENABLED: 'true' },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'secret echo' }) });
  const verdict = await failing.clientSuppressionsFor('jole', { email: 'a@b.co' });
  assert.equal(verdict.available, false);
  assert.match(verdict.error, /HTTP 500/);
  assert.doesNotMatch(verdict.error, /secret echo/);
});
