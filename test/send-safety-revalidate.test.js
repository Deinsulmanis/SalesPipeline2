'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { guardProviderSend, revalidateFreshSendSafety, evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { REQUIRED_WORKER_ROLE } = require('../integrations/send-authorization');
const { assertStaffingSendAllowed, ACTIVATION_VARIABLE } = require('../integrations/staffing-launch-gate');

const root = path.join(__dirname, '..');

function authorizedEnv(extra = {}) {
  return {
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'prod-sender',
    SEND_AUTHORIZED_ENV: 'prod-sender',
    SEND_AUTHORIZED_TOKEN: 'test-sender-token',
    SEND_WORKER_ROLE: REQUIRED_WORKER_ROLE,
    ...extra,
  };
}

function eligibleLead(overrides = {}) {
  return {
    id: 'L1', email: 'owner@harbour.test', notes: 'enriched',
    stage: 'Queued', emailStatus: '', campaign: 'Ontario List',
    ...overrides,
  };
}

async function attemptSend(lead, durable, env, purpose = 'cold') {
  let providerCalls = 0;
  const gate = await guardProviderSend(lead, {
    env,
    loadFreshLead: async id => (durable.leads.has(id) ? durable.leads.get(id) : null),
    loadSuppressedEmails: async () => {
      if (durable.suppressionError) throw new Error(durable.suppressionError);
      return durable.suppressed;
    },
  }, { purpose });
  if (gate.allowed) providerCalls += 1;
  return { providerCalls, gate };
}

test('A. suppression added after selection blocks the provider send', async () => {
  const lead = eligibleLead();
  const durable = {
    leads: new Map([[lead.id, { ...lead }]]),
    suppressed: new Set(),
  };
  durable.suppressed.add(lead.email.toLowerCase());
  const { providerCalls, gate } = await attemptSend(lead, durable, authorizedEnv());
  assert.equal(providerCalls, 0);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'suppressed');
});

test('B. manual hold added after the agent snapshot blocks the provider send', async () => {
  const snapshot = eligibleLead();
  const durable = {
    leads: new Map([[snapshot.id, { ...snapshot, notes: '[MANUAL HOLD] operator paused' }]]),
    suppressed: new Set(),
  };
  const { providerCalls, gate } = await attemptSend(snapshot, durable, authorizedEnv());
  assert.equal(providerCalls, 0);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'manual_hold');
});

test('unsubscribe and bounce on the fresh row block the send', async () => {
  for (const [notes, code] of [
    ['[REPLY: Unsubscribed] bye', 'unsubscribed'],
    ['[BOUNCED] mailbox gone', 'bounced'],
  ]) {
    const lead = eligibleLead();
    const durable = {
      leads: new Map([[lead.id, { ...lead, notes }]]),
      suppressed: new Set(),
    };
    const { providerCalls, gate } = await attemptSend(lead, durable, authorizedEnv());
    assert.equal(providerCalls, 0, code);
    assert.equal(gate.code, code);
  }
});

test('terminal and promoted stages are not sendable on the cold path', async () => {
  for (const current of [
    eligibleLead({ emailStatus: 'replied' }),
    eligibleLead({ emailStatus: 'done' }),
    eligibleLead({ stage: 'Promoted' }),
    eligibleLead({ stage: 'Unsub' }),
  ]) {
    const lead = eligibleLead();
    const durable = { leads: new Map([[lead.id, current]]), suppressed: new Set() };
    const { providerCalls, gate } = await attemptSend(lead, durable, authorizedEnv());
    assert.equal(providerCalls, 0, JSON.stringify(current));
    assert.equal(gate.code, 'terminal_state');
  }
});

test('a failed fresh read does not send', async () => {
  const lead = eligibleLead();
  const durable = {
    leads: new Map([[lead.id, lead]]),
    suppressed: new Set(),
    suppressionError: 'Sheets quota',
  };
  const { providerCalls, gate } = await attemptSend(lead, durable, authorizedEnv());
  assert.equal(providerCalls, 0);
  assert.equal(gate.code, 'revalidation_unavailable');
});

test('D. prod-looking credentials without send authorization do not send', async () => {
  const lead = eligibleLead();
  const durable = { leads: new Map([[lead.id, lead]]), suppressed: new Set() };
  const { providerCalls, gate } = await attemptSend(lead, durable, {
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'production',
    SPREADSHEET_ID: '1prodSpreadsheetId',
    GMAIL_TOKEN_JSON: '{"access_token":"copied-from-prod"}',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
  });
  assert.equal(providerCalls, 0);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'send_unauthorized');
  assert.doesNotMatch(JSON.stringify(gate), /copied-from-prod|access_token/);
});

