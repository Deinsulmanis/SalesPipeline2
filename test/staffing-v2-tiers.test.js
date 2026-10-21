'use strict';

// Industrial Staffing V2 ICP tiers (2026-10-21): Tier A and Tier B leads in the
// same V2 campaign. Each lead carries icp_tier + lead_tag + copy_variant; Tier A
// keeps its roles + market Touch 1, Tier B opens with its verified positioning
// and carries no roles or market. Fixtures are anonymized (.test domains).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { importStaffingV2Leads, evaluateStaffingV2Import, IMPORT_SCHEMA } = require('../integrations/staffing-v2-import');
const { readStaffingV2Profile, profileDigest, SCHEMA, PROFILE_INTEGRITY_FAILED, TIER_RULES } = require('../integrations/staffing-v2-profile');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2, LOCKED_EMAILS_V2, LOCKED_EMAIL_V2_TIER_B, renderStaffingEmail, renderStaffingPreview,
  validateStaffingEmail, staffingV2Live, setStaffingV2LiveForTests, staffingV2SendBlock,
} = require('../integrations/staffing-campaign');
const { renderJoleEmployerStep, renderJoleEmployerStepV3 } = require('../integrations/clients/jole-copy');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { SHEET_FIELDS, toOutreachLeadRow, fromOutreachLeadRow } = require('../integrations/outreach-state');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS, STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const ROOT = path.join(__dirname, '..');
const V2_ID = 'industrial_staffing_employer_acquisition_v2';
const V2_TEMPLATE = 'industrial-staffing-employer-v2';
const LAUNCHED = '2026-09-01T00:00:00.000Z';
const UNSUBSCRIBE = 'To unsubscribe, reply “unsubscribe”';
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A Tier A V2_READY record: roles + market, the 100-point ICP score.
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
// A Tier B record: no roles, market or Tier A scores; its verified positioning and evidence.
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
const codes = records => evaluateStaffingV2Import(payload(records), {}, { newId: () => 'x' }).refusals.map(refusal => refusal.code);

function memoryStore() {
  const store = { leads: [], appends: 0, ids: 0 };
  store.deps = {
    readCorpus: async () => ({ leads: store.leads, suppressedEmails: new Set() }),
    appendLeads: async rows => { store.appends += 1; store.leads.push(...rows); },
    mirrorLeads: async rows => ({ scheduled: true, leads: rows.length }),
    newId: () => `v2lead${++store.ids}`,
    now: () => '2026-10-21T00:00:00.000Z',
  };
  return store;
}
async function imported(records) {
  const store = memoryStore();
  const result = await importStaffingV2Leads({ payload: payload(records), dryRun: false, ...store.deps });
  assert.equal(result.written, records.length, JSON.stringify(result.refusals));
  return store.leads;
}
const leadA = async () => (await imported([tierA()]))[0];
const leadB = async (extra = {}) => (await imported([tierB(extra)]))[0];

// ── Import validation ────────────────────────────────────────────────────────

test('1. a valid Tier A record is accepted', () => {
  assert.equal(IMPORT_SCHEMA, 'staffing_v2_import_v2');
  assert.deepEqual(codes([tierA()]), []);
});

test('2–3. Tier A without roles or without market is refused', () => {
  assert.deepEqual(codes([tierA({ roles: '' })]), ['roles_missing']);
  assert.deepEqual(codes([tierA({ market: '' })]), ['market_missing']);
  assert.deepEqual(codes([tierA({ role_market_evidence_source: '' })]), ['evidence_missing']);
  // Tier A keeps its scoring rubric and readiness status.
  assert.deepEqual(codes([tierA({ total_icp_score: '' })]), ['invalid_score']);
  assert.deepEqual(codes([tierA({ copy_readiness_status: 'TIER_B_POSITIONING_VERIFIED' })]), ['status_not_ready']);
  assert.deepEqual(codes([tierA({ tier_b_positioning: 'light-industrial staffing' })]), ['tier_b_fields_on_tier_a']);
});

