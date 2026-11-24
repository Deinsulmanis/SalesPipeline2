'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { resolveLeadClient } = require('./clients/ownership');
const { classifyReplyText, REPLY_STATE } = require('./canonical-reply');
const { stripQuotedReply, scrubOwnOutboundCopy } = require('./reply-reconciliation');
const { INTENT: SAMPLE_LIST_INTENT, SAMPLE_OFFER, detectSampleListRequest } = require('./scalelab-sample-list');

const VERSION = 'scalelab_reply_v1';
const SCOPE = 'scalelab';
const INTENTS = Object.freeze([
  'opt_out', 'delivery_failure', 'calendar_notice', 'automated_acknowledgment', 'out_of_office',
  'contact_change', 'explicit_rejection', 'reverse_pitch', 'meeting_request', 'reschedule_request',
  'pricing_request', 'information_request', 'interest', 'future_contact', 'objection', 'referral',
  'acknowledgment', 'unclear', SAMPLE_LIST_INTENT,
]);
const skillPath = join(__dirname, '..', 'docs', 'skills', 'scalelab-response-classification', 'SKILL.md');
const loadClassificationSkill = () => readFileSync(skillPath, 'utf8');

function scaleLabOwner(lead) {
  const owner = resolveLeadClient(lead);
  return lead?.clientId === SCOPE && owner.ok && owner.clientId === SCOPE && owner.source === 'explicit';
}

function verifiedContext(activities, { leadId, threadId, senderInboxId, messageId, occurredAt }) {
  const at = Date.parse(occurredAt);
  if (!leadId || !threadId || !senderInboxId || !Number.isFinite(at)) return [];
  return activities.flatMap(row => {
    if (row.sourceLeadId !== leadId || Date.parse(row.occurredAt) >= at) return [];
    if (!Number.isFinite(Date.parse(row.occurredAt))) return [];
    let meta;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (meta.gmailThreadId !== threadId || meta.senderInboxId !== senderInboxId
        || (meta.clientId && meta.clientId !== SCOPE) || meta.gmailMessageId === messageId) return [];
    if (!['human_response_sent', 'initial_email_sent', 'follow_up_sent'].includes(row.eventType)
        && !String(row.eventId).startsWith('gmail-reply:')) return [];
    const actor = row.eventId.startsWith('gmail-reply:') ? 'prospect' : 'scalelab';
    const text = stripQuotedReply(row.content || '');
    // The offer can sit past the 500-character excerpt, so it is flagged
    // from the full text of our own turn.
    return [{ id: row.eventId, at: row.occurredAt, actor, text: text.slice(0, 500),
      ...(actor === 'scalelab' && SAMPLE_OFFER.test(text) ? { offersSampleList: true } : {}) }];
  }).sort((a, b) => a.at.localeCompare(b.at)).slice(-4);
}

