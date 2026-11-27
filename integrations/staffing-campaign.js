'use strict';

// A V2 lead's typed sourcing profile (roles + market, buyer, ICP, provenance).
const {
  SCHEMA_MARKER: STAFFING_V2_PROFILE_MARKER, PROFILE_INTEGRITY_FAILED, TIER_RULES, hasStaffingV2ProfileMarker,
  readStaffingV2Profile, staffingV2RolesText,
} = require('./staffing-v2-profile');
// A V4 lead's sealed profile (tag, demand score, review status, selected variant).
const {
  SCHEMA_MARKER: STAFFING_V4_PROFILE_MARKER, PROFILE_INTEGRITY_FAILED: V4_PROFILE_INTEGRITY_FAILED,
  hasStaffingV4ProfileMarker, readStaffingV4Profile,
} = require('./staffing-v4-profile');
const { renderV4Copy, v4CopyProblem, inferV4CopyVersion, FOLLOW_UPS: V4_FOLLOW_UPS } = require('./staffing-v4-copy');
const { resolveV4CopyVersion } = require('./staffing-v4-copy-version');
// Campaign 4 "HOLD Company Test": its own sealed profile schema; Campaign 3's
// copy plus its own non-claiming COPY_G (campaign-4-copy.js).
const {
  C4_SCHEMA_MARKER, C4_PROFILE_INTEGRITY_FAILED, hasC4ProfileMarker, readC4Profile,
} = require('./campaign-4-profile');
const { renderC4Copy } = require('./campaign-4-copy');

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

// Staffing Outreach Campaign 2 (2026-10-23): a new cohort sent with V2's
// locked Tier A / Tier B copy, unchanged, under its own id, label and template
// so every send is attributable apart from V1 (completed) and V2. Each lead
// carries a sealed V2 sourcing profile adopted from the prepared V2 import
// (staffing-campaign-2-adoption.js); without one it is held. It may not send
// before its approved start (staffing-launch-gate.js).
const {
  STAFFING_CAMPAIGN_2_ID, STAFFING_CAMPAIGN_2_NAME,
} = require('./staffing-launch-gate');
const STAFFING_CAMPAIGN_2 = Object.freeze({
  id: STAFFING_CAMPAIGN_2_ID,
  name: STAFFING_CAMPAIGN_2_NAME,
  legacyNames: Object.freeze([]),
  niche: STAFFING_CAMPAIGN.niche,
  emailTemplateId: 'industrial-staffing-outreach-campaign-2',
  personalizationStrategy: STAFFING_CAMPAIGN.personalizationStrategy,
  model: STAFFING_CAMPAIGN.model,
  status: 'approved',
  ready: true,
});


// Industrial Campaign 3 (internally "staffing V4", 2026-11-20): ONE campaign,
// owned by ScaleLab AI, whose Email 1 is one of six evidence-selected variants
// (staffing-v4-copy.js) and whose Emails 2 and 3 are shared and threaded under
// Email 1's subject. Cadence, sender assignment, caps, threading, reservations
// and every safety gate are the existing ones.
//
// Live (owner approval 2026-11-20): a lead may be queued and sent only when its
// sealed profile holds a selected variant, a clean contact QC status and an
// explicit SEND_READY review status (staffingV4SendBlock), and the shared
// staffing launch gate is active. STAFFING_V4_LIVE = false stops it again.
const STAFFING_V4_LIVE = true;
let staffingV4LiveOverride = null;
function staffingV4Live() {
  return staffingV4LiveOverride === null ? STAFFING_V4_LIVE : staffingV4LiveOverride;
}
/** Tests only: model Campaign 3 live (true) or locked (false); null restores the source value. */
function setStaffingV4LiveForTests(value) {
  staffingV4LiveOverride = value === null ? null : Boolean(value);
}

const STAFFING_CAMPAIGN_V4 = Object.freeze({
  id: 'industrial_staffing_campaign_3',
  name: 'Industrial Campaign 3',
  legacyNames: Object.freeze([]),
  niche: STAFFING_CAMPAIGN.niche,
  emailTemplateId: 'industrial-staffing-campaign-3',
  personalizationStrategy: 'staffing_v4_evidence_variant_v1',
  model: null, // locked copy; selection and rendering make no model call
  owner: 'scalelab',
  get status() { return staffingV4Live() ? 'approved' : 'draft'; },
  get ready() { return staffingV4Live(); },
});

