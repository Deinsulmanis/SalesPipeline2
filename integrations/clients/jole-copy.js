'use strict';

/**
 * Jole BTX employer-acquisition copy, v1 (template jole-industrial-employer-v1).
 *
 * The approved three-touch sequence from Jole's sequence review (2026-10-05),
 * on the canonical client id `jole`. Jole's offer is to INDUSTRIAL END
 * EMPLOYERS: Jole supplies skilled-trade labor. It is not ScaleLab's
 * staffing-agency offer and shares no copy with it.
 *
 * Copy and an offline renderer only. Nothing here selects leads, routes,
 * queues or sends, and no send path imports it: the campaign stays DRAFT and
 * the template not ready until launch is approved separately.
 *
 * Rendering is strict. A missing or unsafe variable refuses to render rather
 * than falling back to a guess; the only fallback is the reviewed role
 * "skilled trades" and the reviewed no-hiring-claim opener.
 */

const { STAFFING_OPT_OUT_LINE, resolveCommercialMailingAddress } = require('../staffing-compliance');

const COPY_VERSION = 'jole_industrial_employer_v1';
const FALLBACK_ROLE = 'skilled trades';
const SENDER = Object.freeze({ name: 'Jorge Guerrero', title: 'CEO', company: 'Jole BTX LLC', signOff: 'Jorge' });
// Env names the launch must set. Never a ScaleLab value: Jole's address and
// landing page do not fall back to the global ones.
const REQUIRED_CONFIG = Object.freeze(['JOLE_LANDING_PAGE_URL', 'JOLE_COMMERCIAL_MAILING_ADDRESS']);

const TOUCH_1 = Object.freeze({
  one_role: 'Hi {{first_name}},\n\nSaw {{company}} is hiring {{role}} in {{location}}.\n\nCurious — are you already covered on that, or still open to additional staffing support?\n\nJorge',
  two_roles: 'Hi {{first_name}},\n\nSaw {{company}} is hiring {{role_1}} and {{role_2}} in {{location}}.\n\nCurious — are you already covered on those, or still open to additional staffing support?\n\nJorge',
  // Only for a separately reviewed employer record: claims no active hiring.
  employer_fallback: 'Hi {{first_name}},\n\nCurious — is {{company}} already covered on skilled trades, or still open to additional staffing support?\n\nJorge',
});
const TOUCH_2 = "Hi {{first_name}},\n\nReason I asked — Jole BTX helps industrial employers bring in skilled trades for project and contract needs.\n\nWe've been in industrial staffing for about 25 years, support roughly 800 workers a year, and can often start presenting qualified labor within about a week depending on the role and location.\n\nHere's a quick overview of how we help:\n{{jole_landing_page_url}}\n\nWorth a conversation if {{role}} is still a priority?\n\nJorge";
const TOUCH_3 = "Hi {{first_name}},\n\nWanted to close the loop on this.\n\nShould I keep Jole in mind if {{company}} needs additional skilled-trade labor, or is this not something you're looking for right now?\n\nJorge";

const STEPS = Object.freeze([
  // Subject is the verified role (the first, when there are two); reviewed fallback "skilled trades".
  Object.freeze({ step: 1, sendAfterBusinessDays: 0, subject: '{{role}}', bodies: TOUCH_1 }),
  // Follow-ups reply in the original Gmail thread; no new subject.
  Object.freeze({ step: 2, sendAfterBusinessDays: 3, subject: null, bodies: Object.freeze({ default: TOUCH_2 }) }),
  Object.freeze({ step: 3, sendAfterBusinessDays: 4, subject: null, bodies: Object.freeze({ default: TOUCH_3 }) }),
]);

