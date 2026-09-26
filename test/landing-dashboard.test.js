'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  parseFunnelFilters, buildStaffingFunnel, loadStaffingFunnel,
  ISSUANCE_COLUMNS, SESSION_COLUMNS, BOOKING_COLUMNS, LEAD_COLUMNS,
} = require('../integrations/landing-dashboard');
const { registerLandingDashboardRoutes } = require('../integrations/landing-dashboard-route');
const { createRequireAuth } = require('../integrations/dashboard-auth');

const NOW = new Date('2026-09-26T02:00:00Z');
const HEX64 = /[0-9a-f]{64}/;
const ENV = { LANDING_LINK_TRACKING_ENABLED: 'false', LANDING_COLLECTOR_ENABLED: 'true' };

const link = (id, lead, source, sentAt, extra = {}) => ({
  issuance_id: id, lead_id: lead, source, trigger_action: source === 'positive_reply' ? 'AUTO_STAFFING_QUALIFIED' : null,
  campaign_id: 'industrial_staffing_employer_acquisition_v1', campaign_version: 'industrial_staffing_employer_acquisition_v1',
  template_id: 'industrial-staffing-employer-v1', template_version: 'staffing_locked_v1', sender_inbox_id: 'primary',
  is_test: false, status: 'sent', sent_at: sentAt, ...extra,
});
const session = (issuance, extra = {}) => ({
  issuance_id: issuance, started_at: '2026-09-24T17:00:00Z', last_seen_at: '2026-09-24T17:05:00Z', visible_at: null, engaged_at: null,
  interacted_at: null, intent_at: null, is_internal: false, is_debug: false, webdriver: false, ua_headless: false, ua_declared_bot: false,
  seconds_after_send: 3600, visible_ms: 0, video_playing: false, video_25: false, video_50: false, video_75: false, video_complete: false,
  meeting_section_visible: false, booking_cta_click: false, booking_dialog_open: false, scroll_jump: false, ...extra,
});
const T = '2026-09-24T17:00:10Z';
const ISSUANCES = [
  link('I1', 'L1', 'followup_2', '2026-09-20T17:00:00Z'),
  link('I2', 'L2', 'followup_2', '2026-09-21T17:00:00Z', { sender_inbox_id: 'deniels' }),
  link('I3', 'L3', 'positive_reply', '2026-09-22T17:00:00Z'),
  link('I4', 'L1', 'positive_reply', '2026-09-23T17:00:00Z', { template_version: 'staffing_locked_v2' }),
  link('T1', 'LT', 'followup_2', '2026-09-24T17:00:00Z', { is_test: true }),
];
const SESSIONS = [
  session('I1', { visible_at: T, engaged_at: T, interacted_at: T, intent_at: T, video_playing: true, video_25: true, video_50: true,
    video_75: true, video_complete: true, meeting_section_visible: true, booking_cta_click: true, booking_dialog_open: true, visible_ms: 95000,
    last_seen_at: '2026-09-24T17:30:00Z' }),
  session('I1', { seconds_after_send: 5, webdriver: true, scroll_jump: true }),
  session('I2', { visible_at: T }),
  session('I3', { visible_at: T, engaged_at: T, intent_at: T, video_playing: true, last_seen_at: '2026-09-24T17:10:00Z' }),
  session('I3', { visible_at: T, engaged_at: T, is_internal: true }),
  session('T1', { visible_at: T, engaged_at: T, interacted_at: T }),
];
const BOOKINGS = [
  { lead_id: 'L1', booked_at: '2026-09-24T18:00:00Z', meeting_at: '2026-09-28T08:00:00-07:00', attributed_issuance_id: 'I1', attributed_source: 'followup_2', assist_label: 'page_assisted' },
  { lead_id: 'L3', booked_at: '2026-09-25T18:00:00Z', meeting_at: null, attributed_issuance_id: 'I3', attributed_source: 'positive_reply', assist_label: 'visited_before_booking' },
  { lead_id: 'L9', booked_at: '2026-09-25T19:00:00Z', meeting_at: null, attributed_issuance_id: null, attributed_source: null, assist_label: 'no_link_issued' },
  { lead_id: 'LT', booked_at: '2026-09-25T20:00:00Z', meeting_at: null, attributed_issuance_id: null, attributed_source: null, assist_label: 'no_link_issued' },
  { lead_id: 'L2', booked_at: '2026-08-01T20:00:00Z', meeting_at: null, attributed_issuance_id: null, attributed_source: null, assist_label: 'no_link_issued' },
];
const LEADS = [
  { lead_id: 'L1', company: 'Acme <script>alert(1)</script> Staffing', contact_name: 'Alex A', email: 'alex@acme.test' },
  { lead_id: 'L2', company: 'Bravo Workforce', contact_name: '', email: 'ops@bravo.test' },
  { lead_id: 'L3', company: 'Coastal Labour', contact_name: 'Dana', email: 'dana@coastal.test' },
  { lead_id: 'L9', company: 'Direct Booker', contact_name: '', email: 'x@direct.test' },
  { lead_id: 'LT', company: 'ScaleLabAi', contact_name: '', email: 'deins@scalelabai.ca' },
];
const build = (query = {}) => buildStaffingFunnel({
  filters: parseFunnelFilters(query, NOW), issuances: ISSUANCES, sessions: SESSIONS, bookings: BOOKINGS, leads: LEADS, env: ENV, now: NOW,
});
const rateOf = (data, key) => data.rates.find(r => r.key === key);

