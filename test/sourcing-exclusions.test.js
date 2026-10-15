'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nationalBrandMatch, joleExclusionReason, LEGACY_NATIONAL } = require('../integrations/sourcing/exclusions');

const national = (name, domain = '') => nationalBrandMatch({ name, domain });
const jole = (company, currentClients = []) => joleExclusionReason(company, { currentClients });

test('every name the legacy Batch 3 NATIONAL list rejected is still rejected', () => {
  for (const name of [
    'Randstad USA', 'ManpowerGroup', 'Adecco Staffing', 'EmployBridge', 'TrueBlue', 'Aerotek', 'Actalent',
    'Kelly Services', 'Insight Global', 'Kforce', 'Robert Half', 'Labor Ready', 'PeopleReady', 'Staffmark',
    'TEKsystems', 'Allegis Group', 'Apex Systems', 'Express Employment Professionals', 'Express Personnel',
    'ASGN', 'Volt Workforce Solutions', 'Snelling Staffing', 'PDS Tech', 'PROMAN Skilled Trades',
    'Prostar Staffing', 'Integrity Staffing Services', 'ATR International', 'AppleOne', 'Labor Finders',
    'Elwood Staffing', 'PrideStaff', 'Spherion',
  ]) {
    assert.ok(LEGACY_NATIONAL.test(name), `legacy regex should match ${name}`);
    assert.ok(national(name), `${name} must stay excluded`);
  }
});

test('franchise and branch names of excluded brands are rejected with the city appended', () => {
  for (const [name, brand] of [
    ['Express Employment Omaha', 'Express Employment Professionals'],
    ['Express Employment Professionals of Omaha', 'express employment professionals'],
    ['Express Employment - Tulsa South', 'Express Employment Professionals'],
    ['ExpressPros Boise', 'Express Employment Professionals'],
    ['Express Pros of Fort Worth', 'Express Employment Professionals'],
    ['Pride-Staff Fresno', 'pride staff'],
    ['Labor-Finders of Tampa', 'labor finders'],
    ['Spherion Staffing of Mid-America', 'spherion'],
    ['Integrity Staffing Solutions - Wilmington', 'Integrity Staffing Solutions'],
    ['People Ready Branch 4211', 'people ready'],
  ]) {
    const match = national(name);
    assert.ok(match, `${name} must be rejected`);
    assert.equal(match.brand.toLowerCase(), brand.toLowerCase(), name);
  }
});

test('a franchise on its own domain is caught by the brand domain only when the domain is the brand’s', () => {
  assert.equal(national('Omaha Office', 'https://www.expresspros.com/omaha').rule, 'brand_domain');
  assert.equal(national('Branch 12', 'jobs.integritystaffing.com').brand, 'Integrity Staffing Solutions');
  assert.equal(national('Express Welding', 'expresswelding.com'), null);
});

test('unrelated companies that share a generic word are NOT rejected', () => {
  for (const name of [
    'Express Welding & Fabrication', 'Express Scripts', 'Express Oil Change', 'Integrity Steel Erectors',
    'Integrity Staffing Group', 'Kelly Tractor Co', 'Volt Electric', 'Spectrum Fabrication', 'Atrium Metals',
    'Pride Manufacturing', 'People First Machining', 'Labor Management Partners', 'Apple Valley Steel',
    'Robert Halfmann Welding', 'Elwood Industries', 'Snell Machine Works', 'Kos Manufacturing Partners',
  ]) assert.equal(national(name), null, `${name} must not be treated as a national staffing brand`);
});

test('Jole: staffing, recruiting and labor-service firms are excluded (code, brand or name)', () => {
  assert.equal(jole({ name: 'Acme Industrial', sicCodes: ['7363'] }), 'staffing_firm_sic');
  assert.equal(jole({ name: 'Acme Industrial', naicsCodes: ['561320'] }), 'staffing_firm_naics');
  assert.match(jole({ name: 'Express Employment Omaha' }), /^staffing_firm_national_brand:/);
  assert.equal(jole({ name: 'Integrity Staffing Group' }), 'staffing_firm_name');
  assert.equal(jole({ name: 'Gulf Coast Recruiting LLC' }), 'staffing_firm_name');
  assert.equal(jole({ name: 'Delta Labor Services' }), 'staffing_firm_name');
});

test('Jole: SpaceX family, Kiewit family / KOS and Karpower are excluded, look-alikes are not', () => {
  assert.equal(jole({ name: 'Space Exploration Technologies Corp' }), 'current_client:SpaceX');
  assert.equal(jole({ name: 'SpaceX Starbase', domain: 'spacex.com' }), 'current_client:SpaceX');
  assert.equal(jole({ name: 'Kiewit Power Constructors' }), 'current_client:Kiewit / KOS');
  assert.equal(jole({ name: 'Kiewit Offshore Services' }), 'current_client:Kiewit / KOS');
  assert.equal(jole({ name: 'KOS', domain: 'kiewit.com' }), 'current_client:Kiewit / KOS');
  assert.equal(jole({ name: 'KOS LLC' }), 'current_client:Kiewit / KOS');
  assert.equal(jole({ name: 'Karpowership US' }), 'current_client:Karpower');
  for (const name of ['Space Coast Fabrication', 'Kos Manufacturing Partners', 'Kiew Machine', 'Karpenter Steel'])
    assert.equal(jole({ name }), null, name);
});

test('Jole: current clients are excluded by name or domain, and the list is mandatory', () => {
  const clients = [{ name: 'Acme Steel', domain: 'acmesteel.com' }, 'gulfmetals.com'];
  assert.equal(jole({ name: 'Acme Steel LLC' }, clients), 'current_client:supplied_list');
  assert.equal(jole({ name: 'Other', domain: 'careers.acmesteel.com' }, clients), 'current_client:supplied_list');
  assert.equal(jole({ name: 'Gulf Metals', domain: 'gulfmetals.com' }, clients), 'current_client:supplied_list');
  assert.equal(jole({ name: 'Acme Steel Fabricators', domain: 'acmefab.com' }, clients), null);
  assert.throws(() => joleExclusionReason({ name: 'Acme' }), /current-client exclusion list is required/);
  assert.throws(() => joleExclusionReason({ name: 'Acme' }, {}), /required/);
});

test('Jole: an in-ICP industrial employer passes', () => {
  for (const company of [
    { name: 'AAON', domain: 'aaon.com', naicsCodes: ['333415'] },
    { name: '110 Metalworks', domain: '110metalworks.com' },
    { name: 'Workforce Fabrication Inc', domain: 'workforcefab.com' },
    { name: 'Bollinger Shipyards', domain: 'bollingershipyards.com' },
  ]) assert.equal(jole(company), null, company.name);
});
