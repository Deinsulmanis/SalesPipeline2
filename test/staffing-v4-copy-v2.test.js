'use strict';

// Industrial Campaign 3 copy v2 (owner-approved copy change 2026-11-24).
// Pins the owner's text for all six Email 1 variants and both follow-ups, the
// COPY_C primary / fallback / HOLD rule and specialty_line validation, the
// locked sentences and bold rules, the website-free Campaign 3 footer, and the
// per-lead version pin: a lead whose Email 1 went out on v1 finishes on v1,
// every lead whose Email 1 sends after deploy gets v2 for all three touches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const copy = require('../integrations/staffing-v4-copy');
const profileLib = require('../integrations/staffing-v4-profile');
const { resolveV4CopyVersion } = require('../integrations/staffing-v4-copy-version');
const staffing = require('../integrations/staffing-campaign');
const { coldSendAttribution } = require('../integrations/campaign-versions');
const compliance = require('../integrations/staffing-compliance');
const { STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');

const { STAFFING_CAMPAIGN_V4, renderStaffingEmail, validateStaffingEmail, setStaffingV4LiveForTests } = staffing;

const AS_OF = '2026-11-24';
const DASH = /[–—]/;
const FOOTER = `\n\nScaleLabAi\n${OPTIONS.mailingAddress}\n\nThis is a commercial email. Not relevant? Reply "unsubscribe" and I won't follow up again.\n\nRef: SA-48271`;
const LEAD_ID = 'V4V2L1';

const evidence = (extra = {}) => ({
  asOf: AS_OF, firstName: 'Dana', company: 'Tradeco Staffing', contactName: 'Dana Smith',
  contactStatus: 'READY_FOR_REVIEW', emailResolved: true, attributionP: 0.99,
  employerAds: [], salesHiring: [], expansion: [], leadership: [], candidateAds: [],
  specialization: { phrase: 'skilled trades', url: 'https://tradeco.example/trades', quote: 'We place welders and electricians.' },
  specialtyLine: null,
  ...extra,
});
const LINE = { line: 'pipe fitters and welders for industrial construction contractors', url: 'https://tradeco.example/services',
  quote: 'We supply pipe fitters and welders to industrial construction contractors across the Gulf Coast.' };
const employerAd = { url: 'https://ads.example/a1', text: 'Need staff? We supply your workforce.', current: true, employerFacingP: 0.95, lastSeen: '2026-11-20' };
const salesHire = { url: 'https://jobs.example/s1', quote: 'Tradeco is hiring a Business Development Manager to win new clients.', salesPosition: 'Business Development Manager', ownCommercialTeam: true, current: true, observedAt: '2026-11-20' };
const expansion = { url: 'https://news.example/e1', quote: 'Tradeco opens a new branch in Houston.', market: 'Houston', announcedAt: '2026-10-01' };
const leader = { url: 'https://news.example/l1', quote: 'Dana Smith named Vice President of Sales.', personName: 'Dana Smith', title: 'Vice President of Sales', appointedAt: '2026-09-15', current: true };
// A job-posting candidate as build_evidence.py writes it: the single most common
// hands-on title (singular) and the most common posting "City, ST".
const postingAd = { url: 'https://www.indeed.com/viewjob?jk=abc', source: 'job_postings',
  quote: 'Forklift Operator (Columbus, OH, posted 2026-11-15); Forklift Operator (Columbus, OH, posted 2026-11-12)',
  role: 'forklift operator', location: 'Columbus, OH', current: true, lastSeen: '2026-11-15' };

const select = (ev, copyVersion = 'v2') => copy.selectV4Variant(ev, { copyVersion });
function lead(ev, { copyVersion = 'v2', extra = {} } = {}) {
  const selection = select(ev, copyVersion);
  const profile = profileLib.buildStaffingV4Profile({
    row: { company: 'Tradeco Staffing', company_domain: 'tradeco.example', contact_name: 'Dana Smith', email: 'dana@tradeco.example',
      v4_tag: 'V4|PASS|LOW_SIGNAL|NO_ADS_OBSERVED|COPY_TIER_PENDING', demand_score: 0, signal_priority: 'LOW_SIGNAL',
      ad_class: 'NO_ADS_OBSERVED', contact_status: 'READY_FOR_REVIEW' },
    selection, selectedAt: '2026-11-24T18:00:00.000Z', sourcingRunId: 'v4-copy-v2-test',
  });
  if (profile.copy_status === 'SELECTED') profile.review_status = 'SEND_READY';
  return {
    id: LEAD_ID, company: 'Tradeco Staffing', contactName: 'Dana Smith', email: 'dana@tradeco.example',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN_V4.name, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id,
    emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, senderInboxId: 'primary', routingRequired: 'true',
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '',
    campaign_notes: profileLib.serializeStaffingV4Profile(profile), ...extra,
  };
}
const render = (l, step, extra = {}) => renderStaffingEmail(l, step, { ...OPTIONS, ...extra });
const copyOf = body => body.split('\n\nScaleLabAi\n')[0];
const ledgerRow = (eventType, step, meta = {}, at = '2026-11-25T15:00:00.000Z', extra = {}) => ({
  eventId: `${eventType}:${step}:${at}`, eventType, sourceLeadId: LEAD_ID, occurredAt: at,
  metadata: JSON.stringify({ leadId: LEAD_ID, step, sequenceStep: step, ...meta }), ...extra,
});

test.afterEach(() => setStaffingV4LiveForTests(null));

// ── 1. Email 1, all six variants, verbatim ──────────────────────────────────

const CASES = {
  COPY_A: [evidence({ employerAds: [employerAd] }), 'Employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you're running ads to win new employer clients.\n\nWe give industrial staffing agencies a second channel: we find employers hiring the trades you place and book qualified meetings with them. We only get paid for the meetings we book.\n\nWorth a look alongside your ads?\n\nDeins"],
  COPY_D: [evidence({ salesHiring: [salesHire] }), 'Growing your employer accounts',
    "Hi Dana,\n\nSaw you're hiring a Business Development Manager to bring in new employer accounts.\n\nWe can keep their calendar full while they ramp up. We book qualified employer meetings for industrial staffing agencies, and we only get paid for the meetings we book.\n\nWorth comparing notes?\n\nDeins"],
  COPY_E: [evidence({ expansion: [expansion] }), 'Employer accounts in Houston',
    "Hi Dana,\n\nSaw you're expanding into Houston.\n\nA new market is where employer accounts are hardest to win. We book qualified employer meetings for industrial staffing agencies there, and we only get paid for the meetings we book.\n\nWorth a look for Houston?\n\nDeins"],
  COPY_F: [evidence({ leadership: [leader] }), 'Employer growth at Tradeco Staffing',
    'Hi Dana,\n\nCongrats on the Vice President of Sales role at Tradeco Staffing.\n\nIf growing employer accounts is on your list, we book qualified employer meetings for industrial staffing agencies, and we only get paid for the meetings we book.\n\nWorth a quick look?\n\nDeins'],
  COPY_B: [evidence({ candidateAds: [postingAd] }), 'Employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you're recruiting for forklift operator roles in Columbus, OH right now.\n\nAgencies hiring that actively can usually take on more employer accounts. We find those employers, reach the decision makers and book qualified meetings, and we only get paid for the meetings we book.\n\nWorth a look for Tradeco Staffing?\n\nDeins"],
  COPY_C: [evidence({ specialtyLine: LINE }), 'Employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you place pipe fitters and welders for industrial construction contractors.\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings, and we only get paid for the meetings we book.\n\nWorth seeing how we'd do this for Tradeco Staffing?\n\nDeins"],
};

for (const [variant, [ev, subject, text]] of Object.entries(CASES)) {
  test(`1. v2 ${variant} renders the owner's text, no bold, Campaign 3 footer`, () => {
    const email = render(lead(ev), 1);
    assert.equal(email.copyVariant, variant);
    assert.equal(email.copyVersion, 'v2');
    assert.equal(email.subject, subject);
    assert.equal(email.body, text + FOOTER);
    assert.doesNotMatch(email.html, /<strong>/, 'Email 1 has no bold');
    assert.doesNotMatch(email.body, DASH);
    assert.equal(email.body.split(copy.V2_EMAIL_1_LOCK).length - 1, 1);
    assert.equal(validateStaffingEmail(email, 1), null);
    // The send path's pre-check passes only subject, body and campaign: the version is inferred.
    assert.equal(validateStaffingEmail({ subject: email.subject, body: email.body, campaignId: email.campaignId }, 1), null);
  });
}

test('2. precedence is unchanged: A > D > E > F > B > C > HOLD', () => {
  const all = { employerAds: [employerAd], salesHiring: [salesHire], expansion: [expansion], leadership: [leader], candidateAds: [postingAd], specialtyLine: LINE };
  assert.equal(select(evidence(all)).variant, 'COPY_A');
  assert.equal(select(evidence({ ...all, employerAds: [] })).variant, 'COPY_D');
  assert.equal(select(evidence({ ...all, employerAds: [], salesHiring: [] })).variant, 'COPY_E');
  assert.equal(select(evidence({ ...all, employerAds: [], salesHiring: [], expansion: [] })).variant, 'COPY_F');
  assert.equal(select(evidence({ ...all, employerAds: [], salesHiring: [], expansion: [], leadership: [] })).variant, 'COPY_B');
  assert.equal(select(evidence({ specialtyLine: LINE })).variant, 'COPY_C');
  assert.equal(select(evidence({ specialization: null })).status, 'HOLD');
});

// ── 2. COPY_C primary, fallback, HOLD ───────────────────────────────────────

test('3. COPY_C: primary with a valid specialty_line, else the fallback, else HOLD', () => {
  const primary = select(evidence({ specialtyLine: LINE }));
  assert.deepEqual([primary.variant, primary.form, primary.vars.specialty_line], ['COPY_C', 'primary', LINE.line]);
  const fallback = select(evidence());
  assert.deepEqual([fallback.variant, fallback.form, fallback.vars.verified_specialization], ['COPY_C', 'fallback', 'skilled trades']);
  const email = render(lead(evidence()), 1);
  assert.equal(copyOf(email.body), "Hi Dana,\n\nSaw Tradeco Staffing focuses on skilled trades staffing.\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings, and we only get paid for the meetings we book.\n\nWorth seeing how we'd do this for Tradeco Staffing?\n\nDeins");
  assert.equal(validateStaffingEmail(email, 1), null);
  const hold = select(evidence({ specialization: null, specialtyLine: null }));
  assert.equal(hold.status, 'HOLD');
  assert.equal(hold.variant, '');
  // A bad specialty_line falls back; it never renders.
  const bad = select(evidence({ specialtyLine: { ...LINE, line: 'Pipe Fitters And Welders For Contractors' } }));
  assert.equal(bad.form, 'fallback');
});

test('4. specialty_line must read after "Saw you place ", lowercase, 2 or 3 plural roles, <= 90 chars, no period, quote-backed', () => {
  const ok = line => copy.variableProblem('specialty_line', line) === null;
  assert.ok(ok('pipe fitters and welders for industrial construction contractors'));
  assert.ok(ok('warehouse and production workers for manufacturers'));
  assert.ok(ok('welders, pipefitters and millwrights for refineries'));
  assert.ok(ok('CNC machinists and assemblers for manufacturers'), 'acronyms stay upper case');
  assert.ok(!ok('welders for manufacturers'), 'one role');
  assert.ok(!ok('welders, fitters, millwrights and electricians for refineries'), 'four roles');
  assert.ok(!ok('welders and fitters for manufacturers.'), 'trailing period');
  assert.ok(!ok('Welders and fitters for manufacturers'), 'not lowercase');
  assert.ok(!ok('welders and fitters'), 'no client type');
  assert.ok(!ok('welders and fitters for manufacturers for plants'), 'two "for"');
  assert.ok(!ok('welding and fabrication for manufacturers'), 'roles must be plural people');
  assert.ok(!ok('welders and fitters for manufacturers — Ohio'), 'no dashes');
  assert.ok(!ok('{{roles}} and fitters for manufacturers'), 'no placeholders');
  assert.ok(!ok(`${'welders and fitters for '}${'x'.repeat(70)}`), 'over 90 characters');
  // Every content word must come from the first-party quote (singular or plural).
  assert.equal(copy.quoteBacksLine(LINE.line, LINE.quote), true);
  assert.equal(copy.quoteBacksLine('pipe fitters and welders for refineries', LINE.quote), false, 'refineries is not in the quote');
  assert.equal(select(evidence({ specialtyLine: { ...LINE, line: 'electricians and welders for industrial construction contractors' } })).form, 'fallback', 'never invents a role');
  assert.equal(select(evidence({ specialtyLine: { ...LINE, url: '' } })).form, 'fallback', 'needs its source URL');
});

// ── 3. Emails 2 and 3 ───────────────────────────────────────────────────────

const E2 = 'Hi Dana,\n\nQuick version of how it works:\n\n1. We build a list of employers in your area hiring the roles you place.\n2. We reach their plant, operations and hiring managers.\n3. You only talk to the ones who want staffing help, booked on your calendar.\n\nNo retainer. We only get paid for the qualified meetings we book.\n\nWant me to pull a short sample list of employers hiring in your market, so you can see the fit?\n\nDeins';
const E3 = "Hi Dana,\n\nI'll close the loop here so I'm not cluttering your inbox.\n\nIf bringing in more employer accounts becomes a priority, just reply \"later\" and I'll check back next quarter.\n\nDeins";

test('5. v2 Emails 2 and 3 are shared by every variant, verbatim, threaded', () => {
  for (const [ev] of Object.values(CASES)) {
    const l = lead(ev);
    const two = render(l, 2);
    const three = render(l, 3);
    assert.equal(two.body, E2 + FOOTER);
    assert.equal(three.body, E3 + FOOTER);
    assert.equal(two.subject, null);
    assert.equal(three.subject, null);
    assert.equal(validateStaffingEmail(two, 2), null);
    assert.equal(validateStaffingEmail(three, 3), null);
    assert.equal(validateStaffingEmail({ subject: null, body: two.body, campaignId: two.campaignId }, 2), null);
  }
});

test('6. bold: only Email 2\'s locked sentence; the numbered list renders cleanly in text and HTML', () => {
  const l = lead(evidence({ specialtyLine: LINE }));
  const htmlText = html => html.replace(/<\/p>\n<p>/g, '\n\n').replace(/<br>/g, '\n').replace(/<\/?(?:p|strong)>/g, '')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const step of [1, 2, 3]) {
    const email = render(l, step);
    assert.equal(htmlText(email.html), email.body, `step ${step}: same words in text and HTML`);
    assert.equal((email.html.match(/<strong>/g) || []).length, step === 2 ? 1 : 0, `step ${step} bold`);
  }
  const two = render(l, 2);
  assert.match(two.html, /<strong>We only get paid for the qualified meetings we book\.<\/strong>/);
  assert.match(two.html, /<p>1\. We build a list of employers in your area hiring the roles you place\.<br>2\. We reach their plant, operations and hiring managers\.<br>3\. You only talk to the ones who want staffing help, booked on your calendar\.<\/p>/);
  assert.match(two.body, /\n\n1\. We build[^\n]+\n2\. We reach[^\n]+\n3\. You only talk[^\n]+\n\n/);
});

test('7. locked sentences: Email 1 "only get paid for the meetings we book", Email 2 the qualified-meetings line, Email 3 reply "later"', () => {
  const l = lead(evidence({ specialtyLine: LINE }));
  const [one, two, three] = [1, 2, 3].map(step => render(l, step));
  assert.match(validateStaffingEmail({ ...one, body: one.body.replace('only get paid for the meetings we book', 'only charge for meetings') }, 1), /locked sentence/);
  assert.match(validateStaffingEmail({ ...one, body: one.body.replace('Deins', `only get paid for the meetings we book\n\nDeins`) }, 1), /locked sentence/);
  assert.match(validateStaffingEmail({ ...two, body: two.body.replace('We only get paid for the qualified meetings we book.', 'We get paid later.') }, 2), /./);
  assert.match(validateStaffingEmail({ ...three, body: three.body.replace('reply "later"', 'reply later') }, 3), /./);
  assert.equal(three.body.includes('only get paid'), false, 'Email 3 has no performance line');
  // A body that mixes v1 and v2 lines is refused.
  assert.match(validateStaffingEmail({ ...one, copyVersion: 'v2', body: one.body.replace('Deins', `${copy.PERFORMANCE_SENTENCE}\n\nDeins`) }, 1), /mixes copy versions/);
  assert.notEqual(validateStaffingEmail({ ...one, copyVersion: 'v1' }, 1), null, 'a v2 body never passes as v1');
  // Approved subject prefixes (COPY_C is now "Employer accounts for").
  assert.match(validateStaffingEmail({ ...one, subject: 'More employer accounts for Tradeco Staffing' }, 1), /approved subject/);
});

test('8. the v2 copy has no en or em dashes, signs as Deins, and keeps six variants', () => {
  const texts = [...Object.values(copy.EMAIL_1_V2), copy.COPY_C_V2_FALLBACK, ...copy.FOLLOW_UPS_V2].flatMap(t => [t.subject, t.body]);
  for (const text of texts) assert.doesNotMatch(text, DASH);
  for (const t of [...Object.values(copy.EMAIL_1_V2), copy.COPY_C_V2_FALLBACK, ...copy.FOLLOW_UPS_V2]) assert.ok(t.body.endsWith('\n\nDeins'));
  assert.deepEqual(Object.keys(copy.EMAIL_1_V2).sort(), [...copy.VARIANTS].sort());
});

// ── 4. Footer ───────────────────────────────────────────────────────────────

test('9. Campaign 3 footer drops the website line only; V1, V2 and Jole footers keep it', () => {
  const l = lead(evidence());
  for (const step of [1, 2, 3]) {
    const email = render(l, step);
    assert.ok(email.body.endsWith(FOOTER));
    assert.ok(!email.body.includes('scalelabai.ca'));
    assert.ok(email.body.trim().endsWith('Ref: SA-48271'), 'Ref stays the final line (Gmail filter key)');
  }
  const identity = { companyName: 'ScaleLabAi', mailingAddress: OPTIONS.mailingAddress, website: 'scalelabai.ca' };
  assert.match(compliance.formatStaffingComplianceFooter(identity), /\nscalelabai\.ca\n/, 'the default footer is unchanged');
  assert.doesNotMatch(compliance.formatStaffingComplianceFooter(identity, { includeWebsite: false }), /scalelabai/);
  const jole = fs.readFileSync(path.join(__dirname, '../integrations/clients/jole-copy.js'), 'utf8');
  assert.ok(!/includeWebsite/.test(jole), 'Jole copy is untouched');
});

// ── 5. Version pinning ──────────────────────────────────────────────────────

test('10. a lead sealed under v2 is v2 for every touch, whatever the ledger says', () => {
  const l = lead(evidence(), { extra: { emailStep: '1', lastEmailedAt: '2026-11-20T15:00:00Z' } });
  assert.equal(profileLib.readStaffingV4Profile(l).sealedCopyVersion, 'v2');
  for (const step of [1, 2, 3]) assert.equal(render(l, step, { activities: [ledgerRow('initial_email_sent', 1)] }).copyVersion, 'v2');
});

test('11. a pre-v2 lead whose Email 1 went out on v1 finishes on v1 Emails 2 and 3', () => {
  const l = lead(evidence(), { copyVersion: 'v1', extra: { emailStep: '1', lastEmailedAt: '2026-11-20T15:00:00Z' } });
  const v1Send = [ledgerRow('initial_email_sent', 1, {}, '2026-11-20T15:00:00.000Z')];
  for (const step of [2, 3]) {
    const email = render(l, step, { activities: v1Send });
    assert.equal(email.copyVersion, 'v1');
    assert.ok(email.body.includes(step === 2 ? copy.EMAIL_2_BOLD : copy.EMAIL_3_BOLD));
    assert.equal(validateStaffingEmail(email, step), null);
  }
  // Without a ledger, a row that shows a send is v1 too.
  assert.equal(render(l, 2).copyVersion, 'v1');
});

test('12. a pre-v2 lead whose Email 1 has not gone out gets v2 for all three touches', () => {
  const l = lead(evidence(), { copyVersion: 'v1' });
  assert.equal(profileLib.readStaffingV4Profile(l).sealedCopyVersion, '');
  const one = render(l, 1);
  assert.equal(one.copyVersion, 'v2');
  assert.equal(one.copyVariant, 'COPY_C');
  assert.ok(one.body.startsWith('Hi Dana,\n\nSaw Tradeco Staffing focuses on skilled trades staffing.'), 'v1 COPY_C vars render the v2 fallback');
  assert.equal(validateStaffingEmail(one, 1), null);
  // After deploy its Email 1 records v2, so its follow-ups stay on v2.
  const sent = [ledgerRow('initial_email_sent', 1, { staffingCopyVersion: 'v2' })];
  const lAfter = { ...l, emailStep: '1', lastEmailedAt: '2026-11-25T15:00:00.000Z' };
  for (const step of [2, 3]) assert.equal(render(lAfter, step, { activities: sent }).copyVersion, 'v2');
  // Every v1 variant's variables render under v2 (COPY_A, B, D, E, F share their names).
  for (const ev of [evidence({ employerAds: [employerAd] }), evidence({ candidateAds: [postingAd] }), evidence({ salesHiring: [salesHire] }),
    evidence({ expansion: [expansion] }), evidence({ leadership: [leader] })]) {
    const email = render(lead(ev, { copyVersion: 'v1' }), 1);
    assert.equal(email.copyVersion, 'v2');
    assert.equal(validateStaffingEmail(email, 1), null);
  }
});

test('13. the ledger rule: confirmed send or live reservation pins; a failed reservation does not', () => {
  const l = lead(evidence(), { copyVersion: 'v1' });
  const reserved = ledgerRow('ordinary_send_reserved', 1, { staffingCopyVersion: 'v1' }, '2026-11-24T15:00:00.000Z', { eventId: 'r1' });
  assert.deepEqual(resolveV4CopyVersion(l, [reserved]), { copyVersion: 'v1', reason: 'email_1_recorded_version' });
  const failed = { eventId: 'f1', eventType: 'ordinary_send_failed', sourceLeadId: LEAD_ID, occurredAt: '2026-11-24T15:01:00.000Z', metadata: JSON.stringify({ leadId: LEAD_ID, step: 1, reservationEventId: 'r1' }) };
  assert.equal(resolveV4CopyVersion(l, [reserved, failed]).copyVersion, 'v2', 'a failed attempt delivered nothing');
  assert.equal(resolveV4CopyVersion(l, []).reason, 'email_1_not_sent');
  // Another lead's send never pins this one.
  assert.equal(resolveV4CopyVersion(l, [{ ...ledgerRow('initial_email_sent', 1), sourceLeadId: 'other' }]).copyVersion, 'v2');
  // A Campaign 3 send from before v2 recorded no version: v1.
  assert.equal(resolveV4CopyVersion(l, [ledgerRow('initial_email_sent', 1)]).copyVersion, 'v1');
});

test('14. every send records its copy version so reply rates compare v1 vs v2 by variant', () => {
  setStaffingV4LiveForTests(true);
  const prev = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = '2026-09-01T00:00:00.000Z';
  try {
    const v2 = lead(evidence({ specialtyLine: LINE }));
    assert.equal(coldSendAttribution(v2, 1).copyVersion, 'industrial_staffing_v4_e1_v2_copy_c');
    assert.equal(coldSendAttribution(v2, 1).staffingCopyVersion, 'v2');
    assert.equal(coldSendAttribution(v2, 2).copyVersion, 'industrial_staffing_v4_follow_up_v2');
    const v1 = lead(evidence(), { copyVersion: 'v1', extra: { emailStep: '1' } });
    const v1Send = { activities: [ledgerRow('initial_email_sent', 1)] };
    assert.equal(coldSendAttribution(v1, 2, v1Send).copyVersion, 'industrial_staffing_v4_follow_up');
    assert.equal(coldSendAttribution(v1, 2, v1Send).staffingCopyVersion, 'v1');
  } finally {
    if (prev === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = prev;
  }
  // The send path records it on the reservation, and the delivery step aligns the
  // attribution with the version its ledger-pinned render actually used.
  const agent = fs.readFileSync(path.join(__dirname, '../outreach-agent.js'), 'utf8');
  assert.match(agent, /staffingCopyVersion: attribution\.staffingCopyVersion/);
  assert.match(agent, /attribution = \{ \.\.\.attribution, \.\.\.coldSendAttribution\(lead, step, \{ staffingCopyVersion: staffingEmail\.copyVersion \}\) \}/);
  const delivery = agent.slice(agent.indexOf('async function deliverOrdinaryColdStep('), agent.indexOf('await recordColdCallActivityStrict(reservation)'));
  assert.ok(delivery.indexOf('attribution = { ...attribution') < delivery.indexOf("eventType: 'ordinary_send_reserved'"), 'aligned before the reservation is written');
  assert.match(agent, /activities: activitiesForCycle \|\| \[\] \};/, 'the delivery render reads the ledger');
});

// ── 6. Profiles ─────────────────────────────────────────────────────────────

test('15. v1 profiles keep their exact shape; v2 profiles add copy_version and var_specialty_line, sealed', () => {
  const v1 = lead(evidence(), { copyVersion: 'v1' });
  assert.ok(!v1.campaign_notes.includes('copy_version'));
  assert.ok(!v1.campaign_notes.includes('var_specialty_line'));
  assert.equal(JSON.parse(v1.campaign_notes).selector_version, profileLib.SELECTOR_VERSION);
  const v2 = lead(evidence({ specialtyLine: LINE }));
  const parsed = JSON.parse(v2.campaign_notes);
  assert.equal(parsed.copy_version, 'v2');
  assert.equal(parsed.var_specialty_line, LINE.line);
  assert.equal(parsed.selector_version, profileLib.SELECTOR_VERSION_V2);
  for (const notes of [{ ...parsed, copy_version: 'v1' }, { ...parsed, copy_version: 'v3' }, { ...parsed, var_specialty_line: 'welders and fitters for plants' },
    Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'copy_version')),
    Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'var_specialty_line'))]) {
    const tampered = { ...v2, campaign_notes: JSON.stringify(notes) };
    assert.equal(profileLib.readStaffingV4Profile(tampered).ok, false);
    assert.throws(() => render(tampered, 1), /refused/);
  }
});

