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

/**
 * Jole BTX employer-acquisition copy, v4 (2026-10-21): evidence-aware. Each
 * lead's sequence uses exactly one personalization mode, decided from its
 * evidence (clients/jole-personalization.js) and pinned by its first send:
 *
 *   exact          role AND hiring site independently supported by the same
 *                  posting; the copy names both
 *   role_only      the craft role is supported, the site is not: the copy
 *                  names the role and never a place
 *   general_craft  a valid industrial employer without a clean current role
 *                  claim: the copy names neither a role, a place nor an opening
 *   hold           never rendered
 *
 * Same dash rule, link rule, footer and cadence as v3.
 */
const COPY_VERSION_V4 = 'jole_industrial_employer_v4';
const PERSONALIZATION_MODES = Object.freeze(['exact', 'role_only', 'general_craft', 'hold']);
const SENDABLE_MODES = Object.freeze(['exact', 'role_only', 'general_craft']);

const V4_T2_CONTEXT = 'Just to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.';
const V4_T2_OVERVIEW = `Here's a quick overview of Jole:\n${JOLE_V3_OVERVIEW_URL}`;
const V4_COPY = Object.freeze({
  exact: Object.freeze({
    subject: '{{role}} | {{location}}',
    bodies: Object.freeze([
      'Hi {{first_name}},\n\nSaw {{company}} is hiring {{role}} in {{location}}{{secondary_role_line}}.\n\nI can have our team check whether Jole has the right craft coverage for that site and what it would realistically take to fill the gap.\n\nWant me to check?\n\nJorge',
      `Hi {{first_name}},\n\n${V4_T2_CONTEXT}\n\nFor an opening like {{role}} in {{location}}, we'd look at the site, shift, certifications, headcount and start date, then tell you whether it's something we can realistically cover.\n\nWe're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\n${V4_T2_OVERVIEW}\n\nIf {{role}} is still open, worth having us take a look?\n\nJorge`,
      'Hi {{first_name}},\n\nIs getting the {{role}} opening in {{location}} covered still a priority for {{company}}, or has the need changed?\n\nJorge',
    ]),
  }),
  role_only: Object.freeze({
    subject: '{{role}}',
    bodies: Object.freeze([
      'Hi {{first_name}},\n\nSaw {{company}} has been hiring {{role}} recently.\n\nI can have our team check whether Jole has the right craft coverage and what it would realistically take to support the need.\n\nWant me to check?\n\nJorge',
      `Hi {{first_name}},\n\n${V4_T2_CONTEXT}\n\nFor a need like {{role}}, we'd look at the shift, certifications, headcount, start date and site requirements, then tell you whether it's something we can realistically cover.\n\nWe're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\n${V4_T2_OVERVIEW}\n\nIf the {{role}} need is still active, worth having us take a look?\n\nJorge`,
      'Hi {{first_name}},\n\nIs getting the {{role}} need covered still a priority for {{company}}, or has the need changed?\n\nJorge',
    ]),
  }),
  general_craft: Object.freeze({
    subject: 'skilled trade coverage',
    bodies: Object.freeze([
      'Hi {{first_name}},\n\nReaching out because {{company}} operates in an industrial environment where skilled trade coverage can become a bottleneck.\n\nI can have our team look at where Jole could realistically support your craft needs when coverage gets tight.\n\nWorth a look?\n\nJorge',
      `Hi {{first_name}},\n\n${V4_T2_CONTEXT}\n\nWhen an employer needs additional craft coverage, we look at the trades, site requirements, headcount, certifications and timing, then tell them whether it's something we can realistically support.\n\nWe're not trying to force every requirement into a fit. If we can't cover it properly, we'll tell you.\n\n${V4_T2_OVERVIEW}\n\nWorth keeping Jole in mind when coverage gets tight?\n\nJorge`,
      'Hi {{first_name}},\n\nIs adding another option for skilled trade coverage something {{company}} is focused on right now, or are you mostly covered?\n\nJorge',
    ]),
  }),
});

const JOLE_INDUSTRIAL_EMPLOYER_COPY_V4 = Object.freeze({
  copyVersion: COPY_VERSION_V4, sender: SENDER, modes: V4_COPY,
  // v3's cadence: T1, then three and four business days after the previous touch.
  steps: Object.freeze(STEPS_V3.map(({ step, sendAfterBusinessDays }) => Object.freeze({ step, sendAfterBusinessDays }))),
  requiredConfig: Object.freeze(['JOLE_COMMERCIAL_MAILING_ADDRESS']),
  cadence: JOLE_INDUSTRIAL_EMPLOYER_COPY.cadence,
  footer: JOLE_INDUSTRIAL_EMPLOYER_COPY.footer,
  linkPolicy: JOLE_INDUSTRIAL_EMPLOYER_COPY_V3.linkPolicy,
});

