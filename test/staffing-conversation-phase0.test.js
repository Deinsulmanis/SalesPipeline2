'use strict';

// Phase 0 of the staffing conversation work: four deterministic fixes to the
// production reply path. No agent redesign; every fix only narrows what
// automation may send.
//
//   1. a staffing reply the conversation already had is not sent again
//   2. a manual human reply holds automated staffing replies
//   3. model-written staffing answers are drafts, never auto-sent
//   4. the staffing booking snippet uses staffing wording

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { offerForLead } = require('../integrations/offer-config');
const { ACTION, decideReplyResponse, numericConfidence } = require('../integrations/reply-response-policy');
const { classifyReplyText } = require('../integrations/canonical-reply');
const { deterministicReplyCategory, classifyReplyDetailed } = require('../integrations/reply-classifier');
const { interpretInboundReply, ROUTE } = require('../integrations/reply-decision');
const { deriveAutomationOwnership, OWNER } = require('../integrations/automation-ownership');
const { BOOKING_URL, bookingSnippet, pricingDeflection } = require('../booking');
const { factsForLead } = require('../product-facts');
const {
  overlayStaffingReplyClassification, STAFFING_NOTE,
  staffingReplyHistory, staffingRepeatReason, staffingHumanTouchBlock,
} = require('../integrations/staffing-reply-policy');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agent = readSource(path.join(root, 'outreach-agent.js'));
const between = (start, end) => {
  const from = agent.indexOf(start);
  const to = agent.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `source markers not found: ${start} … ${end}`);
  return agent.slice(from, to);
};

const staffing = (over = {}) => ({
  id: 'S1', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing',
  contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary',
  stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: '', ...over,
});
const dental = (over = {}) => ({
  id: 'D1', email: 'front@clinic.test', company: 'Harbour Dental',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', campaign: 'Dental V3',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', ...over,
});

const QUALIFIED_NOTES = [STAFFING_NOTE.QUALIFIED, STAFFING_NOTE.QUALIFY_RECEIVED, STAFFING_NOTE.QUALIFY_ASKED].join(' ');
const INFO_SENT_NOTES = [STAFFING_NOTE.INFO_SENT, STAFFING_NOTE.QUALIFY_ASKED].join(' ');