test('E. authorized production-like environment sends exactly once', async () => {
  const lead = eligibleLead();
  const durable = { leads: new Map([[lead.id, lead]]), suppressed: new Set() };
  const { providerCalls, gate } = await attemptSend(lead, durable, authorizedEnv());
  assert.equal(gate.allowed, true);
  assert.equal(providerCalls, 1);
  const second = await attemptSend(lead, durable, authorizedEnv());
  assert.equal(second.providerCalls, 1);
});

test('F. staffing launch gate remains fail-closed in an authorized environment', async () => {
  const lead = eligibleLead({
    campaign: 'Industrial Staffing Agency',
    leadNiche: 'industrial_staffing',
    emailTemplateId: 'industrial-staffing-employer-v1',
  });
  const durable = { leads: new Map([[lead.id, { ...lead }]]), suppressed: new Set() };
  const env = authorizedEnv();
  assert.throws(() => assertStaffingSendAllowed(lead, env), /paused/);
  const { providerCalls, gate } = await attemptSend(lead, durable, env);
  assert.equal(providerCalls, 0);
  assert.equal(gate.code, 'staffing_launch_paused');
  const activated = authorizedEnv({ [ACTIVATION_VARIABLE]: '2026-09-01T00:00:00.000Z' });
  assert.doesNotThrow(() => assertStaffingSendAllowed(lead, activated));
  const allowed = await attemptSend(lead, durable, activated);
  assert.equal(allowed.providerCalls, 1);
});

test('sequence purpose still refuses suppression and hold but not pipeline stages', async () => {
  const lead = eligibleLead({ stage: 'hot', emailStatus: 'emailed' });
  const durable = { leads: new Map([[lead.id, { ...lead }]]), suppressed: new Set() };
  const ok = await attemptSend(lead, durable, authorizedEnv(), 'sequence');
  assert.equal(ok.providerCalls, 1);
  durable.leads.set(lead.id, { ...lead, notes: '[MANUAL HOLD]' });
  const held = await attemptSend(lead, durable, authorizedEnv(), 'sequence');
  assert.equal(held.providerCalls, 0);
  assert.equal(held.gate.code, 'manual_hold');
});

test('warm-path subset still reports identity and suppression without changing extra hold semantics', () => {
  const lead = eligibleLead();
  const missing = evaluateFreshSendSafety(lead, null, new Set(), { purpose: 'warm' });
  assert.equal(missing.code, 'identity_changed');
  const suppressed = evaluateFreshSendSafety(
    lead, { ...lead, notes: '[REPLY: Unsubscribed]' }, new Set(), { purpose: 'warm' });
  assert.equal(suppressed.code, 'unsubscribed');
  const releasedHold = evaluateFreshSendSafety(
    lead,
    { ...lead, notes: '[MANUAL HOLD] [RESUME: 2020-01-01T00:00:00.000Z]' },
    new Set(),
    { purpose: 'warm' },
  );
  assert.equal(releasedHold.allowed, true, 'warm caller keeps the extra verbatim hold check');
});

test('revalidateFreshSendSafety never uses a cached suppression set from the caller', async () => {
  const lead = eligibleLead();
  const cached = new Set();
  const durable = new Set([lead.email]);
  const gate = await revalidateFreshSendSafety(lead, {
    env: authorizedEnv(),
    loadFreshLead: async () => lead,
    loadSuppressedEmails: async () => durable,
  }, { purpose: 'cold' });
  assert.equal(gate.allowed, false);
  assert.equal(cached.size, 0);
});

test('ordinary cold and sequence paths call last-moment revalidation after reserve and before send', () => {
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const ordinary = agent.slice(
    agent.indexOf('async function deliverOrdinaryColdStep'),
    agent.indexOf('async function markReplied'),
  );
  assert.ok(ordinary.indexOf('ordinary_send_reserved') < ordinary.indexOf('guardProviderSend(lead'));
  assert.ok(ordinary.indexOf('guardProviderSend(lead') < ordinary.indexOf('result = await sendEmail('));
  const pass = agent.slice(agent.indexOf('async function runStageSequencePass'), agent.indexOf('async function run()'));
  assert.ok(pass.indexOf('SEQUENCE_EVENTS.SEND_RESERVED') < pass.indexOf('guardProviderSend(safetyLead'));
  assert.ok(pass.indexOf('guardProviderSend(safetyLead') < pass.indexOf('result = await sendEmail('));
  assert.match(agent, /evaluateFreshSendSafety\(lead, current, suppressed, \{ purpose: 'warm' \}\)/);
});
