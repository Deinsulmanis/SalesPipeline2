'use strict';

// Jole as a second client on ScaleLab's system: research profile and role
// cleaning at import, personalization, campaign family and attribution, queue
// admission, the agent's managed-client branches, import batches — and that
// nothing can send while Jole's switch is off. ScaleLab's resolution and copy
// paths are asserted unchanged alongside.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { cleanHiringRole } = require('../integrations/clients/hiring-roles');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile, readLeadProfile } = require('../integrations/clients/lead-profile');
const { renderClientLeadEmail, clientPersonalizationState, isClientTemplateId } = require('../integrations/clients/client-email');
const { validateClientLeadImport, importClientLeads } = require('../integrations/clients/lead-import');
const { resolveLeadFamily, coldSendAttribution, isManagedFamily } = require('../integrations/campaign-versions');
const { queueEligibility } = require('../integrations/outreach-queue');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { campaignsForClient, clientCampaign } = require('../integrations/clients/campaigns');
const { createMemoryImportBatchStore, processPendingImportBatches } = require('../integrations/clients/import-batches');
const { clientSendBlock } = require('../integrations/clients/send-policy');
const { getClient } = require('../integrations/clients/registry');

const CAMPAIGN = 'jole-btx-employer-acquisition';
const NOW = Date.parse('2026-10-20T15:00:00Z');
const ENV = Object.freeze({
  JOLE_LANDING_PAGE_URL: 'https://jolebtx.netlify.app/industrial-staffing/',
  JOLE_COMMERCIAL_MAILING_ADDRESS: '1313 E Alton Gloor, Suite I-2, Brownsville, TX 78526',
  // ScaleLab's address must never reach Jole's footer.
  COMMERCIAL_MAILING_ADDRESS: '500 ScaleLab Way, Vancouver, BC V6B 1A1',
});
const research = (extra = {}) => ({
  first_name: 'Theodore', last_name: 'Jeske', title: 'President', buyer_type: 'owner/executive',
  company_domain: '110metalworks.com', contact_city: 'Liverpool', contact_state: 'NY', sector: 'Industrial fabrication / machinery',
  priority_tier: 'Tier A', site_tie: 'EXACT', email_domain_catch_all: 'N', email_status: 'verified',
  hiring_site: 'Liverpool, NY', verified_role: 'Tig Welder - 2nd Shift', secondary_role: 'CNC Machinist II - Nights',
  posting_date: '2026-09-28', hiring_evidence_url: 'https://example.org/jobs/1', relevant_roles_30d: '3', core_trade_roles_30d: '2',
  why_contact_is_relevant: 'President at 110 Metalworks; posted Tig Welder at Liverpool, NY.', apollo_person_id: 'p1', apollo_organization_id: 'o1',
  verified_at: '2026-10-07', ...extra,
});
const joleLead = (extra = {}, researchExtra = {}) => ({
  id: 'jl1', company: '110 Metalworks', contactName: 'Theodore Jeske', email: 'tjeske@110metalworks.com', city: 'Liverpool, NY',
  website: 'http://110metalworks.com', tradeType: 'Industrial fabrication / machinery', stage: 'Import', emailStatus: '', emailStep: '',
  lastEmailedAt: '', notes: '', leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
  intendedCampaignVersion: CAMPAIGN, campaign: CAMPAIGN, routingRequired: 'true', senderInboxId: '', clientId: 'jole',
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow(research(researchExtra)) })),
  ...extra,
});

// ── Role cleaning ───────────────────────────────────────────────────────────
test('roles: raw posting titles reduce to the trade they name, nothing more', () => {
  const cases = {
    'Welder - 2nd Shift': 'Welders', 'CNC Machinist II - Nights': 'CNC Machinists',
    'Maintenance Technician - Weekend Shift': 'Maintenance Technicians', 'Electrical & Instrumentation Technician': 'I&E Technicians',
    'Welder/Fabricator': 'Welders and Fabricators', 'Lead Mechanic - Shipfitter (2nd Shift) - Steel America (Job ID:1504)': 'Shipfitters',
    'Welder-2nd Shift-$3.00/hour Shift Premium': 'Welders', 'INDUSTRIAL ELECTRICIAN - FULL TIME - 2ND SHIFT': 'Industrial Electricians',
    'Journeyman Plumber-Pipefitter': 'Journeyman Plumbers and Pipefitters', 'FCAW / GMAW / Arc Welder Days & Nights *': 'Welders',
  };
  for (const [raw, clean] of Object.entries(cases)) assert.deepEqual([cleanHiringRole(raw).status, cleanHiringRole(raw).clean], ['clean', clean], raw);
});

