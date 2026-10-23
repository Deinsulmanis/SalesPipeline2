'use strict';

// Staffing Outreach Campaign 2 sends the Industrial Staffing Agency (V1) locked
// copy, unchanged, under its own campaign version, and may not reach a provider
// before 2026-10-23 07:00 America/Vancouver. V1 stays completed; V2 and Jole are
// untouched. Nothing here contacts Google, Gmail or Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, staffingCampaignFor, isStaffingCampaign,
  renderStaffingEmail, validateStaffingEmail, replaceStaffingReviewTag, LOCKED_EMAILS,
} = require('../integrations/staffing-campaign');
const {
  staffingSendBlockReason, assertStaffingSendAllowed, isStaffingCampaign2Lead,
  STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE,
} = require('../integrations/staffing-launch-gate');
const { CAMPAIGN_VERSIONS, activeVersionForLead, coldSendAttribution } = require('../integrations/campaign-versions');
const { validateCampaignVersionRoute, campaignVersionsForRoute } = require('../integrations/campaign-routing');
const { completedCampaignFor, outreachBlockForLead } = require('../integrations/lead-archive');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { googleRecipient } = require('../test-support/google-recipient');

const OPEN = Date.parse(STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE);
const ACTIVATED = '2026-09-01T00:00:00.000Z';
const RENDER_ENV = Object.freeze({ COMMERCIAL_MAILING_ADDRESS: '100 Example Ave, City, ST 00000',
  FROM_EMAIL: 'deins@scalelabai.ca', FROM_NAME: 'Deins' });
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
  STAFFING_LAUNCH_ACTIVATED_AT: ACTIVATED, ...RENDER_ENV,
});
const REVIEWED = replaceStaffingReviewTag('', { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true });

// Production shape of a reviewed, routed Campaign 2 lead (outreach_leads).
const campaign2Lead = (extra = {}) => ({
  id: 'c2-1', company: 'Labor Masters', contactName: 'Nancy Example', firstName: 'Nancy', email: 'nancy@labormasters.test',
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', tradeType: '', siteContext: '',
  leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN_2.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  intendedCampaignVersion: STAFFING_CAMPAIGN_2.id, campaign_notes: REVIEWED, senderInboxId: 'primary',
  routingRequired: 'true', clientId: 'scalelab', sheetRow: 2, revision: 1, ...extra,
});

function withClock(t, iso) {
  t.mock.timers.enable({ apis: ['Date'], now: typeof iso === 'number' ? iso : Date.parse(iso) });
}
function withActivation(t) {
  const previous = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = ACTIVATED;
  t.after(() => {
    if (previous === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT;
    else process.env.STAFFING_LAUNCH_ACTIVATED_AT = previous;
  });
}

test('Campaign 2 is its own staffing campaign on V1 template, separate from V1 and V2', () => {
  assert.equal(STAFFING_CAMPAIGN_2.id, 'industrial_staffing_outreach_campaign_2');
  assert.equal(STAFFING_CAMPAIGN_2.name, 'Staffing Outreach Campaign 2');
  assert.equal(STAFFING_CAMPAIGN_2.emailTemplateId, STAFFING_CAMPAIGN.emailTemplateId);
  assert.notEqual(STAFFING_CAMPAIGN_2.id, STAFFING_CAMPAIGN.id);
  assert.equal(staffingCampaignFor(campaign2Lead()), STAFFING_CAMPAIGN_2);
  assert.equal(staffingCampaignFor(campaign2Lead({ intendedCampaignVersion: '', emailTemplateId: '' })), STAFFING_CAMPAIGN_2);
  assert.equal(staffingCampaignFor({ ...campaign2Lead(), campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id }), STAFFING_CAMPAIGN);
  assert.equal(staffingCampaignFor(campaign2Lead({ intendedCampaignVersion: STAFFING_CAMPAIGN.id })), null, 'a Campaign 2 lead never routes as V1');
  assert.equal(staffingCampaignFor(campaign2Lead({ intendedCampaignVersion: STAFFING_CAMPAIGN_V2.id })), null, 'nor as V2');
  assert.equal(isStaffingCampaign2Lead({ ...campaign2Lead(), campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id }), false);
});

test('V1 stays completed; Campaign 2 is not a completed campaign', () => {
  assert.equal(completedCampaignFor(campaign2Lead()), null);
  assert.equal(outreachBlockForLead(campaign2Lead()), null);
  const v1 = { ...campaign2Lead(), campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id };
  assert.equal(outreachBlockForLead(v1).code, 'campaign_completed');
});

test('every Campaign 2 touch is the V1 locked copy, byte for byte', () => {
  const lead = campaign2Lead();
  const v1Twin = { ...lead, campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id };
  for (const step of [1, 2, 3]) {
    const mine = renderStaffingEmail(lead, step, { env: RENDER_ENV });
    const theirs = renderStaffingEmail(v1Twin, step, { env: RENDER_ENV });
    assert.equal(mine.body, theirs.body, `step ${step}`);
    assert.equal(mine.subject, theirs.subject, `step ${step}`);
    assert.equal(mine.campaignId, undefined, 'validated against V1 locked phrases');
    assert.equal(validateStaffingEmail(mine, step), null, `step ${step}`);
  }
  assert.equal(renderStaffingEmail(lead, 1, { env: RENDER_ENV }).subject, 'employer accounts');
  assert.ok(renderStaffingEmail(lead, 3, { env: RENDER_ENV }).body.startsWith(
    LOCKED_EMAILS[2].replace('{{firstName}}', 'Nancy').replace('{{company}}', 'Labor Masters')));
});

test('Campaign 2 refuses to render without a company or an ICP-confirmed review', () => {
  assert.throws(() => renderStaffingEmail(campaign2Lead({ company: '' }), 2, { env: RENDER_ENV }), /Invalid template variable/);
  assert.throws(() => renderStaffingEmail(campaign2Lead({ campaign_notes: '' }), 1, { env: RENDER_ENV }), /no stored personalized opening/);
});

test('Campaign 2 is attributed to its own version and never to V1', (t) => {
  withActivation(t);
  withClock(t, OPEN);
  const version = activeVersionForLead(campaign2Lead());
  assert.equal(version.id, STAFFING_CAMPAIGN_2.id);
  const first = coldSendAttribution(campaign2Lead(), 1);
  assert.equal(first.campaignVersion, STAFFING_CAMPAIGN_2.id);
  assert.equal(first.copyVersion, 'staffing_locked_v1');
  assert.equal(coldSendAttribution(campaign2Lead(), 2).copyVersion, 'industrial_staffing_follow_up_v1');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].activatedAt, STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE);
});

