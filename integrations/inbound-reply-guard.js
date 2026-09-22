'use strict';

const {
  hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase,
} = require('./canonical-reply');
const { failSafeReplyCategory, deterministicReplyCategory } = require('./reply-classifier');
const { evaluateFreshSendSafety } = require('./send-safety-revalidate');
const { replyDecisionFor } = require('./reply-decision');

const NOTE_UNSUBSCRIBED = '[REPLY: Unsubscribed]';
const NOTE_NOT_INTERESTED = '[REPLY: Not Interested]';
const NOTE_OOO = '[REPLY: OOO';
const NOTE_TIMING = '[REPLY: Timing';
const NOTE_WRONG_PERSON = '[REPLY: Wrong Person';
const NOTE_ALREADY_HANDLED = '[REPLY: Already handled';
const NOTE_NEEDS_HUMAN = '[REPLY: Needs human]';

const parseMeta = (row) => {
  try {
    return typeof row.metadata === 'object' && row.metadata
      ? row.metadata
      : JSON.parse(row.metadata || '{}');
  } catch (_) {
    return {};
  }
};

function inboundMessageIdOf(row = {}) {
  const meta = parseMeta(row);
  return String(meta.gmailMessageId || '').trim()
    || String(row.eventId || '').replace(/^gmail-reply:/, '').trim();
}

function inboundAlreadyEvaluated(activities = [], messageId = '') {
  const id = String(messageId || '').trim();
  if (!id) return false;
  return activities.some((row) => {
    if (String(row.eventType || '') !== 'gmail_reply_evaluated') return false;
    const meta = parseMeta(row);
    return String(meta.sourceEventId || '') === `gmail-reply:${id}`
      || String(meta.gmailMessageId || '') === id;
  });
}

/**
 * What production already decided this message meant. Answered from the reply
 * decision when one exists; replies from before decision records keep the old
 * answer, the classification stored on their reply event. (Whether the message
 * was already HANDLED is a different question: inboundAlreadyEvaluated.)
 */
function committedInboundClassification(activities = [], messageId = '') {
  const id = String(messageId || '').trim();
  if (!id) return '';
  const decided = replyDecisionFor(activities, id);
  if (decided && decided.finalClassification) return String(decided.finalClassification).toUpperCase();
  const inbound = activities.find((row) => {
    if (!/reply|meeting_requested/.test(String(row.eventType || ''))) return false;
    return inboundMessageIdOf(row) === id;
  });
  if (!inbound) return '';
  return String(parseMeta(inbound).classification || '').toUpperCase();
}

function shouldCallReplyModel({
  text = '', subject = '', alreadyEvaluated = false, priorEvaluationFailed = false,
} = {}) {
  if (alreadyEvaluated && !priorEvaluationFailed) return false;
  if (deterministicReplyCategory(text, { subject })) return false;
  if (failSafeReplyCategory(text, { subject })) return false;
  return true;
}

function terminalIntentFromText(text = '', { subject = '' } = {}) {
  if (hasExplicitUnsubscribePhrase(text, { subject })) {
    return {
      classification: 'UNSUBSCRIBE',
      suppressionReason: 'unsubscribe',
      crmStage: 'Unsub',
      crmStatus: 'done',
      notesTag: NOTE_UNSUBSCRIBED,
      autoSend: false,
    };
  }
  if (hasExplicitNegativePhrase(text, { subject })) {
    return {
      classification: 'NOT_INTERESTED',
      suppressionReason: 'not_interested',
      crmStage: 'Done',
      crmStatus: 'done',
      notesTag: NOTE_NOT_INTERESTED,
      autoSend: false,
    };
  }
  return null;
}

function shouldReplayTerminalCrm({ classification = '', lead = {}, suppressedEmails = new Set() } = {}) {
  const kind = String(classification || '').toUpperCase();
  const notes = String(lead.notes || '');
  const email = String(lead.email || '').trim().toLowerCase();
  if (kind === 'UNSUBSCRIBE') {
    const tagged = /\[REPLY:\s*Unsubscribed\]/i.test(notes) && String(lead.stage) === 'Unsub';
    const listed = email && suppressedEmails instanceof Set && suppressedEmails.has(email);
    return !(tagged && listed);
  }
  if (kind === 'NOT_INTERESTED') {
    const tagged = /\[REPLY:\s*Not Interested\]/i.test(notes)
      && String(lead.stage) === 'Done'
      && String(lead.emailStatus) === 'done';
    const listed = email && suppressedEmails instanceof Set && suppressedEmails.has(email);
    return !(tagged && listed);
  }
  return false;
}

function uniqueSuppressions(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const email = String(item?.email || '').trim().toLowerCase();
    const reason = String(item?.reason || '').trim().toLowerCase();
    if (!email || !reason) continue;
    const key = `${email}:${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function suppressionForCanonical(canonical = {}, lead = {}) {
  if (!lead?.email) return null;
  if (canonical.reason === 'unsubscribe_request') {
    return { email: lead.email, reason: 'unsubscribe', company: lead.company };
  }
  if (canonical.state === 'negative' && canonical.reason === 'explicit_rejection') {
    return { email: lead.email, reason: 'not_interested', company: lead.company };
  }
  return null;
}

function skipHandlerForEvaluatedMessage({
  alreadyEvaluated = false, classification = '', lead = {}, suppressedEmails = new Set(),
} = {}) {
  if (!alreadyEvaluated) return false;
  return !shouldReplayTerminalCrm({ classification, lead, suppressedEmails });
}

/**
 * Unsubscribe wins over a send that was already selected in the same window.
 * Uses the same last-moment safety gate the provider send path uses.
 */
function scheduledSendAfterInboundOptOut({
  selectedLead, freshLead, suppressedEmails, purpose = 'cold', env,
} = {}) {
  return evaluateFreshSendSafety(selectedLead, freshLead, suppressedEmails, { purpose, env });
}

function checkOnlyPersistsClassification(classification) {
  const kind = String(classification || '').toUpperCase();
  return [
    'UNSUBSCRIBE', 'NOT_INTERESTED', 'OUT_OF_OFFICE', 'WRONG_PERSON',
    'ALREADY_HANDLED', 'NEEDS_HUMAN', 'QUESTION',
  ].includes(kind);
}

module.exports = {
  NOTE_UNSUBSCRIBED, NOTE_NOT_INTERESTED, NOTE_OOO, NOTE_TIMING, NOTE_WRONG_PERSON,
  NOTE_ALREADY_HANDLED, NOTE_NEEDS_HUMAN,
  inboundAlreadyEvaluated, committedInboundClassification, inboundMessageIdOf,
  shouldCallReplyModel, terminalIntentFromText, shouldReplayTerminalCrm,
  uniqueSuppressions, suppressionForCanonical, skipHandlerForEvaluatedMessage,
  scheduledSendAfterInboundOptOut, checkOnlyPersistsClassification,
};
