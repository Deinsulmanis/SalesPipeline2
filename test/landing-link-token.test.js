'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const util = require('node:util');

const {
  LANDING_LINK_SOURCE, PLAN_STATUS, parseLandingKeyring, landingTrackingState, landingIssuanceKey,
  deriveLandingToken, isLandingToken, landingTokenHash, trackedLandingUrl,
  coldStepPriorAttempts, warmReplyPriorAttempts, planLandingLink, landingLinkMetadata, issuanceConflict,
} = require('../integrations/landing-link-token');
const { ordinaryColdActionId, responseActionId } = require('../integrations/outbound-action-id');
const { STAFFING_LANDING_PAGE_URL } = require('../integrations/staffing-campaign');

const KEY_1 = crypto.createHash('sha256').update('landing test key 1').digest('base64');
const KEY_2 = crypto.createHash('sha256').update('landing test key 2').digest('base64');
const env = (overrides = {}) => ({
  LANDING_LINK_TRACKING_ENABLED: 'true',
  LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1 }),
  LANDING_LINK_TOKEN_ACTIVE_VERSION: '1',
  ...overrides,
});
const rotated = overrides => env({ LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1, 2: KEY_2 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '2', ...overrides });
const LEAD = 'mtwg1abcdef0123456789';
const COLD_ACTION = ordinaryColdActionId(LEAD, 2);
const followUpPlan = (trackingEnv, priorAttempts = []) => planLandingLink({
  actionId: COLD_ACTION, source: LANDING_LINK_SOURCE.FOLLOWUP_2, priorAttempts, tracking: landingTrackingState(trackingEnv),
});

test('key ring: valid ring parses; every malformed ring is reported, never thrown', () => {
  const ok = parseLandingKeyring(env());
  assert.equal(ok.error, null);
  assert.equal(ok.activeVersion, 1);
  assert.equal(ok.keys.get(1).length, 32);
  const cases = {
    missing: { LANDING_LINK_TOKEN_KEYS: '' },
    notJson: { LANDING_LINK_TOKEN_KEYS: '{nope' },
    array: { LANDING_LINK_TOKEN_KEYS: '[]' },
    shortKey: { LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: Buffer.alloc(16).toString('base64') }) },
    notBase64: { LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: `${'!'.repeat(44)}` }) },
    badVersion: { LANDING_LINK_TOKEN_KEYS: JSON.stringify({ zero: KEY_1 }) },
    activeMissing: { LANDING_LINK_TOKEN_ACTIVE_VERSION: '7' },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const ring = parseLandingKeyring(env(overrides));
    assert.ok(ring.error, name);
    assert.equal(ring.activeVersion, null, name);
  }
});

test('tracking state: off unless the flag is exactly true AND the key ring is valid', () => {
  assert.equal(landingTrackingState({}).enabled, false);
  assert.equal(landingTrackingState(env({ LANDING_LINK_TRACKING_ENABLED: 'false' })).enabled, false);
  assert.equal(landingTrackingState(env({ LANDING_LINK_TRACKING_ENABLED: '1' })).enabled, false);
  const noKeys = landingTrackingState(env({ LANDING_LINK_TOKEN_KEYS: '' }));
  assert.equal(noKeys.enabled, false);
  assert.match(noKeys.reason, /LANDING_LINK_TOKEN_KEYS/);
  assert.equal(landingTrackingState(env()).enabled, true);
  // The key ring is still available with the flag off, for pinned retries.
  assert.equal(landingTrackingState(env({ LANDING_LINK_TRACKING_ENABLED: 'false' })).keyring.keys.size, 1);
});

test('token: 128-bit, 22 URL-safe characters, deterministic per issuance, unrelated across issuances', () => {
  const keyring = parseLandingKeyring(rotated());
  const key = landingIssuanceKey(COLD_ACTION);
  assert.equal(key, `${COLD_ACTION}|staffing_landing`);
  const token = deriveLandingToken({ issuanceKey: key, keyVersion: 1, keyring });
  assert.ok(isLandingToken(token));
  assert.equal(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 16);
  assert.equal(deriveLandingToken({ issuanceKey: key, keyVersion: 1, keyring }), token);
  assert.notEqual(deriveLandingToken({ issuanceKey: key, keyVersion: 2, keyring }), token);
  assert.notEqual(deriveLandingToken({ issuanceKey: landingIssuanceKey(ordinaryColdActionId(LEAD, 3)), keyVersion: 1, keyring }), token);
  const replyKey = landingIssuanceKey(responseActionId(LEAD, 'inbound-1', 'AUTO_STAFFING_SEND_INFO'));
  assert.notEqual(deriveLandingToken({ issuanceKey: replyKey, keyVersion: 1, keyring }), token);
  assert.equal(token.includes(LEAD), false);
  assert.equal(token.includes(LEAD.slice(0, 6)), false);
  assert.throws(() => deriveLandingToken({ issuanceKey: key, keyVersion: 9, keyring }), /not in the key ring/);
  assert.throws(() => landingIssuanceKey(''), /action id/);
});

