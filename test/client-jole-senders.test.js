'use strict';

// Jole BTX LLC out of onboarding (2026-10-05): an ACTIVE client whose sender
// infrastructure is configurable, with no send authority. Every Jole inbox is
// scoped to Jole and to the one employer-acquisition campaign, capped at
// 20/day, held paused while Jole sending is off, and never interchangeable with
// a ScaleLab inbox in either direction.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getClient } = require('../integrations/clients/registry');
const { clientCampaign, clientTemplate, campaignSendable } = require('../integrations/clients/campaigns');
const { checkClientConsistency } = require('../integrations/clients/ownership');
const { senderPolicyBlockers, cappedDailyLimit, senderServesCampaign } = require('../integrations/clients/sender-policy');
const { clientSendState } = require('../integrations/clients/send-policy');
const { configuredSenders, allowedForLead, chooseSender } = require('../integrations/gmail-sender-routing');
const { activationBlockers } = require('../integrations/gmail-sender-lifecycle');
const { assignNewLeads } = require('../integrations/sender-balance');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { DEFAULT_SECONDARY_INBOXES } = require('../integrations/gmail-inbox-registry');

const CAMPAIGN = 'jole-btx-employer-acquisition';
const VERSION = 'jole_industrial_employer_acquisition_v1';

// Production's registry as configured today: five ScaleLab inboxes, no Jole row.
const PROD_ENV = {
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '60', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 60, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'active', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5, staffingOnly: true },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
};
const withJole = (rows, extra = {}) => {
  const base = JSON.parse(PROD_ENV.GMAIL_INBOX_REGISTRY_JSON);
  const env = { ...PROD_ENV, GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([...base, ...rows]), ...extra };
  for (const row of rows) env[row.tokenEnv] = '{}';
  return env;
};
const joleRow = (id, email, extra = {}) => ({ id, email, clientId: 'jole', status: 'paused', tokenEnv: `GMAIL_${id.toUpperCase()}_TOKEN_JSON`, dailyLimit: 20, perRunLimit: 2, ...extra });

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
// A Jole sender as it would look after Jole sending is approved (for routing logic only).
const approvedJoleSender = (extra = {}) => ({ id: 'jole_team1', email: 'a@jolebtxteam.com', clientId: 'jole', status: 'active',
  sendEligible: true, dailyLimit: 20, perRunLimit: 2, credentialConfigured: true, ...extra });

test('1-2. Jole is out of onboarding: an active, configured client with no platform access', () => {
  const jole = getClient('jole');
  assert.notEqual(jole.lifecycleStatus, 'onboarding_pending');
  assert.equal(jole.lifecycleStatus, 'active');
  assert.equal(jole.active, true);
  assert.equal(jole.displayName, 'Jole BTX LLC');
  assert.equal(jole.platformAccess, 'none');
  assert.deepEqual([...jole.workspaces], ['clients', 'pipeline', 'inbox', 'bookings', 'campaigns', 'analytics', 'settings']);
});

test('3. the Jole campaign exists with its exact identifiers, configured as a never-sendable draft', () => {
  const campaign = clientCampaign(CAMPAIGN);
  assert.equal(campaign.clientId, 'jole');
  assert.equal(campaign.emailTemplateId, 'jole-industrial-employer-v1');
  assert.equal(campaign.campaignVersion, VERSION);
  assert.equal(clientCampaign(VERSION), campaign, 'the stored campaign version resolves to the same campaign');
  assert.equal(clientTemplate('jole-industrial-employer-v1').ready, false);
  assert.equal(campaignSendable(campaign).ok, false);
  assert.deepEqual([...getClient('jole').senderPolicy.allowedCampaignIds], [CAMPAIGN]);
});

test('4. production today has no Jole sender; any registered Jole sender belongs to Jole and only its campaign', () => {
  assert.equal(configuredSenders(PROD_ENV).filter(sender => sender.clientId === 'jole').length, 0);
  const senders = configuredSenders(withJole([joleRow('jole_team1', 'a@jolebtxteam.com'), joleRow('jole_group1', 'b@jolebtxgroup.com')]));
  const jole = senders.filter(sender => sender.clientId === 'jole');
  assert.deepEqual(jole.map(sender => sender.id), ['jole_team1', 'jole_group1']);
  for (const sender of jole) {
    assert.equal(senderServesCampaign(sender, CAMPAIGN), true);
    assert.equal(senderServesCampaign(sender, VERSION), true);
    assert.equal(senderServesCampaign(sender, 'JOLE_DC_MISSION_CRITICAL'), false, 'not even another Jole campaign');
    assert.equal(senderServesCampaign(sender, 'industrial_staffing_employer_acquisition_v1'), false);
  }
});

