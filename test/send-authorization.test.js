'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sendAuthorization, assertSendAuthorized,
  AUTHORIZED_ENV_VAR, AUTHORIZED_TOKEN_VAR, WORKER_ROLE_VAR, REQUIRED_WORKER_ROLE,
} = require('../integrations/send-authorization');

const root = path.join(__dirname, '..');

function authorizedEnv(extra = {}) {
  return {
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'prod-sender',
    [AUTHORIZED_ENV_VAR]: 'prod-sender',
    [AUTHORIZED_TOKEN_VAR]: 'test-sender-token',
    [WORKER_ROLE_VAR]: REQUIRED_WORKER_ROLE,
    ...extra,
  };
}

test('missing SENDING_ENABLED is fail-closed', () => {
  const verdict = sendAuthorization({ ...authorizedEnv(), SENDING_ENABLED: 'yes' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'sending_disabled');
});

test('SENDING_ENABLED=true is not enough without production authorization', () => {
  const verdict = sendAuthorization({
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'production',
    SPREADSHEET_ID: 'looks-like-prod',
    GMAIL_TOKEN_JSON: '{"access_token":"x"}',
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'send_unauthorized');
  assert.doesNotMatch(JSON.stringify(verdict), /access_token|test-sender-token/);
});

test('missing SEND_AUTHORIZED_ENV is fail-closed even when Railway env is set', () => {
  const verdict = sendAuthorization({
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'production',
    [AUTHORIZED_TOKEN_VAR]: 'token',
    [WORKER_ROLE_VAR]: REQUIRED_WORKER_ROLE,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /SEND_AUTHORIZED_ENV/);
});

test('environment mismatch is fail-closed', () => {
  const verdict = sendAuthorization(authorizedEnv({ RAILWAY_ENVIRONMENT: 'preview' }));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /authorized send environment/);
});

test('blank token is fail-closed', () => {
  const verdict = sendAuthorization(authorizedEnv({ [AUTHORIZED_TOKEN_VAR]: '   ' }));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /SEND_AUTHORIZED_TOKEN/);
});

test('wrong worker role is fail-closed', () => {
  const verdict = sendAuthorization(authorizedEnv({ [WORKER_ROLE_VAR]: 'web' }));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /SEND_WORKER_ROLE/);
});

test('assertSendAuthorized throws a reason and never logs the token', () => {
  assert.throws(() => assertSendAuthorized({ SENDING_ENABLED: 'true' }), /SEND_AUTHORIZED_ENV/);
  assert.doesNotThrow(() => assertSendAuthorized(authorizedEnv()));
});

test('authorized production-like environment is allowed', () => {
  const verdict = sendAuthorization(authorizedEnv());
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, '');
});

test('Gmail sendEmail calls assertSendAuthorized before constructing the provider', async () => {
  const source = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
  const code = source.slice(
    source.indexOf('async function sendEmail('),
    source.indexOf('async function loadOutreachProviderState('),
  );
  assert.match(code, /assertSendAuthorized\(\);\n  assertStaffingSendAllowed\(lead\);/);

  let constructed = 0;
  class Provider {
    constructor() { constructed += 1; }
    async sendEmail() { return { data: { id: 'm1', threadId: 't1' } }; }
  }
  const send = new Function(
    'assertStaffingSendAllowed', 'assertSendAuthorized', 'PRIMARY_GMAIL_SENDER',
    'GmailOutreachProvider', 'gmailForSender', 'toRawMessage',
    `${code}; return sendEmail;`,
  )(
    () => {},
    () => assertSendAuthorized({
      SENDING_ENABLED: 'true',
      SPREADSHEET_ID: 'prod-looking-sheet',
      GMAIL_TOKEN_JSON: '{"access_token":"copied"}',
    }),
    { sendEligible: true },
    Provider,
    () => assert.fail('Gmail client must not be built'),
    () => assert.fail('MIME must not be built'),
  );
  await assert.rejects(
    send({ lead: { id: '1', email: 'a@x.test' }, to: 'a@x.test', sender: { sendEligible: true } }),
    /SEND_AUTHORIZED_ENV/,
  );
  assert.equal(constructed, 0);
});

test('authorized sendEmail proceeds to the provider exactly once', async () => {
  const source = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
  const code = source.slice(
    source.indexOf('async function sendEmail('),
    source.indexOf('async function loadOutreachProviderState('),
  );
  let constructed = 0;
  let sent = 0;
  class Provider {
    constructor() { constructed += 1; }
    async sendEmail() { sent += 1; return { data: { id: 'm1', threadId: 't1' } }; }
  }
  const send = new Function(
    'assertStaffingSendAllowed', 'assertSendAuthorized', 'PRIMARY_GMAIL_SENDER',
    'GmailOutreachProvider', 'gmailForSender', 'toRawMessage',
    `${code}; return sendEmail;`,
  )(
    () => {},
    () => assertSendAuthorized(authorizedEnv()),
    { sendEligible: true },
    Provider,
    () => ({ users: { messages: { send: async () => ({}) } } }),
    () => 'raw',
  );
  await send({
    lead: { id: '1', email: 'a@x.test' }, to: 'a@x.test', subject: 's', body: 'b',
    sender: { sendEligible: true, id: 'primary', email: 'from@x.test' },
  });
  assert.equal(constructed, 1);
  assert.equal(sent, 1);
});

test('Smartlead enqueue and ordinary/sequence sends keep the authorization gate at the provider boundary', () => {
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('\r\n').join('\n');
  assert.match(agent, /async function sendEmail\([\s\S]*?assertSendAuthorized\(\);/);
  assert.match(agent, /async function enqueueSmartleadLead\(lead, mapping\) \{\n  assertSendAuthorized\(\);/);
  assert.match(agent, /const gate = await guardProviderSend\(lead, freshSendSafetyDeps\(\), \{ purpose: 'cold' \}\);/);
  assert.match(agent, /const gate = await guardProviderSend\(safetyLead, freshSendSafetyDeps\(\), \{ purpose: 'sequence' \}\);/);
  assert.match(server, /assertSendAuthorized\(\);\n    const safety = await guardProviderSend\(found\.lead/);
});
