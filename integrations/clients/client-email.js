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
const { jolePersonalizationFor, joleSelectionHold, joleFollowUpHold } = require('./jole-personalization');

const DAY_MS = 24 * 60 * 60 * 1000;

// Template id → its copy versions and how a lead picks one. A managed template
// with no entry here cannot send. The version is per lead, from send evidence:
// a sequence never changes copy mid-thread. An evidence-aware version also
// takes the lead's personalization (mode and verified claims); selectionHold
// and followUpHold say why a lead may not start, or continue, a sequence.
const RENDERERS = Object.freeze({
  'jole-industrial-employer-v1': Object.freeze({
    versions: JOLE_COPY_VERSIONS, resolveVersion: resolveJoleCopyVersion,
    personalizationFor: jolePersonalizationFor, selectionHold: joleSelectionHold, followUpHold: joleFollowUpHold,
  }),
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
// enforceEvidenceAge: the campaign-wide evidence age gate. Evidence-aware
// copy (v4) applies its own per-mode 30-day rule instead.
function personalizationFor(lead, { now = Date.now(), enforceEvidenceAge = true } = {}) {
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
  if (maxAge && enforceEvidenceAge) {
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
  const version = clientCopyVersionFor(lead, { activities });
  const inputs = personalizationFor(lead, { now, enforceEvidenceAge: !version.evidenceAware });
  const client = getClient(inputs.campaign.clientId);
  const copyEnv = client.copyEnv || {};
  const renderer = RENDERERS[inputs.template.id];
  // A contacted lead whose next touch would repeat a claim found false never continues.
  const followUpHold = Number(step) > 1 ? renderer.followUpHold?.(lead) : '';
  if (followUpHold) throw fail('followup_hold', followUpHold);
  const personalization = version.evidenceAware ? renderer.personalizationFor(lead, activities, { now }) : undefined;
  const email = version.render({
    step, firstName: inputs.firstName, company: lead.company, roles: inputs.roles, location: inputs.location,
    landingPageUrl: env[copyEnv.landingPageUrl] || '', bookingLink: env[copyEnv.bookingLink] || '',
    mailingAddress: env[copyEnv.mailingAddress] || '', personalization,
  });
  return {
    subject: email.subject, body: email.body, step: email.step, variant: email.variant, copyVersion: email.copyVersion,
    ...(personalization ? { personalization: { mode: personalization.mode, role: personalization.role, location: personalization.location } } : {}),
  };
}

/** Why an untouched client lead may not start its sequence ('' when it may). */
function clientSelectionHold(lead = {}) {
  const renderer = RENDERERS[String(lead.emailTemplateId || '').trim()];
  return renderer?.selectionHold ? renderer.selectionHold(lead) : '';
}

/** Why a contacted client lead's next follow-up may not send ('' when it may). */
function clientFollowUpHold(lead = {}) {
  const renderer = RENDERERS[String(lead.emailTemplateId || '').trim()];
  return renderer?.followUpHold ? renderer.followUpHold(lead) : '';
}

// Validates against the version the email was rendered from (email.copyVersion),
// else the version the lead resolves to on these activities.
function validateClientLeadEmail(lead = {}, email = {}, step = 1, { activities = [], now = Date.now() } = {}) {
  const renderer = RENDERERS[String(lead.emailTemplateId || '').trim()];
  if (!renderer) return 'no client renderer for this template';
  const version = email.copyVersion ? renderer.versions[email.copyVersion] : clientCopyVersionFor(lead, { activities });
  if (!version) return `no client copy for version ${email.copyVersion}`;
  if (version.evidenceAware) {
    // The resolved claims (with what the mode must never print), overridden by what this email rendered from.
    return version.validate(email, step, { ...renderer.personalizationFor(lead, activities, { now }), ...(email.personalization || {}) }) || '';
  }
  return version.validate(email, step) || '';
}

/**
 * Operator view of a lead's personalization: ready / needs_review / stale /
 * config_missing, with the rendered opener when it renders. Never throws.
 */
function clientPersonalizationState(lead = {}, { env = process.env, now = Date.now() } = {}) {
  try {
    const evidenceAware = (() => { try { return Boolean(clientCopyVersionFor(lead).evidenceAware); } catch (_) { return false; } })();
    const inputs = personalizationFor(lead, { now, enforceEvidenceAge: !evidenceAware });
    const held = clientSelectionHold(lead);
    if (held && !lead.emailStep && !lead.emailStatus) return { status: 'hold', roles: inputs.roles, location: inputs.location, reason: held };
    try {
      const email = renderClientLeadEmail(lead, 1, { env, now });
      return { status: 'ready', roles: inputs.roles, location: inputs.location, subject: email.subject, variant: email.variant,
        ...(email.personalization ? { mode: email.personalization.mode } : {}) };
    } catch (error) {
      return { status: 'config_missing', roles: inputs.roles, location: inputs.location, reason: error.message };
    }
  } catch (error) {
    const status = error.code === 'evidence_stale' ? 'stale' : error.code === 'needs_review' ? 'needs_review' : 'not_ready';
    return { status, reason: error.message };
  }
}

module.exports = {
  isClientTemplateId, renderClientLeadEmail, validateClientLeadEmail, clientPersonalizationState, clientCopyVersionFor,
  clientSelectionHold, clientFollowUpHold,
};
