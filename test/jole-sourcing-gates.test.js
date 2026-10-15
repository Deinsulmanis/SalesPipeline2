'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  JOLE_SECTORS, SEARCH_EXCLUDED_NAICS, SEARCH_EXCLUDED_SIC, BUYER_FAMILIES,
  joleCompanyDiscoveryParams, joleBuyerSearchParams, sectorScreen, buyerFamilyOf, rankJoleContacts,
} = require('../integrations/sourcing/jole-search');
const { approvedCraftRole, usState, evaluateHiringEvidence, evidenceSearchKeywords, fieldServiceForCustomers } = require('../integrations/sourcing/hiring-evidence');
const { joleExclusionReason, joleExclusionCategory, JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 } = require('../integrations/sourcing/exclusions');

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
  assert.equal(p.organization_num_employees_ranges, undefined);
  assert.deepEqual(joleCompanyDiscoveryParams({ sectorId: 'shipyard_marine', now: NOW, sizeBand: 'small' }).organization_num_employees_ranges, ['1,200']);
  assert.deepEqual(joleCompanyDiscoveryParams({ sectorId: 'shipyard_marine', now: NOW, sizeBand: 'mid' }).organization_num_employees_ranges, ['201,1000']);
  assert.throws(() => joleCompanyDiscoveryParams({ sectorId: 'shipyard_marine', sizeBand: 'huge' }), /unknown size band/);
});

test('buyer families are the five approved roles, exact titles only, in the approved order', () => {
  assert.deepEqual(BUYER_FAMILIES.map(f => f.id), ['plant_operations', 'hr_talent', 'maintenance_reliability', 'superintendent_site', 'owner_executive']);
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
  // A longer posting name is a different company unless the employer's domain hosts it.
  assert.equal(evaluateHiringEvidence({ employer: { name: 'Koch', domain: 'kochinc.com' }, now: NOW, postings: [posting({ company: 'KOCH Finishing Systems' })] }).status, 'hold');
  assert.equal(evaluateHiringEvidence({ employer: { name: 'Atlas Copco' }, now: NOW, postings: [posting({ company: 'Atlas Copco Group' })] }).status, 'verified');
  assert.equal(evaluateHiringEvidence({ employer: { name: 'Austal' }, now: NOW, postings: [posting({ company: 'Austal USA' })] }).status, 'verified');
});

test('Jole competitors named by Jorge are excluded by full name or domain only', () => {
  const r = company => joleExclusionReason(company, { currentClients: JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 });
  assert.equal(r({ name: 'Brock Group' }), 'competitor_service_provider:Brock Group');
  assert.equal(r({ name: 'Austin Industrial, Inc.' }), 'competitor_service_provider:Austin Industrial / Austin Industries');
  assert.equal(r({ name: 'Zachry Group' }), 'competitor_service_provider:Zachry');
  assert.equal(r({ name: 'Turner Industries Group' }), 'competitor_service_provider:Turner Industries');
  assert.equal(r({ name: 'Plant Services', domain: 'turner-industries.com' }), 'competitor_service_provider:Turner Industries');
  for (const name of ['Austin Dynamics Inc.', 'Turner Machine Co', 'Brockway Mould', 'Zachary Steel Works'])
    assert.equal(r({ name }), null, name);
});

