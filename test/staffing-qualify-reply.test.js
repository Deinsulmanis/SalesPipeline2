'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STAFFING_CAMPAIGN, STAFFING_LANDING_PAGE_URL, LOCKED_EMAILS, renderStaffingEmail,
} = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');
const { offerForLead, warmResponse, OFFERS } = require('../integrations/offer-config');
const { ACTION, decideReplyResponse } = require('../integrations/reply-response-policy');
const { BOOKING_URL, containsBookingLink } = require('../booking');
const { classifyReplyText, hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase } = require('../integrations/canonical-reply');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const {
  overlayStaffingReplyClassification, classifyStaffingQualificationAnswer,
  staffingConversationState, STAFFING_NOTE, STAFFING_QUALIFY_QUESTION, STAFFING_SEND_INFO_REPLY,
  staffingQualifiedReply, inboundWarmReplyAlreadySent, notesForStaffingWarmAction,
} = require('../integrations/staffing-reply-policy');

const staffing = (over = {}) => ({
  id: 'S1', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing',
  contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary',
  routingRequired: 'true', siteContext: 'Your warehouse team places CDL drivers for local manufacturers.',
  stage: 'Queued', emailStatus: 'emailed', emailStep: '1', notes: '', ...over,
});
const dental = (over = {}) => ({
  id: 'D1', email: 'front@clinic.test', company: 'Harbour Dental',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', campaign: 'Dental V3',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', ...over,
});
const render = step => renderStaffingEmail(staffing(), step, STAFFING_RENDER_OPTIONS);
const overlay = (text, leadOver = {}, classification = 'NEEDS_HUMAN') => overlayStaffingReplyClassification({
  text, lead: staffing(leadOver), classification, canonical: classifyReplyText(text),
});

