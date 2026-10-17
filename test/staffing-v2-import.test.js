'use strict';

// Industrial Staffing V2 import + persistence: the explicit-identity import
// path, the structured profile that carries roles + market and the experiment
// fields, and the guards that keep a V2 lead from ever queueing or sending as
// V1. Fixtures are anonymized (.test domains); nothing here reaches a store.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { importStaffingV2Leads, evaluateStaffingV2Import, IMPORT_SCHEMA } = require('../integrations/staffing-v2-import');
const {
  readStaffingV2Profile, hasStaffingV2ProfileMarker, staffingV2RolesText, profileDigest, SCHEMA,
  MAX_STAFFING_V2_PROFILE_CHARS, PROFILE_INTEGRITY_FAILED,
} = require('../integrations/staffing-v2-profile');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2, renderStaffingEmail, validateStaffingEmail, staffingCampaignFor,
  staffingV2Live, setStaffingV2LiveForTests, isStaffingV2Marked, staffingV2SendBlock, replaceStaffingReviewTag,
  staffingV2CampaignNotesRefusal, renderStaffingPreview,
} = require('../integrations/staffing-campaign');
const { activeVersionForLead, CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { validateCampaignVersionRoute, routedLeadReady } = require('../integrations/campaign-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { admitStaffingPersonalization } = require('../integrations/staffing-preview-route');
const { withStaffingHold } = require('../integrations/staffing-hold');
const {
  SHEET_FIELDS, toOutreachLeadRow, fromOutreachLeadRow, applyLeadChange, applyLeadChanges, applyCanonicalChange,
} = require('../integrations/outreach-state');
const { createPostgrestDouble } = require('../test-support/postgrest-double');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS, STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const ROOT = path.join(__dirname, '..');
const V1_ID = 'industrial_staffing_employer_acquisition_v1';
const V2_ID = 'industrial_staffing_employer_acquisition_v2';
const V1_TEMPLATE = 'industrial-staffing-employer-v1';
const V2_TEMPLATE = 'industrial-staffing-employer-v2';
const LAUNCHED = '2026-09-01T00:00:00.000Z';

// A finished V2_READY sourcing record, every field present (reference.md §1 + execution fields).
const record = (extra = {}) => ({
  company: 'Northwind Trades Staffing', company_domain: 'northwindtrades.test', apollo_organization_id: 'org-001',
  first_name: 'Jordan', last_name: 'Reyes', job_title: 'Owner', apollo_person_id: 'per-001',
  buyer_cohort: 'P1A_OWNER_EXEC', buyer_priority: 'P1', buyer_family: 'OWNER_EXEC',
  buyer_evidence: 'Owner and founder, per the About page.', alternate_buyers: ['Sam Lee | VP Sales | P1B_REVENUE | per-002'],
  buyer_assignment_method: 'RANDOMIZED_P1A', buyer_randomization_bucket: '0',
  staffing_model: 'TEMP_CONTRACT_CORE', vertical: 'SKILLED_TRADE_INDUSTRIAL',
  vertical_sublane: 'TRADES_CONSTRUCTION_PROJECT', specialty_tags: 'OIL_GAS',
  roles: 'welders|pipefitters|electricians', market: 'industrial construction contractors',
  roles_evidence: 'We supply temporary and contract welders, pipefitters and electricians',
  market_evidence: 'to industrial construction contractors.',
  role_market_evidence_source: 'https://northwindtrades.test/industrial-construction',
  employee_count: '60', city: 'Houston', state: 'TX', country: 'US', icp_lane: 'TIER_A_STAFFING',
  staffing_model_score: '25', vertical_score: '15', buyer_score: '20', evidence_score: '15',
  economics_score: '10', company_profile_score: '10', email_quality_score: '5',
  pre_reveal_subtotal: '95', total_icp_score: '100', icp_priority_band: 'PRIORITY_A',
  pre_reveal_gate_status: 'PASS', post_reveal_gate_status: 'PASS', hard_gate_status: 'PASS', hard_gate_failures: '',
  company_fit_status: 'ICP_CONFIRMED', copy_readiness_status: 'ROLE_MARKET_VERIFIED', buyer_status: 'BUYER_CONFIRMED',
  email_readiness_status: 'EMAIL_READY', v2_status: 'V2_READY', review_flags: '',
  qualification_reason: 'Core industrial temp staffing; owner buyer.',
  email: 'Jordan.Reyes@northwindtrades.test', email_status: 'verified', catch_all_status: 'N',
  reveal_credit_cost: '1', source: 'apollo_people_search_free', source_url_or_reference: 'A1-q3:p2',
  source_checked_at: '2026-10-20', sourcing_run_id: 'v2src-20261020-01', source_batch: 'T1',
  search_stream: 'A1_SKILLED_TRADES_CONSTRUCTION|A2_MANUFACTURING_INDUSTRIAL', source_query: 'A1-q3:p2',
  reveal_attempted: 'Y', reveal_attempted_at: '2026-10-20T15:04:05Z', reveal_result: 'MATCHED_EMAIL',
  duplicate_status: 'CLEAR', suppression_status: 'CLEAR',
  campaign_id: V2_ID, template_id: V2_TEMPLATE,
  ...extra,
});
const payload = (records = [record()], run = {}, extra = {}) => ({
  schema: IMPORT_SCHEMA, campaign_id: V2_ID, template_id: V2_TEMPLATE,
  run: { sourcing_run_id: 'v2src-20261020-01', catch_all_allowed: true, allow_over_500_ready: false,
    allowed_buyer_cohorts: ['P1A_OWNER_EXEC', 'P1B_REVENUE', 'P2_COMMERCIAL'], ...run },
  records, ...extra,
});

// An in-memory store with the same seams the server passes: one ColdEmail
// append, one mirror, and nothing else (no queue, activity, reservation or sender).
function memoryStore({ leads = [], suppressed = [] } = {}) {
  const store = { leads: [...leads], appends: 0, mirrored: [], ids: 0 };
  store.deps = {
    readCorpus: async () => ({ leads: store.leads, suppressedEmails: new Set(suppressed) }),
    appendLeads: async rows => { store.appends += 1; store.leads.push(...rows); },
    mirrorLeads: async rows => { store.mirrored.push(...rows); return { scheduled: true, leads: rows.length }; },
    newId: () => `v2lead${++store.ids}`,
    now: () => '2026-10-21T00:00:00.000Z',
  };
  return store;
}
const importInto = (store, body, dryRun = false) => importStaffingV2Leads({ payload: body, dryRun, ...store.deps });
const refusalCodes = result => result.refusals.map(refusal => refusal.code);
async function importedLead(extra = {}) {
  const store = memoryStore();
  const result = await importInto(store, payload([record(extra)]));
  assert.equal(result.written, 1, JSON.stringify(result.refusals));
  return store.leads[0];
}
function withLaunchedStaffing(t, { v2Live = false } = {}) {
  const saved = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = LAUNCHED;
  setStaffingV2LiveForTests(v2Live);
  t.after(() => {
    setStaffingV2LiveForTests(null);
    if (saved === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = saved;
  });
}
// writes = lead mutations; events = queue activity rows. A refusal produces neither.
async function queue(lead, emailTemplateId, campaignVersionId, { validateSelection = () => ({ ok: true }) } = {}) {
  let writes = 0;
  let events = 0;
  const result = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'primary', emailTemplateId, campaignVersionId }, {
    loadState: async () => ({ leads: [lead], activities: [], boardLeads: [], suppressedEmails: new Set(), ...STAFFING_RENDER_OPTIONS }),
    validateSelection,
    applyChanges: async changes => { writes += changes.length; return changes.map(({ lead: l }) => ({ leadId: l.id, status: 'succeeded' })); },
    appendActivities: async rows => { events += Array.isArray(rows) ? rows.length : 1; },
  });
  return { result, writes, events };
}

// ── 1–3. Import, storage, renderer ───────────────────────────────────────────

test('1. a valid rich V2 record imports as one Import-stage V2 lead', async () => {
  const store = memoryStore();
  const result = await importInto(store, payload());
  assert.deepEqual([result.received, result.accepted, result.refused, result.written, store.appends], [1, 1, 0, 1, 1]);
  const lead = store.leads[0];
  assert.deepEqual([lead.campaign, lead.emailTemplateId, lead.intendedCampaignVersion, lead.leadNiche, lead.clientId],
    [STAFFING_CAMPAIGN_V2.name, V2_TEMPLATE, V2_ID, 'industrial_staffing', 'scalelab']);
  assert.deepEqual([lead.company, lead.contactName, lead.email, lead.city, lead.website],
    ['Northwind Trades Staffing', 'Jordan Reyes', 'jordan.reyes@northwindtrades.test', 'Houston', 'https://northwindtrades.test']);
  // V1-meaning legacy columns are not reused for V2 data.
  assert.deepEqual([lead.tradeType, lead.tier, lead.siteContext, lead.notes], ['', '', '', '']);
  assert.equal(staffingCampaignFor(lead), STAFFING_CAMPAIGN_V2);
  assert.equal(store.mirrored.length, 1);
});

test('dry run is the default and writes nothing', async () => {
  const store = memoryStore();
  const result = await importStaffingV2Leads({ payload: payload(), ...store.deps });
  assert.deepEqual([result.dryRun, result.accepted, result.written, store.appends, store.leads.length], [true, 1, 0, 0, 0]);
});

test('2. the stored profile keeps roles and market as separate structured values', async () => {
  const read = readStaffingV2Profile(await importedLead());
  assert.equal(read.ok, true);
  assert.equal(read.profile.schema, SCHEMA);
  assert.deepEqual(read.profile.roles, ['welders', 'pipefitters', 'electricians']);
  assert.equal(read.profile.market, 'industrial construction contractors');
});

test('3. V2 Touch 1 reads the structured roles + market, never an opener sentence', async () => {
  const lead = await importedLead();
  const email = renderStaffingEmail(lead, 1, OPTIONS);
  assert.match(email.body, /^Hi Jordan,\n\nSaw Northwind Trades Staffing places welders, pipefitters and electricians for industrial construction contractors\.\n\n/);
  assert.equal(email.campaignId, V2_ID);
  assert.equal(validateStaffingEmail(email, 1), null);
  // A stray V1 opener in siteContext is ignored, not reverse-parsed.
  const stray = renderStaffingEmail({ ...lead, siteContext: 'Saw you place nurses for hospitals.' }, 1, OPTIONS);
  assert.equal(stray.body, email.body);
  assert.deepEqual([staffingV2RolesText(['welders']), staffingV2RolesText(['welders', 'pipefitters'])], ['welders', 'welders and pipefitters']);
  // An unusable profile renders nothing rather than falling back.
  const broken = { ...lead, campaign_notes: lead.campaign_notes.replace(/"market":"[^"]*"/, '"market":""') };
  assert.throws(() => renderStaffingEmail(broken, 1, OPTIONS), /staffing_v2_profile_integrity_failed/);
  for (const step of [2, 3]) assert.equal(validateStaffingEmail(renderStaffingEmail(lead, step, OPTIONS), step), null);
});

// ── 4–12. Refusals ───────────────────────────────────────────────────────────

test('4–5. missing roles or market refuses the record', async () => {
  for (const [extra, code] of [[{ roles: '' }, 'roles_missing'], [{ market: '' }, 'market_missing'],
    [{ roles: 'welders|pipefitters|electricians|riggers' }, 'roles_invalid'], [{ market: 'see https://x.test' }, 'market_invalid'],
    [{ role_market_evidence_source: '' }, 'evidence_missing'], [{ roles_evidence: '' }, 'evidence_missing']]) {
    const result = evaluateStaffingV2Import(payload([record(extra)]), {}, { newId: () => 'x' });
    assert.deepEqual(refusalCodes(result), [code], JSON.stringify(extra));
  }
});

test('6. a missing campaign identity refuses the request and the record', () => {
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { campaign_id: '' })), /never infers its campaign/);
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { template_id: undefined })), /never infers its campaign/);
  const result = evaluateStaffingV2Import(payload([record({ campaign_id: '' })]));
  assert.deepEqual(refusalCodes(result), ['campaign_identity_missing']);
});

