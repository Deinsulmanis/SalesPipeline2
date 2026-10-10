'use strict';

// Approved locked copy. Readiness permits queueing; staffing-launch-gate separately controls delivery.
const STAFFING_CAMPAIGN = Object.freeze({
  // The id is canonical and is referenced by CAMPAIGN_VERSIONS and
  // ACTIVE_CAMPAIGN_VERSION, so it does NOT change when the display name does.
  id: 'industrial_staffing_employer_acquisition_v1',
  name: 'Industrial Staffing Agency',
  // Names this campaign has been stored under before. Rows written under an
  // earlier name keep matching, so renaming can never orphan imported leads.
  legacyNames: Object.freeze(['Industrial Staffing — Employer Acquisition']),
  niche: 'industrial_staffing',
  emailTemplateId: 'industrial-staffing-employer-v1',
  personalizationStrategy: 'staffing_market_evidence_v1',
  model: 'claude-haiku-4-5',
  status: 'approved',
  ready: true,
});

// Every campaign label that identifies this campaign: the current name, the id,
// and any name it was stored under previously.
const STAFFING_CAMPAIGN_LABELS = Object.freeze([
  STAFFING_CAMPAIGN.name, STAFFING_CAMPAIGN.id, ...STAFFING_CAMPAIGN.legacyNames,
]);

function isStaffingCampaign(lead = {}) {
  const ids = [lead.campaignId, lead.intendedCampaignVersion].filter(Boolean);
  const matches = STAFFING_CAMPAIGN_LABELS.includes(lead.campaign) || ids.includes(STAFFING_CAMPAIGN.id);
  if (!matches) return false;
  if (ids.some(id => id !== STAFFING_CAMPAIGN.id)) return false;
  if (lead.campaign && !STAFFING_CAMPAIGN_LABELS.includes(lead.campaign)) return false;
  if (lead.emailTemplateId && lead.emailTemplateId !== STAFFING_CAMPAIGN.emailTemplateId) return false;
  if (lead.leadNiche && !['industrial_staffing', 'staffing'].includes(lead.leadNiche)) return false;
  return true;
}

const STAFFING_LANDING_PAGE_URL = 'https://scalelabai.ca/staffing/';
// A tracked link is the plain URL plus one opaque token (see landing-link-token.js).
const TRACKED_STAFFING_LANDING_URL = /^https:\/\/scalelabai\.ca\/staffing\/\?t=[A-Za-z0-9_-]{22}$/;

function isTrackedStaffingLandingUrl(url) {
  return typeof url === 'string' && TRACKED_STAFFING_LANDING_URL.test(url);
}

/**
 * The locked copy with its landing-page URL swapped for a tracked one. Without a
 * tracked URL the text is returned untouched, so untracked renders stay
 * byte-identical. The swap happens on the template, before merge, so only the
 * locked occurrence can change.
 */
function withStaffingLandingUrl(text, landingPageUrl) {
  if (!landingPageUrl) return text;
  if (!isTrackedStaffingLandingUrl(landingPageUrl)) throw new Error('staffing landing-page URL is not a tracked landing link');
  const parts = String(text).split(STAFFING_LANDING_PAGE_URL);
  if (parts.length !== 2) throw new Error('staffing copy must contain the landing-page URL exactly once');
  return parts.join(landingPageUrl);
}

const LOCKED_EMAILS = Object.freeze([
  `Hi {{firstName}},\n\n{{hyperPersonalizedOpening}}\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for {{company}}?\n\n— Deins`,
  `Hi {{firstName}},\n\nJust to clarify — we're not talking about candidate sourcing.\n\nWe run a 30-day employer acquisition pilot built around the roles {{company}} already places.\n\nWe handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.\n\nIf we don't generate qualified employer meetings, there are no meeting fees.\n\nYou can see how it works here:\n${STAFFING_LANDING_PAGE_URL}\n\nOpen to seeing what this could look like for {{company}}?`,
  // Touch 3, normalized 2026-10-03 to the approved wording. The sign-off is
  // part of the copy: the compliance footer carries no personal name and Gmail
  // API sends never append the mailbox signature, so it cannot duplicate.
  `Hi {{firstName}},\n\nIs bringing in more employer accounts something {{company}} is focused on right now?\n\nDeins`,
]);
// A reviewed ICP fit can use the core offer without an unsupported company fact.
// This variant applies only to an explicit NONE_REQUIRED staffing review.
const NO_PERSONALIZATION_EMAIL = `Hi {{firstName}},\n\nWe help industrial staffing agencies generate qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for {{company}}?\n\n— Deins`;
const REVIEW_TAG = /\[STAFFING_REVIEW_V1 fit=(ICP_CONFIRMED|ICP_REJECT|ICP_UNRESOLVED);personalization=(SPECIFIC_HIGH|BROAD_MEDIUM|SAFE_FALLBACK|NONE_REQUIRED|FAILED);routing_ready=(true|false)\]/;
function staffingReviewStatus(lead = {}) {
  const match = REVIEW_TAG.exec(String(lead.campaign_notes || lead.campaignNotes || ''));
  return match ? { fit: match[1], personalization: match[2], routingReady: match[3] === 'true' } : null;
}
const REVIEW_PERSONALIZATION = Object.freeze(['SPECIFIC_HIGH', 'BROAD_MEDIUM', 'SAFE_FALLBACK', 'NONE_REQUIRED', 'FAILED']);
function replaceStaffingReviewTag(campaignNotes, { fit, personalization, routingReady }) {
  if (!['ICP_CONFIRMED', 'ICP_REJECT', 'ICP_UNRESOLVED'].includes(fit)) throw new Error('invalid staffing review fit');
  if (!REVIEW_PERSONALIZATION.includes(personalization)) throw new Error('invalid staffing review personalization');
  const tag = `[STAFFING_REVIEW_V1 fit=${fit};personalization=${personalization};routing_ready=${routingReady ? 'true' : 'false'}]`;
  const current = String(campaignNotes || '');
  if (REVIEW_TAG.test(current)) return current.replace(REVIEW_TAG, tag);
  return current ? `${current.replace(/\s*$/, '')}; ${tag}` : tag;
}
function staffingNoPersonalizationAllowed(lead = {}) {
  const review = staffingReviewStatus(lead);
  return Boolean(review && review.fit === 'ICP_CONFIRMED'
    && review.personalization === 'NONE_REQUIRED' && review.routingReady);
}
// One bold phrase per step, exactly as locked. Step 3's bold contains a
// placeholder, so bolding happens on the RENDERED text rather than the template.
const BOLD_PHRASES = Object.freeze([
  'we get paid based on the meetings we generate.',
  'We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.',
  'Is bringing in more employer accounts something {{company}} is focused on right now?',
]);
const BOLD_PHRASE = BOLD_PHRASES[0];
// Cadence: staffing does not get its own scheduler, only its own copy. Its
// timing is THE sequence timing (integrations/sequence-timing.js), re-exported
// here by reference so nothing can hold a second copy of the delays.
const { SEQUENCE_TIMING: STAFFING_SEQUENCE_TIMING } = require('./sequence-timing');
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const {
  appendStaffingComplianceFooter, staffingSenderIdentity, staffingComplianceError,
  STAFFING_CAMPAIGN_REF,
} = require('./staffing-compliance');

