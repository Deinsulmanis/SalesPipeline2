'use strict';

// Jole launch preparation (2026-10-15). Jole is fully prepared: its six
// inboxes are active at 20/day and 2/window, its personalization-ready leads
// are assigned and queued. But CLIENT_SENDING_AUTHORIZED does not name jole, so
// no Jole send can happen. Preparation authority (mark ready, activate, assign,
// balance, queue) is separate from send authority, and every send path still
// requires the final switch. ScaleLab's roster, capacity and assignments do
// not change.
//
// Nothing here can send: the provider `run` is a spy, reservation stores are
// in memory, and the production-equivalent env carries no real credentials.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { configuredSenders, chooseSender, allowedForLead } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { createClientCapacityState, clientCapacityVerdict, consumeClientCapacity } = require('../integrations/clients/capacity');
const { clientSendState, clientSendBlock, clientPreparationBlock } = require('../integrations/clients/send-policy');
const { routedLeadReady, validateRoute, validateCampaignVersionRoute } = require('../integrations/campaign-routing');
const { activationBlockers, activateSender } = require('../integrations/gmail-sender-lifecycle');
const { assignBatch, assignNewLeads, planSenderRebalance } = require('../integrations/sender-balance');
const { queueSelectedLeads, AUTO_SENDER } = require('../integrations/outreach-queue');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { withGmailProviderSend, setSendReservationStoreForTests } = require('../integrations/send-lock');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const ROOT = path.join(__dirname, '..');
const CAMPAIGN = 'jole-btx-employer-acquisition';
const TEMPLATE = 'jole-industrial-employer-v1';
const DAY = 24 * 60 * 60 * 1000;
const SIX = [
  ['jole_group_jorge', 'jorge@jolebtxgroup.com', 'GMAIL_JOLE_GROUP_JORGE_TOKEN_JSON'],
  ['jole_group_jguerrero', 'j.guerrero@jolebtxgroup.com', 'GMAIL_JOLE_GROUP_JGUERRERO_TOKEN_JSON'],
  ['jole_team_jorge', 'jorge@jolebtxteam.com', 'GMAIL_JOLE_TEAM_JORGE_TOKEN_JSON'],
  ['jole_team_jguerrero', 'j.guerrero@jolebtxteam.com', 'GMAIL_JOLE_TEAM_JGUERRERO_TOKEN_JSON'],
  ['jole_industrial_jorge', 'jorge@joleindustrial.com', 'GMAIL_JOLE_INDUSTRIAL_JORGE_TOKEN_JSON'],
  ['jole_industrial_jguerrero', 'j.guerrero@joleindustrial.com', 'GMAIL_JOLE_INDUSTRIAL_JGUERRERO_TOKEN_JSON'],
];
const SIX_IDS = SIX.map(([id]) => id);
const SCALELAB_IDS = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'];

// ScaleLab exactly as live: 50/6, 30/6, paused team inbox, 45/5, 45/5;
// ceilings 170/22. No Jole credential, no Jole lifecycle row.
const SCALELAB_ENV = Object.freeze({
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_GLOBAL_DAILY_CEILING: '170', GMAIL_GLOBAL_PER_RUN_CEILING: '22',
  // Live cold-delivery policy since 2026-10-09: off, every sender in the pool, no holds.
  RECIPIENT_PROVIDER_POLICY: 'off', COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'none',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 30, perRunLimit: 5, staffingOnly: true },
    { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
    { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
  JOLE_LANDING_PAGE_URL: 'https://jolebtx.netlify.app/industrial-staffing/',
  JOLE_BOOKING_LINK: 'https://booking.jolebtx.com/jorge',
  JOLE_COMMERCIAL_MAILING_ADDRESS: '1313 E Alton Gloor, Suite I-2, Brownsville, TX 78526',
});
// Production after the launch-prep deploy and the lifecycle steps: the six
// credentials present and all six marked ready then activated. Jole is NOT
// named in CLIENT_SENDING_AUTHORIZED.
const HELD_ENV = Object.freeze({
  ...SCALELAB_ENV,
  ...Object.fromEntries(SIX.map(([, , tokenEnv]) => [tokenEnv, '{"refresh_token":"r"}'])),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(SIX_IDS.map(id => ({ id, status: 'active' }))),
});
// Tomorrow: the single launch action.
const LAUNCH_ENV = Object.freeze({ ...HELD_ENV, CLIENT_SENDING_AUTHORIZED: 'jole' });
// A send-authorized worker process (the switches every send path checks first).
const WORKER = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'production', RAILWAY_ENVIRONMENT: 'production',
  SEND_AUTHORIZED_TOKEN: 'test-token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
});

// Hiring evidence verified recently, so the fixture never ages past the
// campaign's 45-day window.
const VERIFIED = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
const research = n => ({
  first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'owner/executive',
  company_domain: `gulffab${n}.com`, contact_city: 'Houston', contact_state: 'TX', sector: 'Industrial fabrication / machinery',
  priority_tier: 'Tier A', site_tie: 'EXACT', email_domain_catch_all: 'N', email_status: 'verified',
  hiring_site: 'Houston, TX', verified_role: 'Tig Welder - 2nd Shift', posting_date: VERIFIED,
  hiring_evidence_url: `https://example.org/jobs/${n}`, relevant_roles_30d: '3', core_trade_roles_30d: '2',
  why_contact_is_relevant: 'Plant manager; posted Tig Welder at Houston, TX.', verified_at: VERIFIED,
});
const joleLead = (n = 1, extra = {}) => ({
  id: `JL${n}`, company: `Gulf Fabrication ${n}`, contactName: 'Pat Rivera', email: `pat@gulffab${n}.com`, city: 'Houston, TX',
  stage: 'Import', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: TEMPLATE, intendedCampaignVersion: CAMPAIGN, campaign: CAMPAIGN, routingRequired: 'true',
  senderInboxId: '', clientId: 'jole', sheetRow: 10000 + n, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow(research(n)) })),
  ...extra,
});
let staffingSeq = 0;
const staffingLead = (senderInboxId = 'primary', extra = {}) => {
  staffingSeq += 1;
  return { id: `S${staffingSeq}`, company: `Staffing Co ${staffingSeq}`, contactName: 'Alex', email: `s${staffingSeq}@staffco${staffingSeq}.com`,
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name,
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
    siteContext: 'Your warehouse staffing team serves local manufacturers.',
    senderInboxId, routingRequired: 'true', sheetRow: staffingSeq, revision: 1, ...extra };
};

