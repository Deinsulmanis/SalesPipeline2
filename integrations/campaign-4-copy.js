'use strict';

/**
 * Campaign 4 "HOLD Company Test" copy (owner decisions 2026-11-27).
 *
 * Campaign 4 sends Campaign 3's copy v2 exactly (staffing-v4-copy.js): the six
 * evidence-selected Email 1 variants and the shared Emails 2 and 3. It adds ONE
 * variant of its own, COPY_G, a non-claiming Email 1 used only when Campaign 3's
 * selector finds no verified variant for the lead. COPY_G states nothing about
 * the agency: no specialisation, signal or market. Its text is the owner's,
 * exactly. Emails 2 and 3, the footer with Ref: SA-48271, the locked phrases,
 * the no-dash rule and the validator are Campaign 3's.
 *
 * COPY_G exists for Campaign 4 only: Campaign 3's VARIANTS, selector and
 * renderer are unchanged and never see it. Pure: no I/O, no model calls.
 */

const {
  VARIANTS, SIGNATURE, V2_EMAIL_1_LOCK, FOLLOW_UPS_V2, variableProblem, renderV4Copy,
} = require('./staffing-v4-copy');

const COPY_G = Object.freeze({
  subject: 'Employer accounts for {{company}}',
  body: 'Hi {{first_name}},\n\nIs bringing in more employer accounts a focus for {{company}} right now?\n\n'
    + 'We help staffing agencies win qualified meetings with employers who need workers, and we only get paid for the meetings we book.\n\n'
    + `Worth seeing how we'd do this for you {{first_name}}?\n\n${SIGNATURE}`,
  variables: Object.freeze(['first_name', 'company']),
});
const C4_VARIANTS = Object.freeze([...VARIANTS, 'COPY_G']);
const DASHES = /[‒–—―−]/;

if (COPY_G.body.split(V2_EMAIL_1_LOCK).length !== 2) throw new Error('COPY_G must carry the v2 Email 1 lock exactly once');
if (DASHES.test(COPY_G.body) || DASHES.test(COPY_G.subject)) throw new Error('COPY_G must not contain a dash');

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mergeStrict(template, vars) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    const problem = variableProblem(key, vars[key]);
    if (problem) throw new Error(`Campaign 4 variable refused: ${problem}`);
    return vars[key];
  });
}

/**
 * One Campaign 4 touch. A Campaign 3 variant renders through Campaign 3's own
 * renderer, byte for byte. COPY_G renders its Email 1 here and its Emails 2
 * and 3 from Campaign 3's shared follow-ups (identical for every variant).
 */
function renderC4Copy({ variant, step, vars = {}, appendFooter, resumeLine = '', copyVersion = 'v2' }) {
  if (copyVersion !== 'v2') throw new Error(`Campaign 4 sends copy v2 only (got ${copyVersion || '(blank)'})`);
  if (variant !== 'COPY_G') return renderV4Copy({ variant, step, vars, appendFooter, resumeLine, copyVersion });
  if (typeof appendFooter !== 'function') throw new Error('Campaign 4 render needs the compliance footer');
  if (step !== 1) {
    if (!FOLLOW_UPS_V2.some(item => item.step === step)) throw new Error('Invalid Campaign 4 sequence step');
    // The shared follow-ups merge only first_name; any Campaign 3 variant renders them identically.
    return { ...renderV4Copy({ variant: 'COPY_C', step, vars: { first_name: vars.first_name }, appendFooter, resumeLine, copyVersion }), copyVersion };
  }
  if (resumeLine) throw new Error('only a Campaign 4 follow-up can carry the out-of-office resume line');
  const problems = COPY_G.variables.map(name => variableProblem(name, vars[name])).filter(Boolean);
  if (problems.length) throw new Error(`Campaign 4 Email 1 refused: ${problems.join('; ')}`);
  const copy = mergeStrict(COPY_G.body, vars);
  if (DASHES.test(copy)) throw new Error('Campaign 4 copy contains an en or em dash');
  const body = appendFooter(copy);
  if (body.split(V2_EMAIL_1_LOCK).length !== 2) throw new Error('Campaign 4 copy must contain its locked sentence exactly once');
  const html = escapeHtml(body).split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject: mergeStrict(COPY_G.subject, vars), body, html, copy, bold: null, copyVersion };
}

module.exports = { COPY_G, C4_VARIANTS, renderC4Copy };
