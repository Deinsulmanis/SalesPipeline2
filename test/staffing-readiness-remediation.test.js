'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CAMPAIGN_FAMILY, familyForLead, resolveLeadFamily } = require('../integrations/campaign-versions');
const { offerForLead } = require('../integrations/offer-config');
const { factsForLead, STAFFING_PRODUCT_FACTS, DENTAL_PRODUCT_FACTS } = require('../product-facts');
const { ACTION, decideReplyResponse, numericConfidence, POSITIVE_AUTOSEND_FLOOR } = require('../integrations/reply-response-policy');
const { classifyStaffingReply, STAFFING_CLARIFICATION, unroutedReplyDecision } = require('../integrations/staffing-reply-policy');
const { sequenceAllowedForLead, evaluateStageSequence, automaticEnrollmentDecision } = require('../integrations/stage-sequences');
const { authoritativeProvider, assertGmailProviderAllowed, assertSmartleadEnqueueAllowed } = require('../integrations/provider-ownership');
const { staffingReadinessReport } = require('../integrations/staffing-readiness');
const { sendAuthorization } = require('../integrations/send-authorization');
const { staffingLaunchState, ACTIVATION_VARIABLE } = require('../integrations/staffing-launch-gate');
const { STAFFING_CAMPAIGN, LOCKED_EMAILS, renderStaffingEmail } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const staffing = (over = {}) => ({
  id: 'S1', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing',
  contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary',
  routingRequired: 'true', siteContext: 'Your warehouse team places CDL drivers for local manufacturers.',
  stage: 'Queued', emailStatus: '', emailStep: '', notes: '', ...over,
});
const dental = (over = {}) => ({
  id: 'D1', email: 'front@clinic.test', company: 'Harbour Dental',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', campaign: 'Dental V3',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', ...over,
});
const roofing = (over = {}) => ({
  id: 'R1', email: 'ops@roofs.test', company: 'Peak Roofing',
  leadNiche: 'roofing', emailTemplateId: 'roofing-survey-v1', ...over,
});

test('1. staffing question facts never include dental language', () => {
  const scoped = factsForLead(staffing());
  assert.equal(scoped.ok, true);
  assert.equal(scoped.family, CAMPAIGN_FAMILY.STAFFING);
  assert.match(scoped.facts, /employer acquisition/);
  assert.doesNotMatch(scoped.facts, /dental|clinic|patient|receptionist|missed calls/i);
  assert.doesNotMatch(STAFFING_PRODUCT_FACTS, /dental|clinic|patient/i);
  assert.match(DENTAL_PRODUCT_FACTS, /dental practices/);
  const agent = read('outreach-agent.js');
  const fn = agent.slice(agent.indexOf('async function answerQuestion'), agent.indexOf('function withBooking'));
  assert.match(fn, /factsForLead/);
  assert.doesNotMatch(fn, /sells 24\/7 answering and booking software to dental clinics/);
});

test('2. unknown niche never defaults to dental', () => {
  assert.equal(familyForLead({}), CAMPAIGN_FAMILY.UNROUTED);
  assert.equal(familyForLead({ leadNiche: 'plumbing' }), CAMPAIGN_FAMILY.UNROUTED);
  assert.equal(resolveLeadFamily({ leadNiche: 'dental', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }).family, CAMPAIGN_FAMILY.UNROUTED);
  assert.throws(() => offerForLead({}), /unrouted|blank or unknown/i);
  const scoped = factsForLead({});
  assert.equal(scoped.ok, false);
  assert.doesNotMatch(scoped.facts, /dental practices/);
});

test('dental still resolves to dental and roofing still resolves to roofing', () => {
  assert.equal(familyForLead(dental()), CAMPAIGN_FAMILY.DENTAL);
  assert.equal(familyForLead(roofing()), CAMPAIGN_FAMILY.ROOFING);
  assert.equal(offerForLead(dental()).targetCustomer, 'dental practices');
  assert.equal(offerForLead(roofing()).id, 'roofing_survey_v1');
  assert.notEqual(familyForLead(staffing()), familyForLead(dental()));
});

