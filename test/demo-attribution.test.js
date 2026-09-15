'use strict';

// Incident repair, Phase 4 — a demo play is attributed to ONE lead, or to none.
//
// DemoPlays were matched to leads by cleaned company name. Four Smili Dental
// locations share one, so a single listener on one location's page produced a
// canonical demo pair for all four, and each queued a booking-link email. A
// company name is not an identity.
//
// Attribution now resolves the lead token that every proposal link already
// carries (/p/<token>), forwarded by the page on each play pixel. Token-less
// legacy rows may still match by company, but only when that key belongs to
// exactly one lead in the whole corpus; otherwise the ambiguity is reported and
// no pair is created.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  proposalTokenFor, normalizeLeadToken, aggregateDemoPlays, attributeDemoPlays, demoPlayForLead,
} = require('../integrations/demo-attribution');
const {
  buildDemoPairActivity, qualifyingDemoPair, hasUndeliveredDemoPair,
} = require('../integrations/demo-intent-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agentSrc = readSource('outreach-agent.js');
const serverSrc = readSource('server.js');

// outreach-agent.js keys legacy rows with normalizeName(cleanCompanyName(company)).
// Both helpers are agent-internal, and requiring the agent starts a worker, so
// the composition is restated here and the agent's use of it is pinned below.
function cleanCompanyName(raw) {
  if (!raw) return '';
  let cutAt = raw.length;
  for (const sep of ['|', ' - ', ' • ', ' · ', ' – ', ' — ']) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) cutAt = Math.min(cutAt, idx);
  }
  return raw.slice(0, cutAt).trim() || raw.trim();
}
const normalizeName = str => (str || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const companyKey = company => normalizeName(cleanCompanyName(company));

// Synthetic leads only. No real prospect appears in this file.
const SMILI = [
  { id: 'smili-mt', company: 'Smili Dental - Mount Tabor', email: 'mt@smili.example' },
  { id: 'smili-pr', company: 'Smili Dental - Park Row', email: 'pr@smili.example' },
  { id: 'smili-sr', company: 'Smili Dental | South Ridge', email: 'sr@smili.example' },
  { id: 'smili-pc', company: 'Smili Dental – Pacific Commons', email: 'pc@smili.example' },
];
const SOLO = { id: 'solo-1', company: 'Harbour Dental', email: 'owner@harbour.example', senderInboxId: 'tryscalelabai' };
const CORPUS = [...SMILI, SOLO];

const HEADER = ['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type', 'lead_token'];
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)';
const play = (at, company, type, token = '', ip = '203.0.113.7', ua = BROWSER) =>
  [at, company, 'dental', ip, ua, type, token];

function attribute(rows, corpus = CORPUS, options = {}) {
  const plays = aggregateDemoPlays([HEADER, ...rows], { companyKey, ...options });
  return attributeDemoPlays(corpus, plays, { companyKey });
}
const pairedLeads = attribution => [...attribution.byLeadId]
  .filter(([, hit]) => qualifyingDemoPair(hit.play)).map(([id]) => id).sort();

// The page sends the cleaned company, which is the same for every location.
const PAGE_COMPANY = 'Smili Dental';

test('one token resolves to exactly one lead', () => {
  const token = proposalTokenFor('smili-mt');
  const attribution = attribute([
    play('2026-09-11T16:50:00.000Z', PAGE_COMPANY, 'intro', token),
    play('2026-09-11T16:51:00.000Z', PAGE_COMPANY, 'demo', token),
  ]);
  assert.deepEqual(pairedLeads(attribution), ['smili-mt']);
  assert.equal(attribution.byLeadId.get('smili-mt').via, 'lead_token');
  assert.deepEqual(attribution.ambiguous, []);
});

test('one listening session cannot produce pairs for other locations', () => {
  const token = proposalTokenFor('smili-pr');
  const attribution = attribute([
    play('2026-09-11T16:50:00.000Z', PAGE_COMPANY, 'intro', token),
    play('2026-09-11T16:51:00.000Z', PAGE_COMPANY, 'demo', token),
  ]);
  assert.deepEqual(pairedLeads(attribution), ['smili-pr']);
  for (const other of ['smili-mt', 'smili-sr', 'smili-pc']) {
    assert.equal(demoPlayForLead(attribution, other), null, `${other} received no evidence at all`);
  }
});

