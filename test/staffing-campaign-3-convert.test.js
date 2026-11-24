'use strict';

// Industrial Campaign 3 conversion: a never-contacted V1 / Campaign 2 Import-stage
// row becomes a Campaign 3 lead in place (same id, no second row), only through
// the import's own evidence selection, and only when nothing about the lead says
// it was contacted, suppressed, replied, routed or held without owner approval.

const test = require('node:test');
const assert = require('node:assert/strict');

const profileLib = require('../integrations/staffing-v4-profile');
const {
  STAFFING_CAMPAIGN_V4, staffingCampaignFor, staffingV4SendBlock, staffingV2CampaignNotesRefusal,
  setStaffingV4LiveForTests, CAMPAIGN_3_CONVERSION_PREFIX, campaign3ConversionAllowed,
} = require('../integrations/staffing-campaign');
const { hasStaffingHoldMarker } = require('../integrations/staffing-hold');
const { evaluateCampaign3Import, IMPORT_SCHEMA } = require('../integrations/staffing-campaign-3-import');
const { CONVERT_SCHEMA, planCampaign3Conversion, convertCampaign3Leads } = require('../integrations/staffing-campaign-3-convert');

const NOW = () => '2026-11-24T08:00:00.000Z';
const HOLD_V1 = '[STAFFING_HOLD_V1]\n{"version":1,"reason":"REVIEW_REQUIRED","explanation":"Held from Staffing Outreach Campaign 2","evidence":[{"source":"x","detail":"y"}],"reviewedAt":"2026-10-23T07:30:00.000Z","reviewSource":"campaign2-launch-prep","temporary":true,"couldBecomeEligible":true}\n[/STAFFING_HOLD_V1]';
const REVIEW_V1 = '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=NONE_REQUIRED;routing_ready=false]';

const evidence = (extra = {}) => ({
  asOf: '2026-11-24', firstName: 'Dana', company: 'Tradeco Staffing', contactName: 'Dana Smith',
  contactStatus: 'READY_FOR_REVIEW', emailResolved: true, attributionP: null,
  employerAds: [], salesHiring: [], expansion: [], leadership: [], candidateAds: [],
  specialization: { phrase: 'skilled trades', url: 'https://tradecostaffing.com/trades', quote: 'We place welders and electricians.' },
  ...extra,
});
const record = (extra = {}, ev = {}, rowExtra = {}) => ({
  lead_id: 'C2L1',
  row: { company_name: 'Tradeco Staffing', company_domain: 'tradecostaffing.com', email: 'dana@tradecostaffing.com',
    v4_tag: 'V4|PASS|INSUFFICIENT_EVIDENCE|NOT_CHECKED|COPY_TIER_PENDING', demand_score: '0', signal_priority: 'INSUFFICIENT_EVIDENCE',
    ad_class: 'NOT_CHECKED', contact_status: 'READY_FOR_REVIEW', ...rowExtra },
  evidence: evidence(ev),
  ...extra,
});
const payload = (records, extra = {}) => ({ schema: CONVERT_SCHEMA, sourcing_run_id: 'recovery-test', records, owner_approved_send_ready: true, ...extra });
const c2Lead = (extra = {}) => ({
  id: 'C2L1', company: 'Tradeco Staffing', contactName: 'Dana Smith', email: 'dana@tradecostaffing.com', website: '',
  campaign: 'Staffing Outreach Campaign 2', leadNiche: 'industrial_staffing', stage: 'Import',
  emailStatus: '', lastEmailedAt: '', emailStep: '', senderInboxId: '', emailTemplateId: '', intendedCampaignVersion: '',
  notes: 'ScaleLab staged staffing source 2026-10-01', campaign_notes: `${REVIEW_V1}\n${HOLD_V1}`, clientId: 'scalelab', ...extra,
});
const v1Lead = (extra = {}) => c2Lead({ id: 'V1L1', email: 'pat@v1staffingco.com', campaign: 'Industrial Staffing Agency', ...extra });
const plan = (records, leads, extra = {}, corpus = {}) => planCampaign3Conversion(payload(records, extra), { leads, ...corpus }, { now: NOW });

