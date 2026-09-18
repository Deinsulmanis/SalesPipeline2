'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const {
  STAFFING_CAMPAIGN, STAFFING_LANDING_PAGE_URL, renderStaffingEmail,
} = require('../integrations/staffing-campaign');
const {
  PRODUCTION_STAFFING_MAILING_ADDRESS, PRODUCTION_STAFFING_RENDER_OPTIONS,
} = require('../test-support/staffing-mail');
const { looksLikeTestFixtureMailingAddress, formatStaffingComplianceFooter,
  staffingSenderIdentity } = require('../integrations/staffing-compliance');
const { classifyReplyText, REPLY_STATE, NEEDS_HUMAN_REASON, AUTOMATED_SUBTYPE,
  hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase, extractReturnDate, extractRecontactDate,
} = require('../integrations/canonical-reply');
const { deterministicReplyCategory, classifyReply, failSafeReplyCategory } = require('../integrations/reply-classifier');
const { overlayStaffingReplyClassification, classifyStaffingReply,
  STAFFING_NOTE, STAFFING_QUALIFY_QUESTION, STAFFING_SEND_INFO_REPLY, staffingQualifiedReply,
} = require('../integrations/staffing-reply-policy');
const { ACTION, decideReplyResponse } = require('../integrations/reply-response-policy');
const { offerForLead, warmResponse, bookingUrlForFamily, parsePricing } = require('../integrations/offer-config');
const { BOOKING_URL, containsBookingLink } = require('../booking');
const { sendSuppressionReason } = require('../integrations/pipeline-state');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');
const { inboundAlreadyEvaluated, shouldCallReplyModel, terminalIntentFromText,
  uniqueSuppressions, scheduledSendAfterInboundOptOut } = require('../integrations/inbound-reply-guard');
const { commercialListUnsubscribeHeaders } = require('../integrations/commercial-email-headers');
const { STAFFING_FUNNEL, staffingFunnelFromSend, staffingFunnelFromReply,
  countStaffingFunnel } = require('../integrations/staffing-funnel');

const NOW = '2026-09-18T16:00:00.000Z';
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

function preview(text, leadOver = {}, classificationHint = '') {
  const lead = staffing(leadOver);
  const canonical = classifyReplyText(text, { currentEmail: lead.email, now: NOW, year: 2026 });
  let classification = classificationHint
    || deterministicReplyCategory(text)
    || failSafeReplyCategory(text)
    || 'NEEDS_HUMAN';
  if (canonical.reason === 'unsubscribe_request' || hasExplicitUnsubscribePhrase(text)) classification = 'UNSUBSCRIBE';
  else if (canonical.reason === 'explicit_rejection' || hasExplicitNegativePhrase(text)) classification = 'NOT_INTERESTED';
  const overlay = overlayStaffingReplyClassification({ text, lead, classification, canonical });
  if (overlay.overlay && overlay.classification) classification = overlay.classification;
  const offer = offerForLead(lead);
  const decision = decideReplyResponse({
    classification, canonical: overlay.canonical || canonical, confidence: overlay.confidence,
    offer, text, family: 'industrial_staffing', qualificationFit: overlay.fit || '',
  });
  const autoSend = Boolean(decision.send);
  const body = autoSend ? warmResponse({ action: decision.action, lead, offer }) : '';
  const suppression = terminalIntentFromText(text);
  return {
    text, classification, confidence: decision.confidence, action: decision.action,
    autoSend, body, suppression: suppression?.suppressionReason || null,
    crmReason: suppression?.classification || classification,
    booking: containsBookingLink(body) || body.includes(BOOKING_URL),
    landing: body.includes(STAFFING_LANDING_PAGE_URL),
    canonicalReason: canonical.reason, canonicalState: canonical.state,
    revisitDate: canonical.revisitDate || null, returnDate: canonical.returnDate || null,
    suppliedContact: canonical.suppliedContact || null, identityMutationAllowed: canonical.identityMutationAllowed !== true,
  };
}