test('roles: helpers, supervisors, bare "Technician" and multi-role titles go to review, never guessed', () => {
  for (const raw of ['Outside Machinist Helper', 'Shop Helper', 'Supervisor- Electrical, Instrumentation, & Controls Maintenance',
    'Technician', 'Foreman', 'Welder/Fitter/Field Service Technician', 'Instrumentation Apprentice', '']) {
    const result = cleanHiringRole(raw);
    assert.equal(result.status, 'review', raw);
    assert.equal(result.clean, null, raw);
    assert.equal(result.raw, raw.trim());
  }
});

// ── Lead profile ────────────────────────────────────────────────────────────
test('profile: research is kept in full with raw AND clean roles; ready when a role and location exist', () => {
  const profile = readLeadProfile(joleLead());
  assert.equal(profile.clientId, 'jole');
  assert.deepEqual(profile.hiring.roles.map(role => [role.raw, role.clean]), [['Tig Welder - 2nd Shift', 'TIG Welders'], ['CNC Machinist II - Nights', 'CNC Machinists']]);
  assert.deepEqual(profile.personalization, { status: 'ready', roles: ['TIG Welders', 'CNC Machinists'], location: 'Liverpool, NY' });
  assert.equal(profile.company.tier, 'Tier A');
  assert.equal(profile.hiring.siteTie, 'EXACT');
  assert.equal(profile.email.domainCatchAll, false);
  assert.equal(profile.contact.title, 'President');
  assert.equal(profile.source.apolloPersonId, 'p1');
});

test('profile: no usable role means needs_review; a compound role never joins a two-role opener', () => {
  assert.equal(readLeadProfile(joleLead({}, { verified_role: 'Shop Helper', secondary_role: 'Technician' })).personalization.status, 'needs_review');
  const compound = readLeadProfile(joleLead({}, { verified_role: 'Welder/Fabricator', secondary_role: 'Machinist' }));
  assert.deepEqual(compound.personalization.roles, ['Welders and Fabricators']);
});

test('import: research rows land in campaign_notes; the lead is still a plain Import lead of Jole', () => {
  const row = { company: '110 Metalworks', contactName: 'Theodore Jeske', email: 'tjeske@110metalworks.com', city: 'Liverpool, NY', tradeType: 'Industrial fabrication / machinery', research: research() };
  const result = validateClientLeadImport({ clientId: 'jole', campaignId: CAMPAIGN, rows: [row], env: {} });
  assert.equal(result.accepted, 1);
  const lead = result.leads[0];
  assert.equal(readLeadProfile(lead).personalization.status, 'ready');
  assert.deepEqual([lead.stage, lead.clientId, lead.senderInboxId, lead.emailStep, lead.emailStatus], ['Import', 'jole', '', '', '']);
  assert.equal(resolveLeadFamily(lead).family, 'jole_employer');
});

