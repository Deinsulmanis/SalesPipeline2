'use strict';

// Fixture postal address for tests only. It is not a production sender address.
const TEST_STAFFING_MAILING_ADDRESS = '1 Harbour Street, New Westminster, BC V3L 1A1';
const STAFFING_RENDER_OPTIONS = Object.freeze({
  mailingAddress: TEST_STAFFING_MAILING_ADDRESS,
  companyName: 'ScaleLabAi',
  website: 'scalelabai.ca',
  env: Object.freeze({}),
});

module.exports = { TEST_STAFFING_MAILING_ADDRESS, STAFFING_RENDER_OPTIONS };
