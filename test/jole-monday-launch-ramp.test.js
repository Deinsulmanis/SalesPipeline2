'use strict';

// Jole Monday launch ramp (2026-10-19). No code change: two existing
// cold-delivery-policy controls carry the whole ramp, and this file pins the
// exact production values so a later edit cannot drift from them.
//
//   COLD_SENDER_HOLDS      the two joleindustrial.com inboxes may never cold-send
//                          (warm-up incomplete). No expiry; lifting it is an
//                          explicit Railway change.
//   COLD_INBOX_DAILY_CAPS  the four warmed inboxes at 15/day; the two held ones
//                          at 0/day, so they add nothing to Jole's allocation.
//
// Result once CLIENT_SENDING_AUTHORIZED=jole: 4 × 15 = 60 Jole cold sends/day,
// beneath the unchanged 20/inbox hard ceiling and the 120/day client cap.
// ScaleLab's roster, caps and holds are untouched. Nothing here can send.

const test = require('node:test');
const assert = require('node:assert/strict');

const { configuredSenders, chooseSender } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { coldSenderVerdict, coldSenderHolds, coldDeliveryVerdict, describeColdDeliveryPolicy } = require('../integrations/cold-delivery-policy');
const { activationBlockers } = require('../integrations/gmail-sender-lifecycle');
const { createClientCapacityState, clientCapacityVerdict, consumeClientCapacity } = require('../integrations/clients/capacity');
const { clientSendBlock } = require('../integrations/clients/send-policy');
const { clientSendWindowVerdict } = require('../integrations/clients/send-windows');
const { getClient } = require('../integrations/clients/registry');
const { renderClientLeadEmail, clientPersonalizationState } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { planSenderRebalance } = require('../integrations/sender-balance');

// The exact Railway values for the launch ramp.
const LAUNCH_HOLDS = 'jole_industrial_jorge:warmup_incomplete,jole_industrial_jguerrero:warmup_incomplete';
const LAUNCH_CAPS = 'jole_group_jorge:15,jole_group_jguerrero:15,jole_team_jorge:15,jole_team_jguerrero:15,'
  + 'jole_industrial_jorge:0,jole_industrial_jguerrero:0';

const READY = ['jole_group_jorge', 'jole_group_jguerrero', 'jole_team_jorge', 'jole_team_jguerrero'];
const INDUSTRIAL = ['jole_industrial_jorge', 'jole_industrial_jguerrero'];
const SIX = [...READY, ...INDUSTRIAL];
const SCALELAB_IDS = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'];
const LANDING = 'https://jolebtx.netlify.app/';
const BOOKING = 'https://calendar.app.google/HfJfGYaL3gEaSg4P8';
const ADDRESS = '2738 Dallas Ave, Ingleside, TX 78362';
const DAY = 24 * 60 * 60 * 1000;

