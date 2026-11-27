'use strict';

/**
 * Immutable, source-controlled campaign registry. Once a version has sent in
 * production its meaning is never edited; material copy/offer/subject changes
 * require a new id. `activatedAt` is the Step 12 measurement boundary. Events
 * without an explicit stored version remain legacy_unknown regardless of date.
 */
const LEGACY_UNKNOWN = 'legacy_unknown';
const { staffingLaunchState, staffingCampaign2Open, STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE } = require('./staffing-launch-gate');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, staffingV2Live, isStaffingV2Marked,
  STAFFING_CAMPAIGN_V4, staffingV4Live, isStaffingV4Marked,
  STAFFING_CAMPAIGN_C4, staffingC4Live, isCampaign4Marked,
} = require('./staffing-campaign');
const { readStaffingV4Profile } = require('./staffing-v4-profile');
const { readC4Profile } = require('./campaign-4-profile');
const { resolveV4CopyVersion } = require('./staffing-v4-copy-version');
function staffingCampaign2Status() {
  const launch = staffingLaunchState().status;
  return launch === 'active' && !staffingCampaign2Open() ? 'approved' : launch;
}
const STAFFING_CAMPAIGN_V4_ACTIVATED_AT = '2026-11-20T15:00:00.000Z';

const CAMPAIGN_VERSIONS = Object.freeze({
  [STAFFING_CAMPAIGN.id]: Object.freeze({
    id: STAFFING_CAMPAIGN.id, label: STAFFING_CAMPAIGN.name, niche: STAFFING_CAMPAIGN.niche,
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, family: 'industrial_staffing',
    copyVersion: 'staffing_locked_v1', personalizationStrategy: STAFFING_CAMPAIGN.personalizationStrategy,
    subjectStrategy: 'employer_accounts_locked_v1', offerVersion: 'employer_meetings_performance_v1',
    get status() { return staffingLaunchState().status; },
    get activatedAt() { return staffingLaunchState().activatedAt; },
    meaning: 'Approved employer-meeting copy and personalization. Queueing is permitted; delivery requires separate explicit staffing activation.',
  }),
  // Campaign 2 sends V2's locked copy (Tier A / Tier B Touch 1, V2 Touches 2
  // and 3), so its copy versions are V2's; the campaign version tells it apart.
  [STAFFING_CAMPAIGN_2.id]: Object.freeze({
    id: STAFFING_CAMPAIGN_2.id, label: STAFFING_CAMPAIGN_2.name, niche: STAFFING_CAMPAIGN_2.niche,
    emailTemplateId: STAFFING_CAMPAIGN_2.emailTemplateId, family: 'industrial_staffing',
    copyVersion: 'staffing_locked_v2', followUpCopyVersion: 'industrial_staffing_follow_up_v2',
    personalizationStrategy: STAFFING_CAMPAIGN_2.personalizationStrategy,
    subjectStrategy: 'employer_accounts_locked_v1', offerVersion: 'employer_meetings_performance_v1',
    get status() { return staffingCampaign2Status(); },
    get activatedAt() { return staffingCampaign2Status() === 'active' ? STAFFING_CAMPAIGN_2_SEND_NOT_BEFORE : null; },
    meaning: 'Staffing Outreach Campaign 2: the Industrial Staffing V2 locked copy (Tier A roles-and-market or Tier B positioning Touch 1, V2 Touches 2 and 3, V2 footer), V1 subjects, cadence and offer, attributed separately. No touch may send before 2026-10-23 07:00 America/Vancouver.',
  }),
  // V2 has its own copy for every touch: Email 1 records staffing_locked_v2,
  // Emails 2 and 3 industrial_staffing_follow_up_v2. Same subjects, cadence and
  // offer as V1. Draft (unqueueable, unsendable) until staffing-campaign.js
  // makes V2 live; live, it follows V1's staffing launch gate.
  [STAFFING_CAMPAIGN_V2.id]: Object.freeze({
    id: STAFFING_CAMPAIGN_V2.id, label: STAFFING_CAMPAIGN_V2.name, niche: STAFFING_CAMPAIGN_V2.niche,
    emailTemplateId: STAFFING_CAMPAIGN_V2.emailTemplateId, family: 'industrial_staffing',
    copyVersion: 'staffing_locked_v2', followUpCopyVersion: 'industrial_staffing_follow_up_v2',
    personalizationStrategy: STAFFING_CAMPAIGN_V2.personalizationStrategy,
    subjectStrategy: 'employer_accounts_locked_v1', offerVersion: 'employer_meetings_performance_v1',
    get status() { return staffingV2Live() ? staffingLaunchState().status : 'draft'; },
    activatedAt: null,
    meaning: 'Industrial Staffing V2: V1 targeting, offer, subjects and cadence with V2 copy: a company-named roles-and-market opening, a performance-basis Touch 2 with no landing-page link, and a short close-the-loop Touch 3.',
  }),
  // Industrial Campaign 3 (internally staffing V4): one campaign, six
  // evidence-selected Email 1 variants, shared Emails 2 and 3. Email 1 records
  // industrial_staffing_v4_e1_<variant> (coldSendAttribution), so every send is
  // attributable to its variant. Live, it follows the shared staffing launch gate.
  [STAFFING_CAMPAIGN_V4.id]: Object.freeze({
    id: STAFFING_CAMPAIGN_V4.id, label: STAFFING_CAMPAIGN_V4.name, niche: STAFFING_CAMPAIGN_V4.niche,
    emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, family: 'industrial_staffing',
    copyVersion: 'industrial_staffing_v4_e1', followUpCopyVersion: 'industrial_staffing_v4_follow_up',
    personalizationStrategy: STAFFING_CAMPAIGN_V4.personalizationStrategy,
    subjectStrategy: 'industrial_staffing_v4_variant_subject', offerVersion: 'employer_meetings_performance_v1',
    get status() { return staffingV4Live() ? staffingLaunchState().status : 'draft'; },
    // Owner approval 2026-11-20; first Email 1 sent 2026-11-20 07:01 America/Vancouver.
    get activatedAt() { return this.status === 'active' ? STAFFING_CAMPAIGN_V4_ACTIVATED_AT : null; },
    meaning: 'Industrial Campaign 3: one campaign whose Email 1 is chosen from six approved variants by verified evidence (employer ads, internal sales hiring, expansion, new commercial leader, candidate ads, specialization), with shared Emails 2 and 3.',
  }),
  // Campaign 4 "HOLD Company Test" (owner brief 2026-11-27): the HOLD reply-test
  // cohort. One Email 1 (a conditional opener; nothing verified is claimed) and
  // Campaign 3 copy v2's Emails 2 and 3. Every send records campaignVersion
  // hold_company_test_campaign_4 and copy version c4_v1, so its replies are
  // measured apart from Campaign 3. Live, it follows the shared staffing launch gate.
  [STAFFING_CAMPAIGN_C4.id]: Object.freeze({
    id: STAFFING_CAMPAIGN_C4.id, label: STAFFING_CAMPAIGN_C4.name, niche: STAFFING_CAMPAIGN_C4.niche,
    emailTemplateId: STAFFING_CAMPAIGN_C4.emailTemplateId, family: 'industrial_staffing',
    copyVersion: 'hold_company_test_c4_e1', followUpCopyVersion: 'hold_company_test_c4_follow_up',
    personalizationStrategy: STAFFING_CAMPAIGN_C4.personalizationStrategy,
    subjectStrategy: 'hold_company_test_c4_subject', offerVersion: 'employer_meetings_performance_v1',
    get status() { return staffingC4Live() ? staffingLaunchState().status : 'draft'; },
    // The measurement boundary is set by a reviewed change after the first send.
    activatedAt: null,
    meaning: 'Campaign 4 HOLD Company Test: the HOLD-gate reply test cohort, sent a conditional Email 1 ("If you place warehouse, production or skilled trades workers, ...") with Campaign 3 copy v2 Emails 2 and 3, including the sample-list offer.',
  }),
  dental_v1_measured: Object.freeze({
    id: 'dental_v1_measured',
    label: 'Dental V1 — Measured',
    niche: 'dental',
    emailTemplateId: 'dental-guarantee-v1',
    family: 'dental_ai_receptionist',
    copyVersion: 'dental_risk_reversal_hp_v1',
    subjectStrategy: 'service_curiosity_v1',
    personalizationStrategy: 'dental_hyper_personalization_v1',
    offerVersion: 'three_patients_30d_rr_v1',
    activatedAt: '2026-08-27T20:31:18.220Z',
    status: 'retired',
    meaning: 'Historical evidence-backed hyper-personalized dental body, service-curiosity subjects, three-patient/30-day risk reversal, and final assembly validation.',
  }),
  dental_v2_answering_booking: Object.freeze({
    id: 'dental_v2_answering_booking',
    label: 'Dental V2 — Answering & Booking',
    niche: 'dental',
    emailTemplateId: 'dental-guarantee-v1',
    family: 'dental_ai_receptionist',
    copyVersion: 'dental_risk_reversal_hp_v2',
    followUpCopyVersion: 'dental_answering_booking_follow_up_v2',
    subjectStrategy: 'service_curiosity_v1',
    personalizationStrategy: 'dental_hyper_personalization_v1',
    offerVersion: 'three_patients_30d_rr_v1',
    activatedAt: '2026-08-28T23:06:42.340Z',
    status: 'retired',
    meaning: 'Dental V2 preserves the measured offer, subjects, personalization, CTA and cadence while positioning the product as 24/7 answering and booking software.',
  }),
  dental_v3_pay_per_booking: Object.freeze({
    id: 'dental_v3_pay_per_booking',
    label: 'Dental V3 — Pay Per Booking',
    niche: 'dental',
    emailTemplateId: 'dental-guarantee-v1',
    family: 'dental_ai_receptionist',
    copyVersion: 'dental_pay_per_booking_hp_v3',
    followUpCopyVersion: 'dental_answering_booking_follow_up_v2',
    subjectStrategy: 'verified_service_curiosity_v2',
    personalizationStrategy: 'dental_hyper_personalization_v1',
    offerVersion: 'pay_per_booked_appointment_v1',
    activatedAt: '2026-08-28T23:13:22.640Z',
    // The dental offer was retired on 2026-09-30 (lead-archive RETIRED_OFFERS).
    // Its meaning is unchanged; it can no longer be selected for a send.
    status: 'retired',
    retiredAt: '2026-09-30',
    meaning: 'Dental V3 uses only verified service-curiosity subjects and charges only for appointments booked through the system, with no volume or timeframe promise.',
  }),
  roofing_survey_v1_measured: Object.freeze({
    id: 'roofing_survey_v1_measured', label: 'Roofing Survey V1 — Measured',
    niche: 'roofing', emailTemplateId: 'roofing-survey-v1', family: 'roofing_survey',
    copyVersion: 'roofing_survey_reply_first_v1', subjectStrategy: 'roofing_question_v1',
    personalizationStrategy: 'locked_template_v1', offerVersion: 'none',
    activatedAt: '2026-08-27T20:31:18.220Z', status: 'retired', retiredAt: '2026-09-30',
    meaning: 'Existing locked roofing survey pilot copy; no sales offer.',
  }),
});

