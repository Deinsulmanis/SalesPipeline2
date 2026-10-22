'use strict';

/**
 * Jole BTX employer-acquisition copy, v2 and v3 (template jole-industrial-employer-v1).
 * v2 is unchanged below; v3 follows it (see resolveJoleCopyVersion).
 *
 * The approved three-touch sequence from Jole's sequence review (2026-10-05),
 * on the canonical client id `jole`. Jole's offer is to INDUSTRIAL END
 * EMPLOYERS: Jole supplies skilled-trade labor. It is not ScaleLab's
 * staffing-agency offer and shares no copy with it.
 *
 * Rendering is strict. A missing or unsafe variable refuses to render rather
 * than falling back to a guess. The sender independently requires client
 * authorization, verified hiring evidence and a dedicated Jole inbox.
 */

const { STAFFING_OPT_OUT_LINE, resolveCommercialMailingAddress } = require('../staffing-compliance');

const COPY_VERSION = 'jole_industrial_employer_v2';
const SENDER = Object.freeze({ name: 'Jorge Guerrero', title: 'CEO', company: 'Jole BTX LLC', signOff: 'Jorge' });
// Env names the launch must set. Never a ScaleLab value: Jole's address and
// landing page do not fall back to the global ones.
const REQUIRED_CONFIG = Object.freeze(['JOLE_LANDING_PAGE_URL', 'JOLE_BOOKING_LINK', 'JOLE_COMMERCIAL_MAILING_ADDRESS']);

const TOUCH_1 = "Hi {{first_name}},\n\nSaw {{company}} is hiring {{role}} in {{location}}{{secondary_role_line}}.\n\nJole BTX helps industrial teams cover skilled-trade gaps with contract craft labor.\n\nIf that opening is still live, I can have our team look at the exact site requirements and tell you whether it's something we can realistically cover.\n\nWorth doing?\n\nJorge";
const TOUCH_2 = "Hi {{first_name}},\n\nTo make this more concrete, Jole has been supporting industrial employers with skilled-trade labor for about 25 years and works with roughly 800 workers a year.\n\nIf {{role}} is still open at {{location}}, a quick 10-minute call is probably the easiest next step.\n\nYou can walk me through the shift, certifications, headcount and start date, and I'll tell you whether it's something we can realistically cover.\n\nHere's a quick overview of how Jole works:\n{{jole_landing_page_url}}\n\nIf we're not a fit for it, I'll tell you that too.\n\nWorth 10 minutes to see if Jole can realistically cover it?\n\nIf so, you can grab whatever time works here:\n{{jole_booking_link}}\n\nJorge";
const TOUCH_3 = "Hi {{first_name}},\n\nJust following up on the {{role}} opening in {{location}}.\n\nIf it's still a priority, happy to compare notes and see whether Jole could help with the coverage.\n\nIf that's useful, I'm happy to jump on a quick call.\n\nJorge";

const STEPS = Object.freeze([
  Object.freeze({ step: 1, sendAfterBusinessDays: 0, subject: '{{role}} — {{location}}', bodies: Object.freeze({ default: TOUCH_1 }) }),
  // Follow-ups reply in the original Gmail thread; no new subject.
  Object.freeze({ step: 2, sendAfterBusinessDays: 3, subject: null, bodies: Object.freeze({ default: TOUCH_2 }) }),
  Object.freeze({ step: 3, sendAfterBusinessDays: 4, subject: null, bodies: Object.freeze({ default: TOUCH_3 }) }),
]);

const JOLE_INDUSTRIAL_EMPLOYER_COPY = Object.freeze({
  copyVersion: COPY_VERSION, sender: SENDER, steps: STEPS,
  requiredConfig: REQUIRED_CONFIG,
  // Cadence counts business days after the PREVIOUS touch's actual delivery.
  cadence: 'T1 day 0; T2 three business days after T1 was delivered; T3 four business days after T2 was delivered',
  footer: 'Jorge Guerrero / CEO / Jole BTX LLC / JOLE_COMMERCIAL_MAILING_ADDRESS, then the commercial-email notice and reply-unsubscribe line',
  linkPolicy: 'Touch 2 carries the Jole landing page and booking link; touches 1 and 3 carry none',
});

const UNSAFE_VARIABLE = /[\r\n<>\u0000-\u001f]|{{|}}|https?:\/\/|www\./i;
function cleanVariable(value, field) {
  const text = String(value ?? '').trim();
  if (!text || UNSAFE_VARIABLE.test(text)) throw Object.assign(new Error(`Jole copy variable ${field} is missing or unsafe`), { code: 'invalid_variable' });
  return text;
}

