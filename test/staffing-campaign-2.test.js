'use strict';

// Staffing Outreach Campaign 2 sends the Industrial Staffing V2 locked Tier A /
// Tier B copy, unchanged, from a sealed V2 sourcing profile adopted onto each
// existing Campaign 2 row, under its own campaign version. It never renders V1
// copy and may not reach a provider before 2026-10-23 07:00 America/Vancouver.
// V1 stays completed; V2 and Jole are untouched. Nothing here contacts Google,
// Gmail or Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, staffingCampaignFor, isStaffingCampaign,
  renderStaffingEmail, validateStaffingEmail, LOCKED_EMAILS_V2, LOCKED_EMAIL_V2_TIER_B,
  isStaffingV2Marked, staffingV2SendBlock, staffingV2CampaignNotesRefusal, replaceStaffingReviewTag,
} = require('../integrations/staffing-campaign');
const {
  staffingSendBlockReason, assertStaffingSendAllowed, STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE,
} = require('../integrations/staffing-launch-gate');
const { CAMPAIGN_VERSIONS, activeVersionForLead, coldSendAttribution } = require('../integrations/campaign-versions');
const { validateCampaignVersionRoute, campaignVersionsForRoute, templateById } = require('../integrations/campaign-routing');
const { completedCampaignFor, outreachBlockForLead } = require('../integrations/lead-archive');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { planCampaign2Adoption } = require('../integrations/staffing-campaign-2-adoption');
const { evaluateStaffingV2Import, IMPORT_SCHEMA } = require('../integrations/staffing-v2-import');
const { setStaffingV2LiveForTests } = require('../integrations/staffing-campaign');
const { googleRecipient } = require('../test-support/google-recipient');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');

const OPEN = Date.parse(STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE);
const ACTIVATED = '2026-09-01T00:00:00.000Z';
const V2_ID = STAFFING_CAMPAIGN_V2.id;
const V2_TEMPLATE = STAFFING_CAMPAIGN_V2.emailTemplateId;
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
  STAFFING_LAUNCH_ACTIVATED_AT: ACTIVATED,
});