// Which version each family sends today. Naming a version here does NOT activate
// it: activeVersionForLead still refuses any version whose status is not
// 'active', so the staffing entry stays inert until the campaign is activated.
const ACTIVE_CAMPAIGN_VERSION = Object.freeze({
  dental_ai_receptionist: 'dental_v3_pay_per_booking',
  roofing_survey: 'roofing_survey_v1_measured',
  industrial_staffing: STAFFING_CAMPAIGN.id,
});

const CAMPAIGN_FAMILY = Object.freeze({
  DENTAL: 'dental_ai_receptionist',
  ROOFING: 'roofing_survey',
  STAFFING: 'industrial_staffing',
  UNROUTED: 'unrouted',
});

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function familyFromText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  if (text.includes('staffing')) return CAMPAIGN_FAMILY.STAFFING;
  if (text.includes('roof')) return CAMPAIGN_FAMILY.ROOFING;
  if (text.includes('dent')) return CAMPAIGN_FAMILY.DENTAL;
  return null;
}

function familyFromCampaignVersionId(id) {
  const version = CAMPAIGN_VERSIONS[String(id || '').trim()];
  return version ? version.family : null;
}

// A managed client's lead belongs to its client's campaign registry, not to
// ScaleLab's keyword families (Jole's copy says "staffing"; it is not
// ScaleLab's staffing offer). Its family is that campaign's lead type. Lazy
// require: clients/ modules load routing helpers that load this file.
function managedCampaignForLead(lead = {}) {
  const { clientCampaign } = require('./clients/campaigns');
  return clientCampaign(lead.intendedCampaignVersion) || clientCampaign(lead.campaign) || null;
}

