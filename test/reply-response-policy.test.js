'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTION, decideReplyResponse } = require('../integrations/reply-response-policy');
const { offerForLead, warmResponse } = require('../integrations/offer-config');
const { deriveAutomationOwnership, OWNER } = require('../integrations/automation-ownership');

const dental = { id: 'l1', company: 'Example Dental', tradeType: 'Dental', emailTemplateId: 'dental-guarantee-v1' };
test('normal positive and meeting intent deterministically produce a booking response', () => {
  const offer = offerForLead(dental, {});
  for (const classification of ['INTERESTED','MEETING_REQUEST']) {
    const decision = decideReplyResponse({ classification, offer });
    assert.equal(decision.send, true);
    assert.match(warmResponse({ action: decision.action, lead: dental, offer }), /calendar\.app\.google/);
  }
});
test('pricing auto-sends only with explicit campaign-approved wording', () => {
  const unconfigured = offerForLead(dental, {});
  assert.equal(decideReplyResponse({ classification: 'QUESTION', text: 'How much?', offer: unconfigured }).action, ACTION.HUMAN_REVIEW);
  const configured = offerForLead(dental, { OFFER_PRICING_JSON: JSON.stringify({ dental_ai_receptionist: { approvedWording: 'Approved exact pricing wording.' } }) });
  const decision = decideReplyResponse({ classification: 'QUESTION', text: 'How much?', offer: configured });
  assert.equal(decision.action, ACTION.AUTO_PRICING_RESPONSE);
  assert.match(warmResponse({ action: decision.action, lead: dental, offer: configured }), /Approved exact pricing wording/);
});
test('unsubscribe, negative, wrong person and OOO never create an automated email', () => {
  const offer = offerForLead(dental, {});
  for (const classification of ['UNSUBSCRIBE','NOT_INTERESTED','WRONG_PERSON','OUT_OF_OFFICE','NEEDS_HUMAN']) {
    assert.equal(decideReplyResponse({ classification, offer }).send, false);
  }
});
test('all warm prospect responses route through the hardened primitive', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const question = source.slice(source.indexOf('async function handleQuestion'), source.indexOf('async function handleNeedsHuman'));
  const roofing = source.slice(source.indexOf('async function handleRoofingSurveyReply'), source.indexOf('async function runReplyCheckPass'));
  const positive = source.slice(source.indexOf('async function handlePositiveAutomation'), source.indexOf('async function writeLateReplyNotes'));
  const intent = source.slice(source.indexOf('async function runIntentTriggerPass'), source.indexOf('async function runHumanOutboundPass'));
  for (const block of [question, roofing, positive, intent]) {
    assert.match(block, /deliverHardenedWarmReply/);
    assert.doesNotMatch(block, /await sendEmail\(/);
  }
});
test('ordinary positive promotion no longer applies MANUAL HOLD', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const interested = source.slice(source.indexOf('async function handleInterested'), source.indexOf('const ACTIVE_REPLY_EVENT_TYPES'));
  assert.doesNotMatch(interested, /applyHoldToNotes/);
  assert.match(interested, /deterministic reply automation/);
});
test('canonical ownership recognizes one deterministic reply automation owner', () => {
  const result = deriveAutomationOwnership({ id: 'l1', email: 'lead@example.com', emailStatus: 'replied' }, {
    sendingEnabled: true, replyResponseDecision: { send: true, action: ACTION.AUTO_BOOKING_RESPONSE },
  });
  assert.equal(result.owner, OWNER.REPLY_AUTOMATION);
  assert.equal(result.sendAllowed, true);
});
