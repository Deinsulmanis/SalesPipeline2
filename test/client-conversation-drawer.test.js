'use strict';

// The managed-client (Jole) Inbox conversation drawer: the read-only detail
// endpoint, its view model, and the dashboard code that renders it. Mixed
// ScaleLab / Jole fixtures throughout. Nothing here sends or writes a lead:
// stores are in memory and the HTTP server binds to localhost.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { registerClientRoutes } = require('../integrations/clients/routes');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { buildClientConversationDetail, senderDisplayLabel } = require('../integrations/clients/conversation-detail');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const JOLE_CAMPAIGN = 'jole-btx-employer-acquisition';
const profile = (extra = {}) => JSON.stringify({
  schema: 'client_lead_profile_v1', clientId: 'jole',
  contact: { firstName: 'Cindy', lastName: 'Thomas', title: 'Human Resources Manager', city: 'Lynchburg', state: 'VA', linkedinUrl: 'https://www.linkedin.com/in/example' },
  company: { domain: 'customtruck.example', size: '1,001-5,000 employees', sector: 'Industrial fabrication', tier: 'Tier A' },
  hiring: {
    site: 'Lynchburg, VA', siteTie: 'EXACT',
    roles: [{ raw: 'CNC MACHINIST', clean: 'CNC Machinists', status: 'clean' }, { raw: 'WELDER', clean: 'Welders', status: 'clean' }],
    postingDate: '2026-10-02', evidenceUrl: 'https://jobs.example/cnc-machinist-4456038987',
    relevantRoles30d: 6, coreTradeRoles30d: 5, context: 'HR manager at the hiring site.', verifiedAt: '2026-10-07',
  },
  personalization: { status: 'ready', roles: ['CNC Machinists', 'Welders'], location: 'Lynchburg, VA' },
  ...extra,
});
const joleLead = (id, extra = {}) => ({
  id, clientId: 'jole', company: 'Custom Truck One Source', contactName: 'Cindy Thomas', email: `${id}@customtruck.example`,
  leadNiche: 'jole_employer', campaign: JOLE_CAMPAIGN, intendedCampaignVersion: JOLE_CAMPAIGN,
  stage: 'Unsub', emailStatus: 'done', emailStep: '1', lastEmailedAt: '2026-10-19T13:38:18.067Z',
  senderInboxId: 'jole_team_jguerrero', notes: '[REPLY: Unsubscribed]', campaign_notes: profile(), ...extra,
});
const scaleLead = (id, extra = {}) => ({
  id, clientId: 'scalelab', company: 'ScaleLab Staffing Co', contactName: 'Sam Scale', email: `${id}@scale.example`,
  leadNiche: 'industrial_staffing', campaign: 'staffing_v2', stage: 'Contacted', emailStatus: 'replied', emailStep: '1',
  senderInboxId: 'primary', notes: '', ...extra,
});
const sent = (id, leadId, senderInboxId, occurredAt, eventType = 'initial_email_sent', step = 1) => ({
  eventId: `gmail:${id}`, sourceLeadId: leadId, leadId: `CE-${leadId}`, eventType, occurredAt,
  metadata: JSON.stringify({ gmailMessageId: id, senderInboxId, sequenceStep: step }),
});
const queued = (leadId, senderInboxId) => ({
  eventId: `lead-queued:${leadId}`, sourceLeadId: leadId, eventType: 'lead_queued', occurredAt: '2026-10-15T20:56:33Z',
  metadata: JSON.stringify({ senderInboxId }),
});
const LONG_REPLY = `Please remove me from your list. ${'This is a long reply that keeps going without a break '.repeat(20)}`;
const replyEvent = (leadId, { clientId = 'jole', workflowState = 'unsubscribe', sentiment = 'unsubscribe', content = LONG_REPLY, at = '2026-10-19T13:40:42Z' } = {}) => ({
  eventId: `client-reply:${clientId}:${leadId}:${at}`, sourceLeadId: leadId, leadId: `CE-${leadId}`, eventType: 'client_reply_classified',
  occurredAt: at, subject: 'RE: [EXTERNAL] CNC Machinists — Lynchburg, VA', content,
  metadata: JSON.stringify({
    clientId, campaignId: JOLE_CAMPAIGN, workflowState, sentiment,
    conversationStatus: workflowState === 'unsubscribe' ? 'closed_unsubscribed' : 'qualification_in_progress',
    suppressionScope: workflowState === 'unsubscribe' ? 'global' : 'none',
    canonical: { state: 'negative', reason: 'unsubscribe_request', signals: ['unsubscribe'], confidence: 'high' },
    senderInboxId: 'jole_team_jguerrero', gmailMessageId: 'r1',
  }),
});
const senders = [
  { id: 'primary', email: 'scale@scalelab.example', status: 'active' },
  ...[['jole_group_jorge', 'jorge@jolebtxgroup.com'], ['jole_group_jguerrero', 'j.guerrero@jolebtxgroup.com'],
    ['jole_team_jorge', 'jorge@jolebtxteam.com'], ['jole_team_jguerrero', 'j.guerrero@jolebtxteam.com'],
    ['jole_industrial_jorge', 'jorge@joleindustrial.com'], ['jole_industrial_jguerrero', 'j.guerrero@joleindustrial.com']]
    .map(([id, email]) => ({ id, email, clientId: 'jole', status: id.includes('industrial') ? 'warming' : 'active' })),
];