test('7. V1 campaign identity can never enter the V2 path', () => {
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { campaign_id: V1_ID })), /V1 campaign identity cannot enter/);
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { template_id: V1_TEMPLATE })), /V1 campaign identity cannot enter/);
  for (const extra of [{ campaign_id: V1_ID }, { template_id: V1_TEMPLATE }]) {
    assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record(extra)]))), ['v1_identity_refused']);
  }
  // Any other campaign or template is refused too, for the request and for a record.
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { campaign_id: 'industrial_staffing' })), /campaign_id must be/);
  assert.throws(() => evaluateStaffingV2Import(payload([record()], {}, { template_id: 'industrial-staffing-employer-v3' })), /template_id must be/);
  for (const extra of [{ campaign_id: 'industrial_staffing' }, { template_id: 'industrial-staffing-employer-v3' }]) {
    assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record(extra)]))), ['campaign_identity_mismatch']);
  }
});

test('8. a generic industrial_staffing lead never silently becomes V2', () => {
  assert.throws(() => evaluateStaffingV2Import({ ...payload(), campaign_id: undefined, template_id: undefined, lead_niche: 'industrial_staffing' }),
    /never infers its campaign/);
  const generic = { id: 'G1', company: 'Generic Co', email: 'pat@generic.test', leadNiche: 'industrial_staffing' };
  assert.equal(isStaffingV2Marked(generic), false);
  assert.notEqual(staffingCampaignFor({ ...generic, campaign: STAFFING_CAMPAIGN.name }), STAFFING_CAMPAIGN_V2);
});

