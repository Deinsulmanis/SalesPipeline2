'use strict';

// Jole BTX LLC's six cold-sending mailboxes, registered connected-but-dormant
// (2026-10-12): warming, 0/day, 0/run, Jole-only, one campaign. These tests pin
// the registration, credential isolation, the tenant boundary at the final
// Gmail provider gate, thread ownership across all six inboxes, observer and
// reply scoping, and that ScaleLab's senders are untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SECONDARY_INBOXES, credentialsFor, verifyMailboxAccess, publicRegistry, withDefaultInboxes, parseRegistry,
} = require('../integrations/gmail-inbox-registry');
const {
  configuredSenders, observableSenders, allowedForLead, chooseSender, pinnedSenderId,
} = require('../integrations/gmail-sender-routing');
const { withGmailProviderSend, setSendReservationStoreForTests } = require('../integrations/send-lock');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { resolveSenderClient } = require('../integrations/clients/ownership');
const { leadsInEmailScope } = require('../integrations/clients/email-scope');
const { resolveReplyClientContext } = require('../integrations/clients/reply-policy');
const { assignNewLeads } = require('../integrations/sender-balance');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { clientSendState } = require('../integrations/clients/send-policy');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

const CAMPAIGN = 'jole-btx-employer-acquisition';
const VERSION = 'jole_industrial_employer_acquisition_v1';
const SIX = [
  ['jole_group_jorge', 'jorge@jolebtxgroup.com', 'GMAIL_JOLE_GROUP_JORGE_TOKEN_JSON'],
  ['jole_group_jguerrero', 'j.guerrero@jolebtxgroup.com', 'GMAIL_JOLE_GROUP_JGUERRERO_TOKEN_JSON'],
  ['jole_team_jorge', 'jorge@jolebtxteam.com', 'GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON'],
  ['jole_team_jguerrero', 'j.guerrero@jolebtxteam.com', 'GMAIL_JOLE_TEAM_JGUERRERO_TOKEN_JSON'],
  ['jole_industrial_jorge', 'jorge@joleindustrial.com', 'GMAIL_JOLE_INDUSTRIAL_JORGE_TOKEN_JSON'],
  ['jole_industrial_jguerrero', 'j.guerrero@joleindustrial.com', 'GMAIL_JOLE_INDUSTRIAL_JGUERRERO_TOKEN_JSON'],
];
const SIX_IDS = SIX.map(([id]) => id);

