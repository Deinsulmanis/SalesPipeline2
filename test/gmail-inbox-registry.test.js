'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRegistry, publicRegistry, assertDormant, credentialsFor, verifyInbox } = require('../integrations/gmail-inbox-registry');

const raw = JSON.stringify([{ id: 'tryscalelabai', email: 'DEINS@tryscalelabai.ca', status: 'warming', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 0 }]);

test('secondary inbox remains isolated and dormant while warming', () => {
  const [entry] = parseRegistry(raw);
  assert.equal(entry.email, 'deins@tryscalelabai.ca');
  assert.equal(assertDormant(entry), true);
  assert.equal(publicRegistry([entry], {}).at(0).sendEligible, false);
});

test('warming inbox fails closed when given a send allowance', () => {
  assert.throws(() => parseRegistry(JSON.stringify([{ id: 'x', email: 'x@example.com', status: 'warming', tokenEnv: 'GMAIL_X_TOKEN_JSON', dailyLimit: 1 }])), /dailyLimit 0/);
});

test('secondary inbox cannot reuse the live primary credential variable', () => {
  assert.throws(() => parseRegistry(JSON.stringify([{ id: 'x', email: 'x@example.com', status: 'warming', tokenEnv: 'GMAIL_TOKEN_JSON', dailyLimit: 0 }])), /cannot reuse/);
});

test('token parsing requires a refresh token and never exposes it publicly', () => {
  const [entry] = parseRegistry(raw);
  const env = { GMAIL_TRYSCALELABAI_TOKEN_JSON: JSON.stringify({ refresh_token: 'secret' }) };
  assert.equal(credentialsFor(entry, env).refresh_token, 'secret');
  assert.equal(JSON.stringify(publicRegistry([entry], env)).includes('secret'), false);
});

test('read-only identity verification rejects the wrong Google account', async () => {
  const [entry] = parseRegistry(raw);
  const env = { GMAIL_TRYSCALELABAI_TOKEN_JSON: JSON.stringify({ refresh_token: 'secret' }) };
  const auth = { setCredentials() {} };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'wrong@example.com' } }) } };
  await assert.rejects(() => verifyInbox(entry, { env, auth, gmail }), /not deins@tryscalelabai.ca/);
});

test('legacy Gmail send path does not import the secondary registry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.doesNotMatch(source, /gmail-inbox-registry|GMAIL_INBOX_REGISTRY_JSON|GMAIL_TRYSCALELABAI_TOKEN_JSON/);
  assert.match(source, /process\.env\.GMAIL_TOKEN_JSON/);
  assert.match(source, /process\.env\.FROM_EMAIL/);
});

test('secondary OAuth onboarding never uses the live primary OAuth client variables', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'connect-gmail-inbox.js'), 'utf8');
  assert.match(source, /GMAIL_SECONDARY_GOOGLE_CLIENT_ID/);
  assert.match(source, /GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET/);
  assert.match(source, /--credentials|credentialsPath/);
  assert.doesNotMatch(source, /process\.env\.GOOGLE_CLIENT_ID|process\.env\.GOOGLE_CLIENT_SECRET/);
});

test('secondary inbox readiness endpoints require dashboard authentication', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/integrations\/gmail-inboxes', requireAuth/);
  assert.match(source, /app\.post\('\/api\/integrations\/gmail-inboxes\/:id\/verify', requireAuth/);
});

test('dashboard inbox selector is status-only and never posts a sender choice', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(source, /id="gmail-inbox-select"/);
  assert.match(source, /Warming inboxes cannot be selected or used for sending/);
  assert.match(source, /inbox\.currentRoute \? '' : 'disabled'/);
  assert.doesNotMatch(source, /senderMailbox:\s*document\.getElementById\('gmail-inbox-select'/);
});
