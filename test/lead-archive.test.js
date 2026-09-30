'use strict';

// Soft archive and the retirement of the dental offer (2026-09-30).
//
// Two independent guarantees are pinned here:
//   1. An archived lead can never be sent anything, by any path, and stays
//      fully readable: its row, activity, Gmail message and thread ids.
//   2. A lead of a retired offer (dental) can never be sent anything, archived
//      or not, restored or not.
// Staffing must be exactly as it was. Nothing here contacts Google, Gmail or
// Supabase; the canonical-write cases use the PostgREST double.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const archive = require('../integrations/lead-archive');
const {
  isArchivedLead, archiveReasonFromNotes, addArchiveMarker, removeArchiveMarker, retiredOfferFor,
  retiredOfferBlock, outreachBlockForLead, planLeadArchive, planBoardArchive, planLeadRestore, planBoardRestore,
  currentArchiveRecord, ARCHIVE_MARKER_PREFIX, ARCHIVED_STAGE, ARCHIVE_REASONS,
} = archive;
const { planOfferRetirement, sendableNow } = require('../integrations/offer-retirement');
const { routedLeadReady, validateRoute, templateById } = require('../integrations/campaign-routing');
const { evaluateFreshSendSafety, guardProviderSend } = require('../integrations/send-safety-revalidate');
const { deriveAutomationOwnership, OWNER, BLOCKED_BY, NON_COLD_STAGES } = require('../integrations/automation-ownership');
const { sendSuppressionReason, deriveAutomationState, AUTOMATION_STATES } = require('../integrations/pipeline-state');
const { planSenderRebalance } = require('../integrations/sender-balance');
const { pendingIntentWork } = require('../integrations/intent-backstop');
const { runGoogleCalendarSync } = require('../integrations/google-calendar');
const { coldSendAttribution } = require('../integrations/campaign-versions');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');
const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyCanonicalChange, applyLeadChanges, SAFETY_NOTE_MARKERS, preserveSafetyMarkers,
} = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agentSrc = readSource('outreach-agent.js');
const serverSrc = readSource('server.js');
const browserSrc = readSource(path.join('public', 'index.html'));

const crypto = require('node:crypto');
const stableId = (prefix, parts) => `${prefix}:${crypto.createHash('sha1')
  .update(parts.map(value => String(value || '')).join('|')).digest('hex').slice(0, 24)}`;
const quiet = { log() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-30T23:00:00.000Z');
const STAFFING_ENV = Object.freeze({ STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' });

// Production shapes (2026-09-30 read-only audit): a routed Ontario lead and a
// legacy BC lead whose only dental signals are tradeType and campaign name.
const routedDental = (extra = {}) => ({
  id: 'd-routed', company: 'Maple Smile Dentistry', contactName: 'Dr. Aya', email: 'aya@maplesmile.test',
  city: 'Toronto', tradeType: 'Dentist', website: 'maplesmile.test', stage: 'Queued', emailStatus: '',
  lastEmailedAt: '', emailStep: '', notes: '', leadNiche: 'dental', senderInboxId: 'primary',
  emailTemplateId: 'dental-guarantee-v1', routingRequired: 'true', intendedCampaignVersion: 'dental_v3_pay_per_booking',
  campaign: 'Ontario List', clientId: 'scalelab', ...extra,
});
const legacyDental = (extra = {}) => ({
  id: 'd-legacy', company: 'Fraser Valley Ortho', contactName: '', email: 'info@fvortho.test', city: 'Abbotsford',
  tradeType: 'Orthodontist', website: '', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
  lastEmailedAt: new Date(NOW - 10 * DAY).toISOString(), notes: '', leadNiche: '', senderInboxId: '',
  emailTemplateId: '', routingRequired: '', intendedCampaignVersion: '', campaign: 'BC Dentists — 33 Cities — Aug 2026',
  clientId: 'scalelab', ...extra,
});
let seq = 0;
const staffingLead = (extra = {}) => {
  seq += 1;
  return {
    id: `s-${seq}`, company: `Staffing Co ${seq}`, contactName: 'Alex', email: `s${seq}@staffing.test`,
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name, tradeType: 'A (light industrial / manufacturing / warehouse / logistics)',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
    siteContext: 'Your warehouse staffing team serves local manufacturers.',
    senderInboxId: 'primary', routingRequired: 'true', sheetRow: seq, revision: 1, ...extra,
  };
};
const archived = (lead, reason = ARCHIVE_REASONS.OFFER_RETIRED_DENTAL) => ({
  ...lead, stage: ARCHIVED_STAGE, notes: addArchiveMarker(lead.notes, reason),
});
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
  ...STAFFING_ENV,
});
const freshGate = (snapshot, current, purpose = 'cold') => guardProviderSend(snapshot,
  { env: SEND_ENV, loadFreshState: async () => ({ current, suppressedEmails: new Set() }) }, { purpose });

// ── Dental recognition ──────────────────────────────────────────────────────

test('dental is recognised by canonical ids first and by legacy tradeType / campaign, never by company name', () => {
  assert.deepEqual(retiredOfferFor(routedDental()).signals,
    ['lead_niche', 'email_template_id', 'campaign_version', 'trade_type']);
  assert.deepEqual(retiredOfferFor(legacyDental()).signals, ['trade_type', 'campaign']);
  for (const tradeType of ['Orthodontist', 'Periodontist', 'Endodontist', 'Oral surgeon', 'Denture care center', 'Cosmetic dentist']) {
    assert.ok(retiredOfferFor({ tradeType }), `${tradeType} is dental`);
  }
  assert.equal(retiredOfferFor({ campaign: 'Dental Campaign Test' }).offer.id, 'dental');
  // A company name alone is display text, not identity.
  assert.equal(retiredOfferFor({ company: 'Sparkle Dental Spa' }), null);
  // Staffing, roofing and med spa leads are not dental.
  assert.equal(retiredOfferFor(staffingLead()), null);
  // Words that merely contain "dent" never retire a lead.
  for (const tradeType of ['Independent staffing agency', 'Student staffing', 'Resident services', 'Accident & injury recruiting', 'Confident Staffing']) {
    assert.equal(retiredOfferFor(staffingLead({ tradeType, campaign: `${tradeType} list` })), null, tradeType);
  }
  for (const campaign of ['Surrey Dentists', 'Tier C Dentists Vancouver', 'BC Dentists — 33 Cities — Aug 2026', 'Dental Campaign Test', 'Smile Dentistry']) {
    assert.ok(retiredOfferFor({ campaign }), campaign);
  }
  assert.equal(retiredOfferFor({ leadNiche: 'roofing', campaign: 'BC Roofing Survey', tradeType: 'Roofing contractor' }), null);
  assert.equal(retiredOfferFor({ tradeType: 'Medical spa', campaign: 'toronto-medspa-jul' }), null);
});

// ── 1. archived dental first-touch cannot send ──────────────────────────────

test('1. an archived dental first-touch lead is refused by routing, ownership and the final provider gate', async () => {
  const lead = archived(routedDental());
  assert.equal(routedLeadReady(lead).code, 'archived');
  assert.equal(sendSuppressionReason(lead), ARCHIVE_MARKER_PREFIX);
  const ownership = deriveAutomationOwnership(lead, { sendingEnabled: true, coldCadenceDue: true });
  assert.equal(ownership.owner, OWNER.NONE);
  assert.equal(ownership.blockedBy, BLOCKED_BY.ARCHIVED);
  // Even a stale, pre-archive snapshot reaching the gate is refused on the row as it is now.
  const verdict = await freshGate(routedDental(), lead);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'archived');
});