test('9. a V2 lead never falls back to V1, whatever is missing or legacy-looking', async t => {
  withLaunchedStaffing(t);
  const lead = await importedLead();
  assert.equal(CAMPAIGN_VERSIONS[V1_ID].status, 'active');
  for (const variant of [{ intendedCampaignVersion: '' }, { intendedCampaignVersion: '', emailTemplateId: '' },
    { intendedCampaignVersion: V1_ID, emailTemplateId: V1_TEMPLATE, campaign: STAFFING_CAMPAIGN.name }]) {
    assert.throws(() => activeVersionForLead({ ...lead, ...variant }), /never falls back to V1|incompatible with template/, JSON.stringify(variant));
  }
  // V1 identity pasted onto a V2-profiled lead does not make it a V1 lead.
  const relabelled = { ...lead, campaign: STAFFING_CAMPAIGN.name, emailTemplateId: V1_TEMPLATE, intendedCampaignVersion: V1_ID };
  assert.equal(staffingCampaignFor(relabelled), null);
  assert.throws(() => renderStaffingEmail(relabelled, 1, OPTIONS), /Staffing campaign assignment required/);
  // V2 itself is not live, so its own version refuses too.
  assert.throws(() => activeVersionForLead(lead), /is not active/);
});

test('10–12. only V2_READY imports; V2_REVIEW and V2_REJECT are refused', () => {
  for (const status of ['', 'V2_REVIEW', 'V2_REJECT']) {
    assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ v2_status: status })]))), ['not_v2_ready'], status);
  }
  for (const [extra, code] of [[{ post_reveal_gate_status: 'NOT_REVEALED' }, 'gate_not_passed'],
    [{ hard_gate_failures: 'PRE-7' }, 'gate_not_passed'], [{ copy_readiness_status: 'ROLE_MARKET_INCOMPLETE' }, 'status_not_ready'],
    [{ icp_priority_band: 'REVIEW' }, 'invalid_band'], [{ duplicate_status: 'DUPLICATE:v1:domain' }, 'declared_duplicate']]) {
    assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record(extra)]))), [code], JSON.stringify(extra));
  }
});

test('run policy: cohort, catch-all and over-500 restrictions are enforced', () => {
  const p3 = record({ buyer_cohort: 'P3_BRANCH_COMMERCIAL', buyer_priority: 'P3', buyer_family: 'BRANCH',
    buyer_assignment_method: 'P3_REVIEW', buyer_randomization_bucket: '', buyer_score: '12', pre_reveal_subtotal: '87', total_icp_score: '92' });
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([p3]))), ['cohort_not_allowed']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([p3], { allowed_buyer_cohorts: ['P3_BRANCH_COMMERCIAL'] }))), []);
  const catchAll = record({ catch_all_status: 'Y', email_readiness_status: 'EMAIL_CATCH_ALL', email_quality_score: '3', total_icp_score: '98' });
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([catchAll], { catch_all_allowed: false }))), ['catch_all_not_allowed']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([catchAll]))), []);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ employee_count: '800' })]))), ['run_restriction']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ total_icp_score: '90' })]))), ['invalid_score']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ buyer_randomization_bucket: '1' })]))), ['invalid_assignment']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ country: 'CA' })]))), ['not_us']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ v2_notes: 'x' })]))), ['unknown_field']);
  // Alternates travel as whole entries; pipe text would split an entry into its parts.
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ alternate_buyers: 'Sam Lee | VP Sales | P1B_REVENUE | per-002' })]))), ['invalid_buyer']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ alternate_buyers: ['Sam Lee | VP Sales | RECRUITER | per-002'] })]))), ['invalid_buyer']);
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ alternate_buyers: [] })]))), []);
  assert.throws(() => evaluateStaffingV2Import(payload([record()], { catch_all_allowed: undefined })), /catch_all_allowed/);
});

// ── 13–19. Experiment fields survive ─────────────────────────────────────────

test('13–19. buyer, randomization, lane, band, scores, Apollo IDs and provenance persist typed', async () => {
  const { profile } = readStaffingV2Profile(await importedLead());
  assert.deepEqual([profile.buyer_cohort, profile.buyer_priority, profile.buyer_family, profile.buyer_assignment_method],
    ['P1A_OWNER_EXEC', 'P1', 'OWNER_EXEC', 'RANDOMIZED_P1A']);
  assert.equal(profile.buyer_randomization_bucket, '0');
  assert.deepEqual([profile.icp_lane, profile.icp_priority_band, profile.staffing_model, profile.vertical, profile.vertical_sublane],
    ['TIER_A_STAFFING', 'PRIORITY_A', 'TEMP_CONTRACT_CORE', 'SKILLED_TRADE_INDUSTRIAL', 'TRADES_CONSTRUCTION_PROJECT']);
  assert.deepEqual(profile.specialty_tags, ['OIL_GAS']);
  assert.deepEqual([profile.staffing_model_score, profile.vertical_score, profile.buyer_score, profile.evidence_score,
    profile.economics_score, profile.company_profile_score, profile.email_quality_score, profile.pre_reveal_subtotal, profile.total_icp_score],
  [25, 15, 20, 15, 10, 10, 5, 95, 100]);
  assert.equal(profile.employee_count, 60);
  assert.deepEqual([profile.apollo_person_id, profile.apollo_organization_id], ['per-001', 'org-001']);
  assert.deepEqual([profile.sourcing_run_id, profile.source_batch, profile.source_query, profile.source,
    profile.source_url_or_reference, profile.source_checked_at, profile.reveal_result, profile.reveal_credit_cost],
  ['v2src-20261020-01', 'T1', 'A1-q3:p2', 'apollo_people_search_free', 'A1-q3:p2', '2026-10-20', 'MATCHED_EMAIL', 1]);
  assert.deepEqual(profile.search_stream, ['A1_SKILLED_TRADES_CONSTRUCTION', 'A2_MANUFACTURING_INDUSTRIAL']);
  assert.deepEqual([profile.duplicate_status, profile.suppression_status, profile.email_status, profile.catch_all_status],
    ['CLEAR', 'CLEAR', 'verified', 'N']);
  assert.match(profile.import_key, /^[0-9a-f]{32}$/);
});

// ── 20–23. Import is not queueing ────────────────────────────────────────────

test('20–23. import creates no queue event, reservation, sender or sequence state, and V2 stays not live', async () => {
  const lead = await importedLead();
  assert.deepEqual([lead.stage, lead.senderInboxId, lead.emailStatus, lead.emailStep, lead.lastEmailedAt, lead.routingRequired],
    ['Import', '', '', '', '', 'true']);
  // The import module reaches no queue, activity, reservation, sender or send code.
  const source = fs.readFileSync(path.join(ROOT, 'integrations', 'staffing-v2-import.js'), 'utf8');
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(required.sort(), ['../check-leads', './clients/ownership', './clients/registry', './staffing-campaign', './staffing-v2-profile', 'node:crypto'].sort());
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['appendActivit', 'reserv', 'assignSenders', 'queueSelectedLeads', 'senderFor', 'setStaffingV2LiveForTests', 'STAFFING_V2_LIVE']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  assert.equal(staffingV2Live(), false);
  assert.match(fs.readFileSync(path.join(ROOT, 'integrations', 'staffing-campaign.js'), 'utf8'), /^const STAFFING_V2_LIVE = false;$/m);
  assert.equal(routedLeadReady({ ...lead, senderInboxId: 'primary' }, { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED }).ok, false);
});