test('5. a Jole sender can never serve ScaleLab', () => {
  const sender = approvedJoleSender();
  assert.equal(allowedForLead(sender, scalelabLead()), false);
  assert.equal(checkClientConsistency({ lead: scalelabLead(), sender }).code, 'client_ownership_conflict');
  const choice = assignNewLeads({ batch: [scalelabLead()], senders: [sender] });
  assert.equal(choice.assignments.size, 0);
});

test('6. a ScaleLab sender can never serve Jole', () => {
  for (const sender of configuredSenders(PROD_ENV)) {
    assert.equal(allowedForLead(sender, joleLead()), false, sender.id);
    assert.equal(checkClientConsistency({ lead: joleLead(), sender }).ok, false, sender.id);
  }
});

test('7-8. no eligible Jole sender fails closed: the lead stays unassigned and unsent, with no ScaleLab fallback', () => {
  const scalelab = configuredSenders(PROD_ENV).map(sender => ({ ...sender, status: 'active', sendEligible: true }));
  const admission = assignNewLeads({ batch: [joleLead()], senders: scalelab });
  assert.equal(admission.assignments.size, 0);
  assert.deepEqual(admission.refused, [{ leadId: 'jl1', reason: 'no active compatible sending inbox' }]);
  // Dynamic selection (no assignment) finds nobody; an assignment to ScaleLab is refused outright.
  const dynamic = chooseSender({ lead: joleLead({ routingRequired: 'false' }), senders: scalelab });
  assert.equal(dynamic.sender, null);
  assert.throws(() => chooseSender({ lead: joleLead({ senderInboxId: 'primary' }), senders: scalelab }), /not delivery eligible/);
  // A paused Jole sender beside them changes nothing.
  const paused = configuredSenders(withJole([joleRow('jole_team1', 'a@jolebtxteam.com')]));
  assert.equal(assignNewLeads({ batch: [joleLead()], senders: paused }).assignments.size, 0);
});

test('9. a Jole inbox is hard-capped at 20 per day; a higher configured value is clamped', () => {
  const senders = configuredSenders(withJole([
    joleRow('jole_team1', 'a@jolebtxteam.com', { dailyLimit: 50 }),
    joleRow('jole_team2', 'b@jolebtxteam.com', { dailyLimit: 10 }),
  ]));
  const byId = Object.fromEntries(senders.map(sender => [sender.id, sender]));
  assert.equal(byId.jole_team1.dailyLimit, 20);
  assert.equal(byId.jole_team1.configuredDailyLimit, 50);
  assert.equal(byId.jole_team2.dailyLimit, 10, 'a lower launch cap is kept');
  assert.equal(getClient('jole').senderPolicy.maxDailyPerInbox, 20);
  assert.equal(cappedDailyLimit({ email: 'x@jolebtxteam.com', clientId: 'jole' }, 500), 20);
});

test('10. a paused Jole sender cannot send, and none can be activated while Jole sending is off', () => {
  const senders = configuredSenders(withJole([joleRow('jole_team1', 'a@jolebtxteam.com')]));
  const sender = senders.find(item => item.id === 'jole_team1');
  assert.equal(sender.status, 'paused');
  assert.equal(sender.sendEligible, false);
  const blockers = activationBlockers({ ...sender, status: 'ready' }, {
    auth: { authenticated: true, identityVerified: true }, observer: { health: 'healthy', cursorState: 'present' }, senders,
  });
  assert.ok(blockers.some(reason => /client sending is not authorized/.test(reason)), blockers.join('; '));
});

test('11. client activation does not activate a sender: even a row marked active stays non-sending', () => {
  for (const env of [withJole([joleRow('jole_team1', 'a@jolebtxteam.com', { status: 'active' })]),
    withJole([joleRow('jole_team1', 'a@jolebtxteam.com', { status: 'active' })], { CLIENT_SENDING_AUTHORIZED: 'jole' })]) {
    const sender = configuredSenders(env).find(item => item.id === 'jole_team1');
    assert.equal(sender.status, 'active');
    assert.equal(sender.sendEligible, false);
    assert.match(sender.policyBlockers.join(' '), /client sending is not authorized/);
  }
  assert.equal(clientSendState('jole', { CLIENT_SENDING_AUTHORIZED: 'jole' }).sendingEnabled, false);
});

test('12-13. client activation queues and assigns nothing: Jole leads are not routable, movable or assignable', () => {
  assert.equal(routedLeadReady(joleLead()).ok, false);
  assert.equal(routedLeadReady(joleLead({ senderInboxId: 'jole_team1' })).ok, false);
  const senders = configuredSenders(withJole([joleRow('jole_team1', 'a@jolebtxteam.com', { status: 'active' })]));
  assert.equal(assignNewLeads({ batch: [joleLead()], senders }).assignments.size, 0);
});