const ACTIVITIES = [
  queued('j1', 'jole_team_jguerrero'),
  sent('g1', 'j1', 'jole_team_jguerrero', '2026-10-19T13:38:18.067Z'),
  replyEvent('j1'),
  // A ScaleLab conversation with the same shape must never surface for Jole.
  sent('s-g1', 's1', 'primary', '2026-10-18T15:00:00Z'),
  replyEvent('s1', { clientId: 'scalelab', content: 'SCALELAB-ONLY reply text', workflowState: 'positive_interest', sentiment: 'positive' }),
];

async function withServer(dataset, run) {
  const store = createMemoryLedgerStore();
  const app = express();
  registerClientRoutes(app, {
    requireAuth: (_req, _res, next) => next(), loadDataset: async () => dataset,
    getStore: () => store, senders: () => senders, routedLeadReady: () => ({ ok: false }),
    startReportScheduler: false, env: {}, log: { log() {}, error() {} },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await run(`http://127.0.0.1:${server.address().port}/api/clients`, store); } finally { await new Promise(resolve => server.close(resolve)); }
}
const dataset = (leads, activities = ACTIVITIES) => ({ leads, activities, suppressedEmails: new Set(['j1@customtruck.example']) });

// ── view model ──────────────────────────────────────────────────────────────

test('the drawer shows the sender that actually sent, from send history, with its address and a friendly label', () => {
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: ACTIVITIES, senders });
  assert.equal(detail.sender.state, 'confirmed');
  assert.equal(detail.sender.source, 'send_history');
  assert.equal(detail.sender.senderId, 'jole_team_jguerrero');
  assert.equal(detail.sender.email, 'j.guerrero@jolebtxteam.com');
  assert.equal(detail.sender.label, 'Jole Team — J. Guerrero');
  assert.deepEqual(detail.sender.proof, { eventType: 'initial_email_sent', step: 1, sentAt: '2026-10-19T13:38:18.067Z', providerMessageId: 'g1' });
  assert.equal(detail.sender.assignmentDiffers, false);
});

test('send history beats the row: a lead reassigned after the send still shows the inbox that sent', () => {
  const lead = joleLead('j1', { senderInboxId: 'jole_group_jorge' });
  const detail = buildClientConversationDetail({ clientId: 'jole', lead, activities: ACTIVITIES, senders });
  assert.equal(detail.sender.senderId, 'jole_team_jguerrero');
  assert.equal(detail.sender.email, 'j.guerrero@jolebtxteam.com');
  assert.equal(detail.sender.source, 'send_history');
  assert.equal(detail.sender.assigned.senderId, 'jole_group_jorge');
  assert.equal(detail.sender.assigned.email, 'jorge@jolebtxgroup.com');
  assert.equal(detail.sender.assignmentDiffers, true);
  assert.equal(detail.sender.assignmentConflict, true, 'the send path calls this a conflict; the drawer says so');
});

test('an unsent assignment is labelled as an assignment, and no evidence is never a guess', () => {
  const queuedOnly = buildClientConversationDetail({
    clientId: 'jole', lead: joleLead('j2', { stage: 'Queued', emailStatus: '', emailStep: '0', notes: '', lastEmailedAt: '', senderInboxId: 'jole_team_jorge' }),
    activities: [queued('j2', 'jole_team_jorge')], senders,
  });
  assert.equal(queuedOnly.sender.state, 'assigned');
  assert.equal(queuedOnly.sender.source, 'assignment');
  assert.equal(queuedOnly.sender.email, 'jorge@jolebtxteam.com');
  assert.equal(queuedOnly.sequence.steps[0].state, 'current');
  const none = buildClientConversationDetail({
    clientId: 'jole', lead: joleLead('j3', { senderInboxId: '', stage: 'Import', emailStatus: '', emailStep: '0', notes: '' }), activities: [], senders,
  });
  assert.equal(none.sender.state, 'unknown');
  assert.equal(none.sender.senderId, '');
  assert.equal(none.sender.email, '');
});

