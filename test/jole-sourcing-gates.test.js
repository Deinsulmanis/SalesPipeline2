'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  JOLE_SECTORS, SEARCH_EXCLUDED_NAICS, SEARCH_EXCLUDED_SIC, BUYER_FAMILIES,
  joleCompanyDiscoveryParams, joleBuyerSearchParams, sectorScreen,
} = require('../integrations/sourcing/jole-search');
const { approvedCraftRole, usState, evaluateHiringEvidence, evidenceSearchKeywords } = require('../integrations/sourcing/hiring-evidence');
const { joleExclusionReason, JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 } = require('../integrations/sourcing/exclusions');

const NOW = Date.parse('2026-10-15T20:00:00Z');
const days = n => new Date(NOW - n * 86400000).toISOString();

test('all seven approved sectors are kept, by their exact ICP labels', () => {
  assert.deepEqual(JOLE_SECTORS.map(s => s.label), [
    'Industrial fabrication / machinery', 'Metals / mining / paper / heavy industrial',
    'Refining / petrochemical / LNG / chemical', 'Power / utilities', 'Shipyard / marine',
    'Pipeline / midstream', 'Oil & gas producers / operators',
  ]);
});

test('chemicals use the non-pharma subcodes; no broad 325, 221, 213 or 4883; every code is 2-5 digits', () => {
  const all = JOLE_SECTORS.flatMap(s => s.naics);
  assert.deepEqual(JOLE_SECTORS.find(s => s.id === 'refining_chemical').naics, ['324', '3251', '3252', '3253', '3255', '3259']);
  for (const banned of ['325', '3254', '3256', '221', '213', '4883', '23', '92']) assert.ok(!all.includes(banned), banned);
  assert.ok(all.every(code => /^\d{2,5}$/.test(code)));
  assert.deepEqual([...SEARCH_EXCLUDED_NAICS], ['5613']);
  assert.deepEqual([...SEARCH_EXCLUDED_SIC], ['7361', '7363']);
});

test('discovery parameters: hiring-site geography, trailing 30 days, staffing excluded', () => {
  const p = joleCompanyDiscoveryParams({ sectorId: 'shipyard_marine', now: NOW, page: 2 });
  assert.deepEqual(p.organization_naics_codes, ['33661']);
  assert.deepEqual(p.organization_job_locations, ['United States']);
  assert.equal(p.organization_locations, undefined, 'headquarters is not the ICP geography');
  assert.deepEqual(p.organization_job_posted_at_range, { min: '2026-09-15', max: '2026-10-15' });
  assert.deepEqual(p.not_organization_sic_codes, ['7361', '7363']);
  assert.equal(p.page, 2);
  assert.throws(() => joleCompanyDiscoveryParams({ sectorId: 'pharma' }), /unknown Jole sector/);
});

test('buyer families are the five approved roles, exact titles only', () => {
  assert.equal(BUYER_FAMILIES.length, 5);
  const p = joleBuyerSearchParams({ organizationIds: ['a'], familyId: 'hr_talent' });
  assert.equal(p.include_similar_titles, false);
  assert.ok(p.person_titles.includes('human resources manager'));
});

test('sector screen rejects pharma/consumer care and governments; holds solar and contractors', () => {
  assert.equal(sectorScreen({ name: 'Vertex Pharmaceuticals', domain: 'vrtx.com' }).reason, 'sector_pharma_biotech_consumer_care');
  assert.equal(sectorScreen({ name: 'Beauty Quest Group' }).decision, 'reject');
  assert.equal(sectorScreen({ name: 'City of Omaha', domain: 'cityofomaha.org' }).reason, 'sector_government');
  assert.equal(sectorScreen({ name: 'Water Dept', domain: 'lascruces.gov' }).reason, 'sector_government');
  assert.equal(sectorScreen({ name: 'Sol-Up Solar', siteText: 'Residential solar installation for homeowners' }).reason, 'sector_solar_installer');
  assert.equal(sectorScreen({ name: 'Acme Solar Power', siteText: 'utility-scale plant' }).decision, 'hold');
  assert.equal(sectorScreen({ name: 'Leafguard Brand Gutters' }).reason, 'sector_contractor_review');
  assert.equal(sectorScreen({ name: 'Kiely Construction' }).decision, 'hold');
  assert.equal(sectorScreen({ name: 'Acme Fab', siteText: 'We are a general contractor' }).reason, 'sector_contractor_review');
});