function renderStaffingPreview(lead, result, step = 1, options = {}) {
  if (!isStaffingCampaign(lead)) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  const noPersonalization = step === 1 && !result?.hyperPersonalizedOpening && staffingNoPersonalizationAllowed(lead);
  if (step === 1 && (result?.reviewFlag || (!result?.hyperPersonalizedOpening && !noPersonalization))) return null;
  const vars = {
    firstName: String(lead.firstName || lead.first || lead.contactName?.split(/\s+/)[0] || 'there').trim(),
    company: String(lead.company || '').trim(),
    hyperPersonalizedOpening: result?.hyperPersonalizedOpening || '',
  };
  if (!vars.company || Object.values(vars).some(v => /[\r\n]|{{|}}/.test(v))) throw new Error('Invalid template variable');
  const merge = text => text.replace(/{{(\w+)}}/g, (_, key) => vars[key]);
  const identity = staffingSenderIdentity(options.env || process.env, options);
  // Only step 2 carries the landing page; a tracked URL anywhere else is a caller bug.
  if (options.landingPageUrl && step !== 2) throw new Error('only staffing step 2 carries the landing-page URL');
  const template = withStaffingLandingUrl(noPersonalization ? NO_PERSONALIZATION_EMAIL : LOCKED_EMAILS[step - 1], options.landingPageUrl);
  const body = appendStaffingComplianceFooter(merge(template), identity);
  // Bold only the locked offer phrase, never a model-authored opener or footer.
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
function renderStaffingEmail(lead = {}, step = 1, options = {}) {
  if (!isStaffingCampaign(lead)) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  const opening = staffingOpeningFor(lead);
  if (step === 1 && !opening && !staffingNoPersonalizationAllowed(lead)) throw new Error('staffing lead has no stored personalized opening');
  const rendered = renderStaffingPreview(lead, { hyperPersonalizedOpening: opening, reviewFlag: false }, step, options);
  if (!rendered) throw new Error('staffing copy could not be rendered');
  return { subject: rendered.subject, body: rendered.body, html: rendered.html, step };
}

/** @returns an error string when the assembled staffing email is unsafe, else null. */
function validateStaffingEmail({ subject, body, leadId } = {}, step = 1) {
  const text = String(body || '');
  if (!text.trim()) return 'staffing body is empty';
  if (/{{|}}/.test(text)) return 'staffing body still contains an unmerged placeholder';
  if (String(subject || '').includes(STAFFING_CAMPAIGN_REF)) return 'staffing subject must not contain the campaign reference';
  if (step === 1 && String(subject || '').trim() !== 'employer accounts') return 'staffing step 1 subject must be the locked subject';
  if (step !== 1 && String(subject || '').trim()) return 'staffing follow-up must keep the original thread subject';
  // Dental/receptionist language must never reach a staffing prospect.
  if (/receptionist|missed calls?|dental|patients?|clinic/i.test(text)) return 'staffing body contains non-staffing offer language';
  // Anchor on the literal text BEFORE the first placeholder: the merged body
  // has a company name where the placeholder was, so the full phrase will not
  // match verbatim.
  const anchor = String(BOLD_PHRASES[step - 1] || '').split('{{')[0].trim();
  if (anchor && !text.includes(anchor)) return 'staffing body is missing its locked phrase';
  return staffingComplianceError(text, { leadId });
}

module.exports = { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_LABELS, isStaffingCampaign, STAFFING_LANDING_PAGE_URL, LOCKED_EMAILS, BOLD_PHRASE, BOLD_PHRASES,
  STAFFING_SEQUENCE_TIMING, renderStaffingPreview, staffingOpeningFor, staffingReviewStatus, replaceStaffingReviewTag,
  staffingNoPersonalizationAllowed, renderStaffingEmail, validateStaffingEmail,
  isTrackedStaffingLandingUrl, withStaffingLandingUrl };
