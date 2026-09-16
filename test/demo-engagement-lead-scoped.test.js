'use strict';

// The dashboard's demo engagement is lead-scoped.
//
// "Demo played" and the play count were derived from the DemoPlays company
// column, so one visitor's session on ONE Smili Dental location's proposal page
// marked all four locations engaged and rendered the identical "2 · 1 open" on
// every row. Token-first attribution already fixed which lead a play may create
// a pair for; the read path had never been moved and kept its own answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { aggregateDemoPlays, attributeDemoPlays, demoPlayForLead, proposalTokenFor } = require('../integrations/demo-attribution');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

// server.js: cleanCompanyName + lowercase alphanumerics.
function cleanCompanyName(raw) {
  if (!raw) return '';
  let cutAt = raw.length;
  for (const sep of ['|', ' - ', ' • ', ' · ', ' – ', ' — ']) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) cutAt = Math.min(cutAt, idx);
  }
  return raw.slice(0, cutAt).trim() || raw.trim();
}
const openKey = company => cleanCompanyName(company || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');

const leads = [
  { id: 'midtown', company: 'Smili Dental - Midtown', email: 'info@mt.test' },
  { id: 'powell', company: 'Smili Dental - Powell River', email: 'info@pr.test' },
  { id: 'pine', company: 'Smili Dental - Pine Centre Mall', email: 'info@pcm.test' },
  { id: 'southridge', company: 'Smili Dental - Southridge', email: 'info@srd.test' },
];
const header = ['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type', 'lead_token'];
const engagedIds = rows => {
  const attribution = attributeDemoPlays(leads, aggregateDemoPlays(rows, { companyKey: openKey }), { companyKey: openKey });
  return leads.filter(lead => Boolean(demoPlayForLead(attribution, lead.id))).map(lead => lead.id);
};

test('a tokened session credits exactly the lead that was listening', () => {
  const token = proposalTokenFor('midtown');
  const rows = [header,
    ['2026-09-14T18:40:29.887Z', 'Smili Dental', 'Dental clinic', '208.181.179.150', 'Chrome', 'intro', token],
    ['2026-09-14T18:40:43.453Z', 'Smili Dental', 'Dental clinic', '208.181.179.150', 'Chrome', 'demo', token],
  ];
  assert.deepEqual(engagedIds(rows), ['midtown']);
});

test('a token-less session on a shared brand credits nobody, rather than everybody', () => {
  const rows = [header,
    ['2026-09-14T18:40:29.887Z', 'Smili Dental', 'Dental clinic', '208.181.179.150', 'Chrome', 'intro', ''],
    ['2026-09-14T18:40:43.453Z', 'Smili Dental', 'Dental clinic', '208.181.179.150', 'Chrome', 'demo', ''],
  ];
  assert.deepEqual(engagedIds(rows), []);
});

test('a token-less session on a company only one lead owns still credits that lead', () => {
  const solo = [{ id: 'solo', company: 'Eagle Point Dental', email: 'info@epd.test' }];
  const rows = [header, ['2026-08-19T18:53:08.130Z', 'Eagle Point Dental', 'Dentist', '1.2.3.4', 'Chrome', 'demo', '']];
  const attribution = attributeDemoPlays(solo, aggregateDemoPlays(rows, { companyKey: openKey }), { companyKey: openKey });
  assert.ok(demoPlayForLead(attribution, 'solo'));
});

test('the dashboard snapshot reads the token column', () => {
  const server = source('server.js');
  assert.ok(server.includes("'DemoPlays!A:G', 'ProposalOpens!A:F'"),
    'the snapshot must read column G or the token is invisible to the dashboard');
});

test('the server decides engagement per lead, through the shared attribution', () => {
  const server = source('server.js');
  assert.ok(server.includes('attributeDemoPlays(leads,'), 'engagement must be attributed over the corpus');
  assert.ok(server.includes('const attributedPlay = demoPlayForLead(demoAttribution, lead.id);'));
  assert.ok(server.includes('row.demoEngaged = Boolean(attributedPlay);'));
  assert.ok(!server.includes('demoCompanyKeys'),
    'company-keyed engagement is the defect and must be gone, not merely unused');
});

test('the play log exposes the token so the browser need never guess', () => {
  assert.ok(source('server.js').includes('leadToken: normalizeLeadToken(row[6])'));
});

test('the browser renders the per-lead payload, not a company aggregate', () => {
  const browser = source('public/index.html');
  assert.ok(browser.includes('const demoEntry = l.demoPlays && l.demoPlays.count ? l.demoPlays : null;'),
    'the row cell must use the lead-scoped payload');
  assert.ok(browser.includes('const demoEntry = lead.demoPlays && lead.demoPlays.count ? lead.demoPlays : null;'),
    'the detail drawer must use the lead-scoped payload');
  // ceDemoMap survives only for the explicitly per-company "Demo plays" panel.
  const rowRender = browser.slice(browser.indexOf('const emailSafe ='), browser.indexOf('return `<tr data-id='));
  assert.ok(!/ceDemoMap\s*\./.test(rowRender), 'the row must not read the company-keyed map');
});