// Production's ScaleLab registry override and credentials, no Jole token yet.
const PROD_ENV = Object.freeze({
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 30, perRunLimit: 5, staffingOnly: true },
    { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', dailyLimit: 45, perRunLimit: 3 },
    { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 45, perRunLimit: 3 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
});
const withAllJoleTokens = (extra = {}) => ({ ...PROD_ENV, ...Object.fromEntries(SIX.map(([, , tokenEnv]) => [tokenEnv, '{"refresh_token":"r"}'])), ...extra });
const isScaleLab = sender => (sender.clientId || 'scalelab') === 'scalelab';

const joleLead = (extra = {}) => ({
  id: 'jl1', clientId: 'jole', company: 'Gulfside Fabrication', email: 'ops@gulfside.example.com', stage: 'Queued',
  emailStatus: '', emailStep: '', notes: '', leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
  intendedCampaignVersion: VERSION, campaign: CAMPAIGN, senderInboxId: '', routingRequired: 'true', ...extra,
});
const scalelabLead = (extra = {}) => ({
  id: 'sl1', clientId: 'scalelab', company: 'Acme Staffing', email: 'a@acmestaffing.example.com', stage: 'Queued',
  emailStatus: '', emailStep: '', notes: '', leadNiche: 'industrial_staffing', tradeType: 'industrial_staffing',
  intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1', campaign: 'Industrial Staffing Agency',
  emailTemplateId: 'industrial-staffing-employer-v1', senderInboxId: '', routingRequired: 'true', ...extra,
});
const retiredLeads = () => [
  { id: 'd1', company: 'Bright Smiles Dental', email: 'office@brightsmiles.example.com', leadNiche: 'dental', tradeType: 'Dental',
    emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List', stage: 'Archived' },
  { id: 'r1', company: 'Peak Roofing', email: 'owner@peakroofing.example.com', leadNiche: 'roofing', tradeType: 'Roofing',
    campaign: 'Roofing Survey', stage: 'Archived' },
  { id: 'm1', company: 'Glow Med Spa', email: 'hello@glowmedspa.example.com', leadNiche: 'med_spa', tradeType: 'Med Spa',
    campaign: 'Med Spa', stage: 'Archived' },
];
// A Jole sender as it would look after warmup is approved and capacity raised.
const activatedJoleSender = (id = 'jole_team_jorge', extra = {}) => {
  const [, email, tokenEnv] = SIX.find(row => row[0] === id);
  return { id, email, tokenEnv, clientId: 'jole', status: 'active', sendEligible: true, dailyLimit: 20, perRunLimit: 2,
    credentialConfigured: true, observerEnabled: true, provider: 'gmail', allowedCampaignIds: [CAMPAIGN], ...extra };
};
const scalelabSender = (id = 'deniels') => configuredSenders(PROD_ENV).find(sender => sender.id === id);
// Jole as it would be after an explicit authorization: active, sending enabled
// in its config and named in CLIENT_SENDING_AUTHORIZED. Never production state.
const authorizeJoleForTest = () => activateJoleForTest({
  sending: Object.freeze({ enabled: true, requiresEnvAuthorization: true, clientSuppressionRequired: true }),
});
const AUTHORIZED_ENV = { CLIENT_SENDING_AUTHORIZED: 'jole' };

async function providerVerdict({ lead, sender, env = AUTHORIZED_ENV, actionId = `cold:${lead.id}:1` }) {
  let delivered = false;
  try {
    await withGmailProviderSend({ lead, sender, env, sendAction: { actionId, leadId: lead.id }, run: async () => { delivered = true; return { id: 'g' }; } });
    return { delivered, code: 'sent' };
  } catch (error) { return { delivered, code: error.code || error.message }; }
}

// ── Registration ────────────────────────────────────────────────────────────

test('six Jole senders are registered with exact ids, mailboxes, credentials and dormant limits', () => {
  const defaults = DEFAULT_SECONDARY_INBOXES.filter(row => row.clientId === 'jole');
  assert.deepEqual(defaults.map(row => [row.id, row.email, row.tokenEnv]), SIX);
  const senders = configuredSenders(PROD_ENV).filter(sender => sender.clientId === 'jole');
  assert.deepEqual(senders.map(sender => sender.id), SIX_IDS);
  for (const sender of senders) {
    assert.equal(sender.provider, 'gmail');
    assert.equal(sender.status, 'warming', 'not ready, not active');
    assert.equal(sender.dailyLimit, 0, 'zero daily cold capacity');
    assert.equal(sender.perRunLimit, 0, 'zero window capacity');
    assert.equal(sender.sendEligible, false);
    assert.deepEqual([...sender.allowedCampaignIds], [CAMPAIGN]);
    assert.equal(sender.observerEnabled, true, 'observer may run independently of cold sending');
    assert.match(sender.policyBlockers.join(' '), /client sending is not authorized/);
  }
  // The corporate reply/calendar identity is not one of them.
  assert.equal(configuredSenders(PROD_ENV).some(sender => sender.email === 'jorgeg@jolebtx.com'), false);
});

test('the six appear in the Jole sender list only, with a dormant public state', () => {
  const env = withAllJoleTokens();
  const rows = publicRegistry(withDefaultInboxes(parseRegistry(env.GMAIL_INBOX_REGISTRY_JSON, env), env), env);
  const jole = rows.filter(row => row.clientId === 'jole');
  assert.deepEqual(jole.map(row => [row.id, row.status, row.dailyLimit, row.sendEligible, row.credentialConfigured]),
    SIX_IDS.map(id => [id, 'warming', 0, false, true]));
  assert.equal(rows.filter(row => row.clientId === 'scalelab').some(row => SIX_IDS.includes(row.id)), false);
});

// ── Credentials ─────────────────────────────────────────────────────────────

test('credential isolation: one token variable per mailbox, never the primary or a ScaleLab variable', () => {
  const tokenEnvs = SIX.map(([, , tokenEnv]) => tokenEnv);
  assert.equal(new Set(tokenEnvs).size, 6);
  const scalelabTokens = configuredSenders(PROD_ENV).filter(isScaleLab).map(sender => sender.tokenEnv);
  for (const tokenEnv of tokenEnvs) {
    assert.notEqual(tokenEnv, 'GMAIL_TOKEN_JSON');
    assert.equal(scalelabTokens.includes(tokenEnv), false, tokenEnv);
  }
  // A managed inbox sharing another inbox's credential is blocked, not loaded silently.
  const shared = { ...PROD_ENV, GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([...JSON.parse(PROD_ENV.GMAIL_INBOX_REGISTRY_JSON),
    { id: 'jole_extra', email: 'extra@jolebtxteam.com', clientId: 'jole', status: 'active', tokenEnv: 'GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON', dailyLimit: 20, perRunLimit: 2 }]) };
  const senders = configuredSenders(shared);
  for (const id of ['jole_extra', 'jole_team_jorge']) {
    assert.match(senders.find(sender => sender.id === id).policyBlockers.join(' '), /shared with another inbox/, id);
  }
  // ScaleLab rows are not judged by the managed-client rule.
  for (const sender of senders.filter(isScaleLab)) assert.equal(sender.policyBlockers, undefined, sender.id);
});

test('a token minted for another account is refused by identity verification', async () => {
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'jorge@jolebtxgroup.com' } }),
    messages: { list: async () => ({ data: { messages: [] } }) } } };
  await assert.rejects(verifyMailboxAccess({ gmail, expectedEmail: 'j.guerrero@jolebtxgroup.com' }), /Credential belongs to jorge@jolebtxgroup.com/);
  const ok = await verifyMailboxAccess({ gmail, expectedEmail: 'jorge@jolebtxgroup.com' });
  assert.equal(ok.identityVerified, true);
});