test('friendly labels are formatted from the registry id and address, for all six Jole inboxes', () => {
  assert.deepEqual(senders.filter(sender => sender.clientId === 'jole').map(sender => senderDisplayLabel(sender.id, sender.email)), [
    'Jole Group — Jorge', 'Jole Group — J. Guerrero', 'Jole Team — Jorge', 'Jole Team — J. Guerrero',
    'Jole Industrial — Jorge', 'Jole Industrial — J. Guerrero',
  ]);
});

test('sequence: Step 1 sent, the reply stopped the rest, and the reply keeps raw text and classification apart', () => {
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: ACTIVITIES, senders });
  assert.deepEqual(detail.sequence.steps.map(step => [step.step, step.label, step.state]), [
    [1, 'Initial outreach', 'sent'], [2, 'Follow-up', 'stopped'], [3, 'Final follow-up', 'stopped']]);
  assert.equal(detail.sequence.stoppedByReply, true);
  assert.equal(detail.sequence.summary, 'Stopped by reply after Step 1');
  assert.equal(detail.sequence.nextFollowUpAt, '');
  assert.equal(detail.replies.length, 1);
  const [reply] = detail.replies;
  assert.equal(reply.body, LONG_REPLY, 'the stored body is passed through untouched');
  assert.equal(reply.workflowState, 'unsubscribe');
  assert.equal(reply.sentiment, 'unsubscribe');
  assert.deepEqual(reply.classifier, { state: 'negative', reason: 'unsubscribe_request', confidence: 'high' });
  assert.equal(reply.receivedAt, '2026-10-19T13:40:42.000Z');
  assert.equal(detail.timestamps.firstOutreachAt, '2026-10-19T13:38:18.067Z');
  assert.equal(detail.timestamps.replyReceivedAt, '2026-10-19T13:40:42.000Z');
  assert.equal(detail.pipeline.stage, 'closed');
  assert.equal(detail.pipeline.closed, true);
  assert.equal(detail.pipeline.conversationStatus, 'closed_unsubscribed');
  assert.equal(detail.pipeline.nextAction.owner, 'none');
});

test('sequence in flight: the next step is current with the shared cadence due date', () => {
  const lead = joleLead('j4', { stage: 'Contacted', emailStatus: 'emailed', notes: '', lastEmailedAt: '2026-10-19T13:38:18.067Z' });
  const detail = buildClientConversationDetail({ clientId: 'jole', lead, activities: [sent('g4', 'j4', 'jole_group_jorge', '2026-10-19T13:38:18.067Z')], senders });
  assert.deepEqual(detail.sequence.steps.map(step => step.state), ['sent', 'current', 'pending']);
  assert.equal(detail.sequence.nextFollowUpStep, 2);
  assert.equal(detail.sequence.nextFollowUpAt, '2026-10-22T13:38:18.067Z');
  assert.equal(detail.timestamps.nextFollowUpAt, '2026-10-22T13:38:18.067Z');
  assert.equal(detail.pipeline.nextAction.owner, 'automation');
  assert.equal(detail.sender.senderId, 'jole_group_jorge');
});

test('campaign context comes from the lead research profile', () => {
  const { campaign } = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: ACTIVITIES, senders });
  assert.equal(campaign.id, JOLE_CAMPAIGN);
  assert.ok(campaign.label, 'the registered campaign label');
  assert.deepEqual(campaign.primaryRole, { raw: 'CNC MACHINIST', clean: 'CNC Machinists', status: 'clean' });
  assert.deepEqual(campaign.secondaryRole, { raw: 'WELDER', clean: 'Welders', status: 'clean' });
  assert.equal(campaign.location, 'Lynchburg, VA');
  assert.equal(campaign.evidenceUrl, 'https://jobs.example/cnc-machinist-4456038987');
  assert.equal(campaign.postingDate, '2026-10-02');
  assert.equal(campaign.verifiedAt, '2026-10-07');
});

