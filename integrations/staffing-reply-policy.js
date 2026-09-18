'use strict';

const { CAMPAIGN_FAMILY, familyForLead, resolveLeadFamily } = require('./campaign-versions');
const { ACTION } = require('./reply-response-policy');
const { STAFFING_LANDING_PAGE_URL } = require('./staffing-campaign');

const CANDIDATE_SIDE_MARKERS = Object.freeze([
  ['looking_for_work', /\b(?:looking for (?:a )?job|i am (?:a )?(?:candidate|job seeker)|hire me|my resume|resume attached|i need (?:a )?job)\b/i],
  ['candidate_sourcing', /\b(?:need .{0,40}candidates|send .{0,40}candidates|fill (?:these|our) (?:roles|positions)|candidate sourcing|talent pool|recruit(?:ing|ers?) (?:help|software|for us)|looking for candidates)\b/i],
  ['job_seeker', /\b(?:apply(?:ing)? for (?:a )?(?:job|role)|i(?:'| a)m (?:a )?(?:welder|cdl driver|labourer|laborer))\b/i],
]);

const NOT_QUALIFIED_MARKERS = Object.freeze([
  ['already_have_bd', /\b(?:already have|already use|already doing).{0,60}(?:business development|biz dev|\bbd\b|sales (?:team|people)|outbound|employers?)\b/i],
  ['already_have_someone', /\bwe already have someone doing this\b/i],
  ['already_use_company', /\bwe already use another (?:company|vendor|provider|agency)\b/i],
  ['already_do_outbound', /\bwe already do outbound\b/i],
  ['internal_bd', /\b(?:we have an internal (?:sales|bd|business development) team|our (?:bd|sales|business development) team handles|internal (?:bd|sales) team)\b/i],
  ['in_house', /\bwe handle this in[- ]house\b/i],
  ['already_covered', /\bwe(?:'?ve| have) already got this covered\b/i],
  ['referral', /\b(?:i(?:'| a)m not the right person|talk to|speak (?:with|to)|you should speak with|send this to|contact).{0,40}(?:manager|colleague|someone else|other|vp|director|sarah|john|[A-Z][a-z]{1,30})\b|\bwrong person\b|\bnot (?:the right|my) (?:person|department)\b|\b[A-Z][a-z]{1,30} handles this\b/],
  ['vendor', /\b(?:are you hiring vendors?|partnership opportunity|we sell)\b/i],
]);

const EMPLOYER_SIDE_MARKERS = Object.freeze([
  ['employer_accounts', /\b(?:employer accounts?|new (?:clients?|accounts?)|client acquisition|business development|more employers?)\b/i],
  ['pilot', /\b(?:30[- ]day|employer acquisition pilot|qualified employer meetings?)\b/i],
]);

const STAFFING_INTEREST_MARKERS = Object.freeze([
  ['bare_interested', /^\s*(?:yes[,.]?\s+)?(?:i(?:['’]m| am)\s+|we(?:['’]re| are)\s+)?interested(?:\s+(?:please|in (?:this|it|learning more)))?[.!]?\s*$/i],
  ['im_interested', /\b(?:i am|i['’]m|we are|we['’]re)\s+(?:very\s+|quite\s+|really\s+)?interested\b/i],
  ['open_to_hearing', /\b(?:i['’]d be open to (?:hearing|learning|seeing)|(?:i['’]d|we['’]d) be open to it|open to (?:hearing|learning) about it)\b/i],
  ['tell_me_more', /\b(?:sure[,.]?\s+)?tell me more\b/i],
  ['sounds_good', /\b(?:sounds|looks) (?:good|great|interesting)\b/i],
]);

const STAFFING_SEND_INFO_MARKERS = Object.freeze([
  ['send_info', /\b(?:can you |could you |please )?send (?:me )?(?:some |more |the )?(?:info|information|details)\b/i],
  ['website', /\b(?:do you have |have you got |what(?:['’]s| is) your )?(?:a |your )?website\b/i],
  ['read_more', /\bwhere can i (?:read|learn|see|find) (?:more|about this|about it)\b/i],
  ['see_how', /\b(?:can i see how (?:it|this) works|how (?:does|would) (?:it|this) work|see how (?:it|this) works)\b/i],
]);

const STAFFING_MARKET_MARKERS = Object.freeze([
  ['role', /\b(?:welders?|welding|machinists?|cnc|millwrights?|fitters?|fabricators?|electricians?|plumbers?|pipefitters?|boilermakers?|labourers?|laborers?|forklift|warehouse(?:men| workers?)?|pickers?|packers?|cdl|drivers?|operators?|assemblers?|technicians?|skilled trades?|tradespeople|trades|maintenance techs?|apprentices?)\b/i],
  ['industry', /\b(?:manufactur(?:ing|ers?)|construction|logistics|warehous(?:e|ing)|industrial|oil(?:\s|&| and)?\s*gas|energy|mining|fabrication|production|heavy (?:industrial|equipment)|skilled trades)\b/i],
  ['employer_type', /\b(?:employer accounts?|employers?|manufacturers?|contractors?|plants?|warehouses?|facilities|shops?|mills?)\b/i],
  ['placement_phrase', /\b(?:we (?:place|staff|specialize in|serve|focus on)|looking (?:to bring in|for) more|primarily|mostly|mainly|roles? and industr)\b/i],
  ['geography', /\b(?:around|near|greater)\s+[A-Za-z][A-Za-z .'-]{2,40}\b|\b(?:houston|dallas|dfw|texas|alberta|calgary|edmonton|gta|midwest|gulf coast)\b/i],
]);

const STAFFING_NOTE = Object.freeze({
  QUALIFY_ASKED: '[STAFFING QUALIFY ASKED]',
  QUALIFY_RECEIVED: '[STAFFING QUALIFY RECEIVED]',
  QUALIFIED: '[STAFFING QUALIFIED]',
  QUALIFY_UNCLEAR: '[STAFFING QUALIFY UNCLEAR]',
  INFO_SENT: '[STAFFING INFO SENT]',
});

const STAFFING_CLARIFICATION = 'Just to clarify — we are not talking about candidate sourcing. We run a 30-day employer acquisition pilot: ScaleLab handles prospecting, outreach and qualification, then puts interested employers on the agency calendar. If we do not generate qualified employer meetings, there are no meeting fees.';

const STAFFING_QUALIFY_QUESTION = [
  'Absolutely — happy to explain.',
  '',
  'We handle employer prospecting, outreach, follow-up and qualification, then put qualified employer conversations directly on your calendar.',
  '',
  'What roles and industries are you primarily looking to bring in more employer accounts for?',
].join('\n');

const STAFFING_SEND_INFO_REPLY = [
  "Absolutely — here's a quick overview of how it works:",
  '',
  STAFFING_LANDING_PAGE_URL,
  '',
  "If it looks relevant, let me know what roles or industries you're trying to bring in more employer accounts for and I can show you how we'd approach that market.",
].join('\n');

function firstMatch(markers, text) {
  for (const [name, pattern] of markers) {
    if (pattern.test(text)) return name;
  }
  return '';
}

function classifyStaffingReply(text = '', lead = {}) {
  const family = familyForLead(lead);
  const body = String(text || '');
  if (family !== CAMPAIGN_FAMILY.STAFFING) {
    return { family, staffing: false, qualifiedEmployer: false, candidateSide: false };
  }
  const candidateSide = firstMatch(CANDIDATE_SIDE_MARKERS, body);
  const notQualified = firstMatch(NOT_QUALIFIED_MARKERS, body);
  const employerSide = firstMatch(EMPLOYER_SIDE_MARKERS, body);
  if (candidateSide && !employerSide) {
    return {
      family, staffing: true, candidateSide: true, qualifiedEmployer: false,
      signal: candidateSide, clarification: STAFFING_CLARIFICATION,
      action: ACTION.HUMAN_REVIEW, send: false, promote: false,
      reason: 'candidate-side or candidate-sourcing interest is not a qualified employer meeting',
    };
  }
  if (notQualified) {
    const referral = notQualified === 'referral';
    return {
      family, staffing: true, candidateSide: false, qualifiedEmployer: false,
      signal: notQualified, clarification: '',
      action: ACTION.HUMAN_REVIEW, send: false, promote: false,
      classification: referral ? 'WRONG_PERSON' : 'ALREADY_HANDLED',
      reason: referral
        ? 'wrong person or referral is not a qualified employer meeting'
        : 'existing business-development or unrelated request is not a qualified employer meeting',
    };
  }
  return {
    family, staffing: true, candidateSide: false, qualifiedEmployer: Boolean(employerSide),
    signal: employerSide || '', clarification: '',
  };
}

function unroutedReplyDecision(lead = {}) {
  const resolved = resolveLeadFamily(lead);
  if (resolved.confident && resolved.family !== CAMPAIGN_FAMILY.UNROUTED) return null;
  return {
    action: ACTION.HUMAN_REVIEW, send: false, promote: false,
    family: CAMPAIGN_FAMILY.UNROUTED, reason: resolved.reason || 'unknown niche requires routing review',
  };
}

function staffingConversationState(notes = '') {
  const text = String(notes || '');
  return {
    qualifyAsked: text.includes(STAFFING_NOTE.QUALIFY_ASKED),
    qualifyReceived: text.includes(STAFFING_NOTE.QUALIFY_RECEIVED),
    qualified: text.includes(STAFFING_NOTE.QUALIFIED),
    qualifyUnclear: text.includes(STAFFING_NOTE.QUALIFY_UNCLEAR),
    infoSent: text.includes(STAFFING_NOTE.INFO_SENT),
  };
}

function detectStaffingWarmIntent(text = '') {
  const body = String(text || '');
  if (!body.trim()) return '';
  if (firstMatch(STAFFING_SEND_INFO_MARKERS, body)) return 'SEND_INFO';
  if (firstMatch(STAFFING_INTEREST_MARKERS, body)) return 'INTERESTED';
  return '';
}

function hasStaffingMarketContext(text = '') {
  return Boolean(firstMatch(STAFFING_MARKET_MARKERS, String(text || '')));
}

function isVagueAck(text = '') {
  return /^(?:yes|ok|okay|sure|thanks|thank you|got it|sounds good|interested)[.!]?\s*$/i.test(String(text || '').trim());
}

function looksLikeDifferentSpeechAct(text = '') {
  const body = String(text || '');
  if (/\b(?:call me|email (?:john|me at)|who is this|wrong (?:email|number)|how much|what(?:['’]s| is) the (?:price|cost|fee))\b/i.test(body)) {
    return true;
  }
  return /\?/.test(body) && !hasStaffingMarketContext(body) && !detectStaffingWarmIntent(body);
}

function classifyStaffingQualificationAnswer(text = '') {
  const body = String(text || '').trim();
  if (!body) return 'unrelated';
  if (hasStaffingMarketContext(body)) return 'clear';
  if (isVagueAck(body) || detectStaffingWarmIntent(body)) return 'unclear';
  if (looksLikeDifferentSpeechAct(body)) return 'unrelated';
  const words = body.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3 && words.length <= 40 && !/\?/.test(body)) return 'unclear';
  return 'unrelated';
}

function isPricingQuestion(text = '') {
  return /\b(pric|cost|fee|charge|how much|\$|rate|monthly|per month)\b/i.test(String(text || ''));
}

function highConfidenceCanonical(canonical = {}, signal) {
  const signals = [...new Set([...(canonical.signals || []), signal].filter(Boolean))];
  return {
    ...canonical,
    state: 'positive',
    confidence: 'high',
    signals,
  };
}

/**
 * Staffing-family-only overlay. Does not change dental classification.
 * Unsubscribe / negative / meeting / pricing keep their existing categories.
 */
function overlayStaffingReplyClassification({ text = '', lead = {}, classification = '', canonical = {} } = {}) {
  const family = familyForLead(lead);
  const kind = String(classification || '').toUpperCase();
  const body = String(text || '');
  const passthrough = {
    classification: kind, canonical, confidence: 0, fit: '', intent: '', overlay: false,
  };
  if (family !== CAMPAIGN_FAMILY.STAFFING) return passthrough;
  if (kind === 'UNSUBSCRIBE' || kind === 'NOT_INTERESTED' || kind === 'OUT_OF_OFFICE' || kind === 'WRONG_PERSON' || kind === 'ALREADY_HANDLED') {
    return { ...passthrough, overlay: false };
  }

  const blocked = classifyStaffingReply(body, lead);
  if (blocked.promote === false) {
    const blockedKind = blocked.classification || 'ALREADY_HANDLED';
    return {
      classification: blockedKind, canonical, confidence: 0, fit: '', intent: '',
      overlay: true, blocked, send: false, action: ACTION.HUMAN_REVIEW, reason: blocked.reason,
    };
  }

  const state = staffingConversationState(lead.notes);
  const intent = detectStaffingWarmIntent(body);

  if (kind === 'MEETING_REQUEST') {
    return { ...passthrough, intent, overlay: false };
  }
  if (kind === 'QUESTION' && isPricingQuestion(body)) {
    return { ...passthrough, intent, overlay: false };
  }

  if (intent === 'SEND_INFO') {
    return {
      classification: 'SEND_INFO',
      canonical: highConfidenceCanonical(canonical, 'send_info'),
      confidence: 90, fit: '', intent, overlay: true,
    };
  }

  if (state.qualifyAsked && !state.qualified) {
    const fit = classifyStaffingQualificationAnswer(body);
    if (fit === 'clear') {
      return {
        classification: 'STAFFING_QUALIFICATION',
        canonical: highConfidenceCanonical(canonical, 'staffing_qualification'),
        confidence: 90, fit, intent, overlay: true,
      };
    }
    return {
      classification: 'STAFFING_QUALIFICATION',
      canonical: { ...canonical, confidence: canonical.confidence || 'low' },
      confidence: 0, fit, intent, overlay: true, send: false,
      action: ACTION.HUMAN_REVIEW,
      reason: fit === 'unclear'
        ? 'staffing qualification answer is unclear'
        : 'unrelated reply while staffing qualification is pending',
      notesTag: fit === 'unclear' ? STAFFING_NOTE.QUALIFY_UNCLEAR : '',
    };
  }

  if (intent === 'INTERESTED') {
    return {
      classification: 'INTERESTED',
      canonical: highConfidenceCanonical(canonical, 'expressed_interest'),
      confidence: 90, fit: '', intent, overlay: true,
    };
  }

  return { ...passthrough, intent, overlay: false };
}

function staffingQualifyQuestionReply() {
  return STAFFING_QUALIFY_QUESTION;
}

function staffingSendInfoReply() {
  return STAFFING_SEND_INFO_REPLY;
}

function staffingQualifiedReply({ company = '', bookingUrl = '', landingPageUrl = STAFFING_LANDING_PAGE_URL } = {}) {
  const who = String(company || '').trim() || 'your agency';
  const landing = landingPageUrl || STAFFING_LANDING_PAGE_URL;
  const booking = String(bookingUrl || '').trim();
  return [
    'That’s exactly the kind of market this is built around.',
    '',
    'Here’s a quick overview of how the employer acquisition system works:',
    landing,
    '',
    `If it looks relevant, you can grab 15 minutes here and I’ll walk you through how we’d target that market for ${who}:`,
    booking,
  ].join('\n');
}

function notesForStaffingWarmAction(action) {
  if (action === ACTION.AUTO_STAFFING_QUALIFY_QUESTION) return [STAFFING_NOTE.QUALIFY_ASKED];
  if (action === ACTION.AUTO_STAFFING_SEND_INFO) return [STAFFING_NOTE.INFO_SENT, STAFFING_NOTE.QUALIFY_ASKED];
  if (action === ACTION.AUTO_STAFFING_QUALIFIED) return [STAFFING_NOTE.QUALIFY_RECEIVED, STAFFING_NOTE.QUALIFIED];
  return [];
}

function inboundWarmReplyAlreadySent(activities = [], inboundMessageId = '') {
  const inbound = String(inboundMessageId || '');
  if (!inbound) return false;
  return activities.some((row) => {
    if (!['booking_link_sent', 'human_response_sent'].includes(String(row.eventType || ''))) return false;
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch (_) { metadata = {}; }
    return String(metadata.inboundMessageId || '') === inbound;
  });
}

module.exports = {
  STAFFING_CLARIFICATION, STAFFING_LANDING_PAGE_URL, STAFFING_NOTE,
  STAFFING_QUALIFY_QUESTION, STAFFING_SEND_INFO_REPLY,
  CANDIDATE_SIDE_MARKERS, EMPLOYER_SIDE_MARKERS, NOT_QUALIFIED_MARKERS,
  STAFFING_INTEREST_MARKERS, STAFFING_SEND_INFO_MARKERS, STAFFING_MARKET_MARKERS,
  classifyStaffingReply, unroutedReplyDecision,
  staffingConversationState, detectStaffingWarmIntent, hasStaffingMarketContext,
  classifyStaffingQualificationAnswer, overlayStaffingReplyClassification,
  staffingQualifyQuestionReply, staffingSendInfoReply, staffingQualifiedReply,
  notesForStaffingWarmAction, inboundWarmReplyAlreadySent,
};
