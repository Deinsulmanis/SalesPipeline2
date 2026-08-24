'use strict';

const PROFILE_ID = 'roofing_survey_reply_first';
const TEMPLATE_ID = 'roofing-survey-v1';
const MODEL = process.env.ANTHROPIC_HAIKU_MODEL || 'claude-haiku-4-5';
const CATEGORIES = new Set(['positive','negative','question','ambiguous','unsubscribe','wrong_person','out_of_office','automated','hostile','already_completed']);
const REASON_CODES = new Set(['explicit_permission','explicit_decline','information_request','unclear_permission','explicit_unsubscribe','different_contact','temporary_absence','machine_generated','hostile_response','survey_complete','invalid_model_output']);

const KNOWLEDGE = Object.freeze({
  purpose: 'Research sales and operational problems affecting roofing companies.',
  length: 'Eight one-click questions, usually less than two minutes.',
  typing: 'No written survey answers are required.',
  dataUse: 'Responses are analyzed for recurring industry patterns.',
  reporting: 'Findings are reported in anonymized form.',
  salesIntent: 'The survey itself is not a service pitch.',
  followUp: 'The survey separately asks whether the respondent permits follow-up.',
});

function safeFirstName(lead) {
  const raw = String(lead.contactName || lead.first || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'’-]{1,30}$/.test(raw) && !/^(sk-ant|api|token|secret)/i.test(raw) ? raw : 'there';
}

function complianceFooter({ mailingAddress = 'ScaleLab AI, New Westminster, BC', reference = '' } = {}) {
  return `---\n${mailingAddress}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.${reference ? ` · Ref: ${reference}` : ''}`;
}

function renderInitialEmail(lead, options = {}) {
  const first = safeFirstName(lead);
  return {
    subject: 'quick roofing question',
    body: `Hi ${first},

I’m putting together an anonymous report on what’s costing roofing companies the most time and revenue right now.

The survey is eight clicks, takes under two minutes, and requires no typing. Participants will receive the findings when the research is complete.

Want me to send it over?

– Deins

${complianceFooter(options)}`,
  };
}

function qualifyLead(lead) {
  const evidence = [lead.tradeType, lead.company, lead.siteContext, lead.website].filter(Boolean).join(' ').toLowerCase();
  if (!/\broof(?:er|ers|ing)?\b/.test(evidence)) return { ok: false, confidence: 0, reasonCode: 'no_roofing_evidence' };
  const role = String(lead.contactName || lead.role || lead.title || '').toLowerCase();
  const relevantRole = /\b(owner|co-owner|founder|general manager|sales manager|operations manager|office manager)\b/.test(role);
  return { ok: true, confidence: relevantRole ? 0.95 : (lead.contactName ? 0.75 : 0.6), reasonCode: relevantRole ? 'roofing_decision_maker' : 'roofing_company_contact' };
}

function deterministicClassification(text) {
  const value = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().toLowerCase();
  if (/\b(unsubscribe|remove me|stop (emailing|contacting)|do not contact|don'?t contact)\b/.test(value)) return result('unsubscribe', .99, false, false, 'explicit_unsubscribe');
  if (/\b(already (completed|filled|did)|survey.{0,12}(completed|done)|filled it out)\b/.test(value)) return result('already_completed', .95, false, true, 'survey_complete');
  if (/\b(out of (the )?office|on vacation|away until)\b/.test(value)) return result('out_of_office', .98, false, false, 'temporary_absence');
  if (/\b(automatic reply|auto[- ]?reply|mailbox is not monitored|do not reply)\b/.test(value)) return result('automated', .98, false, false, 'machine_generated');
  if (/\b(wrong person|not the right person|contact .{0,30} instead|no longer work)\b/.test(value)) return result('wrong_person', .94, false, true, 'different_contact');
  if (/\b(spam|scam|fraud|harass|leave me alone|fuck|idiot)\b/.test(value)) return result('hostile', .96, false, true, 'hostile_response');
  if (/\b(privacy|legal|lawyer|attorney|consent|data protection)\b/.test(value)) return result('question', .9, false, true, 'information_request');
  if (/\b(speak|talk|call|connect) (to|with) (someone|a person|you)\b/.test(value)) return result('ambiguous', .9, false, true, 'unclear_permission');
  if (/\b(no|nope|not interested|no thanks|pass)\b/.test(value) && !/\?/.test(value)) return result('negative', .93, false, false, 'explicit_decline');
  if (/\b(what'?s the link|send (me )?the link)\b/.test(value)) return result('positive', .98, true, false, 'explicit_permission');
  const hasQuestion = /\?|\b(who are you|what is this for|how .* used|is it anonymous|how long|are you selling)\b/.test(value);
  const hasPermission = /\b(yes|sure|send it|send it over|okay|ok|i'?ll take a look|happy to help|sounds good)\b/.test(value);
  if (hasQuestion && hasPermission) return result('ambiguous', .85, false, true, 'unclear_permission');
  if (hasQuestion) return result('question', .9, false, true, 'information_request');
  if (hasPermission) return result('positive', .98, true, false, 'explicit_permission');
  if (/\b(interesting|maybe|what do you mean|i'?m busy|can you explain)\b/.test(value)) return result('ambiguous', .82, false, true, 'unclear_permission');
  return null;
}

function validateInitialEmail(email) {
  if (!email || email.subject !== 'quick roofing question') return 'subject must match the locked roofing survey subject';
  const body = String(email.body || '');
  if (/https?:\/\//i.test(body)) return 'initial survey invitation must not contain a URL';
  if (/\b(book|calendar|calendly|ai receptionist|service pitch)\b/i.test(body)) return 'initial survey invitation contains prohibited sales language';
  if (/{{[^}]+}}/.test(body)) return 'initial survey invitation contains an unresolved variable';
  if (!/anonymous report/i.test(body) || !/eight clicks/i.test(body) || !/Want me to send it over\?/i.test(body)) return 'locked roofing survey copy is incomplete';
  if (!/Reply "unsubscribe"/i.test(body)) return 'compliance footer is missing';
  return '';
}

function result(category, confidence, shouldSendSurvey, requiresHumanReview, reasonCode) {
  return { category, confidence, should_send_survey: shouldSendSurvey, requires_human_review: requiresHumanReview, reason_code: reasonCode };
}

function validateClassification(value) {
  if (!value || typeof value !== 'object' || !CATEGORIES.has(value.category)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof value.should_send_survey !== 'boolean' || typeof value.requires_human_review !== 'boolean') return null;
  if (!REASON_CODES.has(value.reason_code)) return null;
  if (value.category !== 'positive' && value.should_send_survey) return null;
  return { category: value.category, confidence, should_send_survey: value.should_send_survey, requires_human_review: value.requires_human_review, reason_code: value.reason_code };
}

async function classifyReply({ replyText = '', createMessage } = {}) {
  const deterministic = deterministicClassification(replyText);
  if (deterministic) return deterministic;
  if (!createMessage) return result('ambiguous', 0, false, true, 'invalid_model_output');
  try {
    const response = await createMessage({
      model: MODEL, max_tokens: 120, temperature: 0,
      system: `You classify replies to a neutral roofing-industry survey invitation. Return ONLY JSON with category, confidence (0-1), should_send_survey, requires_human_review, reason_code. Categories: ${[...CATEGORIES].join(', ')}. Never infer permission. Questions, ambiguity, hostility, privacy/legal concerns, conflicting intent, and already-completed claims require human review. Allowed reason codes: ${[...REASON_CODES].join(', ')}.`,
      messages: [{ role: 'user', content: `Reply:\n${String(replyText || '').slice(0, 3000)}` }],
    });
    const raw = String(response.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return validateClassification(JSON.parse(raw)) || result('ambiguous', 0, false, true, 'invalid_model_output');
  } catch (_) { return result('ambiguous', 0, false, true, 'invalid_model_output'); }
}

function renderPositiveReply(lead, surveyUrl, options = {}) {
  if (!/^https:\/\//i.test(String(surveyUrl || '').trim())) throw new Error('ROOFING_SURVEY_URL must be a valid HTTPS URL');
  const first = safeFirstName(lead);
  return `Thanks, ${first}—here it is:

${String(surveyUrl).trim()}

It’s eight one-click questions and should take less than two minutes. I’ll send the anonymized findings to this email once the research is complete.

Appreciate your input.

– Deins

${complianceFooter(options)}`;
}

function renderQuestionDraft(lead) {
  return `Hi ${safeFirstName(lead)},\n\n${KNOWLEDGE.purpose} ${KNOWLEDGE.length} ${KNOWLEDGE.typing} Responses are analyzed for recurring industry patterns and findings are reported in anonymized form. The survey itself is not a service pitch.\n\nWould you like me to send the link?\n\n– Deins`;
}

function decideReplyAction({ classification, surveyUrl = '', autoReplyEnabled = false, alreadyHandled = false, confidenceFloor = .85 } = {}) {
  const category = classification?.category;
  if (['unsubscribe','negative','out_of_office','automated','wrong_person','already_completed'].includes(category)) return { action: 'no_reply' };
  if (alreadyHandled) return { action: 'duplicate_blocked' };
  if (category !== 'positive' || !classification?.should_send_survey || classification?.requires_human_review || classification.confidence < confidenceFloor) return { action: 'review' };
  if (!/^https:\/\//i.test(String(surveyUrl || '').trim())) return { action: 'review', reason: 'missing_survey_url' };
  return { action: autoReplyEnabled ? 'send' : 'draft' };
}

module.exports = { PROFILE_ID, TEMPLATE_ID, MODEL, CATEGORIES, KNOWLEDGE, safeFirstName, renderInitialEmail, validateInitialEmail, qualifyLead, deterministicClassification, validateClassification, classifyReply, renderPositiveReply, renderQuestionDraft, decideReplyAction };