test('four locations and one legacy listener produce at most one pair — here none, because it is ambiguous', () => {
  const attribution = attribute([
    play('2026-09-11T16:50:00.000Z', PAGE_COMPANY, 'intro'),
    play('2026-09-11T16:51:00.000Z', PAGE_COMPANY, 'demo'),
  ]);
  const paired = pairedLeads(attribution);
  assert.ok(paired.length <= 1, 'one listener can never be four prospects');
  assert.deepEqual(paired, []);
  assert.deepEqual(attribution.ambiguous, [{
    via: 'legacy_company', key: 'smili dental', leadIds: ['smili-mt', 'smili-pc', 'smili-pr', 'smili-sr'],
  }]);
});

test('a legacy company key shared by two leads creates no pair and is reported', () => {
  const twins = [SOLO, { id: 'solo-2', company: 'Harbour Dental', email: 'frontdesk@harbour.example' }];
  const attribution = attribute([
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro'),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo'),
  ], twins);
  assert.deepEqual(pairedLeads(attribution), []);
  assert.equal(attribution.ambiguous.length, 1);
  assert.deepEqual(attribution.ambiguous[0].leadIds, ['solo-1', 'solo-2']);
});

test('a legacy company key that resolves to exactly one lead creates one pair', () => {
  const attribution = attribute([
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro'),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo'),
  ]);
  assert.deepEqual(pairedLeads(attribution), ['solo-1']);
  assert.equal(attribution.byLeadId.get('solo-1').via, 'legacy_company');
});

test('duplicate plays are idempotent: one pair, one stable event id', () => {
  const token = proposalTokenFor('solo-1');
  const rows = [
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro', token),
    play('2026-09-12T10:00:30.000Z', 'Harbour Dental', 'intro', token),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo', token),
    play('2026-09-12T10:02:00.000Z', 'Harbour Dental', 'demo', token),
    play('2026-09-12T10:03:00.000Z', 'Harbour Dental', 'intro', token),
  ];
  const first = attribute(rows);
  const second = attribute([...rows, ...rows]);
  assert.deepEqual(pairedLeads(first), ['solo-1']);
  assert.deepEqual(pairedLeads(second), ['solo-1']);

  const eventA = buildDemoPairActivity(SOLO, demoPlayForLead(first, 'solo-1'));
  const eventB = buildDemoPairActivity(SOLO, demoPlayForLead(second, 'solo-1'));
  assert.equal(eventA.eventId, 'demo-pair:solo-1');
  assert.equal(eventB.eventId, eventA.eventId, 'replaying the same evidence names the same canonical event');
  assert.equal(JSON.parse(eventA.metadata).introPlayedAt, '2026-09-12T10:00:00.000Z', 'first play wins');
  assert.equal(hasUndeliveredDemoPair(SOLO, [eventA]), true);
});

test('out-of-order plays still qualify, with each clip at its own first play', () => {
  const token = proposalTokenFor('solo-1');
  const attribution = attribute([
    play('2026-09-12T10:05:00.000Z', 'Harbour Dental', 'intro', token),
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'demo', token),
  ]);
  const pair = qualifyingDemoPair(demoPlayForLead(attribution, 'solo-1'));
  assert.ok(pair, 'demo before intro is still both clips');
  assert.equal(pair.introPlayedAt, '2026-09-12T10:05:00.000Z');
  assert.equal(pair.demoPlayedAt, '2026-09-12T10:00:00.000Z');
  assert.equal(pair.occurredAt, '2026-09-12T10:05:00.000Z');
});

test('a token row never falls back to the company match', () => {
  const attribution = attribute([
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro', 'ffffffffff'),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo', 'ffffffffff'),
  ]);
  assert.equal(demoPlayForLead(attribution, 'solo-1'), null,
    'a token that matches no lead says nothing about a lead that shares its company');
  assert.equal(attribution.unmatchedTokens, 1);
});

test('token evidence and legacy evidence never combine into a pair', () => {
  const attribution = attribute([
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro', proposalTokenFor('solo-1')),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo'),
  ]);
  const hit = attribution.byLeadId.get('solo-1');
  assert.equal(hit.via, 'lead_token');
  assert.equal(qualifyingDemoPair(hit.play), null, 'half a pair from each source is not a pair');
});

test('own-IP and bot rows are excluded before attribution', () => {
  const token = proposalTokenFor('solo-1');
  const isExcluded = ({ ip, userAgent }) => ip === '75.155.151.158' || /bot/i.test(userAgent);
  const attribution = attribute([
    play('2026-09-12T10:00:00.000Z', 'Harbour Dental', 'intro', token, '75.155.151.158'),
    play('2026-09-12T10:01:00.000Z', 'Harbour Dental', 'demo', token, '203.0.113.9', 'LinkPreviewBot/1.0'),
  ], CORPUS, { isExcluded });
  assert.equal(demoPlayForLead(attribution, 'solo-1'), null);
});