// Campaign 4 "HOLD Company Test" (owner brief 2026-11-27): the HOLD reply-test
// cohort, fully separate from Campaign 3. Same cadence, inboxes, global cap,
// compliance footer (Ref: SA-48271), reply handling and safety gates; its own
// id, label, template and sealed profile schema (campaign-4-profile.js). Its
// copy is Campaign 3's copy v2 exactly (the evidence-selected Email 1 variant
// and the shared Emails 2 and 3), plus one Campaign 4-only non-claiming Email 1,
// COPY_G, for leads with no verified Campaign 3 variant. A lead sends only with a verified SEND_READY
// profile (campaign4SendBlock) behind the shared staffing launch gate, within
// its daily split of ScaleLab's cap (campaign-4-share.js).
// STAFFING_C4_LIVE = false stops it.
const STAFFING_C4_LIVE = true;
let staffingC4LiveOverride = null;
function staffingC4Live() {
  return staffingC4LiveOverride === null ? STAFFING_C4_LIVE : staffingC4LiveOverride;
}
/** Tests only: model Campaign 4 live (true) or locked (false); null restores the source value. */
function setStaffingC4LiveForTests(value) {
  staffingC4LiveOverride = value === null ? null : Boolean(value);
}

const STAFFING_CAMPAIGN_C4 = Object.freeze({
  id: 'hold_company_test_campaign_4',
  name: 'HOLD Company Test',
  legacyNames: Object.freeze([]),
  niche: STAFFING_CAMPAIGN.niche,
  // Contains "staffing" so every staffing gate (isStaffingLead) recognises it.
  emailTemplateId: 'industrial-staffing-hold-company-test-4',
  personalizationStrategy: STAFFING_CAMPAIGN_V4.personalizationStrategy, // Campaign 3's evidence-selected variants
  model: null, // locked copy; rendering makes no model call
  owner: 'scalelab',
  get status() { return staffingC4Live() ? 'approved' : 'draft'; },
  get ready() { return staffingC4Live(); },
});

const STAFFING_CAMPAIGNS = Object.freeze([STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, STAFFING_CAMPAIGN_V4, STAFFING_CAMPAIGN_C4]);

// Every campaign label that identifies this campaign: the current name, the id,
// and any name it was stored under previously.
const STAFFING_CAMPAIGN_LABELS = Object.freeze([
  STAFFING_CAMPAIGN.name, STAFFING_CAMPAIGN.id, ...STAFFING_CAMPAIGN.legacyNames,
]);
const labelsOf = campaign => (campaign === STAFFING_CAMPAIGN ? STAFFING_CAMPAIGN_LABELS
  : [campaign.name, campaign.id, ...campaign.legacyNames]);

// A lead belongs to exactly one staffing version: every campaign identifier it
// carries (label, id, template) must name the same version, or it is neither.
// The campaigns that send V2's locked copy from a sealed V2 sourcing profile.
const V2_COPY_CAMPAIGNS = Object.freeze([STAFFING_CAMPAIGN_V2, STAFFING_CAMPAIGN_2]);
const usesV2Copy = campaign => V2_COPY_CAMPAIGNS.includes(campaign);

function matchesStaffingCampaign(lead, campaign) {
  // A lead carrying a V2 sourcing profile is V2 or Campaign 2, never V1.
  if (!usesV2Copy(campaign) && hasStaffingV2ProfileMarker(lead)) return false;
  // Likewise a lead carrying a Campaign 3 (V4) profile is Campaign 3 or nothing.
  if (campaign !== STAFFING_CAMPAIGN_V4 && hasStaffingV4ProfileMarker(lead)) return false;
  // And a lead carrying a Campaign 4 profile is Campaign 4 or nothing.
  if (campaign !== STAFFING_CAMPAIGN_C4 && hasC4ProfileMarker(lead)) return false;
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
    || (hasStaffingV2ProfileMarker(lead) && !isStaffingCampaign2Marked(lead));
}

/** Does anything on this lead name Staffing Outreach Campaign 2: its label, id, version or template? */
function isStaffingCampaign2Marked(lead = {}) {
  return labelsOf(STAFFING_CAMPAIGN_2).includes(lead.campaign)
    || [lead.campaignId, lead.intendedCampaignVersion].includes(STAFFING_CAMPAIGN_2.id)
    || lead.emailTemplateId === STAFFING_CAMPAIGN_2.emailTemplateId;
}

const normalizedEmail = value => String(value || '').trim().toLowerCase();

/**
 * Why a Campaign 2 lead may not be queued or sent, or null. Every identifier
 * must name Campaign 2, and its sealed profile must verify, name Campaign 2 and
 * belong to this lead's address. A refusal is a hold; nothing falls back to V1.
 */
