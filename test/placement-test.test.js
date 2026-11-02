'use strict';

// The controlled inbox-placement test: owned mailboxes only, real quota and
// reservations, no access to prospects, and no effect on the other client.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PLACEMENT_TEST_EVENT, PLACEMENT_TEST_RECIPIENTS, validPlacementLabel, placementActionId, placementMessage, placementSenders, runPlacementTest,
} = require('../integrations/placement-test');
const { senderCountsToday, successfulSendCountToday } = require('../integrations/gmail-sender-routing');
const { clientSendCountsToday } = require('../integrations/clients/capacity');
const { createSendQuotaCoordinator } = require('../integrations/send-quota-coordinator');
const { buildSendRunPlan } = require('../integrations/send-run-plan');

const root = path.join(__dirname, '..');
const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(root, 'integrations', 'placement-test.js'), 'utf8');

const SENDERS = [
  { id: 'jole_group_jorge', email: 'jorge@jolebtxgroup.com', clientId: 'jole', sendEligible: true, dailyLimit: 15, perRunLimit: 2 },
  { id: 'jole_team_jorge', email: 'jorge@jolebtxteam.com', clientId: 'jole', sendEligible: true, dailyLimit: 20, perRunLimit: 2 },
];
const messageFor = ({ label, sender, recipient }) => placementMessage({ label, sender, recipient, senderName: 'Jorge Guerrero', mailingAddress: 'Addr' });
const passThroughQuota = { execute: ({ run }) => run({ markProviderStart: async () => {} }) };
const passThroughReserve = (_action, run) => run();

test('recipients are exactly the two owned Workspace mailboxes', () => {
  assert.deepEqual(PLACEMENT_TEST_RECIPIENTS.map(item => item.email), ['deins@scalelabai.ca', 'deins@scalelabaiteam.com']);
  assert.ok(PLACEMENT_TEST_RECIPIENTS.every(item => item.provider === 'google_workspace'));
});

test('a recipient off the owned list refuses the whole run before anything sends', async () => {
  let sends = 0;
  await assert.rejects(() => runPlacementTest({ label: 'seed-001', senders: SENDERS, recipients: [{ id: 'x', email: 'prospect@corp.com' }],
    quota: passThroughQuota, reserve: passThroughReserve, deliver: () => { sends += 1; }, record: async () => {}, messageFor }), /owned list/);
  assert.equal(sends, 0);
});