test('only a well-formed token is a token', () => {
  assert.equal(normalizeLeadToken(' 0A1B2C3D4E '), '0a1b2c3d4e');
  for (const bad of ['', 'x', '0a1b2c3d4', '0a1b2c3d4e5', 'zzzzzzzzzz', '<script>ab', null, undefined]) {
    assert.equal(normalizeLeadToken(bad), '', `${JSON.stringify(bad)} is not a token`);
  }
  assert.match(proposalTokenFor('mt9ka4dnwfgdo8rlbz'), /^[0-9a-f]{10}$/);
});

test('a targeted subset would make a shared key look unique, so the agent attributes over the full corpus', () => {
  const legacy = [
    play('2026-09-11T16:50:00.000Z', PAGE_COMPANY, 'intro'),
    play('2026-09-11T16:51:00.000Z', PAGE_COMPANY, 'demo'),
  ];
  assert.deepEqual(pairedLeads(attribute(legacy, [SMILI[0]])), ['smili-mt'],
    'pinned hazard: one location on its own looks unique');
  assert.match(agentSrc, /const allLeadsForDailyCap = \[\.\.\.all\];[\s\S]*all\.splice\(0, all\.length, target\)/,
    'the full corpus is captured before a targeted run narrows `all`');
  assert.match(agentSrc, /prepareDemoIntentCandidates\(all, snapshot, allLeadsForDailyCap\)/);
  assert.match(agentSrc, /runIntentTriggerPass\(all, ownershipContext, snapshot, \{[\s\S]*?\}, null, allLeadsForDailyCap\)/);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('the agent attributes through the shared module and nowhere else', () => {
  assert.match(agentSrc, /const demoCompanyKey = company => normalizeName\(cleanCompanyName\(company\)\);/);
  assert.match(agentSrc, /aggregateDemoPlays\(rows, \{ companyKey: demoCompanyKey, isExcluded: excludedDemoPlay \}\)/);
  const prepare = agentSrc.slice(agentSrc.indexOf('async function prepareDemoIntentCandidates'),
    agentSrc.indexOf('async function runIntentTriggerPass'));
  assert.match(prepare, /attributeDemoPlays\(corpus, plays, \{ companyKey: demoCompanyKey \}\)/);
  assert.match(prepare, /ambiguous/, 'ambiguity is reported, not swallowed');
  assert.match(agentSrc, /validateFresh: async \(\{ fresh, current, mine, currentRows \}\) => \{[\s\S]*?attributeDemoPlays\(currentRows,/,
    'the last-moment check re-attributes against the fresh full corpus');
  assert.ok(!/plays\.get\(normalizeName\(cleanCompanyName/.test(agentSrc), 'no company-keyed lookup remains');
  assert.ok(!/currentPlays\.get\(/.test(agentSrc));
  assert.match(agentSrc, /\['demoPlays', 'DemoPlays!A:G'\]/, 'the snapshot reads the token column');
});

test('the tracker forwards the token and the pixel route stores it', () => {
  const tracker = serverSrc.slice(serverSrc.indexOf("app.get('/p/:token'"), serverSrc.indexOf("app.get('/demo-played'"));
  assert.match(tracker, /fwd\.set\('lt', token\)/, '/p/:token forwards the lead token to the page');
  const pixel = serverSrc.slice(serverSrc.indexOf("app.get('/demo-played'"), serverSrc.indexOf('// ── HOT-LEAD ENGAGEMENT TRACKING'));
  assert.match(pixel, /const leadToken = normalizeLeadToken\(req\.query\.lt\)/);
  assert.match(pixel, /\[new Date\(\)\.toISOString\(\), company, niche, clientIp, ua, audioType, leadToken\]/,
    'the token is appended as column G, never inserted mid-row');
  assert.match(pixel, /range:\s+'DemoPlays!A:G'/);
  assert.match(pixel, /maybeFireIntent\(company, leadToken\)/);
});

test('the audit and repair script attributes through the shared module', () => {
  const script = readSource('scripts/demo-intent-audit-repair.js');
  assert.match(script, /attributeDemoPlays\(cold, /);
  assert.match(script, /'DemoPlays!A:G'/);
  assert.ok(!/plays\.get\(companyKey\(lead\.company\)\)/.test(script), 'no company-keyed lookup remains');
});

test('both proposalToken implementations agree with the module', () => {
  const pattern = /createHash\('sha1'\)\.update\(String\((lead\.id|id)\)\)\.digest\('hex'\)\.slice\(0, 10\)/;
  assert.match(agentSrc, pattern);
  assert.match(serverSrc, pattern);
  assert.equal(proposalTokenFor('abc'), require('node:crypto').createHash('sha1').update('abc').digest('hex').slice(0, 10));
});
