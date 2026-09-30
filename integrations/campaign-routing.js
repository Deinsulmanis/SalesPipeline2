'use strict';

const { CAMPAIGN_VERSIONS, CAMPAIGN_FAMILY, resolveLeadFamily } = require('./campaign-versions');
const { staffingSendBlockReason, isStaffingLead } = require('./staffing-launch-gate');
const { STAFFING_CAMPAIGN } = require('./staffing-campaign');
const { isStaffingOnlySender } = require('./gmail-inbox-registry');
const { getClient } = require('./clients/registry');
const { clientCampaign, clientTemplate, clientLeadType, campaignSendable } = require('./clients/campaigns');
const { checkClientConsistency, resolveLeadClient } = require('./clients/ownership');
const { clientSendBlock } = require('./clients/send-policy');
const { outreachBlockForLead, RETIRED_OFFERS } = require('./lead-archive');

const EMAIL_TEMPLATES = Object.freeze([
  Object.freeze({ id: STAFFING_CAMPAIGN.emailTemplateId, name: STAFFING_CAMPAIGN.name,
    niche: STAFFING_CAMPAIGN.niche, ready: STAFFING_CAMPAIGN.ready, sequenceSteps: 3,
    reason: '' }),
  // Retired with the dental offer (lead-archive RETIRED_OFFERS). Kept registered
  // so historical sends still resolve their copy; never ready again.
  Object.freeze({ id: 'dental-guarantee-v1', name: 'Dental guarantee pitch', niche: 'dental', ready: false, sequenceSteps: 3,
    reason: 'The dental offer is retired; dental email copy can no longer be sent' }),
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
  // Managed-client lead types (clients/campaigns.js) normalise too, but stay
  // out of LEAD_TYPES: the legacy import and its dropdowns remain ScaleLab's.
  const clientType = clientLeadType(niche);
  if (clientType) return clientType.id;
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

function templateById(id) {
  return EMAIL_TEMPLATES.find(template => template.id === String(id || '').trim()) || clientTemplate(id) || null;
}

// Every route names one client end to end: the lead's own fields, the sender,
// the template and the campaign. The inbox rows callers pass may omit clientId
// (sender-balance strips it), so the sender is resolved by id from the
// configured registry in that case, never assumed.
function routeClientVerdict({ lead = null, niche, inbox, emailTemplateId, campaignVersionId }) {
  const hasClient = inbox && Object.prototype.hasOwnProperty.call(inbox, 'clientId');
  return checkClientConsistency({
    lead: { ...(lead || {}), leadNiche: niche, emailTemplateId, senderInboxId: '' },
    ...(hasClient ? { sender: inbox } : { senderInboxId: inbox?.id || '' }),
    templateId: emailTemplateId, campaignId: campaignVersionId || lead?.intendedCampaignVersion || '',
  });
}

function campaignVersionsForRoute({ niche, emailTemplateId = '' } = {}) {
  const normalizedNiche = normalizeNiche(niche);
  return Object.values(CAMPAIGN_VERSIONS).filter(version => (version.status === 'active' || (version.id === STAFFING_CAMPAIGN.id && version.status === 'approved'))
    && version.niche === normalizedNiche
    && (!emailTemplateId || version.emailTemplateId === emailTemplateId));
}

function validateCampaignVersionRoute({ niche, emailTemplateId, campaignVersionId } = {}) {
  const managed = clientCampaign(campaignVersionId);
  if (managed) {
    const sendable = campaignSendable(managed);
    if (!sendable.ok) return { ok: false, reason: sendable.reason };
    if (managed.leadType !== normalizeNiche(niche)) return { ok: false, reason: `${managed.label} cannot be used for ${normalizeNiche(niche)} leads` };
    if (managed.emailTemplateId !== String(emailTemplateId || '').trim()) return { ok: false, reason: `${managed.label} does not use the selected email copy` };
    return { ok: true, version: { id: managed.id, label: managed.label, niche: managed.leadType, emailTemplateId: managed.emailTemplateId, clientId: managed.clientId } };
  }
  const version = CAMPAIGN_VERSIONS[String(campaignVersionId || '').trim()];
  if (!version || !(version.status === 'active' || (version.id === STAFFING_CAMPAIGN.id && version.status === 'approved'))) return { ok: false, reason: 'An approved registered campaign version is required' };
  const normalizedNiche = normalizeNiche(niche);
  if (version.niche !== normalizedNiche) return { ok: false, reason: `${version.label} cannot be used for ${normalizedNiche} leads` };
  if (version.emailTemplateId !== String(emailTemplateId || '').trim()) return { ok: false, reason: `${version.label} does not use the selected email copy` };
  return { ok: true, version };
}

// A lead type whose offer is retired can never be routed, queued or balanced.
function retiredLeadType(niche) {
  return RETIRED_OFFERS.find(offer => offer.leadType === niche) || null;
}

function validateRoute({ niche, senderInboxId, emailTemplateId, inboxes = [], requireReady = true, lead = null, campaignVersionId = '' } = {}) {
  const normalizedNiche = normalizeNiche(niche);
  const template = templateById(emailTemplateId);
  const inbox = inboxes.find(item => item.id === senderInboxId);
  if (!normalizedNiche) return { ok: false, reason: 'Lead niche is required' };
  if (!inbox) return { ok: false, reason: 'A registered sending inbox is required' };
  if (!inbox.sendEligible) return { ok: false, reason: `${inbox.email} is not eligible to send` };
  if (!inbox.deliveryImplemented) return { ok: false, reason: `${inbox.email} is connected but sender routing is not active yet` };
  const owner = routeClientVerdict({ lead, niche: normalizedNiche, inbox, emailTemplateId, campaignVersionId });
  if (!owner.ok) return { ok: false, code: owner.code, reason: owner.reason };
  if (isStaffingOnlySender(inbox) && normalizedNiche !== STAFFING_CAMPAIGN.niche) {
    return { ok: false, reason: `${inbox.email} is reserved for staffing agency leads` };
  }
  // A lead type whose offer is retired, or an archived lead, is never routed.
  const retired = retiredLeadType(normalizedNiche);
  if (retired) return { ok: false, code: 'offer_retired', reason: `The ${retired.label} offer is retired; ${normalizedNiche} leads cannot be routed` };
  const leadBlock = lead ? outreachBlockForLead(lead) : null;
  if (leadBlock) return { ok: false, code: leadBlock.code, reason: leadBlock.reason };
  if (!template) return { ok: false, reason: 'A registered email template is required' };
  if (template.niche !== normalizedNiche) return { ok: false, reason: `${template.name} cannot be used for ${normalizedNiche} leads` };
  if (requireReady && !template.ready) return { ok: false, reason: template.reason || `${template.name} is not ready` };
  return { ok: true, niche: normalizedNiche, inbox, template, clientId: owner.clientId };
}

// A managed client's lead is ready only through its own campaign registry;
// the legacy family resolver knows nothing about it and must not decide it.
function managedLeadReady(lead, clientId, env) {
  const client = getClient(clientId);
  if (!lead.leadNiche || !lead.senderInboxId || !lead.emailTemplateId || !lead.intendedCampaignVersion) {
    return { ok: false, reason: 'routing assignment is incomplete' };
  }
  const owner = checkClientConsistency({ lead, expectedClientId: client.id });
  if (!owner.ok) return { ok: false, code: owner.code, reason: owner.reason };
  const campaign = clientCampaign(lead.intendedCampaignVersion);
  if (!campaign) return { ok: false, reason: `campaign ${lead.intendedCampaignVersion} is not registered` };
  const sendable = campaignSendable(campaign);
  if (!sendable.ok) return { ok: false, code: sendable.code, reason: sendable.reason };
  const template = clientTemplate(lead.emailTemplateId);
  if (!template || template.id !== campaign.emailTemplateId) return { ok: false, reason: 'email template does not match the campaign' };
  if (template.niche !== normalizeNiche(lead.leadNiche)) return { ok: false, reason: 'email template does not match lead niche' };
  const blocked = clientSendBlock(client.id, env);
  if (blocked) return { ok: false, code: blocked.code, reason: blocked.reason };
  return { ok: true, legacy: false, template, clientId: client.id };
}

function routedLeadReady(lead, env = process.env) {
  // Archived leads and retired offers first, before ownership and before the
  // legacy bypass below: a legacy dental row has no routing fields at all, and
  // "legacy: true" must never mean "sendable" for an offer that no longer exists.
  const archiveBlock = outreachBlockForLead(lead);
  if (archiveBlock) return { ok: false, code: archiveBlock.code, reason: archiveBlock.reason };
  // Client ownership first: a lead whose fields name two clients, or that
  // carries another client's sender, is refused before any legacy bypass.
  const ownerOfLead = resolveLeadClient(lead);
  if (!ownerOfLead.ok) return { ok: false, code: ownerOfLead.code, reason: ownerOfLead.reason };
  if (!getClient(ownerOfLead.clientId).isDefault) return managedLeadReady(lead, ownerOfLead.clientId, env);
  if (String(lead.senderInboxId || '').trim()) {
    const senderOwner = checkClientConsistency({ lead });
    if (!senderOwner.ok) return { ok: false, code: senderOwner.code, reason: senderOwner.reason };
  }
  // Staffing is a post-routing campaign: it has never had unrouted production
  // rows, so it may not use the legacy bypass that exists for old dental and
  // roofing records. A staffing row without explicit routing is refused.
  const staffing = isStaffingLead(lead);
  if (!staffing && String(lead.routingRequired || '').toLowerCase() !== 'true') return { ok: true, legacy: true };
  if (!lead.leadNiche || !lead.senderInboxId || !lead.emailTemplateId) return { ok: false, reason: 'routing assignment is incomplete' };
  const resolved = resolveLeadFamily(lead);
  if (!resolved.confident || resolved.family === CAMPAIGN_FAMILY.UNROUTED) {
    return { ok: false, reason: resolved.reason || 'unknown or ambiguous niche' };
  }
  const blocked = staffingSendBlockReason(lead, env);
  if (blocked) return { ok: false, reason: blocked };
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