test.afterEach(() => setStaffingV4LiveForTests(null));

test('1. a never-contacted Campaign 2 Import row converts in place to a send-ready Campaign 3 lead', () => {
  setStaffingV4LiveForTests(true);
  const lead = c2Lead();
  const result = plan([record()], [lead]);
  assert.deepEqual(result.refusals, []);
  assert.equal(result.conversions.length, 1);
  const { patch, leadId, expectedState, releaseManualHold } = result.conversions[0];
  assert.equal(leadId, 'C2L1', 'the same lead id: no second row');
  assert.equal(releaseManualHold, false);
  assert.equal(patch.campaign, 'Industrial Campaign 3');
  assert.equal(patch.intendedCampaignVersion, 'industrial_staffing_campaign_3');
  assert.equal(patch.emailTemplateId, 'industrial-staffing-campaign-3');
  assert.equal(patch.routingRequired, 'true');
  assert.equal(patch.website, 'https://tradecostaffing.com', 'a blank website takes the company domain');
  assert.equal(patch.stage, undefined, 'conversion never changes the stage; queueing does');
  assert.equal(patch.senderInboxId, undefined, 'conversion never assigns a sender');
  assert.equal(patch.notes, undefined, 'notes are untouched without a manual hold release');
  const after = { ...lead, ...patch };
  assert.equal(staffingCampaignFor(after), STAFFING_CAMPAIGN_V4);
  assert.equal(staffingV4SendBlock(after), null);
  assert.equal(hasStaffingHoldMarker(after), false, 'the V1 hold record goes with the V1 notes');
  const profile = profileLib.readStaffingV4Profile(after).profile;
  assert.equal(profile.review_status, 'SEND_READY');
  assert.equal(profile.copy_status, 'SELECTED');
  assert.ok(profile.sourcing_run_id.startsWith(CAMPAIGN_3_CONVERSION_PREFIX));
  assert.equal(profile.email, 'dana@tradecostaffing.com');
  assert.deepEqual(expectedState, { campaign: lead.campaign, campaign_notes: lead.campaign_notes, stage: 'Import', emailStep: '', senderInboxId: '' });
});

test('2. a V1 (Industrial Staffing Agency) Import row converts the same way', () => {
  setStaffingV4LiveForTests(true);
  const result = plan([record({ lead_id: 'V1L1' }, {}, { email: 'pat@v1staffingco.com', company_domain: 'v1staffingco.com' })], [v1Lead()]);
  assert.deepEqual(result.refusals, []);
  assert.equal(result.conversions[0].fromCampaign, 'Industrial Staffing Agency');
});

test('3. without owner approval the profile is REVIEW READY, which the send gate keeps out', () => {
  setStaffingV4LiveForTests(true);
  const result = plan([record()], [c2Lead()], { owner_approved_send_ready: false });
  assert.equal(result.conversions.length, 1);
  const after = { ...c2Lead(), ...result.conversions[0].patch };
  assert.equal(profileLib.readStaffingV4Profile(after).profile.review_status, 'REVIEW_READY');
  assert.match(staffingV4SendBlock(after), /REVIEW READY, not SEND READY/);
});