const CITY_STATE = /\b[A-Z][A-Za-z.' ]+, [A-Z]{2}\b/;
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * The claims each mode may and may not make, on the sales copy (subject and
 * body before the footer). '' when the email keeps to its mode.
 */
function v4ModeProblem(email, { mode, role = '', location = '', company = '', forbiddenRoles = [], forbiddenLocations = [] } = {}) {
  const copy = `${email.subject || ''}\n${email.coreBody || ''}`;
  const has = text => Boolean(text) && copy.toLowerCase().includes(String(text).toLowerCase());
  if (mode === 'exact') return has(role) && has(location) ? '' : 'exact copy must name its verified role and site';
  // Neither lower mode may place the company anywhere ("Acme, LP" is a name, not a place).
  const withoutCompany = company ? copy.split(company).join(' ') : copy;
  if (CITY_STATE.test(withoutCompany) || [location, ...forbiddenLocations].some(has)) return `${mode} copy must not name a location`;
  if (mode === 'role_only') return has(role) ? '' : 'role_only copy must name its verified role';
  if (mode === 'general_craft') {
    if (/\bhiring\b|\bopenings?\b|\bposting\b/i.test(copy)) return 'general_craft copy must not claim a current opening';
    if ([role, ...forbiddenRoles].some(has)) return 'general_craft copy must not name a role';
    return '';
  }
  return `invalid personalization mode ${mode}`;
}

function validateJoleEmployerEmailV4(email = {}, step, personalization) {
  const base = validateJoleEmployerEmailV3(email, step);
  if (base) return base;
  if (!personalization) return '';
  return v4ModeProblem({ ...email, coreBody: email.coreBody ?? String(email.body || '').split(`\n\n${SENDER.name}\n${SENDER.title}\n`)[0] }, personalization);
}

/**
 * Render one v4 touch. personalization: { mode, role, location,
 * secondaryRole } from the lead's resolved evidence. Throws on hold, an
 * unknown mode, a missing value the mode needs, or any claim the mode forbids.
 */
function renderJoleEmployerStepV4({ step, firstName, company, mailingAddress, personalization = {} } = {}, { withFooter = true } = {}) {
  const definition = STEPS_V3.find(item => item.step === Number(step));
  if (!definition) throw fail('invalid_step', `invalid Jole step ${step}`);
  const mode = String(personalization.mode || '');
  if (mode === 'hold') throw fail('personalization_hold', `Jole personalization hold: ${personalization.reason || 'held for review'}`);
  if (!SENDABLE_MODES.includes(mode)) throw fail('personalization_mode_missing', `no Jole personalization mode for this lead (${mode || 'unclassified'})`);
  const template = V4_COPY[mode];
  const vars = { first_name: cleanVariable(firstName, 'first_name'), company: cleanVariable(companyWithoutDashSuffix(company), 'company') };
  if (mode === 'exact' || mode === 'role_only') vars.role = cleanVariable(personalization.role, 'role');
  if (mode === 'exact') {
    vars.location = cleanVariable(personalization.location, 'location');
    // Only a second role with its own verified evidence; none is otherwise invented.
    vars.secondary_role_line = personalization.secondaryRole ? ` and also has openings for ${cleanVariable(personalization.secondaryRole, 'role')} at the site` : '';
  }
  const fill = text => text.replace(/{{(\w+)}}/g, (_, key) => {
    if (!Object.hasOwn(vars, key) || (!vars[key] && key !== 'secondary_role_line')) throw fail('invalid_variable', `Jole copy variable ${key} is missing`);
    return vars[key];
  });
  const coreBody = fill(template.bodies[definition.step - 1]);
  const body = withFooter ? `${coreBody}\n\n${joleFooter(mailingAddress)}` : coreBody;
  const email = {
    step: definition.step, variant: mode, subject: definition.step === 1 ? fill(template.subject) : null,
    coreBody, body, copyVersion: COPY_VERSION_V4, personalizationMode: mode,
  };
  const problem = validateJoleEmployerEmailV4(email, definition.step, { ...personalization, mode, company: vars.company });
  if (problem) throw fail('invalid_copy', `Jole copy refused: ${problem}`);
  return email;
}

/**
 * Jole BTX employer-acquisition copy, v5 (2026-10-27): the approved
 * three-touch sequence, evidence-aware like v4 and on the same
 * classification, mode pinning, cadence and footer. `exact` is the approved
 * copy word for word. `role_only` drops only the location references.
 * `general_craft` names no role, no place and no current opening.
 *
 * Unlike every earlier version, v5 is the copy of a lead's NEXT UNSENT touch
 * whatever version its thread began on (resolveJoleCopyVersion): an open v2,
 * v3 or v4 thread continues with the v5 follow-up for its current step, and
 * keeps the claims its first email made (jole-personalization.js). No touch
 * carries a link.
 */
const COPY_VERSION_V5 = 'jole_industrial_employer_v5';

const V5_T1_OFFER = "Jole supplies contract skilled tradespeople to industrial sites. If that's an option, I can check whether we could cover the role and how quickly someone could realistically start.";
const V5_T2_OFFER = "I help industrial sites with both contract crews and permanent skilled trade hires.\n\nIf useful, I can send over the trades I typically help with.";
const V5_T3 = 'Hi {{first_name}},\n\nQuick question, are you the one who handles bringing in outside tradespeople, or does someone else on your team take care of that?\n\nJorge';
const V5_COPY = Object.freeze({
  exact: Object.freeze({
    subject: '{{role}} in {{location}}',
    bodies: Object.freeze([
      `Hi {{first_name}},\n\nSaw you were hiring {{role}} in {{location}}.\n\nIs that strictly a permanent hire, or would bringing in contract labor help in the meantime?\n\n${V5_T1_OFFER}\n\nJorge`,
      `Hi {{first_name}},\n\nWas the {{role}} opening in {{location}} for a specific project, or are you looking to grow your crew long term?\n\n${V5_T2_OFFER}\n\nJorge`,
      V5_T3,
    ]),
  }),
  role_only: Object.freeze({
    subject: '{{role}}',
    bodies: Object.freeze([
      `Hi {{first_name}},\n\nSaw you were hiring {{role}}.\n\nIs that strictly a permanent hire, or would bringing in contract labor help in the meantime?\n\n${V5_T1_OFFER}\n\nJorge`,
      `Hi {{first_name}},\n\nWas the {{role}} opening for a specific project, or are you looking to grow your crew long term?\n\n${V5_T2_OFFER}\n\nJorge`,
      V5_T3,
    ]),
  }),
  general_craft: Object.freeze({
    subject: 'contract tradespeople',
    bodies: Object.freeze([
      "Hi {{first_name}},\n\nWhen a skilled trade position comes up at {{company}}, is it strictly a permanent hire, or would bringing in contract labor help in the meantime?\n\nJole supplies contract skilled tradespeople to industrial sites. If that's ever an option, I can check whether we could cover it and how quickly someone could realistically start.\n\nJorge",
      `Hi {{first_name}},\n\nWhen {{company}} brings on skilled trades, is it usually for a specific project, or to grow your crew long term?\n\n${V5_T2_OFFER}\n\nJorge`,
      V5_T3,
    ]),
  }),
});

const JOLE_INDUSTRIAL_EMPLOYER_COPY_V5 = Object.freeze({
  copyVersion: COPY_VERSION_V5, sender: SENDER, modes: V5_COPY,
  steps: JOLE_INDUSTRIAL_EMPLOYER_COPY_V4.steps,
  requiredConfig: Object.freeze(['JOLE_COMMERCIAL_MAILING_ADDRESS']),
  cadence: JOLE_INDUSTRIAL_EMPLOYER_COPY.cadence,
  footer: JOLE_INDUSTRIAL_EMPLOYER_COPY.footer,
  linkPolicy: 'no touch carries a link',
});

/**
 * v4's claim rules, except that a touch which names neither role nor place
 * (every Touch 3) need not repeat the claims its mode may make.
 */
function v5ModeProblem(email, personalization = {}, step) {
  if (Number(step) === 3 && personalization.mode !== 'general_craft') {
    const asNeutral = { ...personalization, mode: 'general_craft', role: '', forbiddenRoles: [personalization.role].filter(Boolean) };
    return v4ModeProblem(email, asNeutral) ? `${personalization.mode} touch 3 must not name a role or place` : '';
  }
  return v4ModeProblem(email, personalization);
}

function validateJoleEmployerEmailV5(email = {}, step, personalization) {
  const { subject, body } = email;
  const text = `${subject || ''}\n${body || ''}`;
  if (!String(body || '').trim() || /{{|}}/.test(text)) return 'copy is empty or contains a raw placeholder';
  if (/scalelab|employer meetings|meeting fees?|receptionist|calendar link|dental|roofing/i.test(text)) return 'copy contains another campaign\'s offer';
  const footerAt = String(body).indexOf(`\n\n${SENDER.name}\n${SENDER.title}\n`);
  const copy = footerAt === -1 ? String(body) : `${String(body).slice(0, footerAt)}\n${String(body).split('\n').slice(-1)[0]}`;
  if (DASH_PUNCTUATION.test(`${subject || ''}\n${copy}`)) return 'copy contains dash punctuation';
  if (/https?:\/\/|www\./i.test(String(body))) return 'v5 copy carries no link';
  if (!personalization) return '';
  return v5ModeProblem({ ...email, coreBody: email.coreBody ?? String(body || '').split(`\n\n${SENDER.name}\n${SENDER.title}\n`)[0] }, personalization, step);
}

/** Render one v5 touch; the same contract as renderJoleEmployerStepV4. */
function renderJoleEmployerStepV5({ step, firstName, company, mailingAddress, personalization = {} } = {}, { withFooter = true } = {}) {
  const definition = JOLE_INDUSTRIAL_EMPLOYER_COPY_V5.steps.find(item => item.step === Number(step));
  if (!definition) throw fail('invalid_step', `invalid Jole step ${step}`);
  const mode = String(personalization.mode || '');
  if (mode === 'hold') throw fail('personalization_hold', `Jole personalization hold: ${personalization.reason || 'held for review'}`);
  if (!SENDABLE_MODES.includes(mode)) throw fail('personalization_mode_missing', `no Jole personalization mode for this lead (${mode || 'unclassified'})`);
  const template = V5_COPY[mode];
  const vars = { first_name: cleanVariable(firstName, 'first_name'), company: cleanVariable(companyWithoutDashSuffix(company), 'company') };
  if (mode === 'exact' || mode === 'role_only') vars.role = cleanVariable(personalization.role, 'role');
  if (mode === 'exact') vars.location = cleanVariable(personalization.location, 'location');
  const fill = text => text.replace(/{{(\w+)}}/g, (_, key) => {
    if (!vars[key]) throw fail('invalid_variable', `Jole copy variable ${key} is missing`);
    return vars[key];
  });
  const coreBody = fill(template.bodies[definition.step - 1]);
  const body = withFooter ? `${coreBody}\n\n${joleFooter(mailingAddress)}` : coreBody;
  const email = {
    step: definition.step, variant: mode, subject: definition.step === 1 ? fill(template.subject) : null,
    coreBody, body, copyVersion: COPY_VERSION_V5, personalizationMode: mode,
  };
  const problem = validateJoleEmployerEmailV5(email, definition.step, { ...personalization, mode, company: vars.company });
  if (problem) throw fail('invalid_copy', `Jole copy refused: ${problem}`);
  return email;
}

// Every Jole copy version that has ever sent, by the id its sends record.
// v2, v3 and v4 stay renderable for audit, reconstruction and rollback; only
// CURRENT_COPY_VERSION is ever selected for a touch not yet attempted.
const JOLE_COPY_VERSIONS = Object.freeze({
  [COPY_VERSION]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY, render: renderJoleEmployerStep, validate: validateJoleEmployerEmail }),
  [COPY_VERSION_V3]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY_V3, render: renderJoleEmployerStepV3, validate: validateJoleEmployerEmailV3 }),
  [COPY_VERSION_V4]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY_V4, render: renderJoleEmployerStepV4, validate: validateJoleEmployerEmailV4, evidenceAware: true }),
  [COPY_VERSION_V5]: Object.freeze({ copy: JOLE_INDUSTRIAL_EMPLOYER_COPY_V5, render: renderJoleEmployerStepV5, validate: validateJoleEmployerEmailV5, evidenceAware: true }),
});
// The copy of every touch not yet attempted, and the version a thread whose
// first send recorded no version (every send before v3) began on.
const CURRENT_COPY_VERSION = COPY_VERSION_V5;
const LEGACY_COPY_VERSION = COPY_VERSION;