function staffingCampaign2SendBlock(lead = {}) {
  if (staffingCampaignFor(lead) !== STAFFING_CAMPAIGN_2) return 'staffing Campaign 2 lead has conflicting campaign identity';
  if (!labelsOf(STAFFING_CAMPAIGN_2).includes(lead.campaign)
    || lead.emailTemplateId !== STAFFING_CAMPAIGN_2.emailTemplateId
    || String(lead.intendedCampaignVersion || '').trim() !== STAFFING_CAMPAIGN_2.id) {
    return 'staffing Campaign 2 lead requires its explicit Campaign 2 campaign, template and version';
  }
  const profile = readStaffingV2Profile(lead);
  if (!profile.ok) {
    return profile.reason === PROFILE_INTEGRITY_FAILED ? PROFILE_INTEGRITY_FAILED
      : `staffing Campaign 2 lead is not sendable: ${profile.reason}`;
  }
  if (profile.profile.campaign_id !== STAFFING_CAMPAIGN_2.id || profile.profile.template_id !== STAFFING_CAMPAIGN_2.emailTemplateId) {
    return 'staffing Campaign 2 lead profile names another campaign';
  }
  if (normalizedEmail(profile.profile.email) !== normalizedEmail(lead.email)) return 'staffing Campaign 2 lead profile belongs to another address';
  return null;
}

/**
 * Does anything on this lead name Industrial Staffing V4: its campaign label or
 * id, template, version, or a V4 profile? Such a lead is V4 or nothing: never
 * routed, attributed or rendered as V1 or V2.
 */
function isStaffingV4Marked(lead = {}) {
  return labelsOf(STAFFING_CAMPAIGN_V4).includes(lead.campaign)
    || [lead.campaignId, lead.intendedCampaignVersion].includes(STAFFING_CAMPAIGN_V4.id)
    || lead.emailTemplateId === STAFFING_CAMPAIGN_V4.emailTemplateId
    || hasStaffingV4ProfileMarker(lead);
}

/**
 * Why a V4-marked lead may not be queued or sent, or null (null for every
 * non-V4 lead). Every identifier must name V4, the sealed profile must verify,
 * hold a selected variant, a clean contact QC status and an explicit
 * SEND_READY review status, and V4 must be live. A refusal is a hold: nothing
 * here selects another campaign or another variant.
 */
function staffingV4SendBlock(lead = {}) {
  if (!isStaffingV4Marked(lead)) return null;
  if (staffingCampaignFor(lead) !== STAFFING_CAMPAIGN_V4) return 'staffing V4 lead has conflicting campaign identity';
  if (!labelsOf(STAFFING_CAMPAIGN_V4).includes(lead.campaign)
    || lead.emailTemplateId !== STAFFING_CAMPAIGN_V4.emailTemplateId
    || String(lead.intendedCampaignVersion || '').trim() !== STAFFING_CAMPAIGN_V4.id) {
    return 'staffing V4 lead requires its explicit V4 campaign, template and version';
  }
  const read = readStaffingV4Profile(lead);
  if (!read.ok) return read.reason === V4_PROFILE_INTEGRITY_FAILED ? V4_PROFILE_INTEGRITY_FAILED : `staffing V4 lead is not sendable: ${read.reason}`;
  if (read.profile.copy_status !== 'SELECTED') return `staffing V4 lead is on hold: ${read.profile.hold_reasons.join('; ') || 'no variant selected'}`;
  if (read.profile.contact_status !== 'READY_FOR_REVIEW') return `staffing V4 contact status is ${read.profile.contact_status || '(blank)'}`;
  if (read.profile.review_status !== 'SEND_READY') return 'staffing V4 lead is REVIEW READY, not SEND READY';
  if (!staffingV4Live()) return `${STAFFING_CAMPAIGN_V4.name} is registered but not live yet`;
  return null;
}

/**
 * Does anything on this lead name Campaign 4: its label, id, version, template
 * or a Campaign 4 profile? Such a lead is Campaign 4 or nothing.
 */
function isCampaign4Marked(lead = {}) {
  return labelsOf(STAFFING_CAMPAIGN_C4).includes(lead.campaign)
    || [lead.campaignId, lead.intendedCampaignVersion].includes(STAFFING_CAMPAIGN_C4.id)
    || lead.emailTemplateId === STAFFING_CAMPAIGN_C4.emailTemplateId
    || hasC4ProfileMarker(lead);
}

/**
 * Why a Campaign 4-marked lead may not be queued or sent, or null (null for
 * every other lead). Every identifier must name Campaign 4, its sealed profile
 * must verify, name Campaign 4, belong to this address, carry a clean contact
 * QC status and an explicit SEND_READY review status, and Campaign 4 must be
 * live. A refusal is a hold: nothing falls back to Campaign 3 or any other copy.
 */
