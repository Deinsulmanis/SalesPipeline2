'use strict';

// Review-only campaign configuration. No sender, schedule or enrollment is assigned.
const STAFFING_CAMPAIGN = Object.freeze({
  id: 'industrial_staffing_employer_acquisition_v1',
  name: 'Industrial Staffing — Employer Acquisition',
  niche: 'industrial_staffing',
  emailTemplateId: 'industrial-staffing-employer-v1',
  personalizationStrategy: 'staffing_market_evidence_v1',
  model: 'claude-haiku-4-5',
  status: 'draft',
  ready: false,
});

function isStaffingCampaign(lead = {}) {
  const ids = [lead.campaignId, lead.intendedCampaignVersion].filter(Boolean);
  const matches = [STAFFING_CAMPAIGN.name, STAFFING_CAMPAIGN.id].includes(lead.campaign) || ids.includes(STAFFING_CAMPAIGN.id);
  if (!matches) return false;
  if (ids.some(id => id !== STAFFING_CAMPAIGN.id)) return false;
  if (lead.campaign && lead.campaign !== STAFFING_CAMPAIGN.name && lead.campaign !== STAFFING_CAMPAIGN.id) return false;
  if (lead.emailTemplateId && lead.emailTemplateId !== STAFFING_CAMPAIGN.emailTemplateId) return false;
  if (lead.leadNiche && !['industrial_staffing', 'staffing'].includes(lead.leadNiche)) return false;
  return true;
}

const LOCKED_EMAILS = Object.freeze([
  `Hi {{firstName}},\n\n{{hyperPersonalizedOpening}}\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for {{company}}?\n\n— Deins`,
  `Hi {{firstName}},\n\nJust to clarify — we're not talking about candidate sourcing.\n\nWe run a 30-day employer acquisition pilot built around the roles {{company}} already places.\n\nWe handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.\n\nIf we don't generate qualified employer meetings, there are no meeting fees.\n\nOpen to seeing what that could look like for {{company}}?`,
  `Hi {{firstName}},\n\nQuick question —\n\nis bringing in more employer accounts something {{company}} is focused on right now?`,
]);
// One bold phrase per step, exactly as locked. Step 3's bold contains a
// placeholder, so bolding happens on the RENDERED text rather than the template.
const BOLD_PHRASES = Object.freeze([
  'we get paid based on the meetings we generate.',
  'We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.',
  'is bringing in more employer accounts something {{company}} is focused on right now?',
]);
const BOLD_PHRASE = BOLD_PHRASES[0];
// Cadence is deliberately the same calendar spacing as the ordinary cold
// sequence; staffing does not get its own scheduler, only its own copy.
const STAFFING_FOLLOW_UP_DELAY_DAYS = Object.freeze([3, 5]);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderStaffingPreview(lead, result, step = 1) {
  if (!isStaffingCampaign(lead)) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  if (step === 1 && (!result || result.reviewFlag || !result.hyperPersonalizedOpening)) return null;
  const vars = {
    firstName: String(lead.firstName || lead.first || lead.contactName?.split(/\s+/)[0] || 'there').trim(),
    company: String(lead.company || '').trim(),
    hyperPersonalizedOpening: result?.hyperPersonalizedOpening || '',
  };
  if (!vars.company || Object.values(vars).some(v => /[\r\n]|{{|}}/.test(v))) throw new Error('Invalid template variable');
  const merge = text => text.replace(/{{(\w+)}}/g, (_, key) => vars[key]);
  const body = merge(LOCKED_EMAILS[step - 1]);
  // Bold only the locked offer phrase, never a model-authored opener.
  const phrase = merge(BOLD_PHRASES[step - 1]);
  let html = body.split(phrase).map(part => escapeHtml(part)).join(`<strong>${escapeHtml(phrase)}</strong>`);
  html = html.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject: step === 1 ? 'employer accounts' : null, body, html, step, previewOnly: true };
}

/**
 * The personalized opening for an imported CRM row.
 *
 * The import writes the approved opening into `siteContext`, which is the
 * existing personalization-context column. An explicit field wins if one is ever
 * added, but nothing is invented: without a stored opening this returns ''.
 */
function staffingOpeningFor(lead = {}) {
  return String(lead.hyperPersonalizedOpening || lead.siteContext || '').trim();
}

/**
 * Runtime render for the sending agent (as opposed to the review preview).
 * Fails CLOSED: a staffing lead with no stored opening, or a merge that would
 * leave a placeholder behind, throws so the caller drafts it for review rather
 * than mailing a half-merged template.
 */
function renderStaffingEmail(lead = {}, step = 1) {
  if (!isStaffingCampaign(lead)) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  const opening = staffingOpeningFor(lead);
  if (step === 1 && !opening) throw new Error('staffing lead has no stored personalized opening');
  const rendered = renderStaffingPreview(lead, { hyperPersonalizedOpening: opening, reviewFlag: false }, step);
  if (!rendered) throw new Error('staffing copy could not be rendered');
  return { subject: rendered.subject, body: rendered.body, html: rendered.html, step };
}

/** @returns an error string when the assembled staffing email is unsafe, else null. */
function validateStaffingEmail({ subject, body } = {}, step = 1) {
  const text = String(body || '');
  if (!text.trim()) return 'staffing body is empty';
  if (/{{|}}/.test(text)) return 'staffing body still contains an unmerged placeholder';
  if (step === 1 && String(subject || '').trim() !== 'employer accounts') return 'staffing step 1 subject must be the locked subject';
  // Dental/receptionist language must never reach a staffing prospect.
  if (/receptionist|missed calls?|dental|patients?|clinic/i.test(text)) return 'staffing body contains non-staffing offer language';
  // Anchor on the literal text BEFORE the first placeholder: the merged body
  // has a company name where the placeholder was, so the full phrase will not
  // match verbatim.
  const anchor = String(BOLD_PHRASES[step - 1] || '').split('{{')[0].trim();
  if (anchor && !text.includes(anchor)) return 'staffing body is missing its locked phrase';
  return null;
}

module.exports = { STAFFING_CAMPAIGN, isStaffingCampaign, LOCKED_EMAILS, BOLD_PHRASE, BOLD_PHRASES,
  STAFFING_FOLLOW_UP_DELAY_DAYS, renderStaffingPreview, staffingOpeningFor, renderStaffingEmail, validateStaffingEmail };