test('current clients and competitors are separate categories', () => {
  const r = name => joleExclusionReason({ name }, { currentClients: JOLE_CURRENT_CLIENTS_ONBOARDING_2026_10_01 });
  for (const name of ['Kiewit Offshore Services', 'Kiewit Offshore Services Ltd', 'KOS', 'SpaceX', 'Space Exploration Technologies Corp', 'Karpower'])
    assert.equal(joleExclusionCategory(r(name)), 'current_client', name);
  for (const name of ['Brock Group', 'Austin Industrial', 'Zachry Group', 'Turner Industries'])
    assert.equal(joleExclusionCategory(r(name)), 'competitor_service_provider', name);
  assert.equal(joleExclusionCategory(r('Acme Staffing Services')), 'staffing_firm');
  assert.equal(joleExclusionCategory(null), null);
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

test('buyer family of a title: approved families only', () => {
  for (const [title, family] of [
    ['Plant Manager', 'plant_operations'], ['Vice President of Operations', 'plant_operations'], ['General Manager', 'plant_operations'],
    ['Senior Human Resources Manager', 'hr_talent'], ['HR Operations Manager', 'hr_talent'], ['Talent Acquisition Manager', 'hr_talent'],
    ['Maintenance Superintendent', 'maintenance_reliability'], ['Reliability Manager', 'maintenance_reliability'],
    ['Site Manager', 'superintendent_site'], ['Superintendent', 'superintendent_site'], ['President', 'owner_executive'], ['Owner', 'owner_executive'],
  ]) assert.equal(buyerFamilyOf(title), family, title);
  for (const title of ['HR Coordinator', 'Maintenance Technician', 'Recruiter', 'Sales Manager', 'Process Engineer', 'Executive Assistant to the President',
    'Sales Operations Manager', 'Finance Operations Manager', 'IT Site Manager', 'Technical Maintenance Manager(Retired)', 'Vice President, Operational Technology', 'Treasury Operations Manager'])
    assert.equal(buyerFamilyOf(title), null, title);
});

test('contact order: family, then exact site, region, state, then non-catch-all', () => {
  const site = { city: 'Tulsa', state: 'OK' };
  const c = (id, title, city, state, catchAll, extra = {}) => ({ id, title, city, state, catchAll, ...extra });
  const { ranked, ineligible } = rankJoleContacts([
    c('hr-exact', 'HR Manager', 'Tulsa', 'OK', false),
    c('plant-state-catchall', 'Plant Manager', 'Okmulgee', 'OK', true),
    c('plant-exact-catchall', 'Operations Manager', 'Tulsa', 'OK', true),
    c('plant-exact', 'Plant Manager', 'Tulsa', 'OK', false),
    c('plant-region', 'Production Manager', 'Broken Arrow', 'OK', false, { siteTie: 'REGION' }),
    c('maint-exact', 'Maintenance Manager', 'Tulsa', 'OK', false),
    c('super-exact', 'Superintendent', 'Tulsa', 'OK', false),
    c('owner', 'President', 'Tulsa', 'OK', false),
    c('analyst', 'HR Analyst', 'Tulsa', 'OK', false),
  ], { site, employeeCount: 450 });
  assert.deepEqual(ranked.map(r => r.contact.id), ['plant-exact', 'plant-exact-catchall', 'plant-region', 'plant-state-catchall', 'hr-exact', 'maint-exact', 'super-exact', 'owner']);
  assert.deepEqual(ineligible.map(i => i.reason), ['not_an_approved_buyer']);
});

test('owner / executive only at small and mid companies, or as a true site executive', () => {
  const owner = { id: 'o', title: 'President', city: 'Tulsa', state: 'OK' };
  assert.equal(rankJoleContacts([owner], { employeeCount: 5000 }).ineligible[0].reason, 'owner_executive_large_company');
  assert.equal(rankJoleContacts([owner], {}).ineligible[0].reason, 'owner_executive_size_unknown');
  assert.equal(rankJoleContacts([owner], { employeeCount: 1000 }).ranked.length, 1);
  assert.equal(rankJoleContacts([{ id: 's', title: 'President, Port Arthur Refinery', siteTie: 'EXACT' }], { employeeCount: 20000 }).ranked.length, 1);
});

test('field service for customers is contractor-for-hire work; own-site roles pass', () => {
  for (const posting of [
    { title: 'Field Service Technician' }, { title: 'Traveling Welder' }, { title: 'Service Technician - Cranes' },
    { title: 'Welder', description: 'Perform repairs at customer sites across the Gulf Coast.' },
    { title: 'Millwright', description: 'Travel up to 75% to client facilities. Per diem provided.' },
    { title: 'Electrician', description: 'This role requires 50% travel.' },
  ]) assert.equal(fieldServiceForCustomers(posting), true, JSON.stringify(posting));
  for (const posting of [
    { title: 'Manufacturing Welder', description: 'Weld components to manufacture products at our Ville Platte plant.' },
    { title: 'Welder Fitter III', description: 'Konecranes serves a broad range of customers across multiple industries. Weld structural steel used in overhead crane manufacturing. Travel insurance.' },
    { title: 'Field Technician', description: 'Operate and maintain our compressor stations.' },
    { title: 'Maintenance Technician', description: 'Occasional travel (10%) to sister plants.' },
  ]) assert.equal(fieldServiceForCustomers(posting), false, JSON.stringify(posting));
  const e = { name: 'Hayden Industrial' };
  assert.equal(evaluateHiringEvidence({ employer: e, now: NOW, postings: [posting({ title: 'Field Service Welder' })] }).reason, 'no_qualifying_posting:field_service_for_customers');
  assert.equal(evaluateHiringEvidence({ employer: e, now: NOW, requireDescription: true, postings: [posting()] }).reason, 'no_qualifying_posting:description_not_checked');
  assert.equal(evaluateHiringEvidence({ employer: e, now: NOW, requireDescription: true, postings: [posting({ description: 'Shop welding at our Tulsa plant.' })] }).status, 'verified');
});

test('large employers: only exact-site or regional buyers; same state is not a site connection', () => {
  const site = { city: 'Macon', state: 'GA' };
  const contacts = [
    { id: 'exact', title: 'Plant Manager', city: 'Macon', state: 'GA', catchAll: false },
    { id: 'region', title: 'HR Manager', siteTie: 'REGION', catchAll: false },
    { id: 'state', title: 'Maintenance Manager', city: 'Atlanta', state: 'GA', catchAll: false },
  ];
  const large = rankJoleContacts(contacts, { site, employeeCount: 20000 });
  assert.deepEqual(large.ranked.map(r => r.contact.id), ['exact', 'region']);
  assert.deepEqual(large.ineligible.map(i => i.reason), ['no_site_connection_large_employer']);
  assert.equal(rankJoleContacts(contacts, { site }).ranked.length, 2, 'unknown size is treated as large');
  assert.equal(rankJoleContacts(contacts, { site, employeeCount: 300 }).ranked.length, 3);
});

test('commuting region: places within 50 miles, nearest first', () => {
  const { nearbyPlaces, findPlace, haversineMiles } = require('../integrations/sourcing/geo');
  const places = [
    { state: 'IL', name: 'Peoria city', lat: 40.7520, lon: -89.6170 },
    { state: 'IL', name: 'East Peoria city', lat: 40.6720, lon: -89.5790 },
    { state: 'IL', name: 'Manito village', lat: 40.4260, lon: -89.7790 },
    { state: 'IL', name: 'Chicago city', lat: 41.8380, lon: -87.6860 },
  ];
  const peoria = findPlace(places, { city: 'Peoria', state: 'IL' });
  assert.ok(peoria);
  assert.deepEqual(nearbyPlaces(peoria, places).map(p => p.name), ['East Peoria', 'Manito']);
  assert.ok(haversineMiles(peoria, places[3]) > 120);
  const macon = { state: 'GA', name: 'Macon-Bibb County consolidated government (balance)', lat: 32.8, lon: -83.7 };
  assert.equal(findPlace([macon], { city: 'Macon', state: 'GA' }), macon);
  assert.equal(findPlace([macon], { city: 'Bibb', state: 'GA' }), null);
});