function isManagedFamily(family) {
  const { CLIENT_LEAD_TYPES } = require('./clients/campaigns');
  return CLIENT_LEAD_TYPES.some(type => type.id === family);
}

function resolveLeadFamily(lead = {}) {
  const managed = managedCampaignForLead(lead);
  if (managed) {
    const owner = String(lead.clientId || '').trim();
    if (owner && owner !== managed.clientId) {
      return { family: CAMPAIGN_FAMILY.UNROUTED, confident: false, reason: `campaign ${managed.id} belongs to ${managed.clientId}, the lead to ${owner}` };
    }
    // A ScaleLab family named on the lead's niche or template is a conflict, never a tie-break.
    const legacy = [familyFromText(lead.leadNiche), familyFromText(lead.emailTemplateId)].filter(Boolean);
    if (legacy.length) {
      return { family: CAMPAIGN_FAMILY.UNROUTED, confident: false, candidates: [managed.leadType, ...legacy], reason: 'campaign mapping is ambiguous' };
    }
    return { family: managed.leadType, confident: true, reason: '', managed: true, clientId: managed.clientId, campaignId: managed.id };
  }
  const signals = [
    familyFromText(lead.leadNiche),
    familyFromText(lead.tradeType),
    familyFromText(lead.emailTemplateId),
    familyFromCampaignVersionId(lead.intendedCampaignVersion),
    familyFromText(lead.campaign),
    familyFromText(lead.campaignFamily),
  ].filter(Boolean);
  const unique = [...new Set(signals)];
  if (!unique.length) {
    return {
      family: CAMPAIGN_FAMILY.UNROUTED, confident: false,
      reason: 'niche, template, and campaign mapping are blank or unknown',
    };
  }
  if (unique.length > 1) {
    return {
      family: CAMPAIGN_FAMILY.UNROUTED, confident: false, candidates: unique,
      reason: 'campaign mapping is ambiguous',
    };
  }
  return { family: unique[0], confident: true, reason: '' };
}