function approvedJoleUrl(value, field) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { url = null; }
  if (!url || url.protocol !== 'https:' || url.username || url.password || /{{|}}|placeholder|change.?me/i.test(raw)
    || /(?:scalelab|localhost|example|placeholder|\.test$|\.invalid$)/i.test(url.hostname)) {
    throw Object.assign(new Error(`${field} must be an approved Jole HTTPS URL`), { code: 'invalid_jole_url' });
  }
  return url.href;
}
const joleLandingPageUrl = value => approvedJoleUrl(value, 'JOLE_LANDING_PAGE_URL');
const joleBookingLink = value => approvedJoleUrl(value, 'JOLE_BOOKING_LINK');

function joleFooter(mailingAddress) {
  // Explicit address only: Jole's footer never falls back to COMMERCIAL_MAILING_ADDRESS.
  const address = resolveCommercialMailingAddress({}, mailingAddress === undefined ? '' : mailingAddress);
  if (/{{|}}|https?:\/\/|scalelab/i.test(address)) throw Object.assign(new Error('invalid Jole mailing address'), { code: 'invalid_mailing_address' });
  return `${SENDER.name}\n${SENDER.title}\n${SENDER.company}\n${address}\n\n${STAFFING_OPT_OUT_LINE}`;
}

function validateJoleEmployerEmail({ subject, body } = {}, step) {
  const text = `${subject || ''}\n${body || ''}`;
  if (!String(body || '').trim() || /{{|}}/.test(text)) return 'copy is empty or contains a raw placeholder';
  // ScaleLab's offers never appear in Jole copy.
  if (/scalelab|employer meetings|meeting fees?|receptionist|calendar link|dental|roofing/i.test(text)) return 'copy contains another campaign\'s offer';
  const links = String(body).match(/https?:\/\/\S+|www\.\S+/gi) || [];
  if (step !== 2 && links.length) return 'only touch 2 may contain a link';
  if (step === 2 && links.length !== 2) return 'touch 2 requires the landing-page and booking links';
  return '';
}

/**
 * Render one touch. roles: the lead's verified hiring roles (1–2). With withFooter:false the compliance footer (which needs
 * the Jole mailing address) is omitted — for offline review only.
 */
function renderJoleEmployerStep({ step, firstName, company, roles = [], location = '', landingPageUrl = '', bookingLink = '', mailingAddress } = {}, { withFooter = true } = {}) {
  const definition = STEPS.find(item => item.step === Number(step));
  if (!definition) throw Object.assign(new Error(`invalid Jole step ${step}`), { code: 'invalid_step' });
  const safeRoles = (Array.isArray(roles) ? roles : []).filter(role => String(role || '').trim()).slice(0, 2).map(role => cleanVariable(role, 'role'));
  if (!safeRoles.length) throw Object.assign(new Error('Jole copy requires a verified hiring role'), { code: 'invalid_variable' });
  const vars = {
    first_name: cleanVariable(firstName, 'first_name'),
    company: cleanVariable(company, 'company'),
    role: safeRoles[0],
    location: cleanVariable(location, 'location'),
    secondary_role_line: safeRoles[1] ? ` and also has openings for ${safeRoles[1]} at the site` : '',
  };
  const variant = definition.step === 1 ? (safeRoles[1] ? 'two_roles' : 'one_role') : 'default';
  if (definition.step === 2) {
    vars.jole_landing_page_url = joleLandingPageUrl(landingPageUrl);
    vars.jole_booking_link = joleBookingLink(bookingLink);
  }
  const fill = template => template.replace(/{{(\w+)}}/g, (_, key) => {
    if (!Object.hasOwn(vars, key) || (!vars[key] && key !== 'secondary_role_line')) throw Object.assign(new Error(`Jole copy variable ${key} is missing`), { code: 'invalid_variable' });
    return vars[key];
  });
  const coreBody = fill(definition.bodies.default);
  const body = withFooter ? `${coreBody}\n\n${joleFooter(mailingAddress)}` : coreBody;
  const email = { step: definition.step, variant, subject: definition.subject ? fill(definition.subject) : null, coreBody, body, copyVersion: COPY_VERSION };
  const problem = validateJoleEmployerEmail(email, definition.step);
  if (problem) throw Object.assign(new Error(`Jole copy refused: ${problem}`), { code: 'invalid_copy' });
  return email;
}

/**
 * Jole BTX employer-acquisition copy, v3 (same template, same campaign, same
 * cadence). Approved 2026-10-20 for leads that have never been sent anything;
 * a lead already in a sequence keeps the version its first send recorded
 * (resolveJoleCopyVersion). V3 carries no dash punctuation anywhere, and its
 * Touch 2 links only the approved Jole overview page (no booking link).
 */
const COPY_VERSION_V3 = 'jole_industrial_employer_v3';
const JOLE_V3_OVERVIEW_URL = 'https://jolebtx.netlify.app/';

