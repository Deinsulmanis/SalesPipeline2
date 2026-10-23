'use strict';

// Readiness is source-controlled; delivery requires a separate, durable Railway
// setting. Missing, malformed or future approval fails closed on every process.
const ACTIVATION_VARIABLE = 'STAFFING_LAUNCH_ACTIVATED_AT';
function staffingLaunchState(env = process.env, now = Date.now()) {
  const value = String(env[ACTIVATION_VARIABLE] || '');
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? Date.parse(value) : NaN;
  const sendable = Number.isFinite(instant) && instant <= now && new Date(instant).toISOString() === value;
  return { ready: true, status: sendable ? 'active' : 'approved', sendable,
    sendingState: sendable ? 'Active / sending' : 'Paused / awaiting activation',
    activatedAt: sendable ? value : null, activationVariable: ACTIVATION_VARIABLE,
    reason: sendable ? '' : 'Staffing sending is paused; explicit launch approval is required' };
}

// Staffing Outreach Campaign 2 is approved to send from its first ScaleLab send
// window on 2026-10-23 (07:00 America/Vancouver, PDT). Before that instant no
// Campaign 2 touch may reach a provider, whatever the staffing activation says.
// Its identity lives here, not in staffing-campaign.js, so this gate stays a leaf.
const STAFFING_CAMPAIGN_2_ID = 'industrial_staffing_outreach_campaign_2';
const STAFFING_CAMPAIGN_2_NAME = 'Staffing Outreach Campaign 2';
const STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE = '2026-10-23T14:00:00.000Z';
function isStaffingCampaign2Lead(lead = {}) {
  return String(lead.campaign || '').trim() === STAFFING_CAMPAIGN_2_NAME
    || [lead.campaign, lead.campaignId, lead.intendedCampaignVersion]
      .some(value => String(value || '').trim() === STAFFING_CAMPAIGN_2_ID);
}
function staffingCampaign2Open(now = Date.now()) {
  return now >= Date.parse(STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE);
}

function isStaffingLead(lead = {}) {
  return [lead.leadNiche, lead.tradeType, lead.emailTemplateId, lead.intendedCampaignVersion,
    lead.campaignId, lead.campaign, lead.campaignFamily].some(value => /staffing/i.test(String(value || '')));
}
function staffingSendBlockReason(lead, env = process.env, now = Date.now()) {
  if (!isStaffingLead(lead)) return '';
  const launch = staffingLaunchState(env, now).reason;
  if (launch) return launch;
  if (isStaffingCampaign2Lead(lead) && !staffingCampaign2Open(now)) {
    return `${STAFFING_CAMPAIGN_2_NAME} may not send before ${STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE}`;
  }
  return '';
}
function assertStaffingSendAllowed(lead, env = process.env, now = Date.now()) {
  if (!lead) throw new Error('Provider delivery requires lead context');
  const reason = staffingSendBlockReason(lead, env, now);
  if (reason) throw new Error(reason);
}
module.exports = { ACTIVATION_VARIABLE, staffingLaunchState, isStaffingLead, staffingSendBlockReason, assertStaffingSendAllowed,
  STAFFING_CAMPAIGN_2_ID, STAFFING_CAMPAIGN_2_NAME, STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE,
  isStaffingCampaign2Lead, staffingCampaign2Open };
