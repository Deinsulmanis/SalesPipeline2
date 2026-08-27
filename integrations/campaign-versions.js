'use strict';

/**
 * Immutable, source-controlled campaign registry. Once a version has sent in
 * production its meaning is never edited; material copy/offer/subject changes
 * require a new id. `activatedAt` is the Step 12 measurement boundary. Events
 * without an explicit stored version remain legacy_unknown regardless of date.
 */
const LEGACY_UNKNOWN = 'legacy_unknown';
const CAMPAIGN_VERSIONS = Object.freeze({
  dental_v1_measured: Object.freeze({
    id: 'dental_v1_measured',
    family: 'dental_ai_receptionist',
    copyVersion: 'dental_risk_reversal_hp_v1',
    subjectStrategy: 'service_curiosity_v1',
    personalizationStrategy: 'dental_hyper_personalization_v1',
    offerVersion: 'three_patients_30d_rr_v1',
    activatedAt: '2026-08-27T20:31:18.220Z',
    status: 'active',
    meaning: 'Current evidence-backed hyper-personalized dental body, service-curiosity subjects, three-patient/30-day risk reversal, and final assembly validation.',
  }),
  roofing_survey_v1_measured: Object.freeze({
    id: 'roofing_survey_v1_measured', family: 'roofing_survey',
    copyVersion: 'roofing_survey_reply_first_v1', subjectStrategy: 'roofing_question_v1',
    personalizationStrategy: 'locked_template_v1', offerVersion: 'none',
    activatedAt: '2026-08-27T20:31:18.220Z', status: 'active',
    meaning: 'Existing locked roofing survey pilot copy; no sales offer.',
  }),
});

const ACTIVE_CAMPAIGN_VERSION = Object.freeze({
  dental_ai_receptionist: 'dental_v1_measured',
  roofing_survey: 'roofing_survey_v1_measured',
});

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function familyForLead(lead = {}) {
  const niche = String(lead.leadNiche || lead.tradeType || '').toLowerCase();
  const template = String(lead.emailTemplateId || '').toLowerCase();
  if (template.includes('roofing') || niche.includes('roof')) return 'roofing_survey';
  if (template.includes('dental') || niche.includes('dent')) return 'dental_ai_receptionist';
  // Existing unrouted production rows are dental unless explicitly roofing.
  return 'dental_ai_receptionist';
}

function campaignVersion(id) {
  const version = CAMPAIGN_VERSIONS[String(id || '')];
  if (!version) throw new Error(`Unknown campaign version "${id || ''}"`);
  return version;
}

function activeVersionForLead(lead = {}) {
  const family = familyForLead(lead);
  const id = ACTIVE_CAMPAIGN_VERSION[family];
  if (!id) throw new Error(`No active campaign version for ${family}`);
  return campaignVersion(id);
}

function coldSendAttribution(lead = {}, step = 1, sendMeta = {}) {
  const version = activeVersionForLead(lead);
  const personalization = sendMeta.personalizationMetadata || {};
  const initial = Number(step) === 1;
  return {
    campaignVersion: version.id,
    campaignFamily: version.family,
    sequenceId: `${version.family}_cold`,
    sequenceStep: Number(step),
    copyVersion: initial ? version.copyVersion : `${version.family}_follow_up_v1`,
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

function buildCampaignVersionIndex(leads = [], activities = []) {
  const byLeadId = new Map();
  for (const lead of leads) {
    const mine = activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`);
    byLeadId.set(lead.id, latestSendAttribution(mine));
  }
  return byLeadId;
}

module.exports = {
  LEGACY_UNKNOWN, CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION,
  familyForLead, campaignVersion, activeVersionForLead, coldSendAttribution,
  stageSequenceAttribution, attributionFromActivity, replyTouchAttribution,
  acquisitionAttribution, latestSendAttribution, promotionAttribution, parseMetadata,
  buildCampaignVersionIndex,
};
