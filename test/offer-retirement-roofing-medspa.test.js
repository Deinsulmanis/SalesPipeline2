'use strict';

// Roofing and med spa retired (2026-09-30) with the same machinery as dental,
// and two Closed/Won clients — Trade Select and SureSky Roofing — that no part
// of the retirement may touch. Shapes are production's (read-only audit of the
// same day). Nothing here contacts Google, Gmail or Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  retiredOfferFor, outreachBlockForLead, isArchivedLead, isProtectedRecord, PROTECTED_RECORDS,
  planLeadArchive, planBoardArchive, planLeadRestore, addArchiveMarker, archiveReasonFromNotes,
  ARCHIVE_REASONS, ARCHIVE_MARKER_PREFIX,
} = require('../integrations/lead-archive');
const { planOfferRetirement, verifyProtectedRecords, sendableNow } = require('../integrations/offer-retirement');
const { routedLeadReady, validateRoute, templateById } = require('../integrations/campaign-routing');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { googleRecipient } = require('../test-support/google-recipient');
const { deriveAutomationOwnership, OWNER, BLOCKED_BY } = require('../integrations/automation-ownership');
const { planSenderRebalance } = require('../integrations/sender-balance');
const { sequenceAllowedForLead } = require('../integrations/stage-sequences');
const { promotionDecision, PROMOTION_TRIGGER, resolvePromotionIdentity } = require('../integrations/promotion-policy');
const { CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');
const { createPostgrestDouble } = require('../test-support/postgrest-double');
const { applyCanonicalChange } = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const stableId = (prefix, parts) => `${prefix}:${crypto.createHash('sha1')
  .update(parts.map(value => String(value || '')).join('|')).digest('hex').slice(0, 24)}`;
const quiet = { log() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-30T23:30:00.000Z');
const STAFFING_ENV = Object.freeze({ STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' });
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true', ...STAFFING_ENV,
});
const gate = (snapshot, current = snapshot, purpose = 'cold') => guardProviderSend(snapshot,
  { env: SEND_ENV, classifyRecipient: googleRecipient, loadFreshState: async () => ({ current, suppressedEmails: new Set() }) }, { purpose });

// ── production shapes ───────────────────────────────────────────────────────
const TRADE_SELECT = Object.freeze({ id: 'mq4vq4pw2t0w6u6qwmp', type: 'trade', first: 'christopher', last: 'cook',
  company: 'tradeselect', tradeType: 'Roofer', stage: 'closed_won', email: '360estimates@gmail.com',
  notes: 'text on the 8th to confirm payment, said check will clear wednesday morning.', meetingAt: '', outcome: '' });
const SURESKY = Object.freeze({ id: 'mq3i7yq86ri0ueadqtl', type: 'trade', first: 'marman', last: 'xxx',
  company: 'suresky.inc', tradeType: 'Roofer', stage: 'closed_won', email: 'xxx@xx', phone: '587 501 4389',
  notes: 'called him a week ago, seemed to say yes to everything', meetingAt: '', outcome: '' });
const ALLIED = Object.freeze({ id: 'mq3i5pbt1quywgesayc', type: 'trade', first: 'Craig', company: 'Allied', tradeType: 'Roofer',
  stage: 'lost', email: 'alliedroofingadneexteriors@gmail.com', notes: 'called on monday' });
const PEST = Object.freeze({ id: 'mqkcqtgu60kx962en8x', company: 'Ok Pest Control', tradeType: 'Pest Control', stage: 'lost',
  email: 'info@okpest.ca', notes: 'call went good' });
const GLAMORE_CARD = Object.freeze({ id: 'mskwbod7auzmbjvcxas', company: 'Glamore Beauty Bar Skin & Laser Clinic', tradeType: '',
  stage: 'follow_up', email: 'info@glamorebeautybar.com', notes: 'emailed me twice' });
const board = () => [TRADE_SELECT, SURESKY, ALLIED, PEST, GLAMORE_CARD].map(card => ({ ...card }));

const roofingLead = (extra = {}) => ({
  id: 'r-1', company: 'Victoria Roof Pros', contactName: '', email: 'info@vicroof.test', city: 'Victoria',
  tradeType: 'Roofing contractor', stage: 'Import', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '',
  leadNiche: 'roofing', senderInboxId: '', emailTemplateId: '', routingRequired: 'true', intendedCampaignVersion: '',
  campaign: 'BC Roofing Survey', clientId: 'scalelab', ...extra,
});
const medSpaLead = (extra = {}) => ({
  id: 'm-1', company: 'Lumina Skin Care Centre', contactName: '', email: 'hello@lumina.test', city: 'Kelowna',
  tradeType: 'Medical spa', stage: 'Done', emailStatus: 'done', emailStep: '3', lastEmailedAt: '2026-07-22T15:03:40.084Z',
  notes: '', leadNiche: '', senderInboxId: 'primary', emailTemplateId: '', routingRequired: '', intendedCampaignVersion: '',
  campaign: '', clientId: 'scalelab', ...extra,
});
const followUpDue = lead => ({ ...lead, stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
  lastEmailedAt: new Date(NOW - 10 * DAY).toISOString(), senderInboxId: 'primary' });
let seq = 0;
const staffingLead = (extra = {}) => {
  seq += 1;
  return { id: `s-${seq}`, company: `Staffing Co ${seq}`, contactName: 'Alex', email: `s${seq}@staffing.test`,
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', tradeType: 'B (skilled trades / construction labor)',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    intendedCampaignVersion: STAFFING_CAMPAIGN.id, siteContext: 'Your warehouse staffing team serves local manufacturers.',
    senderInboxId: 'primary', routingRequired: 'true', sheetRow: seq, revision: 1, ...extra };
};

// ── 1–4: retired, and cannot send ──────────────────────────────────────────

for (const [label, make, offerId] of [['roofing', roofingLead, 'roofing'], ['med-spa', medSpaLead, 'med_spa']]) {
  test(`${label}: a normal lead is retired and cannot send by any path`, async () => {
    const lead = make({ stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '' });
    assert.equal(retiredOfferFor(lead).offer.id, offerId);
    assert.equal(routedLeadReady(lead, STAFFING_ENV).code, 'offer_retired');
    for (const purpose of ['cold', 'sequence', 'warm']) assert.equal((await gate(lead, lead, purpose)).code, 'offer_retired', purpose);
    const reply = deriveAutomationOwnership({ ...lead, emailStatus: 'replied' }, { boardLead: { stage: 'hot' }, sendingEnabled: true,
      replyResponseDecision: { send: true, action: 'AUTO_BOOKING_RESPONSE' } });
    assert.equal(reply.owner, OWNER.NONE);
    assert.equal(reply.blockedBy, BLOCKED_BY.OFFER_RETIRED);
    assert.equal(sequenceAllowedForLead('hot_stale_v1', lead).code, 'offer_retired');
    assert.equal(sendableNow(lead, { now: NOW }), false);
  });

  test(`${label}: an overdue follow-up still cannot send after retirement`, async () => {
    const lead = followUpDue(make());
    assert.equal(routedLeadReady(lead, STAFFING_ENV).code, 'offer_retired');
    assert.equal(sendableNow(lead, { now: NOW }), false);
    assert.equal((await gate(lead)).code, 'offer_retired');
    // And once archived, the archive is the named reason.
    const archived = { ...lead, stage: 'Archived', notes: addArchiveMarker('', `offer_retired_${offerId}`) };
    assert.equal((await gate(lead, archived)).code, 'archived');
  });
}

test('roofing and med spa copy and versions can never be selected again', () => {
  assert.equal(templateById('roofing-survey-v1').ready, false);
  assert.match(templateById('roofing-survey-v1').reason, /retired/);
  assert.equal(CAMPAIGN_VERSIONS.roofing_survey_v1_measured.status, 'retired');
  const inboxes = [{ id: 'primary', email: 'p@x.test', sendEligible: true, deliveryImplemented: true }];
  assert.equal(validateRoute({ niche: 'roofing', senderInboxId: 'primary', emailTemplateId: 'roofing-survey-v1', inboxes, requireReady: false }).code, 'offer_retired');
});

test('recognition: canonical fields win; legacy text never retires staffing; company and notes are never read', () => {
  // Every production shape.
  for (const tradeType of ['Roofing contractor', 'electrician', 'Handyman/Handywoman/Handyperson', 'Water damage restoration service']) {
    assert.equal(retiredOfferFor(roofingLead({ tradeType })).offer.id, 'roofing', tradeType);
  }
  assert.equal(retiredOfferFor({ leadNiche: 'roofing', emailTemplateId: 'roofing-survey-v1', campaign: 'Roofing Survey – Owned Test' }).offer.id, 'roofing');
  for (const tradeType of ['Medical spa', 'Med spa', 'Day spa', 'Skin care clinic', 'Laser hair removal service', 'Optometrist', 'Hair salon']) {
    assert.equal(retiredOfferFor(medSpaLead({ tradeType })).offer.id, 'med_spa', tradeType);
  }
  assert.equal(retiredOfferFor(medSpaLead({ tradeType: '', campaign: 'toronto-medspa-jul' })).offer.id, 'med_spa');
  // Staffing with roofing- or spa-sounding text is staffing.
  assert.equal(retiredOfferFor(staffingLead({ tradeType: 'Spa', campaign: 'Roofing crews' })), null);
  assert.equal(retiredOfferFor(staffingLead({ tradeType: 'Roofer' })), null);
  // Company names and notes are never evidence.
  assert.equal(retiredOfferFor({ company: 'Sure Sky Roofing & Med Spa', notes: 'roofing medspa' }), null);
  // Substrings that merely contain the words are not matches.
  for (const tradeType of ['Waterproofing', 'Proofreading service', 'Spa staffing agency', 'Pest Control']) {
    assert.equal(retiredOfferFor({ tradeType }), null, tradeType);
  }
});

// ── 5: sender balance and the refill ────────────────────────────────────────

const SENDERS = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'].map(id => ({
  id, email: `${id}@example.test`, status: 'active', sendEligible: true, credentialConfigured: true,
  dailyLimit: { primary: 60, tryscalelabai: 60, scalelabaiteam: 40, deniels: 20, deniels_tryscalelabai: 20 }[id],
  perRunLimit: 6, ...(id === 'scalelabaiteam' ? { staffingOnly: true } : {}),
}));
const balanceInput = (leads, extra = {}) => ({ leads, activities: [], boardLeads: [], suppressedEmails: new Set(),
  lockedLeadIds: new Set(), senders: SENDERS, horizon: NOW.getTime() + DAY, env: STAFFING_ENV,
  renderOptions: STAFFING_RENDER_OPTIONS, ...extra });

