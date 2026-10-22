'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSendRunPlan } = require('../integrations/send-run-plan');
const { createSendQuotaCoordinator, preDeliveryRefusal } = require('../integrations/send-quota-coordinator');
const { createSenderPacer } = require('../integrations/sender-pacer');
const { runSenderLanes, concurrentSenderLanesEnabled } = require('../integrations/sender-lanes');
const { createMemorySendQuotaStore } = require('../test-support/send-quota-memory');
const { simulate } = require('../scripts/simulate-send-throughput');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { setSendReservationStoreForTests, closeSendReservationStore,
  withOutboundReservation } = require('../integrations/send-lock');

const sender = (id, clientId, dailyLimit, perRunLimit) =>
  ({ id, clientId, dailyLimit, perRunLimit, sendEligible: dailyLimit > 0 });
const senders = [
  sender('primary', 'scalelab', 50, 6), sender('tryscalelabai', 'scalelab', 30, 6),
  sender('deniels', 'scalelab', 45, 5), sender('deniels_tryscalelabai', 'scalelab', 45, 5),
  sender('scalelabaiteam', 'scalelab', 15, 5),
  ...['jole_team_jorge', 'jole_team_jguerrero', 'jole_group_jorge', 'jole_group_jguerrero']
    .map(id => sender(id, 'jole', 15, 2)),
  sender('jole_industrial_jorge', 'jole', 0, 2),
  sender('jole_industrial_jguerrero', 'jole', 0, 2),
];
const capacity = { globalDailyLimit: 245, globalPerRunLimit: 39,
  clientLimits: { scalelab: { daily: 185, perRun: 27 }, jole: { daily: 60, perRun: 12 } } };
const dayKey = '2026-10-20';
const silent = () => {};

test('concurrent sender lanes require an explicit true flag', async () => {
  assert.equal(concurrentSenderLanesEnabled({}), false);
  assert.equal(concurrentSenderLanesEnabled({ SEND_CONCURRENT_SENDER_LANES: 'false' }), false);
  assert.equal(concurrentSenderLanesEnabled({ SEND_CONCURRENT_SENDER_LANES: 'true' }), true);
  let running = 0;
  let peak = 0;
  await runSenderLanes([{ id: 'a' }, { id: 'b' }], async () => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 1));
    running--;
  }, { parallel: concurrentSenderLanesEnabled({}) });
  assert.equal(peak, 1);
});

function customPlan({ globalDaily = 10, globalRun = 10, clientDaily = 10, clientRun = 10,
  laneDaily = 10, laneRun = 1, clientId = 'scalelab', senderIds = ['a', 'b'] } = {}) {
  return { globalDailyLimit: globalDaily, globalRunLimit: globalRun,
    clientLimits: { [clientId]: { daily: clientDaily, perRun: clientRun } },
    lanes: senderIds.map(senderId => ({ senderId, clientId,
      budget: laneRun, dailyLimit: laneDaily, runLimit: laneRun })),
    totalPlanned: senderIds.length * laneRun };
}
function baselines({ global = 0, clientId = 'scalelab', client = 0, senders: senderCounts = {} } = {}) {
  return { global, clients: new Map([[clientId, client]]), senders: new Map(Object.entries(senderCounts)) };
}
async function ready(options = {}) {
  const store = createMemorySendQuotaStore();
  const plan = options.plan || customPlan();
  const coordinator = createSendQuotaCoordinator({ store, runId: options.runId || 'run-1', dayKey,
    plan, baselines: options.baselines || baselines({ clientId: Object.keys(plan.clientLimits)[0] }),
    now: options.now, deadlineAt: options.deadlineAt || null, log: silent });
  await coordinator.start();
  return { store, coordinator };
}

test('fixed plan preserves all exact daily, client and inbox ceilings', () => {
  const plan = buildSendRunPlan({ senders, capacity,
    sentTodayBySender: new Map(), sentTodayByClient: new Map(), sentTodayGlobal: 0,
    perInboxRunCap: 6 });
  assert.equal(plan.globalDailyLimit, 245);
  assert.equal(plan.totalPlanned, 35);
  assert.equal(plan.lanes.filter(lane => lane.clientId === 'scalelab').reduce((n, lane) => n + lane.budget, 0), 27);
  assert.equal(plan.lanes.filter(lane => lane.clientId === 'jole').reduce((n, lane) => n + lane.budget, 0), 8);
  assert.deepEqual(Object.fromEntries(plan.lanes.map(lane => [lane.senderId, lane.dailyLimit])),
    Object.fromEntries(senders.filter(item => item.sendEligible).map(item => [item.id, item.dailyLimit])));
  assert.equal(plan.lanes.some(lane => lane.senderId.startsWith('jole_industrial')), false);
  assert.equal(senders.filter(item => item.clientId === 'scalelab').reduce((n, item) => n + item.dailyLimit, 0), 185);
  assert.equal(senders.filter(item => item.clientId === 'jole').reduce((n, item) => n + item.dailyLimit, 0), 60);
});