// ── 7. Evidence builder agrees with the selector ────────────────────────────

test('16. build_evidence\'s specialty_line and job-posting candidate pass the selector\'s own checks', t => {
  const { spawnSync } = require('node:child_process');
  const tools = path.join(__dirname, '../docs/scalelab-sourcing/tools');
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(tools)})
import copy_v2_evidence as c
dec = {"icp_evidence": [{"url": "https://x.example/s", "excerpt": "We supply pipe fitters and welders to industrial construction contractors across Texas."}]}
dec2 = {"icp_evidence": [{"url": "https://x.example/a", "excerpt": "Warehouse workers, forklift drivers, assemblers and welders for manufacturers."}]}
posts = [dict(title=t, city=ci, state=st, postedAt=d, url="https://j.example/%d" % i) for i, (t, ci, st, d) in enumerate([
  ("Forklift Operator - 2nd Shift", "COLUMBUS", "oh", "2026-11-15"), ("Forklift Operator", "Columbus", "OH", "2026-11-12"),
  ("Welder", "Dublin", "OH", "2026-11-20"), ("Warehouse Supervisor", "Columbus", "OH", "2026-11-20"), ("CDL Driver", "Columbus", "OH", "2026-11-20")])]
print(json.dumps({"lines": [c.specialty_line(dec), c.specialty_line(dec2)], "posting": c.posting_candidate(posts, "2026-11-24"),
  "one": c.posting_candidate(posts[2:3], "2026-11-24")}))
`;
  const run = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
  if (run.error) return t.skip('python3 is not available');
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  for (const line of out.lines) {
    const s = select(evidence({ specialtyLine: line }));
    assert.equal(s.form, 'primary', line.line);
    assert.equal(s.vars.specialty_line, line.line);
  }
  assert.deepEqual([out.posting.role, out.posting.location], ['forklift operator', 'Columbus, OH']);
  const b = select(evidence({ candidateAds: [out.posting] }));
  assert.equal(b.variant, 'COPY_B');
  assert.deepEqual([b.vars.verified_role, b.vars.location], ['forklift operator', 'Columbus, OH']);
  assert.equal(out.one, null, 'one posting of a role is not "recruiting for ... roles right now"');
});
