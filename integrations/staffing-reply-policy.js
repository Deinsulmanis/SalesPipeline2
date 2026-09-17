'use strict';

const { CAMPAIGN_FAMILY, familyForLead, resolveLeadFamily } = require('./campaign-versions');
const { ACTION } = require('./reply-response-policy');

const CANDIDATE_SIDE_MARKERS = Object.freeze([
  ['looking_for_work', /\b(?:looking for (?:a )?job|i am (?:a )?(?:candidate|job seeker)|hire me|my resume|resume attached|i need (?:a )?job)\b/i],
  ['candidate_sourcing', /\b(?:need .{0,40}candidates|send .{0,40}candidates|fill (?:these|our) (?:roles|positions)|candidate sourcing|talent pool|recruit(?:ing|ers?) (?:help|software|for us)|looking for candidates)\b/i],
  ['job_seeker', /\b(?:apply(?:ing)? for (?:a )?(?:job|role)|i(?:'| a)m (?:a )?(?:welder|cdl driver|labourer|laborer))\b/i],
]);

const NOT_QUALIFIED_MARKERS = Object.freeze([
  ['already_have_bd', /\b(?:already have|already use|already doing).{0,60}(?:business development|biz dev|\bbd\b|sales (?:team|people)|outbound|employers?)\b/i],
  ['referral', /\b(?:talk to|speak (?:with|to)|contact|reach out to).{0,40}(?:manager|colleague|someone else|other)\b|\bwrong person\b|\bnot (?:the right|my) (?:person|department)\b/i],
  ['vendor', /\b(?:are you hiring vendors?|partnership opportunity|we sell)\b/i],
]);

const EMPLOYER_SIDE_MARKERS = Object.freeze([
  ['employer_accounts', /\b(?:employer accounts?|new (?:clients?|accounts?)|client acquisition|business development|more employers?)\b/i],
  ['pilot', /\b(?:30[- ]day|employer acquisition pilot|qualified employer meetings?)\b/i],
]);

const STAFFING_CLARIFICATION = 'Just to clarify — we are not talking about candidate sourcing. We run a 30-day employer acquisition pilot: ScaleLab handles prospecting, outreach and qualification, then puts interested employers on the agency calendar. If we do not generate qualified employer meetings, there are no meeting fees.';

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
    return {
      family, staffing: true, candidateSide: false, qualifiedEmployer: false,
      signal: notQualified, clarification: '',
      action: ACTION.HUMAN_REVIEW, send: false, promote: false,
      reason: notQualified === 'referral'
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

module.exports = {
  STAFFING_CLARIFICATION, CANDIDATE_SIDE_MARKERS, EMPLOYER_SIDE_MARKERS, NOT_QUALIFIED_MARKERS,
  classifyStaffingReply, unroutedReplyDecision,
};
