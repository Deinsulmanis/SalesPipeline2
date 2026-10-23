'use strict';

// A V2 lead's typed sourcing profile (roles + market, buyer, ICP, provenance).
const {
  SCHEMA_MARKER: STAFFING_V2_PROFILE_MARKER, PROFILE_INTEGRITY_FAILED, hasStaffingV2ProfileMarker, readStaffingV2Profile,
  staffingV2RolesText,
} = require('./staffing-v2-profile');

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

// Industrial Staffing V2 (2026-10-15): a separate campaign whose ONLY intended
// difference from V1 is the Email 1 copy. It shares V1's niche, personalization
// strategy and model, subject, cadence, Email 2 and Email 3, and its own id,
// template and copy version keep every V2 send attributable apart from V1.
//
// V2 is registered but NOT live: no lead can be queued to it and nothing can
// send under it until a reviewed change sets STAFFING_V2_LIVE to true. Live, it
// follows V1's staffing launch gate (campaign-versions.js).
const STAFFING_V2_LIVE = false;
let staffingV2LiveOverride = null;
function staffingV2Live() {
  return staffingV2LiveOverride === null ? STAFFING_V2_LIVE : staffingV2LiveOverride;
}
/** Tests only: model V2 live (true) or locked (false); null restores the source value. */
function setStaffingV2LiveForTests(value) {
  staffingV2LiveOverride = value === null ? null : Boolean(value);
}

const STAFFING_CAMPAIGN_V2 = Object.freeze({
  id: 'industrial_staffing_employer_acquisition_v2',
  name: 'Industrial Staffing Agency V2',
  legacyNames: Object.freeze([]),
  niche: STAFFING_CAMPAIGN.niche,
  emailTemplateId: 'industrial-staffing-employer-v2',
  personalizationStrategy: STAFFING_CAMPAIGN.personalizationStrategy,
  model: STAFFING_CAMPAIGN.model,
  get status() { return staffingV2Live() ? 'approved' : 'draft'; },
  get ready() { return staffingV2Live(); },
});

// Staffing Outreach Campaign 2 (2026-10-23): a new cohort sent with V1's
// locked template and copy, unchanged. Its own id and label keep every send
// attributable apart from V1, which is a completed campaign. It may not send
// before its approved start (staffing-launch-gate.js).
const {
  STAFFING_CAMPAIGN_2_ID, STAFFING_CAMPAIGN_2_NAME,
} = require('./staffing-launch-gate');
const STAFFING_CAMPAIGN_2 = Object.freeze({
  id: STAFFING_CAMPAIGN_2_ID,
  name: STAFFING_CAMPAIGN_2_NAME,
  legacyNames: Object.freeze([]),
  niche: STAFFING_CAMPAIGN.niche,
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  personalizationStrategy: STAFFING_CAMPAIGN.personalizationStrategy,
  model: STAFFING_CAMPAIGN.model,
  status: 'approved',
  ready: true,
});

const STAFFING_CAMPAIGNS = Object.freeze([STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2]);

// Every campaign label that identifies this campaign: the current name, the id,
// and any name it was stored under previously.
const STAFFING_CAMPAIGN_LABELS = Object.freeze([
  STAFFING_CAMPAIGN.name, STAFFING_CAMPAIGN.id, ...STAFFING_CAMPAIGN.legacyNames,
]);
const labelsOf = campaign => (campaign === STAFFING_CAMPAIGN ? STAFFING_CAMPAIGN_LABELS
  : [campaign.name, campaign.id, ...campaign.legacyNames]);

// A lead belongs to exactly one staffing version: every campaign identifier it
// carries (label, id, template) must name the same version, or it is neither.
function matchesStaffingCampaign(lead, campaign) {
  // A lead carrying a V2 sourcing profile is V2 or nothing, whatever else it says.
  if (campaign !== STAFFING_CAMPAIGN_V2 && hasStaffingV2ProfileMarker(lead)) return false;
  const labels = labelsOf(campaign);
  const ids = [lead.campaignId, lead.intendedCampaignVersion].filter(Boolean);
  const matches = labels.includes(lead.campaign) || ids.includes(campaign.id);
  if (!matches) return false;
  if (ids.some(id => id !== campaign.id)) return false;
  if (lead.campaign && !labels.includes(lead.campaign)) return false;
  if (lead.emailTemplateId && lead.emailTemplateId !== campaign.emailTemplateId) return false;
  if (lead.leadNiche && !['industrial_staffing', 'staffing'].includes(lead.leadNiche)) return false;
  return true;
}