test('missing optional fields: no profile, no sends, no replies, no ledger still yields a complete, empty-safe model', () => {
  const bare = { id: 'j5', clientId: 'jole', company: '', email: 'j5@x.example', campaign: JOLE_CAMPAIGN };
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: bare, activities: [], senders: [] });
  assert.deepEqual(detail.replies, []);
  assert.equal(detail.campaign.primaryRole, null);
  assert.equal(detail.campaign.evidenceUrl, '');
  assert.equal(detail.contact.title, '');
  assert.equal(detail.sender.state, 'unknown');
  assert.deepEqual(detail.sequence.steps.map(step => step.state), ['pending', 'pending', 'pending']);
  assert.equal(detail.timestamps.firstOutreachAt, '');
});

test('a profile URL that is not http(s) is dropped, never rendered as a link', () => {
  const lead = joleLead('j1', { campaign_notes: profile({ hiring: { site: 'X', roles: [], evidenceUrl: 'javascript:alert(1)' } }) });
  assert.equal(buildClientConversationDetail({ clientId: 'jole', lead, activities: [], senders }).campaign.evidenceUrl, '');
});

// ── tenant isolation ────────────────────────────────────────────────────────

test('isolation: ScaleLab activity, replies and inboxes never reach a Jole conversation', () => {
  // A Jole lead handed foreign rows (another lead's, another client's reply, a ScaleLab inbox).
  const foreignReply = { ...replyEvent('j1', { clientId: 'scalelab', content: 'SCALELAB-ONLY reply text' }), eventId: 'x' };
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: [...ACTIVITIES, foreignReply], senders });
  const text = JSON.stringify(detail);
  assert.equal(text.includes('SCALELAB-ONLY'), false);
  assert.equal(text.includes('scale@scalelab.example'), false);
  assert.equal(detail.replies.length, 1);
  // A Jole lead whose send names a ScaleLab inbox: the id is shown, its address is not.
  const crossed = buildClientConversationDetail({
    clientId: 'jole', lead: joleLead('j6', { senderInboxId: '' }), activities: [sent('gx', 'j6', 'primary', '2026-10-19T13:00:00Z')], senders,
  });
  assert.equal(crossed.sender.senderId, 'primary');
  assert.equal(crossed.sender.inClient, false);
  assert.equal(crossed.sender.email, '');
  assert.equal(JSON.stringify(crossed).includes('scale@scalelab.example'), false);
});

test('API: Jole gets its own conversation; ScaleLab leads and ScaleLab itself get 404, and nothing is written', async () => {
  const data = dataset([joleLead('j1'), scaleLead('s1')]);
  const before = JSON.stringify(data.leads);
  await withServer(data, async (url, store) => {
    const response = await fetch(`${url}/jole/inbox/j1`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.clientId, 'jole');
    assert.equal(detail.leadId, 'j1');
    assert.equal(detail.sender.email, 'j.guerrero@jolebtxteam.com');
    assert.deepEqual(detail.pipeline.suppression && detail.pipeline.suppression.scope, 'global');
    // A ScaleLab lead through Jole's route, and ScaleLab's own route: both 404.
    const crossLead = await fetch(`${url}/jole/inbox/s1`);
    assert.equal(crossLead.status, 404);
    assert.equal(JSON.stringify(await crossLead.json()).includes('ScaleLab Staffing Co'), false);
    assert.equal((await fetch(`${url}/scalelab/inbox/s1`)).status, 404, 'ScaleLab (legacy reply policy) has no managed drawer');
    assert.equal((await fetch(`${url}/scalelab/inbox/j1`)).status, 404, 'Jole data never answers on the ScaleLab route');
    assert.equal((await fetch(`${url}/nobody/inbox/j1`)).status, 404);
    assert.equal(store.tables.opportunities.size, 0, 'a read writes no ledger row');
  });
  assert.equal(JSON.stringify(data.leads), before, 'a read mutates no lead');
});

test('API: the Inbox list now carries leadId for every row so a row can open its drawer', async () => {
  await withServer(dataset([joleLead('j1'), scaleLead('s1')]), async url => {
    const inbox = await (await fetch(`${url}/jole/inbox`)).json();
    assert.deepEqual(inbox.conversations.map(row => row.leadId), ['j1']);
  });
});

// ── dashboard ───────────────────────────────────────────────────────────────