function familyForLead(lead = {}) {
  return resolveLeadFamily(lead).family;
}

function campaignVersion(id) {
  const version = CAMPAIGN_VERSIONS[String(id || '')];
  if (!version) throw new Error(`Unknown campaign version "${id || ''}"`);
  return version;
}

// evidenceOnly: attribute a send that ALREADY happened (Gmail SENT evidence
// being recorded or reconciled). A retired version still describes what it
// sent; it just can never be chosen for a new send.
function activeVersionForLead(lead = {}, { evidenceOnly = false } = {}) {
  const resolved = resolveLeadFamily(lead);
  const family = resolved.family;
  if (family === CAMPAIGN_FAMILY.UNROUTED) {
    const intendedFamily = familyFromCampaignVersionId(lead.intendedCampaignVersion);
    const nicheFamily = familyFromText(lead.leadNiche) || familyFromText(lead.tradeType)
      || familyFromText(lead.emailTemplateId) || familyFromText(lead.campaign);
    if (intendedFamily && nicheFamily && intendedFamily !== nicheFamily) {
      throw new Error(`Campaign version ${lead.intendedCampaignVersion} is incompatible with ${nicheFamily}`);
    }
    throw new Error(resolved.reason || 'Campaign family is unrouted');
  }
  if (resolved.managed) return managedCampaignVersion(managedCampaignForLead(lead), lead, { evidenceOnly });
  const id = String(lead.intendedCampaignVersion || '').trim() || ACTIVE_CAMPAIGN_VERSION[family];
  if (!id) throw new Error(`No active campaign version for ${family}`);
  const version = campaignVersion(id);
  if (version.status !== 'active' && !(evidenceOnly && version.status === 'retired')) {
    throw new Error(`Campaign version ${id} is not active`);
  }
  if (version.family !== family) throw new Error(`Campaign version ${id} is incompatible with ${family}`);
  if (version.emailTemplateId && lead.emailTemplateId && version.emailTemplateId !== lead.emailTemplateId) {
    throw new Error(`Campaign version ${id} is incompatible with template ${lead.emailTemplateId}`);
  }
  // The staffing family's active version is V1. A lead that names V2 anywhere
  // (label, template, version, V2 sourcing profile) resolves to V2 or to
  // nothing: a blank or V1 version never makes it a V1 send.
  if (family === CAMPAIGN_FAMILY.STAFFING && isStaffingV2Marked(lead) && version.id !== STAFFING_CAMPAIGN_V2.id) {
    throw new Error(`staffing V2 lead requires campaign version ${STAFFING_CAMPAIGN_V2.id}; it never falls back to V1`);
  }
  if (family === CAMPAIGN_FAMILY.STAFFING && isStaffingV4Marked(lead) && version.id !== STAFFING_CAMPAIGN_V4.id) {
    throw new Error(`staffing V4 lead requires campaign version ${STAFFING_CAMPAIGN_V4.id}; it never falls back to V1 or V2`);
  }
  if (family === CAMPAIGN_FAMILY.STAFFING && isCampaign4Marked(lead) && version.id !== STAFFING_CAMPAIGN_C4.id) {
    throw new Error(`Campaign 4 lead requires campaign version ${STAFFING_CAMPAIGN_C4.id}; it never falls back to another campaign`);
  }
  if (version.id === STAFFING_CAMPAIGN_C4.id && !isCampaign4Marked(lead)) {
    throw new Error(`campaign version ${STAFFING_CAMPAIGN_C4.id} needs a Campaign 4 lead`);
  }
  return version;
}