// A prepared V2 import record (Tier A): roles + market and its evidence.
const tierA = (extra = {}) => ({
  company: 'Northwind Trades Staffing', company_domain: 'northwindtrades.test', apollo_organization_id: 'org-001',
  first_name: 'Jordan', last_name: 'Reyes', job_title: 'Owner', apollo_person_id: 'per-001',
  buyer_cohort: 'P1A_OWNER_EXEC', buyer_priority: 'P1', buyer_family: 'OWNER_EXEC', buyer_evidence: 'Owner, per the About page.',
  buyer_assignment_method: 'ONLY_P1A', buyer_randomization_bucket: '',
  staffing_model: 'TEMP_CONTRACT_CORE', vertical: 'SKILLED_TRADE_INDUSTRIAL', vertical_sublane: 'TRADES_CONSTRUCTION_PROJECT',
  roles: 'welders|pipefitters', market: 'industrial construction contractors',
  roles_evidence: 'We supply welders and pipefitters', market_evidence: 'to industrial construction contractors.',
  role_market_evidence_source: 'https://northwindtrades.test/industrial', employee_count: '60', city: 'Houston', state: 'TX', country: 'US',
  icp_lane: 'TIER_A_STAFFING', staffing_model_score: '25', vertical_score: '15', buyer_score: '20', evidence_score: '15',
  economics_score: '10', company_profile_score: '10', email_quality_score: '5', pre_reveal_subtotal: '95', total_icp_score: '100',
  icp_priority_band: 'PRIORITY_A', pre_reveal_gate_status: 'PASS', post_reveal_gate_status: 'PASS', hard_gate_status: 'PASS',
  company_fit_status: 'ICP_CONFIRMED', copy_readiness_status: 'ROLE_MARKET_VERIFIED', buyer_status: 'BUYER_CONFIRMED',
  email_readiness_status: 'EMAIL_READY', v2_status: 'V2_READY', email: 'jordan.reyes@northwindtrades.test', email_status: 'verified',
  catch_all_status: 'N', reveal_credit_cost: '1', reveal_result: 'MATCHED_EMAIL', source: 'apollo_people_search_free',
  source_checked_at: '2026-10-20', sourcing_run_id: 'v2run-20261021-01', duplicate_status: 'CLEAR', suppression_status: 'CLEAR',
  campaign_id: V2_ID, template_id: V2_TEMPLATE, icp_tier: 'TIER_A', lead_tag: 'ICP_TIER_A', copy_variant: 'STAFFING_V2_TIER_A_SPECIFIC',
  ...extra,
});
// Tier B: no roles, market or Tier A scores; its verified positioning instead.
const tierB = (extra = {}) => tierA({
  company: 'Lakeshore Labor Partners', company_domain: 'lakeshorelabor.test', apollo_organization_id: 'org-101',
  first_name: 'Casey', last_name: 'Morgan', apollo_person_id: 'per-101', email: 'casey@lakeshorelabor.test', city: '', state: '',
  roles: '', market: '', roles_evidence: '', market_evidence: '', role_market_evidence_source: '',
  staffing_model: '', vertical: '', vertical_sublane: '', icp_lane: '', icp_priority_band: '',
  staffing_model_score: '', vertical_score: '', buyer_score: '', evidence_score: '', economics_score: '', company_profile_score: '',
  pre_reveal_subtotal: '', total_icp_score: '', copy_readiness_status: 'TIER_B_POSITIONING_VERIFIED',
  icp_tier: 'TIER_B', lead_tag: 'ICP_TIER_B', copy_variant: 'STAFFING_V2_TIER_B_INDUSTRIAL',
  tier_b_confidence: 'HIGH', tier_b_positioning: 'light-industrial staffing', tier_b_specialty: 'LIGHT_INDUSTRIAL',
  tier_b_evidence_url: 'https://lakeshorelabor.test/services', tier_b_evidence_summary: 'Services page: light industrial and warehouse staffing.',
  ...extra,
});
const payload = records => ({
  schema: IMPORT_SCHEMA, campaign_id: V2_ID, template_id: V2_TEMPLATE,
  run: { sourcing_run_id: 'v2run-20261021-01', catch_all_allowed: true, allow_over_500_ready: false,
    allowed_buyer_cohorts: ['P1A_OWNER_EXEC', 'P1B_REVENUE', 'P2_COMMERCIAL'] },
  records,
});
const HELD = replaceStaffingReviewTag('', { fit: 'ICP_UNRESOLVED', personalization: 'NONE_REQUIRED', routingReady: false });

// Production shape of a plain, never-contacted Campaign 2 import (outreach_leads).
const plainRow = (record, extra = {}) => ({
  id: `c2-${record.apollo_person_id}`, company: '', contactName: `${record.first_name} ${record.last_name}`,
  email: record.email, stage: 'Import', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', tradeType: '',
  siteContext: '', leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN_2.name, emailTemplateId: '',
  intendedCampaignVersion: '', campaign_notes: HELD, senderInboxId: '', routingRequired: '', clientId: 'scalelab', ...extra,
});
const NOW = () => '2026-10-23T08:00:00.000Z';
function adopted(record, extra = {}) {
  const row = plainRow(record, extra);
  const plan = planCampaign2Adoption(payload([record]), { leads: [row] }, { now: NOW, renderOptions: OPTIONS });
  assert.deepEqual(plan.refusals, []);
  return { ...row, ...plan.adoptions[0].patch };
}
const routed = (lead, extra = {}) => ({ ...lead, stage: 'Queued', senderInboxId: 'primary', routingRequired: 'true', ...extra });

