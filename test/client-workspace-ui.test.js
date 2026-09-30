'use strict';

// Client-aware dashboard: config-driven navigation, the managed-client
// workspace views (Pipeline, Inbox, Settings) and the app-shell pins that keep
// the sidebar independently scrollable. Navigation is never the security
// boundary — the route tests below prove the server scopes every view.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { WORKSPACE_IDS, validateWorkspaces, navigationFor, resolveWorkspace } = require('../integrations/clients/navigation');
const { getClient, publicClient, listClients } = require('../integrations/clients/registry');
const { PIPELINE_STAGES, pipelineStageFor, buildClientPipeline } = require('../integrations/clients/pipeline');
const { filterInboxesForClient, buildClientInbox, buildClientSettings } = require('../integrations/clients/workspace-views');
const { registerClientRoutes } = require('../integrations/clients/routes');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { routedLeadReady } = require('../integrations/campaign-routing');
const ledger = require('../integrations/clients/ledger');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const joleLead = (id, extra = {}) => ({
  id, clientId: 'jole', company: `Jole Employer ${id}`, contactName: 'Pat', email: `${id}@jole-employer.example.com`,
  stage: 'Import', emailStatus: '', emailStep: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-dc-mission-critical-v1', intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL',
  campaign: 'JOLE_DC_MISSION_CRITICAL', senderInboxId: '', routingRequired: 'true', tradeType: '', ...extra,
});
const scalelabLead = (id, extra = {}) => ({
  id, clientId: 'scalelab', company: `Dental ${id}`, contactName: 'Sam', email: `${id}@dental.example.com`,
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '', leadNiche: 'dental',
  emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v3_pay_per_booking',
  campaign: 'Ontario List', senderInboxId: 'primary', routingRequired: 'true', ...extra,
});
const reply = (eventId, leadId, clientId, content) => ({
  eventId, sourceLeadId: leadId, eventType: 'client_reply_classified', occurredAt: '2026-10-02T15:00:00Z',
  subject: 'Re: hello', content, metadata: JSON.stringify({ clientId, workflowState: 'qualification_in_progress', sentiment: 'positive' }),
});
const INBOXES = [
  { id: 'primary', email: 'owner@scalelab.example.com', status: 'active', sendEligible: true, dailyLimit: 50, sentToday: 12 },
  { id: 'jole_a', email: 'outreach@jole.example.com', clientId: 'jole', status: 'warming', sendEligible: false, dailyLimit: 10, sentToday: 0, credentialConfigured: true },
];

// ── Navigation ─────────────────────────────────────────────────────────────

test('navigation: ScaleLab keeps every current module, in catalog order', () => {
  const nav = navigationFor(getClient('scalelab'));
  assert.deepEqual(nav.workspaces, WORKSPACE_IDS);
  assert.equal(nav.defaultWorkspace, 'pipeline');
  assert.deepEqual(nav.sections.map(section => section.id), ['clients', 'sales', 'growth', 'system']);
});

test('navigation: Jole gets exactly Client Ops, Pipeline, Inbox, Bookings, Campaigns, Analytics, Settings', () => {
  const nav = navigationFor(getClient('jole'));
  assert.deepEqual(nav.sections.map(section => [section.label, section.items.map(item => item.label)]), [
    ['Clients', ['Client Ops']],
    ['Sales', ['Pipeline', 'Inbox', 'Bookings']],
    ['Growth', ['Campaigns', 'Analytics']],
    ['System', ['Settings']],
  ]);
  assert.equal(nav.defaultWorkspace, 'clients');
  for (const hidden of ['outreach', 'staffing', 'sequences', 'health']) assert.equal(nav.workspaces.includes(hidden), false, hidden);
  assert.ok(nav.sections.every(section => section.items.every(item => item.managedContext)), 'every item has header copy');
});

test('navigation: a workspace the client lacks resolves to its default, never to an invalid route', () => {
  const jole = getClient('jole');
  assert.equal(resolveWorkspace(jole, 'staffing'), 'clients');
  assert.equal(resolveWorkspace(jole, 'nonsense'), 'clients');
  assert.equal(resolveWorkspace(jole, undefined), 'clients');
  assert.equal(resolveWorkspace(jole, 'pipeline'), 'pipeline');
  assert.equal(resolveWorkspace(getClient('scalelab'), 'staffing'), 'staffing');
});

