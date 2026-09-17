'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGoogleServiceAccountJson } = require('../integrations/google-service-account');

test('missing or blank service-account JSON fails with a clear error', () => {
  assert.throws(() => parseGoogleServiceAccountJson(undefined), /missing or empty/);
  assert.throws(() => parseGoogleServiceAccountJson(''), /missing or empty/);
  assert.throws(() => parseGoogleServiceAccountJson('   '), /missing or empty/);
});

test('malformed service-account JSON fails clearly instead of a raw parse error', () => {
  const leaked = '{not json "private_key":"-----BEGIN RSA PRIVATE KEY-----SECRET"}';
  assert.throws(() => parseGoogleServiceAccountJson(leaked), /not valid JSON/);
  try {
    parseGoogleServiceAccountJson(leaked);
  } catch (error) {
    assert.equal(error instanceof SyntaxError, false);
    assert.doesNotMatch(error.message, /position|Unexpected token/i);
    assert.doesNotMatch(error.message, /SECRET|BEGIN RSA PRIVATE KEY|private_key/);
  }
  assert.throws(() => parseGoogleServiceAccountJson('[]'), /must be a JSON object/);
  assert.throws(() => parseGoogleServiceAccountJson('null'), /must be a JSON object/);
  assert.throws(() => parseGoogleServiceAccountJson('"service-account"'), /must be a JSON object/);
});

test('a JSON object is accepted', () => {
  assert.deepEqual(parseGoogleServiceAccountJson('{"type":"service_account","client_email":"sa@x.test"}'), {
    type: 'service_account', client_email: 'sa@x.test',
  });
});

test('runtime parsers use the guarded helper rather than raw JSON.parse', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(server, /parseGoogleServiceAccountJson\(process\.env\.GOOGLE_SERVICE_ACCOUNT_JSON\)/);
  assert.match(agent, /parseGoogleServiceAccountJson\(process\.env\.GOOGLE_SERVICE_ACCOUNT_JSON\)/);
  assert.doesNotMatch(server, /JSON\.parse\(process\.env\.GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.doesNotMatch(agent, /JSON\.parse\(process\.env\.GOOGLE_SERVICE_ACCOUNT_JSON/);
});