// The same outbound evidence outreach-queue.js refuses a re-queue on: sends,
// reservations (resolved or not) and uncertain deliveries.
const OUTBOUND_EVIDENCE = /(?:email_sent|follow_up_sent|sequence_step_sent|booking_link_sent|human_response_sent|send_reserved|send_uncertain)/;
const SEND_EVENTS = Object.freeze(['initial_email_sent', 'follow_up_sent']);
const metadataOf = row => {
  if (row?.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch (_) { return {}; }
};
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const isLeadRow = (lead, row) => (row.sourceLeadId ? row.sourceLeadId === lead.id
  : row.leadId ? [lead.id, `CE-${lead.id}`].includes(row.leadId) : normalizeEmail(row.email) === normalizeEmail(lead.email));
const byTime = (a, b) => (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0);
const recordedVersion = row => {
  const recorded = String(metadataOf(row).copyVersion || '');
  return Object.hasOwn(JOLE_COPY_VERSIONS, recorded) ? recorded : LEGACY_COPY_VERSION;
};
const stepOfRow = row => (row.eventType === 'initial_email_sent' ? 1 : Number(metadataOf(row).step ?? metadataOf(row).sequenceStep));

/** Outbound ledger rows for this lead that still count: a reservation whose failure was recorded does not. */
function liveOutboundRows(lead, activities) {
  const rows = (Array.isArray(activities) ? activities : []).filter(row => isLeadRow(lead, row));
  const failed = new Set(rows.filter(row => /_send_failed$/.test(String(row.eventType || '')))
    .map(row => metadataOf(row).reservationEventId).filter(Boolean));
  return rows.filter(row => OUTBOUND_EVIDENCE.test(String(row.eventType || '')) && !failed.has(row.eventId)).sort(byTime);
}

/**
 * The version a lead's thread began on (what its first outbound evidence
 * recorded), or null for a lead never attempted. History only: it decides
 * which claims a later touch must keep, never which copy that touch uses.
 */
function joleThreadCopyVersion(lead = {}, activities = []) {
  const all = (Array.isArray(activities) ? activities : []).filter(row => isLeadRow(lead, row)
    && OUTBOUND_EVIDENCE.test(String(row.eventType || ''))).sort(byTime);
  if (all.length) return recordedVersion(all[0]);
  if (Number(lead.emailStep) > 0 || String(lead.emailStatus || '').trim() || String(lead.lastEmailedAt || '').trim()) return LEGACY_COPY_VERSION;
  return null;
}

/**
 * Which Jole copy renders `step` of this lead (default: its next step).
 *
 *   1. A step the ledger shows SENT renders as the version that send recorded
 *      (no version recorded: legacy v2), so a delivered email is never
 *      re-described in another version.
 *   2. A step with a live (not failed) reservation or uncertain delivery keeps
 *      the version that attempt recorded, so the reservation, the delivery
 *      re-check and a provider recovery all agree on the copy.
 *   3. Every other step is a touch not yet attempted: CURRENT_COPY_VERSION
 *      (v5), whatever version the thread began on.
 *
 * threadCopyVersion is history only. Pure.
 */
function resolveJoleCopyVersion(lead = {}, activities = [], { step } = {}) {
  const target = Number(step) || (Number(lead.emailStep) || 0) + 1;
  const threadCopyVersion = joleThreadCopyVersion(lead, activities);
  const forStep = liveOutboundRows(lead, activities).filter(row => stepOfRow(row) === target);
  const sent = forStep.find(row => SEND_EVENTS.includes(row.eventType));
  if (sent) return { copyVersion: recordedVersion(sent), threadCopyVersion, step: target, reason: 'step_sent_recorded_version' };
  if (forStep.length) return { copyVersion: recordedVersion(forStep[0]), threadCopyVersion, step: target, reason: 'step_attempt_recorded_version' };
  return {
    copyVersion: CURRENT_COPY_VERSION, threadCopyVersion, step: target,
    reason: threadCopyVersion ? 'v5_rollout_next_unsent_step' : 'no_outbound_evidence',
  };
}

module.exports = {
  JOLE_INDUSTRIAL_EMPLOYER_COPY, COPY_VERSION,
  renderJoleEmployerStep, validateJoleEmployerEmail, joleLandingPageUrl, joleBookingLink, joleFooter,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V3, COPY_VERSION_V3, JOLE_V3_OVERVIEW_URL,
  renderJoleEmployerStepV3, validateJoleEmployerEmailV3, companyWithoutDashSuffix,
  JOLE_COPY_VERSIONS, CURRENT_COPY_VERSION, LEGACY_COPY_VERSION, resolveJoleCopyVersion,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V4, COPY_VERSION_V4, PERSONALIZATION_MODES, SENDABLE_MODES,
  renderJoleEmployerStepV4, validateJoleEmployerEmailV4, v4ModeProblem,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V5, COPY_VERSION_V5, renderJoleEmployerStepV5, validateJoleEmployerEmailV5, v5ModeProblem,
  joleThreadCopyVersion,
};