/** The staffing campaign version (V1 or V2) this lead belongs to, or null. */
function staffingCampaignFor(lead = {}) {
  return STAFFING_CAMPAIGNS.find(campaign => matchesStaffingCampaign(lead, campaign)) || null;
}

function isStaffingCampaign(lead = {}) {
  return Boolean(staffingCampaignFor(lead));
}

/** Is this one of the staffing versions' email templates? */
function isStaffingTemplateId(id) {
  const value = String(id || '').trim();
  return STAFFING_CAMPAIGNS.some(campaign => campaign.emailTemplateId === value);
}

/** Is this one of the staffing versions' campaign ids? */
function isStaffingCampaignVersionId(id) {
  const value = String(id || '').trim();
  return STAFFING_CAMPAIGNS.some(campaign => campaign.id === value);
}

/**
 * Does anything on this lead name Industrial Staffing V2: its campaign label or
 * id, template, version, or a V2 sourcing profile? Such a lead is V2 or nothing.
 * It is never routed, attributed or rendered as V1, whatever is missing.
 */
function isStaffingV2Marked(lead = {}) {
  return labelsOf(STAFFING_CAMPAIGN_V2).includes(lead.campaign)
    || [lead.campaignId, lead.intendedCampaignVersion].includes(STAFFING_CAMPAIGN_V2.id)
    || lead.emailTemplateId === STAFFING_CAMPAIGN_V2.emailTemplateId
    || hasStaffingV2ProfileMarker(lead);
}

/**
 * Why a V2-marked lead may not be queued or sent, or null (and null for every
 * non-V2 lead). Every identifier must name V2, the lead's sourcing profile must
 * carry structured roles + market, and V2 must be live. A refusal is a hold:
 * nothing here ever selects V1 instead.
 */
function staffingV2SendBlock(lead = {}) {
  if (!isStaffingV2Marked(lead)) return null;
  if (staffingCampaignFor(lead) !== STAFFING_CAMPAIGN_V2) return 'staffing V2 lead has conflicting campaign identity';
  if (!labelsOf(STAFFING_CAMPAIGN_V2).includes(lead.campaign)
    || lead.emailTemplateId !== STAFFING_CAMPAIGN_V2.emailTemplateId
    || String(lead.intendedCampaignVersion || '').trim() !== STAFFING_CAMPAIGN_V2.id) {
    return 'staffing V2 lead requires its explicit V2 campaign, template and version';
  }
  const profile = readStaffingV2Profile(lead);
  if (!profile.ok) {
    return profile.reason === PROFILE_INTEGRITY_FAILED ? PROFILE_INTEGRITY_FAILED : `staffing V2 lead is not sendable: ${profile.reason}`;
  }
  if (!staffingV2Live()) return `${STAFFING_CAMPAIGN_V2.name} is registered but not live yet`;
  return null;
}