const TOUCH_1_V3 = "Hi {{first_name}},\n\nSaw {{company}} is hiring {{role}} in {{location}}{{secondary_role_line}}.\n\nI can have our team check whether Jole has the right craft coverage for that site and what it would realistically take to fill the gap.\n\nWant me to check?\n\nJorge";
const TOUCH_2_V3 = `Hi {{first_name}},\n\nJust to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.\n\nFor an opening like {{role}} in {{location}}, we'd look at the site, shift, certifications, headcount and start date, then tell you whether it's something we can realistically cover.\n\nWe're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\nHere's a quick overview of Jole:\n${JOLE_V3_OVERVIEW_URL}\n\nIf {{role}} is still open, worth having us take a look?\n\nJorge`;
const TOUCH_3_V3 = 'Hi {{first_name}},\n\nIs getting the {{role}} opening in {{location}} covered still a priority for {{company}}, or has the need changed?\n\nJorge';

const STEPS_V3 = Object.freeze([
  Object.freeze({ step: 1, sendAfterBusinessDays: 0, subject: '{{role}} | {{location}}', bodies: Object.freeze({ default: TOUCH_1_V3 }) }),
  Object.freeze({ step: 2, sendAfterBusinessDays: 3, subject: null, bodies: Object.freeze({ default: TOUCH_2_V3 }) }),
  Object.freeze({ step: 3, sendAfterBusinessDays: 4, subject: null, bodies: Object.freeze({ default: TOUCH_3_V3 }) }),
]);

const JOLE_INDUSTRIAL_EMPLOYER_COPY_V3 = Object.freeze({
  copyVersion: COPY_VERSION_V3, sender: SENDER, steps: STEPS_V3,
  requiredConfig: Object.freeze(['JOLE_COMMERCIAL_MAILING_ADDRESS']),
  cadence: JOLE_INDUSTRIAL_EMPLOYER_COPY.cadence,
  footer: JOLE_INDUSTRIAL_EMPLOYER_COPY.footer,
  linkPolicy: `Touch 2 carries ${JOLE_V3_OVERVIEW_URL} only; touches 1 and 3 carry none`,
});

// Dash punctuation: en/em/figure dashes, horizontal bar, minus, and an ASCII
// hyphen used as a dash (spaced, or doubled). A hyphen inside a word
// (Winston-Salem, Multi-Craft) is not punctuation and stays.
const DASH_PUNCTUATION = /[‒-―−﹘﹣－]|\s-|-\s|--/;
// "Vallourec - North America" → "Vallourec": the stored company name up to its
// first dash separator. Only the separator form; an in-word hyphen is kept.
function companyWithoutDashSuffix(value) {
  return String(value ?? '').split(/\s*[‒-―−]\s*|\s+-+\s*|\s*-+\s+|--/)[0].trim();
}

function validateJoleEmployerEmailV3({ subject, body } = {}, step) {
  const text = `${subject || ''}\n${body || ''}`;
  if (!String(body || '').trim() || /{{|}}/.test(text)) return 'copy is empty or contains a raw placeholder';
  if (/scalelab|employer meetings|meeting fees?|receptionist|calendar link|dental|roofing/i.test(text)) return 'copy contains another campaign\'s offer';
  // The postal address is the client's compliance value, not copy; everything
  // else (subject, sales copy, signature, opt-out line) is checked.
  const footerAt = String(body).indexOf(`\n\n${SENDER.name}\n${SENDER.title}\n`);
  const copy = footerAt === -1 ? String(body) : `${String(body).slice(0, footerAt)}\n${String(body).split('\n').slice(-1)[0]}`;
  if (DASH_PUNCTUATION.test(`${subject || ''}\n${copy}`)) return 'copy contains dash punctuation';
  const links = String(body).match(/https?:\/\/\S+|www\.\S+/gi) || [];
  if (step !== 2 && links.length) return 'only touch 2 may contain a link';
  if (step === 2 && (links.length !== 1 || links[0] !== JOLE_V3_OVERVIEW_URL)) return 'touch 2 requires exactly the Jole overview link';
  return '';
}