test('missing or malformed credentials are failure-safe: not ready, not observed, no crash', () => {
  const senders = configuredSenders(PROD_ENV);
  const jole = senders.filter(sender => sender.clientId === 'jole');
  assert.equal(jole.length, 6);
  for (const sender of jole) {
    assert.equal(sender.credentialConfigured, false);
    assert.equal(sender.sendEligible, false);
    assert.throws(() => credentialsFor(sender, PROD_ENV), /is not configured/);
  }
  assert.equal(observableSenders(senders).some(sender => sender.clientId === 'jole'), false, 'no observer runs without a token');
  const malformed = { ...PROD_ENV, GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON: 'not json' };
  assert.doesNotThrow(() => configuredSenders(malformed), 'a bad Jole token never breaks the registry');
  assert.throws(() => credentialsFor(configuredSenders(malformed).find(s => s.id === 'jole_team_jorge'), malformed), /valid token JSON/);
  assert.throws(() => credentialsFor({ tokenEnv: 'GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON' }, { GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON: '{}' }), /refresh_token/);
});

// ── Tenant isolation at the final provider boundary ─────────────────────────

test('tenant isolation: only a Jole lead with an activated Jole sender reaches Gmail', async t => {
  t.after(authorizeJoleForTest());
  assert.equal(clientSendState('jole', AUTHORIZED_ENV).sendingEnabled, true, 'modelled authorization');
  const allowed = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender() });
  assert.deepEqual(allowed, { delivered: true, code: 'sent' });

  const joleViaScaleLab = await providerVerdict({ lead: joleLead(), sender: scalelabSender('deniels') });
  assert.deepEqual(joleViaScaleLab, { delivered: false, code: 'client_ownership_conflict' });

  const scalelabViaJole = await providerVerdict({ lead: scalelabLead(), sender: activatedJoleSender() });
  assert.deepEqual(scalelabViaJole, { delivered: false, code: 'client_ownership_conflict' });

  for (const lead of retiredLeads()) {
    const verdict = await providerVerdict({ lead, sender: activatedJoleSender() });
    assert.equal(verdict.delivered, false, lead.id);
    assert.equal(verdict.code, 'client_ownership_conflict', lead.id);
  }
  // No client at all is ScaleLab's legacy default, never Jole's.
  const nullClient = await providerVerdict({ lead: { id: 'n1', email: 'x@nowhere.example.com', company: 'X' }, sender: activatedJoleSender() });
  assert.deepEqual(nullClient, { delivered: false, code: 'client_ownership_conflict' });
  const unknownClient = await providerVerdict({ lead: joleLead({ clientId: 'acme' }), sender: activatedJoleSender() });
  assert.equal(unknownClient.delivered, false);
});