// ── 24–25. Idempotency, duplicates, suppression ──────────────────────────────

test('24. re-importing the same artifact is a safe no-op; true duplicates are refused', async () => {
  const store = memoryStore();
  await importInto(store, payload());
  const again = await importInto(store, payload());
  assert.deepEqual([again.accepted, again.alreadyImported, again.written, store.appends, store.leads.length], [0, 1, 0, 1, 1]);
  assert.equal(again.alreadyImportedLeads[0].leadId, store.leads[0].id);
  // Same address from a different Apollo person, or a second buyer at the same company, is a duplicate.
  const otherPerson = await importInto(store, payload([record({ apollo_person_id: 'per-999' })]), true);
  assert.deepEqual(refusalCodes(otherPerson), ['duplicate_email']);
  const sameCompany = await importInto(store, payload([record({ email: 'sam.lee@northwindtrades.test', first_name: 'Sam', last_name: 'Lee', apollo_person_id: 'per-002' })]), true);
  assert.deepEqual(refusalCodes(sameCompany), ['duplicate_company']);
  // Two rows for one company inside a request are both refused.
  const batch = evaluateStaffingV2Import(payload([record({ email: 'a@acme.test', company_domain: 'acme.test', apollo_person_id: 'p1', apollo_organization_id: 'o1' }),
    record({ email: 'b@acme.test', company_domain: 'acme.test', apollo_person_id: 'p2', apollo_organization_id: 'o2' })]));
  assert.deepEqual(refusalCodes(batch), ['duplicate_in_batch', 'duplicate_in_batch']);
});

test('24b. V1 companies and other clients are duplicates for V2', async () => {
  const v1 = { id: 'v1a', company: 'Old Co', email: 'owner@oldco.test', website: 'https://www.oldco.test', campaign: STAFFING_CAMPAIGN.name, clientId: 'scalelab' };
  const jole = { id: 'j1', company: 'Plant', email: 'jordan.reyes@northwindtrades.test', clientId: 'jole', campaign: 'jole-btx-employer-acquisition' };
  const fromV1 = evaluateStaffingV2Import(payload([record({ email: 'new@oldco.test', company_domain: 'oldco.test' })]), { leads: [v1] });
  assert.deepEqual(refusalCodes(fromV1), ['duplicate_company']);
  const fromJole = evaluateStaffingV2Import(payload([record()]), { leads: [jole] });
  assert.deepEqual(refusalCodes(fromJole), ['cross_client_duplicate']);
});

test('25. a suppressed address is refused', async () => {
  const store = memoryStore({ suppressed: ['jordan.reyes@northwindtrades.test'] });
  const result = await importInto(store, payload());
  assert.deepEqual([refusalCodes(result), result.written, store.appends], [['suppressed'], 0, 0]);
});

// ── 26–30. V1 unchanged; V2 queue/route guards ───────────────────────────────

test('26. the legacy ColdEmail import is unchanged for V1 and refuses V2 identity before any write', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/coldemail/import'"), server.indexOf('// A board lead and its ColdEmail row are separate records'));
  // The V1 projection is byte-for-byte what it was.
  for (const line of [
    "id, company: row.company || '', contactName: row.contactName || '',",
    "email: row.email || '', city: row.city || '', tradeType: row.tradeType || '',",
    "website: row.website || '', stage: 'Import',",
    "tier: row.tier || '',         siteContext: row.siteContext || '',",
    'campaign: campaignName, campaign_notes: campaignNotes,',
    "leadNiche, senderInboxId: '', emailTemplateId: '', routingRequired: 'true', intendedCampaignVersion: '',",
    'clientId: DEFAULT_CLIENT_ID,',
  ]) assert.ok(route.includes(line), line);
  const guard = route.indexOf('use_staffing_v2_import');
  assert.ok(guard > 0 && guard < route.indexOf('ensureColdEmailSheet()'), 'V2 is refused before any read or write');
  assert.equal(isStaffingV2Marked({ campaign: STAFFING_CAMPAIGN.name }), false, 'a V1 import is not refused');
  assert.equal(isStaffingV2Marked({ campaign: STAFFING_CAMPAIGN_V2.name }), true);
  assert.equal(isStaffingV2Marked({ campaign: V2_ID }), true);
  // The V2 route exists and is a dry run unless told otherwise.
  assert.match(server, /app\.post\('\/api\/staffing\/v2\/leads\/import', requireAuth/);
  assert.match(server, /const dryRun = body\.dry_run !== false;/);
});

test('27. V1 emails render exactly as before', () => {
  const v1 = { id: 'L1', company: 'Tradeco Construction', contactName: 'Dana Smith', email: 'dana@tradeco.test', leadNiche: 'industrial_staffing',
    siteContext: 'Saw you place electricians and plumbers for commercial and industrial contractors.', stage: 'Queued',
    campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: V1_ID, emailTemplateId: V1_TEMPLATE };
  const body = renderStaffingEmail(v1, 1, OPTIONS).body;
  assert.ok(body.startsWith('Hi Dana,\n\nSaw you place electricians and plumbers for commercial and industrial contractors.\n\n'
    + 'We help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\n'
    + "Worth seeing how we'd do this for Tradeco Construction?\n\n— Deins"));
  assert.equal(renderStaffingEmail(v1, 1, OPTIONS).campaignId, undefined, 'a V1 render keeps its exact shape');
  for (const step of [1, 2, 3]) assert.equal(validateStaffingEmail(renderStaffingEmail(v1, step, OPTIONS), step), null);
  // V1 review tags still work on V1 notes; a V2 profile can never take one.
  assert.match(replaceStaffingReviewTag('', { fit: 'ICP_CONFIRMED', personalization: 'SPECIFIC_HIGH', routingReady: true }), /STAFFING_REVIEW_V1/);
});

test('28. V1 queue routing is unchanged', async t => {
  withLaunchedStaffing(t);
  const v1 = { id: 'L1', company: 'Tradeco Construction', contactName: 'Dana Smith', email: 'dana@tradeco.test', leadNiche: 'industrial_staffing',
    siteContext: 'Saw you place electricians and plumbers for commercial and industrial contractors.', stage: 'Import',
    campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: '', emailTemplateId: '', emailStatus: '', emailStep: '', lastEmailedAt: '' };
  assert.equal(activeVersionForLead(v1).id, V1_ID, 'generic staffing still resolves to V1');
  assert.equal(staffingV2SendBlock(v1), null);
  const { result, writes, events } = await queue(v1, V1_TEMPLATE, V1_ID);
  assert.deepEqual([result.queued, writes, events > 0], [1, 1, true]);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: V1_TEMPLATE, campaignVersionId: V1_ID }).ok, true);
});

