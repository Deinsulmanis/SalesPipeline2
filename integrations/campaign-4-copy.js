'use strict';

/**
 * Campaign 4 "HOLD Company Test" (owner brief 2026-11-27): the approved copy,
 * its renderer and its validator.
 *
 * Built on Campaign 3 copy v2 (staffing-v4-copy.js): the same locked phrases,
 * the same Emails 2 and 3 word for word (Email 2 keeps the sample-list offer),
 * the same "Deins" sign-off, no dashes, and the same variable rules. Only
 * Email 1's opening line differs. The HOLD cohort's specialisation was NOT
 * verified, so the opener is conditional ("If you place ...") and never claims
 * we checked what the agency places. There is one copy version, c4_v1, sealed
 * on every lead's profile (campaign-4-profile.js) and recorded on every send.
 *
 * Pure: no I/O, no model calls.
 */

const {
  SIGNATURE, V2_EMAIL_1_LOCK, V2_EMAIL_2_BOLD, V2_EMAIL_3_LOCK, FOLLOW_UPS_V2,
  PERFORMANCE_SENTENCE, EMAIL_2_BOLD, EMAIL_3_BOLD, variableProblem,
} = require('./staffing-v4-copy');

const C4_COPY_VERSION = 'c4_v1';
const C4_COPY_VERSIONS = Object.freeze([C4_COPY_VERSION]);
const C4_VARIABLE_NAMES = Object.freeze(['first_name', 'company']);
const C4_OPENER = 'If you place warehouse, production or skilled trades workers, we can help you win more employer accounts in that market.';
const DASHES = /[‒–—―−]/;

const C4_EMAIL_1 = Object.freeze({
  subject: 'Employer accounts for {{company}}',
  body: `Hi {{first_name}},\n\n${C4_OPENER}\n\n`
    + 'We book qualified employer meetings for industrial staffing agencies, and we only get paid for the meetings we book.\n\n'
    + `Worth seeing how we'd do this for {{company}}?\n\n${SIGNATURE}`,
  variables: C4_VARIABLE_NAMES,
  lock: V2_EMAIL_1_LOCK,
});
// Emails 2 and 3 are Campaign 3 copy v2's, unchanged (the object is shared, not copied).
const C4_FOLLOW_UPS = FOLLOW_UPS_V2;
const C4_SUBJECT_PREFIX = C4_EMAIL_1.subject.split('{{')[0];

// Phrases Campaign 4 must never carry: anything that claims a verified
// specialisation or a signal we did not check, and Campaign 3 v1's locked lines.
const UNVERIFIED_CLAIMS = Object.freeze([/\bSaw you place\b/i, /\bSaw [^\n]* focuses on\b/i, /\bSaw you're\b/i, /\bverified\b/i]);

if (C4_EMAIL_1.body.split(V2_EMAIL_1_LOCK).length !== 2) throw new Error('Campaign 4 Email 1 must carry the v2 lock exactly once');
if (DASHES.test(C4_EMAIL_1.body) || DASHES.test(C4_EMAIL_1.subject)) throw new Error('Campaign 4 copy must not contain a dash');

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function c4TemplateFor(step) {
  if (step === 1) return C4_EMAIL_1;
  const follow = C4_FOLLOW_UPS.find(item => item.step === step);
  if (!follow) throw new Error('Invalid Campaign 4 sequence step');
  return { ...follow, lock: follow.lock || follow.bold };
}

function mergeStrict(template, vars) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    if (!C4_VARIABLE_NAMES.includes(key)) throw new Error(`Campaign 4 variable refused: unknown variable ${key}`);
    const problem = variableProblem(key, vars[key]);
    if (problem) throw new Error(`Campaign 4 variable refused: ${problem}`);
    return vars[key];
  });
}

/**
 * One Campaign 4 touch, merged. `appendFooter(text)` adds the ScaleLab
 * compliance footer (with Ref: SA-48271). Throws on anything unresolved.
 */