function withClock(t, iso) {
  t.mock.timers.enable({ apis: ['Date'], now: typeof iso === 'number' ? iso : Date.parse(iso) });
}
function withActivation(t) {
  const previous = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = ACTIVATED;
  t.after(() => {
    if (previous === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT;
    else process.env.STAFFING_LAUNCH_ACTIVATED_AT = previous;
  });
}

test('Campaign 2 is its own staffing campaign and template, separate from V1 and V2', () => {
  assert.equal(STAFFING_CAMPAIGN_2.id, 'industrial_staffing_outreach_campaign_2');
  assert.equal(STAFFING_CAMPAIGN_2.name, 'Staffing Outreach Campaign 2');
  assert.equal(STAFFING_CAMPAIGN_2.emailTemplateId, 'industrial-staffing-outreach-campaign-2');
  assert.notEqual(STAFFING_CAMPAIGN_2.emailTemplateId, STAFFING_CAMPAIGN.emailTemplateId);
  assert.notEqual(STAFFING_CAMPAIGN_2.emailTemplateId, V2_TEMPLATE);
  const lead = adopted(tierA());
  assert.equal(staffingCampaignFor(lead), STAFFING_CAMPAIGN_2);
  assert.equal(isStaffingV2Marked(lead), false, 'an adopted profile does not make the lead V2');
  assert.equal(staffingCampaignFor({ ...lead, intendedCampaignVersion: STAFFING_CAMPAIGN.id }), null, 'never V1');
  assert.equal(staffingCampaignFor({ ...lead, campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }), null, 'a profiled lead is never V1, whatever it is relabelled');
  assert.equal(templateById(STAFFING_CAMPAIGN_2.emailTemplateId).ready, true);
});

test('V1 stays completed; Campaign 2 is not a completed campaign', () => {
  const lead = adopted(tierA());
  assert.equal(completedCampaignFor(lead), null);
  assert.equal(outreachBlockForLead(lead), null);
  const v1 = { ...plainRow(tierA()), campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id };
  assert.equal(outreachBlockForLead(v1).code, 'campaign_completed');
});

test('Tier A sends the V2 locked copy, byte-identical to the same record imported into V2', () => {
  const lead = adopted(tierA());
  setStaffingV2LiveForTests(true);
  try {
    const imported = evaluateStaffingV2Import(payload([tierA()]), {}, { newId: () => 'v2-1', now: NOW }).accepted[0].lead;
    for (const step of [1, 2, 3]) {
      const mine = renderStaffingEmail(lead, step, OPTIONS);
      const theirs = renderStaffingEmail(imported, step, OPTIONS);
      assert.equal(mine.body, theirs.body, `step ${step}`);
      assert.equal(mine.subject, theirs.subject, `step ${step}`);
      assert.equal(mine.campaignId, STAFFING_CAMPAIGN_2.id);
      assert.equal(validateStaffingEmail(mine, step), null, `step ${step}`);
    }
  } finally { setStaffingV2LiveForTests(null); }
  const first = renderStaffingEmail(lead, 1, OPTIONS);
  assert.equal(first.subject, 'employer accounts');
  assert.ok(first.body.startsWith(LOCKED_EMAILS_V2[0].replace('{{firstName}}', 'Jordan')
    .replaceAll('{{company}}', 'Northwind Trades Staffing').replace('{{roles}}', 'welders and pipefitters')
    .replace('{{market}}', 'industrial construction contractors')));
  for (const step of [2, 3]) {
    assert.ok(renderStaffingEmail(lead, step, OPTIONS).body.startsWith(LOCKED_EMAILS_V2[step - 1]
      .replace('{{firstName}}', 'Jordan').replaceAll('{{company}}', 'Northwind Trades Staffing')), `step ${step}`);
  }
  assert.doesNotMatch(first.body, /We help industrial staffing agencies|scalelabai\.ca\/staffing/, 'no V1 copy');
});

test('Tier B sends the V2 Tier B locked Touch 1 and the shared V2 follow-ups', () => {
  const lead = adopted(tierB());
  const first = renderStaffingEmail(lead, 1, OPTIONS);
  assert.ok(first.body.startsWith(LOCKED_EMAIL_V2_TIER_B.replace('{{firstName}}', 'Casey')
    .replaceAll('{{company}}', 'Lakeshore Labor Partners').replace('{{tier_b_positioning}}', 'light-industrial staffing')));
  assert.doesNotMatch(first.body, /{{|places .* for/);
  for (const step of [1, 2, 3]) assert.equal(validateStaffingEmail(renderStaffingEmail(lead, step, OPTIONS), step), null);
});

test('a Campaign 2 lead without its sealed profile is held and never falls back to V1 copy', () => {
  const plain = routed(plainRow(tierA(), { company: 'Northwind Trades Staffing',
    emailTemplateId: STAFFING_CAMPAIGN_2.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN_2.id,
    campaign_notes: replaceStaffingReviewTag('', { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true }) }));
  for (const step of [1, 2, 3]) assert.throws(() => renderStaffingEmail(plain, step, OPTIONS), /sealed Tier A \/ Tier B profile/);
  assert.match(staffingV2SendBlock(plain), /not sendable: no staffing V2 profile/);
  const lead = routed(adopted(tierA()));
  assert.equal(staffingV2SendBlock(lead), null);
  assert.match(staffingV2SendBlock({ ...lead, email: 'someone.else@northwindtrades.test' }), /belongs to another address/);
  assert.match(staffingV2SendBlock({ ...lead, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }), /conflicting campaign identity|requires its explicit/);
});

test('adoption reuses the V2 import checks and refuses anything but one untouched Campaign 2 row', () => {
  const a = tierA();
  const plan = (records, leads, extra) => planCampaign2Adoption(payload(records), { leads, ...extra }, { now: NOW, renderOptions: OPTIONS });
  const ok = plan([a, tierB()], [plainRow(a), plainRow(tierB())]);
  assert.equal(ok.adoptions.length, 2);
  assert.deepEqual(ok.adoptions.map(item => item.tier), ['TIER_A', 'TIER_B']);
  assert.deepEqual(Object.keys(ok.adoptions[0].patch).sort(),
    ['campaign_notes', 'company', 'emailTemplateId', 'intendedCampaignVersion', 'leadNiche']);
  const codes = result => result.refusals.map(refusal => refusal.code);
  assert.deepEqual(codes(plan([a], [])), ['no_campaign_2_lead']);
  assert.deepEqual(codes(plan([a], [plainRow(a), plainRow(a, { id: 'other' })])), ['duplicate_email']);
  assert.deepEqual(codes(plan([a], [plainRow(a, { campaign: STAFFING_CAMPAIGN.name })])), ['not_campaign_2']);
  assert.deepEqual(codes(plan([a], [plainRow(a, { lastEmailedAt: '2026-10-22T15:00:00Z' })])), ['contacted']);
  assert.deepEqual(codes(plan([a], [plainRow(a, { senderInboxId: 'primary' })])), ['contacted']);
  assert.deepEqual(codes(plan([a], [plainRow(a)], { suppressedEmails: new Set([a.email]) })), ['suppressed']);
  assert.deepEqual(codes(plan([a], [plainRow(a, { clientId: 'jole_btx' })])), ['cross_client_duplicate']);
  assert.deepEqual(codes(plan([tierA({ v2_status: 'V2_REVIEW' })], [plainRow(a)])), ['not_v2_ready']);
  assert.deepEqual(codes(plan([tierA({ roles: '' })], [plainRow(a)])), ['roles_missing']);
  // Idempotent: an adopted row is reported, never re-sealed or replaced.
  const again = plan([a], [adopted(a)]);
  assert.equal(again.adoptions.length, 0);
  assert.equal(again.alreadyAdopted.length, 1);
  assert.deepEqual(codes(plan([tierA({ market: 'other contractors' })], [adopted(a)])), []);
});

test('only adoption may write a profile, once, onto a never-contacted Campaign 2 lead with that address', () => {
  const a = tierA();
  const row = plainRow(a);
  const notes = planCampaign2Adoption(payload([a]), { leads: [row] }, { now: NOW, renderOptions: OPTIONS }).adoptions[0].patch.campaign_notes;
  assert.equal(staffingV2CampaignNotesRefusal(row, notes), null);
  assert.match(staffingV2CampaignNotesRefusal({ ...row, email: 'x@other.test' }, notes), /read_only/);
  assert.match(staffingV2CampaignNotesRefusal({ ...row, emailStep: '1' }, notes), /read_only/);
  assert.match(staffingV2CampaignNotesRefusal({ ...row, campaign: STAFFING_CAMPAIGN.name }, notes), /read_only/);
  assert.match(staffingV2CampaignNotesRefusal({ ...row, campaign_notes: notes }, HELD), /read_only/, 'an adopted profile is read-only');
  const v2Notes = evaluateStaffingV2Import(payload([a]), {}, { newId: () => 'v2-1', now: NOW }).accepted[0].lead.campaign_notes;
  assert.match(staffingV2CampaignNotesRefusal(row, v2Notes), /read_only/, 'a V2 import profile cannot be pasted onto a Campaign 2 row');
});

test('an adopted Campaign 2 person cannot be imported into V2 again', () => {
  const lead = adopted(tierA());
  const result = evaluateStaffingV2Import(payload([tierA()]), { leads: [lead] }, { newId: () => 'v2-1', now: NOW });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.refusals[0].code, 'duplicate_email');
});

test('Campaign 2 is attributed to its own version with V2 copy versions, never to V1', (t) => {
  withActivation(t);
  withClock(t, OPEN);
  const lead = routed(adopted(tierA()));
  assert.equal(activeVersionForLead(lead).id, STAFFING_CAMPAIGN_2.id);
  const first = coldSendAttribution(lead, 1);
  assert.equal(first.campaignVersion, STAFFING_CAMPAIGN_2.id);
  assert.equal(first.copyVersion, 'staffing_locked_v2');
  assert.equal(coldSendAttribution(lead, 2).copyVersion, 'industrial_staffing_follow_up_v2');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].emailTemplateId, STAFFING_CAMPAIGN_2.emailTemplateId);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].activatedAt, STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE);
});

