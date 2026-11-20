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
function isStaffingLead(lead = {}) {
  return [lead.leadNiche, lead.tradeType, lead.emailTemplateId, lead.intendedCampaignVersion,
    lead.campaignId, lead.campaign, lead.campaignFamily].some(value => /staffing/i.test(String(value || '')));
}
function staffingSendBlockReason(lead, env = process.env) {
  if (!isStaffingLead(lead)) return '';
  // Industrial Staffing V4 is held at the final gate too (send-safety-revalidate
  // and the provider call both read this): a V4 lead that is not SEND_READY
  // under a live V4 is refused even if the shared staffing launch is active.
  // Lazy require: staffing-campaign loads modules that load this file.
  const v4Block = require('./staffing-campaign').staffingV4SendBlock(lead);
  return v4Block || staffingLaunchState(env).reason;
}
function assertStaffingSendAllowed(lead, env = process.env) {
  if (!lead) throw new Error('Provider delivery requires lead context');
  const reason = staffingSendBlockReason(lead, env);
  if (reason) throw new Error(reason);
}
module.exports = { ACTIVATION_VARIABLE, staffingLaunchState, isStaffingLead, staffingSendBlockReason, assertStaffingSendAllowed };