test('token hash and URL: SHA-256 hex, and only a well-formed token becomes a URL', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(landingTokenHash(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.match(landingTokenHash(token), /^[0-9a-f]{64}$/);
  assert.equal(trackedLandingUrl(token), `${STAFFING_LANDING_PAGE_URL}?t=${token}`);
  for (const bad of ['', 'short', `${token}x`, 'AbCdEfGhIjKlMnOpQrSt/v', null]) {
    assert.equal(isLandingToken(bad), false);
    assert.throws(() => trackedLandingUrl(bad));
  }
});

test('plan: tracking off and no earlier attempt renders the plain URL', () => {
  const result = followUpPlan(env({ LANDING_LINK_TRACKING_ENABLED: 'false' }));
  assert.equal(result.status, PLAN_STATUS.UNTRACKED);
  assert.equal(result.tracked, false);
  assert.equal(result.url, null);
  assert.equal(landingLinkMetadata(result), null);
});

test('plan: tracking on and no earlier attempt issues with the active key version', () => {
  const result = followUpPlan(rotated());
  assert.equal(result.status, PLAN_STATUS.TRACKED);
  assert.equal(result.keyVersion, 2);
  assert.equal(result.pinned, false);
  assert.equal(result.url, trackedLandingUrl(result.token));
  assert.deepEqual(landingLinkMetadata(result), {
    issuanceKey: `${COLD_ACTION}|staffing_landing`, keyVersion: 2, source: 'followup_2', tracked: true,
  });
});

test('pinning: rotation between attempts keeps the first attempt key version and URL', () => {
  const first = followUpPlan(env());
  assert.equal(first.keyVersion, 1);
  // The first attempt's reservation carries the pin. The key ring then rotates to v2.
  const retry = followUpPlan(rotated(), [{ leadId: LEAD, step: 2, landingLink: landingLinkMetadata(first) }]);
  assert.equal(retry.status, PLAN_STATUS.TRACKED);
  assert.equal(retry.pinned, true);
  assert.equal(retry.keyVersion, 1);
  assert.equal(retry.url, first.url);
  assert.equal(retry.tokenHash, first.tokenHash);
  // Without the pin the same action would render a different URL.
  assert.notEqual(followUpPlan(rotated()).url, first.url);
});

test('pinning: rotation before Gmail recovery re-renders the exact URL that was sent', () => {
  const sent = followUpPlan(env());
  const reservation = { leadId: LEAD, step: 2, landingLink: landingLinkMetadata(sent) };
  const sendRow = { step: 2, landingLink: landingLinkMetadata(sent) };
  const recovery = followUpPlan(rotated(), [reservation, sendRow]);
  assert.equal(recovery.url, sent.url);
});

test('pinning: an action first attempted untracked stays untracked after tracking is switched on', () => {
  const result = followUpPlan(rotated(), [{ leadId: LEAD, step: 2 }]);
  assert.equal(result.status, PLAN_STATUS.UNTRACKED);
  assert.equal(result.pinned, true);
});

test('pinning: an action first attempted tracked stays tracked after the flag is switched off', () => {
  const first = followUpPlan(env());
  const result = followUpPlan(env({ LANDING_LINK_TRACKING_ENABLED: 'false' }), [{ landingLink: landingLinkMetadata(first) }]);
  assert.equal(result.status, PLAN_STATUS.TRACKED);
  assert.equal(result.url, first.url);
});

test('pinning fails closed: a pinned key version missing from the ring blocks, never re-derives', () => {
  const first = followUpPlan(env());
  const onlyV2 = env({ LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 2: KEY_2 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '2' });
  const result = followUpPlan(onlyV2, [{ landingLink: landingLinkMetadata(first) }]);
  assert.equal(result.status, PLAN_STATUS.BLOCKED);
  assert.match(result.reason, /key version 1 is not in the key ring/);
  assert.equal(result.url, null);
});

test('pinning fails closed when earlier attempts disagree', () => {
  const v1 = landingLinkMetadata(followUpPlan(env()));
  const v2 = { ...v1, keyVersion: 2 };
  assert.equal(followUpPlan(rotated(), [{ landingLink: v1 }, {}]).status, PLAN_STATUS.BLOCKED);
  assert.equal(followUpPlan(rotated(), [{ landingLink: v1 }, { landingLink: v2 }]).status, PLAN_STATUS.BLOCKED);
  assert.equal(followUpPlan(rotated(), [{ landingLink: { ...v1, issuanceKey: 'other|staffing_landing' } }]).status, PLAN_STATUS.BLOCKED);
  assert.equal(followUpPlan(rotated(), [{ landingLink: { ...v1, tracked: 'yes' } }]).status, PLAN_STATUS.BLOCKED);
});

test('plans never expose the token or URL when logged or serialised', () => {
  const result = followUpPlan(env());
  assert.ok(result.token && result.url);
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes(result.token), false);
  assert.equal(util.inspect(result).includes(result.token), false);
  assert.equal(Object.keys(result).includes('token'), false);
});