function campaign4SendBlock(lead = {}) {
  if (!isCampaign4Marked(lead)) return null;
  if (staffingCampaignFor(lead) !== STAFFING_CAMPAIGN_C4) return 'Campaign 4 lead has conflicting campaign identity';
  if (!labelsOf(STAFFING_CAMPAIGN_C4).includes(lead.campaign)
    || lead.emailTemplateId !== STAFFING_CAMPAIGN_C4.emailTemplateId
    || String(lead.intendedCampaignVersion || '').trim() !== STAFFING_CAMPAIGN_C4.id) {
    return 'Campaign 4 lead requires its explicit Campaign 4 campaign, template and version';
  }
  const read = readC4Profile(lead, { campaignId: STAFFING_CAMPAIGN_C4.id });
  if (!read.ok) return read.reason === C4_PROFILE_INTEGRITY_FAILED ? C4_PROFILE_INTEGRITY_FAILED : `Campaign 4 lead is not sendable: ${read.reason}`;
  if (normalizedEmail(read.profile.email) !== normalizedEmail(lead.email)) return 'Campaign 4 lead profile belongs to another address';
  if (read.profile.contact_status !== 'VALID') return `Campaign 4 contact status is ${read.profile.contact_status || '(blank)'}`;
  if (read.profile.review_status !== 'SEND_READY') return 'Campaign 4 lead is REVIEW READY, not SEND READY';
  if (!staffingC4Live()) return `${STAFFING_CAMPAIGN_C4.name} is registered but not live yet`;
  return null;
}

/**
 * Why a V2-marked lead may not be queued or sent, or null (and null for every
 * non-V2 lead). Every identifier must name V2, the lead's sourcing profile must
 * carry structured roles + market, and V2 must be live. A refusal is a hold:
 * nothing here ever selects V1 instead. A Campaign 2 lead, which sends the same
 * copy from the same kind of profile, answers to staffingCampaign2SendBlock.
 */
