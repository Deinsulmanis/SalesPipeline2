'use strict';

// These tests exercise live staffing machinery with Industrial Staffing Agency
// (V1) fixtures. V1 itself is a completed campaign; that is pinned in
// test/completed-campaign.test.js.
require('../integrations/lead-archive').setCompletedCampaignsForTests([]);

// Industrial Staffing V2 (2026-10-15/16, copy relocked 2026-10-20): a separate
// campaign with V1's targeting, offer, subjects and cadence and its own copy
// for all three touches. These tests pin V2's identity and copy (no touch
// carries a landing-page link, Touch 3 no bold, every touch V2's own footer), keep
// V1's three emails and its Touch 2 landing link exactly as they were, keep
// every V1/V2 identifier apart in attribution, and show V2 stays unqueueable
// and unsendable until made live.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const staffing = require('../integrations/staffing-campaign');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2, STAFFING_LANDING_PAGE_URL, LOCKED_EMAILS, LOCKED_EMAILS_V2, BOLD_PHRASES, BOLD_PHRASES_V2,
  renderStaffingEmail, renderStaffingPreview, validateStaffingEmail, isStaffingCampaign, staffingCampaignFor,
  isStaffingTemplateId, staffingOpeningParts, staffingV2Live, setStaffingV2LiveForTests,
} = staffing;
const { CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION, activeVersionForLead, coldSendAttribution } = require('../integrations/campaign-versions');
const { templateById, campaignVersionsForRoute, validateCampaignVersionRoute, routedLeadReady } = require('../integrations/campaign-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { staffingColdStepLandingPlan, buildIssuanceRecord } = require('../integrations/landing-link-issuance');
const { resolveColdFollowUpThread } = require('../integrations/gmail-threading');
const { resolveCampaign } = require('../integrations/research-icp/campaigns');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS, STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const ROOT = path.join(__dirname, '..');
const V1_ID = 'industrial_staffing_employer_acquisition_v1';
const V2_ID = 'industrial_staffing_employer_acquisition_v2';
const V1_TEMPLATE = 'industrial-staffing-employer-v1';
const V2_TEMPLATE = 'industrial-staffing-employer-v2';
const RISK_REVERSAL = 'No qualified meetings, no meeting fees.';
const IMPORTANT_PART = "The important part: if we don't generate qualified employer meetings that actually happen, you don't pay meeting fees.";
const SEND_THE_10 = 'Happy to send over the 10 I pulled for you if you want to take a look.';
const PRIORITY_QUESTION = 'Is bringing in more employer accounts something Tradeco Construction is actively focused on right now, or are you mainly focused on filling demand from existing clients?';
const V2_UNSUBSCRIBE = 'To unsubscribe, reply “unsubscribe”';
const OPENING = 'Saw you place electricians and plumbers for commercial and industrial contractors.';
const LAUNCHED = '2026-09-01T00:00:00.000Z';
const TRACKING_ON = { LANDING_LINK_TRACKING_ENABLED: 'true', LANDING_LINK_TOKEN_ACTIVE_VERSION: '1',
  LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: crypto.createHash('sha256').update('v2 test key').digest('base64') }) };
const LINK = /https?:\/\/|scalelabai\.ca\/staffing|\?t=/;

const base = (extra = {}) => ({ id: 'L1', company: 'Tradeco Construction', contactName: 'Dana Smith', email: 'dana@tradeco.com',
  leadNiche: 'industrial_staffing', siteContext: OPENING, stage: 'Queued', emailStatus: '', emailStep: '', ...extra });
const v1Lead = (extra = {}) => base({ campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: V1_ID, emailTemplateId: V1_TEMPLATE, ...extra });
const v2Lead = (extra = {}) => base({ campaign: STAFFING_CAMPAIGN_V2.name, intendedCampaignVersion: V2_ID, emailTemplateId: V2_TEMPLATE, ...extra });

const FOOTER_TEXT = '\n\nScaleLabAi\n150 Braid Street\nNew Westminster, BC V3L 0L4\nCanada\nscalelabai.ca\n\n'
  + 'This is a commercial email. Not relevant? Reply "unsubscribe" and I won\'t follow up again.\n\nRef: SA-48271';
const FOOTER_HTML = '\n<p>ScaleLabAi<br>150 Braid Street<br>New Westminster, BC V3L 0L4<br>Canada<br>scalelabai.ca</p>\n'
  + '<p>This is a commercial email. Not relevant? Reply &quot;unsubscribe&quot; and I won&#39;t follow up again.</p>\n<p>Ref: SA-48271</p>';
// V2's own footer on every touch: brand, the production mailing address on one
// line, website, and the reply-to-unsubscribe line.
const V2_FOOTER_TEXT = `\n\nScaleLabAI\n150 Braid Street, New Westminster, BC V3L 0L4, Canada\nscalelabai.ca\n${V2_UNSUBSCRIBE}`;
const V2_FOOTER_HTML = `\n<p>ScaleLabAI<br>150 Braid Street, New Westminster, BC V3L 0L4, Canada<br>scalelabai.ca<br>${V2_UNSUBSCRIBE}</p>`;
const copyOf = body => body.split(/\n\nScaleLabA[iI]\n/)[0];