const JOLE_INDUSTRIAL_EMPLOYER_COPY = Object.freeze({
  copyVersion: COPY_VERSION, sender: SENDER, steps: STEPS, fallbackRole: FALLBACK_ROLE,
  requiredConfig: REQUIRED_CONFIG,
  // Cadence counts business days after the PREVIOUS touch's actual delivery.
  cadence: 'T1 day 0; T2 three business days after T1 was delivered; T3 four business days after T2 was delivered',
  footer: 'Jorge Guerrero / CEO / Jole BTX LLC / JOLE_COMMERCIAL_MAILING_ADDRESS, then the commercial-email notice and reply-unsubscribe line',
  linkPolicy: 'Touch 2 carries exactly one link, the Jole landing page; touches 1 and 3 carry none',
});

const UNSAFE_VARIABLE = /[\r\n<>\u0000-\u001f]|{{|}}|https?:\/\/|www\./i;
function cleanVariable(value, field) {
  const text = String(value ?? '').trim();
  if (!text || UNSAFE_VARIABLE.test(text)) throw Object.assign(new Error(`Jole copy variable ${field} is missing or unsafe`), { code: 'invalid_variable' });
  return text;
}

function joleLandingPageUrl(value) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { url = null; }
  if (!url || url.protocol !== 'https:' || url.username || url.password || /{{|}}|placeholder|change.?me/i.test(raw)
    || /(?:scalelab|localhost|example|placeholder|\.test$|\.invalid$)/i.test(url.hostname)) {
    throw Object.assign(new Error('JOLE_LANDING_PAGE_URL must be the approved Jole HTTPS landing page'), { code: 'invalid_landing_page' });
  }
  return url.href;
}

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
  if (step === 2 && links.length !== 1) return 'touch 2 requires exactly one landing-page link';
  return '';
}

/**
 * Render one touch. roles: the lead's verified hiring roles (0–2); none uses the
 * reviewed fallbacks. With withFooter:false the compliance footer (which needs
 * the Jole mailing address) is omitted — for offline review only.
 */
function renderJoleEmployerStep({ step, firstName, company, roles = [], location = '', landingPageUrl = '', mailingAddress } = {}, { withFooter = true } = {}) {
  const definition = STEPS.find(item => item.step === Number(step));
  if (!definition) throw Object.assign(new Error(`invalid Jole step ${step}`), { code: 'invalid_step' });
  const safeRoles = (Array.isArray(roles) ? roles : []).filter(role => String(role || '').trim()).slice(0, 2).map(role => cleanVariable(role, 'role'));
  const vars = {
    first_name: cleanVariable(firstName, 'first_name'),
    company: cleanVariable(company, 'company'),
    role: safeRoles[0] || FALLBACK_ROLE,
    role_1: safeRoles[0] || '', role_2: safeRoles[1] || '',
  };
  let variant = 'default';
  if (definition.step === 1) {
    variant = !safeRoles.length ? 'employer_fallback' : safeRoles.length === 2 ? 'two_roles' : 'one_role';
    if (variant !== 'employer_fallback') vars.location = cleanVariable(location, 'location');
  }
  if (definition.step === 2) vars.jole_landing_page_url = joleLandingPageUrl(landingPageUrl);
  const fill = template => template.replace(/{{(\w+)}}/g, (_, key) => {
    if (!vars[key]) throw Object.assign(new Error(`Jole copy variable ${key} is missing`), { code: 'invalid_variable' });
    return vars[key];
  });
  const coreBody = fill(definition.bodies[variant]);
  const body = withFooter ? `${coreBody}\n\n${joleFooter(mailingAddress)}` : coreBody;
  const email = { step: definition.step, variant, subject: definition.subject ? fill(definition.subject) : null, coreBody, body, copyVersion: COPY_VERSION };
  const problem = validateJoleEmployerEmail(email, definition.step);
  if (problem) throw Object.assign(new Error(`Jole copy refused: ${problem}`), { code: 'invalid_copy' });
  return email;
}

module.exports = {
  JOLE_INDUSTRIAL_EMPLOYER_COPY, COPY_VERSION, FALLBACK_ROLE,
  renderJoleEmployerStep, validateJoleEmployerEmail, joleLandingPageUrl, joleFooter,
};