test('4. a valid Tier B record is accepted without roles or market', () => {
  assert.deepEqual(codes([tierB()]), []);
  assert.deepEqual(codes([tierB({ tier_b_confidence: 'MEDIUM', tier_b_specialty: '', tier_b_evidence_url: '', tier_b_evidence_summary: '' })]), []);
  assert.deepEqual(codes([tierA(), tierB()]), [], 'both tiers import together in one request');
});

test('5. Tier B without tier_b_positioning, or with an unsafe one, is refused', () => {
  assert.deepEqual(codes([tierB({ tier_b_positioning: '' })]), ['tier_b_positioning_missing']);
  for (const positioning of ['Light-industrial staffing', 'light-industrial staffing.', 'staffing staffing', 'see https://x.test',
    'light-industrial {{market}}', 'x'.repeat(81)]) {
    assert.deepEqual(codes([tierB({ tier_b_positioning: positioning })]), ['tier_b_positioning_invalid'], positioning);
  }
  assert.deepEqual(codes([tierB({ tier_b_confidence: 'LOW' })]), ['invalid_tier_b_field']);
  assert.deepEqual(codes([tierB({ tier_b_evidence_url: 'lakeshorelabor.test' })]), ['invalid_tier_b_field']);
});

test('6–7. an invalid icp_tier or copy_variant is refused', () => {
  for (const icpTier of ['', 'TIER_C', 'tier_a', 'TIER_A_STAFFING']) assert.deepEqual(codes([tierA({ icp_tier: icpTier })]), ['invalid_tier'], icpTier);
  for (const variant of ['', 'STAFFING_V2_TIER_C', 'staffing_v2_tier_a_specific']) {
    assert.deepEqual(codes([tierA({ copy_variant: variant })]), ['invalid_copy_variant'], variant);
  }
  assert.deepEqual(codes([tierA({ lead_tag: 'ICP_TIER_B' })]), ['invalid_lead_tag']);
  assert.deepEqual(codes([tierB({ lead_tag: '' })]), ['invalid_lead_tag']);
});

test('8–9. each tier can use only its own copy variant', () => {
  assert.deepEqual(codes([tierA({ copy_variant: 'STAFFING_V2_TIER_B_INDUSTRIAL' })]), ['copy_variant_mismatch']);
  assert.deepEqual(codes([tierB({ copy_variant: 'STAFFING_V2_TIER_A_SPECIFIC' })]), ['copy_variant_mismatch']);
});

test('Tier B never carries roles, market or Tier A scores', () => {
  for (const extra of [{ roles: 'welders' }, { market: 'manufacturers' }, { roles_evidence: 'x' }, { role_market_evidence_source: 'https://x.test' }]) {
    assert.deepEqual(codes([tierB(extra)]), ['tier_b_roles_market_refused'], JSON.stringify(extra));
  }
  for (const extra of [{ icp_lane: 'TIER_A_STAFFING' }, { icp_priority_band: 'PRIORITY_A' }, { staffing_model_score: '25' }, { total_icp_score: '90' }]) {
    assert.deepEqual(codes([tierB(extra)]), ['tier_b_scored'], JSON.stringify(extra));
  }
  // Shared rules still apply to Tier B: identity, buyer, email and provenance.
  assert.deepEqual(codes([tierB({ country: 'CA' })]), ['not_us']);
  assert.deepEqual(codes([tierB({ email_quality_score: '3' })]), ['invalid_score']);
  assert.deepEqual(codes([tierB({ buyer_assignment_method: 'P2_FALLBACK' })]), ['invalid_assignment']);
  assert.deepEqual(codes([tierB({ v2_status: 'V2_REVIEW' })]), ['not_v2_ready']);
});

// ── Rendering ────────────────────────────────────────────────────────────────

test('10. Tier A Touch 1 is the existing roles + market opener', async () => {
  const email = renderStaffingEmail(await leadA(), 1, OPTIONS);
  assert.equal(email.subject, 'employer accounts');
  assert.ok(email.body.startsWith('Hi Jordan,\n\nSaw Northwind Trades Staffing places welders and pipefitters for industrial construction contractors.\n\n'
    + 'I found 10 employers actively hiring in that market that look like potential accounts for Northwind Trades Staffing.\n\n'
    + 'We also generate qualified employer meetings for staffing agencies on a performance basis. No qualified meetings, no meeting fees.\n\n'
    + 'Want the 10?\n\nDeins\n\n'));
  assert.equal(validateStaffingEmail(email, 1), null);
  // The locked Tier A text is unchanged (same fingerprint as production 8bb1f5a).
  assert.equal(sha(LOCKED_EMAILS_V2), '700d17e34c9d30446f786f378d6ac6876597e95a8d79cdf86e6c207961225fd1');
});