test('summary counts separate links, leads and sessions; internal and test traffic stay out', () => {
  const data = build();
  assert.deepEqual(
    [data.summary.linksSent, data.summary.leadsReached, data.summary.rawSessions, data.summary.visibleSessions,
      data.summary.engagedSessions, data.summary.interactedSessions, data.summary.intentSessions],
    [4, 3, 4, 3, 2, 1, 2]);
  assert.deepEqual(
    [data.summary.videoPlays, data.summary.video25, data.summary.video50, data.summary.video75, data.summary.videoCompletes,
      data.summary.meetingSectionViews, data.summary.bookingCtaClicks, data.summary.bookingDialogsOpened, data.summary.assistedBookings],
    [2, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(data.summary.bookingsByLabel, { page_assisted: 1, visited_before_booking: 1, link_sent_no_visit: 0, no_link_issued: 0 });
  assert.deepEqual(data.status, { trackingEnabled: false, collectorEnabled: true });
  assert.equal(data.monitor, null, 'internal counts only on request');
});

test('every rate names its grain and uses that grain for both sides', () => {
  const data = build();
  const expect = {
    link_to_visit: [3, 4, 'links'], link_to_engaged: [2, 4, 'links'], raw_to_engaged: [2, 4, 'sessions'],
    engaged_to_video: [2, 2, 'sessions'], video_to_half: [1, 2, 'sessions'], half_to_cta: [1, 1, 'sessions'],
    cta_to_booking: [1, 1, 'leads'], engaged_to_booking: [2, 2, 'leads'], link_to_booking: [2, 3, 'leads'],
  };
  assert.deepEqual(data.rates.map(r => r.key), Object.keys(expect));
  for (const [key, [numerator, denominator, grain]] of Object.entries(expect)) {
    const r = rateOf(data, key);
    assert.deepEqual([r.numerator, r.denominator, r.grain], [numerator, denominator, grain], key);
    assert.equal(r.value, numerator / denominator, key);
  }
  const empty = buildStaffingFunnel({ filters: parseFunnelFilters({}, NOW), env: ENV, now: NOW });
  assert.ok(empty.rates.every(r => r.value === null && r.denominator === 0), 'no division by zero');
});

test('source breakdown, filters and the test toggle', () => {
  const data = build();
  const [followUp, positive] = data.bySource;
  assert.deepEqual([followUp.source, followUp.counts.linksSent, followUp.counts.leadsReached, followUp.counts.rawSessions, followUp.counts.assistedBookings], ['followup_2', 2, 2, 3, 1]);
  assert.deepEqual([positive.source, positive.counts.linksSent, positive.counts.leadsReached, positive.counts.rawSessions, positive.counts.assistedBookings], ['positive_reply', 2, 2, 1, 1]);
  assert.deepEqual(data.options, {
    sources: ['followup_2', 'positive_reply'], campaigns: ['industrial_staffing_employer_acquisition_v1'],
    senders: ['deniels', 'primary'], templates: ['staffing_locked_v1', 'staffing_locked_v2'],
  });
  assert.equal(build({ source: 'followup_2' }).summary.linksSent, 2);
  assert.equal(build({ sender: 'deniels' }).summary.linksSent, 1);
  assert.equal(build({ template: 'staffing_locked_v2' }).summary.linksSent, 1);
  assert.equal(build({ campaign: 'someone_else' }).summary.linksSent, 0);
  const withTest = build({ includeTest: '1' });
  assert.deepEqual([withTest.summary.linksSent, withTest.summary.leadsReached, withTest.summary.rawSessions, withTest.bookings.total], [5, 4, 5, 4]);
});

test('visit quality: one highest tier per session and neutral supporting signals', () => {
  const data = build();
  assert.deepEqual(data.quality.tiers, { intent: 2, interacted: 0, engaged: 0, visible: 1, raw: 1 });
  assert.deepEqual(data.quality.signals, { webdriver: 1, headless: 0, declaredBot: 0, openedWithinMinuteOfSend: 1, instantScrollJump: 1, neverVisible: 1 });
});

test('lead activity rows and the bookings panel', () => {
  const data = build();
  const byLead = Object.fromEntries(data.leads.rows.map(row => [row.leadId, row]));
  assert.deepEqual(Object.keys(byLead).sort(), ['L1', 'L2', 'L3']);
  assert.deepEqual(
    [byLead.L1.links, byLead.L1.source, byLead.L1.highestTier, byLead.L1.videoFurthest, byLead.L1.bookingCtaClicked, byLead.L1.bookingDialogOpened, byLead.L1.booking.assistLabel],
    [2, 'positive_reply', 'intent', 'complete', true, true, 'page_assisted']);
  assert.deepEqual([byLead.L2.highestTier, byLead.L2.booking], ['visible', null], 'a booking before the link is not shown against it');
  assert.deepEqual([byLead.L3.highestTier, byLead.L3.videoFurthest, byLead.L3.booking.assistLabel], ['intent', 'playing', 'visited_before_booking']);
  assert.deepEqual(data.leads.rows.map(row => row.leadId), ['L1', 'L3', 'L2'], 'most recent activity first');
  assert.deepEqual(data.bookings.byLabel, { page_assisted: 1, visited_before_booking: 1, link_sent_no_visit: 0, no_link_issued: 1 });
  assert.deepEqual(data.bookings.rows.map(row => row.leadId), ['L1', 'L3', 'L9'], 'test lead and out-of-period bookings excluded');
});

test('the read model carries no token material, IP or user agent', () => {
  for (const data of [build(), build({ includeTest: '1', includeInternal: '1' })]) {
    const json = JSON.stringify(data);
    assert.equal(HEX64.test(json), false);
    for (const word of ['token', 'ua_browser', 'user_agent', 'userAgent', 'ip_', '"ip"', 'action_id', 'provider_message_id']) assert.equal(json.includes(word), false, word);
  }
  for (const columns of [ISSUANCE_COLUMNS, SESSION_COLUMNS, BOOKING_COLUMNS, LEAD_COLUMNS]) {
    assert.equal(/token|action_id|provider_|ua_browser|ua_os|ua_major/.test(columns), false, columns);
  }
});

test('filters are validated and custom dates are Vancouver days', () => {
  assert.equal(parseFunnelFilters({}, NOW).range, '30d');
  assert.equal(parseFunnelFilters({ range: '7d' }, NOW).from, '2026-09-19T02:00:00.000Z');
  const custom = parseFunnelFilters({ range: 'custom', from: '2026-03-08', to: '2026-03-08' }, NOW);
  assert.deepEqual([custom.from, custom.to], ['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'], 'DST day is 23 hours');
  assert.equal(parseFunnelFilters({ range: 'custom', from: '2026-09-25', to: '2026-09-01' }, NOW).range, '30d', 'reversed range refused');
  assert.equal(parseFunnelFilters({ range: 'custom', from: 'x', to: '2026-09-01' }, NOW).range, '30d');
  assert.equal(parseFunnelFilters({ source: 'other' }, NOW).source, '');
  assert.equal(parseFunnelFilters({ sender: 'a&b=c' }, NOW).sender, '');
  assert.equal(parseFunnelFilters({ includeTest: 'true', includeInternal: '0' }, NOW).includeTest, true);
});

function fakeSupabase({ failTable = null, status = 402 } = {}) {
  const calls = [];
  const rowsFor = table => ({
    landing_link_issuances: ISSUANCES.filter(row => !row.is_test), landing_session_facts: SESSIONS,
    landing_booking_attribution: BOOKINGS, outreach_leads: LEADS,
    landing_sessions: [{ is_internal: true, is_debug: false, resolution: 'none' }, { is_internal: true, is_debug: true, resolution: 'none' }, { is_internal: false, is_debug: false, resolution: 'pending' }],
  })[table];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    calls.push({ table, query: decodeURIComponent(parsed.search), headers: init.headers });
    if (table === failTable) return { ok: false, status, json: async () => ({ message: 'secret detail' }) };
    return { ok: true, status: 200, json: async () => rowsFor(table) };
  };
  return { calls, fetchImpl };
}
const SUPA_ENV = { ...ENV, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test_value' };

test('loader: explicit columns, test and internal traffic filtered in the query, ids chunked', async () => {
  const { calls, fetchImpl } = fakeSupabase();
  const result = await loadStaffingFunnel({ query: { includeInternal: '1' }, env: SUPA_ENV, fetchImpl, now: NOW });
  assert.equal(result.ok, true);
  const byTable = Object.fromEntries(calls.map(call => [call.table, call.query]));
  assert.deepEqual(Object.keys(byTable).sort(), ['landing_booking_attribution', 'landing_link_issuances', 'landing_session_facts', 'landing_sessions', 'outreach_leads']);
  for (const call of calls) {
    assert.match(call.query, /select=[a-z0-9_,]+&/, call.table);
    assert.equal(call.query.includes('select=*'), false, call.table);
    assert.equal(/token|ua_browser|action_id/.test(call.query), false, call.table);
    assert.equal(call.headers.Authorization, 'Bearer sb_secret_test_value');
  }
  assert.match(byTable.landing_link_issuances, /is_test=is\.false/);
  assert.match(byTable.landing_session_facts, /issuance_id=in\.\("I1","I2","I3","I4"\)&is_internal=is\.false&is_debug=is\.false/);
  assert.match(byTable.outreach_leads, /select=lead_id,company,contact_name,email&lead_id=in\./);
  assert.deepEqual(result.data.monitor, { internalSessions: 2, debugSessions: 1, unresolvedSessions: 1 });
  assert.equal(result.data.summary.linksSent, 4);

  const many = Array.from({ length: 170 }, (_, i) => link(`X${i}`, `LX${i}`, 'followup_2', '2026-09-20T17:00:00Z'));
  const chunked = [];
  await loadStaffingFunnel({ env: SUPA_ENV, now: NOW, fetchImpl: async (url) => {
    const table = new URL(url).pathname.split('/').pop();
    if (table === 'landing_session_facts') chunked.push(url);
    return { ok: true, status: 200, json: async () => (table === 'landing_link_issuances' ? many : []) };
  } });
  assert.equal(chunked.length, 3, '170 ids in chunks of 80');
});

test('loader: a Supabase failure (e.g. 402) is reported without data', async () => {
  for (const table of ['landing_link_issuances', 'landing_session_facts', 'landing_booking_attribution', 'outreach_leads']) {
    const { fetchImpl } = fakeSupabase({ failTable: table });
    const result = await loadStaffingFunnel({ env: SUPA_ENV, fetchImpl, now: NOW });
    assert.deepEqual(result, { ok: false, error: 'HTTP 402' }, table);
  }
  assert.equal((await loadStaffingFunnel({ env: ENV, fetchImpl: async () => { throw new Error('no'); }, now: NOW })).ok, false, 'unconfigured');
});

async function withApp(configure, run) {
  const app = express();
  configure(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const BASIC = `Basic ${Buffer.from('operator:correct horse battery staple').toString('base64')}`;
const auth = () => createRequireAuth({ getUser: () => 'operator', getPassword: () => 'correct horse battery staple' });
const silent = { warn() {} };

test('route: dashboard auth required, no-store, generic 503', async () => {
  const seen = [];
  await withApp(app => registerLandingDashboardRoutes(app, auth(), {
    env: ENV, now: () => NOW, logger: silent,
    load: async ({ query }) => { seen.push(query); return { ok: true, data: build(query) }; },
  }), async base => {
    const anonymous = await fetch(`${base}/api/landing/funnel`);
    assert.equal(anonymous.status, 401);
    assert.equal(seen.length, 0, 'nothing loaded before auth');
    const response = await fetch(`${base}/api/landing/funnel?range=7d&source=followup_2`, { headers: { authorization: BASIC } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.filters.range, '7d');
    assert.deepEqual(seen[0], { range: '7d', source: 'followup_2' });
    assert.equal(HEX64.test(JSON.stringify(body)), false);
  });
  await withApp(app => registerLandingDashboardRoutes(app, auth(), {
    env: ENV, logger: silent, load: async () => ({ ok: false, error: 'HTTP 402 secret detail' }),
  }), async base => {
    const response = await fetch(`${base}/api/landing/funnel`, { headers: { authorization: BASIC } });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes('402') || text.includes('secret'), false);
  });
});

test('server.js registers the funnel route after dashboard auth', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const auth = server.indexOf('app.use(requireAuth);');
  const route = server.indexOf("require('./integrations/landing-dashboard-route').registerLandingDashboardRoutes(app, requireAuth)");
  assert.ok(auth > 0 && route > auth);
});

// ── Frontend: the real renderer from public/index.html ──────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
function extract(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, startMarker);
  return html.slice(start, end);
}
const helpers = extract('function escAttr(s) {', '\nfunction toggleCeRow');
const renderer = extract('function renderStaffingFunnel(data) {', '\nconst INBOX_FILTERS');
const renderStaffingFunnel = new Function(`${helpers}\n${renderer}\nreturn renderStaffingFunnel;`)();

test('dashboard: workspace is wired into navigation and loading', () => {
  assert.match(html, /data-workspace="staffing" onclick="setWorkspace\('staffing'\)"/);
  assert.match(html, /staffing:\s+\['Staffing Funnel',/);
  assert.match(html, /make\('staffing', workspaceIntro\(/);
  assert.match(html, /if \(name === 'staffing'\) return loadStaffingFunnel\(\);/);
  assert.match(html, /fetch\('\/api\/landing\/funnel\?' \+ params\.toString\(\)\)/);
});

test('dashboard: renders counts, grains, labels and escaped lead links', () => {
  const out = renderStaffingFunnel(build());
  for (const text of ['Tracked links sent', 'Assisted bookings', 'Follow-up #2', 'Positive reply', 'Page-assisted', 'Visited before booking',
    'per links sent', 'per sessions', 'per leads', '75.0%', '3 / 4', '66.7%', 'Highest tier reached', 'Link tracking off']) {
    assert.ok(out.includes(text), text);
  }
  assert.ok(out.includes('Acme &lt;script&gt;alert(1)&lt;/script&gt; Staffing'));
  assert.equal(out.includes('<script>alert(1)'), false, 'company names are escaped');
  assert.ok(out.includes(`openCeDetail('L1')`) && out.includes(`openCeDetail('L9')`), 'rows open the existing lead drawer');
  assert.equal(/NaN|undefined|\[object Object\]/.test(out), false);
  assert.equal(HEX64.test(out) || /token/i.test(out), false);
});

test('dashboard: empty state renders cleanly with zero data', () => {
  const out = renderStaffingFunnel(buildStaffingFunnel({ filters: parseFunnelFilters({}, NOW), env: ENV, now: NOW }));
  assert.ok(out.includes('No tracked links were sent in this period'));
  assert.ok(out.includes('Link tracking is off, so this stays empty until it is switched on.'));
  assert.ok(out.includes('No bookings in this period'));
  assert.ok(out.includes('No sessions yet'));
  assert.equal(/NaN|undefined|\[object Object\]/.test(out), false);
  const monitored = renderStaffingFunnel(build({ includeInternal: '1' }));
  assert.equal(monitored.includes('Internal and debug traffic'), false, 'no monitor block without monitor data');
});