const senderOf = (env, id) => configuredSenders(env).find(sender => sender.id === id);
const isScaleLab = sender => (sender.clientId || 'scalelab') === 'scalelab';
// The queue route's inbox list (server.js gmailInboxOptions), from the same senders.
const inboxOptions = env => configuredSenders(env).map(sender => ({
  id: sender.id, email: sender.email, status: sender.status, clientId: sender.clientId || 'scalelab',
  staffingOnly: Boolean(sender.staffingOnly),
  ...(sender.allowedCampaignIds ? { allowedCampaignIds: [...sender.allowedCampaignIds] } : {}),
  ...(sender.preparationBlockers ? { preparationReady: sender.preparationReady === true } : {}),
  sendEligible: sender.sendEligible, deliveryImplemented: true,
}));
const HEALTHY = Object.freeze({ health: 'healthy', cursorState: 'present' });
const AUTHENTICATED = Object.freeze({ authenticated: true, identityVerified: true });

function spyStore() {
  const calls = [];
  const store = createMemorySendReservationStore();
  const spy = new Proxy(store, { get: (target, key) => (typeof target[key] === 'function'
    ? (...args) => { calls.push(key); return target[key](...args); } : target[key]) });
  return { spy, calls, store };
}

async function provider({ lead, sender, env, actionId = `cold:${lead.id}:1` }) {
  let gmailCalls = 0;
  try {
    await withGmailProviderSend({ lead, sender, env, sendAction: { actionId, leadId: lead.id }, run: async () => { gmailCalls += 1; return { id: 'g' }; } });
    return { gmailCalls, code: 'sent' };
  } catch (error) { return { gmailCalls, code: error.code || error.message }; }
}

// The queue route (server.js POST /api/coldemail/queue) with 'auto'
// assignment, against in-memory canonical state.
async function queueJole(state, ids, env) {
  const patches = [];
  const result = await queueSelectedLeads({ ids, senderInboxId: AUTO_SENDER, emailTemplateId: TEMPLATE, campaignVersionId: CAMPAIGN }, {
    // Production passes no env, so the copy renders from process.env; here the
    // production-equivalent env stands in for it.
    loadState: async () => ({ ...state, env, lockedLeadIds: new Set() }),
    assignSenders: (batch, loaded) => assignBatch({ batch, input: { ...loaded, senders: configuredSenders(env),
      lockedLeadIds: loaded.lockedLeadIds, horizon: Date.now() + DAY, env, renderOptions: { env } } }),
    validateSelection: (lead, leadSender) => {
      const route = validateRoute({ niche: lead.leadNiche, senderInboxId: leadSender, emailTemplateId: TEMPLATE,
        inboxes: inboxOptions(env), lead, campaignVersionId: CAMPAIGN, preparation: true });
      if (!route.ok) return route;
      return validateCampaignVersionRoute({ niche: lead.leadNiche, emailTemplateId: TEMPLATE, campaignVersionId: CAMPAIGN });
    },
    applyChanges: async changes => changes.map(({ lead, patch }) => {
      patches.push({ leadId: lead.id, patch });
      Object.assign(state.leads.find(item => item.id === lead.id), patch, { revision: lead.revision + 1 });
      return { leadId: lead.id, status: 'succeeded' };
    }),
    appendActivities: async () => {},
  });
  return { result, patches };
}

const tally = leads => leads.reduce((acc, lead) => ({ ...acc, [lead.senderInboxId]: (acc[lead.senderInboxId] || 0) + 1 }), {});

// ── Requirement 11: the paused ready state, then the one launch action ──────

test('paused ready state: active 20/2, credential, observer healthy, queued + assigned, valid campaign, NOT authorized → not send eligible, send blocked, no reservation, Gmail never called', async t => {
  const { spy, calls } = spyStore();
  setSendReservationStoreForTests(spy);
  t.after(() => setSendReservationStoreForTests(null));
  const env = { ...HELD_ENV, ...WORKER };

  const senders = configuredSenders(env);
  const sender = senders.find(item => item.id === 'jole_team_jorge');
  assert.deepEqual({ status: sender.status, dailyLimit: sender.dailyLimit, perRunLimit: sender.perRunLimit,
    credentialConfigured: sender.credentialConfigured, preparationReady: sender.preparationReady,
    clientAuthorized: sender.clientAuthorized, sendEligible: sender.sendEligible },
  { status: 'active', dailyLimit: 20, perRunLimit: 2, credentialConfigured: true, preparationReady: true,
    clientAuthorized: false, sendEligible: false });
  // Observer healthy and mailbox verified: nothing blocks the inbox's lifecycle.
  assert.deepEqual(activationBlockers(sender, { auth: AUTHENTICATED, observer: HEALTHY, senders, env }), []);
  // Client active, reviewed key on, final switch off.
  assert.deepEqual(clientSendState('jole', env).launchHold, true);
  assert.equal(clientPreparationBlock('jole'), null);
  assert.equal(clientSendBlock('jole', env).code, 'client_sending_disabled');

  const lead = joleLead(1, { stage: 'Queued', senderInboxId: 'jole_team_jorge' });
  // Valid campaign and route: ready for launch, held only by authorization.
  assert.equal(validateCampaignVersionRoute({ niche: lead.leadNiche, emailTemplateId: TEMPLATE, campaignVersionId: CAMPAIGN }).ok, true);
  assert.equal(routedLeadReady(lead, env, { preparation: true }).ok, true);
  assert.equal(routedLeadReady(lead, env).code, 'client_sending_disabled', 'the send selector holds it');

  // Every send-side judgment refuses.
  assert.equal(allowedForLead(sender, lead), false);
  assert.throws(() => chooseSender({ lead, senders, sendsToday: new Map() }), /not delivery eligible/);
  const gate = await guardProviderSend(lead, { env, senders,
    loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }),
    loadClientSuppression: async () => ({ available: true, entries: [] }),
  }, { purpose: 'cold', senderInboxId: sender.id });
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'client_sending_disabled');
  const verdict = await provider({ lead, sender, env });
  assert.deepEqual(verdict, { gmailCalls: 0, code: 'client_sending_disabled' });
  assert.deepEqual(calls, [], 'no reservation was read or written');
});

