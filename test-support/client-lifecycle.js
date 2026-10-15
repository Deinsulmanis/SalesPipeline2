'use strict';

// Jole's lifecycle states for tests. Production Jole is ACTIVE (taken out of
// onboarding 2026-10-05), prepared for launch since 2026-10-15 (sending key on
// in config, capacity 120/12), and NOT authorized to send until
// CLIENT_SENDING_AUTHORIZED names it.
//  - ACTIVATED_JOLE: onboarding complete and an operator activation recorded
//    (the production shape; kept for tests that pin it explicitly).
//  - PENDING_JOLE: Jole before onboarding, for tests of inactive-client
//    behavior (every send path and fulfillment write refused).
// Overrides are validated by the registry, so an impossible state (active
// before onboarding, sending without activation) cannot be modelled.

const { overrideClientForTests } = require('../integrations/clients/registry');

const ACTIVATED_JOLE = Object.freeze({
  lifecycleStatus: 'active',
  active: true,
  onboarding: Object.freeze({
    agreementSigned: true, onboardingFormReturned: true, setupBalancePaid: true,
    setupBalanceDueCents: 0, currency: 'USD',
  }),
  activation: Object.freeze({ activatedBy: 'test-operator', activatedAt: '2026-10-01T00:00:00.000Z' }),
});

const PENDING_JOLE = Object.freeze({
  lifecycleStatus: 'onboarding_pending',
  active: false,
  onboarding: Object.freeze({
    agreementSigned: false, onboardingFormReturned: false, setupBalancePaid: false,
    setupBalanceDueCents: 17500, currency: 'USD',
  }),
  activation: Object.freeze({ activatedBy: '', activatedAt: '' }),
  // A client in onboarding can never have its sending key on or any capacity
  // (registry rules).
  sending: Object.freeze({ enabled: false, requiresEnvAuthorization: true, clientSuppressionRequired: true }),
  capacity: Object.freeze({ dailyCap: 0, windowCap: 0, reservedDaily: 0, reservedWindow: 0 }),
});

/** Activate Jole for the duration of a test; returns restore(). */
function activateJoleForTest(extra = {}) {
  return overrideClientForTests('jole', { ...ACTIVATED_JOLE, ...extra });
}

/** Put Jole back in onboarding for the duration of a test; returns restore(). */
function pendingJoleForTest(extra = {}) {
  return overrideClientForTests('jole', { ...PENDING_JOLE, ...extra });
}

module.exports = { ACTIVATED_JOLE, PENDING_JOLE, activateJoleForTest, pendingJoleForTest };