test('29. a V2 lead cannot be queued while V2 is not live, and writes nothing', async t => {
  withLaunchedStaffing(t, { v2Live: false });
  const lead = await importedLead();
  const routed = await queue(lead, V2_TEMPLATE, V2_ID, {
    validateSelection: l => validateCampaignVersionRoute({ niche: l.leadNiche, emailTemplateId: V2_TEMPLATE, campaignVersionId: V2_ID }) });
  assert.deepEqual([routed.result.status, routed.result.error, routed.writes, routed.events], [422, 'An approved registered campaign version is required', 0, 0]);
  // Even past a permissive selection check, the V2 guard holds it.
  const guarded = await queue(lead, V2_TEMPLATE, V2_ID);
  assert.deepEqual([guarded.result.status, guarded.writes, guarded.events], [422, 0, 0]);
  assert.match(guarded.result.error, /Industrial Staffing Agency V2 is registered but not live yet/);
  // Live (a later reviewed change), the same structured lead queues as V2 — and a
  // V2 lead without a structured profile still does not.
  setStaffingV2LiveForTests(true);
  const live = await queue(lead, V2_TEMPLATE, V2_ID);
  assert.deepEqual([live.result.queued, live.writes, live.events > 0], [1, 1, true]);
  // Without its structured profile — even with a renderable V1-style opener — a V2 lead is held.
  const profileless = { ...lead, campaign_notes: '', siteContext: 'Saw you place welders for manufacturers.' };
  const held = await queue(profileless, V2_TEMPLATE, V2_ID);
  assert.deepEqual([held.result.status, held.writes, held.events], [422, 0, 0]);
  assert.match(held.result.error, /not sendable: no staffing V2 profile/);
});

test('30. a V2 lead can never be queued or routed under the V1 campaign or template', async t => {
  withLaunchedStaffing(t, { v2Live: true });
  const lead = await importedLead();
  const asV1 = await queue(lead, V1_TEMPLATE, V1_ID);
  assert.deepEqual([asV1.result.status, asV1.writes, asV1.events], [422, 0, 0]);
  const routed = routedLeadReady({ ...lead, senderInboxId: 'primary', emailTemplateId: V1_TEMPLATE, intendedCampaignVersion: V1_ID },
    { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED });
  assert.equal(routed.ok, false);
  assert.equal(staffingV2SendBlock({ ...lead, emailTemplateId: V1_TEMPLATE }), 'staffing V2 lead has conflicting campaign identity');
});

test('V1 personalization can never rewrite a V2 lead', async () => {
  const lead = await importedLead();
  let writes = 0;
  const result = await admitStaffingPersonalization({ id: lead.id }, {
    loadLead: async () => lead, applyPatch: async () => { writes += 1; }, classifyEmail: async () => ({ provider: 'GOOGLE' }),
  });
  assert.deepEqual([result.ok, writes], [false, 0]);
  assert.match(result.reason, /Industrial Staffing V2 leads use their imported roles and market/);
  assert.throws(() => replaceStaffingReviewTag(lead.campaign_notes, { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true }),
    /not a V1 review record/);
});

// ── Storage round trip ───────────────────────────────────────────────────────

test('round trip: import → ColdEmail row → Supabase row → lead → every structured V2 value intact', async () => {
  const input = record();
  const lead = await importedLead();
  // Google Sheets: the lead is stored as one A:Y row in SHEET_FIELDS order, then read back.
  const sheetRow = SHEET_FIELDS.map(field => String(lead[field] ?? ''));
  const fromSheet = Object.fromEntries(SHEET_FIELDS.map((field, i) => [field, sheetRow[i]]));
  // Supabase: the mirror's full-row mapping and its read mapping.
  const supabaseRow = toOutreachLeadRow(fromSheet, { now: new Date('2026-10-21T00:00:00Z') });
  assert.equal(supabaseRow.campaign_notes, lead.campaign_notes);
  assert.equal(supabaseRow.intended_campaign_version, V2_ID);
  const fromSupabase = fromOutreachLeadRow(supabaseRow);
  for (const stored of [fromSheet, fromSupabase]) {
    const read = readStaffingV2Profile(stored);
    assert.equal(read.ok, true);
    assert.equal(hasStaffingV2ProfileMarker(stored), true);
    assert.equal(staffingCampaignFor(stored), STAFFING_CAMPAIGN_V2);
    const { profile } = read;
    const lists = ['roles', 'specialty_tags', 'search_stream', 'alternate_buyers', 'hard_gate_failures', 'review_flags'];
    const ints = ['employee_count', 'staffing_model_score', 'vertical_score', 'buyer_score', 'evidence_score', 'economics_score',
      'company_profile_score', 'email_quality_score', 'pre_reveal_subtotal', 'total_icp_score', 'reveal_credit_cost'];
    for (const [field, value] of Object.entries(input)) {
      const expected = lists.includes(field) ? (Array.isArray(value) ? value : value.split('|').map(part => part.trim()).filter(Boolean))
        : ints.includes(field) ? Number(value)
        : field === 'email' ? value.toLowerCase() : value;
      assert.deepEqual(profile[field], expected, field);
    }
    assert.equal(profile.contact_name, 'Jordan Reyes');
    // Queryable later exactly as SQL would read it: campaign_notes::jsonb ->> 'buyer_cohort'.
    assert.equal(JSON.parse(stored.campaign_notes).buyer_cohort, 'P1A_OWNER_EXEC');
  }
});

// ── Hardening: the profile is sealed, and campaign_notes is read-only ────────

const OFF = { SUPABASE_OUTREACH_MODE: 'off' };
const quiet = { log() {}, warn() {}, error() {} };
const REVIEW_TAG = '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=SPECIFIC_HIGH;routing_ready=true]';
const HOLD = { reason: 'REVIEW_REQUIRED', explanation: 'Needs review', evidence: [{ source: 'audit', detail: 'x' }],
  reviewedAt: '2026-10-21T00:00:00.000Z', reviewSource: 'operator' };