function fnSource(name) {
  const start = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const end = html.indexOf('\n}\n', start);
  return html.slice(start, end + 3);
}
// The dashboard's own renderer and helpers, run against a minimal DOM.
function loadDrawer({ answer }) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, innerHTML: '', textContent: '', focused: false,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        focus() { nodes.forEach(item => { item.focused = false; }); this.focused = true; },
      });
    }
    return nodes.get(id);
  };
  const listeners = [];
  const document = {
    getElementById: node, addEventListener: (type, fn) => listeners.push([type, fn]), contains: () => true, activeElement: null,
  };
  const start = html.indexOf('\nasync function renderManagedInbox(');
  const block = html.slice(start, html.indexOf('\nasync function renderManagedBookings('));
  const helpers = ['esc', 'escAttr', 'rdFormatTime', 'metricCard', 'emptyState', 'clientStatusBadges', 'onboardingPending'].map(fnSource).join('\n');
  const factory = new Function('document', 'answer', `
    const EMPTY_ICONS = {};
    let activeClientId = 'jole'; let clientViewToken = 0;
    let clientDetailLeadId = ''; let clientDetailReturnFocus = null;
    const activeClient = () => ({ clientId: 'jole', displayName: 'Jole BTX LLC', lifecycleStatus: 'active', active: true });
    const campaignName = id => id;
    const calls = [];
    async function clientApi(path) { calls.push(path); return answer(path); }
    ${helpers}
    ${block}
    return { renderManagedInbox, openClientConversation, closeClientConversation, calls,
      settle: () => new Promise(resolve => setTimeout(resolve, 0)), switchClient: () => { clientViewToken += 1; activeClientId = 'other'; } };
  `);
  return { ui: factory(document, answer), node, listeners };
}

test('dashboard: clicking a Jole Inbox row opens the drawer with that lead, its sender, sequence, reply and context', async () => {
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: ACTIVITIES, senders });
  const longCompany = 'Custom Truck One Source Industrial Fabrication And Machinery Services Holdings Incorporated';
  const { ui, node, listeners } = loadDrawer({
    answer: async p => (p === '/inbox' ? { total: 1, awaitingClarification: 0, conversations: [{
      leadId: 'j1', company: longCompany, contactName: 'Cindy Thomas', email: 'j1@customtruck.example', campaign: JOLE_CAMPAIGN,
      receivedAt: '2026-10-19T13:40:42Z', workflowState: 'unsubscribe', sentiment: 'unsubscribe', conversationStatus: 'closed_unsubscribed',
      excerpt: 'Please remove me', subject: '', openClarifications: [] }] } : { ...detail, contact: { ...detail.contact, company: longCompany } }),
  });
  const list = await ui.renderManagedInbox({ clientId: 'jole', displayName: 'Jole BTX LLC', sending: {} });
  // The row is a real button that opens this lead's drawer.
  assert.match(list, /<button type="button" class="inbox-row" data-lead-id="j1" onclick="openClientConversation\(this\.dataset\.leadId\)"/);
  ui.openClientConversation('j1');
  assert.equal(node('client-detail-overlay').classList.contains('open'), true);
  assert.equal(node('cd-close').focused, true, 'focus moves into the drawer');
  await ui.settle();
  assert.deepEqual(ui.calls, ['/inbox', '/inbox/j1']);
  const body = node('cd-body').innerHTML;
  assert.equal(node('cd-name').textContent, longCompany);
  assert.equal(node('cd-sub').textContent, 'Cindy Thomas · Human Resources Manager');
  // Order of the sections is the agreed hierarchy.
  const order = ['>Contact<', '>Reply<', '>Sending inbox<', '>Email sequence<', '>Campaign context<', '>Pipeline &amp; next action<', '>Activity<'].map(title => body.indexOf(title));
  assert.ok(order.every(index => index >= 0), 'every section renders');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Sender: friendly label, exact address and inbox id.
  assert.match(body, /Jole Team — J\. Guerrero/);
  assert.match(body, /j\.guerrero@jolebtxteam\.com/);
  assert.match(body, /Inbox ID: <span class="cd-mono">jole_team_jguerrero<\/span>/);
  assert.match(body, /Confirmed by sent email/);
  assert.match(body, /Gmail message <span class="cd-mono">g1<\/span>/);
  // Sequence and reply.
  assert.match(body, /Step 1 — Initial outreach[\s\S]*Sent ·/);
  assert.match(body, /Step 2 — Follow-up[\s\S]*Not sent — stopped by reply/);
  assert.match(body, /Step 3 — Final follow-up/);
  assert.match(body, /Stopped by reply after Step 1/);
  assert.match(body, /data-tone="negative">unsubscribe</);
  assert.match(body, /unsubscribe request · high confidence/);
  assert.ok(body.includes(LONG_REPLY), 'the full stored reply renders, unclamped');
  // Campaign context.
  assert.match(body, /CNC Machinists <small[^>]*>posted as CNC MACHINIST/);
  assert.match(body, /Welders/);
  assert.match(body, /Lynchburg, VA/);
  assert.match(body, /href="https:\/\/jobs\.example\/cnc-machinist-4456038987" target="_blank" rel="noopener noreferrer"/);
  assert.match(body, /Conversation closed<\/span><span class="detail-field-val">Yes/);
  assert.match(body, /Globally suppressed|Not suppressed/);
  // Close by the button, then reopen.
  ui.closeClientConversation();
  assert.equal(node('client-detail-overlay').classList.contains('open'), false);
  ui.openClientConversation('j1');
  assert.equal(node('client-detail-overlay').classList.contains('open'), true);
  // Escape closes it.
  listeners.filter(([type]) => type === 'keydown').forEach(([, fn]) => fn({ key: 'Escape' }));
  assert.equal(node('client-detail-overlay').classList.contains('open'), false);
});