function renderC4Copy({ step, vars = {}, appendFooter, resumeLine = '', copyVersion = C4_COPY_VERSION }) {
  if (typeof appendFooter !== 'function') throw new Error('Campaign 4 render needs the compliance footer');
  if (!C4_COPY_VERSIONS.includes(copyVersion)) throw new Error(`unknown Campaign 4 copy version ${copyVersion || '(blank)'}`);
  const template = c4TemplateFor(step);
  const problems = template.variables.map(name => variableProblem(name, vars[name])).filter(Boolean);
  if (problems.length) throw new Error(`Campaign 4 Email ${step} refused: ${problems.join('; ')}`);
  let copy = mergeStrict(template.body, vars);
  if (resumeLine) {
    if (step === 1) throw new Error('only a Campaign 4 follow-up can carry the out-of-office resume line');
    const at = copy.indexOf('\n\n');
    copy = `${copy.slice(0, at)}\n\n${resumeLine}${copy.slice(at)}`;
  }
  if (DASHES.test(copy)) throw new Error('Campaign 4 copy contains an en or em dash');
  const body = appendFooter(copy);
  const subject = mergeStrict(template.subject, vars);
  if (body.split(template.lock).length !== 2) throw new Error('Campaign 4 copy must contain its locked sentence exactly once');
  const phrase = template.bold || null;
  let html = phrase ? body.split(phrase).map(escapeHtml).join(`<strong>${escapeHtml(phrase)}</strong>`) : escapeHtml(body);
  html = html.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject, body, html, copy, bold: phrase, copyVersion };
}

/** Why a rendered Campaign 4 touch is unsafe, or null. Same rules as Campaign 3 v2, plus C4's own. */
function c4CopyProblem({ body, subject, copyVersion = C4_COPY_VERSION } = {}, step) {
  const text = String(body || '');
  if (!text.trim()) return 'Campaign 4 body is empty';
  if (/{{|}}/.test(text) || /{{|}}/.test(String(subject || ''))) return 'Campaign 4 email still contains an unmerged placeholder';
  if (/\b(?:undefined|null|NaN)\b/.test(text)) return 'Campaign 4 body contains an unresolved value';
  if (!C4_COPY_VERSIONS.includes(copyVersion)) return `unknown Campaign 4 copy version ${copyVersion}`;
  let template;
  try { template = c4TemplateFor(step); } catch (error) { return error.message; }
  if (text.split(template.lock).length !== 2) return 'Campaign 4 body is missing its locked sentence';
  if ([PERFORMANCE_SENTENCE, EMAIL_2_BOLD, EMAIL_3_BOLD].some(line => text.includes(line))) return 'Campaign 4 body carries Campaign 3 v1 copy';
  const copy = text.split(`\n\n${SIGNATURE}\n\n`)[0];
  if (DASHES.test(copy)) return 'Campaign 4 copy contains an en or em dash';
  if (!text.includes(`\n\n${SIGNATURE}\n\n`)) return 'Campaign 4 body must sign off as Deins before the footer';
  if (UNVERIFIED_CLAIMS.some(pattern => pattern.test(copy))) return 'Campaign 4 copy claims a verified specialisation or signal';
  if (step === 1) {
    if (!copy.includes(C4_OPENER)) return 'Campaign 4 Email 1 is missing its approved opener';
    if (!String(subject || '').startsWith(C4_SUBJECT_PREFIX)) return 'Campaign 4 step 1 subject is not the approved subject';
  }
  return null;
}

module.exports = {
  C4_COPY_VERSION, C4_COPY_VERSIONS, C4_VARIABLE_NAMES, C4_OPENER, C4_EMAIL_1, C4_FOLLOW_UPS, C4_SUBJECT_PREFIX,
  V2_EMAIL_1_LOCK, V2_EMAIL_2_BOLD, V2_EMAIL_3_LOCK,
  c4TemplateFor, renderC4Copy, c4CopyProblem,
};