test('4. refuses contacted, routed, past-Import, other-client, profiled, suppressed and replied leads', () => {
  setStaffingV4LiveForTests(true);
  const cases = [
    [c2Lead({ emailStep: '1' }), 'contacted'],
    [c2Lead({ lastEmailedAt: '2026-11-01T15:00:00Z' }), 'contacted'],
    [c2Lead({ emailStatus: 'sent' }), 'contacted'],
    [c2Lead({ senderInboxId: 'primary' }), 'contacted'],
    [c2Lead({ stage: 'Queued' }), 'contacted'],
    [c2Lead({ clientId: 'jole' }), 'ownership_conflict'],
    [c2Lead({ clientId: 'jole', campaign: '', leadNiche: '', campaign_notes: '' }), 'cross_client'],
    [c2Lead({ campaign: 'Industrial Staffing V2' }), 'not_convertible'],
    [c2Lead({ campaign: '' }), 'not_convertible'],
    [c2Lead({ notes: '[REPLY: Not Interested] thanks' }), 'terminal_marker'],
    [c2Lead({ notes: '[BOUNCED 2026-11-01]' }), 'terminal_marker'],
    [c2Lead({ notes: '[REPLY: Unsubscribed]' }), 'terminal_marker'],
  ];
  for (const [lead, code] of cases) {
    const result = plan([record()], [lead]);
    assert.equal(result.conversions.length, 0, `${code} must not convert`);
    assert.equal(result.refusals[0].code, code);
  }
  const suppressed = plan([record()], [c2Lead()], {}, { suppressedEmails: new Set(['dana@tradecostaffing.com']) });
  assert.equal(suppressed.refusals[0].code, 'suppressed');
});

test('5. refuses a wrong id, a mismatched address, duplicates and held evidence', () => {
  setStaffingV4LiveForTests(true);
  assert.equal(plan([record({ lead_id: 'nope' })], [c2Lead()]).refusals[0].code, 'no_lead');
  assert.equal(plan([record({ lead_id: '' })], [c2Lead()]).refusals[0].code, 'missing_lead_id');
  assert.equal(plan([record()], [c2Lead({ email: 'other@tradecostaffing.com' })]).refusals[0].code, 'email_mismatch');
  assert.equal(plan([record()], [c2Lead(), c2Lead()]).refusals[0].code, 'ambiguous_lead');
  const twin = { id: 'X9', email: 'dana@tradecostaffing.com', campaign: 'Industrial Staffing Agency', clientId: 'scalelab' };
  assert.equal(plan([record()], [c2Lead(), twin]).refusals[0].code, 'duplicate_email');
  const sameCompany = { id: 'X8', email: 'boss@tradecostaffing.com', campaign: 'Industrial Staffing Agency', clientId: 'scalelab' };
  assert.equal(plan([record()], [c2Lead(), sameCompany]).refusals[0].code, 'duplicate_company');
  assert.equal(plan([record({}, { specialization: null })], [c2Lead()]).refusals[0].code, 'held');
  assert.equal(plan([record({}, { contactStatus: 'NEEDS_EVIDENCE' })], [c2Lead()]).refusals[0].code, 'held');
  assert.equal(plan([record(), record()], [c2Lead()]).refusals[0].code, 'duplicate_in_batch');
  assert.equal(plan([record({}, {}, { email: 'dana@gmail.com' })], [c2Lead({ email: 'dana@gmail.com' })]).refusals[0].code, 'personal_mailbox');
});

test('6. a manual hold is released only on request AND with owner approval, and only that marker', () => {
  setStaffingV4LiveForTests(true);
  const held = c2Lead({ notes: '[MANUAL HOLD] staged lookalike; [RESUME: 2099-01-01T00:00:00Z] check' });
  assert.equal(plan([record()], [held]).refusals[0].code, 'manual_hold');
  assert.equal(plan([record({ release_manual_hold: true })], [held], { owner_approved_send_ready: false }).refusals[0].code, 'manual_hold');
  const released = plan([record({ release_manual_hold: true })], [held]);
  assert.deepEqual(released.refusals, []);
  const item = released.conversions[0];
  assert.equal(item.releaseManualHold, true);
  assert.ok(!item.patch.notes.includes('[MANUAL HOLD]'));
  assert.ok(item.patch.notes.includes('staged lookalike'), 'the rest of the notes are kept');
  // A release request never lifts an opt-out.
  const optedOut = c2Lead({ notes: '[MANUAL HOLD] [REPLY: Unsubscribed]' });
  assert.equal(plan([record({ release_manual_hold: true })], [optedOut]).refusals[0].code, 'terminal_marker');
});