function staffingV2SendBlock(lead = {}) {
  if (isStaffingCampaign2Marked(lead)) return staffingCampaign2SendBlock(lead);
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
//
// One exception: Campaign 2 adoption seals a profile once onto an existing,
// never-contacted Campaign 2 lead that has none. The profile must verify, name
// Campaign 2, and carry this lead's own address.
const STAFFING_V2_PROFILE_READ_ONLY = 'staffing_v2_profile_read_only';
const STAFFING_CAMPAIGN_2_ADOPTION_SCHEMA = 'staffing_campaign_2_adoption_v1';
function neverContacted(lead = {}) {
  return !String(lead.lastEmailedAt || '').trim() && !String(lead.emailStatus || '').trim()
    && !(Number(lead.emailStep) > 0);
}
function campaign2AdoptionAllowed(current, next) {
  if (!labelsOf(STAFFING_CAMPAIGN_2).includes(current.campaign) || hasStaffingV2ProfileMarker(current)) return false;
  if (!neverContacted(current)) return false;
  const read = readStaffingV2Profile({ campaign_notes: next });
  return Boolean(read.ok && read.profile.import_schema === STAFFING_CAMPAIGN_2_ADOPTION_SCHEMA
    && read.profile.campaign_id === STAFFING_CAMPAIGN_2.id && read.profile.template_id === STAFFING_CAMPAIGN_2.emailTemplateId
    && normalizedEmail(read.profile.email) === normalizedEmail(current.email));
}
/** Why writing `nextNotes` over `current`'s campaign_notes is refused, or null. Pure. */
function staffingV2CampaignNotesRefusal(current = {}, nextNotes) {
  const next = String(nextNotes ?? '');
  if (next === String(current.campaign_notes ?? current.campaignNotes ?? '')) return null;
  // Campaign 3 (V4) profiles are read-only through every write path.
  const v4 = staffingV4CampaignNotesRefusal(current, nextNotes);
  if (v4) return v4;
  // So are Campaign 4 profiles.
  const c4 = campaign4CampaignNotesRefusal(current, nextNotes);
  if (c4) return c4;
  if (isStaffingV2Marked(current) || hasStaffingV2ProfileMarker(current)) {
    return `${STAFFING_V2_PROFILE_READ_ONLY}: a staffing V2 lead's campaign_notes is its imported profile; only the V2 import writes it`;
  }
  if (next.includes(STAFFING_V2_PROFILE_MARKER) && !campaign2AdoptionAllowed(current, next)) {
    return `${STAFFING_V2_PROFILE_READ_ONLY}: a staffing V2 profile is written only by the V2 import or Campaign 2 adoption`;
  }
  return null;
}

// A V4 lead's campaign_notes is its sealed profile, written once by a V4 import
// on a new row. No other writer may change it or put a V4 profile on a lead,
// so the selected variant stays stable for the whole sequence.
//
// One exception: Campaign 3 conversion (staffing-campaign-3-convert.js) seals a
// V4 profile once onto an existing, never-contacted, unrouted Import-stage V1 or
// Campaign 2 lead that carries no V2 or V4 profile. That lead's own row is why
// the import refuses it, so conversion is the only way in without a second row.
// The profile must verify, select a variant, carry this lead's own address and
// the conversion provenance.
const STAFFING_V4_PROFILE_READ_ONLY = 'staffing_v4_profile_read_only';
const CAMPAIGN_3_CONVERSION_PREFIX = 'campaign3-convert:';
function campaign3ConversionAllowed(current = {}, next) {
  const source = staffingCampaignFor(current);
  if (source !== STAFFING_CAMPAIGN && source !== STAFFING_CAMPAIGN_2) return false;
  if (hasStaffingV2ProfileMarker(current) || isStaffingV4Marked(current)) return false;
  if (!neverContacted(current) || String(current.senderInboxId || '').trim()) return false;
  if (String(current.stage || '').trim() !== 'Import') return false;
  const read = readStaffingV4Profile({ campaign_notes: next });
  return Boolean(read.ok && read.profile.copy_status === 'SELECTED'
    && String(read.profile.sourcing_run_id || '').startsWith(CAMPAIGN_3_CONVERSION_PREFIX)
    && normalizedEmail(read.profile.email) === normalizedEmail(current.email));
}
function staffingV4CampaignNotesRefusal(current = {}, nextNotes) {
  const next = String(nextNotes ?? '');
  if (next === String(current.campaign_notes ?? current.campaignNotes ?? '')) return null;
  if (isStaffingV4Marked(current)) {
    return `${STAFFING_V4_PROFILE_READ_ONLY}: a staffing V4 lead's campaign_notes is its sealed profile and selected variant; it is never rewritten`;
  }
  if (next.includes(STAFFING_V4_PROFILE_MARKER) && !campaign3ConversionAllowed(current, next)) {
    return `${STAFFING_V4_PROFILE_READ_ONLY}: a staffing V4 profile is written only by the V4 import or Campaign 3 conversion of an untouched V1 / Campaign 2 lead`;
  }
  return null;
}

// A Campaign 4 lead's campaign_notes is its sealed profile, written once by the
// Campaign 4 import on a new row. No writer may change it or put a Campaign 4
// profile on any existing lead (there is no conversion path into Campaign 4).
const CAMPAIGN_4_PROFILE_READ_ONLY = 'campaign_4_profile_read_only';
function campaign4CampaignNotesRefusal(current = {}, nextNotes) {
  const next = String(nextNotes ?? '');
  if (next === String(current.campaign_notes ?? current.campaignNotes ?? '')) return null;
  if (isCampaign4Marked(current)) {
    return `${CAMPAIGN_4_PROFILE_READ_ONLY}: a Campaign 4 lead's campaign_notes is its sealed profile; it is never rewritten`;
  }
  if (next.includes(C4_SCHEMA_MARKER)) {
    return `${CAMPAIGN_4_PROFILE_READ_ONLY}: a Campaign 4 profile is written only by the Campaign 4 import`;
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
  if (String(campaignNotes || '').includes(STAFFING_V4_PROFILE_MARKER)) throw new Error('a staffing V4 profile is not a V1 review record');
  if (String(campaignNotes || '').includes(C4_SCHEMA_MARKER)) throw new Error('a Campaign 4 profile is not a V1 review record');
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
// V2 Touch 1 for an ICP Tier B lead (copy variant STAFFING_V2_TIER_B_INDUSTRIAL,
// locked 2026-10-21). Tier B has no verified roles + market, so it names the
// agency's verified positioning instead and claims no market. Touches 2 and 3
// are the same for both tiers: they name only the contact and the company.
const LOCKED_EMAIL_V2_TIER_B = `Hi {{firstName}},\n\nSaw {{company}} handles {{tier_b_positioning}}.\n\nI found 10 employers that look like potential accounts for {{company}}.\n\nWe also generate qualified employer meetings for staffing agencies on a performance basis. No qualified meetings, no meeting fees.\n\nWant the 10?\n\nDeins`;
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
const copyFor = campaign => (usesV2Copy(campaign)
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

// V2 Touch 1: its locked text and merge values. A lead imported through the V2
// import carries a sourcing profile whose copy_variant picks the text: Tier A
// merges the profile's structured roles + market, Tier B its verified
// positioning. Both come from structured fields only, never from an opener
// sentence, and an unusable profile renders nothing. A lead without a V2
// profile keeps the stored-opening reading, as Tier A.
function staffingV2Touch1(lead = {}, opening) {
  if (!hasStaffingV2ProfileMarker(lead)) {
    const parts = staffingOpeningParts(opening);
    return parts ? { template: LOCKED_EMAILS_V2[0], vars: parts } : null;
  }
  const read = readStaffingV2Profile(lead);
  if (!read.ok) return null;
  const { profile } = read;
  if (profile.copy_variant === TIER_RULES.TIER_B.copy_variant) {
    return { template: LOCKED_EMAIL_V2_TIER_B, vars: { tier_b_positioning: profile.tier_b_positioning } };
  }
  return { template: LOCKED_EMAILS_V2[0], vars: { roles: staffingV2RolesText(profile.roles), market: profile.market } };
}
function staffingV2Parts(lead = {}, opening) {
  const touch1 = staffingV2Touch1(lead, opening);
  return touch1 ? touch1.vars : null;
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

// V4: the sealed profile's selected variant and validated variables, merged
// into the approved copy, with the existing ScaleLab compliance footer. Throws
// on anything unresolved; there is no model-written opener to fall back on.
function renderStaffingV4(lead, step, options = {}) {
  if (options.landingPageUrl) throw new Error('staffing V4 copy carries no landing-page URL');
  if (options.oooResumeContext && step === 1) throw new Error('only a staffing follow-up can resume after an out-of-office reply');
  const read = readStaffingV4Profile(lead);
  if (!read.ok) throw new Error(`staffing V4 Email ${step} refused: ${read.reason}${read.detail ? ` (${read.detail})` : ''}`);
  if (read.profile.copy_status !== 'SELECTED') throw new Error(`staffing V4 Email ${step} refused: lead is on hold (${read.profile.hold_reasons.join('; ') || 'no variant'})`);
  const identity = staffingSenderIdentity(options.env || process.env, options);
  // Copy version pinned per lead (staffing-v4-copy-version.js). The send path
  // passes the activity ledger so a thread keeps the version its Email 1 used.
  const pinned = resolveV4CopyVersion(lead, options.activities, { sealedCopyVersion: read.sealedCopyVersion });
  const rendered = renderV4Copy({
    variant: read.profile.copy_variant, step, vars: read.vars, copyVersion: pinned.copyVersion,
    resumeLine: options.oooResumeContext ? OOO_RESUME_CONTEXT_LINE : '',
    // Campaign 3's footer has no website line (owner copy change 2026-11-24).
    appendFooter: text => appendStaffingComplianceFooter(text, identity, { includeWebsite: false }),
  });
  // Follow-ups keep the Email 1 thread subject ("Re: ..."), exactly as every
  // staffing version does, so Gmail threading holds. The approved standalone
  // subject is reported for review only.
  return { subject: step === 1 ? rendered.subject : null, approvedSubject: rendered.subject,
    body: rendered.body, html: rendered.html, step, campaignId: STAFFING_CAMPAIGN_V4.id,
    copyVariant: read.profile.copy_variant, copyVersion: pinned.copyVersion, copyVersionReason: pinned.reason };
}

// Campaign 4: Campaign 3's copy v2 exactly (owner decision 2026-11-27). The
// sealed profile's selected variant and validated variables, merged by the same
// renderer, with the same ScaleLab compliance footer as Campaign 3 (no website
// line; Ref: SA-48271 kept so Gmail filtering and reply routing hold).
function renderStaffingC4(lead, step, options = {}) {
  if (options.landingPageUrl) throw new Error('Campaign 4 copy carries no landing-page URL');
  if (options.oooResumeContext && step === 1) throw new Error('only a staffing follow-up can resume after an out-of-office reply');
  const read = readC4Profile(lead, { campaignId: STAFFING_CAMPAIGN_C4.id });
  if (!read.ok) throw new Error(`Campaign 4 Email ${step} refused: ${read.reason}${read.detail ? ` (${read.detail})` : ''}`);
  const identity = staffingSenderIdentity(options.env || process.env, options);
  // Copy version pinned per lead: the one the import sealed (v2). A Campaign 3
  // variant renders through Campaign 3's renderer; COPY_G through its own.
  const rendered = renderC4Copy({
    variant: read.variant, step, vars: read.vars, copyVersion: read.copyVersion,
    resumeLine: options.oooResumeContext ? OOO_RESUME_CONTEXT_LINE : '',
    appendFooter: text => appendStaffingComplianceFooter(text, identity, { includeWebsite: false }),
  });
  return { subject: step === 1 ? rendered.subject : null, approvedSubject: rendered.subject,
    body: rendered.body, html: rendered.html, step, campaignId: STAFFING_CAMPAIGN_C4.id,
    copyVariant: read.variant, copyVersion: read.copyVersion, copyVersionReason: 'sealed_on_profile' };
}

function renderStaffingPreview(lead, result, step = 1, options = {}) {
  const campaign = staffingCampaignFor(lead);
  if (!campaign) throw new Error('Staffing campaign assignment required');
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  if (campaign === STAFFING_CAMPAIGN_V4) {
    try { return { ...renderStaffingV4(lead, step, options), previewOnly: true }; } catch (_) { return null; }
  }
  if (campaign === STAFFING_CAMPAIGN_C4) {
    try { return { ...renderStaffingC4(lead, step, options), previewOnly: true }; } catch (_) { return null; }
  }
  const v2 = usesV2Copy(campaign);
  const copy = copyFor(campaign);
  // V1's no-personalization Email 1 has no V2 counterpart: V2 Email 1 needs roles + market.
  const noPersonalization = !v2 && step === 1 && !result?.hyperPersonalizedOpening && staffingNoPersonalizationAllowed(lead);
  // A V2 lead with a sourcing profile needs no opener: Touch 1 merges its structured roles + market.
  const structuredV2 = v2 && hasStaffingV2ProfileMarker(lead);
  // Campaign 2 renders only from its sealed profile, never from a stored opener.
  if (campaign === STAFFING_CAMPAIGN_2 && !structuredV2) return null;
  // Every touch of a profiled V2 lead requires the sealed profile to verify.
  if (structuredV2 && !readStaffingV2Profile(lead).ok) return null;
  if (step === 1 && (result?.reviewFlag || (!result?.hyperPersonalizedOpening && !noPersonalization && !structuredV2))) return null;
  const touch1 = v2 && step === 1 ? staffingV2Touch1(lead, result?.hyperPersonalizedOpening) : null;
  if (v2 && step === 1 && !touch1) return null;
  const vars = {
    firstName: String(lead.firstName || lead.first || lead.contactName?.split(/\s+/)[0] || 'there').trim(),
    company: String(lead.company || '').trim(),
    hyperPersonalizedOpening: result?.hyperPersonalizedOpening || '',
    ...(touch1 ? touch1.vars : {}),
  };
  if (!vars.company || Object.values(vars).some(v => /[\r\n]|{{|}}/.test(v))) throw new Error('Invalid template variable');
  const merge = text => text.replace(/{{(\w+)}}/g, (_, key) => vars[key]);
  const identity = staffingSenderIdentity(options.env || process.env, options);
  // Only V1 step 2 carries the landing page; a tracked URL anywhere else is a caller bug.
  if (options.landingPageUrl && !copy.landingPage) throw new Error('staffing V2 copy carries no landing-page URL');
  if (options.landingPageUrl && step !== 2) throw new Error('only staffing step 2 carries the landing-page URL');
  // Touch 1 is never a resume: an OOO can only answer an email already sent.
  if (options.oooResumeContext && step === 1) throw new Error('only a staffing follow-up can resume after an out-of-office reply');
  const lockedText = noPersonalization ? NO_PERSONALIZATION_EMAIL : touch1 ? touch1.template : copy.emails[step - 1];
  const locked = withStaffingLandingUrl(lockedText, options.landingPageUrl);
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
  if (!campaign) {
    // A V4-marked lead whose identifiers disagree is held, never rendered as V1/V2.
    if (isStaffingV4Marked(lead)) throw new Error('staffing V4 lead has conflicting campaign identity');
    if (isCampaign4Marked(lead)) throw new Error('Campaign 4 lead has conflicting campaign identity');
    throw new Error('Staffing campaign assignment required');
  }
  if (![1, 2, 3].includes(step)) throw new Error('Invalid staffing sequence step');
  if (campaign === STAFFING_CAMPAIGN_V4) {
    const email = renderStaffingV4(lead, step, options);
    return { subject: email.subject, body: email.body, html: email.html, step,
      campaignId: email.campaignId, copyVariant: email.copyVariant, copyVersion: email.copyVersion,
      copyVersionReason: email.copyVersionReason };
  }
  if (campaign === STAFFING_CAMPAIGN_C4) {
    const email = renderStaffingC4(lead, step, options);
    return { subject: email.subject, body: email.body, html: email.html, step,
      campaignId: email.campaignId, copyVariant: email.copyVariant, copyVersion: email.copyVersion,
      copyVersionReason: email.copyVersionReason };
  }
  const opening = staffingOpeningFor(lead);
  const structuredV2 = usesV2Copy(campaign) && hasStaffingV2ProfileMarker(lead);
  if (campaign === STAFFING_CAMPAIGN_2 && !structuredV2) {
    throw new Error(`${STAFFING_CAMPAIGN_2.name} Email ${step} needs its sealed Tier A / Tier B profile`);
  }
  const v2Profile = structuredV2 ? readStaffingV2Profile(lead) : null;
  if (v2Profile && !v2Profile.ok && v2Profile.reason === PROFILE_INTEGRITY_FAILED) {
    throw new Error(`staffing V2 Email ${step} refused: ${PROFILE_INTEGRITY_FAILED} (${v2Profile.detail})`);
  }
  if (structuredV2 && step === 1 && !staffingV2Touch1(lead, opening)) {
    throw new Error(`staffing V2 Email 1 needs its structured Touch 1 fields: ${readStaffingV2Profile(lead).reason || 'unusable V2 profile'}`);
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
function validateStaffingEmail({ subject, body, leadId, campaignId, copyVersion } = {}, step = 1) {
  const text = String(body || '');
  if (!text.trim()) return 'staffing body is empty';
  if (/{{|}}/.test(text)) return 'staffing body still contains an unmerged placeholder';
  if (String(subject || '').includes(STAFFING_CAMPAIGN_REF)) return 'staffing subject must not contain the campaign reference';
  if (step === 1 && campaignId !== STAFFING_CAMPAIGN_V4.id && campaignId !== STAFFING_CAMPAIGN_C4.id
    && String(subject || '').trim() !== 'employer accounts') return 'staffing step 1 subject must be the locked subject';
  if (step !== 1 && String(subject || '').trim()) return 'staffing follow-up must keep the original thread subject';
  if (campaignId === STAFFING_CAMPAIGN_V4.id) {
    if (/receptionist|missed calls?|dental|patients?|clinic/i.test(text)) return 'staffing body contains non-staffing offer language';
    // The render names its copy version; a caller passing only the body gets
    // it inferred from the locked text, and both versions stay strict.
    return v4CopyProblem({ body: text, subject, copyVersion: copyVersion || inferV4CopyVersion(text, step) }, step)
      || staffingComplianceError(text, { leadId });
  }
  if (campaignId === STAFFING_CAMPAIGN_C4.id) {
    if (/receptionist|missed calls?|dental|patients?|clinic/i.test(text)) return 'staffing body contains non-staffing offer language';
    // Campaign 3's own validator: Campaign 4 sends Campaign 3's copy v2 only.
    return v4CopyProblem({ body: text, subject, copyVersion: copyVersion || 'v2' }, step)
      || (copyVersion && copyVersion !== 'v2' ? 'Campaign 4 sends copy v2 only' : null)
      || staffingComplianceError(text, { leadId });
  }
  // Dental/receptionist language must never reach a staffing prospect.
  if (/receptionist|missed calls?|dental|patients?|clinic/i.test(text)) return 'staffing body contains non-staffing offer language';
  // Anchor on the literal text BEFORE the first placeholder: the merged body
  // has a company name where the placeholder was, so the full phrase will not
  // match verbatim.
  // A V2 email is checked against V2's locked phrases; anything else against V1's.
  const v2Copy = V2_COPY_CAMPAIGNS.some(campaign => campaign.id === campaignId);
  const phrases = v2Copy ? LOCKED_PHRASES_V2 : BOLD_PHRASES;
  const anchor = String(phrases[step - 1] || '').split('{{')[0].trim();
  if (anchor && !text.includes(anchor)) return 'staffing body is missing its locked phrase';
  return v2Copy
    ? staffingV2ComplianceError(text, step, { leadId })
    : staffingComplianceError(text, { leadId });
}

module.exports = { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_LABELS, isStaffingCampaign, STAFFING_LANDING_PAGE_URL, LOCKED_EMAILS, BOLD_PHRASE, BOLD_PHRASES,
  OOO_RESUME_CONTEXT_LINE,
  STAFFING_SEQUENCE_TIMING, renderStaffingPreview, staffingOpeningFor, staffingReviewStatus, replaceStaffingReviewTag,
  staffingNoPersonalizationAllowed, renderStaffingEmail, validateStaffingEmail,
  isTrackedStaffingLandingUrl, withStaffingLandingUrl,
  STAFFING_CAMPAIGN_2, STAFFING_CAMPAIGN_V2, STAFFING_CAMPAIGNS, LOCKED_EMAILS_V2, LOCKED_EMAIL_V2_TIER_B, BOLD_PHRASES_V2, LOCKED_PHRASES_V2,
  staffingCampaignFor, isStaffingTemplateId, isStaffingCampaignVersionId, staffingOpeningParts,
  staffingV2Live, setStaffingV2LiveForTests,
  isStaffingV2Marked, staffingV2SendBlock, staffingV2Parts, staffingV2Touch1,
  isStaffingCampaign2Marked, staffingCampaign2SendBlock, STAFFING_CAMPAIGN_2_ADOPTION_SCHEMA, usesV2Copy,
  STAFFING_V2_PROFILE_READ_ONLY, staffingV2CampaignNotesRefusal,
  STAFFING_CAMPAIGN_V4, staffingV4Live, setStaffingV4LiveForTests, isStaffingV4Marked, staffingV4SendBlock,
  STAFFING_V4_PROFILE_READ_ONLY, staffingV4CampaignNotesRefusal, V4_FOLLOW_UPS,
  CAMPAIGN_3_CONVERSION_PREFIX, campaign3ConversionAllowed,
  STAFFING_CAMPAIGN_C4, staffingC4Live, setStaffingC4LiveForTests, isCampaign4Marked, campaign4SendBlock,
  CAMPAIGN_4_PROFILE_READ_ONLY, campaign4CampaignNotesRefusal };