test('navigation: config validation rejects unknown, duplicate, empty or default-less workspace lists', () => {
  const base = { id: 'acme', defaultWorkspace: 'pipeline' };
  assert.throws(() => validateWorkspaces({ ...base, workspaces: [] }), /non-empty/);
  assert.throws(() => validateWorkspaces({ ...base, workspaces: ['pipeline', 'payroll'] }), /unknown workspace/);
  assert.throws(() => validateWorkspaces({ ...base, workspaces: ['pipeline', 'pipeline'] }), /duplicate/);
  assert.throws(() => validateWorkspaces({ ...base, workspaces: ['inbox'] }), /defaultWorkspace/);
  assert.equal(validateWorkspaces({ ...base, workspaces: ['pipeline'] }), true);
  for (const config of listClients()) assert.equal(validateWorkspaces(config), true, config.id);
});

test('registry: the public client carries navigation and terminology, and no activation shortcut', () => {
  const jole = publicClient(getClient('jole'));
  assert.deepEqual(jole.navigation.workspaces, ['clients', 'pipeline', 'inbox', 'bookings', 'campaigns', 'analytics', 'settings']);
  assert.equal(jole.terminology.leads, 'employer leads');
  assert.equal(jole.lifecycleStatus, 'onboarding_pending');
  assert.equal(jole.active, false);
  assert.equal(jole.platformAccess, 'none');
});

// ── Pipeline ───────────────────────────────────────────────────────────────

test('pipeline: stage derivation follows the evidence, most advanced first', () => {
  const lead = joleLead('p1');
  assert.equal(pipelineStageFor(lead), 'imported');
  assert.equal(pipelineStageFor({ ...lead, senderInboxId: 'jole_a' }), 'approved');
  assert.equal(pipelineStageFor(lead, { routingReady: true }), 'routing_ready');
  assert.equal(pipelineStageFor({ ...lead, stage: 'Queued' }), 'queued');
  assert.equal(pipelineStageFor({ ...lead, emailStep: '1', emailStatus: 'emailed' }), 'contacted');
  assert.equal(pipelineStageFor({ ...lead, emailStatus: 'replied' }), 'replied');
  assert.equal(pipelineStageFor(lead, { opportunity: { conversation_status: 'qualification_in_progress' } }), 'qualifying');
  assert.equal(pipelineStageFor(lead, { openClarification: true }), 'awaiting_clarification');
  assert.equal(pipelineStageFor(lead, { meetings: [{ meeting_status: 'BOOKED' }] }), 'meeting_booked');
  assert.equal(pipelineStageFor(lead, { meetings: [{ meeting_status: 'HELD' }] }), 'meeting_held');
  assert.equal(pipelineStageFor({ ...lead, notes: '[REPLY: Not Interested]' }), 'closed');
  // A qualified held meeting is billable history: it outranks a later close.
  assert.equal(pipelineStageFor({ ...lead, notes: '[REPLY: Not Interested]' }, { meetings: [{ meeting_status: 'QUALIFIED_HELD' }] }), 'qualified_held');
});

test('pipeline: an empty client gets every column at zero, nothing invented', () => {
  const board = buildClientPipeline({ clientId: 'jole', leads: [], routedLeadReady });
  assert.equal(board.total, 0);
  assert.deepEqual(board.stages.map(stage => stage.id), PIPELINE_STAGES.map(stage => stage.id));
  assert.ok(board.stages.every(stage => stage.count === 0 && stage.leads.length === 0));
});

test('pipeline: ledger rows of another client never move this client\'s leads', () => {
  const board = buildClientPipeline({
    clientId: 'jole', leads: [joleLead('p1')], routedLeadReady, env: {},
    ledger: { available: true, meetings: [{ client_id: 'scalelab', lead_id: 'p1', meeting_status: 'QUALIFIED_HELD' }], opportunities: [], clarifications: [] },
  });
  assert.equal(board.stages.find(stage => stage.id === 'qualified_held').count, 0);
  assert.equal(board.stages.find(stage => stage.id === 'imported').count, 1);
});

// ── Inbox & Settings view models ──────────────────────────────────────────

test('inbox: only this client\'s classified replies, with its open clarifications', () => {
  const view = buildClientInbox({
    clientId: 'jole', leads: [joleLead('j1'), joleLead('j2')],
    activities: [reply('r1', 'j1', 'jole', 'What are your rates?'), reply('r2', 's1', 'scalelab', 'dental reply'), reply('r3', 'j2', 'scalelab', 'mislabelled')],
    ledger: { available: true, opportunities: [], clarifications: [
      { client_id: 'jole', lead_id: 'j1', status: 'open', clarification_id: 'c1', question: 'Rates?' },
      { client_id: 'scalelab', lead_id: 'j1', status: 'open', clarification_id: 'c2', question: 'not ours' },
    ] },
  });
  assert.deepEqual(view.conversations.map(row => row.leadId), ['j1']);
  assert.equal(view.awaitingClarification, 1);
  assert.deepEqual(view.conversations[0].openClarifications.map(row => row.id), ['c1']);
  assert.equal(JSON.stringify(view).includes('dental'), false);
});