test('the module cannot reach a lead: it takes no lead, queue or stage input', () => {
  assert.doesNotMatch(moduleText, /require\(/);
  assert.doesNotMatch(moduleText, /campaign|stage|emailStatus|queued/i);
});

test('only eligible Jole inboxes take part', () => {
  const senders = [...SENDERS, { id: 'primary', clientId: 'scalelab', sendEligible: true }, { id: 'jole_held', clientId: 'jole', sendEligible: false },
    { id: 'jole_paused', clientId: 'jole', sendEligible: true }];
  assert.deepEqual(placementSenders(senders, { mayStillSend: sender => sender.id !== 'jole_paused' }).map(s => s.id), ['jole_group_jorge', 'jole_team_jorge']);
});

test('labels are strict and action ids are deterministic', () => {
  assert.equal(validPlacementLabel('seed-20261101a'), true);
  for (const bad of ['', 'a', 'UPPER', 'has space', 'x'.repeat(41), '../etc']) assert.equal(validPlacementLabel(bad), false);
  assert.equal(placementActionId('seed-1', 's', 'r'), 'placement-test:seed-1:s:r');
});

test('the message says it is a test, carries no link, and names its run', () => {
  const message = messageFor({ label: 'seed-001', sender: SENDERS[0], recipient: PLACEMENT_TEST_RECIPIENTS[0] });
  assert.match(message.subject, /Inbox placement test seed-001/);
  assert.match(message.body, /controlled inbox placement test/);
  assert.match(message.body, /no action is needed/);
  assert.doesNotMatch(message.body, /https?:\/\//);
  assert.equal(message.to, 'deins@scalelabai.ca');
});

test('every send passes quota, then reservation, then provider, then the ledger', async () => {
  const order = [];
  const quota = { execute: async ({ actionId, clientId, senderId, run }) => { order.push(`quota:${clientId}:${senderId}`); return run({ markProviderStart: async () => order.push('start') }); } };
  const reserve = async (action, run) => { order.push(`reserve:${action.actionType}`); assert.equal(action.ownership.clientId, 'jole'); return run(); };
  const deliver = async () => { order.push('provider'); return { data: { id: 'g1', threadId: 't1' } }; };
  const record = async row => order.push(`ledger:${row.gmailMessageId}`);
  const results = await runPlacementTest({ label: 'seed-001', senders: [SENDERS[0]], recipients: [PLACEMENT_TEST_RECIPIENTS[0]], quota, reserve, deliver, record, messageFor });
  assert.deepEqual(order, ['quota:jole:jole_group_jorge', 'reserve:gmail_placement_test', 'start', 'provider', 'ledger:g1']);
  assert.equal(results[0].status, 'accepted');
  assert.equal(results[0].gmailMessageId, 'g1');
});

test('a ledger failure after Gmail accepted the message is never reported as refused', async () => {
  const results = await runPlacementTest({ label: 'seed-001', senders: [SENDERS[0]], recipients: [PLACEMENT_TEST_RECIPIENTS[0]], quota: passThroughQuota, reserve: passThroughReserve,
    deliver: async () => ({ data: { id: 'g1', threadId: 't1' } }), record: async () => { throw new Error('sheet unavailable'); }, messageFor });
  assert.equal(results[0].status, 'accepted');
  assert.equal(results[0].ledger, 'failed');
});

test('an exhausted cap or a held action sends nothing and is reported', async () => {
  let sends = 0;
  const quota = { execute: async () => { throw Object.assign(new Error('day:sender is exhausted'), { code: 'quota_exhausted' }); } };
  const results = await runPlacementTest({ label: 'seed-001', senders: SENDERS, quota, reserve: passThroughReserve, deliver: () => { sends += 1; }, record: async () => { throw new Error('must not record'); }, messageFor });
  assert.equal(sends, 0);
  assert.equal(results.length, 4);
  assert.ok(results.every(item => item.status === 'refused' && item.code === 'quota_exhausted'));
});

test('the real coordinator refuses a test send once the inbox has spent its day', async () => {
  const capacity = { globalDailyLimit: 275, globalPerRunLimit: 39, clientLimits: { scalelab: { daily: 170, perRun: 27 }, jole: { daily: 105, perRun: 12 } } };
  const spent = buildSendRunPlan({ senders: SENDERS, capacity, sentTodayBySender: new Map([['jole_group_jorge', 15]]), sentTodayByClient: new Map([['jole', 15]]), sentTodayGlobal: 15, perInboxRunCap: 2 });
  assert.equal(spent.lanes.find(lane => lane.senderId === 'jole_group_jorge').budget, 0);
  assert.equal(spent.lanes.find(lane => lane.senderId === 'jole_team_jorge').budget, 2);
  const store = { beginRun: async () => {}, reserve: async () => {}, markSending: async () => {}, markConsumed: async () => {} };
  const quota = createSendQuotaCoordinator({ store, runId: 'r', dayKey: '2026-11-01', plan: spent, baselines: { global: 15, clients: new Map(), senders: new Map() }, log: () => {} });
  let sends = 0;
  const results = await runPlacementTest({ label: 'seed-001', senders: SENDERS, quota, reserve: passThroughReserve, deliver: async () => { sends += 1; return { id: `g${sends}` }; }, record: async () => {}, messageFor });
  assert.equal(sends, 2, 'only the inbox with capacity sends');
  assert.deepEqual(results.filter(item => item.status === 'refused').map(item => item.senderInboxId), ['jole_group_jorge', 'jole_group_jorge']);
});

test('a test send counts against its inbox, the global day and Jole, never ScaleLab', () => {
  const row = { eventId: 'placement-test:seed:jole_group_jorge:r', eventType: PLACEMENT_TEST_EVENT, leadId: '', sourceLeadId: '', occurredAt: '2026-11-02T01:00:00Z',
    metadata: JSON.stringify({ senderInboxId: 'jole_group_jorge', clientId: 'jole' }) };
  const dayKey = '2026-11-01';
  assert.equal(senderCountsToday([row], dayKey).get('jole_group_jorge'), 1);
  assert.equal(successfulSendCountToday([row], dayKey), 1);
  const clients = clientSendCountsToday([row], { dayKey, leadsById: new Map() });
  assert.equal(clients.get('jole'), 1);
  assert.equal(clients.get('scalelab') || 0, 0);
});

test('the agent only enters the test on its own variable, and shares the single provider call', () => {
  assert.match(agent, /if \(PLACEMENT_TEST_LABEL\) await runPlacementTestPass\(\);\s*else await runInner\(\);/);
  assert.equal((agent.match(/users\.messages\.send\(/g) || []).length, 1, 'one provider send call in the agent');
  const pass = agent.slice(agent.indexOf('async function runPlacementTestPass'), agent.indexOf('async function runInner() {'));
  assert.match(pass, /assertSendAuthorized\(\)/);
  assert.match(pass, /assertSendLockReady\(\)/);
  assert.match(pass, /clientSendBlock\(PLACEMENT_TEST_CLIENT\)/);
  assert.match(pass, /createSendQuotaCoordinator/);
  assert.match(pass, /withOutboundReservation/);
  assert.match(pass, /clientSendWindowVerdict\(PLACEMENT_TEST_CLIENT\)\.allowed/);
  assert.doesNotMatch(pass, /selectQueued|selectFollowUps|markSent/);
});

test('the route is authenticated, explicit, and refuses during a send window or a live run', () => {
  const route = server.slice(server.indexOf("app.post('/api/ops/placement-test'"), server.indexOf("// End placement test route"));
  assert.match(route, /requireAuth/);
  assert.match(route, /PLACEMENT_TEST_CONFIRM/);
  assert.match(route, /validPlacementLabel/);
  assert.match(route, /clientSendWindowVerdict\(PLACEMENT_TEST_CLIENT\)\.allowed/);
  assert.match(route, /agentState\.running \|\| automationLaunchReserved/);
  assert.match(route, /PLACEMENT_TEST_LABEL/);
});