test('the same lead and inbox become send-authorizable when CLIENT_SENDING_AUTHORIZED=jole, and nothing else changes', async t => {
  const { spy, calls } = spyStore();
  setSendReservationStoreForTests(spy);
  t.after(() => setSendReservationStoreForTests(null));
  const env = { ...LAUNCH_ENV, ...WORKER };

  const senders = configuredSenders(env);
  const sender = senders.find(item => item.id === 'jole_team_jorge');
  assert.deepEqual([sender.status, sender.dailyLimit, sender.perRunLimit, sender.clientAuthorized, sender.sendEligible],
    ['active', 20, 2, true, true]);
  const lead = joleLead(1, { stage: 'Queued', senderInboxId: 'jole_team_jorge' });
  assert.equal(routedLeadReady(lead, env).ok, true);
  assert.equal(chooseSender({ lead, senders, sendsToday: new Map() }).sender.id, 'jole_team_jorge');
  const gate = await guardProviderSend(lead, { env, senders,
    loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }),
    loadClientSuppression: async () => ({ available: true, entries: [] }),
  }, { purpose: 'cold', senderInboxId: sender.id });
  assert.equal(gate.allowed, true, gate.reason);
  // The provider boundary admits it (the spy stands in for Gmail) and the
  // durable reservation is taken only now, at send time.
  const verdict = await provider({ lead, sender, env });
  assert.deepEqual(verdict, { gmailCalls: 1, code: 'sent' });
  assert.ok(calls.includes('reserveOutboundAction'));
  // The one difference between the two states is that env value.
  const diff = Object.keys(LAUNCH_ENV).filter(key => LAUNCH_ENV[key] !== HELD_ENV[key]);
  assert.deepEqual(diff, ['CLIENT_SENDING_AUTHORIZED']);
});

// ── Requirement 3: sendEligible keeps its meaning ────────────────────────────

test('all six: status active, credential, capacity configured, prepared — clientAuthorized false and sendEligible false', () => {
  const six = configuredSenders(HELD_ENV).filter(sender => sender.clientId === 'jole');
  assert.deepEqual(six.map(sender => sender.id), SIX_IDS);
  for (const sender of six) {
    assert.deepEqual({ status: sender.status, credentialConfigured: sender.credentialConfigured,
      capacity: [sender.dailyLimit, sender.perRunLimit], preparationReady: sender.preparationReady,
      clientAuthorized: sender.clientAuthorized, sendEligible: sender.sendEligible },
    { status: 'active', credentialConfigured: true, capacity: [20, 2], preparationReady: true,
      clientAuthorized: false, sendEligible: false }, sender.id);
    assert.match(sender.policyBlockers.join(' '), /client sending is not authorized/);
    assert.deepEqual([...sender.preparationBlockers], []);
    assert.equal(sender.email.endsWith('@jolebtx.com'), false, 'the protected corporate domain never sends');
  }
  // Activation reports the same truth: active, not eligible.
  const activated = activateSender({ ...six[0], status: 'ready' }, { auth: AUTHENTICATED, observer: HEALTHY, senders: six, env: HELD_ENV });
  assert.deepEqual([activated.status, activated.sendEligible], ['active', false]);
  assert.equal(activateSender({ ...six[0], status: 'ready', policyBlockers: [] }, { auth: AUTHENTICATED, observer: HEALTHY, senders: six, env: LAUNCH_ENV }).sendEligible, true);
});

test('an unhealthy observer or missing cursor still blocks activation; preparation is not a bypass', () => {
  const senders = configuredSenders(HELD_ENV);
  const sender = { ...senders.find(item => item.id === 'jole_group_jorge'), status: 'ready' };
  assert.ok(activationBlockers(sender, { auth: AUTHENTICATED, observer: { health: 'stale', cursorState: 'present' }, senders, env: HELD_ENV })
    .includes('gmail observer unhealthy'));
  assert.ok(activationBlockers(sender, { auth: AUTHENTICATED, observer: { health: 'healthy', cursorState: 'missing' }, senders, env: HELD_ENV })
    .includes('history cursor missing'));
  assert.ok(activationBlockers(sender, { auth: { authenticated: true, identityVerified: false }, observer: HEALTHY, senders, env: HELD_ENV })
    .includes('gmail auth unhealthy'));
});

// ── Requirement 4 and 8: queueing assigns and balances, never reserves ──────