test('cold Email 1 does not contain the staffing landing page', () => {
  const email = render(1);
  assert.equal(LOCKED_EMAILS[0].includes(STAFFING_LANDING_PAGE_URL), false);
  assert.equal(email.body.includes(STAFFING_LANDING_PAGE_URL), false);
  assert.equal(email.body.includes('/staffing/'), false);
  assert.match(email.body, /Reply "unsubscribe" and I won't follow up again/);
  assert.match(email.body, /Ref: SA-48271/);
});

test('cold Email 2 contains the exact staffing landing URL and keeps the footer', () => {
  const email = render(2);
  assert.ok(LOCKED_EMAILS[1].includes(STAFFING_LANDING_PAGE_URL));
  assert.ok(email.body.includes('https://scalelabai.ca/staffing/'));
  assert.equal((email.body.match(/https:\/\/scalelabai\.ca\/staffing\//g) || []).length, 1);
  assert.doesNotMatch(email.body, /[?&](lead|token|utm_|email)=/i);
  assert.match(email.body, /You can see how it works here:/);
  assert.match(email.body, /Open to seeing what this could look like for Harbour Staffing\?/);
  assert.match(email.body, /Reply "unsubscribe" and I won't follow up again/);
  assert.ok(email.body.indexOf(STAFFING_LANDING_PAGE_URL) < email.body.indexOf('ScaleLabAi'));
  assert.equal(email.subject, null);
});

test('cold Email 3 does not contain the staffing landing page', () => {
  const email = render(3);
  assert.equal(LOCKED_EMAILS[2].includes('/staffing/'), false);
  assert.equal(email.body.includes(STAFFING_LANDING_PAGE_URL), false);
  assert.match(email.body, /Reply "unsubscribe" and I won't follow up again/);
});

test('landing page URL has no tracker query and matches the offer config', () => {
  assert.equal(STAFFING_LANDING_PAGE_URL, 'https://scalelabai.ca/staffing/');
  assert.equal(OFFERS.industrial_staffing.landingPageUrl, STAFFING_LANDING_PAGE_URL);
  assert.equal(offerForLead(staffing()).landingPageUrl, STAFFING_LANDING_PAGE_URL);
  assert.doesNotMatch(STAFFING_LANDING_PAGE_URL, /\?/);
});

test('staffing Interested routes to the qualification question with no booking URL', () => {
  for (const phrase of ['Interested', "I'm interested", "I'd be open to hearing about it", 'Sure, tell me more']) {
    const result = overlay(phrase);
    assert.equal(result.classification, 'INTERESTED', phrase);
    const decision = decideReplyResponse({
      classification: result.classification, canonical: result.canonical, confidence: result.confidence,
      offer: offerForLead(staffing()), text: phrase, family: 'industrial_staffing',
    });
    assert.equal(decision.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, phrase);
    const body = warmResponse({ action: decision.action, lead: staffing(), offer: offerForLead(staffing()) });
    assert.equal(body, STAFFING_QUALIFY_QUESTION, phrase);
    assert.equal(containsBookingLink(body), false, phrase);
    assert.equal(body.includes(BOOKING_URL), false, phrase);
    assert.equal(body.includes(STAFFING_LANDING_PAGE_URL), false, phrase);
  }
});

test('dental INTERESTED still sends the booking CTA and is unchanged', () => {
  const offer = offerForLead(dental());
  const decision = decideReplyResponse({
    classification: 'INTERESTED',
    canonical: { state: 'positive', confidence: 'high', signals: ['expressed_interest'] },
    offer, text: 'Interested', family: 'dental_ai_receptionist',
  });
  assert.equal(decision.action, ACTION.AUTO_BOOKING_RESPONSE);
  const body = warmResponse({ action: decision.action, lead: dental(), offer });
  assert.match(body, /Absolutely — happy to show you/);
  assert.ok(containsBookingLink(body));
  assert.equal(overlay('Interested', dental()).overlay, false);
});

test('SEND_INFO phrases send the staffing landing page and no booking link', () => {
  for (const phrase of ['Send me some info', 'Can you send me more details?', 'Do you have a website?']) {
    const result = overlay(phrase);
    assert.equal(result.classification, 'SEND_INFO', phrase);
    const decision = decideReplyResponse({
      classification: result.classification, canonical: result.canonical, confidence: result.confidence,
      offer: offerForLead(staffing()), text: phrase, family: 'industrial_staffing',
    });
    assert.equal(decision.action, ACTION.AUTO_STAFFING_SEND_INFO, phrase);
    const body = warmResponse({ action: decision.action, lead: staffing(), offer: offerForLead(staffing()) });
    assert.equal(body, STAFFING_SEND_INFO_REPLY, phrase);
    assert.ok(body.includes(STAFFING_LANDING_PAGE_URL), phrase);
    assert.equal(containsBookingLink(body), false, phrase);
    assert.equal(body.includes(BOOKING_URL), false, phrase);
  }
});

test('dental send-info / website questions are not remapped by the staffing overlay', () => {
  assert.equal(overlay('Send me some info', dental()).overlay, false);
  assert.equal(overlay('Do you have a website?', dental()).overlay, false);
  const dentalQuestion = decideReplyResponse({
    classification: 'QUESTION', offer: offerForLead(dental()), text: 'Do you have a website?',
    family: 'dental_ai_receptionist', confidence: 90,
  });
  assert.equal(dentalQuestion.action, ACTION.AUTO_QUESTION_RESPONSE);
});

test('a pending qualification plus a clear market answer sends landing page and booking CTA', () => {
  const pending = staffing({ notes: `${STAFFING_NOTE.QUALIFY_ASKED} [REPLY: Interested]` });
  const text = 'Mostly welders and machinists';
  assert.equal(classifyStaffingQualificationAnswer(text), 'clear');
  const result = overlay(text, pending);
  assert.equal(result.classification, 'STAFFING_QUALIFICATION');
  assert.equal(result.fit, 'clear');
  const offer = offerForLead(pending);
  const decision = decideReplyResponse({
    classification: result.classification, canonical: result.canonical, confidence: result.confidence,
    offer, text, family: 'industrial_staffing', qualificationFit: result.fit,
  });
  assert.equal(decision.action, ACTION.AUTO_STAFFING_QUALIFIED);
  const body = warmResponse({ action: decision.action, lead: pending, offer });
  assert.equal(body, staffingQualifiedReply({
    company: pending.company, bookingUrl: offer.bookingUrl, landingPageUrl: offer.landingPageUrl,
  }));
  assert.ok(body.includes(STAFFING_LANDING_PAGE_URL));
  assert.ok(body.includes(BOOKING_URL));
  assert.match(body, /Harbour Staffing/);
});

test('clear-fit examples are recognized without requiring an exact canned phrase', () => {
  const pending = { notes: STAFFING_NOTE.QUALIFY_ASKED };
  for (const text of [
    'Manufacturing companies around Houston',
    'Warehouse and logistics employers',
    'Construction and skilled trades',
    'We want more employer accounts for CNC machinists and welders',
  ]) {
    assert.equal(classifyStaffingQualificationAnswer(text), 'clear', text);
    assert.equal(overlay(text, pending).fit, 'clear', text);
  }
});

test('unclear qualification answers fail closed to human review', () => {
  const pending = { notes: STAFFING_NOTE.QUALIFY_ASKED };
  const text = 'Sure';
  assert.equal(classifyStaffingQualificationAnswer(text), 'unclear');
  const result = overlay(text, pending);
  assert.equal(result.fit, 'unclear');
  const decision = decideReplyResponse({
    classification: result.classification, canonical: result.canonical, confidence: result.confidence,
    offer: offerForLead(staffing()), text, family: 'industrial_staffing', qualificationFit: result.fit,
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  assert.equal(result.notesTag, STAFFING_NOTE.QUALIFY_UNCLEAR);
});

test('an unrelated reply while qualification is pending does not qualify', () => {
  const pending = { notes: STAFFING_NOTE.QUALIFY_ASKED };
  const text = 'Can you just email this to accounting instead?';
  assert.equal(classifyStaffingQualificationAnswer(text), 'unrelated');
  const result = overlay(text, pending);
  assert.equal(result.fit, 'unrelated');
  const decision = decideReplyResponse({
    classification: result.classification, canonical: result.canonical, confidence: result.confidence,
    offer: offerForLead(staffing()), text, family: 'industrial_staffing', qualificationFit: result.fit,
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  assert.notEqual(result.notesTag, STAFFING_NOTE.QUALIFIED);
});

test('the same market answer does not qualify unless qualification is pending', () => {
  const text = 'We place welders and machinists';
  const result = overlay(text);
  assert.notEqual(result.classification, 'STAFFING_QUALIFICATION');
  assert.notEqual(result.fit, 'clear');
  const decision = decideReplyResponse({
    classification: result.classification || 'NEEDS_HUMAN',
    offer: offerForLead(staffing()), text, family: 'industrial_staffing',
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
});

test('qualification-pending state is persisted as notes tags', () => {
  assert.deepEqual(notesForStaffingWarmAction(ACTION.AUTO_STAFFING_QUALIFY_QUESTION), [STAFFING_NOTE.QUALIFY_ASKED]);
  assert.deepEqual(notesForStaffingWarmAction(ACTION.AUTO_STAFFING_SEND_INFO), [STAFFING_NOTE.INFO_SENT, STAFFING_NOTE.QUALIFY_ASKED]);
  assert.deepEqual(notesForStaffingWarmAction(ACTION.AUTO_STAFFING_QUALIFIED), [STAFFING_NOTE.QUALIFY_RECEIVED, STAFFING_NOTE.QUALIFIED]);
  const asked = staffingConversationState(`${STAFFING_NOTE.QUALIFY_ASKED} [REPLY: Interested]`);
  assert.equal(asked.qualifyAsked, true);
  assert.equal(asked.qualified, false);
  const done = staffingConversationState(`${STAFFING_NOTE.QUALIFIED} ${STAFFING_NOTE.QUALIFY_RECEIVED} ${STAFFING_NOTE.QUALIFY_ASKED}`);
  assert.equal(done.qualified, true);
});

test('unsubscribe still overrides positive staffing classification', () => {
  const text = 'Interested, please unsubscribe me';
  assert.equal(hasExplicitUnsubscribePhrase(text), true);
  assert.equal(classifyReplyText(text).reason, 'unsubscribe_request');
  const result = overlay(text, {}, 'UNSUBSCRIBE');
  assert.equal(result.classification, 'UNSUBSCRIBE');
  const decision = decideReplyResponse({
    classification: 'UNSUBSCRIBE', offer: offerForLead(staffing()), text, family: 'industrial_staffing',
  });
  assert.equal(decision.action, ACTION.SUPPRESS);
  assert.equal(decision.send, false);
});

test('negative still stops the sequence', () => {
  const text = 'Not interested, thanks.';
  assert.equal(hasExplicitNegativePhrase(text), true);
  const result = overlay(text, {}, 'NOT_INTERESTED');
  assert.equal(result.classification, 'NOT_INTERESTED');
  const decision = decideReplyResponse({
    classification: 'NOT_INTERESTED', offer: offerForLead(staffing()), text, family: 'industrial_staffing',
  });
  assert.equal(decision.action, ACTION.AUTO_NEGATIVE_CLOSE);
  assert.equal(decision.send, false);
});

test('staffing pricing still goes to review', () => {
  const decision = decideReplyResponse({
    classification: 'QUESTION', text: 'How much does this cost per month?',
    offer: offerForLead(staffing()), family: 'industrial_staffing',
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  const pending = overlay('How much does this cost per month?', { notes: STAFFING_NOTE.QUALIFY_ASKED }, 'QUESTION');
  assert.equal(pending.overlay, false);
});

test('low-confidence staffing interest without a deterministic phrase fails closed', () => {
  const decision = decideReplyResponse({
    classification: 'INTERESTED', offer: offerForLead(staffing()), confidence: 40,
    family: 'industrial_staffing', text: 'hmm maybe later idk',
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  const result = overlay('hmm maybe later idk');
  assert.equal(result.overlay, false);
});

test('no duplicate warm reply can be sent from the same inbound event', () => {
  const activities = [{
    eventType: 'booking_link_sent',
    metadata: JSON.stringify({ inboundMessageId: 'msg-1', action: ACTION.AUTO_STAFFING_QUALIFY_QUESTION }),
  }];
  assert.equal(inboundWarmReplyAlreadySent(activities, 'msg-1'), true);
  assert.equal(inboundWarmReplyAlreadySent(activities, 'msg-2'), false);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const positive = agent.slice(agent.indexOf('async function handlePositiveAutomation'), agent.indexOf('async function handleTimingReply'));
  assert.match(positive, /inboundWarmReplyAlreadySent/);
  assert.match(positive, /deliverHardenedWarmReply/);
});

test('global classifier is not loosened for bare Interested or send me some info', () => {
  assert.notEqual(deterministicReplyCategory('Interested'), 'INTERESTED');
  assert.notEqual(deterministicReplyCategory('Send me some info'), 'QUESTION');
  assert.equal(overlay('Interested').classification, 'INTERESTED');
  assert.equal(overlay('Send me some info').classification, 'SEND_INFO');
});

test('agent routes staffing SEND_INFO and qualification without the dental question+booking path', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /case 'SEND_INFO':/);
  assert.match(agent, /case 'STAFFING_QUALIFICATION':/);
  assert.match(agent, /overlayStaffingReplyClassification/);
  const question = agent.slice(agent.indexOf('async function handleQuestion'), agent.indexOf('async function handleNeedsHuman'));
  assert.match(question, /isStaffingCampaign\(lead\)/);
  assert.match(question, /SEND_INFO/);
});
