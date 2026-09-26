'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  STAFFING_CAMPAIGN, STAFFING_LANDING_PAGE_URL, renderStaffingEmail, validateStaffingEmail,
  isTrackedStaffingLandingUrl, withStaffingLandingUrl,
} = require('../integrations/staffing-campaign');
const { STAFFING_SEND_INFO_REPLY, staffingSendInfoReply } = require('../integrations/staffing-reply-policy');
const { offerForLead, warmResponse } = require('../integrations/offer-config');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const TRACKED = `${STAFFING_LANDING_PAGE_URL}?t=AbCdEfGhIjKlMnOpQrStUv`;
const lead = {
  id: 'S1', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing', contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary',
  routingRequired: 'true', siteContext: 'Your warehouse team places CDL drivers for local manufacturers.',
};

// SHA-256 of what production 54ad855 renders for this fixture, computed from
// the unmodified modules. With no tracked URL, the output must not move by a byte.
const BASELINE_54AD855 = Object.freeze({
  step1: { body: '31bb33d9de2ff5baa884ab1cf77ca979e6b9dcefc3e38b4d45b5717d865b1aac', html: 'ed843d3527dadd783cdfa4f74e65c52b139528871987b5affdf58542ee8f3a00' },
  step2: { body: '6153c78b47f450a39fb10605b57121f3de646e0a1166066085d8578e44717464', html: 'd942d8dc898515b96400d85b5901051870f1a85586601c4db146a8b4d2ce052b' },
  step3: { body: '58ce0634aca0fa76be75d445141a3487724c0814a9a8cde5e69fb88ec37de4c0', html: '61dfe39315e3e31662a8f86cb48c22a96a5462ff7b8c896d4fc42c562ea1ed5a' },
  AUTO_STAFFING_QUALIFY_QUESTION: 'a3e5d182ed39f749fe32d41659567a161323de38d08c20506bda1d6fe3c959e7',
  AUTO_STAFFING_SEND_INFO: '2a318f8fc183270ad973f81ed038387d11d25ba8d0806c393c2fb6781b9a5ef2',
  AUTO_STAFFING_QUALIFIED: 'a932aaabd4b36b83a744c07fb52b5f7f8153f0947b1e64420aaa0755d89f9266',
  AUTO_BOOKING_RESPONSE: '147e4082973d413d54b9c86c14e3891142003d1ffe1e9eccfd65cfeb8ca818f3',
  AUTO_MEETING_RESPONSE: 'd9910e3ada0a2fdaa45bd0b0a1b52b92aca0436ac954676724cd4ef168b7a477',
});

test('untracked renders are byte-identical to production 54ad855 for all three staffing steps', () => {
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(lead, step, STAFFING_RENDER_OPTIONS);
    assert.equal(sha(email.body), BASELINE_54AD855[`step${step}`].body, `step ${step} body`);
    assert.equal(sha(email.html), BASELINE_54AD855[`step${step}`].html, `step ${step} html`);
  }
});

test('untracked warm responses are byte-identical to production 54ad855', () => {
  const offer = offerForLead(lead);
  for (const action of ['AUTO_STAFFING_QUALIFY_QUESTION', 'AUTO_STAFFING_SEND_INFO', 'AUTO_STAFFING_QUALIFIED', 'AUTO_BOOKING_RESPONSE', 'AUTO_MEETING_RESPONSE']) {
    assert.equal(sha(warmResponse({ action, lead, offer })), BASELINE_54AD855[action], action);
  }
  assert.equal(staffingSendInfoReply(), STAFFING_SEND_INFO_REPLY);
});

test('a tracked step-2 render changes only the landing URL, in body and html', () => {
  const plain = renderStaffingEmail(lead, 2, STAFFING_RENDER_OPTIONS);
  const tracked = renderStaffingEmail(lead, 2, { ...STAFFING_RENDER_OPTIONS, landingPageUrl: TRACKED });
  assert.equal(tracked.body, plain.body.replace(STAFFING_LANDING_PAGE_URL, TRACKED));
  assert.equal(tracked.html, plain.html.replace(STAFFING_LANDING_PAGE_URL, TRACKED));
  assert.equal(tracked.body.split(TRACKED).length, 2);
  assert.equal(validateStaffingEmail({ ...tracked, subject: '' }, 2), null);
});

test('tracked URLs are refused on steps without the landing page and when malformed', () => {
  for (const step of [1, 3]) {
    assert.throws(() => renderStaffingEmail(lead, step, { ...STAFFING_RENDER_OPTIONS, landingPageUrl: TRACKED }), /only staffing step 2/);
  }
  for (const bad of [
    STAFFING_LANDING_PAGE_URL, `${STAFFING_LANDING_PAGE_URL}?t=short`, `${STAFFING_LANDING_PAGE_URL}?email=a@b.c`,
    `${TRACKED}&x=1`, 'https://evil.example/staffing/?t=AbCdEfGhIjKlMnOpQrStUv', `http://scalelabai.ca/staffing/?t=AbCdEfGhIjKlMnOpQrStUv`,
  ]) {
    assert.equal(isTrackedStaffingLandingUrl(bad), false, bad);
    assert.throws(() => renderStaffingEmail(lead, 2, { ...STAFFING_RENDER_OPTIONS, landingPageUrl: bad }), /not a tracked landing link/, bad);
  }
  assert.throws(() => withStaffingLandingUrl('no url here', TRACKED), /exactly once/);
});

test('tracked warm responses: send-info and qualified carry the link; nothing else accepts one', () => {
  const offer = offerForLead(lead);
  const info = warmResponse({ action: 'AUTO_STAFFING_SEND_INFO', lead, offer, landingPageUrl: TRACKED });
  assert.equal(info, STAFFING_SEND_INFO_REPLY.replace(STAFFING_LANDING_PAGE_URL, TRACKED));
  const qualified = warmResponse({ action: 'AUTO_STAFFING_QUALIFIED', lead, offer, landingPageUrl: TRACKED });
  assert.equal(qualified, warmResponse({ action: 'AUTO_STAFFING_QUALIFIED', lead, offer }).replace(STAFFING_LANDING_PAGE_URL, TRACKED));
  // The direct booking link stays in the qualified reply, untouched.
  assert.ok(qualified.includes(offer.bookingUrl));
  for (const action of ['AUTO_STAFFING_QUALIFY_QUESTION', 'AUTO_BOOKING_RESPONSE', 'AUTO_MEETING_RESPONSE']) {
    assert.throws(() => warmResponse({ action, lead, offer, landingPageUrl: TRACKED }), /does not carry the staffing landing page/, action);
  }
  assert.throws(() => warmResponse({ action: 'AUTO_STAFFING_QUALIFIED', lead, offer, landingPageUrl: 'https://scalelabai.ca/other' }), /not a tracked landing link/);
});