test('14. the corporate jolebtx.com is never a cold sender, and Jole domains are unusable by anyone else', () => {
  assert.match(senderPolicyBlockers({ email: 'jorge@jolebtx.com', clientId: 'jole' }).join(' '), /protected domain/);
  assert.match(senderPolicyBlockers({ email: 'x@gmail.com', clientId: 'jole' }).join(' '), /not an approved Jole BTX LLC outbound domain/);
  assert.match(senderPolicyBlockers({ email: 'deins@jolebtxteam.com' }).join(' '), /reserved for Jole BTX LLC/);
  assert.match(senderPolicyBlockers({ email: 'deins@jolebtx.com', clientId: 'scalelab' }).join(' '), /reserved for Jole BTX LLC/);
  const senders = configuredSenders(withJole([joleRow('jole_corp', 'jorge@jolebtx.com', { status: 'active' })], { CLIENT_SENDING_AUTHORIZED: 'jole' }));
  assert.equal(senders.find(item => item.id === 'jole_corp').sendEligible, false);
  // A campaign outside the policy is refused at load as well.
  const wide = configuredSenders(withJole([joleRow('jole_team1', 'a@jolebtxteam.com', { allowedCampaignIds: [CAMPAIGN, 'JOLE_DC_MISSION_CRITICAL'] })]));
  assert.match(wide.find(item => item.id === 'jole_team1').policyBlockers.join(' '), /JOLE_DC_MISSION_CRITICAL is not allowed/);
});

test('a Jole sender on another Jole campaign is refused at the shared consistency check', () => {
  const sender = approvedJoleSender();
  assert.equal(checkClientConsistency({ lead: joleLead(), sender }).ok, true);
  const legacy = joleLead({ intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL', campaign: 'JOLE_DC_MISSION_CRITICAL', emailTemplateId: 'jole-dc-mission-critical-v1' });
  assert.equal(checkClientConsistency({ lead: legacy, sender }).code, 'sender_campaign_not_allowed');
  assert.equal(allowedForLead(sender, legacy), false);
});

test('15. ScaleLab senders are byte-for-byte unchanged: same caps, statuses, eligibility, no new fields', () => {
  const senders = configuredSenders(PROD_ENV);
  assert.deepEqual(senders.map(sender => [sender.id, sender.email, sender.status, sender.dailyLimit, sender.perRunLimit, sender.sendEligible, sender.clientId || 'scalelab']), [
    ['primary', 'deins@scalelabai.ca', 'active', 60, 6, true, 'scalelab'],
    ['tryscalelabai', 'deins@tryscalelabai.ca', 'active', 60, 6, true, 'scalelab'],
    ['scalelabaiteam', 'deins@scalelabaiteam.com', 'active', 40, 5, true, 'scalelab'],
    ['deniels', 'deniels@scalelabai.ca', 'warming', 20, 2, false, 'scalelab'],
    ['deniels_tryscalelabai', 'deniels@tryscalelabai.ca', 'warming', 20, 2, false, 'scalelab'],
  ]);
  for (const sender of senders) {
    for (const key of ['policyBlockers', 'allowedCampaignIds', 'configuredDailyLimit']) assert.equal(sender[key], undefined, `${sender.id}.${key}`);
    assert.equal(senderServesCampaign(sender, 'industrial_staffing_employer_acquisition_v1'), true);
  }
  assert.deepEqual(DEFAULT_SECONDARY_INBOXES.map(row => [row.id, row.status, row.dailyLimit, row.perRunLimit]), [
    ['scalelabaiteam', 'warming', 40, 5], ['deniels', 'warming', 20, 2], ['deniels_tryscalelabai', 'warming', 20, 2],
  ]);
  // A malformed Jole row never takes the ScaleLab registry down with it.
  const mixed = configuredSenders(withJole([joleRow('jole_bad', 'x@jolebtx.com', { status: 'active', dailyLimit: 999 })]));
  assert.equal(mixed.find(item => item.id === 'tryscalelabai').sendEligible, true);
});

test('16. no Jole email can be sent from this configuration: the provider boundary refuses before Gmail', async () => {
  const { withGmailProviderSend } = require('../integrations/send-lock');
  let providerCalled = false;
  for (const env of [{}, { CLIENT_SENDING_AUTHORIZED: 'jole' }, { SEND_LOCK_ENABLED: 'true' }]) {
    await assert.rejects(withGmailProviderSend({ lead: joleLead(), sendAction: { actionId: 'cold:jl1:1', leadId: 'jl1' },
      run: async () => { providerCalled = true; }, env }), error => error.code === 'client_sending_disabled');
  }
  assert.equal(providerCalled, false);
});
