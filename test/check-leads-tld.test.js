'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../check-leads');

test('delegated modern TLDs pass the shared import and send classifier', () => {
  assert.equal(classify('wstetzner@letswork.careers'), 'CLEAN');
  assert.equal(classify('buyer@agency.construction'), 'CLEAN');
});

test('long text bleed and existing junk filters still reject unsafe addresses', () => {
  assert.equal(classify('info@agency.comhours'), 'MALFORMED');
  assert.equal(classify('info@agency.com6041234567'), 'MALFORMED');
  assert.equal(classify('800-7297info@agency.careers'), 'MALFORMED');
  assert.equal(classify('user@domain.com'), 'PLACEHOLDER');
  assert.equal(classify('metric@ingest.sentry.io'), 'THIRD_PARTY');
});