// A managed campaign's version, in the shape ScaleLab versions have, so the
// one attribution and delivery path serves both. Approved (or active) only.
function managedCampaignVersion(campaign, lead = {}, { evidenceOnly = false } = {}) {
  const { CAMPAIGN_STATUS } = require('./clients/campaigns');
  const live = [CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.ACTIVE].includes(campaign.status) && !campaign.archivedAt;
  if (!live && !evidenceOnly) throw new Error(`Campaign ${campaign.id} is not approved`);
  if (lead.emailTemplateId && campaign.emailTemplateId !== lead.emailTemplateId) {
    throw new Error(`Campaign ${campaign.id} is incompatible with template ${lead.emailTemplateId}`);
  }
  return Object.freeze({
    id: campaign.campaignVersion || campaign.id, label: campaign.label, niche: campaign.leadType,
    emailTemplateId: campaign.emailTemplateId, family: campaign.leadType, clientId: campaign.clientId,
    copyVersion: campaign.copyVersion || '', followUpCopyVersion: campaign.copyVersion || '',
    subjectStrategy: campaign.subjectStrategy || '', personalizationStrategy: campaign.personalizationStrategy || '',
    offerVersion: campaign.offerVersion || '', status: live ? 'active' : 'retired',
  });
}

function coldSendAttribution(lead = {}, step = 1, sendMeta = {}, { evidenceOnly = false } = {}) {
  const version = activeVersionForLead(lead, { evidenceOnly });
  const personalization = sendMeta.personalizationMetadata || {};
  const initial = Number(step) === 1;
  if (version.id === STAFFING_CAMPAIGN_V4.id) {
    // The sealed profile's variant; an unreadable profile cannot be attributed (or sent).
    const read = readStaffingV4Profile(lead);
    if (!read.ok || read.profile.copy_status !== 'SELECTED') throw new Error('staffing V4 send has no sealed copy variant');
    const variant = read.profile.copy_variant;
    // Copy version pinned per lead (staffing-v4-copy-version.js). It is recorded
    // on every send as staffingCopyVersion, which also pins the thread's later
    // touches, and named in copyVersion so reply rates compare v1 vs v2 by
    // variant: industrial_staffing_v4_e1_copy_c (v1), ..._e1_v2_copy_c (v2),
    // industrial_staffing_v4_follow_up (v1), ..._follow_up_v2 (v2).
    const staffingCopyVersion = sendMeta.staffingCopyVersion
      || resolveV4CopyVersion(lead, sendMeta.activities, { sealedCopyVersion: read.sealedCopyVersion }).copyVersion;
    const suffix = staffingCopyVersion === 'v1' ? '' : `_${staffingCopyVersion}`;
    return {
      campaignVersion: version.id, campaignFamily: version.family, sequenceId: `${version.family}_cold`,
      sequenceStep: Number(step), staffingCopyVersion,
      copyVersion: initial ? `${version.copyVersion}${suffix}_${variant.toLowerCase()}` : `${version.followUpCopyVersion}${suffix}`,
      subjectStrategy: initial ? version.subjectStrategy : 'thread_follow_up_v1',
      personalizationStrategy: version.personalizationStrategy,
      personalizationLevel: null, personalizationAngle: variant, copyVariant: variant,
      offerVersion: version.offerVersion,
    };
  }
  if (version.id === STAFFING_CAMPAIGN_C4.id) {
    // The sealed profile's copy version; an unreadable profile cannot be attributed (or sent).
    const read = readC4Profile(lead, { campaignId: STAFFING_CAMPAIGN_C4.id });
    if (!read.ok) throw new Error('Campaign 4 send has no sealed profile');
    const staffingCopyVersion = sendMeta.staffingCopyVersion || read.copyVersion;
    if (staffingCopyVersion !== read.copyVersion) throw new Error('Campaign 4 send copy version differs from its sealed profile');
    return {
      campaignVersion: version.id, campaignFamily: version.family, sequenceId: `${version.family}_cold`,
      sequenceStep: Number(step), staffingCopyVersion,
      copyVersion: initial ? `${version.copyVersion}_${staffingCopyVersion}` : `${version.followUpCopyVersion}_${staffingCopyVersion}`,
      subjectStrategy: initial ? version.subjectStrategy : 'thread_follow_up_v1',
      personalizationStrategy: version.personalizationStrategy,
      personalizationLevel: null, personalizationAngle: 'C4_CONDITIONAL_OPENER', copyVariant: 'C4_CONDITIONAL_OPENER',
      offerVersion: version.offerVersion,
    };
  }
  return {
    campaignVersion: version.id,
    campaignFamily: version.family,
    sequenceId: `${version.family}_cold`,
    sequenceStep: Number(step),
    copyVersion: initial ? version.copyVersion : (version.followUpCopyVersion || `${version.family}_follow_up_v1`),
    subjectStrategy: initial ? version.subjectStrategy : 'thread_follow_up_v1',
    personalizationStrategy: version.personalizationStrategy,
    personalizationLevel: personalization.personalizationLevel ?? null,
    personalizationAngle: personalization.selectedAngle || '',
    offerVersion: version.offerVersion,
  };
}