test('queueing 670 leads in canonical batches assigns 111–112 per inbox, writes only routing fields, and creates no reservation', async t => {
  const { spy, calls } = spyStore();
  setSendReservationStoreForTests(spy);
  t.after(() => setSendReservationStoreForTests(null));
  const leads = Array.from({ length: 670 }, (_, i) => joleLead(i + 1));
  const ids = leads.map(lead => lead.id);
  const state = { leads, activities: [], boardLeads: [], suppressedEmails: new Set() };

  const first = await queueJole(state, ids.slice(0, 500), HELD_ENV);
  assert.equal(first.result.queued, 500, first.result.error);
  const second = await queueJole(state, ids.slice(500), HELD_ENV);
  assert.equal(second.result.queued, 170, second.result.error);

  const counts = tally(leads);
  assert.deepEqual(Object.keys(counts).sort(), [...SIX_IDS].sort());
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 670);
  assert.ok(Object.values(counts).every(n => n === 111 || n === 112), JSON.stringify(counts));
  assert.deepEqual(Object.values(counts).sort(), [111, 111, 112, 112, 112, 112]);
  // Only routing fields; no send state, thread, step or timestamp.
  const keys = new Set([...first.patches, ...second.patches].flatMap(item => Object.keys(item.patch)));
  assert.deepEqual([...keys].sort(), ['emailTemplateId', 'intendedCampaignVersion', 'routingRequired', 'senderInboxId', 'stage']);
  for (const lead of leads) {
    assert.deepEqual([lead.stage, lead.emailStatus, lead.emailStep, lead.lastEmailedAt], ['Queued', '', '', '']);
    assert.equal(lead.threadId, undefined);
    assert.equal(lead.clientId, 'jole');
  }
  assert.deepEqual(calls, [], 'queueing never touches the reservation store');
  // Re-queueing is a no-op: no duplicate assignment, no move.
  const again = await queueJole(state, ids.slice(0, 10), HELD_ENV);
  assert.equal(again.result.alreadyQueued, 10);
  assert.equal(again.patches.length, 0);
});

test('balancing is preparation-only: queued Jole leads are movable for the refill but held for the send selector', () => {
  const leads = SIX_IDS.flatMap((id, s) => Array.from({ length: 3 }, (_, i) => joleLead(s * 10 + i + 1, { stage: 'Queued', senderInboxId: id })));
  const plan = planSenderRebalance({ leads, activities: [], boardLeads: [], suppressedEmails: new Set(), lockedLeadIds: new Set(),
    senders: configuredSenders(HELD_ENV), horizon: Date.now() + DAY, env: HELD_ENV, renderOptions: { env: HELD_ENV } });
  const jole = plan.before.filter(row => SIX_IDS.includes(row.id));
  assert.deepEqual(jole.map(row => row.firstTouch), [3, 3, 3, 3, 3, 3], 'each inbox counts its own queued leads');
  assert.equal(plan.moves.length, 0, 'balanced Jole supply is not reshuffled');
  for (const lead of leads) assert.equal(routedLeadReady(lead, HELD_ENV).code, 'client_sending_disabled');
});

test('the 19 review leads, suppressed and held leads are never queued or assigned', async () => {
  const review = joleLead(901, { campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole',
    profile: profileFromResearchRow({ ...research(901), verified_role: 'Helper' }) })) });
  const suppressed = joleLead(902);
  for (const [lead, suppressedEmails, pattern] of [
    [review, new Set(), /personalization needs review/],
    [suppressed, new Set([suppressed.email]), /suppress/i],
  ]) {
    const state = { leads: [lead], activities: [], boardLeads: [], suppressedEmails };
    const { result, patches } = await queueJole(state, [lead.id], HELD_ENV);
    assert.equal(result.status, 409, lead.id);
    assert.match(result.error, pattern);
    assert.equal(patches.length, 0);
    assert.equal(lead.senderInboxId, '');
    assert.equal(lead.stage, 'Import');
  }
});

test('assignment never crosses clients: a Jole lead gets only a Jole inbox, a ScaleLab lead only a ScaleLab inbox', () => {
  const senders = configuredSenders(HELD_ENV);
  const jole = assignNewLeads({ batch: Array.from({ length: 30 }, (_, i) => joleLead(i + 1)), senders });
  assert.equal(jole.refused.length, 0);
  assert.ok([...jole.assignments.values()].every(id => SIX_IDS.includes(id)));
  const staffing = assignNewLeads({ batch: Array.from({ length: 30 }, () => staffingLead('')), senders });
  assert.ok([...staffing.assignments.values()].every(id => SCALELAB_IDS.includes(id)));
  // Without prepared Jole inboxes a Jole lead fails closed rather than borrowing ScaleLab's.
  const none = assignNewLeads({ batch: [joleLead(1)], senders: senders.filter(isScaleLab) });
  assert.deepEqual([none.assignments.size, none.refused.length], [0, 1]);
});

// ── Requirement 5: every real send path rechecks client authorization ───────

test('every send purpose (initial, follow-up/sequence, warm reply, resumed OOO) is refused at the fresh gate while Jole is held', async () => {
  const env = { ...HELD_ENV, ...WORKER };
  const senders = configuredSenders(env);
  const deps = current => ({ env, senders,
    loadFreshState: async () => ({ current, suppressedEmails: new Set() }),
    loadClientSuppression: async () => ({ available: true, entries: [] }) });
  const queued = joleLead(1, { stage: 'Queued', senderInboxId: 'jole_team_jorge' });
  const contacted = joleLead(2, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', senderInboxId: 'jole_team_jorge',
    lastEmailedAt: new Date(Date.now() - 5 * DAY).toISOString() });
  const replied = joleLead(3, { stage: 'Replied', emailStatus: 'replied', emailStep: '1', senderInboxId: 'jole_team_jorge' });
  for (const [lead, purpose] of [[queued, 'cold'], [contacted, 'sequence'], [replied, 'warm'], [contacted, 'warm']]) {
    const verdict = await guardProviderSend(lead, deps(lead), { purpose, senderInboxId: 'jole_team_jorge' });
    assert.equal(verdict.code, 'client_sending_disabled', `${lead.id} ${purpose}`);
  }
});