test('5. retired roofing and med spa leads are neither refill supply nor workload', () => {
  const live = Array.from({ length: 150 }, () => staffingLead());
  const retiredQueued = [
    ...Array.from({ length: 40 }, (_, i) => roofingLead({ id: `rq-${i}`, email: `rq${i}@x.test`, stage: 'Queued', senderInboxId: 'primary' })),
    ...Array.from({ length: 40 }, (_, i) => medSpaLead({ id: `mq-${i}`, email: `mq${i}@x.test`, stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', senderInboxId: 'primary' })),
  ];
  const owned = Array.from({ length: 20 }, (_, i) => {
    const lead = followUpDue(medSpaLead({ id: `mf-${i}`, email: `mf${i}@x.test`, senderInboxId: 'deniels' }));
    return { lead: { ...lead, senderInboxId: 'deniels', lastEmailedAt: new Date(NOW - 4 * DAY).toISOString() },
      activity: { sourceLeadId: lead.id, eventType: 'initial_email_sent', metadata: JSON.stringify({ senderInboxId: 'deniels' }) } };
  });
  const plan = planSenderRebalance(balanceInput([...live, ...retiredQueued, ...owned.map(item => item.lead)],
    { activities: owned.map(item => item.activity) }));
  const moved = new Set(plan.moves.map(move => move.leadId));
  for (const lead of retiredQueued) assert.equal(moved.has(lead.id), false, lead.id);
  assert.equal(plan.before.find(row => row.id === 'deniels').followUps, 0, 'retired follow-ups are no inbox\'s workload');
  const baseline = planSenderRebalance(balanceInput(live));
  assert.deepEqual(plan.moves.map(move => [move.leadId, move.to]), baseline.moves.map(move => [move.leadId, move.to]),
    'staffing balancing is identical with or without the retired leads');
});

// ── 6: observers cannot reactivate ──────────────────────────────────────────

test('6. an archived roofing or med spa lead cannot be reactivated by an observer write, a reply or a booking', async () => {
  for (const reason of ['offer_retired_roofing', 'offer_retired_med_spa']) {
    const db = createPostgrestDouble({ secret: 'sb_secret_TESTONLY_not_a_real_key',
      rows: [{ lead_id: 'ce-1', revision: 1, stage: 'Archived', email_status: 'done', notes: `[ARCHIVED: ${reason}] kept` }] });
    const env = await db.start({ SUPABASE_OUTREACH_WRITES: 'supabase', SUPABASE_OUTREACH_MODE: 'primary' });
    try {
      // What the observer's reply and bounce paths write.
      for (const patch of [{ stage: 'Replied', emailStatus: 'replied' }, { stage: 'Unsub', notes: '[REPLY: Unsubscribed] kept' },
        { stage: 'Contacted', emailStatus: 'emailed', notes: 'kept' }]) {
        const result = await applyCanonicalChange('ce-1', patch, { env, logger: quiet });
        assert.equal(result.ok, true);
        assert.equal(db.row('ce-1').stage, 'Archived', JSON.stringify(patch));
        assert.equal(archiveReasonFromNotes(db.row('ce-1').notes), reason, 'the marker survives every write');
      }
    } finally { await db.stop(); }
  }
  const archived = { ...medSpaLead(), stage: 'Archived', notes: addArchiveMarker('', 'offer_retired_med_spa') };
  for (const trigger of [PROMOTION_TRIGGER.POSITIVE_REPLY, PROMOTION_TRIGGER.LATE_POSITIVE_REPLY, PROMOTION_TRIGGER.MEETING_BOOKED]) {
    const decision = promotionDecision({ trigger, targetStage: 'hot', coldEmailLead: archived,
      identity: resolvePromotionIdentity(archived, [], { coldEmailTwinCount: 1 }), meetingAt: '2026-10-05T17:00:00.000Z', suppressedEmails: new Set() });
    assert.equal(decision.shouldPromote, false, trigger);
  }
});

// ── 7–10: the protected clients ────────────────────────────────────────────

test('7/8. Trade Select and SureSky are never planned for archive by the roofing retirement', () => {
  const leads = [roofingLead(), roofingLead({ id: 'r-2', email: 'two@roof.test', stage: 'Unsub', emailStatus: 'done' })];
  const plan = planOfferRetirement({ offerId: 'roofing', leads, boardLeads: board(), archivedBy: 'test', now: NOW, stableId });
  const planned = [...plan.leadPlans.map(item => item.leadId), ...plan.boardPlans.map(item => item.cardId)];
  assert.ok(!planned.includes(TRADE_SELECT.id), 'Trade Select is not planned');
  assert.ok(!planned.includes(SURESKY.id), 'SureSky is not planned');
  assert.deepEqual(plan.boardPlans.map(item => [item.cardId, item.matchedBy]), [[ALLIED.id, 'card_fields']],
    'the other roofing card (Allied, lost) is archived; pest control is untouched');
  assert.equal(plan.summary.protected, 2);
  assert.deepEqual(plan.spared.map(item => item.client).sort(), ['SureSky Roofing', 'Trade Select']);
  assert.deepEqual(plan.protectedRecords.map(item => [item.id, item.stage, item.verified]),
    [[TRADE_SELECT.id, 'closed_won', true], [SURESKY.id, 'closed_won', true]]);
  // The med spa retirement does not reach them either, and archives Glamore through its ColdEmail twin.
  const medSpa = planOfferRetirement({ offerId: 'med_spa', boardLeads: board(), archivedBy: 'test', now: NOW, stableId,
    leads: [medSpaLead({ id: 'mrr045vlve3xmbk4kld', email: 'info@glamorebeautybar.com', campaign: 'toronto-medspa-jul', tradeType: '' })] });
  assert.deepEqual(medSpa.boardPlans.map(item => [item.cardId, item.matchedBy]), [[GLAMORE_CARD.id, 'coldemail_email']]);
});

test('9. a protected client never receives an archive marker, stage change or event', () => {
  for (const card of [TRADE_SELECT, SURESKY]) {
    assert.equal(isProtectedRecord(card), true);
    assert.throws(() => planBoardArchive(card, { reason: 'offer_retired_roofing', archivedBy: 'x', stableId }), /protected client/);
    assert.throws(() => planLeadArchive({ ...card, email: card.email }, { reason: 'manual_archive', archivedBy: 'x', stableId }), /protected client/);
  }
  // Identity is the exact id: a CE- form or a lookalike company is not protected.
  assert.equal(isProtectedRecord({ id: `CE-${TRADE_SELECT.id}` }), false);
  assert.equal(isProtectedRecord({ id: 'other', company: 'tradeselect', email: TRADE_SELECT.email }), false);
  // The manual archive route refuses them before loading anything.
  const server = readSource('server.js');
  const route = server.slice(server.indexOf("app.post('/api/archive/leads/:id', requireAuth"), server.indexOf("app.post('/api/archive/leads/:id/restore'"));
  assert.match(route, /if \(isProtectedRecord\(\{ id: req\.params\.id \}\)\) return res\.status\(409\)/);
});

test('10. protected clients stay Closed/Won and are not governed by the roofing retirement', async () => {
  for (const card of [TRADE_SELECT, SURESKY]) {
    assert.equal(retiredOfferFor(card), null);
    assert.equal(outreachBlockForLead(card), null);
    assert.equal(isArchivedLead(card), false);
    // Ownership is exactly what the card always had (terminal Closed/Won, or
    // SureSky's placeholder address) — never the archive or the retirement.
    const ownership = deriveAutomationOwnership({ ...card, notes: card.notes }, { boardLead: card, sendingEnabled: true });
    assert.ok([BLOCKED_BY.TERMINAL_STAGE, BLOCKED_BY.INVALID_IDENTITY].includes(ownership.blockedBy), ownership.blockedBy);
    assert.ok(![BLOCKED_BY.OFFER_RETIRED, BLOCKED_BY.ARCHIVED].includes(ownership.blockedBy));
  }
  // The board read keeps every card that is not archived.
  assert.match(readSource('server.js'), /res\.json\(req\.query\.archived === 'include' \? leads : leads\.filter\(lead => !isArchivedLead\(lead\)\)\);/);
  // Another card that merely names the same company is retired like any roofer.
  const lookalike = { id: 'lookalike', company: 'tradeselect', tradeType: 'Roofer', stage: 'lost', email: 'other@x.test' };
  assert.equal(retiredOfferFor(lookalike).offer.id, 'roofing');
  const plan = planOfferRetirement({ offerId: 'roofing', leads: [], boardLeads: [...board(), lookalike], archivedBy: 'test', now: NOW, stableId });
  assert.ok(plan.boardPlans.some(item => item.cardId === 'lookalike'), 'a non-protected lookalike is archived');
});

// ── 11/12: staffing and dental unchanged ────────────────────────────────────

test('11. staffing routing, ownership and the final gate are unchanged', async () => {
  const lead = staffingLead();
  assert.equal(retiredOfferFor(lead), null);
  assert.equal(routedLeadReady(lead, STAFFING_ENV).ok, true);
  assert.equal(deriveAutomationOwnership(lead, { sendingEnabled: true, coldCadenceDue: true }).owner, OWNER.COLD_AUTOMATION);
  assert.equal((await gate(lead)).allowed, true);
  assert.equal(sequenceAllowedForLead('industrial_staffing_cold', lead).ok, true);
});

test('12. dental retirement is unchanged', async () => {
  const dental = { id: 'd-1', email: 'x@smile.test', tradeType: 'Dentist', campaign: 'Surrey Dentists', stage: 'Contacted',
    emailStatus: 'emailed', emailStep: '1', notes: '', leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '' };
  assert.equal(retiredOfferFor(dental).offer.id, 'dental');
  assert.deepEqual(retiredOfferFor(dental).signals, ['trade_type', 'campaign']);
  assert.equal((await gate(dental)).code, 'offer_retired');
  const archived = { ...dental, stage: 'Archived', notes: addArchiveMarker('', 'offer_retired_dental') };
  assert.equal(routedLeadReady(archived).code, 'archived');
  // Restoring a retired lead never makes it sendable.
  const restore = planLeadRestore(archived, { restoredBy: 't', now: NOW, stableId });
  assert.equal(restore.metadata.offerRetired, true);
});

// ── 13: idempotent ──────────────────────────────────────────────────────────

test('13. the roofing and med spa migrations are idempotent', () => {
  for (const [offerId, leads] of [['roofing', [roofingLead(), roofingLead({ id: 'r-2', email: 'r2@x.test' })]],
    ['med_spa', [medSpaLead(), medSpaLead({ id: 'm-2', email: 'm2@x.test', campaign: 'Campaign #2', tradeType: 'Dermatologist' })]]]) {
    const cards = board();
    const first = planOfferRetirement({ offerId, leads, boardLeads: cards, archivedBy: 'test', now: NOW, stableId });
    assert.equal(first.leadPlans.length, 2, offerId);
    const applied = leads.map(lead => ({ ...lead, ...(first.leadPlans.find(item => item.leadId === lead.id) || {}).patch }));
    const appliedCards = cards.map(card => ({ ...card, ...(first.boardPlans.find(item => item.cardId === card.id) || {}).patch }));
    const events = [...first.leadPlans, ...first.boardPlans].map(item => item.event);
    const second = planOfferRetirement({ offerId, leads: applied, activities: events,
      boardLeads: appliedCards.filter(card => !isArchivedLead(card)), archivedBoardLeads: appliedCards.filter(isArchivedLead),
      archivedBy: 'test', now: new Date(NOW.getTime() + DAY), stableId });
    assert.equal(second.leadPlans.length + second.boardPlans.length, 0, `${offerId}: a rerun plans nothing`);
    assert.equal(second.summary.active, 0);
    assert.equal(second.summary.sendable, 0);
    assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
    for (const card of [TRADE_SELECT, SURESKY]) {
      assert.deepEqual(appliedCards.find(item => item.id === card.id), { ...card }, `${offerId}: ${card.company} untouched`);
    }
    assert.ok(events.every(event => ![TRADE_SELECT.id, SURESKY.id].includes(event.leadId)), 'no event names a protected client');
  }
});

// ── 14: ambiguous identity fails closed ─────────────────────────────────────

test('14. an ambiguous or moved protected identity stops the whole migration', () => {
  const plan = cards => () => planOfferRetirement({ offerId: 'roofing', leads: [roofingLead()], boardLeads: cards,
    archivedBy: 'test', now: NOW, stableId });
  const others = [ALLIED, PEST];
  assert.throws(plan([SURESKY, ...others]), /Trade Select .* resolves to 0 records/, 'missing');
  assert.throws(plan([TRADE_SELECT, { ...TRADE_SELECT }, SURESKY, ...others]), /resolves to 2 records/, 'duplicated');
  assert.throws(plan([{ ...TRADE_SELECT, stage: 'lost' }, SURESKY, ...others]), /not closed_won/, 'stage moved');
  assert.throws(plan([TRADE_SELECT, { ...SURESKY, company: 'Allied' }, ...others]), /names company "Allied"/, 'company changed');
  assert.throws(plan([{ ...TRADE_SELECT, stage: 'archived', notes: '[ARCHIVED: manual_archive]' }, SURESKY, ...others]), /is archived/);
  // And the dental and med spa migrations are held to the same check.
  assert.throws(() => planOfferRetirement({ offerId: 'med_spa', leads: [], boardLeads: [SURESKY], archivedBy: 't', stableId }), /refusing to plan/);
  assert.deepEqual(verifyProtectedRecords({ boardLeads: board() }).map(item => item.verified), [true, true]);
  assert.deepEqual(PROTECTED_RECORDS.map(record => record.id), [TRADE_SELECT.id, SURESKY.id]);
});

test('retirement source is free of control bytes (a regex word boundary once became a backspace)', () => {
  for (const file of ['integrations/lead-archive.js', 'integrations/offer-retirement.js', 'integrations/campaign-routing.js',
    'integrations/send-safety-revalidate.js', 'integrations/automation-ownership.js', 'outreach-agent.js', 'server.js', 'public/index.html']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source), false, file);
  }
  assert.equal(ARCHIVE_MARKER_PREFIX, '[ARCHIVED');
  assert.deepEqual([ARCHIVE_REASONS.OFFER_RETIRED_ROOFING, ARCHIVE_REASONS.OFFER_RETIRED_MED_SPA], ['offer_retired_roofing', 'offer_retired_med_spa']);
});

test('a lead with a Pipeline card keeps its own archive record (niche and previous stage), not the card\'s', () => {
  const { currentArchiveRecord } = require('../integrations/lead-archive');
  // Production shape: Prestige Medispa — ColdEmail lead promoted, card CE-<id>.
  const lead = medSpaLead({ id: 'mrb95ojro7q94itxr7o', stage: 'Promoted', emailStatus: 'emailed', emailStep: '1' });
  const card = { id: 'CE-mrb95ojro7q94itxr7o', company: 'Prestige Medispa', tradeType: 'Other', stage: 'lost', email: lead.email, notes: '' };
  const leadPlan = planLeadArchive(lead, { reason: 'offer_retired_med_spa', archivedBy: 't', now: NOW, stableId, boardLead: card });
  const cardPlan = planBoardArchive(card, { reason: 'offer_retired_med_spa', archivedBy: 't', now: new Date(NOW.getTime() + 60000), stableId, sourceLeadId: lead.id });
  const record = currentArchiveRecord([leadPlan.event, cardPlan.event], lead.id);
  assert.equal(record.eventId, leadPlan.event.eventId);
  assert.equal(record.previousStage, 'Promoted');
  assert.equal(record.retiredOffer, 'med_spa');
  assert.equal(record.previousBoardStage, 'lost');
});
