'use strict';

const EMAIL_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'dental-guarantee-v1', name: 'Dental guarantee pitch', niche: 'dental', ready: true, sequenceSteps: 3 }),
  Object.freeze({
    id: 'roofing-survey-v1', name: 'Roofing survey — reply first', niche: 'roofing',
    ready: process.env.ROOFING_SURVEY_REPLY_FLOW_ENABLED === 'true',
    reason: 'Roofing survey workflow is disabled; set ROOFING_SURVEY_REPLY_FLOW_ENABLED=true only for an approved pilot',
    sequenceSteps: 1, profile: 'roofing_survey_reply_first',
  }),
]);

function normalizeNiche(value) {
  const niche = String(value || '').trim().toLowerCase();
  if (['dentist', 'dentists', 'dental clinic', 'dental'].includes(niche)) return 'dental';
  if (['roofer', 'roofers', 'roofing company', 'roofing'].includes(niche)) return 'roofing';
  return niche;
}

function templateById(id) { return EMAIL_TEMPLATES.find(template => template.id === String(id || '').trim()) || null; }

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
  if (String(lead.routingRequired || '').toLowerCase() !== 'true') return { ok: true, legacy: true };
  if (!lead.leadNiche || !lead.senderInboxId || !lead.emailTemplateId) return { ok: false, reason: 'routing assignment is incomplete' };
  const template = templateById(lead.emailTemplateId);
  if (!template?.ready) return { ok: false, reason: template?.reason || 'email template is unavailable' };
  if (template.niche !== normalizeNiche(lead.leadNiche)) return { ok: false, reason: 'email template does not match lead niche' };
  return { ok: true, legacy: false, template };
}

module.exports = { EMAIL_TEMPLATES, normalizeNiche, templateById, validateRoute, routedLeadReady };
