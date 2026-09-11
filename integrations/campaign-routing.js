'use strict';

const { CAMPAIGN_VERSIONS } = require('./campaign-versions');
const { STAFFING_CAMPAIGN } = require('./staffing-campaign');

const EMAIL_TEMPLATES = Object.freeze([
  Object.freeze({ id: STAFFING_CAMPAIGN.emailTemplateId, name: STAFFING_CAMPAIGN.name,
    niche: STAFFING_CAMPAIGN.niche, ready: false, sequenceSteps: 3,
    reason: 'Staffing personalization is review-only; campaign is not approved for sending' }),
  Object.freeze({ id: 'dental-guarantee-v1', name: 'Dental guarantee pitch', niche: 'dental', ready: true, sequenceSteps: 3 }),
  Object.freeze({
    id: 'roofing-survey-v1', name: 'Roofing survey — reply first', niche: 'roofing',
    ready: process.env.ROOFING_SURVEY_REPLY_FLOW_ENABLED === 'true',
    reason: 'Roofing survey workflow is disabled; set ROOFING_SURVEY_REPLY_FLOW_ENABLED=true only for an approved pilot',
    sequenceSteps: 1, profile: 'roofing_survey_reply_first',
  }),
]);

/**
 * The canonical lead types the CRM recognises.
 *
 * One canonical id is stored; aliases exist only so legacy and human-entered
 * spellings normalise onto it. UI labels come from here too, so a lead type
 * cannot be added to one dropdown and forgotten in another.
 */
const LEAD_TYPES = Object.freeze([
  Object.freeze({ id: 'dental', label: 'Dental',
    aliases: Object.freeze(['dentist', 'dentists', 'dental clinic', 'dental']) }),
  Object.freeze({ id: 'roofing', label: 'Roofing',
    aliases: Object.freeze(['roofer', 'roofers', 'roofing company', 'roofing']) }),
  Object.freeze({ id: 'industrial_staffing', label: 'Staffing Agency',
    aliases: Object.freeze(['industrial_staffing', 'industrial staffing', 'staffing',
      'staffing_agency', 'staffing agency']) }),
]);
const LEAD_TYPE_IDS = Object.freeze(LEAD_TYPES.map(type => type.id));

function normalizeNiche(value) {
  const niche = String(value || '').trim().toLowerCase();
  const match = LEAD_TYPES.find(type => type.id === niche || type.aliases.includes(niche));
  // Unknown values pass through unchanged rather than defaulting to a niche;
  // downstream validation refuses them.
  return match ? match.id : niche;
}

/** Human-facing name for a canonical lead type; unknown ids render as themselves. */
function leadTypeLabel(value) {
  const id = normalizeNiche(value);
  return (LEAD_TYPES.find(type => type.id === id) || {}).label || id;
}

function isKnownLeadType(value) {
  return LEAD_TYPE_IDS.includes(normalizeNiche(value));
}

function templateById(id) { return EMAIL_TEMPLATES.find(template => template.id === String(id || '').trim()) || null; }

function campaignVersionsForRoute({ niche, emailTemplateId = '' } = {}) {
  const normalizedNiche = normalizeNiche(niche);
  return Object.values(CAMPAIGN_VERSIONS).filter(version => version.status === 'active'
    && version.niche === normalizedNiche
    && (!emailTemplateId || version.emailTemplateId === emailTemplateId));
}

function validateCampaignVersionRoute({ niche, emailTemplateId, campaignVersionId } = {}) {
  const version = CAMPAIGN_VERSIONS[String(campaignVersionId || '').trim()];
  if (!version || version.status !== 'active') return { ok: false, reason: 'An active registered campaign version is required' };
  const normalizedNiche = normalizeNiche(niche);
  if (version.niche !== normalizedNiche) return { ok: false, reason: `${version.label} cannot be used for ${normalizedNiche} leads` };
  if (version.emailTemplateId !== String(emailTemplateId || '').trim()) return { ok: false, reason: `${version.label} does not use the selected email copy` };
  return { ok: true, version };
}

function validateRoute({ niche, senderInboxId, emailTemplateId, inboxes = [], requireReady = true } = {}) {
  const normalizedNiche = normalizeNiche(niche);
  const template = templateById(emailTemplateId);
  const inbox = inboxes.find(item => item.id === senderInboxId);
  if (!normalizedNiche) return { ok: false, reason: 'Lead niche is required' };
  if (!inbox) return { ok: false, reason: 'A registered sending inbox is required' };
  if (!inbox.sendEligible) return { ok: false, reason: `${inbox.email} is not eligible to send` };
  if (!inbox.deliveryImplemented) return { ok: false, reason: `${inbox.email} is connected but sender routing is not active yet` };
  if (!template) return { ok: false, reason: 'A registered email template is required' };
  if (template.niche !== normalizedNiche) return { ok: false, reason: `${template.name} cannot be used for ${normalizedNiche} leads` };
  if (requireReady && !template.ready) return { ok: false, reason: template.reason || `${template.name} is not ready` };
  return { ok: true, niche: normalizedNiche, inbox, template };
}

function routedLeadReady(lead) {
  // Staffing is a post-routing campaign: it has never had unrouted production
  // rows, so it may not use the legacy bypass that exists for old dental and
  // roofing records. A staffing row without explicit routing is refused.
  const staffing = normalizeNiche(lead.leadNiche) === 'industrial_staffing'
    || String(lead.emailTemplateId || '').includes('staffing');
  if (!staffing && String(lead.routingRequired || '').toLowerCase() !== 'true') return { ok: true, legacy: true };
  if (!lead.leadNiche || !lead.senderInboxId || !lead.emailTemplateId) return { ok: false, reason: 'routing assignment is incomplete' };
  const template = templateById(lead.emailTemplateId);
  if (!template?.ready) return { ok: false, reason: template?.reason || 'email template is unavailable' };
  if (template.niche !== normalizeNiche(lead.leadNiche)) return { ok: false, reason: 'email template does not match lead niche' };
  return { ok: true, legacy: false, template };
}

module.exports = {
  EMAIL_TEMPLATES, LEAD_TYPES, LEAD_TYPE_IDS, normalizeNiche, leadTypeLabel, isKnownLeadType,
  templateById, campaignVersionsForRoute,
  validateCampaignVersionRoute, validateRoute, routedLeadReady,
};