test('sector screen passes approved Phase 5 employers and never passes without website evidence', () => {
  for (const [name, domain, site] of [
    ['AAON', 'aaon.com', 'HVAC equipment manufacturer with plants in Tulsa'],
    ['Bollinger Shipyards', 'bollingershipyards.com', 'shipbuilding and repair'],
    ['Kinder Morgan', 'kindermorgan.com', 'pipeline and terminals energy infrastructure'],
    ['American Water', 'amwater.com', 'water utility services'],
    ['Louisville MSD', 'louisvillemsd.org', 'wastewater treatment plant utility'],
    ['Innophos', 'innophos.com', 'specialty phosphate chemicals for food and pharmaceutical customers'],
    ['Valero', 'valero.com', 'refining and renewable fuels'],
  ]) assert.equal(sectorScreen({ name, domain, siteText: site }).decision, 'pass', name);
  assert.equal(sectorScreen({ name: 'AAON', domain: 'aaon.com' }).reason, 'website_not_checked');
  assert.equal(sectorScreen({ name: 'AAON', siteText: 'Welcome. Cookie settings.' }).reason, 'website_no_industrial_evidence');
});

test('approved craft roles only; helpers, supervisors and office roles never count', () => {
  for (const [title, role] of [
    ['Class A Welder 1st shift', 'welders'], ['Welder - 2nd Shift', 'welders'], ['CNC Machinist II', 'machinists_cnc'],
    ['Industrial Electrician', 'electricians'], ['Maintenance Technician II', 'maintenance_technicians'],
    ['Heavy Equipment and Diesel Mechanic', 'mechanics'], ['I&E Technician', 'instrument_technicians'],
    ['Instrumentation Technician', 'instrument_technicians'], ['Shipfitter', 'fabricators_fitters'],
    ['Millwright', 'millwrights'], ['Journeyman Plumber-Pipefitter', 'pipefitters'], ['Pipe Fitter', 'pipefitters'],
  ]) assert.equal(approvedCraftRole(title), role, title);
  for (const title of ['Welder Helper', 'Electrical Apprentice', 'Maintenance Supervisor', 'Welding Engineer',
    'Maintenance Manager', 'General Laborer', 'Production Operator', 'Warehouse Associate', 'Welding Inspector'])
    assert.equal(approvedCraftRole(title), null, title);
});

test('US hiring site from the posting location', () => {
  assert.equal(usState('Tulsa, OK'), 'OK');
  assert.equal(usState('Houston, TX, United States'), 'TX');
  assert.equal(usState('United States'), 'US');
  assert.equal(usState('Monterrey, NL, Mexico'), null);
  assert.equal(usState('Toronto, ON'), null);
});

const posting = (over = {}) => ({ company: 'Hayden Industrial', title: 'Class A Welder', location: 'Tulsa, OK',
  url: 'https://www.linkedin.com/jobs/view/class-a-welder-at-hayden-industrial-1', postedAt: days(8), ...over });

test('verified evidence carries employer, role, site, URL and dates', () => {
  const r = evaluateHiringEvidence({ employer: { name: 'Hayden Industrial LLC', domain: 'haydenindustrial.com' }, postings: [posting()], now: NOW });
  assert.equal(r.status, 'verified');
  assert.equal(r.evidence.role, 'welders');
  assert.equal(r.evidence.state, 'OK');
  assert.match(r.evidence.url, /^https:/);
  assert.equal(r.evidence.postedAt, days(8));
  assert.equal(r.evidence.verifiedAt, new Date(NOW).toISOString());
});