test('11–12. Tier B Touch 1 names the verified positioning and no roles or market', async () => {
  const lead = await leadB();
  const email = renderStaffingEmail(lead, 1, OPTIONS);
  assert.equal(email.subject, 'employer accounts');
  assert.equal(email.campaignId, V2_ID);
  assert.equal(email.body, 'Hi Casey,\n\nSaw Lakeshore Labor Partners handles light-industrial staffing.\n\n'
    + 'I found 10 employers that look like potential accounts for Lakeshore Labor Partners.\n\n'
    + 'We also generate qualified employer meetings for staffing agencies on a performance basis. No qualified meetings, no meeting fees.\n\n'
    + 'Want the 10?\n\nDeins\n\n'
    + 'ScaleLabAI\n150 Braid Street, New Westminster, BC V3L 0L4, Canada\nscalelabai.ca\n' + UNSUBSCRIBE);
  assert.equal(validateStaffingEmail(email, 1), null);
  assert.match(email.html, /<strong>No qualified meetings, no meeting fees\.<\/strong>/);
  // Nothing of Tier A's sentence: no "places … for …", no market claim, nothing blank.
  assert.doesNotMatch(email.body, / places | in that market|actively hiring|{{|}}|undefined|null| \./);
  assert.equal(LOCKED_EMAIL_V2_TIER_B.includes('{{roles}}') || LOCKED_EMAIL_V2_TIER_B.includes('{{market}}'), false);
  // Every documented phrase reads naturally inside the sentence.
  for (const positioning of ['manufacturing and warehouse staffing', 'industrial and skilled-trades staffing', 'industrial recruiting']) {
    const body = renderStaffingEmail(await leadB({ tier_b_positioning: positioning }), 1, OPTIONS).body;
    assert.ok(body.includes(`Saw Lakeshore Labor Partners handles ${positioning}.\n\n`), positioning);
  }
  // A Tier B profile tampered to carry roles or market is held, never rendered with them.
  const forged = { ...lead, campaign_notes: (() => { const p = JSON.parse(lead.campaign_notes); p.roles = ['welders']; p.market = 'manufacturers';
    p.profile_digest = profileDigest(p); return JSON.stringify(p); })() };
  assert.equal(readStaffingV2Profile(forged).reason, PROFILE_INTEGRITY_FAILED);
  assert.throws(() => renderStaffingEmail(forged, 1, OPTIONS), /staffing_v2_profile_integrity_failed/);
});

test('13–14. Touches 2 and 3 are the shared V2 follow-ups for both tiers, each with exactly one footer', async () => {
  const a = await leadA();
  const b = await leadB();
  for (const step of [1, 2, 3]) {
    for (const [lead, options] of [[a, OPTIONS], [b, OPTIONS], [a, STAFFING_RENDER_OPTIONS], [b, STAFFING_RENDER_OPTIONS]]) {
      const email = renderStaffingEmail(lead, step, options);
      assert.equal(validateStaffingEmail(email, step), null, `${lead.company} step ${step}`);
      assert.equal(email.body.split(UNSUBSCRIBE).length - 1, 1, `${lead.company} step ${step}: one unsubscribe line`);
      assert.equal(email.body.split('ScaleLabAI\n').length - 1, 1, `${lead.company} step ${step}: one footer`);
      if (step > 1) assert.equal(email.subject, null, 'follow-ups keep the thread subject');
    }
  }
  for (const step of [2, 3]) {
    const fromA = renderStaffingEmail(a, step, OPTIONS).body;
    const fromB = renderStaffingEmail(b, step, OPTIONS).body;
    assert.equal(fromB.replace(/Lakeshore Labor Partners/g, 'X').replace('Hi Casey', 'Hi N'),
      fromA.replace(/Northwind Trades Staffing/g, 'X').replace('Hi Jordan', 'Hi N'), `step ${step} is the same text for both tiers`);
    assert.equal(fromB.startsWith(LOCKED_EMAILS_V2[step - 1].split('{{company}}')[0].replace('{{firstName}}', 'Casey')), true);
  }
  // Previews follow the same tier routing.
  assert.match(renderStaffingPreview(b, {}, 1, OPTIONS).body, /^Hi Casey,\n\nSaw Lakeshore Labor Partners handles light-industrial staffing\./);
});