test('Campaign 2 is queueable before its start but its version is not active', (t) => {
  withActivation(t);
  withClock(t, OPEN - 1);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].status, 'approved');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_2.id].activatedAt, null);
  assert.throws(() => activeVersionForLead(campaign2Lead()), /is not active/);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    campaignVersionId: STAFFING_CAMPAIGN_2.id }).ok, true);
  assert.ok(campaignVersionsForRoute({ niche: 'industrial_staffing' }).some(version => version.id === STAFFING_CAMPAIGN_2.id));
});

test('no Campaign 2 touch reaches a provider before 2026-10-23T14:00:00.000Z', async (t) => {
  assert.equal(STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE, '2026-10-23T14:00:00.000Z');
  for (const at of [Date.parse('2026-10-23T06:45:00.000Z'), Date.parse('2026-10-23T12:00:00.000Z'), OPEN - 1]) {
    assert.match(staffingSendBlockReason(campaign2Lead(), SEND_ENV, at), /may not send before 2026-10-23T14:00:00.000Z/);
    assert.throws(() => assertStaffingSendAllowed(campaign2Lead(), SEND_ENV, at), /may not send before/);
  }
  assert.equal(staffingSendBlockReason(campaign2Lead(), SEND_ENV, OPEN), '');
  assert.match(staffingSendBlockReason(campaign2Lead(), {}, OPEN), /paused/, 'staffing activation is still required');

  withClock(t, OPEN - 60 * 1000);
  const current = campaign2Lead();
  for (const purpose of ['cold', 'sequence']) {
    const verdict = await guardProviderSend(current, { env: SEND_ENV, classifyRecipient: googleRecipient,
      loadFreshState: async () => ({ current, suppressedEmails: new Set() }) }, { purpose });
    assert.equal(verdict.allowed, false, purpose);
    assert.equal(verdict.code, 'staffing_launch_paused', purpose);
    assert.match(verdict.reason, /may not send before/, purpose);
  }
});

test('with V1 completed, Campaign 2 is the current live staffing campaign', () => {
  const { liveCampaignVersions, currentLiveCampaignVersion } = require('../integrations/analytics-scope');
  assert.ok(!liveCampaignVersions().includes(STAFFING_CAMPAIGN.id));
  assert.ok(liveCampaignVersions().includes(STAFFING_CAMPAIGN_2.id));
  assert.equal(currentLiveCampaignVersion(), STAFFING_CAMPAIGN_2.id);
});

test('the start restriction applies only to Campaign 2', () => {
  const before = OPEN - 1;
  const v2 = { ...campaign2Lead(), campaign: STAFFING_CAMPAIGN_V2.name, intendedCampaignVersion: STAFFING_CAMPAIGN_V2.id,
    emailTemplateId: STAFFING_CAMPAIGN_V2.emailTemplateId };
  assert.doesNotMatch(staffingSendBlockReason(v2, SEND_ENV, before), /may not send before/);
  const jole = { id: 'j1', leadNiche: 'jole_industrial_hiring', campaign: 'Jole BTX', clientId: 'jole_btx' };
  assert.equal(staffingSendBlockReason(jole, SEND_ENV, before), '');
  assert.equal(staffingSendBlockReason({ leadNiche: 'dental' }, SEND_ENV, before), '');
  assert.equal(isStaffingCampaign(campaign2Lead()), true);
});