// ── Personalization ─────────────────────────────────────────────────────────
test('personalization: renders the approved copy from stored research and Jole\'s own config', () => {
  const lead = joleLead();
  const t1 = renderClientLeadEmail(lead, 1, { env: ENV, now: NOW });
  assert.equal(t1.subject, 'TIG Welders');
  assert.match(t1.body, /^Hi Theodore,\n\nSaw 110 Metalworks is hiring TIG Welders and CNC Machinists in Liverpool, NY\./);
  assert.match(t1.body, /Jorge Guerrero\nCEO\nJole BTX LLC\n1313 E Alton Gloor, Suite I-2, Brownsville, TX 78526/);
  assert.doesNotMatch(t1.body, /ScaleLab Way|scalelab/i);
  const t2 = renderClientLeadEmail(lead, 2, { env: ENV, now: NOW });
  assert.match(t2.body, /https:\/\/jolebtx\.netlify\.app\/industrial-staffing\//);
  assert.equal(clientPersonalizationState(lead, { env: ENV, now: NOW }).status, 'ready');
});

test('personalization: fails closed — no profile, review, stale evidence, or missing Jole config', () => {
  assert.throws(() => renderClientLeadEmail(joleLead({ campaign_notes: '' }), 1, { env: ENV, now: NOW }), /research profile/);
  assert.throws(() => renderClientLeadEmail(joleLead({}, { verified_role: 'Shop Helper', secondary_role: '' }), 1, { env: ENV, now: NOW }), /needs review/);
  const stale = Date.parse('2026-12-01T15:00:00Z');
  assert.throws(() => renderClientLeadEmail(joleLead(), 1, { env: ENV, now: stale }), /older than 45 days/);
  assert.equal(clientPersonalizationState(joleLead(), { env: ENV, now: stale }).status, 'stale');
  // Only Jole's variables: ScaleLab's COMMERCIAL_MAILING_ADDRESS never substitutes.
  assert.throws(() => renderClientLeadEmail(joleLead(), 1, { env: { COMMERCIAL_MAILING_ADDRESS: ENV.COMMERCIAL_MAILING_ADDRESS }, now: NOW }), /mailing address/);
  assert.equal(clientPersonalizationState(joleLead(), { env: {}, now: NOW }).status, 'config_missing');
});

// ── Campaign family, attribution, routing ───────────────────────────────────
test('family: a Jole lead resolves through Jole\'s registry with full attribution; ScaleLab families are unchanged', () => {
  const lead = joleLead();
  assert.equal(resolveLeadFamily(lead).family, 'jole_employer');
  assert.equal(isManagedFamily('jole_employer'), true);
  const attribution = coldSendAttribution(lead, 1);
  assert.deepEqual([attribution.campaignVersion, attribution.campaignFamily, attribution.copyVersion, attribution.sequenceId],
    ['jole_industrial_employer_acquisition_v1', 'jole_employer', 'jole_industrial_employer_v1', 'jole_employer_cold']);
  // A lead whose owner contradicts the campaign, or that names a ScaleLab family, is unrouted.
  assert.equal(resolveLeadFamily({ ...lead, clientId: 'scalelab' }).family, 'unrouted');
  assert.equal(resolveLeadFamily({ ...lead, emailTemplateId: 'industrial-staffing-employer-v1' }).family, 'unrouted');
  assert.equal(resolveLeadFamily({ leadNiche: 'industrial_staffing', emailTemplateId: 'industrial-staffing-employer-v1', intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1' }).family, 'industrial_staffing');
  assert.equal(isManagedFamily('industrial_staffing'), false);
});

test('campaigns: Jole\'s working view is one campaign; archived contractor campaigns are kept but never routable', () => {
  assert.deepEqual(campaignsForClient('jole').map(campaign => [campaign.id, campaign.label, campaign.status]),
    [[CAMPAIGN, 'Jole BTX — Industrial Employers | MFG + Heavy Industry', 'approved']]);
  assert.equal(campaignsForClient('jole', { includeArchived: true }).length, 4);
  assert.match(String(clientCampaign(CAMPAIGN).icp.summary), /not staffing agencies/);
});

// ── Queue admission ─────────────────────────────────────────────────────────
test('queue: a Jole lead is admissible only when all three touches render from its stored research', () => {
  const lead = joleLead();
  const base = { leads: [lead], activities: [], boardLeads: [], suppressedEmails: new Set() };
  assert.equal(queueEligibility(lead, { ...base, env: ENV }).ok, true);
  assert.match(queueEligibility(lead, { ...base, env: {} }).reason, /landing page|mailing address/);
  const held = joleLead({}, { verified_role: 'Foreman', secondary_role: '' });
  assert.match(queueEligibility(held, { ...base, leads: [held], env: ENV }).reason, /needs review/);
  assert.match(queueEligibility(lead, { ...base, env: ENV, suppressedEmails: new Set([lead.email]) }).reason || '', /suppress|unsubscrib|opt/i);
});

test('send: a fully personalised, approved Jole lead with a sender is still refused while Jole sending is off', () => {
  assert.equal(clientSendBlock('jole', ENV).code, 'client_sending_disabled');
  assert.equal(clientSendBlock('jole', { ...ENV, CLIENT_SENDING_AUTHORIZED: 'jole' }).code, 'client_sending_disabled', 'sending.enabled is false in code');
  assert.equal(getClient('jole').capacity.dailyCap, 0);
  assert.equal(routedLeadReady(joleLead({ senderInboxId: 'jole_team1' }), ENV).ok, false);
});

// ── Agent: one delivery path, client copy ───────────────────────────────────
test('agent: managed leads render client copy before any ScaleLab branch, defer follow-ups, skip intent mail, send as Jorge', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const managed = agent.indexOf('if (isManagedFamily(familyForLead(lead))) {');
  const roofing = agent.indexOf('} else if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) {');
  const dental = agent.indexOf('built = await buildEmail(lead);');
  assert.ok(managed > 0 && managed < roofing && roofing < dental, 'managed branch comes first; buildEmail is unreachable for a managed lead');
  assert.match(agent, /if \(isClientTemplateId\(lead\.emailTemplateId\)\) \{\s*\/\/ A managed client's follow-up/);
  assert.match(agent, /CAMPAIGN_FAMILY\.UNROUTED \|\| isManagedFamily\(family\)\) continue;/);
  assert.match(agent, /client delivery body differs from its approved copy/);
  assert.match(agent, /fromName: fromNameForSender\(sender\)/);
  assert.match(agent, /return client\.isDefault \? FROM_NAME : \(client\.senderIdentity\?\.fromName \|\| client\.displayName\)/);
  assert.equal(getClient('jole').senderIdentity.fromName, 'Jorge Guerrero');
  assert.equal(isClientTemplateId('industrial-staffing-employer-v1'), false);
});

// ── Import batches ──────────────────────────────────────────────────────────
test('batches: only pending batches import, once, through the same import; staged ones wait for an operator', async () => {
  const store = createMemoryImportBatchStore([
    { batch_id: 'b1', client_id: 'jole', campaign_id: CAMPAIGN, status: 'pending',
      rows: [{ company: '110 Metalworks', contactName: 'Theodore Jeske', email: 'tjeske@110metalworks.com', city: 'Liverpool, NY', research: research() }] },
    { batch_id: 'b2', client_id: 'jole', campaign_id: CAMPAIGN, status: 'staged', rows: [{ company: 'X', email: 'x@x-co.com' }] },
  ]);
  const written = [];
  const importLeads = options => importClientLeads({
    ...options, env: {}, newId: () => `id${written.length + 1}`,
    readCorpus: async () => ({ leads: [...written], suppressedEmails: new Set() }),
    readClientSuppressions: async () => ({ available: true, entries: [] }),
    appendLeads: async leads => { written.push(...leads); },
  });
  const log = { log() {}, error() {} };
  const first = await processPendingImportBatches({ store, importLeads, log });
  assert.deepEqual(first.map(o => [o.id, o.status, o.written]), [['b1', 'done', 1]]);
  assert.equal(store.rows.find(row => row.batch_id === 'b2').status, 'staged');
  assert.equal(store.rows.find(row => row.batch_id === 'b1').result.written, 1);
  assert.deepEqual(await processPendingImportBatches({ store, importLeads, log }), [], 'a done batch never runs again');
  assert.equal(written.length, 1);
  assert.equal(readLeadProfile(written[0]).personalization.status, 'ready');
});

test('batches: a batch that fails (e.g. suppression list unreadable) is recorded failed and writes nothing', async () => {
  const store = createMemoryImportBatchStore([{ batch_id: 'b3', client_id: 'jole', campaign_id: CAMPAIGN, rows: [{ company: 'A', email: 'a@a-co.com' }] }]);
  const importLeads = options => importClientLeads({
    ...options, env: {}, newId: () => 'x', readCorpus: async () => ({ leads: [], suppressedEmails: new Set() }),
    readClientSuppressions: async () => ({ available: false, reason: 'client ledger is disabled' }),
    appendLeads: async () => { throw new Error('must not write'); },
  });
  const [outcome] = await processPendingImportBatches({ store, importLeads, log: { log() {}, error() {} } });
  assert.equal(outcome.status, 'failed');
  assert.match(store.rows[0].error, /client_suppression_unavailable/);
});