test('evidence must be ≤30 days, dated, not future, US, public URL, approved role, same employer', () => {
  const e = { name: 'Hayden Industrial', domain: 'haydenindustrial.com' };
  const hold = postings => evaluateHiringEvidence({ employer: e, postings, now: NOW });
  assert.equal(hold([posting({ postedAt: days(31) })]).reason, 'no_qualifying_posting:stale');
  assert.equal(hold([posting({ postedAt: days(30) })]).status, 'verified');
  assert.equal(hold([posting({ postedAt: '' })]).reason, 'no_qualifying_posting:undated');
  assert.equal(hold([posting({ postedAt: new Date(NOW + 3 * 86400000).toISOString() })]).reason, 'no_qualifying_posting:future_dated');
  assert.equal(hold([posting({ location: 'Monterrey, Mexico' })]).reason, 'no_qualifying_posting:location_not_us');
  assert.equal(hold([posting({ url: 'http://example.com/job' })]).reason, 'no_qualifying_posting:no_public_url');
  assert.equal(hold([posting({ title: 'Welding Supervisor' })]).reason, 'no_qualifying_posting:role_not_approved');
  assert.equal(hold([posting({ company: 'Hayden Lumber' })]).reason, 'no_postings_for_this_employer');
  assert.equal(hold([]).reason, 'no_public_postings_found');
});

test('identity: the employer’s own careers domain counts; a name collision does not', () => {
  const e = { name: 'Acme Steel', domain: 'acmesteel.com' };
  assert.equal(evaluateHiringEvidence({ employer: e, now: NOW, postings: [posting({ company: 'Acme Steel Fabrication Group', url: 'https://careers.acmesteel.com/jobs/1' })] }).status, 'verified');
  assert.equal(evaluateHiringEvidence({ employer: e, now: NOW, postings: [posting({ company: 'Acme', url: 'https://www.linkedin.com/jobs/view/1' })] }).status, 'hold');
  assert.equal(evaluateHiringEvidence({ employer: { name: 'Austin Industrial' }, now: NOW, postings: [posting({ company: 'Austin Dynamics' })] }).status, 'hold');
});

test('Jole competitors named by Jorge are excluded by full name or domain only', () => {
  const r = company => joleExclusionReason(company, { currentClients: JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 });
  assert.equal(r({ name: 'Brock Group' }), 'competitor_overlap:Brock Group');
  assert.equal(r({ name: 'Austin Industrial, Inc.' }), 'competitor_overlap:Austin Industrial / Austin Industries');
  assert.equal(r({ name: 'Zachry Group' }), 'competitor_overlap:Zachry');
  assert.equal(r({ name: 'Turner Industries Group' }), 'competitor_overlap:Turner Industries');
  assert.equal(r({ name: 'Plant Services', domain: 'turner-industries.com' }), 'competitor_overlap:Turner Industries');
  for (const name of ['Austin Dynamics Inc.', 'Turner Machine Co', 'Brockway Mould', 'Zachary Steel Works'])
    assert.equal(r({ name }), null, name);
});

test('the onboarding current-client list is exactly Karpower, Kiewit Offshore Services and SpaceX, and each is excluded', () => {
  assert.deepEqual([...JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01], ['Karpower', 'Kiewit Offshore Services', 'SpaceX']);
  for (const name of JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01)
    assert.ok(joleExclusionReason({ name }, { currentClients: JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 }), name);
});

test('evidence search: name-only query, then the same name with the approved craft words', () => {
  assert.deepEqual(evidenceSearchKeywords('Lennox International Inc.'), [
    '"Lennox International"',
    '"Lennox International" welder OR millwright OR machinist OR electrician OR mechanic OR technician OR pipefitter OR fabricator OR fitter',
  ]);
});