test('the provider boundary refuses every Jole action kind before any reservation, for all six inboxes', async t => {
  const { spy, calls } = spyStore();
  setSendReservationStoreForTests(spy);
  t.after(() => setSendReservationStoreForTests(null));
  const env = { ...HELD_ENV, SEND_LOCK_ENABLED: 'true' };
  const lead = joleLead(1, { stage: 'Queued' });
  for (const id of SIX_IDS) {
    // As configured, and even if some path handed over an inbox marked eligible.
    for (const sender of [senderOf(env, id), { ...senderOf(env, id), sendEligible: true, policyBlockers: [] }]) {
      for (const actionId of [`cold:${lead.id}:1`, `followup:${lead.id}:2`, `followup:${lead.id}:3`, `reply:${lead.id}:x`, `manual:${lead.id}:y`, `ooo-resume:${lead.id}:2`, `retry:${lead.id}:1`]) {
        const verdict = await provider({ lead: { ...lead, senderInboxId: id }, sender, env, actionId });
        assert.deepEqual(verdict, { gmailCalls: 0, code: 'client_sending_disabled' }, `${id} ${actionId}`);
      }
    }
  }
  // No sender at all (a path that forgot to pass one) is refused too.
  assert.deepEqual(await provider({ lead, sender: null, env }), { gmailCalls: 0, code: 'client_sending_disabled' });
  assert.deepEqual(calls, []);
});