function stageSequenceAttribution({ acquisition = {}, sequenceId, step }) {
  const id = String(sequenceId || '');
  if (!id) throw new Error('Stage sequence attribution requires sequenceId');
  return {
    campaignVersion: acquisition.campaignVersion || LEGACY_UNKNOWN,
    campaignFamily: acquisition.campaignFamily || '',
    sequenceId: id,
    sequenceVersion: id.match(/_v\d+$/)?.[0].slice(1) || 'v1',
    sequenceStep: Number(step),
    copyVersion: id,
    subjectStrategy: 'conversation_thread_v1',
    personalizationStrategy: 'canonical_conversation_context_v1',
    personalizationLevel: null,
    personalizationAngle: '',
    offerVersion: acquisition.offerVersion || '',
  };
}

function attributionFromActivity(row = {}) {
  const metadata = parseMetadata(row.metadata);
  if (!metadata.campaignVersion) return { campaignVersion: LEGACY_UNKNOWN };
  return {
    campaignVersion: metadata.campaignVersion,
    campaignFamily: metadata.campaignFamily || '',
    sequenceId: metadata.sequenceId || '', sequenceVersion: metadata.sequenceVersion || '',
    sequenceStep: Number(metadata.sequenceStep || metadata.step || 0) || null,
    copyVersion: metadata.copyVersion || '', subjectStrategy: metadata.subjectStrategy || '',
    personalizationStrategy: metadata.personalizationStrategy || '',
    personalizationLevel: metadata.personalizationLevel ?? null,
    personalizationAngle: metadata.personalizationAngle || '', offerVersion: metadata.offerVersion || '',
    sourceSendEventId: row.eventId || '',
    sourceMessageId: metadata.gmailMessageId || metadata.providerMessageId || '',
    sourceThreadId: metadata.gmailThreadId || '',
  };
}