test('issuance conflict: a stored row must match the pinned key version and token hash', () => {
  const result = followUpPlan(env());
  const row = { issuance_key: result.issuanceKey, token_key_version: 1, token_hash: result.tokenHash };
  assert.equal(issuanceConflict(result, row), '');
  assert.match(issuanceConflict(result, { ...row, token_key_version: 2 }), /key version 2/);
  assert.match(issuanceConflict(result, { ...row, token_hash: '0'.repeat(64) }), /token hash/);
  assert.match(issuanceConflict(result, { ...row, issuance_key: 'x' }), /issuance key/);
  assert.equal(issuanceConflict(followUpPlan({}), row), '');
});

test('prior attempts: cold steps match reservation and send rows for the same lead and step only', () => {
  const rows = [
    { eventType: 'ordinary_send_reserved', metadata: JSON.stringify({ leadId: LEAD, step: 2, landingLink: { a: 1 } }) },
    { eventType: 'ordinary_send_reserved', metadata: JSON.stringify({ leadId: LEAD, step: 3 }) },
    { eventType: 'ordinary_send_reserved', metadata: JSON.stringify({ leadId: 'other', step: 2 }) },
    { eventType: 'follow_up_sent', sourceLeadId: LEAD, metadata: JSON.stringify({ step: 2 }) },
    { eventType: 'follow_up_sent', sourceLeadId: 'other', metadata: JSON.stringify({ step: 2 }) },
    { eventType: 'ordinary_send_failed', metadata: JSON.stringify({ leadId: LEAD, step: 2 }) },
  ];
  const attempts = coldStepPriorAttempts(rows, LEAD, 2);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].landingLink, { a: 1 });
});

test('prior attempts: warm replies match this action id only', () => {
  const actionId = responseActionId(LEAD, 'inbound-1', 'AUTO_STAFFING_SEND_INFO');
  const other = responseActionId(LEAD, 'inbound-2', 'AUTO_STAFFING_SEND_INFO');
  const rows = [
    { eventType: 'prospect_reply_reserved', eventId: `${actionId}:attempt:1`, metadata: JSON.stringify({ actionId }) },
    { eventType: 'prospect_reply_reserved', eventId: `${other}:attempt:1`, metadata: JSON.stringify({ actionId: other }) },
    { eventType: 'booking_link_sent', eventId: actionId, metadata: JSON.stringify({ actionId }) },
    { eventType: 'booking_link_sent', eventId: other, metadata: JSON.stringify({ actionId: other }) },
  ];
  assert.equal(warmReplyPriorAttempts(rows, actionId).length, 2);
});

test('Follow-up #2 and positive-reply links for the same lead are distinct issuances', () => {
  const tracking = landingTrackingState(env());
  const followUp = planLandingLink({ actionId: COLD_ACTION, source: 'followup_2', tracking });
  const reply = planLandingLink({ actionId: responseActionId(LEAD, 'inbound-1', 'AUTO_STAFFING_QUALIFIED'), source: 'positive_reply', tracking });
  assert.notEqual(followUp.issuanceKey, reply.issuanceKey);
  assert.notEqual(followUp.url, reply.url);
  assert.equal(followUp.source, 'followup_2');
  assert.equal(reply.source, 'positive_reply');
});