// V1's three emails exactly as they rendered before V2 existed (6d3c2df).
const V1_TEXT = [
  'Hi Dana,\n\nSaw you place electricians and plumbers for commercial and industrial contractors.\n\n'
    + 'We help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\n'
    + "Worth seeing how we'd do this for Tradeco Construction?\n\n— Deins" + FOOTER_TEXT,
  "Hi Dana,\n\nJust to clarify — we're not talking about candidate sourcing.\n\n"
    + 'We run a 30-day employer acquisition pilot built around the roles Tradeco Construction already places.\n\n'
    + 'We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.\n\n'
    + "If we don't generate qualified employer meetings, there are no meeting fees.\n\n"
    + 'You can see how it works here:\nhttps://scalelabai.ca/staffing/\n\n'
    + 'Open to seeing what this could look like for Tradeco Construction?' + FOOTER_TEXT,
  'Hi Dana,\n\nIs bringing in more employer accounts something Tradeco Construction is focused on right now?\n\nDeins' + FOOTER_TEXT,
];
// The approved V2 copy (locked 2026-10-20).
const V2_TEXT = [
  'Hi Dana,\n\nSaw Tradeco Construction places electricians and plumbers for commercial and industrial contractors.\n\n'
    + 'I found 10 employers actively hiring in that market that look like potential accounts for Tradeco Construction.\n\n'
    + `We also generate qualified employer meetings for staffing agencies on a performance basis. ${RISK_REVERSAL}\n\n`
    + 'Want the 10?\n\nDeins' + V2_FOOTER_TEXT,
  "Hi Dana,\n\nThe 10 employers I mentioned are just a small sample of the accounts we'd go after for Tradeco Construction.\n\n"
    + 'We identify the right employers, reach the decision-makers, qualify interest, and put interested prospects directly on your calendar.\n\n'
    + `${IMPORTANT_PART}\n\n`
    + "So you're not paying us for activity, outreach volume, or a bunch of emails being sent. You're paying for actual meetings.\n\n"
    + `${SEND_THE_10}\n\nDeins` + V2_FOOTER_TEXT,
  `Hi Dana,\n\nQuick question before I close the loop.\n\n${PRIORITY_QUESTION}\n\nDeins` + V2_FOOTER_TEXT,
];
const V2_TOUCH_1_HTML = '<p>Hi Dana,</p>\n<p>Saw Tradeco Construction places electricians and plumbers for commercial and industrial contractors.</p>\n'
  + '<p>I found 10 employers actively hiring in that market that look like potential accounts for Tradeco Construction.</p>\n'
  + `<p>We also generate qualified employer meetings for staffing agencies on a performance basis. <strong>${RISK_REVERSAL}</strong></p>\n`
  + '<p>Want the 10?</p>\n<p>Deins</p>' + V2_FOOTER_HTML;
const V2_TOUCH_2_HTML = '<p>Hi Dana,</p>\n<p>The 10 employers I mentioned are just a small sample of the accounts we&#39;d go after for Tradeco Construction.</p>\n'
  + '<p>We identify the right employers, reach the decision-makers, qualify interest, and put interested prospects directly on your calendar.</p>\n'
  + '<p><strong>The important part: if we don&#39;t generate qualified employer meetings that actually happen, you don&#39;t pay meeting fees.</strong></p>\n'
  + '<p>So you&#39;re not paying us for activity, outreach volume, or a bunch of emails being sent. You&#39;re paying for actual meetings.</p>\n'
  + `<p>${SEND_THE_10}</p>\n<p>Deins</p>` + V2_FOOTER_HTML;
const V2_TOUCH_3_HTML = `<p>Hi Dana,</p>\n<p>Quick question before I close the loop.</p>\n<p>${PRIORITY_QUESTION}</p>\n<p>Deins</p>` + V2_FOOTER_HTML;