// Production as read from the 2026-10-16 boot log: policy off, pool all, no
// holds, a 50/day global cold ceiling, the six Jole inboxes active on the
// runtime overlay, and Jole not named in CLIENT_SENDING_AUTHORIZED.
const PROD_ENV = Object.freeze({
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_GLOBAL_DAILY_CEILING: '170', GMAIL_GLOBAL_PER_RUN_CEILING: '22',
  RECIPIENT_PROVIDER_POLICY: 'off', COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'none', COLD_INBOX_DAILY_CAP: '50',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 30, perRunLimit: 5, staffingOnly: true },
    { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
    { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
  ...Object.fromEntries(SIX.map(id => [`GMAIL_${id.toUpperCase()}_TOKEN_JSON`, '{"refresh_token":"r"}'])),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(SIX.map(id => ({ id, status: 'active' }))),
  JOLE_LANDING_PAGE_URL: LANDING, JOLE_BOOKING_LINK: BOOKING, JOLE_COMMERCIAL_MAILING_ADDRESS: ADDRESS,
});
// Thursday/Friday/the weekend: ramp configured, final switch still off.
const RAMP_ENV = Object.freeze({ ...PROD_ENV, COLD_SENDER_HOLDS: LAUNCH_HOLDS, COLD_INBOX_DAILY_CAPS: LAUNCH_CAPS });
// Monday before 07:00 Central: the one remaining launch action.
const MONDAY_ENV = Object.freeze({ ...RAMP_ENV, CLIENT_SENDING_AUTHORIZED: 'jole' });

const senderOf = (env, id) => configuredSenders(env).find(sender => sender.id === id);
const scalelabRoster = env => configuredSenders(env).filter(sender => SCALELAB_IDS.includes(sender.id));

// A Jole lead as imported: stored research profile, campaign, template, pinned inbox.
const research = (n, extra = {}) => ({
  first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'Plant / operations / production',
  company_domain: `gulffab${n}.com`, sector: 'Industrial fabrication / machinery', priority_tier: 'Tier A', site_tie: 'EXACT',
  hiring_site: 'Mont Belvieu, TX', verified_role: 'Millwright - Night Shift', posting_date: '2026-10-01',
  hiring_evidence_url: `https://example.org/jobs/${n}`, verified_at: '2026-10-07', ...extra,
});
const joleLead = (n = 1, { senderInboxId = 'jole_group_jorge', profile = {}, ...extra } = {}) => ({
  id: `JL${n}`, company: `Gulf Fabrication ${n}, LLC`, contactName: 'Pat Rivera', email: `pat@gulffab${n}.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', routingRequired: 'true', senderInboxId, clientId: 'jole', sheetRow: 1000 + n, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow(research(n, profile)) })),
  ...extra,
});
// Monday 2026-10-19, an instant inside Jole's 07:00–11:59 Central window.
const MONDAY_0900_CT = Date.parse('2026-10-19T14:00:00.000Z');

test('1. the four warmed Jole inboxes are send eligible on Monday, at 15/day and 2/window', () => {
  for (const id of READY) {
    const sender = senderOf(MONDAY_ENV, id);
    assert.equal(sender.status, 'active');
    assert.equal(sender.sendEligible, true, id);
    assert.equal(sender.dailyLimit, 15, id);
    assert.equal(sender.perRunLimit, 2, id);
    assert.deepEqual(coldSenderVerdict(sender, MONDAY_ENV), { allowed: true, code: '' });
    assert.equal(coldDeliveryVerdict({ sender, classification: { provider: 'MICROSOFT' }, env: MONDAY_ENV }).allowed, true);
  }
});

test('2. the two joleindustrial.com inboxes are cold-held: 0/day, refused at the cold gate and at activation, observers kept', () => {
  for (const id of INDUSTRIAL) {
    const sender = senderOf(MONDAY_ENV, id);
    assert.equal(sender.dailyLimit, 0, id);
    assert.equal(sender.configuredDailyLimit, 20);
    assert.equal(sender.observerEnabled, true, 'the Gmail observer keeps running');
    assert.equal(sender.credentialConfigured, true, 'credentials stay connected');
    const verdict = coldSenderVerdict(sender, MONDAY_ENV);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, 'sender_cold_hold');
    assert.equal(verdict.holdReason, 'warmup_incomplete');
    assert.ok(activationBlockers({ ...sender, status: 'paused' }, {
      auth: { authenticated: true, identityVerified: true }, observer: { health: 'healthy', cursorState: 'present' },
      env: MONDAY_ENV,
    }).includes('sender cold hold: warmup_incomplete'), 'a paused-then-reactivated industrial inbox is still refused');
  }
  // A lead pinned to an industrial inbox stays pinned and is deferred, never re-routed.
  const pinned = joleLead(1, { senderInboxId: 'jole_industrial_jorge' });
  const choice = chooseSender({ lead: pinned, senders: configuredSenders(MONDAY_ENV), sendsToday: new Map(), step: 1 });
  assert.equal(choice.sender, null);
  assert.equal(choice.reason, 'assigned sender daily limit reached');
  // The hold has no date in it and no expiry: the same value holds forever.
  assert.equal(coldSenderHolds(RAMP_ENV).get('jole_industrial_jorge'), 'warmup_incomplete');
  assert.equal(coldSenderHolds(RAMP_ENV).size, 2);
});

test('3. no warmed inbox can take a 16th Jole cold send in a day', () => {
  const senders = configuredSenders(MONDAY_ENV);
  for (const id of READY) {
    const lead = joleLead(2, { senderInboxId: id });
    assert.ok(chooseSender({ lead, senders, sendsToday: new Map([[id, 14]]), step: 1 }).sender, `${id} sends its 15th`);
    const full = chooseSender({ lead, senders, sendsToday: new Map([[id, 15]]), step: 1 });
    assert.equal(full.sender, null, `${id} refuses its 16th`);
    assert.equal(full.reason, 'assigned sender daily limit reached');
    // Follow-ups count against the same daily limit.
    const followUp = chooseSender({ lead: { ...lead, emailStatus: 'emailed', emailStep: '1' }, senders,
      activities: [{ eventType: 'initial_email_sent', sourceLeadId: lead.id, metadata: JSON.stringify({ senderInboxId: id }) }],
      sendsToday: new Map([[id, 15]]), step: 2 });
    assert.equal(followUp.sender, null);
  }
});

test('4. Jole\'s Monday allocation is 60/day (4 × 15) and the client layer stops the 61st', () => {
  const capacity = capacityFromEnv(configuredSenders(MONDAY_ENV), MONDAY_ENV);
  assert.deepEqual(capacity.clientLimits.jole, { daily: 60, perRun: 12 });
  const state = createClientCapacityState({
    globalDailyLimit: capacity.globalDailyLimit, globalWindowLimit: 10_000,
    configs: new Map(Object.entries(capacity.clientLimits).map(([id, limit]) => [id, { dailyCap: limit.daily, windowCap: 10_000 }])),
    env: MONDAY_ENV,
  });
  for (let i = 0; i < 60; i++) consumeClientCapacity(state, 'jole');
  const verdict = clientCapacityVerdict(state, 'jole');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'client_daily_cap');
});

test('5. the 20/inbox hard ceiling is unchanged beneath the ramp, and a cap above it never raises it', () => {
  assert.equal(getClient('jole').senderPolicy.maxDailyPerInbox, 20);
  assert.equal(getClient('jole').capacity.dailyCap, 120);
  assert.equal(getClient('jole').capacity.windowCap, 12);
  // Without the ramp each inbox is at its registry 20.
  for (const id of SIX) assert.equal(senderOf({ ...PROD_ENV, CLIENT_SENDING_AUTHORIZED: 'jole' }, id).dailyLimit, 20);
  // A configured 35 is clamped to 20, and a per-inbox cap of 25 does not lift it.
  const overrides = JSON.stringify([{ id: 'jole_group_jorge', email: 'jorge@jolebtxgroup.com', clientId: 'jole', status: 'active',
    tokenEnv: 'GMAIL_JOLE_GROUP_JORGE_TOKEN_JSON', dailyLimit: 35, perRunLimit: 2, allowedCampaignIds: ['jole-btx-employer-acquisition'] }]);
  const env = { ...MONDAY_ENV, GMAIL_INBOX_REGISTRY_JSON: overrides, COLD_INBOX_DAILY_CAPS: 'jole_group_jorge:25' };
  assert.equal(senderOf(env, 'jole_group_jorge').dailyLimit, 20);
});

test('6. ScaleLab is untouched: same roster, limits, eligibility, holds and allocation with the ramp set', () => {
  assert.deepEqual(scalelabRoster(RAMP_ENV), scalelabRoster(PROD_ENV));
  assert.deepEqual(scalelabRoster(MONDAY_ENV), scalelabRoster(PROD_ENV));
  for (const id of SCALELAB_IDS) {
    assert.equal(coldSenderHolds(MONDAY_ENV).has(id), false, `${id} gains no hold`);
    const sender = senderOf(MONDAY_ENV, id);
    assert.deepEqual(coldSenderVerdict(sender, MONDAY_ENV), coldSenderVerdict(senderOf(PROD_ENV, id), PROD_ENV));
  }
  const before = capacityFromEnv(configuredSenders(PROD_ENV), PROD_ENV).clientLimits.scalelab;
  assert.deepEqual(capacityFromEnv(configuredSenders(MONDAY_ENV), MONDAY_ENV).clientLimits.scalelab, before);
  assert.deepEqual(before, { daily: 170, perRun: 22 });
  // An unparseable hold list would fall back to the ScaleLab defaults; the launch value parses.
  const policy = describeColdDeliveryPolicy(configuredSenders(MONDAY_ENV), MONDAY_ENV);
  assert.deepEqual(policy.coldSenderHolds, { jole_industrial_jorge: 'warmup_incomplete', jole_industrial_jguerrero: 'warmup_incomplete' });
});

test('7. Jole sends only weekdays 07:00–11:59 America/Chicago', () => {
  assert.equal(getClient('jole').timezone, 'America/Chicago');
  const at = iso => clientSendWindowVerdict('jole', { now: Date.parse(iso) }).allowed;
  assert.equal(at('2026-10-19T11:59:00.000Z'), false, 'Mon 06:59 CDT');
  assert.equal(at('2026-10-19T12:00:00.000Z'), true, 'Mon 07:00 CDT');
  assert.equal(at('2026-10-19T16:59:00.000Z'), true, 'Mon 11:59 CDT');
  assert.equal(at('2026-10-19T17:00:00.000Z'), false, 'Mon 12:00 CDT');
  assert.equal(at('2026-10-18T15:00:00.000Z'), false, 'Sunday');
  assert.equal(at('2026-10-17T15:00:00.000Z'), false, 'Saturday');
});

test('8–10. v2 renders: role — location subject, optional second role, both Touch 2 URLs, Jole\'s address only', () => {
  const one = joleLead(3);
  const e1 = renderClientLeadEmail(one, 1, { env: MONDAY_ENV, now: MONDAY_0900_CT });
  assert.equal(e1.copyVersion, 'jole_industrial_employer_v2');
  assert.equal(e1.subject, 'Millwrights — Mont Belvieu, TX');
  assert.match(e1.body, /^Hi Pat,\n\nSaw Gulf Fabrication 3, LLC is hiring Millwrights in Mont Belvieu, TX\.\n/);
  assert.doesNotMatch(e1.body, /also has openings/);
  const two = joleLead(4, { profile: { secondary_role: 'I&E Technician' } });
  assert.match(renderClientLeadEmail(two, 1, { env: MONDAY_ENV, now: MONDAY_0900_CT }).body,
    /hiring Millwrights in Mont Belvieu, TX and also has openings for I&E Technicians at the site\./);
  const e2 = renderClientLeadEmail(one, 2, { env: MONDAY_ENV, now: MONDAY_0900_CT });
  assert.deepEqual(e2.body.match(/https?:\/\/\S+/g), [LANDING, BOOKING]);
  for (const step of [1, 2, 3]) {
    const { body } = renderClientLeadEmail(one, step, { env: MONDAY_ENV, now: MONDAY_0900_CT });
    assert.ok(body.includes(`\nJorge Guerrero\nCEO\nJole BTX LLC\n${ADDRESS}\n`), `touch ${step} footer`);
    assert.doesNotMatch(body, /scalelab|new westminster|{{|}}|undefined|null/i);
  }
  // Without Jole's own address the copy refuses; it never borrows ScaleLab's.
  const noAddress = { ...MONDAY_ENV, JOLE_COMMERCIAL_MAILING_ADDRESS: '', COMMERCIAL_MAILING_ADDRESS: 'ScaleLab AI, 1 Main St, New Westminster, BC' };
  assert.throws(() => renderClientLeadEmail(one, 1, { env: noAddress, now: MONDAY_0900_CT }));
});

test('11–12. only personalization-ready, fresh leads render; needs-review leads are refused and never balanced', () => {
  assert.equal(clientPersonalizationState(joleLead(5), { env: MONDAY_ENV, now: MONDAY_0900_CT }).status, 'ready');
  const review = joleLead(6, { stage: 'Import', senderInboxId: '', profile: { verified_role: 'General Laborer' } });
  assert.equal(clientPersonalizationState(review, { env: MONDAY_ENV, now: MONDAY_0900_CT }).status, 'needs_review');
  assert.throws(() => renderClientLeadEmail(review, 1, { env: MONDAY_ENV, now: MONDAY_0900_CT }), /needs review/);
  // The live Oct 7 verification stamp is 12 days old on Monday; the gate still bites when it ages out.
  assert.throws(() => renderClientLeadEmail(joleLead(7), 1, { env: MONDAY_ENV, now: Date.parse('2026-10-07') + 46 * DAY }), /older than/);
  // The refill never assigns an Import / needs-review lead to any inbox.
  const plan = planSenderRebalance({ leads: [review, ...READY.map((id, i) => joleLead(10 + i, { senderInboxId: id }))],
    activities: [], senders: configuredSenders(RAMP_ENV), horizon: MONDAY_0900_CT, env: RAMP_ENV });
  assert.equal(plan.moves.some(move => move.leadId === review.id), false);
});

test('ramp set, final switch off: industrial-pinned leads are never moved by the refill while warmed inboxes hold supply', () => {
  const leads = [
    ...READY.flatMap((id, i) => Array.from({ length: 20 }, (_, k) => joleLead(100 + i * 20 + k, { senderInboxId: id }))),
    ...INDUSTRIAL.flatMap((id, i) => Array.from({ length: 20 }, (_, k) => joleLead(300 + i * 20 + k, { senderInboxId: id }))),
  ];
  const plan = planSenderRebalance({ leads, activities: [], senders: configuredSenders(RAMP_ENV), horizon: MONDAY_0900_CT, env: RAMP_ENV });
  assert.deepEqual(plan.moves, []);
});

test('13. the final client authorization is still required: with the ramp set and no CLIENT_SENDING_AUTHORIZED nothing Jole can send', () => {
  assert.equal(RAMP_ENV.CLIENT_SENDING_AUTHORIZED, undefined);
  assert.equal(clientSendBlock('jole', RAMP_ENV).code, 'client_sending_disabled');
  for (const id of SIX) {
    const sender = senderOf(RAMP_ENV, id);
    assert.equal(sender.sendEligible, false, id);
    assert.equal(coldSenderVerdict(sender, RAMP_ENV).code, 'sender_not_send_eligible');
  }
  const capacity = capacityFromEnv(configuredSenders(RAMP_ENV), RAMP_ENV);
  assert.deepEqual(capacity.clientLimits.jole, { daily: 0, perRun: 0 });
  // Thursday and Friday windows are open on the Chicago clock; authorization is what holds them.
  assert.equal(clientSendWindowVerdict('jole', { now: Date.parse('2026-10-16T14:00:00.000Z') }).allowed, true);
  const state = createClientCapacityState({ globalDailyLimit: capacity.globalDailyLimit, globalWindowLimit: capacity.globalPerRunLimit, env: RAMP_ENV });
  assert.equal(clientCapacityVerdict(state, 'jole').allowed, false);
  // Only the four warmed inboxes become eligible once it is set.
  assert.deepEqual(configuredSenders(MONDAY_ENV).filter(s => s.clientId === 'jole' && s.sendEligible && s.dailyLimit > 0).map(s => s.id), READY);
});