// A Sheets client holding ColdEmail rows by row number. Reads return the row in
// SHEET_FIELDS order; writes are recorded, never applied.
function sheetsHolding(rowsByNumber) {
  const batches = [];
  const valueRange = range => {
    const match = /!A(\d+):/.exec(range);
    const lead = (match && rowsByNumber[match[1]]) || {};
    return { values: [SHEET_FIELDS.map(field => String(lead[field] ?? ''))] };
  };
  return {
    batches,
    client: { spreadsheets: { values: {
      batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map(valueRange) } }),
      get: async ({ range }) => ({ data: valueRange(range) }),
      batchUpdate: async args => { batches.push(args.requestBody.data); return {}; },
    } } },
  };
}
// The stored profile with one change and its digest left as it was.
function tampered(lead, change) {
  const profile = JSON.parse(lead.campaign_notes);
  change(profile);
  return { ...lead, campaign_notes: JSON.stringify(profile) };
}
// The same, re-sealed with a fresh digest: what only a deliberate forger could
// write. The structural checks still refuse it.
const resealed = (lead, change) => tampered(lead, profile => { change(profile); profile.profile_digest = profileDigest(profile); });
const canonicalRow = (lead, extra = {}) => ({
  lead_id: lead.id, revision: 1, stage: lead.stage || 'Import', company: lead.company || '', email: lead.email || '',
  campaign: lead.campaign || '', email_template_id: lead.emailTemplateId || '', intended_campaign_version: lead.intendedCampaignVersion || '',
  lead_niche: lead.leadNiche || '', client_id: 'scalelab', campaign_notes: lead.campaign_notes || '', ...extra,
});

test('digest: an imported profile is sealed with SHA-256 of its canonical form and verifies', async () => {
  const lead = await importedLead();
  const stored = JSON.parse(lead.campaign_notes);
  assert.ok(lead.campaign_notes.startsWith(`{"schema":"${SCHEMA}"`), 'the schema marker stays first');
  assert.match(stored.profile_digest, /^[0-9a-f]{64}$/);
  assert.equal(profileDigest(stored), stored.profile_digest);
  assert.equal(readStaffingV2Profile(lead).ok, true);
  // Canonical: key order is irrelevant, and imported_at (the import clock) is outside the digest.
  assert.equal(readStaffingV2Profile({ campaign_notes: JSON.stringify(Object.fromEntries(Object.entries(stored).reverse())) }).ok, true);
  const later = memoryStore();
  later.deps.now = () => '2027-03-01T00:00:00.000Z';
  await importInto(later, payload());
  const laterProfile = JSON.parse(later.leads[0].campaign_notes);
  assert.notEqual(laterProfile.imported_at, stored.imported_at);
  assert.equal(laterProfile.profile_digest, stored.profile_digest);
});