test('dashboard: a response for another client or lead, or one that lands after a client switch, is never rendered', async () => {
  const detail = buildClientConversationDetail({ clientId: 'jole', lead: joleLead('j1'), activities: ACTIVITIES, senders });
  const wrong = loadDrawer({ answer: async () => ({ ...detail, clientId: 'scalelab' }) });
  wrong.ui.openClientConversation('j1');
  await wrong.ui.settle();
  assert.equal(wrong.node('cd-body').innerHTML.includes('jole_team_jguerrero'), false);
  assert.match(wrong.node('cd-body').innerHTML, /could not be loaded/);
  let release;
  const slow = loadDrawer({ answer: () => new Promise(resolve => { release = () => resolve(detail); }) });
  slow.ui.openClientConversation('j1');
  slow.ui.switchClient();
  release();
  await slow.ui.settle();
  assert.equal(slow.node('cd-body').innerHTML.includes('jole_team_jguerrero'), false);
});

test('dashboard: a conversation with no optional data renders without empty N/A sections', async () => {
  const bare = buildClientConversationDetail({
    clientId: 'jole', lead: { id: 'j5', clientId: 'jole', company: 'Bare Co', email: 'j5@x.example', campaign: JOLE_CAMPAIGN }, activities: [], senders: [],
  });
  const { ui, node } = loadDrawer({ answer: async () => bare });
  ui.openClientConversation('j5');
  await ui.settle();
  const body = node('cd-body').innerHTML;
  assert.equal(node('cd-name').textContent, 'Bare Co');
  assert.equal(body.includes('>Reply<'), false, 'no reply section without a reply');
  assert.equal(/N\/A|undefined|null/.test(body), false);
  assert.match(body, /Unknown/);
});

test('ScaleLab drawer and ScaleLab Inbox are byte-for-byte unchanged from production', () => {
  const prod = execFileSync('git', ['show', '6982754:public/index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const slice = (source, from, to) => { const start = source.indexOf(from); return source.slice(start, source.indexOf(to, start)); };
  for (const [from, to] of [
    ['function openCeDetail(id) {', '\n// Table cell text'],
    ['function closeCeDetail(e) {', '\nasync function loadCeActivity'],
    ['async function loadCeActivity(id) {', '\nfunction openCeDetail'],
    ['function renderInboxWorkspace() {', '\nasync function loadSequencesWorkspace'],
    ['async function loadInboxWorkspace() {', '\nfunction inboxActionFor'],
    ['<div class="detail-overlay" id="ce-detail-overlay"', '<!-- A managed client'],
  ]) {
    const before = slice(prod, from, to === '<!-- A managed client' ? '<script src="/workspace-shared.js">' : to);
    const after = slice(html, from, to);
    assert.ok(before.length > 100, `${from} found in production`);
    assert.equal(after.trimEnd(), before.trimEnd(), `${from} is unchanged`);
  }
  // The managed drawer never reuses the ScaleLab drawer's element ids.
  const drawer = slice(html, '<div class="detail-overlay" id="client-detail-overlay"', '<script src="/workspace-shared.js">');
  assert.equal(/ce-d-|ce-detail/.test(drawer), false);
  assert.equal(/ce-d-|ce-detail-overlay/.test(fnSource('renderClientConversation')), false);
});