// ── 2. archived dental follow-up cannot send, even with a due row ───────────

test('2. an archived dental follow-up is refused even though an old due follow-up row still exists', async () => {
  // Emailed step 1, ten days ago: by cadence alone step 2 is overdue.
  const due = legacyDental();
  const lead = archived(due);
  assert.equal(lead.emailStatus, 'emailed', 'the historical send state is preserved');
  assert.equal(routedLeadReady(lead).code, 'archived');
  assert.ok(NON_COLD_STAGES.includes('archived'));
  assert.equal(sendableNow(lead, { now: NOW }), false);
  for (const purpose of ['cold', 'sequence', 'warm']) {
    const verdict = await freshGate(due, lead, purpose);
    assert.equal(verdict.allowed, false, purpose);
    assert.equal(verdict.code, 'archived', purpose);
  }
  // Selection itself consults routing, so the due row never reaches the gate.
  assert.match(agentSrc, /function coldFollowUpBlockReason\(lead\) \{\n  const archived = outreachBlockForLead\(lead\);/);
  assert.match(agentSrc, /if \(!routedLeadCanUseCurrentSender\(l\)\) return false;/);
});

test('the retired dental offer blocks every purpose even for a lead that was never archived', async () => {
  const lead = legacyDental();
  assert.equal(routedLeadReady(lead).code, 'offer_retired');
  for (const purpose of ['cold', 'sequence', 'warm']) {
    const verdict = await freshGate(lead, lead, purpose);
    assert.equal(verdict.allowed, false, purpose);
    assert.equal(verdict.code, 'offer_retired', purpose);
  }
  // Reply automation (a warm answer or booking link) is never handed a dental lead.
  const warm = deriveAutomationOwnership({ ...lead, emailStatus: 'replied' }, {
    boardLead: { stage: 'hot' }, sendingEnabled: true,
    replyResponseDecision: { send: true, action: 'AUTO_BOOKING_RESPONSE' },
  });
  assert.equal(warm.owner, OWNER.NONE);
  assert.equal(warm.blockedBy, BLOCKED_BY.OFFER_RETIRED);
  // Queue admission and manual queueing refuse it, and no dental template is ready.
  const inboxes = [{ id: 'primary', email: 'p@x.test', sendEligible: true, deliveryImplemented: true }];
  assert.equal(validateRoute({ niche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes }).code, 'offer_retired');
  assert.equal(templateById('dental-guarantee-v1').ready, false);
  assert.throws(() => coldSendAttribution(lead, 2), /not active/);
});

// ── 3/4. sender balance and the 06:40 / 06:50 refill ────────────────────────

const SENDERS = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'].map(id => ({
  id, email: `${id}@example.test`, status: 'active', sendEligible: true, credentialConfigured: true,
  dailyLimit: { primary: 60, tryscalelabai: 60, scalelabaiteam: 40, deniels: 20, deniels_tryscalelabai: 20 }[id],
  perRunLimit: 6, ...(id === 'scalelabaiteam' ? { staffingOnly: true } : {}),
}));
const balanceInput = (leads, extra = {}) => ({ leads, activities: [], boardLeads: [], suppressedEmails: new Set(),
  lockedLeadIds: new Set(), senders: SENDERS, horizon: NOW.getTime() + DAY, env: STAFFING_ENV,
  renderOptions: STAFFING_RENDER_OPTIONS, ...extra });

test('3. archived and retired leads are never sender-balance supply and never move', () => {
  const liveStaffing = Array.from({ length: 150 }, () => staffingLead());
  const archivedStaffing = Array.from({ length: 20 }, () => archived(staffingLead(), ARCHIVE_REASONS.MANUAL));
  const dental = Array.from({ length: 80 }, (_, i) => routedDental({ id: `dq-${i}`, email: `dq${i}@x.test` }));
  const plan = planSenderRebalance(balanceInput([...liveStaffing, ...archivedStaffing, ...dental]));
  const moved = new Set(plan.moves.map(move => move.leadId));
  assert.ok(plan.moves.length > 0, 'live staffing still balances');
  for (const lead of [...archivedStaffing, ...dental]) assert.equal(moved.has(lead.id), false, lead.id);
  // The same plan without the archived and retired leads: identical moves.
  const baseline = planSenderRebalance(balanceInput(liveStaffing));
  assert.deepEqual(plan.moves.map(move => [move.leadId, move.to]), baseline.moves.map(move => [move.leadId, move.to]));
});

test('4. the refill projection does not count archived or retired follow-ups as an inbox\'s workload', () => {
  const owned = Array.from({ length: 30 }, (_, i) => {
    const lead = legacyDental({ id: `df-${i}`, email: `df${i}@x.test`, senderInboxId: 'deniels',
      lastEmailedAt: new Date(NOW - 4 * DAY).toISOString() });
    return { lead: i % 2 ? archived(lead) : lead,
      activity: { sourceLeadId: lead.id, eventType: 'initial_email_sent', metadata: JSON.stringify({ senderInboxId: 'deniels' }) } };
  });
  const plan = planSenderRebalance(balanceInput(owned.map(item => item.lead), { activities: owned.map(item => item.activity) }));
  assert.equal(plan.before.find(row => row.id === 'deniels').followUps, 0);
});