function withLaunchedStaffing(t, { v2Live = false } = {}) {
  const saved = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = LAUNCHED;
  setStaffingV2LiveForTests(v2Live);
  t.after(() => {
    setStaffingV2LiveForTests(null);
    if (saved === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = saved;
  });
}

// ── Identity ─────────────────────────────────────────────────────────────────

test('V2 exists as its own campaign, version and template, independent of V1', () => {
  assert.equal(STAFFING_CAMPAIGN_V2.id, V2_ID);
  assert.equal(STAFFING_CAMPAIGN_V2.emailTemplateId, V2_TEMPLATE);
  assert.notEqual(STAFFING_CAMPAIGN_V2.name, STAFFING_CAMPAIGN.name);
  for (const key of ['niche', 'personalizationStrategy', 'model']) assert.equal(STAFFING_CAMPAIGN_V2[key], STAFFING_CAMPAIGN[key], key);
  const v1 = CAMPAIGN_VERSIONS[V1_ID];
  const v2 = CAMPAIGN_VERSIONS[V2_ID];
  assert.ok(v1 && v2 && v1 !== v2);
  assert.deepEqual([v2.id, v2.emailTemplateId, v2.copyVersion, v2.followUpCopyVersion],
    [V2_ID, V2_TEMPLATE, 'staffing_locked_v2', 'industrial_staffing_follow_up_v2']);
  assert.equal(v2.family, v1.family);
  for (const key of ['niche', 'personalizationStrategy', 'subjectStrategy', 'offerVersion']) assert.equal(v2[key], v1[key], key);
  assert.equal(templateById(V2_TEMPLATE).niche, 'industrial_staffing');
  assert.equal(ACTIVE_CAMPAIGN_VERSION.industrial_staffing, V1_ID, 'nothing defaults into V2');
});

test('V1 configuration is unchanged', () => {
  assert.deepEqual({ ...STAFFING_CAMPAIGN, legacyNames: [...STAFFING_CAMPAIGN.legacyNames] }, {
    id: V1_ID, name: 'Industrial Staffing Agency', legacyNames: ['Industrial Staffing — Employer Acquisition'],
    niche: 'industrial_staffing', emailTemplateId: V1_TEMPLATE, personalizationStrategy: 'staffing_market_evidence_v1',
    model: 'claude-haiku-4-5', status: 'approved', ready: true,
  });
  const v1 = CAMPAIGN_VERSIONS[V1_ID];
  assert.deepEqual([v1.copyVersion, v1.subjectStrategy, v1.offerVersion, v1.followUpCopyVersion],
    ['staffing_locked_v1', 'employer_accounts_locked_v1', 'employer_meetings_performance_v1', undefined]);
  assert.equal(templateById(V1_TEMPLATE).ready, true);
});

// ── 1. V2 Touch 1 ────────────────────────────────────────────────────────────

test('1. V2 Touch 1 is byte-identical to the approved Touch 1 (text, HTML, subject, bold, footer)', () => {
  const email = renderStaffingEmail(v2Lead(), 1, OPTIONS);
  assert.equal(email.subject, 'employer accounts');
  assert.equal(email.body, V2_TEXT[0]);
  assert.equal(email.html, V2_TOUCH_1_HTML);
  assert.equal(email.campaignId, V2_ID);
  // The roles, market and company are merged from the lead.
  assert.ok(email.body.includes('Saw Tradeco Construction places electricians and plumbers for commercial and industrial contractors.'));
  assert.ok(email.body.includes('look like potential accounts for Tradeco Construction.'));
  // Only the risk-reversal sentence is bold.
  assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  assert.ok(email.html.includes(`<strong>${RISK_REVERSAL}</strong>`));
  assert.equal(email.body.includes('*'), false);
  assert.equal(email.body.includes('—'), false, 'no em dash anywhere, including before Deins');
  // The footer closes Touch 1, ending with the reply-to-unsubscribe line.
  assert.ok(email.body.endsWith(V2_FOOTER_TEXT));
  assert.equal(email.body.split(V2_UNSUBSCRIBE).length, 2);
  assert.equal(/Ref: SA-48271|This is a commercial email|Not relevant\?/.test(email.body), false, 'no V1 footer');
  assert.equal(validateStaffingEmail(email, 1), null);
  assert.equal(LOCKED_EMAILS_V2[0], 'Hi {{firstName}},\n\nSaw {{company}} places {{roles}} for {{market}}.\n\nI found 10 employers actively hiring in that market that look like potential accounts for {{company}}.\n\nWe also generate qualified employer meetings for staffing agencies on a performance basis. No qualified meetings, no meeting fees.\n\nWant the 10?\n\nDeins');
  assert.equal(BOLD_PHRASES_V2[0], RISK_REVERSAL);
});

// ── 2–5. V2 Touch 2 ──────────────────────────────────────────────────────────

test('2. V2 Touch 2 renders the exact approved wording, with the V2 footer', () => {
  const email = renderStaffingEmail(v2Lead(), 2, OPTIONS);
  assert.equal(email.body, V2_TEXT[1]);
  assert.equal(email.html, V2_TOUCH_2_HTML);
  assert.equal(email.campaignId, V2_ID);
  assert.equal(validateStaffingEmail(email, 2), null);
  assert.ok(email.body.includes(`\n\n${SEND_THE_10}\n\n`), 'the corrected closing line');
  assert.ok(copyOf(email.body).endsWith('\n\nDeins'), 'the copy ends at the sign-off');
  assert.ok(email.body.endsWith(V2_FOOTER_TEXT), 'then the V2 footer');
  assert.equal(email.body.split(V2_UNSUBSCRIBE).length, 2);
  assert.equal(/Ref: SA-48271|This is a commercial email|Not relevant\?/.test(email.body), false, 'no V1 footer');
  assert.equal(email.body.includes('—'), false, 'no em dash anywhere in Touch 2');
  assert.equal(LOCKED_EMAILS_V2[1], "Hi {{firstName}},\n\nThe 10 employers I mentioned are just a small sample of the accounts we'd go after for {{company}}.\n\nWe identify the right employers, reach the decision-makers, qualify interest, and put interested prospects directly on your calendar.\n\nThe important part: if we don't generate qualified employer meetings that actually happen, you don't pay meeting fees.\n\nSo you're not paying us for activity, outreach volume, or a bunch of emails being sent. You're paying for actual meetings.\n\nHappy to send over the 10 I pulled for you if you want to take a look.\n\nDeins");
});

test('3. V2 Touch 2: the whole "important part" sentence is the one bold phrase', () => {
  const { html } = renderStaffingEmail(v2Lead(), 2, OPTIONS);
  assert.equal(BOLD_PHRASES_V2[1], IMPORTANT_PART);
  assert.equal((html.match(/<strong>/g) || []).length, 1);
  assert.ok(html.includes('<p><strong>The important part: if we don&#39;t generate qualified employer meetings that actually happen, you don&#39;t pay meeting fees.</strong></p>'));
});

test('4. V2 Touch 2 plain text has no Markdown or HTML markers', () => {
  const { body } = renderStaffingEmail(v2Lead(), 2, OPTIONS);
  assert.equal(/[*_`#]/.test(body), false);
  assert.equal(/<\/?[a-z]/i.test(body), false);
  assert.ok(body.includes(IMPORTANT_PART));
});

test('5. V2 Touch 2 has no landing-page URL or tracked token, and never gets a landing plan', () => {
  const { body, html } = renderStaffingEmail(v2Lead(), 2, OPTIONS);
  assert.equal(LINK.test(body), false);
  assert.equal(LINK.test(html), false);
  assert.equal(body.includes(STAFFING_LANDING_PAGE_URL), false);
  // No plan, so no issuance and no recorded link, with tracking off or on.
  assert.equal(staffingColdStepLandingPlan({ lead: v2Lead(), step: 2, env: {} }), null);
  assert.equal(staffingColdStepLandingPlan({ lead: v2Lead(), step: 2, env: TRACKING_ON }), null);
  // A tracked URL forced into a V2 render is refused, not silently placed.
  assert.throws(() => renderStaffingEmail(v2Lead(), 2, { ...OPTIONS, landingPageUrl: 'https://scalelabai.ca/staffing/?t=abcdefghijklmnopqrstuv' }),
    /V2 copy carries no landing-page URL/);
});

// ── 6. V1 Touch 2 landing behavior ───────────────────────────────────────────

test('6. V1 Touch 2 keeps its landing page: untracked URL by default, a tracked link when tracking is on', () => {
  const plain = renderStaffingEmail(v1Lead(), 2, OPTIONS);
  assert.equal(plain.body, V1_TEXT[1]);
  assert.equal(plain.body.split(STAFFING_LANDING_PAGE_URL).length, 2, 'the URL appears exactly once');
  assert.equal(staffingColdStepLandingPlan({ lead: v1Lead(), step: 2, env: {} }).tracked, false);
  const plan = staffingColdStepLandingPlan({ lead: v1Lead(), step: 2, env: TRACKING_ON });
  assert.equal(plan.tracked, true);
  const tracked = renderStaffingEmail(v1Lead(), 2, { ...OPTIONS, landingPageUrl: plan.url });
  assert.ok(tracked.body.includes(`You can see how it works here:\n${plan.url}\n`));
  assert.equal(tracked.body, V1_TEXT[1].replace(STAFFING_LANDING_PAGE_URL, plan.url));
  assert.equal(validateStaffingEmail(tracked, 2), null);
  // Steps 1 and 3 never carry it, for either version.
  for (const lead of [v1Lead(), v2Lead()]) for (const step of [1, 3]) assert.equal(staffingColdStepLandingPlan({ lead, step, env: TRACKING_ON }), null);
});

// ── 7–8. V2 Touch 3 ──────────────────────────────────────────────────────────

test('7. V2 Touch 3 renders the exact approved wording, with no bold and the V2 footer', () => {
  const email = renderStaffingEmail(v2Lead(), 3, OPTIONS);
  assert.equal(email.body, V2_TEXT[2]);
  assert.equal(email.html, V2_TOUCH_3_HTML);
  assert.equal(email.html.includes('<strong>'), false);
  assert.equal(BOLD_PHRASES_V2[2], null);
  assert.equal(validateStaffingEmail(email, 3), null);
  assert.deepEqual(copyOf(email.body).split('\n').filter(Boolean),
    ['Hi Dana,', 'Quick question before I close the loop.', PRIORITY_QUESTION, 'Deins'], 'greeting, opener, one question, sign-off');
  assert.ok(email.body.endsWith(V2_FOOTER_TEXT));
  assert.equal(email.body.split(V2_UNSUBSCRIBE).length, 2);
  assert.equal(/Ref: SA-48271|This is a commercial email|Not relevant\?/.test(email.body), false, 'no V1 footer');
  // No extra pitch: neither the 10 employers nor the performance terms come back.
  assert.equal(/\b10\b|meeting fees|performance basis|pay/i.test(copyOf(email.body)), false);
  assert.equal(LOCKED_EMAILS_V2[2], 'Hi {{firstName}},\n\nQuick question before I close the loop.\n\nIs bringing in more employer accounts something {{company}} is actively focused on right now, or are you mainly focused on filling demand from existing clients?\n\nDeins');
});

test('8. no V2 touch carries a link or names the website outside its footer', () => {
  for (const step of [1, 2, 3]) {
    const { body, html } = renderStaffingEmail(v2Lead(), step, OPTIONS);
    assert.equal(LINK.test(body) || LINK.test(html), false, `touch ${step}`);
    assert.equal(/scalelabai\.ca/.test(copyOf(body)), false, `touch ${step}: only the footer names the website`);
    assert.equal(/<a\b/i.test(html), false, `touch ${step}: no anchor tags`);
  }
});

test('V2 validation: every touch must end with exactly one V2 footer; the V1 footer is never V2\'s', () => {
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(v2Lead(), step, OPTIONS);
    const refusal = `staffing V2 Touch ${step} must end with its business footer`;
    assert.equal(validateStaffingEmail(email, step), null, `touch ${step}`);
    assert.equal(validateStaffingEmail({ ...email, body: copyOf(email.body) }, step), refusal, 'missing');
    assert.equal(validateStaffingEmail({ ...email, body: `${email.body}\n\nP.S.` }, step), refusal, 'not last');
    assert.equal(validateStaffingEmail({ ...email, body: email.body + V2_FOOTER_TEXT }, step), refusal, 'twice');
    assert.equal(validateStaffingEmail({ ...email, body: copyOf(email.body) + FOOTER_TEXT }, step), 'staffing V2 body must not carry the V1 compliance footer');
  }
});

test('a reply quoting any V2 touch\'s footer inline is not an unsubscribe; a real "unsubscribe" still is', () => {
  const { classifyReplyText } = require('../integrations/canonical-reply');
  const { classifiableText } = require('../integrations/reply-reconciliation');
  for (const touch of V2_TEXT) {
    const quoted = `Yes, send the 10 please.\n\n${touch}`;
    assert.notEqual(classifyReplyText(classifiableText({ body: quoted })).reason, 'unsubscribe_request');
  }
  assert.equal(classifyReplyText(classifiableText({ body: 'unsubscribe' })).reason, 'unsubscribe_request');
  assert.equal(classifyReplyText(classifiableText({ body: `unsubscribe\n\n${V2_TEXT[0]}` })).reason, 'unsubscribe_request');
});

// ── 9–11. Attribution and subjects ───────────────────────────────────────────

test('9–10. copy versions: V2 Touch 1 staffing_locked_v2, V2 Touches 2–3 the V2 follow-up version; V1 unchanged', t => {
  withLaunchedStaffing(t, { v2Live: true });
  const expected = {
    [V1_ID]: ['staffing_locked_v1', 'industrial_staffing_follow_up_v1', 'industrial_staffing_follow_up_v1'],
    [V2_ID]: ['staffing_locked_v2', 'industrial_staffing_follow_up_v2', 'industrial_staffing_follow_up_v2'],
  };
  for (const [lead, id] of [[v1Lead(), V1_ID], [v2Lead(), V2_ID]]) {
    for (const step of [1, 2, 3]) {
      const attribution = coldSendAttribution(lead, step);
      assert.equal(attribution.campaignVersion, id, `${id} step ${step}`);
      assert.equal(attribution.campaignFamily, 'industrial_staffing');
      assert.equal(attribution.copyVersion, expected[id][step - 1], `${id} step ${step}`);
      assert.equal(attribution.offerVersion, 'employer_meetings_performance_v1');
    }
  }
  // Issuance records (e.g. positive-reply links) carry the lead's own campaign.
  const plan = { tracked: true, issuanceKey: 'k|landing', tokenHash: 'h', keyVersion: '1', source: 'positive_reply' };
  const record = lead => buildIssuanceRecord({ plan, actionId: 'response:L1:m1:AUTO_STAFFING_SEND_INFO', lead, campaignVersion: coldSendAttribution(lead, 1).campaignVersion, templateId: lead.emailTemplateId, env: {} });
  assert.deepEqual([record(v2Lead()).campaign_id, record(v2Lead()).campaign_version], [V2_ID, V2_ID]);
  assert.deepEqual([record(v1Lead()).campaign_id, record(v1Lead()).campaign_version], [V1_ID, V1_ID]);
  // The reconciler rebuilds from the lead id and the send's recorded campaign version.
  const rebuilt = campaignVersion => buildIssuanceRecord({ plan, actionId: 'a', lead: { id: 'L1' }, campaignVersion, templateId: '', env: {} }).campaign_id;
  assert.deepEqual([rebuilt(V2_ID), rebuilt(V1_ID), rebuilt(null), rebuilt('dental_v3_pay_per_booking')], [V2_ID, V1_ID, V1_ID, V1_ID]);
});

test('11. subjects: Touch 1 "employer accounts"; Touches 2–3 thread as "Re: employer accounts" for V1 and V2', async () => {
  for (const lead of [v1Lead(), v2Lead()]) {
    assert.equal(renderStaffingEmail(lead, 1, OPTIONS).subject, 'employer accounts');
    // Follow-up copy carries no subject of its own: the thread supplies it.
    assert.equal(renderStaffingEmail(lead, 2, OPTIONS).subject, null);
    assert.equal(renderStaffingEmail(lead, 3, OPTIONS).subject, null);
    const activities = [{ eventType: 'initial_email_sent', sourceLeadId: lead.id, subject: 'employer accounts', occurredAt: '2026-10-10T15:00:00.000Z',
      metadata: JSON.stringify({ gmailMessageId: 'm1', gmailThreadId: 't1', senderInboxId: 'primary' }) }];
    const gmail = { users: { messages: { get: async () => ({ data: { threadId: 't1', payload: { headers: [
      { name: 'Message-ID', value: '<m1@mail.gmail.com>' }, { name: 'To', value: lead.email }] } } }) } } };
    const thread = await resolveColdFollowUpThread({ gmail, lead, activities, expectedSenderId: 'primary' });
    assert.equal(thread.subject, 'Re: employer accounts', lead.intendedCampaignVersion);
  }
  // A follow-up that tried to set its own subject is refused.
  assert.equal(validateStaffingEmail({ ...renderStaffingEmail(v2Lead(), 2, OPTIONS), subject: 'Re: employer accounts' }, 2),
    'staffing follow-up must keep the original thread subject');
});

// ── 12. V1 unchanged ─────────────────────────────────────────────────────────

test('12. V1 Emails 1–3 are byte-identical to their pre-V2 renders', () => {
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(v1Lead(), step, OPTIONS);
    assert.equal(email.body, V1_TEXT[step - 1], `V1 step ${step}`);
    assert.equal(email.campaignId, undefined, 'a V1 render keeps exactly the shape it always had');
    assert.equal(validateStaffingEmail(email, step), null);
  }
  assert.deepEqual([...BOLD_PHRASES], ['we get paid based on the meetings we generate.',
    'We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.',
    'Is bringing in more employer accounts something {{company}} is focused on right now?']);
  assert.equal(LOCKED_EMAILS.length, 3);
  // V1's no-personalization Email 1 (an explicit NONE_REQUIRED review) still renders as before.
  const none = renderStaffingEmail(v1Lead({ siteContext: '', campaign_notes: '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=NONE_REQUIRED;routing_ready=true]' }), 1, OPTIONS);
  assert.match(none.body, /^Hi Dana,\n\nWe help industrial staffing agencies generate qualified employer meetings — and we get paid/);
  // The OOO resume line still opens a V1 follow-up exactly as before, and works for V2 too.
  const resumed = renderStaffingEmail(v1Lead(), 2, { ...OPTIONS, oooResumeContext: true });
  assert.ok(resumed.body.startsWith("Hi Dana,\n\nCircling back now that you're back in the office.\n\nJust to clarify — we're not talking"));
  assert.ok(renderStaffingEmail(v2Lead(), 3, { ...OPTIONS, oooResumeContext: true }).body
    .startsWith("Hi Dana,\n\nCircling back now that you're back in the office.\n\nQuick question before I close the loop."));
});

// ── Personalization: roles and market only from V1's validated opening ──────

test('V2 Touch 1 renders only from a stored roles-and-market opening; it never invents roles or a market', () => {
  assert.deepEqual(staffingOpeningParts(OPENING), { roles: 'electricians and plumbers', market: 'commercial and industrial contractors' });
  for (const opening of ['Saw you focus on oil & gas staffing for employers.', 'Saw you place warehouse workers across South Carolina.', '']) {
    assert.equal(staffingOpeningParts(opening), null, opening);
    assert.throws(() => renderStaffingEmail(v2Lead({ siteContext: opening }), 1, OPTIONS), /roles-and-market opening/, opening);
  }
  const noneReview = '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=NONE_REQUIRED;routing_ready=true]';
  assert.throws(() => renderStaffingEmail(v2Lead({ siteContext: '', campaign_notes: noneReview }), 1, OPTIONS), /roles-and-market opening/);
  assert.equal(renderStaffingPreview(v2Lead(), { hyperPersonalizedOpening: 'Saw you focus on construction staffing for employers.' }, 1, OPTIONS), null);
  // No generic fallback: V2 Touch 1 has no roles/market-free variant to fall back to.
  assert.equal(renderStaffingPreview(v2Lead({ siteContext: '' }), { hyperPersonalizedOpening: '' }, 1, OPTIONS), null);
  assert.equal(LOCKED_EMAILS_V2.filter(text => text.includes('{{roles}}') && text.includes('{{market}}')).length, 1);
});

// ── 13. Isolation ────────────────────────────────────────────────────────────

test('13a. V1 can never render V2 copy', t => {
  withLaunchedStaffing(t, { v2Live: true });
  for (const step of [1, 2, 3]) {
    const body = renderStaffingEmail(v1Lead(), step, OPTIONS).body;
    for (const phrase of [RISK_REVERSAL, IMPORTANT_PART, SEND_THE_10, 'Quick question before I close the loop', 'I found 10 employers', 'ScaleLabAI', V2_UNSUBSCRIBE]) {
      assert.equal(body.includes(phrase), false, `V1 step ${step}: ${phrase}`);
    }
  }
  for (const mixed of [v1Lead({ emailTemplateId: V2_TEMPLATE }), v1Lead({ intendedCampaignVersion: V2_ID })]) {
    assert.equal(isStaffingCampaign(mixed), false);
    for (const step of [1, 2, 3]) assert.throws(() => renderStaffingEmail(mixed, step, OPTIONS), /Staffing campaign assignment required/);
  }
  assert.throws(() => activeVersionForLead(v1Lead({ emailTemplateId: V2_TEMPLATE })), /incompatible with template/);
  for (const step of [1, 2, 3]) {
    assert.equal(validateStaffingEmail({ ...renderStaffingEmail(v1Lead(), step, OPTIONS), campaignId: V2_ID }, step), 'staffing body is missing its locked phrase');
  }
});

test('13b. V2 can never render V1 copy, nor use the V1 template or version', t => {
  withLaunchedStaffing(t, { v2Live: true });
  for (const step of [1, 2, 3]) {
    const body = renderStaffingEmail(v2Lead(), step, OPTIONS).body;
    for (const phrase of ["we're not talking about candidate sourcing", 'there are no meeting fees', 'You can see how it works here',
      'is focused on right now', 'we get paid based on the meetings we generate', '— Deins', 'Not relevant?', 'Ref: SA-48271']) {
      assert.equal(body.includes(phrase), false, `V2 step ${step}: ${phrase}`);
    }
    // A V2 body validated as V1 is refused: V1's locked phrase (Touches 1–2) or
    // V1's footer (Touch 3, whose question opens with V1 Touch 3's words).
    const email = renderStaffingEmail(v2Lead(), step, OPTIONS);
    assert.equal(validateStaffingEmail({ subject: email.subject, body: email.body }, step),
      step === 3 ? 'staffing body is missing the unsubscribe footer' : 'staffing body is missing its locked phrase');
  }
  for (const mixed of [v2Lead({ emailTemplateId: V1_TEMPLATE }), v2Lead({ intendedCampaignVersion: V1_ID }), v2Lead({ campaign: STAFFING_CAMPAIGN.name })]) {
    assert.equal(staffingCampaignFor(mixed), null);
    for (const step of [1, 2, 3]) assert.throws(() => renderStaffingEmail(mixed, step, OPTIONS), /Staffing campaign assignment required/);
  }
  assert.throws(() => activeVersionForLead(v2Lead({ emailTemplateId: V1_TEMPLATE })), /incompatible with template/);
  assert.equal(staffingCampaignFor(v1Lead()), STAFFING_CAMPAIGN);
  assert.equal(staffingCampaignFor(v2Lead()), STAFFING_CAMPAIGN_V2);
  assert.equal(isStaffingTemplateId(V1_TEMPLATE) && isStaffingTemplateId(V2_TEMPLATE) && !isStaffingTemplateId('dental-guarantee-v1'), true);
});

// ── 14–15. Not live: nothing can be queued to V2 or sent under it ────────────

test('14. STAFFING_V2_LIVE stays false in source and at runtime', () => {
  assert.equal(staffingV2Live(), false);
  const source = fs.readFileSync(path.join(ROOT, 'integrations', 'staffing-campaign.js'), 'utf8');
  assert.match(source, /^const STAFFING_V2_LIVE = false;$/m);
  assert.equal(CAMPAIGN_VERSIONS[V2_ID].status, 'draft');
  assert.equal(STAFFING_CAMPAIGN_V2.ready, false);
});

test('15. no queue or send path is enabled for V2: not offered, refused by the queue route, held by selection, refused at send', async t => {
  withLaunchedStaffing(t, { v2Live: false });
  assert.equal(CAMPAIGN_VERSIONS[V1_ID].status, 'active', 'V1 follows the staffing launch gate as before');
  assert.deepEqual(campaignVersionsForRoute({ niche: 'industrial_staffing' }).map(v => v.id),
    [V1_ID, 'industrial_staffing_outreach_campaign_2']);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: V2_TEMPLATE, campaignVersionId: V2_ID }).ok, false);
  assert.equal(templateById(V2_TEMPLATE).ready, false);
  const held = routedLeadReady(v2Lead({ senderInboxId: 'primary', routingRequired: 'true' }), { STAFFING_LAUNCH_ACTIVATED_AT: LAUNCHED });
  assert.deepEqual([held.ok, held.reason], [false, 'Industrial Staffing Agency V2 is registered but not live yet']);
  for (const step of [1, 2, 3]) assert.throws(() => coldSendAttribution(v2Lead(), step), /is not active/);
  // The queue route refuses V2 and writes nothing.
  let writes = 0;
  const lead = { ...v2Lead(), stage: 'Import', intendedCampaignVersion: '', emailTemplateId: '', lastEmailedAt: '' };
  const result = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'primary', emailTemplateId: V2_TEMPLATE, campaignVersionId: V2_ID }, {
    loadState: async () => ({ leads: [lead], activities: [], boardLeads: [], suppressedEmails: new Set(), ...STAFFING_RENDER_OPTIONS }),
    validateSelection: (l, sender) => validateCampaignVersionRoute({ niche: l.leadNiche, emailTemplateId: V2_TEMPLATE, campaignVersionId: V2_ID }),
    applyChanges: async changes => { writes += changes.length; return []; },
    appendActivities: async () => { writes += 1; },
  });
  assert.equal(writes, 0);
  assert.deepEqual([result.status, result.error], [422, 'An approved registered campaign version is required']);
  // Made live (a later reviewed change), it follows V1's staffing launch gate exactly.
  setStaffingV2LiveForTests(true);
  assert.equal(CAMPAIGN_VERSIONS[V2_ID].status, 'active');
  delete process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  assert.equal(CAMPAIGN_VERSIONS[V2_ID].status, 'approved', 'live V2 before a staffing launch is paused exactly like V1');
});

test('the queue route never moves a V1 lead into V2 (or the reverse), and writes nothing when it refuses', async () => {
  const imported = lead => ({ ...lead, stage: 'Import', intendedCampaignVersion: '', emailTemplateId: '', lastEmailedAt: '' });
  const queue = async (lead, emailTemplateId, campaignVersionId) => {
    let writes = 0;
    const result = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'primary', emailTemplateId, campaignVersionId }, {
      loadState: async () => ({ leads: [lead], activities: [], boardLeads: [], suppressedEmails: new Set(), ...STAFFING_RENDER_OPTIONS }),
      validateSelection: () => ({ ok: true }),
      applyChanges: async changes => { writes += changes.length; return changes.map(({ lead: l }) => ({ leadId: l.id, status: 'succeeded' })); },
      appendActivities: async () => {},
    });
    return { result, writes };
  };
  for (const [lead, emailTemplateId, campaignVersionId] of [
    [imported(v1Lead()), V2_TEMPLATE, V2_ID],
    [imported(v2Lead()), V1_TEMPLATE, V1_ID],
  ]) {
    const { result, writes } = await queue(lead, emailTemplateId, campaignVersionId);
    assert.equal(writes, 0, campaignVersionId);
    assert.deepEqual([result.status, result.error], [422, "Tradeco Construction: the selected staffing campaign version is not this lead's campaign"]);
  }
  const control = await queue(imported(v1Lead()), V1_TEMPLATE, V1_ID);
  assert.deepEqual([control.result.queued, control.writes], [1, 1]);
});

// ── Everything else inherited ────────────────────────────────────────────────

test('V2 inherits V1 elsewhere: launch gate, cadence, ICP, offer family, send-path recognition; only its footer is its own', () => {
  const { isStaffingLead } = require('../integrations/staffing-launch-gate');
  assert.equal(isStaffingLead(v2Lead()), true);
  assert.equal(staffing.STAFFING_SEQUENCE_TIMING, require('../integrations/sequence-timing').SEQUENCE_TIMING, 'one shared cadence');
  assert.deepEqual(resolveCampaign({ id: V2_ID }).icp, resolveCampaign({ id: V1_ID }).icp);
  assert.deepEqual(resolveCampaign({ name: STAFFING_CAMPAIGN_V2.name }).icp, resolveCampaign({ id: V1_ID }).icp);
  const { offerForLead } = require('../integrations/offer-config');
  assert.equal(offerForLead(v2Lead()).id, offerForLead(v1Lead()).id);
  // V1 keeps its compliance footer on every touch; every V2 touch ends with V2's own.
  for (const step of [1, 2, 3]) assert.ok(renderStaffingEmail(v1Lead(), step, OPTIONS).body.endsWith('Ref: SA-48271'));
  for (const step of [1, 2, 3]) assert.ok(renderStaffingEmail(v2Lead(), step, OPTIONS).body.endsWith(V2_FOOTER_TEXT));
  const agent = fs.readFileSync(path.join(ROOT, 'outreach-agent.js'), 'utf8');
  assert.equal(/STAFFING_TEMPLATE\b/.test(agent), false);
  assert.equal((agent.match(/isStaffingTemplateId\(lead\.emailTemplateId\)/g) || []).length, 8);
  assert.match(agent, /validateStaffingEmail\(\{ subject, body, campaignId: staffingCampaignFor\(lead\)\?\.id \}, 1\)/);
});
