'use strict';

// Fixture postal address for tests only. It is not a production sender address.
const TEST_STAFFING_MAILING_ADDRESS = '1 Harbour Street, New Westminster, BC V3L 1A1';
// The commercial mailing address production must render. Source of truth is
// Railway COMMERCIAL_MAILING_ADDRESS, not this constant in send templates.
const PRODUCTION_STAFFING_MAILING_ADDRESS = '150 Braid Street\nNew Westminster, BC V3L 0L4\nCanada';
const STAFFING_RENDER_OPTIONS = Object.freeze({
  mailingAddress: TEST_STAFFING_MAILING_ADDRESS,
  companyName: 'ScaleLabAi',
  website: 'scalelabai.ca',
  env: Object.freeze({}),
});
const PRODUCTION_STAFFING_RENDER_OPTIONS = Object.freeze({
  mailingAddress: PRODUCTION_STAFFING_MAILING_ADDRESS,
  companyName: 'ScaleLabAi',
  website: 'scalelabai.ca',
  env: Object.freeze({}),
});

module.exports = {
  TEST_STAFFING_MAILING_ADDRESS, PRODUCTION_STAFFING_MAILING_ADDRESS,
  STAFFING_RENDER_OPTIONS, PRODUCTION_STAFFING_RENDER_OPTIONS,
};