function classifyScaleLabReply({ text = '', subject = '', autoSubmitted = '', delivery = false,
  currentEmail = '', occurredAt, context = [] } = {}) {
  const own = scrubOwnOutboundCopy(stripQuotedReply(String(text)));
  const body = own.trim();
  const head = body.split(/\r?\n/).find(line => line.trim())?.trim() || '';
  const machine = /^(?:auto-replied|auto-generated)$/i.test(autoSubmitted);
  const legacy = classifyReplyText(body, { subject, currentEmail, now: occurredAt });
  const result = (intent, reason, extra = {}) => ({
    version: VERSION, intent, reason, evidenceRefs: context.map(turn => turn.id).filter(Boolean),
    revisitDate: legacy.revisitDate || null, returnDate: legacy.returnDate || null,
    confidence: intent === 'unclear' ? 'low' : 'high', ...extra,
  });
  if (delivery || (/^(?:undelivered mail|delivery status notification|mail delivery fail|undeliverable)/i.test(subject)
    && /could not be delivered|recipient address rejected|\b[45]\.[0-9]+\.[0-9]+\b/i.test(body))) {
    return result('delivery_failure', 'provider_delivery_evidence');
  }
  if (/^(?:accepted|declined|tentative|new time proposed|updated invitation|canceled|cancelled):\s/i.test(subject)
    && (/auto-generated|auto-replied/i.test(autoSubmitted) || /invitation|discovery call|meeting/i.test(subject))) {
    return result('calendar_notice', 'calendar_notification');
  }
  // Require an actual opt-out. "Stop by", "stop at", quoted copy and
  // footer instructions must never create an unsubscribe by themselves.
  const appleOptOut = machine && /^unsubscribe$/i.test(subject.trim())
    && /^unsubscribe\s+SA-\d+$/i.test(head) && /Apple Mail sent this email to unsubscribe/i.test(body);
  if (/^(?:stop|unsubscribe)[.!\s]*$/i.test(head)
    || /^(?:stop|unsubscribe)[.!]?\s+(?:regards|best regards|thanks|thank you|kind regards)[,!.\s]/i.test(body)
    || appleOptOut || (!machine && legacy.reason === 'unsubscribe_request')) return result('opt_out', 'explicit_opt_out');
  if (/réponse automatique|respuesta automática|risposta automatica|automatische antwort/i.test(subject)
      && /(?:^|[^\p{L}])(?:congé|absence|ausente|vacaciones|abwesend|assen[tz]e?)(?!\p{L})/iu.test(body)) {
    return result('out_of_office', 'localized_absence');
  }
  if (legacy.state === REPLY_STATE.AUTOMATED_REPLY) {
    if (legacy.subtype === 'mailbox_migration') return result('contact_change', 'automated_contact_change');
    if (legacy.subtype === 'autoresponder') return result('automated_acknowledgment', 'automated_acknowledgment');
    return result('out_of_office', 'automated_absence');
  }
  if (machine) return result('automated_acknowledgment', 'auto_submitted_header');
  if (legacy.reason === 'explicit_rejection' || /\b(?:i(?:’|')?m|we(?:’|')?re|i am|we are)\s+go(?:ing|in)?\s+(?:to\s+)?pass on (?:your|the) (?:services|offer)\b/i.test(body)
      || /\b(?:will|going (?:to|o)) pass on (?:your|the) (?:services|offer)\b/i.test(body)) {
    return result('explicit_rejection', 'prospect_declined');
  }
  if (/\b(?:we also do|use our services|i can get you a great rate|we can set up a consultation)\b/i.test(body)
    && /\b(?:our services|we also do|we can set up a consultation)\b/i.test(body)) {
    return result('reverse_pitch', 'prospect_offers_own_services');
  }
  if (legacy.revisitDate) return result('future_contact', 'prospect_stated_recontact_date');
  // A clear yes to our sample-list offer. Mixed or conditional replies fall
  // through to the existing intents and stay with the owner.
  const sample = detectSampleListRequest(body, context);
  if (sample.match) return result(SAMPLE_LIST_INTENT, sample.reason);
  if (/\b(?:reschedule|move (?:the|our) (?:call|meeting))\b/i.test(body)
    || (/\b(?:can we|could we|how about)\b.{0,60}\b\d{1,2}:\d{2}\b/i.test(body)
      && context.some(turn => /\b(?:time|reschedule|call|meeting)\b/i.test(turn.text)))) {
    return result('reschedule_request', 'meeting_change_requested');
  }
  if (/\b(?:can you call me|would you call me|can we (?:hop on|schedule|meet)|let.s (?:book|schedule))\b/i.test(body)
    || legacy.signals?.includes('meeting')) return result('meeting_request', 'explicit_meeting_intent');
  if (legacy.reason === 'forwarded_to_decision_maker' || legacy.reason === 'decision_maker_contact_supplied') {
    return result('referral', 'decision_maker_referral');
  }
  if (legacy.state === REPLY_STATE.CONTACT_CHANGE_REVIEW) return result('contact_change', 'contact_change');
  if (/\b(?:pricing|rate sheet|meeting fees|cost per meeting|how much|your (?:rate|fees?))\b/i.test(body)) {
    return result('pricing_request', 'pricing_question');
  }
  if (/\b(?:send (?:me |us )?(?:some |more )?(?:info|information)|(?:would )?like more info|how does (?:this|it) work)\b/i.test(body)) {
    return result('information_request', 'requested_information');
  }
  if (legacy.state === REPLY_STATE.POSITIVE) return result('interest', 'commercial_interest');
  if (legacy.reason === 'already_handled' || legacy.reason === 'question_or_objection') return result('objection', legacy.reason);
  if (/^(?:yes[.!]?|thank you[!.]?|thanks[!.]?|that.s perfect[!.]?)$/i.test(head)) {
    return result('acknowledgment', 'short_acknowledgment', { confidence: 'low' });
  }
  return result('unclear', 'human_review');
}

function observationForIntent(verdict, base) {
  // Unresolved human inbound owns the conversation and blocks cold cadence
  // even if its model evaluation never finishes.
  if (verdict.requiresModel) return { ...base, state: REPLY_STATE.NEEDS_HUMAN,
    reason: 'scalelab_interpretation_pending', genuineHuman: true, subtype: null,
    confidence: 'low', classifierVersion: VERSION };
  const changes = {
    opt_out: [REPLY_STATE.NEGATIVE, 'unsubscribe_request', true],
    explicit_rejection: [REPLY_STATE.NEGATIVE, 'explicit_rejection', true],
    automated_acknowledgment: [REPLY_STATE.AUTOMATED_REPLY, null, false, 'autoresponder'],
    out_of_office: [REPLY_STATE.AUTOMATED_REPLY, null, false, 'out_of_office'],
    calendar_notice: [REPLY_STATE.AUTOMATED_REPLY, null, false, 'calendar_notice'],
    reverse_pitch: [REPLY_STATE.NEEDS_HUMAN, 'reverse_pitch', true],
    meeting_request: [REPLY_STATE.POSITIVE, 'explicit_evaluation_intent', true],
    reschedule_request: [REPLY_STATE.NEEDS_HUMAN, 'reschedule_request', true],
    [SAMPLE_LIST_INTENT]: [REPLY_STATE.NEEDS_HUMAN, SAMPLE_LIST_INTENT, true],
  }[verdict.intent];
  if (!changes) return base;
  const [state, reason, genuineHuman, subtype] = changes;
  return { ...base, state, reason, genuineHuman, subtype: subtype || null, classifierVersion: VERSION };
}

module.exports = { SCOPE, VERSION, INTENTS, loadClassificationSkill, scaleLabOwner, verifiedContext,
  classifyScaleLabReply, observationForIntent };