test('Fix 1: production mailing address renders on Email 1-3 and Harbour is absent', () => {
  const expectedFooter = [
    'ScaleLabAi',
    '150 Braid Street',
    'New Westminster, BC V3L 0L4',
    'Canada',
    'scalelabai.ca',
    '',
    'This is a commercial email. Not relevant? Reply "unsubscribe" and I won\'t follow up again.',
    '',
    'Ref: SA-48271',
  ].join('\n');
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(staffing(), step, PRODUCTION_STAFFING_RENDER_OPTIONS);
    assert.ok(email.body.includes(expectedFooter), `step ${step} missing production footer`);
    assert.equal(email.body.includes('1 Harbour Street'), false, `step ${step} still has Harbour Street`);
    assert.ok(email.body.includes('150 Braid Street'), `step ${step} missing Braid Street`);
    assert.ok(email.body.includes('V3L 0L4'), `step ${step} missing postal code`);
  }
  assert.equal(looksLikeTestFixtureMailingAddress('1 Harbour Street, New Westminster, BC V3L 1A1'), true);
  assert.equal(looksLikeTestFixtureMailingAddress(PRODUCTION_STAFFING_MAILING_ADDRESS), false);
  const identity = staffingSenderIdentity({ COMMERCIAL_MAILING_ADDRESS: PRODUCTION_STAFFING_MAILING_ADDRESS });
  assert.equal(identity.mailingAddress, PRODUCTION_STAFFING_MAILING_ADDRESS);
  assert.match(formatStaffingComplianceFooter(identity), /150 Braid Street/);
});

test('phrase matrix: interested / send-info / negative / unsubscribe', () => {
  for (const phrase of ['Interested', "I'm interested", 'Sure, tell me more', "I'd be open to hearing about it"]) {
    const result = preview(phrase);
    assert.equal(result.classification, 'INTERESTED', phrase);
    assert.equal(result.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, phrase);
    assert.equal(result.autoSend, true, phrase);
    assert.equal(result.body, STAFFING_QUALIFY_QUESTION, phrase);
    assert.equal(result.booking, false, phrase);
    assert.equal(result.landing, false, phrase);
  }
  for (const phrase of ['Send me some info', 'Can you send me more details?', 'Do you have a website?', 'Where can I read about this?']) {
    const result = preview(phrase);
    assert.equal(result.classification, 'SEND_INFO', phrase);
    assert.equal(result.action, ACTION.AUTO_STAFFING_SEND_INFO, phrase);
    assert.equal(result.landing, true, phrase);
    assert.equal(result.booking, false, phrase);
  }
  for (const phrase of ['Not interested', 'No thanks', "We don't need this", "We're not looking for this"]) {
    const result = preview(phrase);
    assert.equal(result.classification, 'NOT_INTERESTED', phrase);
    assert.equal(result.suppression, 'not_interested', phrase);
    assert.equal(result.autoSend, false, phrase);
    assert.notEqual(result.crmReason, 'UNSUBSCRIBE', phrase);
  }
  for (const phrase of ['unsubscribe', 'remove me', 'remove us', 'stop emailing me', 'take me off your list', "don't email me again"]) {
    const result = preview(phrase);
    assert.equal(result.classification, 'UNSUBSCRIBE', phrase);
    assert.equal(result.suppression, 'unsubscribe', phrase);
    assert.equal(result.autoSend, false, phrase);
  }
});