test('a bad queue row or runtime row cannot cross tenants at the routing layer either', () => {
  const sender = activatedJoleSender();
  assert.equal(allowedForLead(sender, scalelabLead({ senderInboxId: 'jole_team_jorge' })), false);
  assert.throws(() => chooseSender({ lead: scalelabLead({ senderInboxId: 'jole_team_jorge' }), senders: [sender] }), /not delivery eligible/);
  for (const lead of retiredLeads()) assert.equal(allowedForLead(sender, lead), false, lead.id);
  assert.equal(allowedForLead(scalelabSender('primary'), joleLead()), false);
  assert.throws(() => chooseSender({ lead: joleLead({ senderInboxId: 'deniels' }), senders: [scalelabSender('deniels')] }), /not delivery eligible/);
  // A runtime overlay marking a Jole row active changes nothing while the client cannot send.
  const overlaid = configuredSenders(withAllJoleTokens({ GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(SIX_IDS.map(id => ({ id, status: 'active' }))) }));
  for (const id of SIX_IDS) assert.equal(overlaid.find(s => s.id === id).sendEligible, false, id);
});

test('campaign isolation: a Jole sender serves only jole-btx-employer-acquisition', async t => {
  t.after(authorizeJoleForTest());
  const archived = joleLead({ intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL', campaign: 'JOLE_DC_MISSION_CRITICAL', emailTemplateId: 'jole-dc-mission-critical-v1' });
  const verdict = await providerVerdict({ lead: archived, sender: activatedJoleSender() });
  assert.equal(verdict.delivered, false);
  assert.equal(verdict.code, 'sender_campaign_not_allowed');
  assert.equal(allowedForLead(activatedJoleSender(), archived), false);
});

test('inactive, not-ready, zero-capacity and blocked senders are denied at the boundary', async t => {
  t.after(authorizeJoleForTest());
  for (const extra of [
    { status: 'paused', sendEligible: false },
    { status: 'warming', sendEligible: false },
    { status: 'ready', sendEligible: false },
    { status: 'active', dailyLimit: 0, sendEligible: false },
  ]) {
    const verdict = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender('jole_group_jorge', extra) });
    assert.deepEqual(verdict, { delivered: false, code: 'sender_not_eligible' }, JSON.stringify(extra));
  }
  const blocked = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender('jole_group_jorge', { policyBlockers: ['x is shared'] }) });
  assert.deepEqual(blocked, { delivered: false, code: 'sender_policy_blocked' });
  // And as actually configured in production, every one of the six is refused.
  for (const sender of configuredSenders(withAllJoleTokens(AUTHORIZED_ENV)).filter(s => s.clientId === 'jole')) {
    const verdict = await providerVerdict({ lead: joleLead(), sender });
    assert.equal(verdict.delivered, false, sender.id);
  }
});

test('production state: Jole sending is off, so no Jole send reaches Gmail from any of the six', async () => {
  assert.equal(clientSendState('jole', {}).sendingEnabled, false);
  assert.equal(clientSendState('jole', AUTHORIZED_ENV).sendingEnabled, false, 'the env alone cannot authorize Jole');
  for (const id of SIX_IDS) {
    const verdict = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender(id), env: AUTHORIZED_ENV });
    assert.deepEqual(verdict, { delivered: false, code: 'client_sending_disabled' }, id);
  }
});

// ── Routing after activation ────────────────────────────────────────────────