test('3. clear staffing interest above threshold may take the warm path but still requires 2B/2C gates', () => {
  const decision = decideReplyResponse({
    classification: 'INTERESTED',
    canonical: { state: 'positive', confidence: 'high', signals: ['expressed_interest'] },
    offer: offerForLead(staffing()),
    text: 'Yes we are interested in more employer accounts',
  });
  assert.equal(decision.send, true);
  assert.ok(decision.confidence >= POSITIVE_AUTOSEND_FLOOR);
  const agent = read('outreach-agent.js');
  const positive = agent.slice(agent.indexOf('async function handlePositiveAutomation'), agent.indexOf('async function handleTimingReply'));
  assert.match(positive, /deliverHardenedWarmReply/);
  assert.match(agent, /assertSendAuthorized\(\)/);
  assert.match(agent, /withGmailProviderSend|withOutboundReservation/);
});

test('4. low-confidence positive classification does not auto-send', () => {
  const decision = decideReplyResponse({
    classification: 'INTERESTED', offer: offerForLead(staffing()), confidence: 40,
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  assert.equal(numericConfidence({ classification: 'INTERESTED', canonical: { confidence: 'low' } }) < POSITIVE_AUTOSEND_FLOOR, true);
});

test('5. candidate-sourcing misunderstanding is staffing clarification and not a qualified employer meeting', () => {
  const result = classifyStaffingReply('Can you send us more warehouse candidates next week?', staffing());
  assert.equal(result.candidateSide, true);
  assert.equal(result.qualifiedEmployer, false);
  assert.equal(result.send, false);
  assert.equal(result.promote, false);
  assert.match(result.clarification, /not talking about candidate sourcing/);
  assert.equal(STAFFING_CLARIFICATION.includes('candidate sourcing'), true);
});

test('6. unsubscribe suppresses and does not send', () => {
  const decision = decideReplyResponse({ classification: 'UNSUBSCRIBE', offer: offerForLead(staffing()) });
  assert.equal(decision.action, ACTION.SUPPRESS);
  assert.equal(decision.send, false);
});

test('7. wrong person / referral does not falsely qualify', () => {
  const decision = decideReplyResponse({ classification: 'WRONG_PERSON', offer: offerForLead(staffing()) });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  const referred = classifyStaffingReply('Please talk to our other manager instead', staffing());
  assert.equal(referred.qualifiedEmployer, false);
});

test('8. staffing lead cannot enter a dental sequence', () => {
  assert.equal(sequenceAllowedForLead('dental_ai_receptionist_cold', staffing()).ok, false);
  assert.equal(sequenceAllowedForLead('demo_follow_up_v1', staffing()).ok, false);
  const enroll = automaticEnrollmentDecision({
    twin: staffing(), verdict: { offer: 'demo_follow_up_v1' },
    senderProof: { ok: true, senderInboxId: 'primary' },
    thread: { threadId: 't1' },
  });
  assert.equal(enroll.enroll, false);
});

test('9. dental lead cannot enter a staffing sequence', () => {
  assert.equal(sequenceAllowedForLead('industrial_staffing_cold', dental()).ok, false);
  assert.equal(sequenceAllowedForLead('demo_follow_up_v1', dental()).ok, true);
});

test('10. staffing provider ownership is singular', () => {
  const gmail = authoritativeProvider({ lead: staffing(), mappings: [], campaignProviders: {} });
  assert.equal(gmail.provider, 'gmail');
  assert.equal(gmail.gmailAllowed, true);
  assert.equal(gmail.smartleadAllowed, false);
  const smartlead = authoritativeProvider({
    lead: staffing(),
    mappings: [{ internalLeadId: 'S1', normalizedEmail: 'owner@harbourstaffing.test', provider: 'smartlead', normalizedStatus: 'Queued' }],
  });
  assert.equal(smartlead.provider, 'smartlead');
  assert.equal(smartlead.gmailAllowed, false);
});

test('11. Smartlead-owned staffing lead cannot receive Gmail follow-up', () => {
  assert.throws(() => assertGmailProviderAllowed({
    lead: staffing(),
    mappings: [{ internalLeadId: 'S1', normalizedEmail: 'owner@harbourstaffing.test', provider: 'smartlead', normalizedStatus: 'Queued' }],
  }), /Smartlead/);
});

test('12. Gmail-owned staffing lead cannot be enqueued into Smartlead concurrently', () => {
  assert.throws(() => assertSmartleadEnqueueAllowed({
    lead: staffing({ emailStatus: 'emailed', emailStep: '1' }),
    campaignProviders: { [STAFFING_CAMPAIGN.name]: { provider: 'smartlead', externalCampaignId: '99' } },
  }), /Gmail/);
});

test('13. staffing activation timestamp alone does not bypass send authorization', () => {
  const env = { [ACTIVATION_VARIABLE]: '2026-09-01T00:00:00.000Z', SENDING_ENABLED: 'false' };
  assert.equal(staffingLaunchState(env).sendable, true);
  const auth = sendAuthorization(env);
  assert.equal(auth.allowed, false);
});

test('14. SENDING_ENABLED=false still blocks provider sends', () => {
  const auth = sendAuthorization({
    SENDING_ENABLED: 'false', RAILWAY_ENVIRONMENT: 'production',
    SEND_AUTHORIZED_ENV: 'production', SEND_AUTHORIZED_TOKEN: 'token',
    SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
  });
  assert.equal(auth.allowed, false);
  assert.equal(auth.code, 'sending_disabled');
});

test('15. Phase 2C reservation is still required on Gmail send', () => {
  const agent = read('outreach-agent.js');
  const send = agent.slice(agent.indexOf('async function sendEmail('), agent.indexOf('async function loadOutreachProviderState('));
  assert.match(send, /withGmailProviderSend/);
  assert.match(agent, /withOutboundReservation/);
});

test('16. stage sequence stops after a reply', () => {
  const source = read('integrations/stage-sequences.js');
  assert.match(source, /if \(since\(replyAt\)\) return 'the prospect replied'/);
  const verdict = evaluateStageSequence({
    boardLead: { stage: 'hot' }, twin: staffing(), featureEnabled: true,
    activities: [
      { eventType: 'sequence_enrolled', occurredAt: '2026-09-01T00:00:00.000Z', metadata: JSON.stringify({ sequenceId: 'hot_stale_v1' }) },
      { eventType: 'positive_reply', occurredAt: '2026-09-02T00:00:00.000Z' },
    ],
  });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason || verdict.stopReason || '', /replied/);
});

test('17. approved staffing sequence copy maps to the intended campaign version', () => {
  assert.equal(STAFFING_CAMPAIGN.id, 'industrial_staffing_employer_acquisition_v1');
  assert.match(LOCKED_EMAILS[0], /qualified employer meetings/);
  assert.match(LOCKED_EMAILS[1], /not talking about candidate sourcing/);
  assert.match(LOCKED_EMAILS[2], /more employer accounts/);
  const email = renderStaffingEmail(staffing(), 1, STAFFING_RENDER_OPTIONS);
  assert.equal(email.subject, 'employer accounts');
  assert.match(email.body, /Harbour Staffing/);
});

test('18. unknown/unrouted lead remains manual review', () => {
  const decision = unroutedReplyDecision({ leadNiche: '' });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  assert.equal(decision.promote, false);
});

test('19. unsupported staffing pricing question is draft/manual review, not an invented answer', () => {
  const decision = decideReplyResponse({
    classification: 'QUESTION', text: 'How much does this cost per month?',
    offer: offerForLead(staffing()),
  });
  assert.equal(decision.send, false);
  assert.equal(decision.action, ACTION.HUMAN_REVIEW);
  assert.match(decision.reason, /pricing is not configured/);
});

test('readiness report is read-only and never recommends retry-send', () => {
  const report = staffingReadinessReport({
    leads: [staffing(), staffing({ id: 'S2', email: 'two@x.test', stage: 'Import', notes: '[MANUAL HOLD]' })],
    env: { [ACTIVATION_VARIABLE]: '2026-09-01T00:00:00.000Z', SENDING_ENABLED: 'false' },
  });
  assert.equal(report.mutated, false);
  assert.equal(report.counts.totalStaffing, 2);
  assert.equal(report.counts.queued, 1);
  assert.equal(report.counts.blockedByManualHold, 1);
  assert.equal(report.rows.every(row => row.retryableSend === false), true);
});
