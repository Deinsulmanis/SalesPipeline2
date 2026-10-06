'use strict';

// Jole's lifecycle. As of 2026-10-05 Jole BTX LLC is an ACTIVE client (taken
// out of onboarding by explicit operator instruction, recorded in
// `activation`). Client-active is not send authority: sending stays disabled,
// client capacity stays 0, and every send path still refuses. The inactive
// (onboarding_pending) behavior stays pinned through the PENDING_JOLE seam.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getClient, buildRegistry, publicClient, overrideClientForTests } = require('../integrations/clients/registry');
const { clientSendBlock, clientSendState } = require('../integrations/clients/send-policy');
const { createClientCapacityState, clientCapacityVerdict } = require('../integrations/clients/capacity');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { routedLeadReady } = require('../integrations/campaign-routing');
const ledger = require('../integrations/clients/ledger');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { buildClientSuppression } = require('../integrations/clients/suppression');
const { ACTIVATED_JOLE, PENDING_JOLE, pendingJoleForTest } = require('../test-support/client-lifecycle');

const joleLead = () => ({
  id: 'jole-lead-1', company: 'Voltline Mission Critical', email: 'ops@voltline.example.com', notes: '',
  stage: 'Queued', emailStatus: '', leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
  intendedCampaignVersion: 'jole-btx-employer-acquisition', campaign: 'jole-btx-employer-acquisition',
  senderInboxId: '', clientId: 'jole', routingRequired: 'true',
});

test('Jole BTX LLC is an active client with no send authority: sending disabled, zero capacity, activation recorded', () => {
  const jole = getClient('jole');
  assert.equal(jole.displayName, 'Jole BTX LLC');
  assert.equal(jole.lifecycleStatus, 'active');
  assert.equal(jole.active, true);
  assert.equal(jole.sending.enabled, false);
  assert.equal(jole.sending.requiresEnvAuthorization, true);
  assert.deepEqual({ daily: jole.capacity.dailyCap, window: jole.capacity.windowCap }, { daily: 0, window: 0 });
  assert.deepEqual({ ...jole.onboarding }, {
    agreementSigned: true, onboardingFormReturned: true, setupBalancePaid: true,
    setupBalanceDueCents: 0, currency: 'USD',
  });
  assert.match(jole.activation.activatedBy, /operator/);
  assert.ok(Number.isFinite(Date.parse(jole.activation.activatedAt)));
  assert.equal(jole.platformAccess, 'none');
  const view = publicClient(jole);
  assert.equal(view.lifecycleStatus, 'active');
  assert.equal(view.active, true);
  assert.equal(view.sendingEnabledInConfig, false);
});

test('activation is never inferred: active must match lifecycle, onboarding must be complete, the operator action recorded', () => {
  const scalelab = getClient('scalelab');
  const pending = { ...getClient('jole'), ...PENDING_JOLE };
  const build = patch => buildRegistry([scalelab, { ...pending, ...patch }]);
  assert.doesNotThrow(() => build({}));
  assert.throws(() => build({ active: true }), /active must equal/);
  assert.throws(() => build({ lifecycleStatus: 'active', active: true }), /onboarding is complete \(agreementSigned, onboardingFormReturned, setupBalancePaid\)/);
  assert.throws(() => build({ lifecycleStatus: 'active', active: true, onboarding: { ...ACTIVATED_JOLE.onboarding, setupBalancePaid: false } }), /setupBalancePaid/);
  assert.throws(() => build({ ...ACTIVATED_JOLE, activation: { activatedBy: '', activatedAt: '' } }), /recorded operator action/);
  assert.throws(() => build({ sending: { ...pending.sending, enabled: true } }), /not active/);
  assert.throws(() => build({ capacity: { ...pending.capacity, dailyCap: 10, windowCap: 2 } }), /zero capacity/);
  assert.throws(() => build({ lifecycleStatus: 'launched' }), /lifecycleStatus is invalid/);
  assert.doesNotThrow(() => build(ACTIVATED_JOLE));
  // The test seam validates too: it cannot model an impossible state.
  assert.throws(() => overrideClientForTests('jole', { lifecycleStatus: 'onboarding_pending' }), /active must equal/);
  assert.equal(getClient('jole').active, true, 'a refused override leaves the config untouched');
});