const OUTBOUND_TYPES = new Set(['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent']);
function replyTouchAttribution(reply = {}, activities = []) {
  const replyMeta = parseMetadata(reply.metadata);
  const threadId = String(replyMeta.gmailThreadId || reply.threadId || '');
  const replyAt = new Date(reply.occurredAt || Date.now()).getTime();
  const candidates = activities.filter(row => {
    if (!OUTBOUND_TYPES.has(String(row.eventType || ''))) return false;
    const at = new Date(row.occurredAt || 0).getTime();
    if (!Number.isFinite(at) || at > replyAt) return false;
    const metadata = parseMetadata(row.metadata);
    return threadId && String(metadata.gmailThreadId || '') === threadId;
  }).sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0));
  return candidates.length ? attributionFromActivity(candidates[0]) : { campaignVersion: LEGACY_UNKNOWN };
}

function acquisitionAttribution(activities = []) {
  const promoted = activities
    .filter(row => row.eventType === 'pipeline_promoted')
    .sort((a, b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0));
  for (const row of promoted) {
    const metadata = parseMetadata(row.metadata);
    if (metadata.acquisitionCampaignVersion) return {
      campaignVersion: metadata.acquisitionCampaignVersion,
      campaignFamily: metadata.acquisitionCampaignFamily || '',
      sourceSendEventId: metadata.acquisitionSourceEventId || '',
      sourceMessageId: metadata.acquisitionSourceMessageId || '',
    };
  }
  return { campaignVersion: LEGACY_UNKNOWN };
}

function latestSendAttribution(activities = []) {
  const rows = activities.filter(row => OUTBOUND_TYPES.has(String(row.eventType || '')))
    .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0));
  return rows.length ? attributionFromActivity(rows[0]) : { campaignVersion: LEGACY_UNKNOWN };
}

function promotionAttribution(touch = {}, existing = {}) {
  if (existing.campaignVersion && existing.campaignVersion !== LEGACY_UNKNOWN) return {
    acquisitionCampaignVersion: existing.campaignVersion,
    acquisitionCampaignFamily: existing.campaignFamily || '',
    acquisitionSourceEventId: existing.sourceSendEventId || '',
    acquisitionSourceMessageId: existing.sourceMessageId || '',
  };
  return {
    acquisitionCampaignVersion: touch.campaignVersion || LEGACY_UNKNOWN,
    acquisitionCampaignFamily: touch.campaignFamily || '',
    acquisitionSourceEventId: touch.sourceSendEventId || '',
    acquisitionSourceMessageId: touch.sourceMessageId || '',
  };
}

// A lead's rows are those whose sourceLeadId is the lead id or whose leadId is
// `CE-<id>` (strict equality, as always). They used to be found by scanning the
// whole activity log once per lead: 4,800 leads x 25,000 rows took seconds of
// every dashboard snapshot. The outbound rows are now indexed once under both
// keys and merged back in log order, so latestSendAttribution sees exactly the
// rows, in exactly the order, it saw before.
function buildCampaignVersionIndex(leads = [], activities = []) {
  const bySourceLeadId = new Map();
  const byLeadKey = new Map();
  const add = (map, key, entry) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(entry); else map.set(key, [entry]);
  };
  activities.forEach((row, index) => {
    if (!OUTBOUND_TYPES.has(String(row.eventType || ''))) return;
    const entry = { row, index };
    add(bySourceLeadId, row.sourceLeadId, entry);
    add(byLeadKey, row.leadId, entry);
  });
  const byLeadId = new Map();
  for (const lead of leads) {
    const a = bySourceLeadId.get(lead.id) || [];
    const b = byLeadKey.get(`CE-${lead.id}`) || [];
    const mine = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i].index < b[j].index)) mine.push(a[i++].row);
      else if (i >= a.length || b[j].index < a[i].index) mine.push(b[j++].row);
      else { mine.push(a[i].row); i++; j++; } // the same row matched both keys
    }
    byLeadId.set(lead.id, latestSendAttribution(mine));
  }
  return byLeadId;
}

module.exports = {
  LEGACY_UNKNOWN, CAMPAIGN_FAMILY, CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION,
  familyForLead, resolveLeadFamily, campaignVersion, activeVersionForLead, coldSendAttribution, isManagedFamily,
  stageSequenceAttribution, attributionFromActivity, replyTouchAttribution,
  acquisitionAttribution, latestSendAttribution, promotionAttribution, parseMetadata,
  buildCampaignVersionIndex,
};
