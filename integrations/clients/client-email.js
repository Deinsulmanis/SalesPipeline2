'use strict';

/**
 * Runtime render of a managed client's cold email — the client counterpart of
 * renderStaffingEmail. The agent, the queue preflight and the operator preview
 * all call this one function, so what is checked is what is sent.
 *
 * Personalization is research merged, never generated: the opener names the
 * lead's stored, cleaned hiring role and hiring location (lead-profile.js).
 * It fails CLOSED — a lead whose profile is missing, held for review, or whose
 * hiring evidence is too old to call current, throws; the caller drafts or
 * defers it instead of sending a guess.
 *
 * Landing page and postal address come from the client's own variables
 * (client config copyEnv), never ScaleLab's.
 */

const { getClient } = require('./registry');
const { clientTemplate, clientCampaign } = require('./campaigns');
const { readLeadProfile } = require('./lead-profile');
const { JOLE_COPY_VERSIONS, resolveJoleCopyVersion } = require('./jole-copy');

const DAY_MS = 24 * 60 * 60 * 1000;

// Template id → its copy versions and how a lead picks one. A managed template
// with no entry here cannot send. The version is per lead, from send evidence:
// a sequence never changes copy mid-thread.
const RENDERERS = Object.freeze({
  'jole-industrial-employer-v1': Object.freeze({ versions: JOLE_COPY_VERSIONS, resolveVersion: resolveJoleCopyVersion }),
});

/** The copy version (and its render/validate) this lead's sequence uses. */
function clientCopyVersionFor(lead = {}, { activities = [] } = {}) {
  const renderer = RENDERERS[String(lead.emailTemplateId || '').trim()];
  if (!renderer) throw fail('template_unknown', `no client renderer for ${lead.emailTemplateId || '(blank)'}`);
  const resolved = renderer.resolveVersion(lead, activities);
  const version = renderer.versions[resolved.copyVersion];
  if (!version) throw fail('copy_version_unknown', `no client copy for version ${resolved.copyVersion}`);
  return { ...resolved, ...version };
}

const isClientTemplateId = id => Boolean(RENDERERS[String(id || '').trim()] && clientTemplate(id));

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Personalization inputs for a lead, or throws with the reason it is not ready. */
function personalizationFor(lead, { now = Date.now() } = {}) {
  const template = clientTemplate(lead.emailTemplateId);
  if (!template || !RENDERERS[template.id]) throw fail('template_unknown', `no client renderer for ${lead.emailTemplateId || '(blank)'}`);
  const campaign = clientCampaign(lead.intendedCampaignVersion || lead.campaign);
  if (!campaign || campaign.emailTemplateId !== template.id) throw fail('campaign_mismatch', 'lead campaign does not use this template');
  const profile = readLeadProfile(lead);
  if (!profile) throw fail('profile_missing', 'lead has no stored research profile');
  if (profile.clientId && profile.clientId !== campaign.clientId) throw fail('profile_client_mismatch', 'lead profile belongs to another client');
  const personalization = profile.personalization || {};
  if (personalization.status !== 'ready') throw fail('needs_review', `personalization needs review: ${personalization.reason || 'not approved'}`);
  // "Is hiring X" must still be true: evidence older than the campaign allows is re-verified first.
  const maxAge = campaign.personalization?.maxEvidenceAgeDays;
  const verifiedAt = Date.parse(profile.hiring?.verifiedAt || '');
  if (maxAge) {
    if (!Number.isFinite(verifiedAt)) throw fail('evidence_undated', 'hiring evidence has no verification date');
    if (now - verifiedAt > maxAge * DAY_MS) throw fail('evidence_stale', `hiring evidence verified ${profile.hiring.verifiedAt} is older than ${maxAge} days; re-verify the posting`);
  }
  const firstName = profile.contact?.firstName || String(lead.contactName || '').trim().split(/\s+/)[0] || '';
  return { profile, campaign, template, firstName, roles: personalization.roles || [], location: personalization.location || '' };
}

/**
 * Render one touch for sending. Throws (fail closed) on anything missing.
 * activities: the activity ledger the send decision is made on; it pins the
 * lead's copy version (clientCopyVersionFor).
 */
function renderClientLeadEmail(lead = {}, step = 1, { env = process.env, now = Date.now(), activities = [] } = {}) {
  const inputs = personalizationFor(lead, { now });
  const client = getClient(inputs.campaign.clientId);
  const copyEnv = client.copyEnv || {};
  const email = clientCopyVersionFor(lead, { activities }).render({
    step, firstName: inputs.firstName, company: lead.company, roles: inputs.roles, location: inputs.location,
    landingPageUrl: env[copyEnv.landingPageUrl] || '', bookingLink: env[copyEnv.bookingLink] || '',
    mailingAddress: env[copyEnv.mailingAddress] || '',
  });
  return { subject: email.subject, body: email.body, step: email.step, variant: email.variant, copyVersion: email.copyVersion };
}

// Validates against the version the email was rendered from (email.copyVersion),
// else the version the lead resolves to on these activities.
function validateClientLeadEmail(lead = {}, email = {}, step = 1, { activities = [] } = {}) {
  const renderer = RENDERERS[String(lead.emailTemplateId || '').trim()];
  if (!renderer) return 'no client renderer for this template';
  const version = email.copyVersion ? renderer.versions[email.copyVersion] : clientCopyVersionFor(lead, { activities });
  if (!version) return `no client copy for version ${email.copyVersion}`;
  return version.validate(email, step) || '';
}

/**
 * Operator view of a lead's personalization: ready / needs_review / stale /
 * config_missing, with the rendered opener when it renders. Never throws.
 */
function clientPersonalizationState(lead = {}, { env = process.env, now = Date.now() } = {}) {
  try {
    const inputs = personalizationFor(lead, { now });
    try {
      const email = renderClientLeadEmail(lead, 1, { env, now });
      return { status: 'ready', roles: inputs.roles, location: inputs.location, subject: email.subject, variant: email.variant };
    } catch (error) {
      return { status: 'config_missing', roles: inputs.roles, location: inputs.location, reason: error.message };
    }
  } catch (error) {
    const status = error.code === 'evidence_stale' ? 'stale' : error.code === 'needs_review' ? 'needs_review' : 'not_ready';
    return { status, reason: error.message };
  }
}

module.exports = { isClientTemplateId, renderClientLeadEmail, validateClientLeadEmail, clientPersonalizationState, clientCopyVersionFor };