test('phrase matrix: timing / OOO / referral / already handled / qualification', () => {
  for (const phrase of ['not right now', 'maybe next month', 'reach out later', 'check back in a few weeks']) {
    const canonical = classifyReplyText(phrase, { now: NOW, year: 2026 });
    assert.equal(canonical.reason, NEEDS_HUMAN_REASON.DEFERRED_TIMING, phrase);
    assert.equal(canonical.state, REPLY_STATE.NEEDS_HUMAN, phrase);
    const result = preview(phrase);
    assert.equal(result.autoSend, false, phrase);
    assert.equal(result.booking, false, phrase);
  }
  assert.equal(extractRecontactDate('maybe next month', { now: NOW }), '2026-10-01');
  assert.equal(extractRecontactDate('check back in a few weeks', { now: NOW }), '');
  assert.equal(preview('follow up after September 20', staffing(), '').revisitDate || extractRecontactDate('follow up after September 20', { now: NOW, year: 2026 }), '2026-09-20');

  assert.equal(classifyReplyText("I'm out until Monday", { now: NOW }).subtype, AUTOMATED_SUBTYPE.OUT_OF_OFFICE);
  assert.equal(classifyReplyText('automatic reply: I am away this week').state, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(classifyReplyText("I'm on vacation until October 5", { now: NOW, year: 2026 }).returnDate, '2026-10-05');
  assert.equal(extractReturnDate("I'm out until Monday", { now: NOW }), '2026-09-21');

  for (const phrase of ["I'm not the right person", 'Talk to Sarah', 'Contact our VP of Sales', 'John handles this']) {
    const result = preview(phrase);
    assert.ok(['WRONG_PERSON', 'NEEDS_HUMAN', 'ALREADY_HANDLED'].includes(result.classification), phrase + ' ' + result.classification);
    assert.equal(result.autoSend, false, phrase);
    assert.equal(result.identityMutationAllowed, true);
    assert.equal(result.suppliedContact, null);
  }
  const withEmail = classifyReplyText('I am not the right person, talk to sarah@other.test instead', { currentEmail: 'owner@harbourstaffing.test' });
  assert.equal(withEmail.suppliedContact, 'sarah@other.test');
  assert.equal(withEmail.identityMutationAllowed, false);

  for (const phrase of [
    'We already have someone doing this',
    'We already do outbound',
    'We have an internal BD team',
    'Our sales team handles this',
  ]) {
    const result = preview(phrase);
    assert.equal(result.classification, 'ALREADY_HANDLED', phrase);
    assert.equal(result.autoSend, false, phrase);
    assert.equal(result.booking, false, phrase);
    assert.equal(result.suppression, null, phrase);
  }

  assert.equal(overlayStaffingReplyClassification({
    text: 'We place welders and machinists', lead: staffing({ notes: STAFFING_NOTE.QUALIFY_ASKED }),
    classification: 'NEEDS_HUMAN', canonical: classifyReplyText('We place welders and machinists'),
  }).fit, 'clear');
  for (const text of ['Manufacturing companies around Houston', 'Warehouse and logistics employers', 'Construction and skilled trades']) {
    assert.equal(overlayStaffingReplyClassification({
      text, lead: staffing({ notes: STAFFING_NOTE.QUALIFY_ASKED }),
      classification: 'NEEDS_HUMAN', canonical: classifyReplyText(text),
    }).fit, 'clear', text);
  }
});

test('Fix 2: unsubscribe is terminal before the model and wins a scheduled-send race', async () => {
  const calls = [];
  const classification = await classifyReply({
    plainTextReply: 'Stop emailing me',
    createMessage: async () => { calls.push('model'); return { content: [{ text: 'INTERESTED' }] }; },
  });
  assert.equal(classification, 'UNSUBSCRIBE');
  assert.equal(calls.length, 0);

  const selected = staffing({
    emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-09-15T12:00:00.000Z',
  });
  const fresh = { ...selected, notes: '[REPLY: Unsubscribed]', stage: 'Unsub', emailStatus: 'done' };
  const launchEnv = { STAFFING_LAUNCH_ACTIVATED_AT: '2020-01-01T00:00:00.000Z' };
  const race = scheduledSendAfterInboundOptOut({
    selectedLead: selected, freshLead: fresh, suppressedEmails: new Set([selected.email]),
    env: launchEnv,
  });
  assert.equal(race.allowed, false);
  assert.equal(race.code, 'unsubscribed');

  const message = {
    id: 'm-unsub', threadId: 't1', internalDate: String(Date.parse('2026-09-18T16:03:00Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: selected.email }, { name: 'To', value: 'deins@scalelabai.ca' },
        { name: 'Subject', value: 'Re: employer accounts' }, { name: 'Message-ID', value: '<m-unsub@t>' },
      ],
      body: { data: Buffer.from('remove me from your list').toString('base64url') },
    },
  };
  const plan = await planMailboxEvents({
    observation: { messages: [message], recovered: false, unavailable: [] },
    gmail: { users: { threads: { get: async () => ({ data: { messages: [] } }) } } },
    leads: [selected], activities: [], senderInboxId: 'primary', senderEmail: 'deins@scalelabai.ca',
    now: new Date(NOW),
  });
  assert.equal(plan.suppressions[0].reason, 'unsubscribe');
  const again = await planMailboxEvents({
    observation: { messages: [message], recovered: false, unavailable: [] },
    gmail: { users: { threads: { get: async () => ({ data: { messages: [] } }) } } },
    leads: [selected], activities: plan.events, senderInboxId: 'primary', senderEmail: 'deins@scalelabai.ca',
    now: new Date(NOW),
  });
  assert.equal(again.events.length, 0);
  assert.deepEqual(uniqueSuppressions([...plan.suppressions, ...again.suppressions]).map(item => item.reason), ['unsubscribe']);
});

test('Fix 3: NOT_INTERESTED globally suppresses cold outreach without becoming Unsubscribed', () => {
  const lead = staffing({ notes: '[REPLY: Not Interested]', stage: 'Done', emailStatus: 'done' });
  assert.equal(sendSuppressionReason(lead, { suppressedEmails: new Set() }), '[REPLY: Not Interested]');
  assert.equal(sendSuppressionReason(staffing({ notes: '' }), { suppressedEmails: new Set(['owner@harbourstaffing.test']) }), 'suppression-list');
  const unsub = staffing({ notes: '[REPLY: Unsubscribed]', stage: 'Unsub', emailStatus: 'done' });
  assert.equal(sendSuppressionReason(unsub, { suppressedEmails: new Set() }), '[REPLY: Unsubscribed]');
  assert.notEqual(terminalIntentFromText('Not interested').crmStage, 'Unsub');
  assert.equal(terminalIntentFromText('Not interested').crmStage, 'Done');
  const safety = evaluateFreshSendSafety(
    staffing({ emailStatus: 'emailed', emailStep: '1' }),
    lead,
    new Set(['owner@harbourstaffing.test']),
    { purpose: 'cold' },
  );
  assert.equal(safety.allowed, false);
  assert.equal(preview('not right now').suppression, null);
  assert.equal(preview('automatic reply').classification, 'OUT_OF_OFFICE');
});

test('Fix 8: the same inbound message does not call the model on later CHECK_ONLY ticks', async () => {
  const messageId = 'm-ambiguous';
  const activities = [{
    eventId: `gmail-evaluated:primary:${messageId}`,
    eventType: 'gmail_reply_evaluated',
    metadata: JSON.stringify({ sourceEventId: `gmail-reply:${messageId}`, gmailMessageId: messageId }),
  }];
  assert.equal(inboundAlreadyEvaluated(activities, messageId), true);
  assert.equal(shouldCallReplyModel({ text: 'hmm maybe idk', alreadyEvaluated: true }), false);
  let modelCalls = 0;
  const first = await classifyReply({
    plainTextReply: 'hmm maybe idk',
    createMessage: async () => { modelCalls += 1; return { content: [{ text: 'NEEDS_HUMAN' }] }; },
  });
  assert.equal(first, 'NEEDS_HUMAN');
  assert.equal(modelCalls, 1);
  const second = await classifyReply({
    plainTextReply: 'hmm maybe idk', alreadyEvaluated: true, priorClassification: 'NEEDS_HUMAN',
    createMessage: async () => { modelCalls += 1; return { content: [{ text: 'INTERESTED' }] }; },
  });
  assert.equal(second, 'NEEDS_HUMAN');
  assert.equal(modelCalls, 1);
});

test('qualification flow is preserved and dental INTERESTED is unchanged', () => {
  const interested = preview('Interested');
  assert.equal(interested.body, STAFFING_QUALIFY_QUESTION);
  assert.equal(interested.booking, false);
  assert.equal(interested.landing, false);
  const info = preview('Send me some info');
  assert.equal(info.body, STAFFING_SEND_INFO_REPLY);
  assert.equal(info.landing, true);
  assert.equal(info.booking, false);
  const pending = staffing({ notes: `${STAFFING_NOTE.QUALIFY_ASKED} [REPLY: Interested]` });
  const qualified = overlayStaffingReplyClassification({
    text: 'We place welders and machinists for manufacturers around Houston',
    lead: pending, classification: 'NEEDS_HUMAN',
    canonical: classifyReplyText('We place welders and machinists for manufacturers around Houston'),
  });
  const decision = decideReplyResponse({
    classification: qualified.classification, canonical: qualified.canonical, confidence: qualified.confidence,
    offer: offerForLead(pending), text: 'We place welders and machinists for manufacturers around Houston',
    family: 'industrial_staffing', qualificationFit: qualified.fit,
  });
  assert.equal(decision.action, ACTION.AUTO_STAFFING_QUALIFIED);
  const body = warmResponse({ action: decision.action, lead: pending, offer: offerForLead(pending) });
  assert.ok(body.includes(STAFFING_LANDING_PAGE_URL));
  assert.ok(body.includes(BOOKING_URL));
  const withoutPending = preview('We place welders and machinists for manufacturers around Houston');
  assert.notEqual(withoutPending.classification, 'STAFFING_QUALIFICATION');
  assert.equal(withoutPending.autoSend, false);

  const dentalDecision = decideReplyResponse({
    classification: 'INTERESTED',
    canonical: { state: 'positive', confidence: 'high', signals: ['expressed_interest'] },
    offer: offerForLead(dental()), text: 'Interested', family: 'dental_ai_receptionist',
  });
  assert.equal(dentalDecision.action, ACTION.AUTO_BOOKING_RESPONSE);
});

test('Fix 10A/10B/10C: offer-scoped booking fallback, pricing fail-closed, List-Unsubscribe mailto only', () => {
  assert.equal(bookingUrlForFamily('industrial_staffing', {}), BOOKING_URL);
  assert.equal(bookingUrlForFamily('industrial_staffing', { STAFFING_BOOKING_URL: 'https://calendar.app.google/staffing-only' }),
    'https://calendar.app.google/staffing-only');
  assert.equal(bookingUrlForFamily('dental_ai_receptionist', { STAFFING_BOOKING_URL: 'https://calendar.app.google/staffing-only' }), BOOKING_URL);
  assert.deepEqual(parsePricing('', {}), {});
  const pricing = decideReplyResponse({
    classification: 'QUESTION', text: 'How much does this cost?',
    offer: offerForLead(staffing()), family: 'industrial_staffing',
  });
  assert.equal(pricing.action, ACTION.HUMAN_REVIEW);
  const headers = commercialListUnsubscribeHeaders({ fromEmail: 'deins@scalelabai.ca', campaignRef: 'SA-48271' });
  assert.equal(headers.length, 1);
  assert.match(headers[0], /^List-Unsubscribe: <mailto:deins@scalelabai\.ca\?/);
  assert.equal(headers.some(h => /List-Unsubscribe-Post/i.test(h)), false);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /commercialListUnsubscribeHeaders/);
  assert.match(agent, /gmail_cold_step/);
});

