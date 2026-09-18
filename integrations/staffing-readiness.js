'use strict';

const { STAFFING_CAMPAIGN, staffingOpeningFor, renderStaffingEmail, validateStaffingEmail } = require('./staffing-campaign');
const { staffingLaunchState, isStaffingLead } = require('./staffing-launch-gate');
const { CAMPAIGN_FAMILY, resolveLeadFamily, familyForLead } = require('./campaign-versions');
const { routedLeadReady } = require('./campaign-routing');
const { queueEligibility } = require('./outreach-queue');
const { sendSuppressionReason } = require('./pipeline-state');
const { deriveAutomationOwnership, mayColdSend } = require('./automation-ownership');
const { sendAuthorization } = require('./send-authorization');
const { authoritativeProvider } = require('./provider-ownership');
const { deriveSequenceState } = require('./stage-sequences');
const { isValidCommercialMailingAddress, looksLikeTestFixtureMailingAddress } = require('./staffing-compliance');

function hasManualHold(lead = {}) {
  return String(lead.notes || '').includes('[MANUAL HOLD]');
}

function missingPersonalization(lead) {
  return !staffingOpeningFor(lead);
}

function missingIdentity(lead) {
  const missing = [];
  if (!String(lead.firstName || lead.first || lead.contactName || '').trim()) missing.push('firstName');
  if (!String(lead.company || '').trim()) missing.push('company');
  if (!String(lead.email || '').trim()) missing.push('email');
  return missing;
}

function staffingReadinessReport({
  leads = [], activities = [], boardLeads = [], suppressedEmails = new Set(),
  mappings = [], campaignProviders = {}, env = process.env, now = Date.now(),
} = {}) {
  const launch = staffingLaunchState(env, now);
  const auth = sendAuthorization(env);
  const staffingLeads = leads.filter(lead => isStaffingLead(lead) || familyForLead(lead) === CAMPAIGN_FAMILY.STAFFING);
  const counts = {
    totalStaffing: 0, queued: 0, eligibleIfSendingEnabled: 0,
    blockedByStaffingGate: 0, blockedBySuppression: 0, blockedByManualHold: 0,
    unroutedUnknownNiche: 0, missingPersonalization: 0, missingIdentity: 0,
    sequenceInconsistent: 0, ambiguousProvider: 0, Import: 0,
    campaignVersions: {}, providers: { gmail: 0, smartlead: 0, ambiguous: 0, none: 0 },
  };
  const rows = [];

  for (const lead of staffingLeads) {
    counts.totalStaffing += 1;
    const resolved = resolveLeadFamily(lead);
    const mine = activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`);
    const ownership = authoritativeProvider({ lead, mappings, campaignProviders, activities: mine });
    counts.providers[ownership.provider] = (counts.providers[ownership.provider] || 0) + 1;
    if (!ownership.ok) counts.ambiguousProvider += 1;
    const version = String(lead.intendedCampaignVersion || STAFFING_CAMPAIGN.id);
    counts.campaignVersions[version] = (counts.campaignVersions[version] || 0) + 1;
    if (lead.stage === 'Queued') counts.queued += 1;
    if (lead.stage === 'Import') counts.Import = (counts.Import || 0) + 1;
    if (resolved.family === CAMPAIGN_FAMILY.UNROUTED || !resolved.confident) counts.unroutedUnknownNiche += 1;
    if (hasManualHold(lead)) counts.blockedByManualHold += 1;
    if (sendSuppressionReason(lead, { suppressedEmails })) counts.blockedBySuppression += 1;
    if (!launch.sendable && isStaffingLead(lead)) counts.blockedByStaffingGate += 1;
    if (missingPersonalization(lead)) counts.missingPersonalization += 1;
    if (missingIdentity(lead).length) counts.missingIdentity += 1;
    const sequence = deriveSequenceState(mine);
    if (sequence.sequenceId && familyForLead(lead) !== CAMPAIGN_FAMILY.STAFFING) counts.sequenceInconsistent += 1;
    if (sequence.sequenceId === 'demo_follow_up_v1' && familyForLead(lead) === CAMPAIGN_FAMILY.STAFFING) {
      counts.sequenceInconsistent += 1;
    }

    const route = routedLeadReady(lead, env);
    const preflight = queueEligibility(lead, { leads, activities, boardLeads, suppressedEmails });
    const automation = deriveAutomationOwnership({ ...lead, stage: lead.stage || 'Queued' }, {
      activities: mine, coldCadenceDue: true, sendingEnabled: true,
      suppressionReason: item => sendSuppressionReason(item, { suppressedEmails }),
    });
    const safety = mayColdSend(automation);
    const wouldSend = Boolean(
      launch.sendable && route.ok && safety.allowed && ownership.gmailAllowed
      && (lead.stage === 'Queued' || preflight.ok)
    );
    if (wouldSend) counts.eligibleIfSendingEnabled += 1;
    rows.push({
      leadId: lead.id, email: lead.email, stage: lead.stage, family: resolved.family,
      confident: resolved.confident, provider: ownership.provider, gmailAllowed: ownership.gmailAllowed,
      smartleadAllowed: ownership.smartleadAllowed, routeOk: route.ok, launchSendable: launch.sendable,
      wouldSendIfSendingEnabled: wouldSend, retryableSend: false,
    });
  }

  counts.Queued = counts.queued;
  counts.total = counts.totalStaffing;
  return {
    generatedAt: new Date(now).toISOString(),
    mutated: false,
    launch, sendAuthorization: { allowed: auth.allowed, code: auth.code },
    campaign: { id: STAFFING_CAMPAIGN.id, copyVersion: 'staffing_locked_v1' },
    commercialMailingAddressConfigured: isValidCommercialMailingAddress(
      env.COMMERCIAL_MAILING_ADDRESS || env.MAILING_ADDRESS,
    ),
    commercialMailingAddressLooksLikeTestFixture: looksLikeTestFixtureMailingAddress(
      env.COMMERCIAL_MAILING_ADDRESS || env.MAILING_ADDRESS,
    ),
    counts, rows,
    note: 'Read-only. SENDING_ENABLED remains whatever the environment already is; this report never sends.',
  };
}

function staffingSequenceDiff() {
  const approved = [
    { step: 1, subject: 'employer accounts', delayDays: 0 },
    { step: 2, subject: null, delayDays: 3 },
    { step: 3, subject: null, delayDays: 5 },
  ];
  return {
    campaignId: STAFFING_CAMPAIGN.id,
    copyNote: 'Repo locked copy matches the approved staffing sequence. Email 3 inserts a line break after "Quick question —". Apostrophes are straight, not curly.',
    delays: [0, 3, 5],
    stopOnReply: true,
    maxSteps: 3,
    providerDefault: 'gmail unless CampaignIntegrations maps the campaign to smartlead',
    approved,
  };
}

module.exports = { staffingReadinessReport, staffingSequenceDiff, missingIdentity, missingPersonalization };
