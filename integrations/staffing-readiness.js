'use strict';

const { STAFFING_CAMPAIGN, staffingOpeningFor, staffingNoPersonalizationAllowed, renderStaffingEmail, validateStaffingEmail } = require('./staffing-campaign');
const { staffingLaunchState, isStaffingLead } = require('./staffing-launch-gate');
const { CAMPAIGN_FAMILY, resolveLeadFamily, familyForLead } = require('./campaign-versions');
const { routedLeadReady } = require('./campaign-routing');
const { queueEligibility } = require('./outreach-queue');
const { sendSuppressionReason } = require('./pipeline-state');
const { deriveAutomationOwnership, mayColdSend } = require('./automation-ownership');
const { sendAuthorization } = require('./send-authorization');
const { authoritativeProvider } = require('./provider-ownership');
const { deriveSequenceState } = require('./stage-sequences');
const { describeSequence, NOMINAL_TOUCH_DAYS, FOLLOW_UP_STEP_COUNT } = require('./sequence-timing');
const { isValidCommercialMailingAddress, looksLikeTestFixtureMailingAddress } = require('./staffing-compliance');

// ── Per-report lookup indexes ───────────────────────────────────────────────
// The report visits every staffing lead. Filtering the whole activity log, the
// whole corpus and the board once per lead made a single report tens of
// millions of comparisons (6-17 s in production). These indexes are built once
// per report and hand each lead a SUPERSET of the rows any per-lead filter
// below can select, in their original order. Every filter still runs, unchanged,
// on that subset, so each lead sees exactly the rows it saw before.

const normalizeKey = value => String(value || '').trim().toLowerCase();

/** key → ascending row positions. Keys are used verbatim (blank included). */
function positionsBy(rows, keyOf) {
  const index = new Map();
  rows.forEach((row, position) => {
    const key = keyOf(row);
    const list = index.get(key);
    if (list) list.push(position); else index.set(key, [position]);
  });
  return index;
}

/** The rows at the union of several position lists, deduplicated, in original order. */
function rowsAt(rows, ...lists) {
  const positions = new Set();
  for (const list of lists) if (list) for (const position of list) positions.add(position);
  return [...positions].sort((a, b) => a - b).map(position => rows[position]);
}

function readinessIndexes({ leads, activities, boardLeads }) {
  return {
    leadsById: positionsBy(leads, lead => lead.id),
    leadsByEmail: positionsBy(leads, lead => normalizeKey(lead.email)),
    activitiesBySourceLeadId: positionsBy(activities, row => row.sourceLeadId),
    activitiesByLeadId: positionsBy(activities, row => row.leadId),
    activitiesByEmail: positionsBy(activities, row => normalizeKey(row.email)),
    boardById: positionsBy(boardLeads, row => row.id),
    boardByEmail: positionsBy(boardLeads, row => normalizeKey(row.email)),
  };
}

function hasManualHold(lead = {}) {
  return String(lead.notes || '').includes('[MANUAL HOLD]');
}

function missingPersonalization(lead) {
  return !staffingOpeningFor(lead) && !staffingNoPersonalizationAllowed(lead);
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
  const index = readinessIndexes({ leads, activities, boardLeads });

  for (const lead of staffingLeads) {
    counts.totalStaffing += 1;
    const resolved = resolveLeadFamily(lead);
    const ceId = `CE-${lead.id}`;
    const mine = rowsAt(activities, index.activitiesBySourceLeadId.get(lead.id), index.activitiesByLeadId.get(ceId))
      .filter(row => row.sourceLeadId === lead.id || row.leadId === ceId);
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
    // queueEligibility matches leads by id and by email, activities by
    // sourceLeadId, by leadId (bare or CE-) or by email, and board cards by id
    // (bare or CE-) or by email. It receives every row that could match any of
    // those and applies its own rules to them.
    const email = normalizeKey(lead.email);
    const preflight = queueEligibility(lead, {
      leads: rowsAt(leads, index.leadsById.get(lead.id), index.leadsByEmail.get(email)),
      activities: rowsAt(activities, index.activitiesBySourceLeadId.get(lead.id),
        index.activitiesByLeadId.get(lead.id), index.activitiesByLeadId.get(ceId), index.activitiesByEmail.get(email)),
      boardLeads: rowsAt(boardLeads, index.boardById.get(lead.id), index.boardById.get(ceId), index.boardByEmail.get(email)),
      suppressedEmails,
    });
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

// Timing is read from integrations/sequence-timing.js, never restated here.
function staffingSequenceDiff() {
  const approved = describeSequence().map(item => ({
    step: item.step, subject: item.step === 1 ? 'employer accounts' : null, day: item.day, timing: item.rule,
  }));
  return {
    campaignId: STAFFING_CAMPAIGN.id,
    copyNote: 'Repo locked copy matches the approved staffing sequence. Email 3 asks the single question and signs off "Deins". Apostrophes are straight, not curly.',
    days: [...NOMINAL_TOUCH_DAYS],
    stopOnReply: true,
    maxSteps: FOLLOW_UP_STEP_COUNT + 1,
    providerDefault: 'gmail unless CampaignIntegrations maps the campaign to smartlead',
    approved,
  };
}

module.exports = { staffingReadinessReport, staffingSequenceDiff, missingIdentity, missingPersonalization };