test('settings: client inboxes only; Jole capacity is zero and blocked while onboarding; DNS never invented', () => {
  const settings = buildClientSettings({ clientId: 'jole', inboxes: INBOXES, global: { dailyLimit: 200, windowLimit: 21 }, env: {}, now: new Date('2026-10-01T18:00:00Z') });
  assert.deepEqual(settings.inboxes.map(inbox => inbox.id), ['jole_a']);
  assert.equal(settings.inboxes[0].domain, 'jole.example.com');
  assert.equal(settings.capacity.dailyCap, 0);
  assert.equal(settings.capacity.remainingToday, 0);
  assert.ok(settings.capacity.blockedBy);
  assert.equal(settings.sending.sendingEnabled, false);
  assert.equal(settings.status.lifecycleStatus, 'onboarding_pending');
  assert.equal(settings.status.onboarding.setupBalanceDueCents, 17500);
  assert.deepEqual(settings.domainAuthentication, { checked: false });
  assert.equal(/spf|dkim|dmarc/i.test(JSON.stringify(settings)), false, 'no DNS verdicts in the payload');
});

test('settings: an inbox with no declared client is ScaleLab\'s, never Jole\'s', () => {
  assert.deepEqual(filterInboxesForClient(INBOXES, 'scalelab').map(inbox => inbox.id), ['primary']);
  assert.deepEqual(filterInboxesForClient(INBOXES, 'jole').map(inbox => inbox.id), ['jole_a']);
  assert.deepEqual(filterInboxesForClient([{ id: 'x', clientId: 'acme' }], 'scalelab'), [], 'unknown owner fails closed');
});

// ── Routes: server-side scoping ───────────────────────────────────────────