test('digest: changed roles, market, buyer or randomization data holds the lead as staffing_v2_profile_integrity_failed', async t => {
  withLaunchedStaffing(t, { v2Live: true });
  const lead = await importedLead();
  const env = { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED };
  assert.equal(routedLeadReady({ ...lead, senderInboxId: 'primary' }, env).ok, true, 'the sealed lead itself passes once V2 is live');
  const changes = {
    roles: profile => { profile.roles = ['nurses']; },
    'roles order': profile => { profile.roles = ['pipefitters', 'welders', 'electricians']; },
    market: profile => { profile.market = 'hospitals'; },
    buyer_cohort: profile => { profile.buyer_cohort = 'P1B_REVENUE'; },
    buyer_assignment_method: profile => { profile.buyer_assignment_method = 'RANDOMIZED_P1B'; },
    buyer_randomization_bucket: profile => { profile.buyer_randomization_bucket = '1'; },
    alternate_buyers: profile => { profile.alternate_buyers = []; },
    icp_priority_band: profile => { profile.icp_priority_band = 'PRIORITY_B'; },
    import_key: profile => { profile.import_key = '0'.repeat(32); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const changed = tampered(lead, change);
    const read = readStaffingV2Profile(changed);
    assert.deepEqual([read.ok, read.reason], [false, PROFILE_INTEGRITY_FAILED], name);
    // Send selection, queue validation and the renderer all hold it; nothing is repaired.
    assert.equal(routedLeadReady({ ...changed, senderInboxId: 'primary' }, env).reason, PROFILE_INTEGRITY_FAILED, name);
    assert.equal(staffingV2SendBlock(changed), PROFILE_INTEGRITY_FAILED, name);
    for (const step of [1, 2, 3]) {
      assert.throws(() => renderStaffingEmail(changed, step, OPTIONS), /staffing_v2_profile_integrity_failed/, `${name} step ${step}`);
      assert.equal(renderStaffingPreview(changed, {}, step, OPTIONS), null, `${name} preview ${step}`);
    }
    // Queue validation: eligibility renders every touch first and refuses (409);
    // the V2 guard behind it (staffingV2SendBlock, asserted above) would too.
    const queued = await queue(changed, V2_TEMPLATE, V2_ID);
    assert.deepEqual([queued.result.status, queued.writes, queued.events], [409, 0, 0], name);
    assert.match(queued.result.error, /staffing_v2_profile_integrity_failed/, name);
  }
});

test('a malformed profile fails closed and is never repaired by re-import', async t => {
  withLaunchedStaffing(t, { v2Live: true });
  const lead = await importedLead();
  const malformed = {
    'not JSON': { ...lead, campaign_notes: lead.campaign_notes.slice(0, -2) },
    'hold block appended': { ...lead, campaign_notes: `${lead.campaign_notes}\n[STAFFING_HOLD_V1]\n{}\n[/STAFFING_HOLD_V1]` },
    'not an object': { ...lead, campaign_notes: `[${lead.campaign_notes}]` },
    'unexpected field': tampered(lead, profile => { profile.roles_override = ['nurses']; }),
    'missing field': tampered(lead, profile => { delete profile.market_evidence; }),
    'missing digest': tampered(lead, profile => { delete profile.profile_digest; }),
    'wrongly typed, re-sealed': resealed(lead, profile => { profile.roles = 'welders'; }),
    'oversized, re-sealed': resealed(lead, profile => { profile.buyer_evidence = 'x'.repeat(MAX_STAFFING_V2_PROFILE_CHARS); }),
  };
  for (const [name, broken] of Object.entries(malformed)) {
    const read = readStaffingV2Profile(broken);
    assert.deepEqual([read.ok, read.reason], [false, PROFILE_INTEGRITY_FAILED], name);
    assert.ok(read.detail, name);
    assert.equal(isStaffingV2Marked(broken), true, `${name}: still V2, never V1`);
    assert.equal(staffingV2SendBlock(broken), PROFILE_INTEGRITY_FAILED, name);
    assert.throws(() => renderStaffingEmail(broken, 1, OPTIONS), /staffing_v2_profile_integrity_failed/, name);
  }
  // Re-importing the record over its corrupted lead is refused, and the stored row is left exactly as it is.
  const corrupted = tampered(lead, profile => { profile.market = 'hospitals'; });
  const store = memoryStore({ leads: [corrupted] });
  const again = await importInto(store, payload());
  assert.deepEqual([refusalCodes(again), again.alreadyImported, again.written, store.appends], [[PROFILE_INTEGRITY_FAILED], 0, 0, 0]);
  assert.equal(store.leads[0].campaign_notes, corrupted.campaign_notes);
});

test('an oversized profile is refused at import, never truncated', async () => {
  assert.equal(MAX_STAFFING_V2_PROFILE_CHARS, 30000);
  const typical = (await importedLead()).campaign_notes.length;
  assert.ok(typical < 4000, `a full record serializes to ${typical} characters`);
  const store = memoryStore();
  const over = await importInto(store, payload([record({ buyer_evidence: 'x'.repeat(MAX_STAFFING_V2_PROFILE_CHARS) })]));
  assert.deepEqual([refusalCodes(over), over.written, store.appends], [['profile_too_large'], 0, 0]);
  // Exactly at the limit, the record is stored whole.
  const room = MAX_STAFFING_V2_PROFILE_CHARS - typical + record().buyer_evidence.length;
  const fits = memoryStore();
  assert.equal((await importInto(fits, payload([record({ buyer_evidence: 'x'.repeat(room) })]))).written, 1);
  assert.equal(fits.leads[0].campaign_notes.length, MAX_STAFFING_V2_PROFILE_CHARS);
  assert.equal(readStaffingV2Profile(fits.leads[0]).profile.buyer_evidence.length, room);
});

test('campaign_notes on a V2 lead is read-only to every generic writer; unrelated edits still land', async () => {
  const lead = await importedLead();
  const v1 = { id: 'L1', company: 'Tradeco Construction', email: 'dana@tradeco.test', campaign: STAFFING_CAMPAIGN.name, campaign_notes: '', stage: 'Import' };
  // The rule. Writing the value already there is not a change.
  assert.equal(staffingV2CampaignNotesRefusal(lead, lead.campaign_notes), null);
  for (const next of ['', undefined, REVIEW_TAG, `${lead.campaign_notes}; ${REVIEW_TAG}`, tampered(lead, profile => { profile.market = 'hospitals'; }).campaign_notes]) {
    assert.match(staffingV2CampaignNotesRefusal(lead, next), /^staffing_v2_profile_read_only: /, String(next).slice(0, 40));
  }
  assert.match(staffingV2CampaignNotesRefusal({ campaign: STAFFING_CAMPAIGN_V2.name, campaign_notes: '' }, 'x'), /staffing_v2_profile_read_only/,
    'a V2-labelled lead without a profile is protected too');
  assert.equal(staffingV2CampaignNotesRefusal(v1, REVIEW_TAG), null, 'V1 notes stay writable');
  assert.match(staffingV2CampaignNotesRefusal(v1, lead.campaign_notes), /written only by the V2 import/, 'no other lead can be given a V2 profile');

  // Canonical writer, Sheets authority: refused before any write, whatever else the patch carries.
  const sheets = sheetsHolding({ 5: lead, 6: v1 });
  const at5 = { row: 5, sheetsClient: sheets.client, spreadsheetId: 's', env: OFF, logger: quiet };
  for (const patch of [{ campaign_notes: REVIEW_TAG }, { campaign_notes: '' },
    { siteContext: 'Saw you place nurses for hospitals.', campaign_notes: `${lead.campaign_notes}; ${REVIEW_TAG}` }]) {
    await assert.rejects(applyLeadChange(lead.id, patch, at5), error => error.refused === true && /staffing_v2_profile_read_only/.test(error.message));
  }
  assert.equal(sheets.batches.length, 0, 'nothing was written');
  await applyLeadChange(lead.id, { stage: 'Review' }, at5);
  await applyLeadChange(lead.id, { campaign_notes: lead.campaign_notes, stage: 'Import' }, at5);
  assert.equal(sheets.batches.length, 2, 'unrelated fields, and the unchanged profile, still land');
  // Batch writer: one refusal stops the batch before any lead is written.
  const batch = sheetsHolding({ 5: lead, 6: v1 });
  await assert.rejects(applyLeadChanges([{ leadId: v1.id, row: 6, patch: { campaign_notes: REVIEW_TAG } },
    { leadId: lead.id, row: 5, patch: { campaign_notes: '' } }], { sheetsClient: batch.client, spreadsheetId: 's', env: OFF, logger: quiet }),
  /staffing_v2_profile_read_only/);
  assert.equal(batch.batches.length, 0);

  // Canonical writer, Supabase authority: refused on the CAS read, with no PATCH and no Sheets mirror.
  const db = createPostgrestDouble({ rows: [canonicalRow(lead)] });
  const env = await db.start({ SUPABASE_OUTREACH_WRITES: 'supabase' });
  try {
    const refused = await applyCanonicalChange(lead.id, { campaign_notes: REVIEW_TAG }, { env, logger: quiet });
    assert.deepEqual([refused.ok, refused.refused], [false, true]);
    assert.match(refused.reason, /staffing_v2_profile_read_only/);
    const mirror = sheetsHolding({});
    await assert.rejects(applyLeadChange(lead.id, { campaign_notes: '' }, { row: 5, sheetsClient: mirror.client, spreadsheetId: 's', env, logger: quiet }),
      error => error.refused === true);
    const many = await applyLeadChanges([{ leadId: lead.id, row: 5, patch: { campaign_notes: REVIEW_TAG } }],
      { sheetsClient: mirror.client, spreadsheetId: 's', env, logger: quiet });
    assert.deepEqual([many.ok, many.summary.refused], [false, 1]);
    assert.equal(db.requests.filter(request => request.method === 'PATCH').length, 0, 'no canonical write');
    assert.equal(mirror.batches.length, 0, 'no mirror write');
    assert.equal(db.row(lead.id).campaign_notes, lead.campaign_notes);
    assert.equal((await applyCanonicalChange(lead.id, { stage: 'Review' }, { env, logger: quiet })).ok, true, 'an unrelated field still lands');
  } finally { await db.stop(); }

  // V1 hold and review-tag writers refuse a V2 profile outright.
  assert.throws(() => withStaffingHold(lead.campaign_notes, HOLD), /not a V1 hold record/);
  assert.throws(() => replaceStaffingReviewTag(lead.campaign_notes, { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true }),
    /not a V1 review record/);

  // Dashboard routes: the full-row edit is checked against the stored row before it writes; a manual add of a V2 lead is refused.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const put = server.slice(server.indexOf("app.put('/api/coldemail/:id'"), server.indexOf("app.delete('/api/coldemail/:id'"));
  assert.match(put, /range: `\$\{CE_SHEET_NAME\}!A\$\{rowNum\}:Y\$\{rowNum\}`/);
  const check = put.indexOf('staffingV2CampaignNotesRefusal(current, ');
  assert.ok(check > 0 && check < put.indexOf('spreadsheets.values.update'), 'checked before the write');
  assert.match(put, /code: STAFFING_V2_PROFILE_READ_ONLY/);
  const post = server.slice(server.indexOf("app.post('/api/coldemail', requireAuth"), server.indexOf('// Idempotent note prepend'));
  const refusal = post.indexOf('use_staffing_v2_import');
  assert.ok(refusal > 0 && refusal < post.indexOf('spreadsheets.values.append'), 'refused before any write');
});

test('V1 campaign_notes writers behave exactly as before', async () => {
  const v1 = { id: 'L1', company: 'Tradeco Construction', email: 'dana@tradeco.test', campaign: STAFFING_CAMPAIGN.name,
    campaign_notes: 'imported by ops', stage: 'Import' };
  const reviewed = replaceStaffingReviewTag(v1.campaign_notes, { fit: 'ICP_CONFIRMED', personalization: 'SPECIFIC_HIGH', routingReady: true });
  assert.equal(reviewed, `imported by ops; ${REVIEW_TAG}`);
  const held = withStaffingHold(reviewed, HOLD);
  assert.equal(held, `${reviewed}\n[STAFFING_HOLD_V1]\n${JSON.stringify({ version: 1, reason: 'REVIEW_REQUIRED', explanation: 'Needs review',
    evidence: [{ source: 'audit', detail: 'x' }], reviewedAt: '2026-10-21T00:00:00.000Z', reviewSource: 'operator',
    temporary: false, couldBecomeEligible: false })}\n[/STAFFING_HOLD_V1]`);
  // The canonical writers still write exactly the requested cells, in one batch.
  const sheets = sheetsHolding({ 9: v1 });
  const opener = 'Saw you place welders for fabricators.';
  assert.equal((await applyLeadChange(v1.id, { siteContext: opener, campaign_notes: reviewed },
    { row: 9, sheetsClient: sheets.client, spreadsheetId: 's', env: OFF, logger: quiet })).ok, true);
  assert.deepEqual(sheets.batches, [[{ range: 'ColdEmail!P9', values: [[opener]] }, { range: 'ColdEmail!R9', values: [[reviewed]] }]]);
  const batch = sheetsHolding({ 9: v1 });
  assert.equal((await applyLeadChanges([{ leadId: v1.id, row: 9, patch: { campaign_notes: held } }],
    { sheetsClient: batch.client, spreadsheetId: 's', env: OFF, logger: quiet })).ok, true);
  assert.deepEqual(batch.batches, [[{ range: 'ColdEmail!R9', values: [[held]] }]]);
  const db = createPostgrestDouble({ rows: [canonicalRow(v1)] });
  const env = await db.start({ SUPABASE_OUTREACH_WRITES: 'supabase' });
  try {
    assert.equal((await applyCanonicalChange(v1.id, { campaign_notes: reviewed }, { env, logger: quiet })).ok, true);
    assert.equal(db.row(v1.id).campaign_notes, reviewed);
  } finally { await db.stop(); }
});

test('valid V2 renders are byte-identical to the V2 render of the same roles and market from an opener', async () => {
  const lead = await importedLead();
  const fromOpener = { ...lead, campaign_notes: '', siteContext: 'Saw you place welders, pipefitters and electricians for industrial construction contractors.' };
  for (const options of [OPTIONS, STAFFING_RENDER_OPTIONS]) {
    for (const step of [1, 2, 3]) {
      assert.deepEqual(renderStaffingEmail(lead, step, options), renderStaffingEmail(fromOpener, step, options), `step ${step}`);
    }
  }
  assert.equal(staffingV2Live(), false, 'STAFFING_V2_LIVE stays false');
});

test('personal-email policy: the V2 list is kept and the shared junk classifier still applies', () => {
  for (const email of ['jordan@gmail.com', 'jordan@hotmail.com', 'jordan@proton.me']) {
    assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ email, company_domain: '' })]))), ['personal_email'], email);
  }
  assert.deepEqual(refusalCodes(evaluateStaffingV2Import(payload([record({ email: 'jordan@sentry.io', company_domain: '' })]))), ['invalid_email']);
});

