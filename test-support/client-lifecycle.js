'use strict';

// Models Jole AFTER onboarding and an explicit operator activation, for tests
// that exercise fulfillment (ledger, managed replies, meetings). Sending stays
// disabled and capacity stays 0. The override is validated by the registry, so
// an impossible state (active before onboarding, sending without activation)
// cannot be modelled. Production config is untouched: Jole ships
// onboarding_pending / inactive.

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

/** Activate Jole for the duration of a test; returns restore(). */
function activateJoleForTest(extra = {}) {
  return overrideClientForTests('jole', { ...ACTIVATED_JOLE, ...extra });
}

module.exports = { ACTIVATED_JOLE, activateJoleForTest };