async function withServer(store, run) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => (req.headers.authorization === 'Basic test' ? next() : res.status(401).json({ error: 'auth' }));
  const dataset = {
    at: Date.parse('2026-10-01T00:00:00Z'),
    leads: [joleLead('j1'), joleLead('j2', { stage: 'Queued' }), scalelabLead('s1'), scalelabLead('s2')],
    activities: [reply('r1', 'j1', 'jole', 'Jole question'), reply('r2', 's1', 'scalelab', 'Dental answer')],
    suppressedEmails: new Set(),
  };
  registerClientRoutes(app, {
    requireAuth, loadDataset: async () => dataset, getStore: () => store, senders: () => [], routedLeadReady,
    env: {}, log: { log() {}, error() {} }, senderStatus: async () => INBOXES,
    globalCapacity: () => ({ dailyLimit: 200, windowLimit: 21 }),
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, auth = true) => fetch(base + p, { headers: auth ? { authorization: 'Basic test' } : {} });
  try { await run({ get }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('routes: pipeline, inbox and settings are operator-only and 404 for an unknown client', async () => {
  await withServer(createMemoryLedgerStore(), async ({ get }) => {
    for (const view of ['pipeline', 'inbox', 'settings']) {
      assert.equal((await get(`/api/clients/jole/${view}`, false)).status, 401, view);
      assert.equal((await get(`/api/clients/acme/${view}`)).status, 404, view);
    }
  });
});

test('routes: each workspace view returns only that client\'s records', async () => {
  const store = createMemoryLedgerStore();
  // Ledger writes need an active client; seed as activated Jole, then read back as it ships (onboarding_pending).
  const restore = activateJoleForTest();
  try {
    await ledger.openClarification(store, { clientId: 'jole', lead: joleLead('j1'), question: 'Rates?', topics: ['rates'], sourceMessageId: 'r1' });
  } finally { restore(); }
  assert.equal(getClient('jole').lifecycleStatus, 'onboarding_pending');
  await withServer(store, async ({ get }) => {
    const pipeline = await (await get('/api/clients/jole/pipeline')).json();
    assert.equal(pipeline.total, 2);
    assert.equal(pipeline.stages.find(stage => stage.id === 'awaiting_clarification').count, 1);
    assert.equal(pipeline.stages.find(stage => stage.id === 'queued').count, 1);
    const inbox = await (await get('/api/clients/jole/inbox')).json();
    assert.deepEqual(inbox.conversations.map(row => row.leadId), ['j1']);
    const settings = await (await get('/api/clients/jole/settings')).json();
    assert.deepEqual(settings.inboxes.map(inbox => inbox.id), ['jole_a']);
    for (const payload of [pipeline, inbox, settings]) {
      const body = JSON.stringify(payload);
      assert.equal(body.includes('dental.example.com') || body.includes('scalelab.example.com'), false, 'no ScaleLab record in a Jole view');
    }
    const slPipeline = await (await get('/api/clients/scalelab/pipeline')).json();
    assert.equal(slPipeline.total, 2);
    assert.equal(JSON.stringify(slPipeline).includes('jole-employer.example.com'), false, 'no Jole record in a ScaleLab view');
    const slSettings = await (await get('/api/clients/scalelab/settings')).json();
    assert.deepEqual(slSettings.inboxes.map(inbox => inbox.id), ['primary']);
  });
});

test('routes: settings degrade to config when inbox status is unavailable', async () => {
  const app = express();
  registerClientRoutes(app, {
    requireAuth: (_q, _s, next) => next(), loadDataset: async () => ({ leads: [], activities: [] }), getStore: () => null,
    senders: () => [], routedLeadReady, env: {}, log: { log() {}, error() {} },
    senderStatus: async () => { throw new Error('gmail down'); },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/clients/jole/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.inboxes, []);
    assert.equal(body.sending.sendingEnabled, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// ── Dashboard pins ─────────────────────────────────────────────────────────

test('app shell: the sidebar nav is the only sidebar scroller and the page is viewport-bound', () => {
  const navRule = HTML.match(/\.crm-nav\{([^}]*)\}/)[1];
  assert.match(navRule, /overflow-y:auto/);
  assert.match(navRule, /min-height:0/);
  assert.match(navRule, /flex:1 1 auto/);
  assert.match(HTML, /\.crm-sidebar\{[^}]*height:100dvh[^}]*overflow:hidden/);
  assert.match(HTML, /body\.workspace-ready\{[^}]*height:100dvh[^}]*overflow:hidden/);
  assert.match(HTML, /html\.workspace-ready\{height:100%;overflow:hidden\}/);
  assert.match(HTML, /#workspace-stage\{[^}]*position:relative[^}]*overflow:auto/);
  assert.match(HTML, /document\.documentElement\.classList\.add\('workspace-ready'\)/);
  assert.match(HTML, /<nav class="crm-nav" id="crm-nav" aria-label="Workspaces">/);
});

test('app shell: the 64px header bar never wraps, so nothing spills over the page on phones', () => {
  assert.match(HTML, /body\.workspace-ready>header\{flex-wrap:nowrap;gap:12px\}/);
  assert.match(HTML, /body\.workspace-ready>header \.workspace-heading\{flex:1 1 auto;min-width:0\}/);
  assert.match(HTML, /body\.workspace-ready>header \.header-right\{flex:0 0 auto;flex-wrap:nowrap\}/);
  // Board search / Add Lead start hidden and are revealed by routing on ScaleLab's Pipeline only.
  assert.match(HTML, /querySelectorAll\('header \.search-wrap, header \.btn-add'\)\.forEach\(node => \{ node\.style\.display = 'none'; \}\)/);
  assert.match(HTML, /const boardTools = name === 'pipeline' && !managed;/);
});

test('dashboard: navigation comes from client config, not from client-name branches', () => {
  assert.equal(/===\s*'jole'|'jole'\s*===|"jole"/.test(HTML), false, 'no hard-coded Jole branch in the dashboard');
  assert.equal(HTML.includes('MANAGED_CLIENT_WORKSPACES'), false);
  assert.match(HTML, /client\.navigation|\.navigation\b/);
  assert.match(HTML, /function renderNavigation\(/);
});

test('dashboard: managed views read client-scoped APIs and hide ScaleLab panels', () => {
  assert.match(HTML, /\/api\/clients\/\$\{encodeURIComponent\(activeClientId\)\}/);
  assert.match(HTML, /\/api\/integrations\/gmail-inboxes\?client=\$\{/);
  assert.match(HTML, /body\[data-client-mode="managed"\] \.crm-workspace:not\(#ws-clients\)>:not\(\.workspace-intro\):not\(\.client-view\)\{display:none!important\}/);
  assert.match(HTML, /body:not\(\[data-client-mode="managed"\]\) \.client-view\{display:none!important\}/);
});

test('dashboard: empty states say why there is no data, without fake records', () => {
  // Copy is built from the client's terminology ("Employer leads" for Jole).
  assert.match(HTML, /is still onboarding\. \$\{terms\.leads\[0\]\.toUpperCase\(\) \+ terms\.leads\.slice\(1\)\} will appear here after activation and import\./);
  assert.match(HTML, /SPF, DKIM and DMARC are not checked by/);
  assert.equal(/Acme|John Doe|Lorem ipsum/i.test(HTML.slice(HTML.indexOf('function renderManagedPipeline'))), false);
});
