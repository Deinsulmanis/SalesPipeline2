'use strict';
/**
 * Staffing Agency as a first-class CRM lead type.
 *
 * The failure this guards against is the one the audit actually found: a
 * staffing lead silently resolving to dental. Every lookup below must name
 * staffing explicitly, and dental/roofing must be provably unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LEAD_TYPES, LEAD_TYPE_IDS, normalizeNiche, leadTypeLabel, isKnownLeadType,
  routedLeadReady, templateById, campaignVersionsForRoute, validateRoute } = require('../integrations/campaign-routing');
const { CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION, familyForLead,
  activeVersionForLead, coldSendAttribution } = require('../integrations/campaign-versions');
const { offerForLead } = require('../integrations/offer-config');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const ui = read('public/index.html');
const server = read('server.js');

const staffingLead = (over = {}) => ({ leadNiche: 'industrial_staffing',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  company: 'Acme Staffing', routingRequired: 'true', ...over });

// ── A. the UI offers Staffing Agency everywhere lead type is chosen ─────────
test('A. Staffing Agency appears in every lead-type control, not just one', () => {
  // Outreach filter, import/campaign selector, and the manual industry picker.
  assert.match(ui, /<option value="industrial_staffing">Staffing Agency<\/option>[\s\S]{0,80}<\/select>/);
  const selectors = ui.match(/<option value="industrial_staffing">Staffing Agency<\/option>/g) || [];
  assert.equal(selectors.length, 2, 'both canonical-value selectors offer staffing');
  assert.match(ui, /<option>Staffing Agency<\/option>/, 'manual industry picker offers it too');
  // And the raw id is never what a human sees.
  assert.match(ui, /LEAD_TYPE_LABELS = \{[^}]*industrial_staffing: 'Staffing Agency'/);
});

test('A2. lead-type labels are rendered instead of the stored id', () => {
  assert.match(ui, /function leadTypeLabel\(value\)/);
  assert.match(ui, /<td>\$\{esc\(leadTypeLabel\(o\.niche\)\) \|\| '—'\}<\/td>/, 'table cells show the label');
  assert.match(ui, /\$\{leadTypeLabel\(niche\)\}/, 'the routing drawer shows the label');
  assert.match(server, /leadTypeLabels: Object\.fromEntries/, 'the server ships labels to the client');
});

// ── B/C/D. backend acceptance and fail-closed behaviour ────────────────────
test('B. industrial_staffing is accepted wherever dental and roofing are', () => {
  assert.deepEqual([...LEAD_TYPE_IDS], ['dental', 'roofing', 'industrial_staffing']);
  assert.equal(isKnownLeadType('industrial_staffing'), true);
  assert.equal(leadTypeLabel('industrial_staffing'), 'Staffing Agency');
  assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).niche, 'industrial_staffing');
  // The routing-options endpoint serves every registered type, not a hardcoded pair.
  assert.match(server, /const versions = LEAD_TYPE_IDS\.flatMap/);
  assert.match(server, /res\.json\(\{ niches: LEAD_TYPE_IDS,/);
  assert.doesNotMatch(server, /\['dental','roofing'\]/, 'no hardcoded lead-type pair remains');
});

test('B2. human spellings normalise onto the single canonical value', () => {
  for (const alias of ['industrial_staffing', 'industrial staffing', 'staffing', 'staffing_agency', 'Staffing Agency'])
    assert.equal(normalizeNiche(alias), 'industrial_staffing', alias);
  assert.equal(normalizeNiche('Dentist'), 'dental');
  assert.equal(normalizeNiche('Roofer'), 'roofing');
  assert.equal(LEAD_TYPES.filter(t => t.id === 'industrial_staffing').length, 1, 'exactly one canonical staffing id');
});

test('C. an unknown lead type fails closed rather than being stored', () => {
  assert.equal(isKnownLeadType('plumbing'), false);
  assert.equal(isKnownLeadType(''), false);
  assert.equal(normalizeNiche('plumbing'), 'plumbing', 'unknown values pass through, never become a niche');
  // The importer refuses it with an explicit 422 rather than accepting it.
  assert.match(server, /if \(!isKnownLeadType\(leadNiche\)\) \{[\s\S]{0,160}Unknown lead type/);
});

test('D. a staffing lead can never default to dental', () => {
  assert.equal(familyForLead(staffingLead()), 'industrial_staffing');
  assert.equal(familyForLead({ leadNiche: 'industrial_staffing' }), 'industrial_staffing');
  assert.equal(familyForLead({ emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }), 'industrial_staffing');
  assert.equal(familyForLead({ tradeType: 'Staffing Agency' }), 'industrial_staffing');
  assert.notEqual(familyForLead(staffingLead()), 'dental_ai_receptionist');
  // The server and client route resolvers agree, and both check staffing first.
  for (const source of [server, ui])
    assert.match(source, /if \(value\.includes\('staffing'\)\) return 'industrial_staffing';[\s\S]{0,120}if \(value\.includes\('dent'\)\)/);
});

// ── campaign naming ────────────────────────────────────────────────────────
test('the campaign is named Industrial Staffing Agency without orphaning stored rows', () => {
  const { STAFFING_CAMPAIGN_LABELS, isStaffingCampaign } = require('../integrations/staffing-campaign');
  assert.equal(STAFFING_CAMPAIGN.name, 'Industrial Staffing Agency');
  // The id is canonical and must NOT track the display name: ACTIVE_CAMPAIGN_VERSION
  // and CAMPAIGN_VERSIONS key off it, so renaming the label cannot move it.
  assert.equal(STAFFING_CAMPAIGN.id, 'industrial_staffing_employer_acquisition_v1');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].label, 'Industrial Staffing Agency');
  assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).name, 'Industrial Staffing Agency');
  // Rows stored under a previous name still resolve, so a rename can never
  // orphan already-imported leads.
  assert.ok(STAFFING_CAMPAIGN.legacyNames.includes('Industrial Staffing — Employer Acquisition'));
  for (const label of STAFFING_CAMPAIGN_LABELS)
    assert.equal(isStaffingCampaign({ campaign: label }), true, label);
  assert.equal(isStaffingCampaign({ campaign: 'Some other campaign' }), false);
  assert.equal(ACTIVE_CAMPAIGN_VERSION.industrial_staffing, STAFFING_CAMPAIGN.id, 'attribution still resolves');
});

// ── E/F/G/H/I. family, offer, campaign and version resolution ──────────────
test('E/F. staffing resolves to the staffing family and staffing offer', () => {
  assert.equal(familyForLead(staffingLead()), 'industrial_staffing');
  const offer = offerForLead(staffingLead());
  assert.equal(offer.id, STAFFING_CAMPAIGN.id);
  assert.equal(offer.targetCustomer, 'industrial staffing agencies');
  assert.notEqual(offer.id, offerForLead({ leadNiche: 'dental' }).id);
});

test('G/H. ACTIVE_CAMPAIGN_VERSION maps the staffing family to the real version id', () => {
  assert.equal(ACTIVE_CAMPAIGN_VERSION.industrial_staffing, STAFFING_CAMPAIGN.id);
  assert.ok(CAMPAIGN_VERSIONS[ACTIVE_CAMPAIGN_VERSION.industrial_staffing], 'the mapped id is a registered version');
  assert.equal(CAMPAIGN_VERSIONS[ACTIVE_CAMPAIGN_VERSION.industrial_staffing].family, 'industrial_staffing');
  // Dental and roofing mappings are untouched.
  assert.equal(ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist, 'dental_v3_pay_per_booking');
  assert.equal(ACTIVE_CAMPAIGN_VERSION.roofing_survey, 'roofing_survey_v1_measured');
});

test('I. a draft or stale staffing version fails closed at attribution', () => {
  // The mapping exists, so the failure is now the activation gate, not a gap.
  assert.throws(() => activeVersionForLead(staffingLead()), /is not active/);
  assert.throws(() => coldSendAttribution(staffingLead()), /is not active/);
  assert.doesNotThrow(() => coldSendAttribution({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' }));
  // An unregistered version id is refused outright.
  assert.throws(() => activeVersionForLead(staffingLead({ intendedCampaignVersion: 'industrial_staffing_v99' })), /Unknown campaign version/);
  // A staffing lead pointed at a dental version is refused as incompatible.
  assert.throws(() => activeVersionForLead(staffingLead({ intendedCampaignVersion: 'dental_v3_pay_per_booking' })), /incompatible/);
});

// ── M. legacy routing bypass is closed for staffing only ───────────────────
test('M. staffing can never take the legacy pre-routing bypass', () => {
  for (const lead of [
    { leadNiche: 'industrial_staffing', routingRequired: '' },
    { leadNiche: 'industrial_staffing', routingRequired: 'false' },
    { emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, routingRequired: '' },
    { leadNiche: 'Staffing Agency', routingRequired: '' },
  ]) {
    const gate = routedLeadReady(lead);
    assert.equal(gate.ok, false, JSON.stringify(lead));
    assert.notEqual(gate.legacy, true, 'staffing must not be treated as a legacy row');
  }
  // Legitimate legacy dental and roofing rows keep the bypass.
  assert.deepEqual(routedLeadReady({ leadNiche: 'dental', routingRequired: '' }), { ok: true, legacy: true });
  assert.deepEqual(routedLeadReady({ leadNiche: 'roofing', routingRequired: 'false' }), { ok: true, legacy: true });
  assert.deepEqual(routedLeadReady({}), { ok: true, legacy: true }, 'unrouted legacy rows are unaffected');
});

// ── N/O/P. routing and scheduler gating, inactive vs active ────────────────
test('N/O. routing and the scheduler refuse staffing while the campaign is a draft', () => {
  assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).ready, false);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].status, 'draft');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].activatedAt, null);
  const routed = routedLeadReady(staffingLead({ senderInboxId: 'primary' }));
  assert.equal(routed.ok, false);
  assert.match(routed.reason, /not approved for sending/);
  const inboxes = [{ id: 'primary', email: 'd@x.ca', sendEligible: true, deliveryImplemented: true }];
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, inboxes }).ok, false);
  assert.equal(campaignVersionsForRoute({ niche: 'industrial_staffing' }).length, 0);
});

test('P. with a ready template the same route passes only through the normal gates', () => {
  const inboxes = [{ id: 'primary', email: 'd@x.ca', sendEligible: true, deliveryImplemented: true }];
  // requireReady:false models the post-activation template without mutating state.
  const activated = validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, inboxes, requireReady: false });
  assert.equal(activated.ok, true, 'the route itself is valid; only readiness blocks it');
  assert.equal(activated.niche, 'industrial_staffing');
  assert.equal(activated.template.id, STAFFING_CAMPAIGN.emailTemplateId);
  // Every other gate still applies independently of readiness.
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, requireReady: false,
    inboxes: [{ id: 'primary', email: 'd@x.ca', sendEligible: false, deliveryImplemented: true }] }).ok, false);
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'nope',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, inboxes, requireReady: false }).ok, false);
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary',
    emailTemplateId: 'dental-guarantee-v1', inboxes, requireReady: false }).ok, false, 'wrong template for the niche');
});

// ── Y/Z. reporting isolation and dental/roofing untouched ──────────────────
test('Y. staffing reporting is attributed apart from dental', () => {
  assert.notEqual(familyForLead(staffingLead()), familyForLead({ leadNiche: 'dental' }));
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].family, 'industrial_staffing');
  assert.match(server, /if \(value\.includes\('staffing'\)\) return 'industrial_staffing';/,
    'facet grouping separates staffing before dental');
});

test('Z. dental and roofing behaviour is unchanged by the lead-type work', () => {
  assert.equal(normalizeNiche('dental'), 'dental');
  assert.equal(normalizeNiche('roofing'), 'roofing');
  assert.equal(leadTypeLabel('dental'), 'Dental');
  assert.equal(leadTypeLabel('roofing'), 'Roofing');
  assert.equal(templateById('dental-guarantee-v1').ready, true);
  assert.equal(familyForLead({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' }), 'dental_ai_receptionist');
  assert.equal(familyForLead({ leadNiche: 'roofing' }), 'roofing_survey');
  assert.equal(familyForLead({}), 'dental_ai_receptionist', 'documented legacy default is intentionally preserved');
  assert.equal(offerForLead({ leadNiche: 'dental' }).targetCustomer, 'dental practices');
  assert.ok(campaignVersionsForRoute({ niche: 'dental' }).length > 0, 'dental still has an active version');
});