test('manual identity edits on a profiled V2 lead hold it and never select V1, even with V2 live', async t => {
  withLaunchedStaffing(t, { v2Live: true });
  const lead = await importedLead();
  const env = { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED };
  const edits = [];
  for (const campaign of [STAFFING_CAMPAIGN.name, '', 'Ontario List']) {
    for (const emailTemplateId of [V1_TEMPLATE, '']) {
      for (const intendedCampaignVersion of [V1_ID, '']) edits.push({ campaign, emailTemplateId, intendedCampaignVersion });
    }
  }
  edits.push({ campaign: STAFFING_CAMPAIGN_V2.name, emailTemplateId: V1_TEMPLATE, intendedCampaignVersion: V2_ID },
    { campaign: STAFFING_CAMPAIGN_V2.name, emailTemplateId: V2_TEMPLATE, intendedCampaignVersion: V1_ID },
    { campaign: STAFFING_CAMPAIGN.name, emailTemplateId: V2_TEMPLATE, intendedCampaignVersion: V2_ID });
  for (const edit of edits) {
    const edited = { ...lead, ...edit, senderInboxId: 'primary' };
    const label = JSON.stringify(edit);
    assert.equal(isStaffingV2Marked(edited), true, label);
    assert.notEqual(staffingV2SendBlock(edited), null, label);
    assert.equal(routedLeadReady(edited, env).ok, false, label);
    // Never V1: the version resolver refuses or names V2, and nothing renders V1 copy.
    let version = null;
    try { version = activeVersionForLead(edited).id; } catch (_) { version = null; }
    assert.notEqual(version, V1_ID, label);
    let rendered = null;
    try { rendered = renderStaffingEmail(edited, 1, OPTIONS); } catch (_) { rendered = null; }
    if (rendered) assert.equal(rendered.campaignId, V2_ID, label);
    const queued = await queue(edited, V1_TEMPLATE, V1_ID);
    assert.deepEqual([queued.writes, queued.events], [0, 0], label);
  }
  // The unedited lead is the only form that passes once live.
  assert.equal(routedLeadReady({ ...lead, senderInboxId: 'primary' }, env).ok, true);
});

test("the sourcing skill's 09-v2-import-candidate.json shape is accepted as written, dry run by default", async () => {
  // Exactly as apollo-execution.md §15 writes it: JSON arrays for lists, numbers for scores and counts.
  const typed = record({
    alternate_buyers: ['Sam Lee | VP Sales | P1B_REVENUE | per-002'], specialty_tags: ['OIL_GAS'],
    roles: ['welders', 'pipefitters', 'electricians'], hard_gate_failures: [], review_flags: [],
    search_stream: ['A1_SKILLED_TRADES_CONSTRUCTION', 'A2_MANUFACTURING_INDUSTRIAL'], employee_count: 60,
    staffing_model_score: 25, vertical_score: 15, buyer_score: 20, evidence_score: 15, economics_score: 10,
    company_profile_score: 10, email_quality_score: 5, pre_reveal_subtotal: 95, total_icp_score: 100, reveal_credit_cost: 1,
  });
  const file = JSON.parse(JSON.stringify(payload([typed], {}, { dry_run: true })));
  const store = memoryStore();
  // The route's rule: a dry run unless the body says dry_run: false.
  const result = await importStaffingV2Leads({ payload: file, dryRun: file.dry_run !== false, ...store.deps });
  assert.deepEqual([result.dryRun, result.accepted, result.refused, result.written, store.appends], [true, 1, 0, 0, 0]);
  const tooMany = payload(Array.from({ length: 501 }, () => typed));
  assert.throws(() => evaluateStaffingV2Import(tooMany), /at most 500 records/);
});