test('an inactive (onboarding) client refuses every send path, whatever else is configured', () => {
  const restore = pendingJoleForTest();
  try {
    const lead = joleLead();
    const env = { CLIENT_SENDING_AUTHORIZED: 'jole' };
    assert.equal(clientSendBlock('jole', env).code, 'client_inactive');
    assert.equal(clientSendState('jole', env).sendingEnabled, false);
    const senders = [{ id: 'jole_test', email: 'o@jolebtxteam.com', clientId: 'jole', status: 'active', sendEligible: true, dailyLimit: 10 }];
    const gate = evaluateFreshSendSafety(lead, { ...lead, senderInboxId: 'jole_test' }, new Set(), {
      env, senderInboxId: 'jole_test', senders, clientSuppression: { available: true, entries: [] },
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'client_inactive');
    const capacity = createClientCapacityState({ globalDailyLimit: 200, globalWindowLimit: 21, env,
      configs: new Map([['jole', { dailyCap: 500, windowCap: 50, reservedDaily: 0, reservedWindow: 0 }]]) });
    assert.equal(clientCapacityVerdict(capacity, 'jole').code, 'client_inactive');
    assert.equal(routedLeadReady({ ...lead, senderInboxId: 'jole_test' }, env).ok, false);
  } finally { restore(); }
});

test('the ACTIVE client still refuses every send path: sending disabled, capacity 0, draft campaign', () => {
  const lead = joleLead();
  for (const env of [{}, { CLIENT_SENDING_AUTHORIZED: 'jole' }]) {
    assert.equal(clientSendBlock('jole', env).code, 'client_sending_disabled');
    assert.equal(clientSendState('jole', env).sendingEnabled, false);
    const senders = [{ id: 'jole_test', email: 'o@jolebtxteam.com', clientId: 'jole', status: 'active', sendEligible: true, dailyLimit: 10 }];
    const gate = evaluateFreshSendSafety(lead, { ...lead, senderInboxId: 'jole_test' }, new Set(), {
      env, senderInboxId: 'jole_test', senders, clientSuppression: { available: true, entries: [] },
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'client_sending_disabled');
    const capacity = createClientCapacityState({ globalDailyLimit: 200, globalWindowLimit: 21, env });
    assert.equal(clientCapacityVerdict(capacity, 'jole').allowed, false);
    assert.equal(routedLeadReady({ ...lead, senderInboxId: 'jole_test' }, env).ok, false);
  }
});

test('before activation no fulfillment record can be written; protective exclusions still can', async () => {
  const restore = pendingJoleForTest();
  try {
    const store = createMemoryLedgerStore();
    await assert.rejects(ledger.recordMeetingBooked(store, { clientId: 'jole', lead: joleLead(), scheduledFor: '2026-10-08T16:00:00Z' }), error => error.code === 'client_not_active');
    await assert.rejects(ledger.upsertOpportunity(store, { clientId: 'jole', lead: joleLead() }), error => error.code === 'client_not_active');
    await assert.rejects(ledger.openClarification(store, { clientId: 'jole', lead: joleLead(), question: 'q' }), error => error.code === 'client_not_active');
    assert.deepEqual(await store.listMeetings('jole'), []);
    // A Jole current-client exclusion can be recorded now: it only ever blocks.
    await store.addClientSuppression(buildClientSuppression({ clientId: 'jole', matchType: 'company', value: 'Existing Jole Customer LLC' }));
    assert.equal((await store.listClientSuppressions('jole')).length, 1);
  } finally { restore(); }
});

test('the active client can keep fulfillment records (ledger), which never sends anything', async () => {
  const store = createMemoryLedgerStore();
  const opportunity = await ledger.upsertOpportunity(store, { clientId: 'jole', lead: joleLead() });
  assert.equal(opportunity.client_id, 'jole');
  assert.equal(clientSendState('jole', {}).sendingEnabled, false);
});

test('the Gmail provider boundary refuses a Jole lead in every lifecycle state (warm / intent paths included)', async () => {
  const { withGmailProviderSend } = require('../integrations/send-lock');
  let providerCalled = false;
  const attempt = (env, code) => assert.rejects(withGmailProviderSend({ lead: joleLead(), sendAction: { actionId: 'warm:jole-lead-1:1', leadId: 'jole-lead-1' },
    run: async () => { providerCalled = true; }, env }), error => error.code === code);
  const restore = pendingJoleForTest();
  try {
    for (const env of [{}, { SEND_LOCK_ENABLED: 'true' }, { CLIENT_SENDING_AUTHORIZED: 'jole' }]) await attempt(env, 'client_inactive');
  } finally { restore(); }
  for (const env of [{}, { SEND_LOCK_ENABLED: 'true' }, { CLIENT_SENDING_AUTHORIZED: 'jole' }]) await attempt(env, 'client_sending_disabled');
  assert.equal(providerCalled, false);
  // A ScaleLab lead passes the boundary exactly as before (lock disabled → run directly).
  const result = await withGmailProviderSend({ lead: { id: 's1', leadNiche: 'dental', email: 'a@b.example.com' },
    sendAction: { actionId: 'warm:s1:1' }, run: async () => 'sent', env: {} });
  assert.equal(result, 'sent');
});
