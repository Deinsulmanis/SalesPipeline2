'use strict';
// Fixture for tests of OTHER final-gate behavior (authorization, staffing,
// freshness, locks): the recipient is positively Google-hosted, so the
// temporary recipient-provider policy (cold-delivery-policy.js) is satisfied
// and the behavior under test decides the outcome.
const googleRecipient = async email => ({
  domain: String(email || '').split('@').pop().toLowerCase(), provider: 'GOOGLE',
  reason: 'test_fixture_google', source: 'fixture', cache: 'none',
});
module.exports = { googleRecipient };