// ── 5. active counts ────────────────────────────────────────────────────────

test('5. archived records leave active lists, counts, facets, queued and board totals; Archive has its own count', () => {
  const build = serverSrc.slice(serverSrc.indexOf('const allRows = leads.map(lead => {'), serverSrc.indexOf('const sendActivity = buildConfirmedSendActivity'));
  assert.match(build, /const archived = isArchivedLead\(lead\);/);
  assert.match(build, /if \(!archived\) \{\n      if \(lead\.stage === 'Queued'\) counts\.queued\+\+;/);
  assert.match(build, /const tally = \(bucket, key\) => \{ if \(!archived\) bucket\[key\]/);
  assert.match(build, /const rows = allRows\.filter\(row => !row\.archived\);/);
  assert.match(build, /counts\.total = rows\.length;\n  counts\.archived = /);
  // The board: archived cards are removed before the pipeline index is built.
  assert.match(serverSrc, /const boardLeads = allBoardLeads\.filter\(card => !isArchivedLead\(card\)\);\n  const archivedBoardLeads = allBoardLeads\.filter\(card => isArchivedLead\(card\)\);\n  const pipelineIndex = buildOutreachPipelineIndex\(leads, boardLeads\);/);
  // /api/leads (the Pipeline board) and the Inbox exclude archived records.
  assert.match(serverSrc, /res\.json\(req\.query\.archived === 'include' \? leads : leads\.filter\(lead => !isArchivedLead\(lead\)\)\);/);
  assert.match(serverSrc, /const activeRecords = dataset\.replyRecords\.filter\(record => !archivedIds\.has\(record\.leadId\)\);/);
  // The browser's lead table reads dataset.rows, which is active only.
  assert.match(serverSrc, /let scopedRows = dataset\.rows;/);
});

// ── 6/7. history and provider ids ───────────────────────────────────────────

test('6/7. archiving writes only stage and notes; every field, event and Gmail id is preserved', () => {
  const lead = routedDental({ stage: 'Contacted', emailStatus: 'emailed', emailStep: '2', lastEmailedAt: '2026-09-20T15:00:00.000Z',
    senderInboxId: 'tryscalelabai', notes: 'Owner is Dr. Aya [REPLY: Not Interested]' });
  const activities = [
    { eventId: 'gmail:m1', sourceLeadId: lead.id, leadId: `CE-${lead.id}`, eventType: 'initial_email_sent', occurredAt: '2026-09-16T15:00:00Z',
      metadata: JSON.stringify({ gmailMessageId: 'm1', gmailThreadId: 't1', senderInboxId: 'tryscalelabai' }) },
    { eventId: 'gmail-reply:m2', sourceLeadId: lead.id, leadId: `CE-${lead.id}`, eventType: 'negative_reply', occurredAt: '2026-09-21T15:00:00Z',
      metadata: JSON.stringify({ gmailMessageId: 'm2', gmailThreadId: 't1' }) },
  ];
  const before = JSON.stringify(activities);
  const plan = planLeadArchive(lead, { reason: ARCHIVE_REASONS.OFFER_RETIRED_DENTAL, archivedBy: 'test', source: 'offer_retirement',
    now: NOW, activities, stableId });
  assert.deepEqual(Object.keys(plan.patch).sort(), ['notes', 'stage'], 'nothing else on the row changes');
  assert.equal(plan.patch.stage, 'Archived');
  assert.ok(plan.patch.notes.includes('Owner is Dr. Aya') && plan.patch.notes.includes('[REPLY: Not Interested]'),
    'notes, opt-out and suppression evidence are kept');
  assert.equal(JSON.stringify(activities), before, 'historical events are never rewritten');
  const meta = plan.metadata;
  for (const [field, value] of Object.entries({ previousStage: 'Contacted', previousEmailStatus: 'emailed', previousEmailStep: '2',
    previousLastEmailedAt: '2026-09-20T15:00:00.000Z', senderInboxId: 'tryscalelabai', emailTemplateId: 'dental-guarantee-v1',
    intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List', leadNiche: 'dental',
    archiveReason: 'offer_retired_dental', archivedBy: 'test', archiveSource: 'offer_retirement', retiredOffer: 'dental' })) {
    assert.equal(meta[field], value, field);
  }
  assert.equal(plan.event.eventType, 'lead_archived');
  assert.equal(plan.event.sourceLeadId, lead.id);
  // After archiving, the record of the archive is readable from the timeline.
  const record = currentArchiveRecord([...activities, plan.event], lead.id);
  assert.equal(record.previousStage, 'Contacted');
  assert.equal(record.eventId, plan.event.eventId);
});

test('7. the retirement summary counts every preserved Gmail message and thread id', () => {
  const lead = legacyDental({ id: 'd7', senderInboxId: 'primary' });
  const activities = [
    { sourceLeadId: 'd7', eventType: 'initial_email_sent', metadata: JSON.stringify({ gmailMessageId: 'a', gmailThreadId: 'T', senderInboxId: 'primary' }) },
    { sourceLeadId: 'd7', eventType: 'follow_up_sent', metadata: JSON.stringify({ gmailMessageId: 'b', gmailThreadId: 'T', senderInboxId: 'primary' }) },
    { sourceLeadId: 'd7', eventType: 'positive_reply', metadata: JSON.stringify({ gmailMessageId: 'c', gmailThreadId: 'T' }) },
  ];
  const plan = planOfferRetirement({ offerId: 'dental', leads: [lead], activities, archivedBy: 'test', now: NOW, stableId });
  assert.equal(plan.summary.providerMessageIds, 3);
  assert.equal(plan.summary.providerThreadIds, 1);
  assert.equal(plan.summary.conversations, 1);
  assert.equal(plan.summary.gmailOwned, 1);
});

// ── 8/9. restore ────────────────────────────────────────────────────────────

test('8. restoring never makes a lead sendable: unsent returns to Import, sent returns to Review under MANUAL HOLD', () => {
  // A non-dental lead, so only the archive and restore rules are in play.
  const unsent = archived(staffingLead({ stage: 'Queued', emailStatus: 'draft' }), ARCHIVE_REASONS.MANUAL);
  const restoredUnsent = planLeadRestore(unsent, { restoredBy: 'test', now: NOW, stableId });
  assert.equal(restoredUnsent.patch.stage, 'Import');
  assert.equal(restoredUnsent.patch.emailStatus, '', 'a parked draft status is cleared so the queue checks apply again');
  assert.equal(isArchivedLead({ ...unsent, ...restoredUnsent.patch }), false);
  // Import is not Queued: selection requires an explicit, fully checked re-queue.
  assert.notEqual(restoredUnsent.patch.stage, 'Queued');

  const sent = archived(staffingLead({ stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
    lastEmailedAt: new Date(NOW - 10 * DAY).toISOString() }), ARCHIVE_REASONS.MANUAL);
  const restoredSent = planLeadRestore(sent, { restoredBy: 'test', now: NOW, stableId });
  assert.equal(restoredSent.patch.stage, 'Review');
  assert.ok(restoredSent.patch.notes.startsWith('[MANUAL HOLD]'));
  const after = { ...sent, ...restoredSent.patch };
  assert.equal(sendSuppressionReason(after), '[MANUAL HOLD]');
  assert.equal(deriveAutomationOwnership(after, { sendingEnabled: true, coldCadenceDue: true }).sendAllowed, false);
  assert.ok(NON_COLD_STAGES.includes('review'));
  assert.equal(restoredSent.metadata.sendableAfterRestore, false);
});

test('9. a restored dental lead stays unable to send while the dental offer is retired', async () => {
  const lead = archived(legacyDental());
  const plan = planLeadRestore(lead, { restoredBy: 'test', now: NOW, stableId });
  const restored = { ...lead, ...plan.patch, notes: removeArchiveMarker(plan.patch.notes).replace('[MANUAL HOLD]', '').trim() };
  // Even with the hold removed by hand, the offer gate still refuses.
  assert.equal(isArchivedLead(restored), false);
  assert.equal(plan.metadata.offerRetired, true);
  assert.equal(routedLeadReady(restored).code, 'offer_retired');
  const verdict = await freshGate(restored, { ...restored, stage: 'Contacted' });
  assert.equal(verdict.code, 'offer_retired');
});

// ── 10. staffing is unchanged ───────────────────────────────────────────────

test('10. staffing routing, ownership and the final gate are exactly as before', async () => {
  const lead = staffingLead();
  assert.equal(outreachBlockForLead(lead), null);
  assert.equal(routedLeadReady(lead, STAFFING_ENV).ok, true);
  const ownership = deriveAutomationOwnership(lead, { sendingEnabled: true, coldCadenceDue: true });
  assert.equal(ownership.owner, OWNER.COLD_AUTOMATION);
  assert.equal(ownership.sendAllowed, true);
  const verdict = await freshGate(lead, lead);
  assert.equal(verdict.allowed, true);
  assert.equal(deriveAutomationState(lead).state, AUTOMATION_STATES.ACTIVE);
  // Staffing reply automation is still owned by reply automation.
  const replied = deriveAutomationOwnership({ ...lead, emailStatus: 'replied' }, { boardLead: { stage: 'hot' }, sendingEnabled: true,
    replyResponseDecision: { send: true, action: 'AUTO_STAFFING_QUALIFIED' } });
  assert.equal(replied.owner, OWNER.REPLY_AUTOMATION);
});

// ── 11/12. idempotency ──────────────────────────────────────────────────────

test('11. archiving an archived lead is a no-op, and the event id is deterministic', () => {
  const lead = routedDental();
  const first = planLeadArchive(lead, { reason: 'offer_retired_dental', archivedBy: 'a', now: NOW, stableId });
  const again = planLeadArchive(lead, { reason: 'offer_retired_dental', archivedBy: 'b', now: new Date(NOW.getTime() + DAY), stableId });
  assert.equal(first.event.eventId, again.event.eventId, 'a rerun before the write lands re-uses the same event id');
  assert.equal(planLeadArchive({ ...lead, ...first.patch }, { reason: 'offer_retired_dental', archivedBy: 'a', now: NOW, stableId }), null);
  assert.equal(addArchiveMarker(first.patch.notes, 'offer_retired_dental'), first.patch.notes, 'the marker is never doubled');
  // After a restore the next archive is a new generation with its own event.
  const restoreEvent = { sourceLeadId: lead.id, eventType: 'lead_restored', occurredAt: NOW.toISOString(), metadata: '{}' };
  const reArchived = planLeadArchive(lead, { reason: 'offer_retired_dental', archivedBy: 'a', now: NOW, stableId, activities: [restoreEvent] });
  assert.notEqual(reArchived.event.eventId, first.event.eventId);
});

test('12. running the dental migration twice archives nothing new and plans no duplicate events', () => {
  const leads = [routedDental(), legacyDental(), staffingLead({ id: 'staff-1' }),
    routedDental({ id: 'd-held', email: 'held@x.test', notes: '[MANUAL HOLD] human owns it', stage: 'Promoted', emailStatus: 'emailed', emailStep: '1' })];
  const board = [{ id: 'CE-d-legacy', email: 'info@fvortho.test', stage: 'follow_up', notes: '' },
    { id: 'board-only', email: 'dr@pediatric.test', tradeType: 'Dentist', stage: 'follow_up', notes: 'opened proposal' },
    { id: 'CE-staff-1', email: leads[2].email, stage: 'hot', notes: '' }];
  const first = planOfferRetirement({ offerId: 'dental', leads, activities: [], boardLeads: board, archivedBy: 'test', now: NOW, stableId });
  assert.equal(first.summary.total, 3, 'the staffing lead is not dental');
  assert.equal(first.leadPlans.length, 3);
  assert.deepEqual(first.boardPlans.map(plan => [plan.cardId, plan.matchedBy]).sort(),
    [['CE-d-legacy', 'coldemail_id'], ['board-only', 'card_fields']]);
  assert.equal(first.summary.held, 1, 'held leads are archived too, and counted');
  // Apply the plans exactly as the server does, then plan again.
  const applied = leads.map(lead => {
    const plan = first.leadPlans.find(item => item.leadId === lead.id);
    return plan ? { ...lead, ...plan.patch } : lead;
  });
  const appliedBoard = board.map(card => {
    const plan = first.boardPlans.find(item => item.cardId === card.id);
    return plan ? { ...card, ...plan.patch } : card;
  });
  const events = [...first.leadPlans, ...first.boardPlans].map(plan => plan.event);
  const second = planOfferRetirement({ offerId: 'dental', leads: applied, activities: events,
    boardLeads: appliedBoard.filter(card => !isArchivedLead(card)), archivedBoardLeads: appliedBoard.filter(isArchivedLead),
    archivedBy: 'test', now: new Date(NOW.getTime() + DAY), stableId });
  assert.equal(second.leadPlans.length, 0);
  assert.equal(second.boardPlans.length, 0);
  assert.equal(second.summary.archived, 3);
  assert.equal(second.summary.active, 0);
  assert.equal(second.summary.sendable, 0);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length, 'every event id is unique');
  // The server appends only events whose id it has not seen.
  assert.match(serverSrc, /async function appendMissingEvents\(events, activities\) \{\n  const known = new Set\(\(activities \|\| \[\]\)\.map\(row => row\.eventId\)\);/);
  // The staffing lead and its card are untouched.
  assert.deepEqual(applied[2], leads[2]);
  assert.deepEqual(appliedBoard[2], board[2]);
});

test('the migration counts the dry-run categories the operator reviews', () => {
  const leads = [
    routedDental({ id: 'q1', email: 'q1@x.test' }),
    routedDental({ id: 'q2', email: 'q2@x.test', emailStatus: 'draft' }),
    legacyDental({ id: 'f1', email: 'f1@x.test' }),
    legacyDental({ id: 'r1', email: 'r1@x.test', stage: 'Review', emailStatus: 'replied' }),
    legacyDental({ id: 'u1', email: 'u1@x.test', stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed]' }),
  ];
  const plan = planOfferRetirement({ offerId: 'dental', leads, archivedBy: 'dry_run', now: NOW, stableId,
    unresolvedByLead: new Map([['f1', [{ actionId: 'gmail-cold:f1:step:2', status: 'sent_unconfirmed' }]]]) });
  assert.equal(plan.summary.total, 5);
  assert.equal(plan.summary.queued, 2);
  assert.equal(plan.summary.draftOrImport, 2);
  assert.equal(plan.summary.alreadySent, 3);
  assert.equal(plan.summary.followUpsDue, 1);
  assert.equal(plan.summary.conversations, 1);
  assert.equal(plan.summary.suppressed, 1);
  assert.equal(plan.summary.reservations, 1);
  assert.equal(plan.summary.sendable, 0, 'with the retirement live nothing dental is sendable, archived or not');
  // An unresolved reservation is preserved as evidence on the archive record, never reconciled.
  const f1 = plan.leadPlans.find(item => item.leadId === 'f1');
  assert.deepEqual(f1.metadata.unresolved, [{ actionId: 'gmail-cold:f1:step:2', status: 'sent_unconfirmed' }]);
});

// ── canonical writes: sticky marker, sticky stage, restore release ──────────

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
function canonical(row) {
  const db = createPostgrestDouble({ secret: SECRET, rows: [{ lead_id: 'ce-1', revision: 1, ...row }] });
  return { db, start: () => db.start({ SUPABASE_OUTREACH_WRITES: 'supabase', SUPABASE_OUTREACH_MODE: 'primary' }) };
}

test('the archive marker is a protected safety marker that only the restore may release', () => {
  assert.ok(SAFETY_NOTE_MARKERS.includes(ARCHIVE_MARKER_PREFIX));
  const kept = preserveSafetyMarkers('[ARCHIVED: offer_retired_dental] old', 'new note');
  assert.deepEqual(kept.kept, ['[ARCHIVED: offer_retired_dental]']);
  const released = preserveSafetyMarkers('[ARCHIVED: offer_retired_dental] old', 'old', { releaseMarkers: [ARCHIVE_MARKER_PREFIX] });
  assert.deepEqual(released.kept, []);
  // Releasing the archive never releases an opt-out.
  const optOut = preserveSafetyMarkers('[ARCHIVED: x] [REPLY: Unsubscribed]', '', { releaseMarkers: [ARCHIVE_MARKER_PREFIX] });
  assert.deepEqual(optOut.kept, ['[REPLY: Unsubscribed]']);
});

test('an observer write cannot walk an archived lead out of Archived; its protective evidence still lands', async () => {
  const { db, start } = canonical({ stage: 'Archived', email_status: 'emailed', notes: '[ARCHIVED: offer_retired_dental] note' });
  const env = await start();
  try {
    // What handleUnsubscribe writes for a lead that opted out.
    const result = await applyCanonicalChange('ce-1', { stage: 'Unsub', emailStatus: 'done',
      notes: '[REPLY: Unsubscribed] note' }, { env, logger: quiet });
    assert.equal(result.ok, true);
    assert.equal(result.stage, 'Archived');
    const row = db.row('ce-1');
    assert.equal(row.stage, 'Archived', 'the stage stays Archived');
    assert.equal(row.email_status, 'done', 'the opt-out status lands');
    assert.ok(row.notes.includes('[REPLY: Unsubscribed]') && row.notes.includes('[ARCHIVED: offer_retired_dental]'));
  } finally { await db.stop(); }
});

test('the restore releases the marker and moves the stage under compare-and-set; a stale restore is refused', async () => {
  const { db, start } = canonical({ stage: 'Archived', email_status: 'emailed', email_step: '1',
    last_emailed_at: '2026-09-01T00:00:00.000Z', notes: '[ARCHIVED: manual_archive] note', lead_niche: 'industrial_staffing' });
  const env = await start();
  try {
    const writes = [];
    const sheets = { spreadsheets: { values: { batchUpdate: async args => { writes.push(args.requestBody.data); return {}; } } } };
    const lead = { id: 'ce-1', stage: 'Archived', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-09-01T00:00:00.000Z',
      notes: '[ARCHIVED: manual_archive] note', leadNiche: 'industrial_staffing' };
    const plan = planLeadRestore(lead, { restoredBy: 'test', now: NOW, stableId });
    // Without the release, the stage and marker both hold.
    const blocked = await applyLeadChanges([{ leadId: 'ce-1', row: 2, patch: plan.patch, expectedState: plan.expectedState }],
      { sheetsClient: sheets, spreadsheetId: 'x', env, logger: quiet });
    assert.equal(blocked.results[0].status, 'succeeded');
    assert.equal(db.row('ce-1').stage, 'Archived');
    assert.ok(archiveReasonFromNotes(db.row('ce-1').notes));
    // The restore declares the release: marker gone, stage Review, hold on.
    const current = { ...lead, notes: db.row('ce-1').notes };
    const real = planLeadRestore(current, { restoredBy: 'test', now: NOW, stableId });
    const restored = await applyLeadChanges([{ leadId: 'ce-1', row: 2, patch: real.patch, expectedState: real.expectedState,
      releaseMarkers: [ARCHIVE_MARKER_PREFIX] }], { sheetsClient: sheets, spreadsheetId: 'x', env, logger: quiet });
    assert.equal(restored.results[0].status, 'succeeded');
    assert.equal(db.row('ce-1').stage, 'Review');
    assert.equal(archiveReasonFromNotes(db.row('ce-1').notes), null);
    assert.ok(db.row('ce-1').notes.startsWith('[MANUAL HOLD]'));
    // A second restore from the stale plan is refused on expectedState.
    const stale = await applyLeadChanges([{ leadId: 'ce-1', row: 2, patch: real.patch, expectedState: real.expectedState,
      releaseMarkers: [ARCHIVE_MARKER_PREFIX] }], { sheetsClient: sheets, spreadsheetId: 'x', env, logger: quiet });
    assert.ok(['refused', 'unchanged'].includes(stale.results[0].status));
  } finally { await db.stop(); }
});

test('archiving under compare-and-set refuses a lead that moved since the plan was made', async () => {
  const { db, start } = canonical({ stage: 'Queued', email_status: '', notes: '', lead_niche: 'dental' });
  const env = await start();
  try {
    const lead = { id: 'ce-1', stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', senderInboxId: '', notes: '', leadNiche: 'dental' };
    const plan = planLeadArchive(lead, { reason: 'offer_retired_dental', archivedBy: 'test', now: NOW, stableId });
    db.row('ce-1').email_status = 'emailed';   // a send landed after the snapshot
    const sheets = { spreadsheets: { values: { batchUpdate: async () => ({}) } } };
    const result = await applyLeadChanges([{ leadId: 'ce-1', row: 2, patch: plan.patch, expectedState: plan.expectedState }],
      { sheetsClient: sheets, spreadsheetId: 'x', env, logger: quiet });
    assert.equal(result.results[0].status, 'refused');
    assert.equal(db.row('ce-1').stage, 'Queued', 'a stale plan never overwrites concurrent activity');
  } finally { await db.stop(); }
});

// ── Replies, intent, calendar, stage sequences ──────────────────────────────

test('a reply from an archived lead is recorded but never promotes, answers, drafts or requeues', () => {
  const branch = agentSrc.slice(agentSrc.indexOf('// An ARCHIVED lead\'s reply is evidence, never a trigger.'),
    agentSrc.indexOf('// A managed client\'s reply never reaches ScaleLab\'s answer'));
  assert.match(branch, /if \(isArchivedLead\(lead\)\) \{/);
  assert.match(branch, /handleArchivedLeadReply\(lead, message, replyText, activitiesForCycle \|\| \[\], \{ historical \}\)/);
  assert.match(branch, /continue;\n    \}\n\s*$/);
  const handler = agentSrc.slice(agentSrc.indexOf('async function handleArchivedLeadReply'), agentSrc.indexOf('async function handleNeedsHuman'));
  for (const forbidden of ['handleInterested', 'handlePositiveAutomation', 'handleQuestion', 'queueDraft', 'sendEmail',
    'deliverHardenedWarmReply', 'stage:', 'emailStatus:']) {
    assert.ok(!handler.includes(forbidden), `the archived-reply handler must not use ${forbidden}`);
  }
  assert.match(handler, /addSuppression\(lead\.email/, 'an opt-out is still honoured');
  // The branch sits before every send-capable handler in the reply loop.
  assert.ok(agentSrc.indexOf('if (isArchivedLead(lead)) {') < agentSrc.indexOf('case REPLY_ROUTE.INTERESTED:'));
});

test('archived and retired leads never arm the demo-intent backstop or get a booking link', () => {
  const plays = [];
  const lead = archived(staffingLead({ id: 'arch' }), ARCHIVE_REASONS.MANUAL);
  const activities = [{ sourceLeadId: 'arch', leadId: 'CE-arch', eventType: 'demo_pair_played', occurredAt: '2026-09-29T10:00:00Z',
    metadata: JSON.stringify({ introPlays: 1, demoPlays: 1 }) }];
  assert.equal(pendingIntentWork({ leads: [lead, legacyDental({ id: 'dd' })], plays, activities, companyKey: v => v }), 0);
  const prepare = agentSrc.slice(agentSrc.indexOf('async function prepareDemoIntentCandidates'), agentSrc.indexOf('async function reportIntentWorkHint'));
  assert.equal((prepare.match(/outreachBlockForLead\(lead\)/g) || []).length, 2, 'both pair creation and due selection skip them');
});

test('a booking by an archived lead is surfaced for review and never blocks automation', async () => {
  const applied = [];
  const result = await runGoogleCalendarSync({
    enabled: true, calendarId: 'cal', appointmentScheduleId: 'sched',
    readState: async () => ({ syncToken: 'tok' }), writeState: async () => {},
    fetchChanges: async () => ({ ok: true, complete: true, events: [{ id: 'evt1' }], nextSyncToken: 'tok2' }),
    loadContext: async () => ({}),
    planBookings: async () => [{ classified: { event: { providerEventId: 'evt1' } }, outcome: 'archived',
      reason: 'this booking belongs to an archived lead; it was not applied and the lead was not reactivated' }],
    applyPlan: async item => { applied.push(item); return { ok: true }; },
    logger: quiet,
  });
  assert.equal(result.ok, true, 'the sync completes, so every automation launch may proceed');
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(applied.length, 0, 'nothing is applied to the archived lead');
  assert.deepEqual(result.review.map(item => item.outcome), ['archived']);
  assert.match(serverSrc, /if \(isArchivedLead\(identity\.coldEmailLead\) \|\| isArchivedLead\(identity\.boardLead\)\) \{\n      plan\.push\(\{ classified, outcome: 'archived'/);
});

test('stage sequences skip archived cards and retired-offer twins before any provider work', () => {
  assert.match(agentSrc, /if \(staffingSendBlockReason\(twin \|\| boardLead\)\) continue;\n    if \(outreachBlockForLead\(boardLead\) \|\| \(twin && outreachBlockForLead\(twin\)\)\) continue;/);
  const card = { id: 'b1', stage: 'archived', notes: '[ARCHIVED: offer_retired_dental]', tradeType: 'Dentist' };
  assert.equal(outreachBlockForLead(card).code, 'archived');
  assert.equal(deriveAutomationOwnership(staffingLead(), { boardLead: card, sendingEnabled: true }).blockedBy, BLOCKED_BY.ARCHIVED);
});

// ── server wiring ───────────────────────────────────────────────────────────

test('every lead-mutating route refuses an archived lead; evidence-recording routes stay open', () => {
  for (const route of [
    "app.put('/api/leads/:id', requireAuth, rejectArchived('board')",
    "app.delete('/api/leads/:id', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/reactivate', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/resume-automation', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/contact-change', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/sequence', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/call-lifecycle', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/close', requireAuth, rejectArchived('board')",
    "app.post('/api/leads/:id/mark-ghosted', requireAuth, rejectArchived('board')",
    "app.patch('/api/leads/:id/call-details', requireAuth, rejectArchived('board')",
    "app.patch('/api/coldemail/:id/stage', requireAuth, rejectArchived('coldemail')",
    "app.put('/api/coldemail/:id', requireAuth, rejectArchived('coldemail')",
    "app.delete('/api/coldemail/:id', requireAuth, rejectArchived('coldemail')",
    "app.post('/api/coldemail/:id/promote', requireAuth, rejectArchived('coldemail')",
  ]) assert.ok(serverSrc.includes(route), route);
  assert.ok(serverSrc.includes("app.post('/api/leads/:id/human-response', requireAuth, async"), 'recording a human reply stays possible');
  assert.ok(serverSrc.includes("app.post('/api/leads/:id/reply-override', requireAuth, async"));
});

// Lift the pure archive-list helpers out of server.js and run them.
function liftArchiveHelpers() {
  const start = serverSrc.indexOf('function archivedStateFor(');
  const end = serverSrc.indexOf("app.get('/api/archive'");
  const body = serverSrc.slice(start, end).replace(/function rejectArchived[\s\S]*?\n\}\n/, '')
    .replace(/async function unresolvedReservationsByLead[\s\S]*?\n\}\n/, '');
  const helpers = { isArchivedLead, archiveReasonFromNotes, retiredOfferBlock, currentArchiveRecord,
    ARCHIVE_EVENT_TYPE: 'lead_archived', ARCHIVED_REPLY_EVENT_TYPE: 'archived_reply_observed',
    ARCHIVE_REASON_LABELS: archive.ARCHIVE_REASON_LABELS,
    normalizeEmail: value => String(value || '').trim().toLowerCase(),
    campaignLabelFor: lead => lead.campaign || '', normalizedRouteNicheFor: lead => (lead.leadNiche || (retiredOfferFor(lead) ? 'dental' : '')) };
  return new Function(...Object.keys(helpers), `${body}\nreturn { archivedStateFor, archiveListRows, filterArchiveRows, archiveFacets };`)(...Object.values(helpers));
}

test('the Archive list shows contact, company, campaign, previous stage, sender, reason and date, with filters', () => {
  const { archiveListRows, filterArchiveRows, archiveFacets, archivedStateFor } = liftArchiveHelpers();
  const lead = routedDental({ stage: 'Contacted', emailStatus: 'emailed', senderInboxId: 'tryscalelabai' });
  const plan = planLeadArchive(lead, { reason: 'offer_retired_dental', archivedBy: 'deins', source: 'offer_retirement', now: NOW, stableId });
  const archivedLead = { ...lead, ...plan.patch };
  const boardOnly = { id: 'board-only', first: 'Phoebe', last: 'Tsang', company: 'Pediatric Dentist', email: 'p@x.test', tradeType: 'Dentist',
    stage: 'archived', notes: '[ARCHIVED: offer_retired_dental] opened proposal' };
  const boardPlanEvent = planBoardArchive({ ...boardOnly, stage: 'follow_up', notes: 'opened proposal' },
    { reason: 'offer_retired_dental', archivedBy: 'deins', now: NOW, stableId }).event;
  const dataset = {
    leads: [archivedLead], activities: [plan.event, boardPlanEvent],
    archivedRows: [{ id: lead.id, company: lead.company, contactName: lead.contactName, email: lead.email,
      senderInboxId: 'tryscalelabai', campaignVersion: 'dental_v3_pay_per_booking', replyCategory: 'negative', archived: true }],
    archivedBoardLeads: [boardOnly],
  };
  const rows = archiveListRows(dataset, new Map());
  assert.equal(rows.length, 2);
  const row = rows.find(item => item.id === lead.id);
  for (const [field, value] of Object.entries({ contactName: 'Dr. Aya', company: 'Maple Smile Dentistry', campaign: 'Ontario List',
    previousStage: 'Contacted', senderInboxId: 'tryscalelabai', archiveReason: 'offer_retired_dental',
    archiveReasonLabel: 'Dental offer retired', archivedAt: NOW.toISOString(), archivedBy: 'deins', offerRetired: true })) {
    assert.equal(row[field], value, field);
  }
  const card = rows.find(item => item.id === 'board-only');
  assert.equal(card.kind, 'board');
  assert.equal(card.previousStage, 'follow_up');
  assert.equal(filterArchiveRows(rows, { search: 'maple' }).length, 1);
  assert.equal(filterArchiveRows(rows, { reason: 'offer_retired_dental' }).length, 2);
  assert.equal(filterArchiveRows(rows, { previousStage: 'Contacted' }).length, 1);
  assert.equal(filterArchiveRows(rows, { sender: 'tryscalelabai' }).length, 1);
  assert.equal(filterArchiveRows(rows, { niche: 'dental' }).length, 2);
  assert.equal(filterArchiveRows(rows, { archivedFrom: '2026-10-01' }).length, 0);
  assert.equal(filterArchiveRows(rows, { archivedFrom: '2026-09-30', archivedTo: '2026-09-30' }).length, 2);
  assert.equal(archiveFacets(rows).reasons.offer_retired_dental, 2);
  assert.deepEqual(archivedStateFor(dataset, lead.id, 'coldemail'), { reason: 'offer_retired_dental' });
  assert.deepEqual(archivedStateFor(dataset, `CE-${lead.id}`, 'board'), { reason: 'offer_retired_dental' });
  assert.deepEqual(archivedStateFor(dataset, 'board-only', 'board'), { reason: 'offer_retired_dental' });
  assert.equal(archivedStateFor({ leads: [staffingLead({ id: 'live' })], archivedBoardLeads: [] }, 'live', 'coldemail'), null);
});

test('the migration endpoint is bounded, reviewed, outside send windows and holds the launch slot', () => {
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/ops/offer-retirement/:offerId'"),
    serverSrc.indexOf("app.post('/api/archive/leads/:id'"));
  assert.match(route, /const blocked = archiveMutationBlocked\(\);/);
  assert.match(route, /automationLaunchReserved = true;/);
  assert.match(route, /Number\(req\.body\?\.expectedLeads\) !== plan\.leadPlans\.length/);
  assert.match(route, /Math\.min\(ARCHIVE_BATCH_MAX,/);
  assert.match(route, /appendMissingEvents\(batch\.map\(item => item\.event\)/);
  assert.match(route, /finally \{\n    archiveRunInFlight = false;\n    automationLaunchReserved = false;/);
  for (const forbidden of ['withOutboundReservation', 'sendEmail', 'messages.send', 'spawnAgent', 'runSenderRebalance']) {
    assert.ok(!route.includes(forbidden), `the migration must not use ${forbidden}`);
  }
  const blocked = serverSrc.slice(serverSrc.indexOf('function archiveMutationBlocked'), serverSrc.indexOf('async function loadArchiveInputs'));
  assert.match(blocked, /insideSendWindow\(\)/);
  assert.match(blocked, /agentState\.running \|\| automationLaunchReserved/);
});

test('the Archive workspace is a top-level section with its own count and no send controls', () => {
  const nav = require('../integrations/clients/navigation');
  assert.ok(nav.WORKSPACE_IDS.includes('archive'));
  assert.match(browserSrc, /data-workspace="archive"/);
  const panel = browserSrc.slice(browserSrc.indexOf('id="archive-detail-overlay"'));
  const drawer = panel.slice(0, panel.indexOf('</div>\n</div>'));
  for (const forbidden of ['openManualPromotion', 'queueSelected', 'btn-promote', 'Resume automation']) {
    assert.ok(!drawer.includes(forbidden), `the archived-lead drawer must not offer ${forbidden}`);
  }
  assert.match(browserSrc, /fetch\('\/api\/archive\?/);
  assert.match(browserSrc, /renderActivityTimeline\(data\.activities, 'ar-d-activity'\)/);
});

// ── Phase 7: system-wide exclusion ──────────────────────────────────────────

test('no sequence may attach to an archived lead or a retired-offer lead', () => {
  const { sequenceAllowedForLead } = require('../integrations/stage-sequences');
  for (const id of ['hot_stale_v1', 'demo_follow_up_v1', 'industrial_staffing_cold', 'generic_follow_up_v1']) {
    assert.equal(sequenceAllowedForLead(id, archived(staffingLead(), ARCHIVE_REASONS.MANUAL)).code, 'archived', id);
    assert.equal(sequenceAllowedForLead(id, legacyDental()).code, 'offer_retired', id);
  }
  assert.equal(sequenceAllowedForLead('industrial_staffing_cold', staffingLead()).ok, true, 'staffing unchanged');
});

test('operational views count active leads; historical funnels say they include archived ones', () => {
  const healthCalls = serverSrc.match(/buildCrmHealth\(\{\s*leads:\s*activeLeadsOf\(dataset\)/g) || [];
  assert.equal(healthCalls.length, 2, 'both CRM Health builders use active leads');
  assert.ok(!/buildCrmHealth\(\{\s*leads:\s*dataset\.leads/.test(serverSrc));
  assert.match(serverSrc, /scope: \{ historical: true, includesArchived: true, archivedLeads: /);
  const routes = readSource(path.join('integrations', 'clients', 'routes.js'));
  assert.match(routes, /const activeLeads = dataset => \(dataset\.leads \|\| \[\]\)\.filter\(lead => !isArchivedLead\(lead\)\);/);
  for (const view of ["'/:clientId/overview'", "'/:clientId/leads'", "'/:clientId/pipeline'", "'/:clientId/inbox'"]) {
    const body = routes.slice(routes.indexOf(view), routes.indexOf('router.', routes.indexOf(view) + 10));
    assert.match(body, /activeLeads\(dataset\)/, view);
  }
  // Identity checks keep every lead: an archived address is still a duplicate.
  assert.match(routes, /existingLeads: dataset\.leads \|\| \[\]/);
});

test('an archived lead is never promoted back onto the board by a reply, a late reply or a booking', () => {
  const { promotionDecision, PROMOTION_TRIGGER, resolvePromotionIdentity } = require('../integrations/promotion-policy');
  const lead = archived(legacyDental({ stage: 'Archived' }));
  for (const trigger of [PROMOTION_TRIGGER.POSITIVE_REPLY, PROMOTION_TRIGGER.LATE_POSITIVE_REPLY, PROMOTION_TRIGGER.MEETING_BOOKED]
    .filter(Boolean)) {
    const decision = promotionDecision({ trigger, targetStage: 'hot', coldEmailLead: lead,
      identity: resolvePromotionIdentity(lead, [], { coldEmailTwinCount: 1 }), meetingAt: '2026-10-05T17:00:00.000Z', suppressedEmails: new Set() });
    assert.equal(decision.shouldPromote, false, String(trigger));
  }
});