test('source: one Gmail send call in production code, behind sendEmail → withGmailProviderSend; the agent selects with the strict gate', () => {
  const files = ['server.js', 'outreach-agent.js', ...fs.readdirSync(path.join(ROOT, 'integrations'), { recursive: true })
    .filter(name => String(name).endsWith('.js')).map(name => path.join('integrations', String(name)))];
  const sendSites = files.flatMap(file => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return (source.match(/\.messages\.send\(|\.drafts\.send\(/g) || []).map(() => file);
  });
  assert.deepEqual(sendSites, ['outreach-agent.js']);
  const agent = fs.readFileSync(path.join(ROOT, 'outreach-agent.js'), 'utf8');
  const sendEmail = agent.slice(agent.indexOf('async function sendEmail('), agent.indexOf('async function loadOutreachProviderState('));
  assert.match(sendEmail, /if \(!sender\?\.sendEligible\) throw/);
  assert.match(sendEmail, /return withGmailProviderSend\(\{/);
  assert.ok(sendEmail.indexOf('withGmailProviderSend') < sendEmail.indexOf('.messages.send('));
  // The agent never asks for preparation readiness: selection and sending are strict.
  assert.equal(/preparation\s*:\s*true/.test(agent), false);
  const selectQueued = agent.slice(agent.indexOf('function selectQueued('), agent.indexOf('function routedLeadCanUseCurrentSender('));
  assert.match(selectQueued, /const routing = routedLeadReady\(l\);/);
  assert.match(selectQueued, /\[client-hold\]/);
  // Smartlead enqueue (agent and route) passes the fresh gate before reserving.
  const enqueue = agent.slice(agent.indexOf('async function enqueueSmartleadLead('));
  assert.ok(enqueue.indexOf('guardProviderSend(') > 0 && enqueue.indexOf('guardProviderSend(') < enqueue.indexOf('withOutboundReservation('));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf('const safety = await guardProviderSend(found.lead'));
  assert.ok(route.indexOf('withOutboundReservation(') > 0, 'the Smartlead route reserves only after its gate');
});

test('source: preparation readiness is requested only by queueing and balancing', () => {
  const files = ['server.js', 'outreach-agent.js', ...fs.readdirSync(path.join(ROOT, 'integrations'), { recursive: true })
    .filter(name => String(name).endsWith('.js')).map(name => path.join('integrations', String(name)).replace(/\\/g, '/'))];
  const users = files.filter(file => /preparation\s*:\s*true/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  // reporting.js: a read-only "prepared for launch" count on the client overview.
  assert.deepEqual(users.sort(), ['integrations/clients/reporting.js', 'integrations/sender-balance.js', 'server.js']);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.equal((server.match(/preparation\s*:\s*true/g) || []).length, 1, 'the queue route only');
});

// ── Requirement 6: client-aware capacity ─────────────────────────────────────

test('capacity while held: ScaleLab 170/22, Jole 0/0, physical 170/22 — exactly today\'s numbers', () => {
  const capacity = capacityFromEnv(configuredSenders(HELD_ENV), HELD_ENV);
  assert.deepEqual(capacity.clientLimits, { scalelab: { daily: 170, perRun: 22 }, jole: { daily: 0, perRun: 0 } });
  assert.deepEqual([capacity.globalDailyLimit, capacity.globalPerRunLimit], [170, 22]);
  // Identical to ScaleLab alone.
  const before = capacityFromEnv(configuredSenders(SCALELAB_ENV), SCALELAB_ENV);
  assert.deepEqual([before.globalDailyLimit, before.globalPerRunLimit, before.activeIds], [170, 22, capacity.activeIds]);
  // The client layer gives Jole nothing while it is not authorized.
  const state = createClientCapacityState({ globalDailyLimit: 170, globalWindowLimit: 22, env: HELD_ENV,
    configs: new Map(Object.entries(capacity.clientLimits).map(([id, l]) => [id, { dailyCap: l.daily, windowCap: l.perRun }])) });
  assert.deepEqual([clientCapacityVerdict(state, 'jole').allowed, clientCapacityVerdict(state, 'jole').remaining], [false, 0]);
  assert.equal(clientCapacityVerdict(state, 'scalelab').remaining, 22);
});

test('capacity at launch: ScaleLab 170/22 + Jole 120/12 = physical 290/34, each client capped independently', () => {
  const capacity = capacityFromEnv(configuredSenders(LAUNCH_ENV), LAUNCH_ENV);
  // 6 inboxes × 20/day = 120 = Jole's cap; 6 × 2/window = 12 = Jole's window cap.
  assert.deepEqual(capacity.clientLimits, { scalelab: { daily: 170, perRun: 22 }, jole: { daily: 120, perRun: 12 } });
  assert.deepEqual([capacity.globalDailyLimit, capacity.globalPerRunLimit], [290, 34]);
  const configs = new Map(Object.entries(capacity.clientLimits).map(([id, l]) => [id, { dailyCap: l.daily, windowCap: l.perRun }]));

  // ScaleLab spends its whole window: 22, never one of Jole's 12.
  const window = createClientCapacityState({ globalDailyLimit: 290, globalWindowLimit: 34, env: LAUNCH_ENV, configs });
  for (let i = 0; i < 22; i += 1) consumeClientCapacity(window, 'scalelab');
  assert.equal(clientCapacityVerdict(window, 'scalelab').code, 'client_window_cap');
  assert.equal(clientCapacityVerdict(window, 'jole').remaining, 12);
  // Jole spends its 12 and stops; together they fill the 34 physical slots exactly.
  for (let i = 0; i < 12; i += 1) consumeClientCapacity(window, 'jole');
  assert.equal(clientCapacityVerdict(window, 'jole').allowed, false);
  assert.equal(window.windowTotal, 34);
  // And Jole alone can never take more than 12 of a window, nor ScaleLab's share.
  const joleOnly = createClientCapacityState({ globalDailyLimit: 290, globalWindowLimit: 34, env: LAUNCH_ENV, configs });
  for (let i = 0; i < 12; i += 1) consumeClientCapacity(joleOnly, 'jole');
  assert.equal(clientCapacityVerdict(joleOnly, 'jole').code, 'client_window_cap');
  assert.equal(clientCapacityVerdict(joleOnly, 'scalelab').remaining, 22);

  // Daily: ScaleLab at 170 stops while Jole keeps all 120 ...
  const scalelabDone = createClientCapacityState({ globalDailyLimit: 290, globalWindowLimit: 34, env: LAUNCH_ENV, configs,
    sentTodayByClient: new Map([['scalelab', 170]]) });
  assert.equal(clientCapacityVerdict(scalelabDone, 'scalelab').code, 'client_daily_cap');
  assert.equal(clientCapacityVerdict(scalelabDone, 'jole').allowed, true);
  // ... and Jole at 120 stops while ScaleLab keeps its window.
  const joleDone = createClientCapacityState({ globalDailyLimit: 290, globalWindowLimit: 34, env: LAUNCH_ENV, configs,
    sentTodayByClient: new Map([['jole', 119]]) });
  assert.equal(clientCapacityVerdict(joleDone, 'jole').remaining, 1);
  consumeClientCapacity(joleDone, 'jole');
  assert.equal(clientCapacityVerdict(joleDone, 'jole').code, 'client_daily_cap');
  assert.equal(clientCapacityVerdict(joleDone, 'scalelab').allowed, true);
});

// ── Requirement 7: ScaleLab unchanged ────────────────────────────────────────

test('ScaleLab roster is byte-identical with Jole prepared or launched', () => {
  const view = env => configuredSenders(env).filter(isScaleLab);
  const before = JSON.stringify(view(SCALELAB_ENV));
  assert.equal(JSON.stringify(view(HELD_ENV)), before);
  assert.equal(JSON.stringify(view(LAUNCH_ENV)), before);
  assert.deepEqual(view(HELD_ENV).map(s => [s.id, s.status, s.dailyLimit, s.perRunLimit, s.sendEligible]), [
    ['primary', 'active', 50, 6, true], ['tryscalelabai', 'active', 30, 6, true], ['scalelabaiteam', 'paused', 30, 5, false],
    ['deniels', 'active', 45, 5, true], ['deniels_tryscalelabai', 'active', 45, 5, true],
  ]);
  for (const sender of view(HELD_ENV)) {
    assert.equal('preparationReady' in sender, false, `${sender.id} carries no new field`);
    assert.equal('clientAuthorized' in sender, false);
  }
});

test('ScaleLab assignment and refill are identical with the six prepared Jole inboxes present', () => {
  const env = { ...HELD_ENV, STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' };
  const all = configuredSenders(env);
  const scalelabOnly = all.filter(isScaleLab);
  staffingSeq = 0;
  const batch = Array.from({ length: 60 }, () => staffingLead(''));
  const withJole = assignNewLeads({ batch, senders: all });
  const without = assignNewLeads({ batch, senders: scalelabOnly });
  assert.deepEqual([...withJole.assignments], [...without.assignments]);
  assert.deepEqual(withJole.refused, without.refused);

  const queued = [...Array.from({ length: 120 }, () => staffingLead('primary')),
    ...SIX_IDS.flatMap((id, s) => Array.from({ length: 30 }, (_, i) => joleLead(s * 100 + i + 1, { stage: 'Queued', senderInboxId: id })))];
  const input = senders => ({ leads: queued, activities: [], boardLeads: [], suppressedEmails: new Set(), lockedLeadIds: new Set(),
    senders, horizon: Date.now() + DAY, env, renderOptions: { ...STAFFING_RENDER_OPTIONS, env } });
  const planWith = planSenderRebalance(input(all));
  const planWithout = planSenderRebalance(input(scalelabOnly));
  const strip = moves => moves.map(({ leadId, from, to }) => ({ leadId, from, to }));
  assert.ok(planWithout.moves.length > 0, 'the fixture exercises real ScaleLab moves');
  assert.deepEqual(strip(planWith.moves), strip(planWithout.moves));
  assert.ok(planWith.moves.every(move => SCALELAB_IDS.includes(move.to)), 'no lead moves to or between Jole inboxes here');
  assert.deepEqual(planWith.after.filter(row => SCALELAB_IDS.includes(row.id)), planWithout.after);
});

// ── Requirement 11 (final): a normal scheduler run in the paused state ──────
//
// outreach-agent.js runs on load and exports nothing, so this test executes
// the agent's REAL selectQueued() source in a sandbox, then drives the step-1
// pipeline through the same modules in the order the agent calls them. The
// source assertions below pin that order in the agent itself.

const vm = require('node:vm');
const { classify } = require('../check-leads');
const { tenantOf } = require('../integrations/clients/email-scope');
const { resolveLeadClient } = require('../integrations/clients/ownership');
const { recordClientSend } = require('../integrations/clients/capacity');
const { DEFAULT_CLIENT_ID } = require('../integrations/clients/registry');

const AGENT = fs.readFileSync(path.join(ROOT, 'outreach-agent.js'), 'utf8');
const agentSlice = (from, to) => {
  const start = AGENT.indexOf(from);
  const end = AGENT.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `agent source has ${from}`);
  return AGENT.slice(start, end);
};
const RUN_ENV = Object.freeze({ ...HELD_ENV, ...WORKER, STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' });

async function withProcessEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const authorized = process.env.CLIENT_SENDING_AUTHORIZED;
  if (!('CLIENT_SENDING_AUTHORIZED' in env)) delete process.env.CLIENT_SENDING_AUTHORIZED;
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (authorized === undefined) delete process.env.CLIENT_SENDING_AUTHORIZED; else process.env.CLIENT_SENDING_AUTHORIZED = authorized;
  }
}

// One scheduled step-1 pass. `stopAtProvider` records "would send" instead
// of calling even the Gmail spy (used for the authorized comparison).
async function schedulerRun(leads, env, { stopAtProvider = false } = {}) {
  const reserved = [];
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(new Proxy(store, { get: (target, key) => (typeof target[key] === 'function'
    ? (...args) => { reserved.push([key, args[0]?.leadId || args[0]]); return target[key](...args); } : target[key]) }));
  const gmail = [];
  const logs = [];
  try {
    return await withProcessEnv(env, async () => {
      const capture = (...args) => logs.push(args.join(' '));
      const sandbox = {
        QUEUE_STAGE: 'Queued', routedLeadReady, tenantOf, DEFAULT_CLIENT_ID, SUPPRESSED_EMAILS: new Set(),
        normEmail: e => (e || '').toLowerCase().trim(), classifyLeadEmail: classify,
        console: { log: capture, warn: capture, error: capture },
      };
      const code = `${agentSlice('function isValidEmail(', '\n}\n')}\n}\n`
        + `${agentSlice('function selectQueued(', 'function routedLeadCanUseCurrentSender(')}\n({ selectQueued });`;
      const { selectQueued } = vm.runInNewContext(code, sandbox);
      const queued = selectQueued(leads);

      const senders = configuredSenders(env);
      const capacity = capacityFromEnv(senders, env);
      const clientCapacity = createClientCapacityState({
        globalDailyLimit: capacity.globalDailyLimit, globalWindowLimit: capacity.globalPerRunLimit, env,
        configs: new Map(Object.entries(capacity.clientLimits).map(([id, l]) => [id, { dailyCap: l.daily, windowCap: l.perRun }])),
      });
      const outcomes = {};
      for (const lead of queued) {
        const clientCap = clientCapacityVerdict(clientCapacity, tenantOf(lead));
        if (!clientCap.allowed) { outcomes[lead.id] = `client_capacity:${clientCap.code}`; continue; }
        let choice;
        try { choice = chooseSender({ lead, activities: [], senders, sendsToday: new Map(), step: 1 }); }
        catch (error) { outcomes[lead.id] = 'sender_refused'; continue; }
        if (!choice.sender) { outcomes[lead.id] = 'sender_deferred'; continue; }
        // deliverOrdinaryColdStep: client authority, then the fresh gate, then sendEmail.
        const owner = resolveLeadClient(lead);
        const blocked = owner.ok ? clientSendBlock(owner.clientId, env) : null;
        if (blocked) { outcomes[lead.id] = `client_authority:${blocked.code}`; continue; }
        const gate = await guardProviderSend(lead, { env, senders,
          loadFreshState: async () => ({ current: lead, suppressedEmails: new Set() }),
          loadClientSuppression: async () => ({ available: true, entries: [] }),
        }, { purpose: 'cold', senderInboxId: choice.sender.id, coldSender: choice.sender });
        if (!gate.allowed) { outcomes[lead.id] = `gate:${gate.code}`; continue; }
        // Stopped before the provider, but counted as a success so the client caps bind.
        if (stopAtProvider) { recordClientSend(clientCapacity, tenantOf(lead)); outcomes[lead.id] = `would_send:${choice.sender.id}`; continue; }
        if (!choice.sender.sendEligible) { outcomes[lead.id] = 'sender_not_eligible'; continue; }
        await withGmailProviderSend({ lead, sender: choice.sender, env, sendAction: { actionId: `cold:${lead.id}:1`, leadId: lead.id },
          run: async () => { gmail.push([lead.id, choice.sender.id]); return { id: `g-${lead.id}` }; } });
        recordClientSend(clientCapacity, tenantOf(lead));
        outcomes[lead.id] = `sent:${choice.sender.id}`;
      }
      return { queued: queued.map(lead => lead.id), outcomes, gmail, logs, reserved };
    });
  } finally { setSendReservationStoreForTests(null); }
}

test('scheduler run while held: Jole leads held as a group, no reservation, no Gmail call; ScaleLab sends exactly as it would alone', async () => {
  staffingSeq = 0;
  const scalelab = [staffingLead('primary'), staffingLead('deniels'), staffingLead('tryscalelabai')];
  const jole = SIX_IDS.flatMap((id, s) => [1, 2].map(i => joleLead(s * 10 + i, { stage: 'Queued', senderInboxId: id })));
  const joleIds = new Set(jole.map(lead => lead.id));

  const held = await schedulerRun([...scalelab, ...jole], RUN_ENV);
  // Selection holds every Jole lead, logged once as a group.
  assert.deepEqual(held.queued, scalelab.map(lead => lead.id));
  assert.ok(held.logs.includes('[client-hold] 12 queued jole lead(s) held: client sending is not authorized (CLIENT_SENDING_AUTHORIZED)'), held.logs.join('\n'));
  assert.equal(held.logs.some(line => /gulffab/.test(line)), false, 'no per-lead Jole warnings');
  // No reservation and no Gmail call for any Jole lead.
  assert.equal(held.reserved.some(([, leadId]) => joleIds.has(leadId)), false);
  assert.equal(held.gmail.some(([leadId]) => joleIds.has(leadId)), false);
  // ScaleLab: every lead delivered through its assigned inbox.
  assert.deepEqual(held.outcomes, Object.fromEntries(scalelab.map(lead => [lead.id, `sent:${lead.senderInboxId}`])));
  assert.deepEqual(held.gmail, scalelab.map(lead => [lead.id, lead.senderInboxId]));

  // Identical to a run with no Jole leads at all.
  const alone = await schedulerRun(scalelab.map(lead => ({ ...lead })), RUN_ENV);
  assert.deepEqual([alone.queued, alone.outcomes, alone.gmail], [held.queued, held.outcomes, held.gmail]);
  assert.deepEqual(alone.reserved, held.reserved);
});

test('scheduler run while held: a Jole lead that bypassed selection is still refused before any reservation or Gmail call', async () => {
  const lead = joleLead(1, { stage: 'Queued', senderInboxId: 'jole_team_jorge' });
  const result = await withProcessEnv(RUN_ENV, async () => {
    const senders = configuredSenders(RUN_ENV);
    const capacity = capacityFromEnv(senders, RUN_ENV);
    const state = createClientCapacityState({ globalDailyLimit: capacity.globalDailyLimit, globalWindowLimit: capacity.globalPerRunLimit, env: RUN_ENV,
      configs: new Map(Object.entries(capacity.clientLimits).map(([id, l]) => [id, { dailyCap: l.daily, windowCap: l.perRun }])) });
    return {
      capacity: clientCapacityVerdict(state, 'jole').code,
      sender: (() => { try { chooseSender({ lead, senders, sendsToday: new Map(), step: 1 }); return 'chosen'; } catch (error) { return 'refused'; } })(),
      authority: clientSendBlock(resolveLeadClient(lead).clientId, RUN_ENV).code,
    };
  });
  assert.deepEqual(result, { capacity: 'client_sending_disabled', sender: 'refused', authority: 'client_sending_disabled' });
});

test('scheduler run after CLIENT_SENDING_AUTHORIZED=jole: the same Jole leads pass every gate up to the provider, inside Jole\'s 12/window', async () => {
  staffingSeq = 100;
  const scalelab = [staffingLead('primary'), staffingLead('deniels')];
  const jole = SIX_IDS.flatMap((id, s) => [1, 2, 3].map(i => joleLead(s * 10 + i, { stage: 'Queued', senderInboxId: id })));
  const launched = await schedulerRun([...scalelab, ...jole], { ...RUN_ENV, CLIENT_SENDING_AUTHORIZED: 'jole' }, { stopAtProvider: true });
  assert.equal(launched.queued.length, 2 + 18, 'selection now includes Jole');
  assert.equal(launched.logs.some(line => line.startsWith('[client-hold]')), false);
  for (const lead of scalelab) assert.equal(launched.outcomes[lead.id], `would_send:${lead.senderInboxId}`);
  // 18 queued Jole leads, Jole's window cap is 12: twelve pass, six wait for the next window.
  const joleOutcomes = jole.map(lead => launched.outcomes[lead.id]);
  assert.deepEqual(joleOutcomes.slice(0, 12), jole.slice(0, 12).map(lead => `would_send:${lead.senderInboxId}`));
  assert.deepEqual(joleOutcomes.slice(12), Array(6).fill('client_capacity:client_window_cap'));
  assert.deepEqual([launched.gmail.length, launched.reserved.length], [0, 0], 'stopped before the provider: nothing sent, nothing reserved');
});

test('source: the agent\'s step-1 loop and cold delivery check client authority before sender, reservation and Gmail', () => {
  assert.match(AGENT, /const queued = selectQueued\(all\);/);
  const loop = agentSlice('── New sends (step 1)', '── Follow-up refill');
  const order = ['clientCapacityVerdict(', 'chooseSender(', 'deliverOrdinaryColdStep('].map(token => loop.indexOf(token));
  assert.ok(order.every(index => index > 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
  const deliver = agentSlice('async function deliverOrdinaryColdStep(', 'async function markReplied(');
  const steps = ['clientSendBlock(', 'findSuccessfulSequenceSend(', 'stepOneAlreadySent(', 'recordColdCallActivityStrict(reservation)', 'guardProviderSend(', 'sendEmail({']
    .map(token => deliver.indexOf(token));
  assert.ok(steps.every(index => index > 0), JSON.stringify(steps));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, 'client authority is the first check, before Gmail probes and the ledger reservation');
});