function renderJoleEmployerStepV3({ step, firstName, company, roles = [], location = '', mailingAddress } = {}, { withFooter = true } = {}) {
  const definition = STEPS_V3.find(item => item.step === Number(step));
  if (!definition) throw Object.assign(new Error(`invalid Jole step ${step}`), { code: 'invalid_step' });
  const safeRoles = (Array.isArray(roles) ? roles : []).filter(role => String(role || '').trim()).slice(0, 2).map(role => cleanVariable(role, 'role'));
  if (!safeRoles.length) throw Object.assign(new Error('Jole copy requires a verified hiring role'), { code: 'invalid_variable' });
  const vars = {
    first_name: cleanVariable(firstName, 'first_name'),
    company: cleanVariable(companyWithoutDashSuffix(company), 'company'),
    role: safeRoles[0],
    location: cleanVariable(location, 'location'),
    secondary_role_line: safeRoles[1] ? ` and also has openings for ${safeRoles[1]} at the site` : '',
  };
  const variant = definition.step === 1 ? (safeRoles[1] ? 'two_roles' : 'one_role') : 'default';
  const fill = template => template.replace(/{{(\w+)}}/g, (_, key) => {
    if (!Object.hasOwn(vars, key) || (!vars[key] && key !== 'secondary_role_line')) throw Object.assign(new Error(`Jole copy variable ${key} is missing`), { code: 'invalid_variable' });
    return vars[key];
  });
  const coreBody = fill(definition.bodies.default);
  const body = withFooter ? `${coreBody}\n\n${joleFooter(mailingAddress)}` : coreBody;
  const email = { step: definition.step, variant, subject: definition.subject ? fill(definition.subject) : null, coreBody, body, copyVersion: COPY_VERSION_V3 };
  const problem = validateJoleEmployerEmailV3(email, definition.step);
  if (problem) throw Object.assign(new Error(`Jole copy refused: ${problem}`), { code: 'invalid_copy' });
  return email;
}

// Every Jole copy version that has ever sent, by the id its sends record.
const JOLE_COPY_VERSIONS = Object.freeze({
  [COPY_VERSION]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY, render: renderJoleEmployerStep, validate: validateJoleEmployerEmail }),
  [COPY_VERSION_V3]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY_V3, render: renderJoleEmployerStepV3, validate: validateJoleEmployerEmailV3 }),
});
// What a never-contacted lead starts on, and what a lead whose send evidence
// predates version stamping (every send before v3) continues on.
const CURRENT_COPY_VERSION = COPY_VERSION_V3;
const LEGACY_COPY_VERSION = COPY_VERSION;

// The same outbound evidence outreach-queue.js refuses a re-queue on: sends,
// reservations (resolved or not) and uncertain deliveries.
const OUTBOUND_EVIDENCE = /(?:email_sent|follow_up_sent|sequence_step_sent|booking_link_sent|human_response_sent|send_reserved|send_uncertain)/;
const metadataOf = row => {
  if (row?.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch (_) { return {}; }
};
const normalizeEmail = value => String(value || '').trim().toLowerCase();

/**
 * Which Jole copy a lead's sequence uses. A lead stays on the version its
 * FIRST outbound evidence (send, reservation or uncertain send, from the
 * activity ledger) recorded; evidence that recorded no version is the legacy
 * v2 sequence. With no ledger evidence, a lead row that shows any send (step,
 * status or last-emailed time) also stays on v2. Only a lead with no evidence
 * anywhere starts v3. Pure.
 */
function resolveJoleCopyVersion(lead = {}, activities = []) {
  const mine = (Array.isArray(activities) ? activities : []).filter(row => (row.sourceLeadId ? row.sourceLeadId === lead.id
    : row.leadId ? [lead.id, `CE-${lead.id}`].includes(row.leadId) : normalizeEmail(row.email) === normalizeEmail(lead.email))
    && OUTBOUND_EVIDENCE.test(String(row.eventType || '')));
  if (mine.length) {
    const first = mine.slice().sort((a, b) => (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0))[0];
    const recorded = String(metadataOf(first).copyVersion || '');
    return Object.hasOwn(JOLE_COPY_VERSIONS, recorded)
      ? { copyVersion: recorded, reason: 'first_outbound_recorded_version' }
      : { copyVersion: LEGACY_COPY_VERSION, reason: 'outbound_evidence_predates_version' };
  }
  if (Number(lead.emailStep) > 0 || String(lead.emailStatus || '').trim() || String(lead.lastEmailedAt || '').trim()) {
    return { copyVersion: LEGACY_COPY_VERSION, reason: 'lead_row_shows_prior_send' };
  }
  return { copyVersion: CURRENT_COPY_VERSION, reason: 'no_outbound_evidence' };
}

module.exports = {
  JOLE_INDUSTRIAL_EMPLOYER_COPY, COPY_VERSION,
  renderJoleEmployerStep, validateJoleEmployerEmail, joleLandingPageUrl, joleBookingLink, joleFooter,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V3, COPY_VERSION_V3, JOLE_V3_OVERVIEW_URL,
  renderJoleEmployerStepV3, validateJoleEmployerEmailV3, companyWithoutDashSuffix,
  JOLE_COPY_VERSIONS, CURRENT_COPY_VERSION, LEGACY_COPY_VERSION, resolveJoleCopyVersion,
};