async function raceLastSlot({ plan, initial, clientId = 'scalelab', targets = ['a', 'b'] }) {
  const { store, coordinator } = await ready({ plan, baselines: initial });
  const results = await Promise.allSettled(targets.map((senderId, index) =>
    coordinator.execute({ actionId: `action-${index}`, clientId, senderId,
      run: async ({ markProviderStart }) => { await markProviderStart(); return { id: index }; } })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  await coordinator.finish();
  return store.snapshot();
}

test('concurrent senders race for one remaining global daily slot', async () => {
  const state = await raceLastSlot({ plan: customPlan({ globalDaily: 2 }),
    initial: baselines({ global: 1 }) });
  assert.equal(state.buckets.get(`day:global:${dayKey}`).used, 2);
});
test('two Jole inboxes race for the final client slot; Jole stops at 60', async () => {
  const state = await raceLastSlot({ plan: customPlan({ globalDaily: 245, clientDaily: 60,
    clientId: 'jole' }), initial: baselines({ clientId: 'jole', client: 59 }), clientId: 'jole' });
  assert.equal(state.buckets.get(`day:client:jole:${dayKey}`).used, 60);
});
test('two attempts race for the last sender daily slot', async () => {
  const plan = customPlan({ senderIds: ['a'], laneDaily: 1, laneRun: 2 });
  const { store, coordinator } = await ready({ plan });
  const results = await Promise.allSettled([0, 1].map(i => coordinator.execute({
    actionId: `a-${i}`, senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart(); return i; },
  })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().buckets.get(`day:sender:a:${dayKey}`).used, 1);
  await coordinator.finish();
});
test('different inboxes race for the final global run slot', async () => {
  const state = await raceLastSlot({ plan: customPlan({ globalRun: 1 }), initial: baselines() });
  assert.equal(state.buckets.get('run:global:run-1').used, 1);
});
test('duplicate lead action gets exactly one quota reservation and provider call', async () => {
  const { store, coordinator } = await ready({ plan: customPlan({ senderIds: ['a'], laneRun: 2 }) });
  let providerCalls = 0;
  const send = () => coordinator.execute({ actionId: 'lead-1:step-2', senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart(); providerCalls++; return true; } });
  const results = await Promise.allSettled([send(), send()]);
  assert.equal(providerCalls, 1);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().actions.get('lead-1:step-2').status, 'consumed');
  await coordinator.finish();
});

test('a durable action refusal releases its separate quota hold before provider dispatch', async () => {
  const actions = createMemorySendReservationStore();
  setSendReservationStoreForTests(actions);
  const { store, coordinator } = await ready({ plan: customPlan({ senderIds: ['a'] }) });
  const action = { actionId: 'already-sent-action', leadId: 'lead-1',
    actionType: 'gmail_cold_step', provider: 'gmail' };
  const env = { SEND_LOCK_ENABLED: 'true', SEND_LOCK_DATABASE_URL: 'test-injected-store' };
  try {
    await withOutboundReservation(action, async () => ({ data: { id: 'prior-send' } }), env);
    let providerCalls = 0;
    await assert.rejects(coordinator.execute({ actionId: action.actionId,
      senderId: 'a', clientId: 'scalelab', run: ({ markProviderStart }) =>
        withOutboundReservation(action, async () => {
          await markProviderStart(); providerCalls++; return { data: { id: 'duplicate' } };
        }, env) }), error => error.code === 'reservation_sent_unconfirmed');
    assert.equal(providerCalls, 0);
    assert.equal(store.snapshot().buckets.get(`day:global:${dayKey}`).used, 0);
    assert.equal(store.snapshot().actions.get(action.actionId).status, 'released');
  } finally {
    await coordinator.finish();
    await closeSendReservationStore();
  }
});