// A V2 lead's campaign_notes is its imported, digest-sealed sourcing profile.
// The V2 import writes it once, on a new row; no other writer may change it or
// put a V2 profile onto an existing lead. Writing the value already there is not
// a change, so a full-row edit of other fields still goes through.
const STAFFING_V2_PROFILE_READ_ONLY = 'staffing_v2_profile_read_only';
/** Why writing `nextNotes` over `current`'s campaign_notes is refused, or null. Pure. */
function staffingV2CampaignNotesRefusal(current = {}, nextNotes) {
  const next = String(nextNotes ?? '');
  if (next === String(current.campaign_notes ?? current.campaignNotes ?? '')) return null;
  if (isStaffingV2Marked(current)) {
    return `${STAFFING_V2_PROFILE_READ_ONLY}: a staffing V2 lead's campaign_notes is its imported profile; only the V2 import writes it`;
  }
  if (next.includes(STAFFING_V2_PROFILE_MARKER)) {
    return `${STAFFING_V2_PROFILE_READ_ONLY}: a staffing V2 profile is written only by the V2 import`;
  }
  return null;
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
// The first follow-up after an out-of-office return opens with this one line,
// then continues with the normal next touch exactly as locked. It claims only
// what the autoresponder said (they were away), never why or where.
const OOO_RESUME_CONTEXT_LINE = "Circling back now that you're back in the office.";
const STAFFING_GREETING = 'Hi {{firstName}},\n\n';
function withOooResumeContext(template) {
  if (!template.startsWith(STAFFING_GREETING)) throw new Error('staffing copy must open with its greeting');
  return `${STAFFING_GREETING}${OOO_RESUME_CONTEXT_LINE}\n\n${template.slice(STAFFING_GREETING.length)}`;
}
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
  // A V2 lead's campaign_notes is its typed sourcing profile; a V1 review tag appended to it would corrupt it.
  if (String(campaignNotes || '').includes(STAFFING_V2_PROFILE_MARKER)) throw new Error('a staffing V2 profile is not a V1 review record');
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

// V2's own copy for all three touches (locked 2026-10-20). Cadence and thread
// subjects are V1's (sequence-timing.js, gmail-threading.js). No V2 touch
// carries a landing-page link, V2 Touch 3 has no bold phrase, and every V2
// touch ends with V2's own footer (staffing-compliance.js).
const LOCKED_EMAILS_V2 = Object.freeze([
  `Hi {{firstName}},\n\nSaw {{company}} places {{roles}} for {{market}}.\n\nI found 10 employers actively hiring in that market that look like potential accounts for {{company}}.\n\nWe also generate qualified employer meetings for staffing agencies on a performance basis. No qualified meetings, no meeting fees.\n\nWant the 10?\n\nDeins`,
  `Hi {{firstName}},\n\nThe 10 employers I mentioned are just a small sample of the accounts we'd go after for {{company}}.\n\nWe identify the right employers, reach the decision-makers, qualify interest, and put interested prospects directly on your calendar.\n\nThe important part: if we don't generate qualified employer meetings that actually happen, you don't pay meeting fees.\n\nSo you're not paying us for activity, outreach volume, or a bunch of emails being sent. You're paying for actual meetings.\n\nHappy to send over the 10 I pulled for you if you want to take a look.\n\nDeins`,
  `Hi {{firstName}},\n\nQuick question before I close the loop.\n\nIs bringing in more employer accounts something {{company}} is actively focused on right now, or are you mainly focused on filling demand from existing clients?\n\nDeins`,
]);
const BOLD_PHRASES_V2 = Object.freeze([
  'No qualified meetings, no meeting fees.',
  "The important part: if we don't generate qualified employer meetings that actually happen, you don't pay meeting fees.",
  null,
]);
// What validation requires each V2 touch to contain: its bold phrase, or for
// Touch 3 its opening line (the question itself starts with V1 Touch 3's words).
const LOCKED_PHRASES_V2 = Object.freeze([
  BOLD_PHRASES_V2[0],
  BOLD_PHRASES_V2[1],
  'Quick question before I close the loop.',
]);
const copyFor = campaign => (campaign === STAFFING_CAMPAIGN_V2
  ? { emails: LOCKED_EMAILS_V2, bold: BOLD_PHRASES_V2, landingPage: false }
  : { emails: LOCKED_EMAILS, bold: BOLD_PHRASES, landingPage: true });

// V2's opening names the roles and the market that V1's research already
// validated, verbatim from the stored V1 opening ("Saw you place {roles} for
// {market}."). Only that shape carries both; a market-only, territory-only or
// missing opening has no supported roles + market, and V2 refuses to render
// rather than invent either.
const V1_ROLES_MARKET_OPENING = /^Saw (?:you place|your team placing) (.+?) for (.+)\.$/;
function staffingOpeningParts(opening) {
  const match = V1_ROLES_MARKET_OPENING.exec(String(opening || '').trim());
  if (!match) return null;
  const roles = match[1].trim();
  const market = match[2].trim();
  return roles && market ? { roles, market } : null;
}

// V2 Touch 1's roles and market. A lead imported through the V2 import carries
// a sourcing profile, and its roles + market come from that profile's
// structured fields only, never from an opener sentence; an unusable profile
// renders nothing. A lead without a V2 profile keeps the stored-opening reading.
function staffingV2Parts(lead = {}, opening) {
  if (!hasStaffingV2ProfileMarker(lead)) return staffingOpeningParts(opening);
  const read = readStaffingV2Profile(lead);
  return read.ok ? { roles: staffingV2RolesText(read.profile.roles), market: read.profile.market } : null;
}
// Cadence: staffing does not get its own scheduler, only its own copy. Its
// timing is THE sequence timing (integrations/sequence-timing.js), re-exported
// here by reference so nothing can hold a second copy of the delays.
const { SEQUENCE_TIMING: STAFFING_SEQUENCE_TIMING } = require('./sequence-timing');
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const {
  appendStaffingComplianceFooter, staffingSenderIdentity, staffingComplianceError,
  appendStaffingV2Footer, staffingV2ComplianceError, STAFFING_CAMPAIGN_REF,
} = require('./staffing-compliance');

function renderStaffingPreview(lead, result, step = 1, options = {}) {
  const campaign = staffingCampaignFor(lead);
  if (!campaign) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  const v2 = campaign === STAFFING_CAMPAIGN_V2;
  const copy = copyFor(campaign);
  // V1's no-personalization Email 1 has no V2 counterpart: V2 Email 1 needs roles + market.
  const noPersonalization = !v2 && step === 1 && !result?.hyperPersonalizedOpening && staffingNoPersonalizationAllowed(lead);
  // A V2 lead with a sourcing profile needs no opener: Touch 1 merges its structured roles + market.
  const structuredV2 = v2 && hasStaffingV2ProfileMarker(lead);
  // Every touch of a profiled V2 lead requires the sealed profile to verify.
  if (structuredV2 && !readStaffingV2Profile(lead).ok) return null;
  if (step === 1 && (result?.reviewFlag || (!result?.hyperPersonalizedOpening && !noPersonalization && !structuredV2))) return null;
  const parts = v2 && step === 1 ? staffingV2Parts(lead, result?.hyperPersonalizedOpening) : null;
  if (v2 && step === 1 && !parts) return null;
  const vars = {
    firstName: String(lead.firstName || lead.first || lead.contactName?.split(/\s+/)[0] || 'there').trim(),
    company: String(lead.company || '').trim(),
    hyperPersonalizedOpening: result?.hyperPersonalizedOpening || '',
    ...(parts || {}),
  };
  if (!vars.company || Object.values(vars).some(v => /[\r\n]|{{|}}/.test(v))) throw new Error('Invalid template variable');
  const merge = text => text.replace(/{{(\w+)}}/g, (_, key) => vars[key]);
  const identity = staffingSenderIdentity(options.env || process.env, options);
  // Only V1 step 2 carries the landing page; a tracked URL anywhere else is a caller bug.
  if (options.landingPageUrl && !copy.landingPage) throw new Error('staffing V2 copy carries no landing-page URL');
  if (options.landingPageUrl && step !== 2) throw new Error('only staffing step 2 carries the landing-page URL');
  // Touch 1 is never a resume: an OOO can only answer an email already sent.
  if (options.oooResumeContext && step === 1) throw new Error('only a staffing follow-up can resume after an out-of-office reply');
  const locked = withStaffingLandingUrl(noPersonalization ? NO_PERSONALIZATION_EMAIL : copy.emails[step - 1], options.landingPageUrl);
  const template = options.oooResumeContext ? withOooResumeContext(locked) : locked;
  // V1: the shared compliance footer on every touch. V2: its own footer on
  // every touch.
  const body = v2 ? appendStaffingV2Footer(merge(template), identity)
    : appendStaffingComplianceFooter(merge(template), identity);
  // Bold only the locked offer phrase, never a model-authored opener or footer.
  // A touch with no bold phrase (V2 Touch 3) renders with none.
  const phrase = copy.bold[step - 1] ? merge(copy.bold[step - 1]) : null;
  let html = phrase ? body.split(phrase).map(part => escapeHtml(part)).join(`<strong>${escapeHtml(phrase)}</strong>`) : escapeHtml(body);
  html = html.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  // A V2 render names its campaign so validation checks V2's locked phrase;
  // a V1 render keeps exactly the shape it always had.
  return { subject: step === 1 ? 'employer accounts' : null, body, html, step, previewOnly: true,
    ...(v2 ? { campaignId: campaign.id } : {}) };
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
  const campaign = staffingCampaignFor(lead);
  if (!campaign) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  const opening = staffingOpeningFor(lead);
  const structuredV2 = campaign === STAFFING_CAMPAIGN_V2 && hasStaffingV2ProfileMarker(lead);
  const v2Profile = structuredV2 ? readStaffingV2Profile(lead) : null;
  if (v2Profile && !v2Profile.ok && v2Profile.reason === PROFILE_INTEGRITY_FAILED) {
    throw new Error(`staffing V2 Email ${step} refused: ${PROFILE_INTEGRITY_FAILED} (${v2Profile.detail})`);
  }
  if (structuredV2 && step === 1 && !staffingV2Parts(lead, opening)) {
    throw new Error(`staffing V2 Email 1 needs structured roles and market: ${readStaffingV2Profile(lead).reason || 'unusable V2 profile'}`);
  }
  if (campaign === STAFFING_CAMPAIGN_V2 && !structuredV2 && step === 1 && !staffingOpeningParts(opening)) {
    throw new Error('staffing V2 Email 1 needs a stored roles-and-market opening ("Saw you place {roles} for {market}.")');
  }
  if (step === 1 && !opening && !structuredV2 && !staffingNoPersonalizationAllowed(lead)) throw new Error('staffing lead has no stored personalized opening');
  const rendered = renderStaffingPreview(lead, { hyperPersonalizedOpening: opening, reviewFlag: false }, step, options);
  if (!rendered) throw new Error('staffing copy could not be rendered');
  return { subject: rendered.subject, body: rendered.body, html: rendered.html, step,
    ...(rendered.campaignId ? { campaignId: rendered.campaignId } : {}) };
}

/** @returns an error string when the assembled staffing email is unsafe, else null. */
function validateStaffingEmail({ subject, body, leadId, campaignId } = {}, step = 1) {
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
  // A V2 email is checked against V2's locked phrases; anything else against V1's.
  const phrases = campaignId === STAFFING_CAMPAIGN_V2.id ? LOCKED_PHRASES_V2 : BOLD_PHRASES;
  const anchor = String(phrases[step - 1] || '').split('{{')[0].trim();
  if (anchor && !text.includes(anchor)) return 'staffing body is missing its locked phrase';
  return campaignId === STAFFING_CAMPAIGN_V2.id
    ? staffingV2ComplianceError(text, step, { leadId })
    : staffingComplianceError(text, { leadId });
}

module.exports = { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_LABELS, isStaffingCampaign, STAFFING_LANDING_PAGE_URL, LOCKED_EMAILS, BOLD_PHRASE, BOLD_PHRASES,
  OOO_RESUME_CONTEXT_LINE,
  STAFFING_SEQUENCE_TIMING, renderStaffingPreview, staffingOpeningFor, staffingReviewStatus, replaceStaffingReviewTag,
  staffingNoPersonalizationAllowed, renderStaffingEmail, validateStaffingEmail,
  isTrackedStaffingLandingUrl, withStaffingLandingUrl,
  STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, STAFFING_CAMPAIGNS, LOCKED_EMAILS_V2, BOLD_PHRASES_V2, LOCKED_PHRASES_V2,
  staffingCampaignFor, isStaffingTemplateId, isStaffingCampaignVersionId, staffingOpeningParts,
  staffingV2Live, setStaffingV2LiveForTests,
  isStaffingV2Marked, staffingV2SendBlock, staffingV2Parts,
  STAFFING_V2_PROFILE_READ_ONLY, staffingV2CampaignNotesRefusal };
