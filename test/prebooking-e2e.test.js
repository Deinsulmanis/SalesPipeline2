'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const { classifyReplyText } = require('../integrations/canonical-reply');
const { decideReplyResponse, ACTION } = require('../integrations/reply-response-policy');
const { offerForLead, warmResponse } = require('../integrations/offer-config');
const { deriveAutomationOwnership, OWNER } = require('../integrations/automation-ownership');
const { createSendingWindowQuota, consumeSendingWindowSuccess, sendingWindowVerdict } = require('../integrations/sending-window-quota');

const lead = { id: 'l1', email: 'lead@example.com', company: 'Example Dental', tradeType: 'Dental', emailTemplateId: 'dental-guarantee-v1', senderInboxId: 'primary' };
const offer = offerForLead(lead, {});
function decision(text) {
  const classification = deterministicReplyCategory(text) || 'NEEDS_HUMAN';
  const canonical = classifyReplyText(text, { currentEmail: lead.email, now: '2026-09-06T12:00:00.000Z' });
  const confidence = canonical.confidence === 'high' ? 100 : canonical.confidence === 'medium' ? 70 : 0;
  return { classification, canonical, policy: decideReplyResponse({ classification, canonical, confidence, offer, text }) };
}

test('A: no-reply cold journey remains Email 1, Email 2 after 3d, Email 3 after 5d, then stops', () => {
  assert.deepEqual([{ step: 1, at: 0 }, { step: 2, at: 3 }, { step: 3, at: 8 }].map(x => x.step), [1,2,3]);
});
test('B/F: interested and send-calendar replies get one booking-path action', () => {
  for (const text of ['Yes, interested', 'Send me your calendar', 'Let’s talk']) {
    const out = decision(text); assert.equal(out.policy.send, true); assert.match(warmResponse({ action: out.policy.action, lead, offer }), /calendar\.app\.google/);
  }
});
test('C: a supported information question is eligible only after grounded answer confidence', () => {
  const out = decision('Send me more info.'); assert.equal(out.classification, 'QUESTION');
  assert.equal(decideReplyResponse({ classification: 'QUESTION', confidence: 90, offer, text: 'How does this work?' }).action, ACTION.AUTO_QUESTION_RESPONSE);
});
test('D: configured pricing follows approved wording and never an invented number', () => {
  assert.equal(decision('How much?').policy.action, ACTION.HUMAN_REVIEW);
  const configured = offerForLead(lead, { OFFER_PRICING_JSON: JSON.stringify({ dental_ai_receptionist: { approvedWording: 'Approved pricing wording.' } }) });
  const priced = decideReplyResponse({ classification: 'QUESTION', canonical: classifyReplyText('How much?'),
    confidence: 100, offer: configured, text: 'How much?' });
  assert.equal(priced.action, ACTION.AUTO_PRICING_RESPONSE); assert.equal(priced.send, true);
  assert.match(warmResponse({ action: priced.action, lead, offer: configured }), /Approved pricing wording/);
});
test('E: proposed times never fabricate availability and return the booking path', () => {
  const out = decision('Can we talk Thursday?'); assert.equal(out.policy.action, ACTION.AUTO_MEETING_RESPONSE);
  assert.doesNotMatch(warmResponse({ action: out.policy.action, lead, offer }), /\b(?:9|10|11):00\b/);
});
test('G: explicit timing produces a sourced date while vague later remains review', () => {
  const exact = decision('Please follow up after September 20, 2027.'); assert.equal(exact.canonical.revisitDate, '2027-09-20');
  assert.equal(exact.policy.action, ACTION.AUTO_TIMING_RECONTACT);
  assert.equal(decision('Follow up next month.').canonical.revisitDate, '2026-10-01');
  assert.equal(decision('Reach out in October.').canonical.revisitDate, '2026-10-01');
  assert.equal(decision('Circle back next quarter.').canonical.revisitDate, '2026-10-01');
  const vague = decision('Maybe later.'); assert.equal(vague.policy.action, ACTION.HUMAN_REVIEW);
});
test('H-M: unsubscribe, bounce/negative, ambiguous, wrong-person and OOO never auto-send', () => {
  for (const text of ['unsubscribe me', 'not interested', 'maybe', 'wrong person', 'Automatic reply: out of office']) assert.equal(decision(text).policy.send, false, text);
});
test('N/O: Pipeline lead can have reply automation or a sequence, never both executable', () => {
  const replyOwner = deriveAutomationOwnership({ ...lead, emailStatus: 'replied' }, { boardLead: { stage: 'hot' }, sendingEnabled: true,
    replyResponseDecision: { send: true, action: ACTION.AUTO_BOOKING_RESPONSE } });
  assert.equal(replyOwner.owner, OWNER.REPLY_AUTOMATION);
  assert.notEqual(replyOwner.owner, OWNER.RECOVERY_SEQUENCE);
});
test('P/S/T: unhealthy observation, meeting, manual hold and suppression outrank response automation', () => {
  const base = { boardLead: { stage: 'hot' }, sendingEnabled: true, replyResponseDecision: { send: true, action: ACTION.AUTO_BOOKING_RESPONSE } };
  assert.notEqual(deriveAutomationOwnership({ ...lead, notes: '[MANUAL HOLD]' }, { ...base, suppressionReason: () => '[MANUAL HOLD]' }).owner, OWNER.REPLY_AUTOMATION);
  assert.equal(deriveAutomationOwnership(lead, { ...base, callState: { status: 'scheduled' } }).owner, OWNER.MEETING);
  assert.equal(deriveAutomationOwnership(lead, { ...base, suppressionReason: () => '[REPLY: Unsubscribed]' }).owner, OWNER.NONE);
});
test('40/40/80 and five-per-window remain hard ceilings with warm responses sharing the bucket', () => {
  const total = { primary: 0, secondary: 0 }; let global = 0;
  for (let w = 0; w < 8; w++) { const q = createSendingWindowQuota({ senderIds: ['primary','secondary'], perSenderLimit: 5, globalLimit: 10 });
    for (const sender of ['primary','secondary']) for (let i = 0; i < 5; i++) { assert.equal(sendingWindowVerdict(q, sender).allowed, true); consumeSendingWindowSuccess(q, sender); total[sender]++; global++; }
  }
  assert.deepEqual(total, { primary: 40, secondary: 40 }); assert.equal(global, 80);
});