test('15–16. V1 and Jole renders are byte-identical to production 8bb1f5a', () => {
  // Fingerprints taken on a clean 8bb1f5a checkout with the same fixtures.
  const v1 = { id: 'L1', company: 'Tradeco Construction', contactName: 'Dana Smith', email: 'dana@tradeco.test', leadNiche: 'industrial_staffing',
    siteContext: 'Saw you place electricians and plumbers for commercial and industrial contractors.', stage: 'Queued',
    campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1', emailTemplateId: 'industrial-staffing-employer-v1' };
  const v2Opener = { ...v1, siteContext: 'Saw you place welders and pipefitters for industrial construction contractors.', campaign: STAFFING_CAMPAIGN_V2.name,
    intendedCampaignVersion: V2_ID, emailTemplateId: V2_TEMPLATE };
  const jole = { firstName: 'Pat', company: 'Gulf Fab', roles: ['Millwright', 'Welder'], location: 'Mont Belvieu, TX',
    landingPageUrl: 'https://jolebtx.netlify.app/', bookingLink: 'https://calendar.app.google/x', mailingAddress: '2738 Dallas Ave, Ingleside, TX 78362' };
  assert.equal(sha([1, 2, 3].map(step => renderStaffingEmail(v1, step, OPTIONS))), '6b3eb3eff200a1ff60d4919723a0c14e9f524ff9dde16297290fe23f42cd531f');
  assert.equal(sha([1, 2, 3].map(step => renderStaffingEmail(v2Opener, step, OPTIONS))), '4933bc7fe9bccc0f3664259001952bf2392c2b4e44dc5eda7b3555a29e42b233');
  assert.equal(sha([1, 2, 3].map(step => renderJoleEmployerStep({ step, ...jole }))), 'd588ab9bff27261a959a3f29f3b059b129f017a9b3d4dd2f80f41f710ebcc8cc');
  assert.equal(sha([1, 2, 3].map(step => renderJoleEmployerStepV3({ step, ...jole }))), 'a113e99299579a0178d2ff30d155d0d45a3f1292b1461f6e47b5106275eb2fd3');
});

// ── Import safety ────────────────────────────────────────────────────────────

test('17–18. importing either tier queues nothing, and V2 stays disabled', async t => {
  const saved = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = LAUNCHED;
  t.after(() => { setStaffingV2LiveForTests(null); if (saved === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = saved; });
  const leads = await imported([tierA(), tierB()]);
  for (const lead of leads) {
    assert.deepEqual([lead.stage, lead.senderInboxId, lead.emailStatus, lead.emailStep, lead.lastEmailedAt], ['Import', '', '', '', '']);
    assert.match(staffingV2SendBlock(lead), /registered but not live yet/);
    assert.equal(routedLeadReady({ ...lead, senderInboxId: 'primary' }, { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED }).ok, false);
    let writes = 0;
    let events = 0;
    const result = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'primary', emailTemplateId: V2_TEMPLATE, campaignVersionId: V2_ID }, {
      loadState: async () => ({ leads: [lead], activities: [], boardLeads: [], suppressedEmails: new Set(), ...STAFFING_RENDER_OPTIONS }),
      validateSelection: () => ({ ok: true }),
      applyChanges: async changes => { writes += changes.length; return []; },
      appendActivities: async rows => { events += rows.length; },
    });
    assert.deepEqual([result.status, writes, events], [422, 0, 0], lead.company);
  }
  assert.equal(staffingV2Live(), false);
  assert.match(fs.readFileSync(path.join(ROOT, 'integrations', 'staffing-campaign.js'), 'utf8'), /^const STAFFING_V2_LIVE = false;$/m);
  // Once V2 is live (a later reviewed change), both tiers pass the same send gate.
  setStaffingV2LiveForTests(true);
  for (const lead of leads) assert.equal(staffingV2SendBlock(lead), null, lead.company);
});