test('Campaign 2 is queueable before its start but its version is not active', (t) => {
  withActivation(t);
  withClock(t, OPEN - 1);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].status, 'approved');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].activatedAt, null);
  assert.throws(() => activeVersionForLead(routed(adopted(tierA()))), /is not active/);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN_2.emailTemplateId,
    campaignVersionId: STAFFING_CAMPAIGN_2.id }).ok, true);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    campaignVersionId: STAFFING_CAMPAIGN_2.id }).ok, false, 'never on the V1 template');
  assert.ok(campaignVersionsForRoute({ niche: 'industrial_staffing' }).some(version => version.id === STAFFING_CAMPAIGN_2.id));
});

test('no Campaign 2 touch reaches a provider before 2026-10-23T14:00:00.000Z', async (t) => {
  assert.equal(STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE, '2026-10-23T14:00:00.000Z');
  const lead = routed(adopted(tierA()));
  for (const at of [Date.parse('2026-10-23T06:45:00.000Z'), Date.parse('2026-10-23T12:00:00.000Z'), OPEN - 1]) {
    assert.match(staffingSendBlockReason(lead, SEND_ENV, at), /may not send before 2026-10-23T14:00:00.000Z/);
    assert.throws(() => assertStaffingSendAllowed(lead, SEND_ENV, at), /may not send before/);
  }
  assert.equal(staffingSendBlockReason(lead, SEND_ENV, OPEN), '');
  assert.match(staffingSendBlockReason(lead, {}, OPEN), /paused/, 'staffing activation is still required');

  withClock(t, OPEN - 60 * 1000);
  for (const purpose of ['cold', 'sequence']) {
    const verdict = await guardProviderSend(lead, { env: SEND_ENV, classifyRecipient: googleRecipient,
      loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }) }, { purpose });
    assert.equal(verdict.allowed, false, purpose);
    assert.equal(verdict.code, 'staffing_launch_paused', purpose);
    assert.match(verdict.reason, /may not send before/, purpose);
  }
});