test('definite pre-delivery refusal releases capacity; ambiguous outcome keeps it', async () => {
  const { store, coordinator } = await ready({ plan: customPlan({ senderIds: ['a'], laneRun: 2 }) });
  await assert.rejects(coordinator.execute({ actionId: 'suppressed', senderId: 'a', clientId: 'scalelab',
    run: async () => { throw preDeliveryRefusal('suppressed', 'suppression appeared'); } }), /suppression/);
  assert.equal(store.snapshot().actions.get('suppressed').status, 'released');
  assert.equal(store.snapshot().buckets.get(`day:global:${dayKey}`).used, 0);
  await assert.rejects(coordinator.execute({ actionId: 'timeout', senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart(); throw new Error('Gmail timeout'); } }), /timeout/);
  assert.equal(store.snapshot().actions.get('timeout').status, 'ambiguous');
  assert.equal(store.snapshot().buckets.get(`day:global:${dayKey}`).used, 1);
  await assert.rejects(coordinator.execute({ actionId: 'timeout', senderId: 'a', clientId: 'scalelab',
    run: async () => assert.fail('provider should not run') }), /held/);
  await coordinator.finish();
});

test('definite Gmail 400 releases quota; successful Gmail result consumes it', async () => {
  const { store, coordinator } = await ready({ plan: customPlan({ senderIds: ['a'], laneRun: 2 }) });
  await assert.rejects(coordinator.execute({ actionId: 'rejected', senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart();
      throw Object.assign(new Error('bad request'), { response: { status: 400 } }); } }), /bad request/);
  assert.equal(store.snapshot().actions.get('rejected').status, 'released');
  await coordinator.execute({ actionId: 'success', senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart(); return { id: 'mock' }; } });
  assert.equal(store.snapshot().actions.get('success').status, 'consumed');
  await coordinator.finish();
});

test('canonical timeout, unsubscribe, authorization and sender hold before dispatch release quota', async () => {
  for (const code of ['canonical_timeout', 'unsubscribed', 'unauthorized', 'sender_held']) {
    const { store, coordinator } = await ready({ runId: `run-${code}`,
      plan: customPlan({ senderIds: ['a'] }) });
    await assert.rejects(coordinator.execute({ actionId: code, senderId: 'a', clientId: 'scalelab',
      run: async () => { throw preDeliveryRefusal(code, code); } }), new RegExp(code));
    assert.equal(store.snapshot().buckets.get(`day:global:${dayKey}`).used, 0);
    await coordinator.finish();
  }
});

test('the actual Gmail boundary releases quota when final canonical read, hold or authorization changes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const code = source.slice(source.indexOf('async function sendEmail('),
    source.indexOf('async function loadOutreachProviderState('));
  for (const scenario of ['canonical_timeout', 'sender_held', 'unauthorized']) {
    const { store, coordinator } = await ready({ runId: `boundary-${scenario}`,
      plan: customPlan({ senderIds: ['a'] }) });
    let held = false;
    let authorized = true;
    let providerCalls = 0;
    const send = new Function('sendLockEnabled', 'preDeliveryRefusal', 'assertSendAuthorized',
      'assertStaffingSendAllowed', 'clientSendWindowVerdict', 'tenantOf', 'SCHEDULED_CLIENT_SCOPE',
      'senderMayStillSend', 'activeSendQuota', 'resolveLeadClient', 'activeSenderPacer',
      'withGmailProviderSend', 'guardProviderSend', 'freshSendSafetyDeps',
      'recipientProviderClassifier', 'GmailOutreachProvider', 'runWithGmailFeature',
      'gmailForSender', 'toRawMessage', 'fromNameForSender', 'PRIMARY_GMAIL_SENDER',
      `${code}; return sendEmail;`)(
      () => true, preDeliveryRefusal,
      () => { if (!authorized) throw new Error('authorization disabled'); },
      () => {}, () => ({ allowed: true }), () => 'scalelab', '',
      () => !held, coordinator, () => ({ ok: true, clientId: 'scalelab' }),
      { run: (_senderId, task) => task() }, ({ run }) => run(),
      async () => {
        if (scenario === 'canonical_timeout') throw new Error('Supabase timeout');
        if (scenario === 'sender_held') held = true;
        if (scenario === 'unauthorized') authorized = false;
        return { allowed: true };
      }, () => ({}), { peek: () => ({ provider: 'google' }) },
      class { constructor() { providerCalls++; } },
      (_feature, task) => task(), () => assert.fail('Gmail must not be reached'),
      () => assert.fail('MIME must not be built'), () => 'Test',
      { id: 'a', email: 'sender@example.test' },
    );
    await assert.rejects(send({ lead: { id: 'L', email: 'lead@example.test' },
      to: 'lead@example.test', sender: { id: 'a', email: 'sender@example.test' },
      sendAction: { actionId: `boundary-${scenario}`, actionType: 'gmail_cold_step' } }),
    /timeout|eligible|authorization disabled/);
    assert.equal(providerCalls, 0);
    assert.equal(store.snapshot().buckets.get(`day:global:${dayKey}`).used, 0);
    assert.equal(store.snapshot().actions.get(`boundary-${scenario}`).status, 'released');
    await coordinator.finish();
  }
});