const delivered = (lead, action, at = '2026-09-20T15:00:00.000Z') => ({
  eventId: `reply-action:${action}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'booking_link_sent', occurredAt: at,
  metadata: JSON.stringify({ action, inboundMessageId: 'earlier-inbound' }),
});
const humanReply = (lead, at = '2026-09-21T16:00:00.000Z') => ({
  eventId: `gmail-outbound:${lead.id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'human_response_sent', occurredAt: at, content: '',
  metadata: JSON.stringify({ actor: 'human', isResponseToInbound: true }),
});

// The production sequence in handlePositiveAutomation, from the same pure
// pieces: rule classification, staffing overlay, reply policy, repeat veto.
function staffingPolicy(text, lead, activities = []) {
  const canonical = classifyReplyText(text, { currentEmail: lead.email });
  const upstream = deterministicReplyCategory(text, { currentEmail: lead.email }) || 'NEEDS_HUMAN';
  const overlay = overlayStaffingReplyClassification({ text, lead, classification: upstream, canonical });
  const classification = overlay.classification || upstream;
  const effective = overlay.canonical || canonical;
  const policy = decideReplyResponse({
    classification, canonical: effective,
    confidence: overlay.confidence || numericConfidence({ classification, canonical: effective }),
    offer: offerForLead(lead), text, family: 'industrial_staffing', qualificationFit: overlay.fit || '',
  });
  const repeated = policy.send ? staffingRepeatReason(policy.action, staffingReplyHistory({ lead, activities })) : '';
  return {
    decided: policy,
    final: repeated ? { ...policy, action: ACTION.HUMAN_REVIEW, send: false, reason: repeated } : policy,
    repeated,
  };
}

// ── 1. conversation state ─────────────────────────────────────────────────

test('already-qualified + positive follow-up does not re-ask qualification', () => {
  const lead = staffing({ notes: QUALIFIED_NOTES });
  for (const text of ['Sounds good, thanks', 'I am interested, will look at the link this week']) {
    const out = staffingPolicy(text, lead);
    // The reply policy alone would ask the qualification question again…
    assert.equal(out.decided.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, text);
    // …and the conversation state stops it: a person reviews instead.
    assert.equal(out.final.action, ACTION.HUMAN_REVIEW, text);
    assert.equal(out.final.send, false, text);
    assert.match(out.repeated, /already qualified/);
  }
});

test('a delivered qualified reply proves qualification even if the notes tag was lost', () => {
  const lead = staffing({ notes: '' });
  const ledger = [delivered(lead, ACTION.AUTO_STAFFING_QUALIFIED)];
  assert.deepEqual(staffingReplyHistory({ lead, activities: ledger }),
    { qualifyAsked: false, qualified: true, infoSent: true });
  const out = staffingPolicy('Sounds good, thanks', lead, ledger);
  assert.equal(out.final.action, ACTION.HUMAN_REVIEW);
  // Another lead's delivered reply is not this conversation.
  assert.deepEqual(staffingReplyHistory({ lead, activities: [delivered(staffing({ id: 'S2', email: 'x@other.test' }),
    ACTION.AUTO_STAFFING_QUALIFIED)] }), { qualifyAsked: false, qualified: false, infoSent: false });
});

test('a question already asked is not asked again even when its tag is missing', () => {
  const lead = staffing({ notes: '' });
  const ledger = [delivered(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION)];
  const out = staffingPolicy("I'm interested", lead, ledger);
  assert.equal(out.decided.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(out.final.action, ACTION.HUMAN_REVIEW);
  assert.match(out.repeated, /already asked/);
});

test('info-already-sent + "send more info" does not resend the same info', () => {
  const byTag = staffing({ notes: INFO_SENT_NOTES });
  const byLedger = staffing({ notes: '' });
  for (const [lead, ledger] of [[byTag, []], [byLedger, [delivered(byLedger, ACTION.AUTO_STAFFING_SEND_INFO)]]]) {
    for (const text of ['Can you send me more info?', 'Send me some info']) {
      const out = staffingPolicy(text, lead, ledger);
      assert.equal(out.decided.action, ACTION.AUTO_STAFFING_SEND_INFO, text);
      assert.equal(out.final.action, ACTION.HUMAN_REVIEW, text);
      assert.equal(out.final.send, false, text);
      assert.match(out.repeated, /information was already sent/);
    }
  }
  // The qualified reply carried the landing page, so it counts as info sent.
  assert.equal(staffingPolicy('Send me some info', staffing({ notes: QUALIFIED_NOTES })).final.send, false);
});

test('the first-time staffing flow still sends: interest, info, then qualified booking', () => {
  const fresh = staffing();
  assert.equal(staffingPolicy("I'm interested", fresh).final.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(staffingPolicy('Send me some info', fresh).final.action, ACTION.AUTO_STAFFING_SEND_INFO);
  // After info (which asks the roles question) a clear market answer books.
  const answered = staffingPolicy('We place welders and fabricators around Houston',
    staffing({ notes: INFO_SENT_NOTES }), [delivered(fresh, ACTION.AUTO_STAFFING_SEND_INFO)]);
  assert.equal(answered.final.action, ACTION.AUTO_STAFFING_QUALIFIED);
  assert.equal(answered.final.send, true);
  assert.equal(answered.repeated, '');
  // Non-staffing actions are never touched by the staffing repeat rule.
  for (const action of [ACTION.AUTO_BOOKING_RESPONSE, ACTION.AUTO_MEETING_RESPONSE, ACTION.AUTO_QUESTION_RESPONSE]) {
    assert.equal(staffingRepeatReason(action, { qualifyAsked: true, qualified: true, infoSent: true }), '');
  }
});

test('the repeat rule is applied to the policy before it is recorded or executed', () => {
  const fn = between('async function handlePositiveAutomation', 'async function handleTimingReply');
  const decide = fn.indexOf('decideReplyResponse({');
  const veto = fn.indexOf('staffingRepeatReason(policy.action, staffingReplyHistory({ lead, activities }))');
  const record = fn.indexOf('recordReplyPolicy(decision, {', veto);
  const gate = fn.indexOf('if (!policy.send) {');
  assert.ok(decide > 0 && veto > decide && record > veto && gate > record);
  assert.match(fn, /if \(repeated\) policy = \{ \.\.\.policy, action: REPLY_RESPONSE_ACTION\.HUMAN_REVIEW, send: false, reason: repeated \}/);
  assert.match(fn, /source: repeated \? REPLY_POLICY_SOURCE\.STAFFING_GUARD : REPLY_POLICY_SOURCE\.REPLY_RESPONSE_POLICY/);
});

// ── 2. human ownership ────────────────────────────────────────────────────

test('a prior human reply prevents staffing automation from competing', () => {
  const lead = staffing();
  const held = staffingHumanTouchBlock({ lead, activities: [humanReply(lead)], outboundObservationOk: true });
  assert.equal(held.code, 'human_response_observed');
  assert.match(held.reason, /2026-09-21T16:00:00\.000Z/);
  // Scoped to this lead: someone else's manual reply does not hold it.
  const other = staffing({ id: 'S2', email: 'ops@other.test' });
  assert.equal(staffingHumanTouchBlock({ lead, activities: [humanReply(other)], outboundObservationOk: true }), null);
  assert.equal(staffingHumanTouchBlock({ lead, activities: [], outboundObservationOk: true }), null);
  // A stale outbound observation cannot prove there was no manual reply.
  assert.equal(staffingHumanTouchBlock({ lead, activities: [], outboundObservationOk: false }).code,
    'outbound_observation_failed');
  assert.equal(staffingHumanTouchBlock({ lead, activities: [] }).code, 'outbound_observation_failed',
    'an omitted observation verdict fails closed');
});

test('the staffing hold runs before delivery and drafts instead of sending', () => {
  const fn = between('async function handlePositiveAutomation', 'async function handleTimingReply');
  assert.match(fn, /outboundObservationOk = false \} = \{\}\) \{/);
  const already = fn.indexOf('if (inboundWarmReplyAlreadySent(activities, message.messageId))');
  const hold = fn.indexOf('staffingHumanTouchBlock({ lead, activities, outboundObservationOk })');
  const send = fn.indexOf('await deliverHardenedWarmReply(');
  assert.ok(already > 0 && hold > already && send > hold);
  assert.match(fn, /const humanHold = isStaffingReplyContext\(\{ family: familyForLead\(lead\), offer \}\)/);
  const branch = fn.slice(fn.indexOf('if (humanHold) {'), send);
  assert.match(branch, /await queueDraft\(lead, \{/);
  assert.match(branch, /await handleNeedsHuman\(lead, message\.fromAddr\)/);
  assert.match(branch, /status: REPLY_EXECUTION_STATUS\.BLOCKED, code: humanHold\.code/);
  assert.match(branch, /fallbackAction: REPLY_RESPONSE_ACTION\.HUMAN_REVIEW/);
  assert.match(branch, /return \{ delivered: false, code: humanHold\.code/);
  assert.doesNotMatch(branch, /deliverHardenedWarmReply|sendEmail|deliverProspectReply/);
  // Exactly one send path remains, through the hardened warm delivery.
  assert.equal((fn.match(/deliverHardenedWarmReply\(/g) || []).length, 1);
  assert.doesNotMatch(fn, /sendEmail\(/);
});

test('every staffing positive path receives the outbound observation verdict', () => {
  assert.match(agent, /const decisionOptions = \{ decision: replyDecision, overlay: staffingOverlay, outboundObservationOk \};/);
  const calls = [...agent.matchAll(/(?<!function )handlePositiveAutomation\(([^;]*?)\);/gs)].map(m => m[1]);
  assert.equal(calls.length, 4);
  for (const args of calls) assert.match(args, /decisionOptions|outboundObservationOk \}/, args);
  const question = between('async function handleQuestion', 'async function handleNeedsHuman');
  assert.match(question, /\{ decision, overlay, outboundObservationOk \}/);
});

// ── 3. staffing answers are drafts ────────────────────────────────────────

test('staffing question answering produces a draft, never a model-written auto-send', () => {
  const scoped = factsForLead(staffing());
  assert.equal(scoped.ok, true);
  assert.equal(scoped.draftOnlyModelAnswers, true);
  // Dental keeps its existing grounded auto-answer.
  assert.ok(!factsForLead(dental()).draftOnlyModelAnswers);

  const fn = between('async function answerQuestion', '// Answer + the warm booking snippet');
  const autos = [...fn.matchAll(/mode: 'auto'/g)].map(m => m.index);
  assert.equal(autos.length, 2, 'approved pricing and the model answer are the only auto returns');
  // The first is approved pricing wording — configuration, not model text.
  assert.match(fn.slice(autos[0], autos[0] + 200), /warmResponse\(\{ action: REPLY_RESPONSE_ACTION\.AUTO_PRICING_RESPONSE/);
  // The model answer can only become 'auto' after the draft-only check.
  const draftOnly = fn.indexOf('if (scoped.draftOnlyModelAnswers) {');
  assert.ok(draftOnly > fn.indexOf('const answer = String(parsed.answer'), 'checked after the model answers');
  assert.ok(draftOnly < autos[1], 'checked before the model answer can auto-send');
  assert.match(fn.slice(draftOnly, autos[1]), /return draft\(withBooking\(answer, company, scoped\), `model-written answer drafted for review/);

  // A drafted answer is a HUMAN_REVIEW policy in handleQuestion.
  const question = between('async function handleQuestion', 'async function handleNeedsHuman');
  assert.match(question, /action: answer\.mode === 'auto' \? answerAction : REPLY_RESPONSE_ACTION\.HUMAN_REVIEW/);
  assert.match(question, /send: answer\.mode === 'auto'/);
});

// ── 4. staffing booking wording ───────────────────────────────────────────

const NON_STAFFING = /receptionist|missed calls?|dental|patients?|clinic|\bcatch\b|set up for you|handles calls/i;

test('booking copy contains staffing-specific wording and no missed-call or receptionist wording', () => {
  const snippet = bookingSnippet('Harbour Staffing', { family: 'industrial_staffing', companyFallback: 'your agency' });
  assert.equal(snippet,
    `If it's useful, you can grab 15 minutes here and I'll walk you through how the employer acquisition pilot would work for Harbour Staffing:\n${BOOKING_URL}`);
  assert.doesNotMatch(snippet, NON_STAFFING);
  assert.match(bookingSnippet('', { family: 'industrial_staffing' }), /for your agency:/);
  const pricing = pricingDeflection('Harbour Staffing', { family: 'industrial_staffing', companyFallback: 'your agency' });
  assert.match(pricing, /employer acquisition pilot/);
  assert.doesNotMatch(pricing, NON_STAFFING);

  // Dental wording is byte-for-byte unchanged.
  assert.equal(bookingSnippet('Harbour Dental', {}),
    `Grab a quick 15 min here and I'll show you exactly what it'd catch for Harbour Dental — and get it set up for you:\n${BOOKING_URL}`);

  // Every snippet the answerer builds names the offer family.
  const fn = between('async function answerQuestion', 'async function ensureAgentHeaders');
  const snippets = [...fn.matchAll(/bookingSnippet\(company, \{([^}]*)\}\)/g)].map(m => m[1]);
  assert.ok(snippets.length >= 5);
  for (const opts of snippets) assert.match(opts, /family: scoped\.family/, opts);
});

// ── unchanged behaviour ───────────────────────────────────────────────────

test('Not Interested, Unsubscribe and OOO behaviour is unchanged', async () => {
  // The states the new guards react to — qualified, info sent, a human reply —
  // do not change how an opt-out, rejection or autoresponder is routed.
  const lead = staffing({ notes: `${QUALIFIED_NOTES} ${STAFFING_NOTE.INFO_SENT}` });
  const cases = [
    ['Please unsubscribe me from this list.', ROUTE.UNSUBSCRIBE, ACTION.SUPPRESS],
    ['Not interested, thanks.', ROUTE.NOT_INTERESTED, ACTION.AUTO_NEGATIVE_CLOSE],
    ['I am out of the office until October 3 with limited access to email.', ROUTE.OUT_OF_OFFICE, ACTION.WAIT_OUT_OF_OFFICE],
  ];
  for (const [text, route, action] of cases) {
    const { decision } = await interpretInboundReply({
      lead, message: { messageId: `m-${route}`, threadId: 't1', subject: 'Re: employer accounts' },
      replyText: text, ruleCanonical: classifyReplyText(text, { currentEmail: lead.email }), maySend: true,
      ruleCategory: deterministicReplyCategory,
      classify: () => classifyReplyDetailed({ plainTextReply: text, lead, apiKey: '' }),
    });
    assert.equal(decision.route, route, text);
    assert.equal(decision.policyAction, action, text);
    assert.equal(decision.policySend, false, text);
    assert.equal(staffingRepeatReason(action, staffingReplyHistory({ lead, activities: [humanReply(lead)] })), '');
  }
  // Those routes never reach the positive automation path.
  const pass = between('async function runReplyCheckPass', 'async function commitMailboxObservationCheckpoints');
  assert.match(pass, /case REPLY_ROUTE\.UNSUBSCRIBE: result = await handleUnsubscribe\(lead\); break;/);
  assert.match(pass, /case REPLY_ROUTE\.NOT_INTERESTED: result = await handleNotInterested\(lead\); break;/);
  assert.match(pass, /case REPLY_ROUTE\.OUT_OF_OFFICE:\n\s+result = await handleOutOfOffice\(/);
});

test('booking-link send gates remain unchanged', () => {
  const deliver = between('async function deliverHardenedWarmReply', 'async function handlePositiveAutomation');
  const gates = [
    "if (staffingSendBlockReason(lead)) return { allowed: false, code: 'staffing_launch_paused' }",
    'const auth = sendAuthorization();',
    "if (observerAutomationReadyBySender.get(sender.id) !== true) return { allowed: false, code: 'observer_not_incremental' }",
    "const safety = evaluateFreshSendSafety(lead, current, suppressed, { purpose: 'warm' });",
    "if (String(current.notes || '').includes('[MANUAL HOLD]')) return { allowed: false, code: 'manual_hold' }",
    "if (freshSender !== sender.id) return { allowed: false, code: 'sender_changed' }",
    "return { allowed: false, code: 'meeting_booked' }",
    "if (booked) return { allowed: false, code: 'meeting_booked_live' }",
    "const expectedOwner = ownerMode === 'cold' ? 'cold_automation' : 'reply_automation';",
    "if (senderCount >= sender.dailyLimit) return { allowed: false, code: 'sender_quota' }",
    "return { allowed: false, code: 'global_quota' }",
    "if (!window.allowed) return { allowed: false, code: 'window_quota', reason: window.reason }",
    "return latest?.id === inboundMessageId ? { ok: true } : { ok: false, reason: 'newer thread activity appeared before send' }",
  ];
  let at = 0;
  for (const gate of gates) {
    const index = deliver.indexOf(gate, at);
    assert.ok(index >= 0, `gate missing or reordered: ${gate}`);
    at = index;
  }
  // The new hold lives in the staffing handler, not in the shared gate.
  assert.doesNotMatch(deliver, /staffingHumanTouchBlock|staffingRepeatReason/);

  // Ownership still grants reply automation only below the stronger gates.
  const base = { boardLead: { stage: 'hot' }, sendingEnabled: true, activities: [],
    replyResponseDecision: { send: true, action: ACTION.AUTO_STAFFING_QUALIFIED } };
  const lead = staffing();
  assert.equal(deriveAutomationOwnership(lead, { ...base, suppressionReason: () => null }).owner, OWNER.REPLY_AUTOMATION);
  assert.equal(deriveAutomationOwnership({ ...lead, notes: '[MANUAL HOLD]' }, base).owner, OWNER.NONE);
  assert.equal(deriveAutomationOwnership(lead, { ...base, callState: { status: 'scheduled' } }).owner, OWNER.MEETING);
  assert.equal(deriveAutomationOwnership(lead, { ...base, suppressionReason: () => '[REPLY: Unsubscribed]' }).owner, OWNER.NONE);
});