test('19–20. the profile persists tier metadata, sealed, and reads back from both stores', async () => {
  const [a, b] = await imported([tierA(), tierB()]);
  for (const [lead, input] of [[a, tierA()], [b, tierB()]]) {
    // Through the ColdEmail row and the Supabase mirror, as the import writes it.
    const fromSheet = Object.fromEntries(SHEET_FIELDS.map(field => [field, String(lead[field] ?? '')]));
    const fromSupabase = fromOutreachLeadRow(toOutreachLeadRow(fromSheet, { now: new Date('2026-10-21T00:00:00Z') }));
    for (const stored of [fromSheet, fromSupabase]) {
      const read = readStaffingV2Profile(stored);
      assert.equal(read.ok, true);
      assert.equal(read.profile.schema, SCHEMA);
      for (const field of ['icp_tier', 'lead_tag', 'copy_variant', 'tier_b_confidence', 'tier_b_positioning', 'tier_b_specialty',
        'tier_b_evidence_url', 'tier_b_evidence_summary']) {
        assert.equal(read.profile[field], input[field] || '', `${input.icp_tier} ${field}`);
      }
      // Queryable later as SQL reads it: campaign_notes::jsonb ->> 'icp_tier'.
      assert.equal(JSON.parse(stored.campaign_notes).icp_tier, input.icp_tier);
    }
  }
  assert.deepEqual(readStaffingV2Profile(a).profile.roles, ['welders', 'pipefitters']);
  assert.deepEqual([readStaffingV2Profile(b).profile.roles, readStaffingV2Profile(b).profile.market], [[], '']);
  // The digest covers the tier fields: a changed tier, tag, variant or positioning is held, never repaired.
  for (const change of [p => { p.icp_tier = 'TIER_A'; }, p => { p.copy_variant = TIER_RULES.TIER_A.copy_variant; },
    p => { p.lead_tag = 'ICP_TIER_A'; }, p => { p.tier_b_positioning = 'healthcare staffing'; }]) {
    const profile = JSON.parse(b.campaign_notes);
    change(profile);
    assert.equal(readStaffingV2Profile({ ...b, campaign_notes: JSON.stringify(profile) }).reason, PROFILE_INTEGRITY_FAILED);
  }
  // Re-sealed by a forger, an inconsistent tier row is still refused.
  const forged = JSON.parse(b.campaign_notes);
  forged.copy_variant = TIER_RULES.TIER_A.copy_variant;
  forged.profile_digest = profileDigest(forged);
  assert.equal(readStaffingV2Profile({ ...b, campaign_notes: JSON.stringify(forged) }).reason, PROFILE_INTEGRITY_FAILED);
  // A schema-v1 profile (none was ever stored) is held as the wrong schema, and still marks its lead V2.
  const v1Schema = { ...a, campaign_notes: a.campaign_notes.replace(SCHEMA, 'staffing_v2_lead_profile_v1') };
  assert.equal(readStaffingV2Profile(v1Schema).reason, PROFILE_INTEGRITY_FAILED);
  assert.notEqual(staffingV2SendBlock(v1Schema), null);
});

test('re-importing the same tiered records is a no-op; a v1 request body is refused', async () => {
  const store = memoryStore();
  await importStaffingV2Leads({ payload: payload([tierA(), tierB()]), dryRun: false, ...store.deps });
  const again = await importStaffingV2Leads({ payload: payload([tierA(), tierB()]), dryRun: false, ...store.deps });
  assert.deepEqual([again.accepted, again.alreadyImported, again.written, store.appends], [0, 2, 0, 1]);
  assert.throws(() => evaluateStaffingV2Import({ ...payload([tierA()]), schema: 'staffing_v2_import_v1' }), /schema must be staffing_v2_import_v2/);
});