test('with V1 completed, Campaign 2 is the current live staffing campaign', () => {
  const { liveCampaignVersions, currentLiveCampaignVersion } = require('../integrations/analytics-scope');
  assert.ok(!liveCampaignVersions().includes(STAFFING_CAMPAIGN.id));
  assert.ok(liveCampaignVersions().includes(STAFFING_CAMPAIGN_2.id));
  assert.equal(currentLiveCampaignVersion(), STAFFING_CAMPAIGN_2.id);
});

test('the start restriction applies only to Campaign 2', () => {
  const before = OPEN - 1;
  const v2 = { ...plainRow(tierA()), campaign: STAFFING_CAMPAIGN_V2.name, intendedCampaignVersion: V2_ID, emailTemplateId: V2_TEMPLATE };
  assert.doesNotMatch(staffingSendBlockReason(v2, SEND_ENV, before), /may not send before/);
  const jole = { id: 'j1', leadNiche: 'jole_industrial_hiring', campaign: 'Jole BTX', clientId: 'jole_btx' };
  assert.equal(staffingSendBlockReason(jole, SEND_ENV, before), '');
  assert.equal(staffingSendBlockReason({ leadNiche: 'dental' }, SEND_ENV, before), '');
  assert.equal(isStaffingCampaign(adopted(tierA())), true);
});
