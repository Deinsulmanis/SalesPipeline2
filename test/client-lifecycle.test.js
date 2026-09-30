'use strict';

// Jole's lifecycle as it ships: onboarding pending — agreement not signed,
// onboarding form not returned, $175 setup balance unpaid. The workspace exists
// internally; production fulfillment is inactive. Activation is an explicit,
// recorded operator action that the registry refuses before onboarding is done.

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
const { ACTIVATED_JOLE } = require('../test-support/client-lifecycle');

const joleLead = () => ({
  id: 'jole-lead-1', company: 'Voltline Mission Critical', email: 'ops@voltline.example.com', notes: '',
  stage: 'Queued', emailStatus: '', leadNiche: 'jole_employer', emailTemplateId: 'jole-dc-mission-critical-v1',
  intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL', campaign: 'JOLE_DC_MISSION_CRITICAL',
  senderInboxId: '', clientId: 'jole', routingRequired: 'true',
});

test('Jole ships onboarding_pending: not active, sending disabled, zero capacity', () => {
  const jole = getClient('jole');
  assert.equal(jole.lifecycleStatus, 'onboarding_pending');
  assert.equal(jole.active, false);
  assert.equal(jole.sending.enabled, false);
  assert.deepEqual({ daily: jole.capacity.dailyCap, window: jole.capacity.windowCap }, { daily: 0, window: 0 });
  assert.deepEqual({ ...jole.onboarding }, {
    agreementSigned: false, onboardingFormReturned: false, setupBalancePaid: false,
    setupBalanceDueCents: 17500, currency: 'USD',
  });
  assert.deepEqual({ ...jole.activation }, { activatedBy: '', activatedAt: '' });
  const view = publicClient(jole);
  assert.equal(view.lifecycleStatus, 'onboarding_pending');
  assert.equal(view.active, false);
});

test('activation is never inferred: active must match lifecycle, onboarding must be complete, the operator action recorded', () => {
  const scalelab = getClient('scalelab');
  const jole = getClient('jole');
  const build = patch => buildRegistry([scalelab, { ...jole, ...patch }]);
  assert.throws(() => build({ active: true }), /active must equal/);
  assert.throws(() => build({ lifecycleStatus: 'active', active: true }), /onboarding is complete \(agreementSigned, onboardingFormReturned, setupBalancePaid\)/);
  assert.throws(() => build({ lifecycleStatus: 'active', active: true, onboarding: { ...ACTIVATED_JOLE.onboarding, setupBalancePaid: false } }), /setupBalancePaid/);
  assert.throws(() => build({ ...ACTIVATED_JOLE, activation: { activatedBy: '', activatedAt: '' } }), /recorded operator action/);
  assert.throws(() => build({ sending: { ...jole.sending, enabled: true } }), /not active/);
  assert.throws(() => build({ capacity: { ...jole.capacity, dailyCap: 10, windowCap: 2 } }), /zero capacity/);
  assert.throws(() => build({ lifecycleStatus: 'launched' }), /lifecycleStatus is invalid/);
  // With onboarding complete and the activation recorded, the registry accepts it.
  assert.doesNotThrow(() => build(ACTIVATED_JOLE));
  // The test seam validates too: it cannot model an impossible state.
  assert.throws(() => overrideClientForTests('jole', { lifecycleStatus: 'active', active: true }), /onboarding/);
  assert.equal(getClient('jole').active, false, 'a refused override leaves the config untouched');
});

test('an inactive client refuses every send path, whatever else is configured', () => {
  const lead = joleLead();
  const env = { CLIENT_SENDING_AUTHORIZED: 'jole' };
  assert.equal(clientSendBlock('jole', env).code, 'client_inactive');
  assert.equal(clientSendState('jole', env).sendingEnabled, false);
  const senders = [{ id: 'jole_test', email: 'o@jole.example.com', clientId: 'jole', status: 'active', sendEligible: true, dailyLimit: 10 }];
  const gate = evaluateFreshSendSafety(lead, { ...lead, senderInboxId: 'jole_test' }, new Set(), {
    env, senderInboxId: 'jole_test', senders, clientSuppression: { available: true, entries: [] },
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'client_inactive');
  const capacity = createClientCapacityState({ globalDailyLimit: 200, globalWindowLimit: 21, env,
    configs: new Map([['jole', { dailyCap: 500, windowCap: 50, reservedDaily: 0, reservedWindow: 0 }]]) });
  assert.equal(clientCapacityVerdict(capacity, 'jole').code, 'client_inactive');
  assert.equal(routedLeadReady({ ...lead, senderInboxId: 'jole_test' }, env).ok, false);
});

test('before activation no fulfillment record can be written; protective exclusions still can', async () => {
  const store = createMemoryLedgerStore();
  await assert.rejects(ledger.recordMeetingBooked(store, { clientId: 'jole', lead: joleLead(), scheduledFor: '2026-10-08T16:00:00Z' }), error => error.code === 'client_not_active');
  await assert.rejects(ledger.upsertOpportunity(store, { clientId: 'jole', lead: joleLead() }), error => error.code === 'client_not_active');
  await assert.rejects(ledger.openClarification(store, { clientId: 'jole', lead: joleLead(), question: 'q' }), error => error.code === 'client_not_active');
  assert.deepEqual(await store.listMeetings('jole'), []);
  // A Jole current-client exclusion can be recorded now: it only ever blocks.
  await store.addClientSuppression(buildClientSuppression({ clientId: 'jole', matchType: 'company', value: 'Existing Jole Customer LLC' }));
  assert.equal((await store.listClientSuppressions('jole')).length, 1);
});

test('after an explicit activation Jole is active but still cannot send until sending is enabled and authorized', () => {
  const restore = overrideClientForTests('jole', ACTIVATED_JOLE);
  try {
    assert.equal(getClient('jole').active, true);
    assert.equal(clientSendBlock('jole', { CLIENT_SENDING_AUTHORIZED: 'jole' }).code, 'client_sending_disabled');
  } finally { restore(); }
  assert.equal(getClient('jole').lifecycleStatus, 'onboarding_pending');
});

test('the Gmail provider boundary itself refuses a lead of an inactive client (warm / intent paths included)', async () => {
  const { withGmailProviderSend } = require('../integrations/send-lock');
  let providerCalled = false;
  for (const env of [{}, { SEND_LOCK_ENABLED: 'true' }, { CLIENT_SENDING_AUTHORIZED: 'jole' }]) {
    await assert.rejects(withGmailProviderSend({ lead: joleLead(), sendAction: { actionId: 'warm:jole-lead-1:1', leadId: 'jole-lead-1' },
      run: async () => { providerCalled = true; }, env }), error => error.code === 'client_inactive');
  }
  assert.equal(providerCalled, false);
  // A ScaleLab lead passes the boundary exactly as before (lock disabled → run directly).
  const result = await withGmailProviderSend({ lead: { id: 's1', leadNiche: 'dental', email: 'a@b.example.com' },
    sendAction: { actionId: 'warm:s1:1' }, run: async () => 'sent', env: {} });
  assert.equal(result, 'sent');
});