test('after activation, Jole leads spread across the six Jole inboxes only, never ScaleLab', () => {
  const joleSenders = SIX_IDS.map(id => activatedJoleSender(id));
  const scalelab = configuredSenders(PROD_ENV).filter(isScaleLab).map(sender => ({ ...sender, sendEligible: true }));
  const batch = Array.from({ length: 30 }, (_, i) => joleLead({ id: `jl${i}`, email: `hr${i}@employer${i}.example.com` }));
  const { assignments, refused } = assignNewLeads({ batch, senders: [...scalelab, ...joleSenders] });
  assert.equal(refused.length, 0);
  assert.deepEqual([...new Set(assignments.values())].sort(), [...SIX_IDS].sort(), 'all six receive work');
  const scalelabBatch = assignNewLeads({ batch: [scalelabLead()], senders: joleSenders });
  assert.equal(scalelabBatch.assignments.size, 0);
  // With the six dormant (production), a Jole lead is assigned nowhere.
  assert.equal(assignNewLeads({ batch, senders: configuredSenders(withAllJoleTokens()) }).assignments.size, 0);
});

// ── Thread and follow-up ownership ──────────────────────────────────────────

const sentFrom = (lead, senderInboxId, step = 1) => ({
  eventId: `send:${lead.id}:${step}`, sourceLeadId: lead.id, leadId: `CE-${lead.id}`, eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent',
  occurredAt: `2026-10-1${step}T15:00:00Z`, metadata: JSON.stringify({ senderInboxId, gmailThreadId: `t-${lead.id}` }),
});

test('thread ownership: once Step 1 leaves an inbox, every follow-up stays on it, for each of the six', () => {
  const senders = SIX_IDS.map(id => activatedJoleSender(id));
  for (const owner of SIX_IDS) {
    const lead = joleLead({ id: `own_${owner}`, emailStatus: 'emailed', emailStep: '1', senderInboxId: owner });
    const activities = [sentFrom(lead, owner)];
    assert.equal(pinnedSenderId(lead, activities), owner);
    for (const step of [2, 3]) {
      const choice = chooseSender({ lead, activities, senders, step });
      assert.equal(choice.sender.id, owner, `step ${step} stays on ${owner}`);
      assert.equal(choice.pinned, true);
      // The owner at capacity defers the follow-up; no other Jole inbox takes the thread.
      const full = chooseSender({ lead, activities, senders, step, sendsToday: new Map([[owner, 20]]) });
      assert.equal(full.sender, null);
      assert.match(full.reason, /pinned sender daily limit/);
    }
  }
});

test('follow-up ownership fails closed on missing or conflicting proof', () => {
  const senders = SIX_IDS.map(id => activatedJoleSender(id));
  const lead = joleLead({ id: 'fu1', emailStatus: 'emailed', emailStep: '1', senderInboxId: '' });
  assert.throws(() => chooseSender({ lead, activities: [], senders, step: 2 }), /no proven sender ownership/);
  const conflicting = [sentFrom(lead, 'jole_team_jorge', 1), sentFrom(lead, 'jole_group_jorge', 2)];
  assert.throws(() => chooseSender({ lead, activities: conflicting, senders, step: 3 }), /sender ownership conflict/);
  // A follow-up pinned to a ScaleLab inbox is refused for a Jole lead.
  assert.throws(() => chooseSender({ lead, activities: [sentFrom(lead, 'deniels')], senders: [...senders, scalelabSender('deniels')], step: 2 }), /not delivery eligible/);
});

// ── Observers and reply attribution ─────────────────────────────────────────

test('observers: each Jole inbox observes once its own token exists, and matches Jole leads only', () => {
  const observed = observableSenders(configuredSenders(withAllJoleTokens()));
  assert.deepEqual(observed.filter(sender => sender.clientId === 'jole').map(sender => sender.id), SIX_IDS,
    'observed while paused/warming: observation does not need cold-send activation');
  for (const sender of observed.filter(item => item.clientId === 'jole')) {
    assert.equal(resolveSenderClient(sender).clientId, 'jole');
    assert.equal(sender.sendEligible, false);
  }
  // Same address in both tenants: a Jole inbox's observer sees only the Jole row.
  const shared = 'hr@both.example.com';
  const leads = [joleLead({ id: 'j-shared', email: shared }), scalelabLead({ id: 's-shared', email: shared })];
  assert.deepEqual(leadsInEmailScope(leads, 'jole').map(lead => lead.id), ['j-shared']);
  assert.deepEqual(leadsInEmailScope(leads, 'scalelab').map(lead => lead.id), ['s-shared']);
});