test('Fix 10E: funnel keys cover the staffing reply lifecycle without duplicating send types', () => {
  assert.equal(staffingFunnelFromSend({ step: 1, family: 'industrial_staffing' }), STAFFING_FUNNEL.EMAIL_1_SENT);
  assert.equal(staffingFunnelFromSend({ step: 2, family: 'industrial_staffing' }), STAFFING_FUNNEL.EMAIL_2_SENT);
  assert.equal(staffingFunnelFromSend({ step: 3, family: 'industrial_staffing' }), STAFFING_FUNNEL.EMAIL_3_SENT);
  assert.equal(staffingFunnelFromReply({ classification: 'INTERESTED', family: 'industrial_staffing' }), STAFFING_FUNNEL.INTERESTED_RECEIVED);
  assert.equal(staffingFunnelFromReply({ classification: 'ALREADY_HANDLED', family: 'industrial_staffing' }), STAFFING_FUNNEL.ALREADY_HANDLED);
  const counts = countStaffingFunnel([
    { eventType: 'initial_email_sent', metadata: JSON.stringify({ staffingFunnel: STAFFING_FUNNEL.EMAIL_1_SENT }) },
    { eventType: 'call_booked', metadata: JSON.stringify({ campaignFamily: 'industrial_staffing' }) },
  ]);
  assert.equal(counts[STAFFING_FUNNEL.EMAIL_1_SENT], 1);
  assert.equal(counts[STAFFING_FUNNEL.MEETING_BOOKED], 1);
});

test('existing-provider replies are not INTERESTED just because they mention BD', () => {
  const blocked = classifyStaffingReply('Our BD team handles employer acquisition', staffing());
  assert.equal(blocked.promote, false);
  const result = preview('Our BD team handles employer acquisition');
  assert.equal(result.classification, 'ALREADY_HANDLED');
  assert.equal(result.autoSend, false);
  assert.equal(result.booking, false);
});