test('7. conversion is idempotent: the same converted lead is a no-op, a different V4 profile is never replaced', () => {
  setStaffingV4LiveForTests(true);
  const first = plan([record()], [c2Lead()]);
  const converted = { ...c2Lead(), ...first.conversions[0].patch };
  const again = plan([record()], [converted]);
  assert.equal(again.conversions.length, 0);
  assert.equal(again.alreadyConverted.length, 1);
  // An imported (not converted) Campaign 3 lead with the same address is refused, not rewritten.
  const imported = evaluateCampaign3Import({ schema: IMPORT_SCHEMA, sourcing_run_id: 'v4-run', owner_approved_send_ready: true,
    records: [{ row: record().row, evidence: evidence() }] }, {}, { newId: () => 'C2L1', now: NOW }).accepted[0].lead;
  assert.equal(plan([record()], [imported]).refusals[0].code, 'profile_present');
});

test('8. the notes guard allows only the conversion write, and only onto an untouched V1 / Campaign 2 row', () => {
  setStaffingV4LiveForTests(true);
  const lead = c2Lead();
  const notes = plan([record()], [lead]).conversions[0].patch.campaign_notes;
  assert.equal(staffingV2CampaignNotesRefusal(lead, notes), null);
  assert.equal(campaign3ConversionAllowed(lead, notes), true);
  for (const blocked of [c2Lead({ emailStep: '1' }), c2Lead({ stage: 'Queued' }), c2Lead({ senderInboxId: 'primary' }),
    c2Lead({ email: 'someone@elsewherestaffing.com' }), c2Lead({ campaign: '' }), c2Lead({ campaign: 'Industrial Staffing V2' })]) {
    assert.match(staffingV2CampaignNotesRefusal(blocked, notes), /staffing_v4_profile_read_only/);
  }
  // A V4 profile without the conversion provenance (an import-style profile) cannot be written onto an existing row.
  const importNotes = notes.replace(/"sourcing_run_id":"campaign3-convert:[^"]*"/, '"sourcing_run_id":"v4-run"');
  assert.match(staffingV2CampaignNotesRefusal(lead, importNotes), /staffing_v4_profile_read_only/);
  // Once converted, the profile is sealed like any Campaign 3 profile.
  const converted = { ...lead, campaign_notes: notes, campaign: 'Industrial Campaign 3' };
  assert.match(staffingV2CampaignNotesRefusal(converted, `${REVIEW_V1}`), /never rewritten/);
});

test('9. dry run writes nothing; a live run commits one compare-and-set per lead with the hold release', async () => {
  setStaffingV4LiveForTests(true);
  const held = c2Lead({ notes: '[MANUAL HOLD] x' });
  let applied = null;
  const io = { readCorpus: async () => ({ leads: [held], suppressedEmails: new Set() }),
    applyChanges: async changes => { applied = changes; return changes.map(c => ({ leadId: c.leadId, status: 'succeeded' })); } };
  const dry = await convertCampaign3Leads({ payload: payload([record({ release_manual_hold: true })]), now: NOW, ...io });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.planned, 1);
  assert.equal(dry.written, 0);
  assert.equal(applied, null, 'dry run never calls the writer');
  const live = await convertCampaign3Leads({ payload: payload([record({ release_manual_hold: true })]), dryRun: false, now: NOW, ...io });
  assert.equal(live.written, 1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].leadId, 'C2L1');
  assert.deepEqual(applied[0].releaseMarkers, ['[MANUAL HOLD]']);
  assert.equal(applied[0].expectedState.stage, 'Import');
  await assert.rejects(convertCampaign3Leads({ payload: { schema: 'wrong', records: [] }, ...io }), /schema must be/);
});