test('reply attribution: a reply on a Jole inbox belongs to a Jole lead, never a ScaleLab one', () => {
  const senders = configuredSenders(withAllJoleTokens());
  for (const id of SIX_IDS) {
    assert.equal(resolveReplyClientContext({ senderInboxId: id, lead: joleLead(), senders }).ok, true, id);
    assert.equal(resolveReplyClientContext({ senderInboxId: id, lead: scalelabLead(), senders }).ok, false, id);
  }
  assert.equal(resolveReplyClientContext({ senderInboxId: 'deniels', lead: joleLead(), senders }).ok, false);
});

// ── Reservations and duplicate sends ────────────────────────────────────────

test('reservation safety: a cross-tenant pair is refused before any reservation is written', async t => {
  t.after(authorizeJoleForTest());
  const store = createMemorySendReservationStore();
  const calls = [];
  const spy = new Proxy(store, { get: (target, key) => (typeof target[key] === 'function'
    ? (...args) => { calls.push(key); return target[key](...args); } : target[key]) });
  setSendReservationStoreForTests(spy);
  t.after(() => setSendReservationStoreForTests(null));
  const env = { ...AUTHORIZED_ENV, SEND_LOCK_ENABLED: 'true' };
  const crossed = await providerVerdict({ lead: scalelabLead(), sender: activatedJoleSender(), env });
  assert.equal(crossed.code, 'client_ownership_conflict');
  assert.deepEqual(calls, [], 'no reservation for a refused pair');
});

test('duplicate-send protection: one action id delivers at most once through a Jole inbox', async t => {
  t.after(authorizeJoleForTest());
  setSendReservationStoreForTests(createMemorySendReservationStore());
  t.after(() => setSendReservationStoreForTests(null));
  const env = { ...AUTHORIZED_ENV, SEND_LOCK_ENABLED: 'true' };
  const first = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender(), env, actionId: 'cold:jl1:1' });
  assert.deepEqual(first, { delivered: true, code: 'sent' });
  const second = await providerVerdict({ lead: joleLead(), sender: activatedJoleSender(), env, actionId: 'cold:jl1:1' });
  assert.equal(second.delivered, false, 'the same action cannot reach Gmail twice');
});

// ── ScaleLab unaffected ─────────────────────────────────────────────────────

test('ScaleLab is unaffected: same roster, caps, capacity and provider verdicts', async () => {
  const withoutJole = configuredSenders(PROD_ENV).filter(isScaleLab);
  assert.deepEqual(withoutJole.map(s => [s.id, s.status, s.dailyLimit, s.perRunLimit, s.sendEligible]), [
    ['primary', 'active', 50, 6, true], ['tryscalelabai', 'active', 30, 6, true], ['scalelabaiteam', 'paused', 30, 5, false],
    ['deniels', 'active', 45, 3, true], ['deniels_tryscalelabai', 'active', 45, 3, true],
  ]);
  // Six dormant Jole rows add no capacity.
  const all = capacityFromEnv(configuredSenders(PROD_ENV), PROD_ENV);
  const scalelabOnly = capacityFromEnv(withoutJole, PROD_ENV);
  assert.deepEqual(
    [all.dailySum, all.perRunSum, all.globalDailyLimit, all.globalPerRunLimit],
    [scalelabOnly.dailySum, scalelabOnly.perRunSum, scalelabOnly.globalDailyLimit, scalelabOnly.globalPerRunLimit]);
  // A ScaleLab lead from a ScaleLab inbox passes the boundary exactly as before.
  for (const sender of withoutJole.filter(s => s.sendEligible)) {
    const verdict = await providerVerdict({ lead: scalelabLead(), sender, env: {} });
    assert.deepEqual(verdict, { delivered: true, code: 'sent' }, sender.id);
  }
});