test('deadline refuses new candidates without releasing a provider attempt in progress', async () => {
  let now = 0;
  const { store, coordinator } = await ready({ plan: customPlan({ senderIds: ['a'], laneRun: 2 }),
    now: () => now, deadlineAt: new Date(1000).toISOString() });
  let complete;
  const first = coordinator.execute({ actionId: 'first', senderId: 'a', clientId: 'scalelab',
    run: async ({ markProviderStart }) => { await markProviderStart();
      await new Promise(resolve => { complete = resolve; }); return true; } });
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  now = 1000;
  await assert.rejects(coordinator.execute({ actionId: 'late', senderId: 'a', clientId: 'scalelab',
    run: async () => assert.fail('late provider attempt') }), /deadline/);
  complete();
  await first;
  const summary = await coordinator.finish();
  assert.equal(summary.terminationReason, 'run_deadline_reached');
  assert.equal(store.snapshot().actions.has('late'), false);
});

test('sender pacer serializes one inbox and lets a slow other inbox continue', async () => {
  const pacer = createSenderPacer({ minDelayMs: 30, maxDelayMs: 90,
    sleep: () => Promise.resolve(), random: () => 0 });
  let releaseA;
  const started = [];
  const a1 = pacer.run('a', async () => { started.push('a1');
    await new Promise(resolve => { releaseA = resolve; }); });
  const a2 = pacer.run('a', async () => { started.push('a2'); });
  const b = pacer.run('b', async () => { started.push('b'); });
  await b;
  assert.deepEqual(started, ['a1', 'b']);
  releaseA();
  await Promise.all([a1, a2]);
  assert.deepEqual(started, ['a1', 'b', 'a2']);
  assert.equal(pacer.history('a').length, 2);
});

test('a crashing lane does not prevent another sender lane from finishing', async () => {
  const ended = [];
  const results = await runSenderLanes([{ id: 'a' }, { id: 'b' }], async sender => {
    if (sender.id === 'a') throw new Error('sender A crashed');
    await Promise.resolve(); ended.push(sender.id);
  });
  assert.deepEqual(ended, ['b']);
  assert.deepEqual(results.map(item => item.status), ['rejected', 'fulfilled']);
  await assert.rejects(runSenderLanes([{ id: 'a' }, { id: 'a' }], async () => {}), /two lanes/);
});

test('second run cannot own an inbox while the prior run is active', async () => {
  const store = createMemorySendQuotaStore();
  const plan = customPlan({ senderIds: ['a'] });
  await store.beginRun({ runId: 'first', dayKey, plan, baselines: baselines() });
  await assert.rejects(store.beginRun({ runId: 'second', dayKey, plan, baselines: baselines() }), /quota_lane_owned/);
  await store.finishRun('first');
  await store.beginRun({ runId: 'second', dayKey, plan, baselines: baselines() });
  await store.finishRun('second');
});

test('saturated day reaches 185 ScaleLab, 60 Jole and 245 combined at every required pacing', () => {
  for (const paceSeconds of [30, 60, 90]) {
    const result = simulate({ paceSeconds });
    assert.deepEqual([result.totals.scalelab, result.totals.jole, result.totals.combined],
      [185, 60, 245]);
    assert.equal(result.ticks.length, 14);
    assert.equal(result.totals.deadlineTerminations, 0);
    assert.equal(result.totals.skippedNextTicks, 0);
    assert.ok(result.totals.maxDurationSeconds < 25 * 60);
  }
});
