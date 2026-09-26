'use strict';

/**
 * conversation-state.js — what has actually happened in one conversation.
 * PURE: no network, no Sheets, no model, no writes. Given the same evidence and
 * the same `now`, it returns byte-identical JSON.
 *
 * It answers, with the evidence behind each answer:
 *   what was said           turns: prospect, human and automated messages
 *   what we have learned    qualification slots, questions, objections, referral
 *   what is still open      questions and objections nobody has responded to
 *   where the meeting is    link sent vs meeting intent vs call lifecycle truth
 *   who owns the next move  production's own ownership verdict, unchanged
 *
 * It DERIVES state only. It never sends, enqueues, changes a stage or an owner,
 * enrols, holds, suppresses or books, and no production decision reads it.
 * Existing rules are called, never re-implemented: ownership, the stage
 * sequence, the call lifecycle, suppression, "we answered" and the reply
 * decision all come from the modules that already own them.
 *
 * Evidence, not guesses. What the evidence does not establish is reported as
 * unknown or unavailable, never as false. Model output is never an input: the
 * shadow agent's recommendations are ignored, and a reply decision is read only
 * as production's recorded interpretation of its message, never recomputed.
 */

const crypto = require('crypto');
const { LEGACY_REPLY_EVENT_TYPES, REPLY_STATE, NEEDS_HUMAN_REASON } = require('./canonical-reply');
const { replyDecisionFor } = require('./reply-decision');
const { PENDING_VERSION, PENDING_STATUS, pendingDecisionFor } = require('./agent-v2-pending-decision');
const { deriveAutomationOwnership, executableOwners } = require('./automation-ownership');
const { deriveOperationalAction, REPLY_ACTION } = require('./reply-operations');
const { leadHasReply } = require('./reply-analytics');
const { evaluateStageSequence, provenSequenceSenderId, SEQUENCE_EVENTS } = require('./stage-sequences');
const {
  deriveCallLifecycle, deriveHotState, sendSuppressionReason, hasManualHold, manualHoldReleased,
  resumeAtFromNotes, CALL_EVENTS, CALL_BOOKING_EVENTS, CALL_STATUS, MANUAL_HOLD_TAG,
} = require('./pipeline-state');
const { latestResponseAt, isResponseEvidence, isProspectFacingResponse } = require('./prospect-response');
const { displayStageFor } = require('./cold-call-pipeline');
const { familyForLead, CAMPAIGN_FAMILY } = require('./campaign-versions');
const { isStaffingCampaign, BOLD_PHRASES } = require('./staffing-campaign');
const {
  STAFFING_NOTE, STAFFING_MARKET_MARKERS, STAFFING_SEND_INFO_MARKERS, CANDIDATE_SIDE_MARKERS,
  NOT_QUALIFIED_MARKERS, EMPLOYER_SIDE_MARKERS, isPricingQuestion, staffingHumanTouchBlock,
} = require('./staffing-reply-policy');
const { storedResearch } = require('./staffing-agent-context');
const { ACTION } = require('./reply-response-policy');
const {
  NOTE_UNSUBSCRIBED, NOTE_NOT_INTERESTED, NOTE_OOO, NOTE_TIMING, NOTE_WRONG_PERSON,
  NOTE_ALREADY_HANDLED, NOTE_NEEDS_HUMAN,
} = require('./inbound-reply-guard');
const { BOOKING_URL } = require('../booking');
const { bookingUrlForFamily } = require('./offer-config');

const CONVERSATION_STATE_VERSION = 'conversation_state_v1';

/**
 * How conflicting evidence is resolved. Stated once so the builder, the tests
 * and the report all mean the same thing.
 */
const EVIDENCE_PRECEDENCE = Object.freeze([
  'terminal: unsubscribe > not interested > bounce > suppression list > closed stage > manual hold > out of office; each is reported with its own evidence and none is hidden by another',
  'meaning of an inbound message: reply_decision_recorded > reply_decision_pending_execution > gmail_reply_evaluated classification > the reply event\'s own classification; a message is never re-classified here',
  'a sent message: a delivered *_sent row with provider ids is a turn; a reservation, draft or failure never becomes a turn',
  'meeting: the call lifecycle (calendar/CRM events + board meetingAt, via deriveCallLifecycle) > meeting intent > booking link sent; a link is never a booking',
  'qualification: a delivered staffing reply action > a [STAFFING ...] note tag; slot values come only from the prospect\'s own words, never from research',
  'human handling: a recorded human_response_sent stands permanently; later automation never erases it',
  'ownership: deriveAutomationOwnership exactly as production computes it; this module adds no ownership rule',
  'absence of evidence is reported as unknown/unavailable, not as false',
]);

const INBOUND_EVENT_TYPES = new Set(LEGACY_REPLY_EVENT_TYPES);
const AUTOMATED_OUTBOUND_TYPES = new Set([
  'initial_email_sent', 'follow_up_sent', 'booking_link_sent', SEQUENCE_EVENTS.STEP_SENT,
]);
const HUMAN_OUTBOUND_TYPE = 'human_response_sent';
const RECORDED_CONVERSATION_TYPE = 'conversation_note';
const INBOUND_TEXT_LIMIT = 1500;
const POSITIVE_CLASSIFICATIONS = new Set(['INTERESTED', 'MEETING_REQUEST', 'SEND_INFO', 'STAFFING_QUALIFICATION']);
const QUESTION_CLASSIFICATIONS = new Set(['QUESTION', 'SEND_INFO']);
const STAFFING_ASKS_ROLES = new Set([ACTION.AUTO_STAFFING_QUALIFY_QUESTION, ACTION.AUTO_STAFFING_SEND_INFO]);
const EXISTING_PROVIDER_MARKERS = new Set([
  'already_have_bd', 'already_have_someone', 'already_use_company', 'already_do_outbound',
  'internal_bd', 'in_house', 'already_covered',
]);
const QUALIFICATION_SLOTS = Object.freeze([
  Object.freeze({ slot: 'roles', marker: 'role' }),
  Object.freeze({ slot: 'industries', marker: 'industry' }),
  Object.freeze({ slot: 'employerTypes', marker: 'employer_type' }),
  Object.freeze({ slot: 'geography', marker: 'geography' }),
]);
// The staffing cold Email 3 asks exactly this, so its delivery is the ask.
const PRIORITY_QUESTION_ANCHOR = String(BOLD_PHRASES[2] || '').split('{{')[0].trim();

// ── small deterministic helpers ─────────────────────────────────────────────

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

const sha256 = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');

function isoOrNull(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const numeric = /^\d{10,13}$/.test(raw) ? Number(raw) * (raw.length === 10 ? 1000 : 1) : NaN;
  const ms = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw, ok: true };
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { value: {}, ok: true };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { value, ok: true } : { value: {}, ok: false };
  } catch (_) {
    return { value: {}, ok: false };
  }
}

const norm = value => String(value || '').trim().toLowerCase();
const text = value => String(value == null ? '' : value);
const uniq = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
const upper = value => String(value || '').trim().toUpperCase();

function compareRows(a, b) {
  // Rows without a usable time sort last; ties break on the event id so input
  // order can never change the output.
  const at = a.occurredAt || '￿';
  const bt = b.occurredAt || '￿';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function familyOf(lead) {
  if (!lead) return '';
  try { return familyForLead(lead) || ''; } catch (_) { return ''; }
}

function messageIdOf(eventId, metadata) {
  const direct = String(metadata.gmailMessageId || metadata.providerMessageId || '').trim();
  if (direct) return direct;
  const match = /^(?:gmail|gmail-reply):(.+)$/.exec(String(eventId || ''));
  return match ? match[1] : '';
}

function evidenceRef(row, extra = {}) {
  return {
    source: extra.source || row.eventType,
    eventId: row.eventId,
    eventType: row.eventType,
    messageId: row.messageId || null,
    occurredAt: row.occurredAt,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  };
}

function noteRef(tag, detail) {
  return { source: 'notes_tag', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: detail || tag };
}

function globalMatches(pattern, value) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const found = [];
  for (const match of String(value || '').matchAll(new RegExp(pattern.source, flags))) {
    const cleaned = match[0].replace(/\s+/g, ' ').replace(/[\s.,;:!?)]+$/, '').trim().toLowerCase();
    if (cleaned) found.push(cleaned);
  }
  return uniq(found);
}

function firstMarker(markers, value) {
  for (const [name, pattern] of markers) if (pattern.test(String(value || ''))) return name;
  return '';
}

function containsAnyUrl(body, urls) {
  const value = String(body || '');
  if (!value) return false;
  return urls.some((url) => {
    if (!url) return false;
    if (value.includes(url)) return true;
    try { const host = new URL(url).host.toLowerCase(); return Boolean(host) && value.toLowerCase().includes(host); }
    catch (_) { return false; }
  });
}

// ── 1. normalization ────────────────────────────────────────────────────────

/**
 * Parse, de-duplicate and order ledger rows. Rows are keyed by eventId: the
 * ledger is append-only, so two rows with one id are one event written twice.
 * The earliest copy wins. Nothing is repaired; every oddity is reported.
 */
function normalizeConversationEvidence({ activities = [] } = {}) {
  const byId = new Map();
  const duplicates = new Map();
  const unparseable = [];
  for (const raw of activities || []) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = parseMetadata(raw.metadata);
    const occurredAt = isoOrNull(raw.occurredAt);
    const shape = {
      eventType: text(raw.eventType).trim(), leadId: text(raw.leadId).trim(),
      sourceLeadId: text(raw.sourceLeadId).trim(), email: norm(raw.email),
      occurredAtRaw: text(raw.occurredAt).trim(), subject: text(raw.subject), content: text(raw.content),
    };
    const eventId = text(raw.eventId).trim()
      || `unidentified:${sha256({ ...shape, metadata: parsed.value }).slice(0, 16)}`;
    const row = {
      eventId, eventType: shape.eventType, leadId: shape.leadId, sourceLeadId: shape.sourceLeadId,
      email: shape.email, occurredAt, occurredAtRaw: shape.occurredAtRaw, subject: shape.subject,
      content: shape.content, metadata: parsed.value, metadataOk: parsed.ok,
      messageId: messageIdOf(eventId, parsed.value),
      threadId: text(parsed.value.gmailThreadId).trim(),
      senderInboxId: text(parsed.value.senderInboxId).trim(),
      // The ledger row exactly as stored. Production rules are handed these,
      // never the parsed copy, so they read the shape they were written for.
      raw,
    };
    if (byId.has(eventId)) {
      const kept = byId.get(eventId);
      const entry = duplicates.get(eventId) || { eventId, copies: 1, identical: true };
      entry.copies += 1;
      const comparable = item => ({ ...item, raw: undefined });
      if (stableStringify(comparable(kept)) !== stableStringify(comparable(row))) entry.identical = false;
      duplicates.set(eventId, entry);
      if (row.occurredAt && (!kept.occurredAt || row.occurredAt < kept.occurredAt)) byId.set(eventId, row);
      continue;
    }
    if (!parsed.ok) unparseable.push(eventId);
    byId.set(eventId, row);
  }
  const rows = [...byId.values()].sort(compareRows);
  return {
    rows,
    // De-duplicated, ordered, unmodified ledger rows for production rules.
    ledgerRows: rows.map(row => row.raw),
    duplicates: [...duplicates.values()].sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
    invalidTimestamps: rows.filter(row => !row.occurredAt).map(row => row.eventId),
    unparseableMetadata: unparseable.sort(),
  };
}

// ── 2. turns ────────────────────────────────────────────────────────────────

function decisionSummary(decision, evaluated) {
  const evaluatedDecisionId = evaluated ? String(evaluated.metadata.replyDecisionId || '') : '';
  let status = 'not_evaluated';
  if (decision) status = decision.version === PENDING_VERSION ? PENDING_STATUS : 'recorded';
  else if (evaluated && evaluatedDecisionId) status = 'evaluated_decision_missing';
  else if (evaluated) status = 'legacy_evaluated';
  return {
    exists: Boolean(decision),
    status,
    decisionId: decision ? decision.decisionId || null : (evaluatedDecisionId || null),
    finalClassification: decision ? decision.finalClassification || null : null,
    finalClassificationSource: decision ? decision.finalClassificationSource || null : null,
    canonicalState: decision ? decision.canonicalState || null : null,
    // The staffing overlay's verdict on the message as a qualification answer.
    qualificationState: decision ? decision.qualificationState || null : null,
    route: decision ? decision.route || null : null,
    policyAction: decision ? decision.policyAction || null : null,
    policySend: decision ? decision.policySend === true : null,
    policyReason: decision ? decision.policyReason || null : null,
    policySource: decision ? decision.policySource || null : null,
    executedAction: decision ? decision.executedAction || null : null,
    executionStatus: decision ? decision.executionStatus || null : null,
    providerProof: decision?.version === PENDING_VERSION ? decision.providerProof || null : null,
    executionCode: decision ? decision.executionCode || null : null,
    requiresHumanAttention: decision ? decision.requiresHumanAttention === true : null,
    effects: decision && Array.isArray(decision.effects) ? [...decision.effects] : [],
    decidedAt: decision ? decision.decidedAt || null : null,
    executedAt: decision ? decision.executedAt || null : null,
    evaluatedEventId: evaluated ? evaluated.eventId : null,
    evaluatedClassification: evaluated ? upper(evaluated.metadata.classification) || null : null,
  };
}

function inboundClassification(decision, evaluated, primary) {
  if (decision && decision.finalClassification) {
    return { value: upper(decision.finalClassification), source: 'reply_decision' };
  }
  if (evaluated && evaluated.metadata.classification) {
    return { value: upper(evaluated.metadata.classification), source: 'gmail_reply_evaluated' };
  }
  if (primary.metadata.classification) {
    return { value: upper(primary.metadata.classification), source: 'reply_event' };
  }
  return { value: null, source: null };
}

function turnShape(fields) {
  // One fixed key order for every turn, whatever its direction.
  return {
    turnId: fields.turnId,
    index: 0,
    direction: fields.direction,
    actor: fields.actor,
    occurredAt: fields.occurredAt,
    messageId: fields.messageId || null,
    threadId: fields.threadId || null,
    senderInboxId: fields.senderInboxId || null,
    eventType: fields.eventType,
    sourceEventIds: fields.sourceEventIds,
    actionType: fields.actionType || null,
    inReplyToMessageId: fields.inReplyToMessageId || null,
    subject: fields.subject || '',
    content: fields.content || '',
    contentAvailable: Boolean(fields.contentAvailable),
    contentSource: fields.contentSource || null,
    contentUnavailableReason: fields.contentUnavailableReason || null,
    contentTruncated: Boolean(fields.contentTruncated),
    from: fields.from || null,
    fromOtherAddress: Boolean(fields.fromOtherAddress),
    genuineHuman: fields.genuineHuman === undefined ? null : fields.genuineHuman,
    automatedReply: Boolean(fields.automatedReply),
    canonicalState: fields.canonicalState || null,
    classification: fields.classification || { value: null, source: null },
    decision: fields.decision || null,
  };
}

function buildTurns({ rows, ledgerRows, lead, boardLead, messageTexts }) {
  const leadEmail = norm((lead && lead.email) || (boardLead && boardLead.email));
  const leadId = lead ? String(lead.id || '') : '';
  const evaluatedByMessage = new Map();
  for (const row of rows) {
    if (row.eventType !== 'gmail_reply_evaluated') continue;
    const id = String(row.metadata.gmailMessageId || String(row.metadata.sourceEventId || '').replace(/^gmail-reply:/, '')).trim();
    if (id && !evaluatedByMessage.has(id)) evaluatedByMessage.set(id, row);
  }

  const inboundGroups = new Map();
  const outboundGroups = new Map();
  const turns = [];
  const recordedConversations = [];
  const warnings = [];

  for (const row of rows) {
    if (INBOUND_EVENT_TYPES.has(row.eventType)) {
      const key = row.messageId ? `msg:${row.messageId}` : `evt:${row.eventId}`;
      inboundGroups.set(key, [...(inboundGroups.get(key) || []), row]);
    } else if (AUTOMATED_OUTBOUND_TYPES.has(row.eventType) || row.eventType === HUMAN_OUTBOUND_TYPE) {
      const key = row.messageId ? `msg:${row.messageId}` : `evt:${row.eventId}`;
      outboundGroups.set(key, [...(outboundGroups.get(key) || []), row]);
    } else if (row.eventType === RECORDED_CONVERSATION_TYPE) {
      recordedConversations.push({
        eventId: row.eventId, occurredAt: row.occurredAt, actor: 'human',
        content: row.content, contentAvailable: Boolean(row.content.trim()),
        contentSource: 'operator_recorded_conversation',
      });
    }
  }

  for (const group of inboundGroups.values()) {
    // Prefer the observer's provider-backed row; otherwise the earliest.
    const primary = group.find(row => row.eventId === `gmail-reply:${row.messageId}`) || group[0];
    const withText = group.find(row => row.content.trim()) || primary;
    const content = withText.content;
    const finalDecision = primary.messageId ? replyDecisionFor(ledgerRows, primary.messageId, leadId || undefined) : null;
    const decision = finalDecision || (primary.messageId
      ? pendingDecisionFor(ledgerRows, primary.messageId, leadId) : null);
    const evaluated = primary.messageId ? evaluatedByMessage.get(primary.messageId) || null : null;
    const from = norm(primary.metadata.from);
    const canonicalState = (decision && decision.canonicalState) || primary.metadata.canonicalState || null;
    const automatedReply = primary.eventType === 'out_of_office_reply'
      || canonicalState === REPLY_STATE.AUTOMATED_REPLY
      || primary.metadata.genuineHuman === false;
    turns.push(turnShape({
      turnId: `turn:${primary.messageId || primary.eventId}`,
      direction: 'inbound', actor: 'prospect',
      occurredAt: primary.occurredAt, messageId: primary.messageId, threadId: primary.threadId,
      senderInboxId: primary.senderInboxId, eventType: primary.eventType,
      sourceEventIds: group.map(row => row.eventId).sort(),
      subject: primary.subject,
      content, contentAvailable: Boolean(content.trim()),
      contentSource: content.trim() ? 'ledger_inbound_text' : null,
      contentUnavailableReason: content.trim() ? null : 'inbound_text_not_recorded',
      contentTruncated: content.length >= INBOUND_TEXT_LIMIT,
      from: from || null,
      fromOtherAddress: Boolean(from && leadEmail && from !== leadEmail),
      genuineHuman: primary.metadata.genuineHuman === undefined ? (automatedReply ? false : null) : primary.metadata.genuineHuman,
      automatedReply,
      canonicalState,
      classification: inboundClassification(decision, evaluated, primary),
      decision: decisionSummary(decision, evaluated),
    }));
  }

  for (const group of outboundGroups.values()) {
    const primary = group.find(row => row.eventType !== HUMAN_OUTBOUND_TYPE) || group[0];
    const human = primary.eventType === HUMAN_OUTBOUND_TYPE;
    const meta = primary.metadata;
    let actionType = null;
    if (primary.eventType === 'booking_link_sent') actionType = String(meta.action || '') || 'unrecorded_action';
    else if (primary.eventType === 'initial_email_sent' || primary.eventType === 'follow_up_sent') {
      actionType = `cold_step_${Number(meta.step) || (primary.eventType === 'initial_email_sent' ? 1 : 0)}`;
    } else if (primary.eventType === SEQUENCE_EVENTS.STEP_SENT) {
      actionType = `${meta.sequenceId || 'sequence'}:step_${Number(meta.step) || 0}`;
    } else if (human) actionType = String(meta.trigger || '') || 'human_response';

    let content = primary.content;
    let contentSource = content.trim() ? 'ledger_sent_body' : null;
    let contentUnavailableReason = null;
    let truncated = false;
    if (human) {
      const reconstructed = primary.messageId && messageTexts[primary.messageId];
      if (meta.trigger === 'crm_log_response' && content.trim()) {
        contentSource = 'operator_logged_note';
      } else if (content.trim()) {
        // Captured by the Gmail observer from the sent message itself.
        contentSource = 'ledger_human_reply_text';
        truncated = meta.contentTruncated === true || content.length >= INBOUND_TEXT_LIMIT;
      } else if (reconstructed && String(reconstructed.text || '').trim()) {
        content = String(reconstructed.text);
        contentSource = String(reconstructed.source || 'provider_message');
        truncated = content.length >= INBOUND_TEXT_LIMIT;
      } else {
        content = '';
        contentSource = null;
        contentUnavailableReason = primary.messageId
          ? 'human_reply_body_not_persisted' : 'human_reply_without_provider_id';
      }
    } else if (!content.trim()) {
      contentUnavailableReason = meta.recoveredAfterCheckpointFailure
        ? 'recovered_send_without_body' : 'sent_body_not_recorded';
    }
    turns.push(turnShape({
      turnId: `turn:${primary.messageId || primary.eventId}`,
      direction: 'outbound', actor: human ? 'human' : 'automation',
      occurredAt: primary.occurredAt, messageId: primary.messageId, threadId: primary.threadId,
      senderInboxId: primary.senderInboxId, eventType: primary.eventType,
      sourceEventIds: group.map(row => row.eventId).sort(),
      actionType, inReplyToMessageId: String(meta.inboundMessageId || '') || null,
      subject: primary.subject,
      content, contentAvailable: Boolean(content.trim()), contentSource, contentUnavailableReason,
      contentTruncated: truncated,
    }));
    if (group.some(row => row.eventType === HUMAN_OUTBOUND_TYPE) && !human) {
      warnings.push({ code: 'automated_send_also_recorded_as_human', detail: 'one provider message is recorded both as an automated send and as a human response', evidence: group.map(row => evidenceRef(row)) });
    }
  }

  const directionRank = { inbound: 0, outbound: 1 };
  turns.sort((a, b) => {
    const at = a.occurredAt || '￿';
    const bt = b.occurredAt || '￿';
    if (at !== bt) return at < bt ? -1 : 1;
    if (a.direction !== b.direction) return directionRank[a.direction] - directionRank[b.direction];
    return a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0;
  });
  turns.forEach((turn, index) => { turn.index = index; });
  recordedConversations.sort((a, b) => compareRows(a, b));
  return { turns, recordedConversations, warnings };
}

const turnRef = turn => (turn ? {
  turnId: turn.turnId, messageId: turn.messageId, occurredAt: turn.occurredAt,
  actor: turn.actor, actionType: turn.actionType,
} : null);

function latestOf(turns, predicate) {
  let found = null;
  for (const turn of turns) if (predicate(turn)) found = turn;
  return turnRef(found);
}

// A genuine message from the prospect side, not an autoresponder.
const isProspectMessage = turn => turn.direction === 'inbound' && !turn.automatedReply;

function firstResponseAfter(turns, inbound) {
  const exact = turns.find(turn => turn.direction === 'outbound' && turn.inReplyToMessageId
    && inbound.messageId && turn.inReplyToMessageId === inbound.messageId);
  if (exact) return exact;
  return turns.find(turn => turn.direction === 'outbound' && turn.index > inbound.index) || null;
}

// ── 3. terminal state ───────────────────────────────────────────────────────

function buildTerminalState({ lead, boardLead, rows, turns, suppressedEmails, now }) {
  const notes = text(lead && lead.notes);
  const email = norm((lead && lead.email) || (boardLead && boardLead.email));
  const decisions = turns.filter(turn => turn.decision && turn.decision.exists);

  const unsubscribed = [];
  if (notes.includes(NOTE_UNSUBSCRIBED)) unsubscribed.push(noteRef(NOTE_UNSUBSCRIBED));
  if (lead && norm(lead.stage) === 'unsub') unsubscribed.push({ source: 'lead_stage', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: 'ColdEmail stage Unsub' });
  for (const row of rows) {
    if (row.eventType === 'unsubscribe_reply' || row.metadata.reason === 'unsubscribe_request') {
      if (INBOUND_EVENT_TYPES.has(row.eventType)) unsubscribed.push(evidenceRef(row, { source: 'reply_event' }));
    }
  }
  for (const turn of decisions) {
    if (turn.decision.finalClassification === 'UNSUBSCRIBE') {
      unsubscribed.push({ source: 'reply_decision', eventId: turn.decision.decisionId, eventType: 'reply_decision_recorded', messageId: turn.messageId, occurredAt: turn.occurredAt, detail: turn.decision.executionStatus });
    }
  }

  const notInterested = [];
  if (notes.includes(NOTE_NOT_INTERESTED)) notInterested.push(noteRef(NOTE_NOT_INTERESTED));
  for (const row of rows) {
    if (INBOUND_EVENT_TYPES.has(row.eventType) && row.metadata.reason === 'explicit_rejection') {
      notInterested.push(evidenceRef(row, { source: 'reply_event' }));
    }
  }
  for (const turn of decisions) {
    if (turn.decision.finalClassification === 'NOT_INTERESTED') {
      notInterested.push({ source: 'reply_decision', eventId: turn.decision.decisionId, eventType: 'reply_decision_recorded', messageId: turn.messageId, occurredAt: turn.occurredAt, detail: turn.decision.executionStatus });
    }
  }

  const bounced = [];
  if (notes.includes('[BOUNCED')) bounced.push(noteRef('[BOUNCED'));
  for (const row of rows) if (row.eventType === 'email_bounced') bounced.push(evidenceRef(row, { source: 'provider_bounce' }));

  // Production's send-suppression reason counts a MANUAL HOLD too. The hold is
  // reversible and reported under manualHold, so `suppressed` means durable
  // suppression only: an opt-out/bounce tag or the suppression list.
  const productionReason = lead ? sendSuppressionReason(lead, { suppressedEmails }) : null;
  const onSuppressionList = Boolean(email && suppressedEmails.has(email));
  const suppressionReason = productionReason && productionReason !== MANUAL_HOLD_TAG
    ? productionReason : (onSuppressionList ? 'suppression-list' : null);

  const boardStage = boardLead ? displayStageFor(boardLead.stage) : null;
  const closed = boardStage === 'closed_won' || boardStage === 'closed_lost';

  const holdPresent = hasManualHold(notes);
  const resumeMs = resumeAtFromNotes(notes);
  const holdReleased = holdPresent && manualHoldReleased(notes, now);

  const oooEvidence = [];
  if (notes.includes(NOTE_OOO)) oooEvidence.push(noteRef(NOTE_OOO, (notes.match(/\[REPLY:\s*OOO[^\]]*\]/i) || [NOTE_OOO])[0]));
  let returnDate = null;
  for (const turn of turns) {
    if (turn.direction !== 'inbound' || !turn.automatedReply) continue;
    const row = rows.find(item => item.eventId === turn.sourceEventIds[0]);
    const stated = row ? isoOrNull(row.metadata.returnDate) : null;
    oooEvidence.push({ source: 'automated_reply', eventId: row ? row.eventId : null, eventType: turn.eventType, messageId: turn.messageId, occurredAt: turn.occurredAt, detail: stated || null });
    if (stated) returnDate = stated;
  }
  // A later genuine reply means they are back; a stated return date wins;
  // otherwise production's OOO hold (tag + resume instant) decides.
  const latestInbound = [...turns].reverse().find(turn => turn.direction === 'inbound');
  let oooStatus = 'none';
  if (oooEvidence.length) {
    const autoTurns = turns.filter(turn => turn.direction === 'inbound' && turn.automatedReply);
    if (autoTurns.length && latestInbound && !latestInbound.automatedReply) oooStatus = 'superseded_by_reply';
    else if (returnDate) oooStatus = returnDate > now ? 'active' : 'expired';
    else if (holdPresent) oooStatus = holdReleased ? 'expired' : 'active';
    else oooStatus = 'unknown';
  }
  const oooActive = oooStatus === 'active';

  const timingEvidence = notes.includes(NOTE_TIMING)
    ? [noteRef(NOTE_TIMING, (notes.match(/\[REPLY:\s*Timing[^\]]*\]/i) || [NOTE_TIMING])[0])] : [];

  const flags = {
    unsubscribed: { value: unsubscribed.length > 0, evidence: unsubscribed },
    notInterested: { value: notInterested.length > 0, evidence: notInterested },
    bounced: { value: bounced.length > 0, evidence: bounced },
    suppressed: {
      value: Boolean(suppressionReason), reason: suppressionReason || null, onSuppressionList,
      sendSuppressionReason: productionReason || null,
      evidence: suppressionReason ? [{ source: onSuppressionList && suppressionReason === 'suppression-list' ? 'suppression_list' : 'notes_tag', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: suppressionReason }] : [],
    },
    closed: { value: closed, boardStage, evidence: closed ? [{ source: 'board_stage', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: boardLead.stage }] : [] },
    manualHold: {
      value: holdPresent && !holdReleased, present: holdPresent, released: holdReleased,
      resumeAt: resumeMs == null ? null : new Date(resumeMs).toISOString(),
      evidence: holdPresent ? [noteRef(MANUAL_HOLD_TAG)] : [],
    },
    outOfOffice: { value: oooActive, status: oooStatus, returnDate, evidence: oooEvidence },
    timingHold: { value: timingEvidence.length > 0, evidence: timingEvidence },
  };
  const order = [
    ['unsubscribed', flags.unsubscribed.value], ['not_interested', flags.notInterested.value],
    ['bounced', flags.bounced.value], ['suppressed', flags.suppressed.value], ['closed', flags.closed.value],
    ['manual_hold', flags.manualHold.value], ['out_of_office', flags.outOfOffice.value],
  ];
  const blockedBy = (order.find(([, active]) => active) || [null])[0];
  return {
    blockedBy,
    isTerminal: ['unsubscribed', 'not_interested', 'bounced', 'closed'].includes(blockedBy),
    ...flags,
  };
}

// ── 4. qualification ────────────────────────────────────────────────────────

function decisionFit(turn) {
  // Production's own verdict on the message as a qualification answer: the
  // staffing overlay's fit ('clear' | 'unclear' | 'unrelated') it recorded.
  const decision = turn.decision;
  if (!decision || !decision.exists || decision.finalClassification !== 'STAFFING_QUALIFICATION') return null;
  return decision.qualificationState || null;
}

function buildQualification({ lead, turns, notes, family }) {
  const staffing = family === CAMPAIGN_FAMILY.STAFFING || (lead && isStaffingCampaign(lead));
  if (!staffing) {
    return { applicable: false, family: family || null, status: 'not_applicable', productionQualified: null, slots: {}, asked: [], legacyTags: [] };
  }
  const tags = {
    asked: notes.includes(STAFFING_NOTE.QUALIFY_ASKED), received: notes.includes(STAFFING_NOTE.QUALIFY_RECEIVED),
    qualified: notes.includes(STAFFING_NOTE.QUALIFIED), unclear: notes.includes(STAFFING_NOTE.QUALIFY_UNCLEAR),
    infoSent: notes.includes(STAFFING_NOTE.INFO_SENT),
  };
  const automated = turns.filter(turn => turn.direction === 'outbound' && turn.actor === 'automation');
  const rolesAsks = automated.filter(turn => STAFFING_ASKS_ROLES.has(turn.actionType));
  const qualifiedSends = automated.filter(turn => turn.actionType === ACTION.AUTO_STAFFING_QUALIFIED);
  const priorityAsks = automated.filter(turn => turn.actionType === 'cold_step_3'
    && PRIORITY_QUESTION_ANCHOR && turn.content.includes(PRIORITY_QUESTION_ANCHOR));
  const firstRolesAskAt = rolesAsks.length ? rolesAsks[0].occurredAt : null;
  const prospectMessages = turns.filter(isProspectMessage);

  const slots = {};
  for (const { slot, marker } of QUALIFICATION_SLOTS) {
    const pattern = (STAFFING_MARKET_MARKERS.find(([name]) => name === marker) || [])[1];
    const evidence = [];
    for (const turn of prospectMessages) {
      if (!pattern || !turn.contentAvailable) continue;
      const matched = globalMatches(pattern, turn.content);
      if (!matched.length) continue;
      // true: after a delivered ask. null: only a legacy tag says we asked, so
      // the order is unknown. false: nothing had asked for it yet.
      let afterAsk = false;
      if (firstRolesAskAt) afterAsk = Boolean(turn.occurredAt && turn.occurredAt > firstRolesAskAt);
      else if (tags.asked) afterAsk = null;
      evidence.push({
        messageId: turn.messageId, eventId: turn.sourceEventIds[0], occurredAt: turn.occurredAt,
        source: 'prospect_inbound', valueSource: `staffing_market_markers.${marker}`,
        values: matched, afterAsk, productionFit: decisionFit(turn),
      });
    }
    const values = uniq(evidence.flatMap(item => item.values));
    let status = 'unknown';
    if (evidence.some(item => item.afterAsk === true || item.productionFit === 'clear')) status = 'filled';
    else if (evidence.length) status = 'mentioned';
    else if (tags.received || tags.qualified || qualifiedSends.length) status = 'legacy_unknown_value';
    slots[slot] = {
      status,
      value: values.length ? values : null,
      askedBy: ['roles', 'industries'].includes(slot)
        ? rolesAsks.map(turnRef).concat(tags.asked && !rolesAsks.length ? [{ turnId: null, messageId: null, occurredAt: null, actor: 'automation', actionType: 'legacy_tag' }] : [])
        : [],
      evidence,
      latestEvidenceMessageId: evidence.length ? evidence[evidence.length - 1].messageId : null,
    };
  }
  const priorityRepliesAfter = priorityAsks.length
    ? prospectMessages.filter(turn => turn.occurredAt && turn.occurredAt > priorityAsks[0].occurredAt).map(turn => turn.messageId)
    : [];
  slots.employerAcquisitionPriority = {
    status: 'unknown',
    value: null,
    askedBy: priorityAsks.map(turnRef),
    evidence: [],
    repliesAfterAsk: priorityRepliesAfter,
    latestEvidenceMessageId: null,
    note: 'asked by staffing cold Email 3; no deterministic rule reads the answer, so the value stays unknown',
  };

  const productionQualified = qualifiedSends.length
    ? { value: true, source: 'delivered_staffing_qualified_reply', evidence: qualifiedSends.map(turnRef) }
    : tags.qualified
      ? { value: true, source: 'legacy_tag', evidence: [noteRef(STAFFING_NOTE.QUALIFIED)] }
      : { value: false, source: null, evidence: [] };

  const anySlotFilled = QUALIFICATION_SLOTS.some(({ slot }) => slots[slot].status === 'filled');
  const clearAnswer = prospectMessages.some(turn => decisionFit(turn) === 'clear');
  const unclearAnswer = prospectMessages.some(turn => ['unclear', 'unrelated'].includes(decisionFit(turn))) || tags.unclear;
  let status = 'not_started';
  if (qualifiedSends.length) status = 'qualified';
  else if (tags.qualified) status = 'qualified_legacy';
  else if (clearAnswer || anySlotFilled) status = 'answered';
  else if (unclearAnswer) status = 'answer_unclear';
  else if (rolesAsks.length || tags.asked) status = 'awaiting_answer';

  return {
    applicable: true,
    family: CAMPAIGN_FAMILY.STAFFING,
    status,
    productionQualified,
    slots,
    asked: rolesAsks.map(turnRef),
    legacyTags: Object.entries(tags).filter(([, present]) => present).map(([name]) => name),
  };
}

// ── 5. questions, objections, referral ──────────────────────────────────────

function signalsFor(turn, rows) {
  const row = rows.find(item => item.eventId === turn.sourceEventIds[0]) || { metadata: {} };
  const decisionRow = turn.decision && turn.decision.exists
    ? rows.find(item => item.eventType === 'reply_decision_recorded' && item.eventId === turn.decision.decisionId) : null;
  const ruleCanonical = decisionRow ? (decisionRow.metadata.ruleCanonical || {}) : {};
  return {
    signals: uniq([...(Array.isArray(ruleCanonical.signals) ? ruleCanonical.signals : []),
      ...(Array.isArray(row.metadata.evidenceSignals) ? row.metadata.evidenceSignals : [])]).sort(),
    reason: ruleCanonical.reason || row.metadata.reason || null,
    revisitDate: isoOrNull(ruleCanonical.revisitDate || row.metadata.revisitDate),
    suppliedContact: String(row.metadata.suppliedContact || '').trim() || null,
    proposedEmail: String(row.metadata.proposedEmail || '').trim() || null,
  };
}

function responseStatus(turns, inbound, { supersededBy = null } = {}) {
  const response = firstResponseAfter(turns, inbound);
  if (response) {
    return { status: 'responded', respondedBy: response.actor, responseTurnId: response.turnId, responseAt: response.occurredAt };
  }
  if (supersededBy) {
    return { status: 'superseded', respondedBy: null, responseTurnId: null, responseAt: null, supersededBy };
  }
  const decision = inbound.decision;
  if (decision && decision.exists && decision.requiresHumanAttention) {
    return { status: 'handed_off', respondedBy: null, responseTurnId: null, responseAt: null };
  }
  return { status: 'open', respondedBy: null, responseTurnId: null, responseAt: null };
}

function buildQuestionsAndObjections({ turns, rows, family, lead }) {
  const questions = [];
  const objections = [];
  const referral = { status: 'none', suppliedContact: null, proposedEmail: null, identityMutationAllowed: false, evidence: [] };
  const ambiguities = [];
  const prospectMessages = turns.filter(isProspectMessage);
  const staffing = family === CAMPAIGN_FAMILY.STAFFING;

  for (const turn of prospectMessages) {
    const body = turn.contentAvailable ? turn.content : '';
    const facts = signalsFor(turn, rows);
    const classification = turn.classification.value;

    // Referral / wrong person: evidence only, never an identity change.
    const referralMarker = firstMarker(NOT_QUALIFIED_MARKERS, body) === 'referral';
    if (classification === 'WRONG_PERSON' || turn.canonicalState === REPLY_STATE.CONTACT_CHANGE_REVIEW
      || turn.eventType === 'wrong_person_reply' || referralMarker || facts.suppliedContact || facts.proposedEmail) {
      referral.status = 'referred';
      referral.suppliedContact = facts.suppliedContact || referral.suppliedContact;
      referral.proposedEmail = facts.proposedEmail || referral.proposedEmail;
      referral.evidence.push({ messageId: turn.messageId, occurredAt: turn.occurredAt,
        source: classification === 'WRONG_PERSON' ? turn.classification.source : (referralMarker ? 'not_qualified_markers.referral' : 'reply_event') });
    }

    // Objections: only the kinds an existing rule already recognises.
    const objectionTypes = [];
    const notQualified = firstMarker(NOT_QUALIFIED_MARKERS, body);
    if (EXISTING_PROVIDER_MARKERS.has(notQualified)) objectionTypes.push({ type: 'existing_provider', source: `not_qualified_markers.${notQualified}` });
    else if (classification === 'ALREADY_HANDLED' || facts.reason === NEEDS_HUMAN_REASON.ALREADY_HANDLED) {
      objectionTypes.push({ type: 'existing_provider', source: classification === 'ALREADY_HANDLED' ? turn.classification.source : 'canonical_reason' });
    }
    if (facts.reason === NEEDS_HUMAN_REASON.DEFERRED_TIMING || facts.revisitDate
      || (turn.decision && turn.decision.route === 'timing')) {
      objectionTypes.push({ type: 'timing', source: facts.revisitDate ? 'canonical_revisit_date' : (turn.decision && turn.decision.route === 'timing' ? 'reply_decision' : 'canonical_reason'), revisitDate: facts.revisitDate });
    }
    if (staffing && firstMarker(CANDIDATE_SIDE_MARKERS, body) && !firstMarker(EMPLOYER_SIDE_MARKERS, body)) {
      objectionTypes.push({ type: 'candidate_side_confusion', source: `candidate_side_markers.${firstMarker(CANDIDATE_SIDE_MARKERS, body)}` });
    }
    for (const item of objectionTypes) {
      const later = prospectMessages.find(other => other.index > turn.index
        && (POSITIVE_CLASSIFICATIONS.has(other.classification.value) || other.canonicalState === REPLY_STATE.POSITIVE));
      objections.push({
        id: `objection:${turn.messageId || turn.turnId}:${item.type}`,
        type: item.type, source: item.source,
        evidenceMessageId: turn.messageId, occurredAt: turn.occurredAt,
        ...(item.revisitDate ? { revisitDate: item.revisitDate } : {}),
        ...responseStatus(turns, turn, { supersededBy: later ? later.messageId : null }),
      });
    }

    // Questions: a recorded question classification, the canonical question
    // reason, or an existing topic rule. Topics come only from existing rules.
    const topics = [];
    const infoMarker = firstMarker(STAFFING_SEND_INFO_MARKERS, body);
    if ((body && isPricingQuestion(body)) || facts.signals.includes('pricing')) {
      topics.push({ topic: 'pricing', source: facts.signals.includes('pricing') ? 'canonical_signal' : 'pricing_pattern' });
    }
    if (facts.signals.includes('how_it_works') || infoMarker === 'see_how') {
      topics.push({ topic: 'how_it_works', source: facts.signals.includes('how_it_works') ? 'canonical_signal' : 'send_info_markers.see_how' });
    }
    if (facts.signals.includes('send_info') || ['send_info', 'website', 'read_more'].includes(infoMarker) || classification === 'SEND_INFO') {
      topics.push({ topic: 'information_request', source: infoMarker && infoMarker !== 'see_how' ? `send_info_markers.${infoMarker}` : (facts.signals.includes('send_info') ? 'canonical_signal' : turn.classification.source) });
    }
    const questionRecorded = QUESTION_CLASSIFICATIONS.has(classification) || turn.eventType === 'question_reply'
      || (facts.reason === NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION && !objectionTypes.length);
    if (!topics.length && questionRecorded) topics.push({ topic: 'unspecified', source: classification ? turn.classification.source : 'canonical_reason' });
    for (const item of topics) {
      questions.push({
        id: `question:${turn.messageId || turn.turnId}:${item.topic}`,
        topic: item.topic, source: item.source, askedBy: 'prospect',
        evidenceMessageId: turn.messageId, occurredAt: turn.occurredAt,
        ...responseStatus(turns, turn),
      });
    }
    if (!topics.length && !objectionTypes.length && /\?/.test(body)) {
      ambiguities.push({ code: 'question_mark_without_rule', messageId: turn.messageId,
        detail: 'the message contains a question mark but no deterministic question or objection rule matched' });
    }
  }
  return { questions, objections, referral, ambiguities };
}

// ── 6. booking ──────────────────────────────────────────────────────────────

function buildBooking({ turns, rows, ledgerRows, boardLead, notes, bookingUrls, now }) {
  const automated = turns.filter(turn => turn.direction === 'outbound' && turn.actor === 'automation');
  const linkTurns = automated.filter(turn => turn.contentAvailable && containsAnyUrl(turn.content, bookingUrls));
  const humanUnknown = turns.filter(turn => turn.direction === 'outbound' && turn.actor === 'human' && !turn.contentAvailable);
  const humanWithLink = turns.filter(turn => turn.direction === 'outbound' && turn.actor === 'human'
    && turn.contentAvailable && containsAnyUrl(turn.content, bookingUrls));
  const legacyLink = /booking link sent/i.test(notes);
  const allLinks = [...linkTurns, ...humanWithLink].sort((a, b) => a.index - b.index);

  const intentTurns = turns.filter(turn => turn.direction === 'inbound' && (
    turn.classification.value === 'MEETING_REQUEST' || turn.eventType === 'meeting_requested'
    || signalsFor(turn, rows).signals.includes('meeting')));

  const call = deriveCallLifecycle(boardLead || {}, { activities: ledgerRows, now: new Date(now) });
  const callRows = rows.filter(row => CALL_EVENTS.includes(row.eventType));
  const bookingRows = callRows.filter(row => CALL_BOOKING_EVENTS.includes(row.eventType));
  const latestBooking = bookingRows[bookingRows.length - 1] || null;
  const trigger = latestBooking ? String(latestBooking.metadata.trigger || '') : '';
  const live = [CALL_STATUS.SCHEDULED, CALL_STATUS.RESCHEDULED].includes(call.status);

  // sent: a delivered body carries the link. sent_legacy: only a note says so.
  // unknown: a human replied and we cannot see what they wrote.
  let linkStatus = 'not_observed';
  if (allLinks.length) linkStatus = 'sent';
  else if (legacyLink) linkStatus = 'sent_legacy';
  else if (humanUnknown.length) linkStatus = 'unknown';
  return {
    linkSent: {
      status: linkStatus,
      value: linkStatus === 'sent' || linkStatus === 'sent_legacy' ? true : (linkStatus === 'unknown' ? null : false),
      source: allLinks.length ? 'delivered_message_body' : (legacyLink ? 'legacy_note' : null),
      firstAt: allLinks.length ? allLinks[0].occurredAt : null,
      lastAt: allLinks.length ? allLinks[allLinks.length - 1].occurredAt : null,
      count: allLinks.length,
      evidence: allLinks.map(turnRef),
      humanRepliesWithUnknownContent: humanUnknown.length,
    },
    meetingIntent: { value: intentTurns.length > 0, evidence: intentTurns.map(turnRef) },
    call: {
      status: call.status,
      live,
      meetingAt: call.meetingAt || null,
      previousMeetingAt: call.previousMeetingAt || null,
      rescheduled: Number(call.rescheduleCount || 0) > 0,
      rescheduleCount: Number(call.rescheduleCount || 0),
      cancelled: call.status === CALL_STATUS.CANCELLED,
      resolvedAt: call.resolvedAt || null,
      reason: call.reason || null,
      bookingSource: latestBooking ? (trigger === 'google_calendar' ? 'google_calendar' : (trigger || 'crm')) : (call.meetingAt ? 'board_field_only' : null),
      confirmedByCalendar: Boolean(latestBooking && trigger === 'google_calendar'),
      evidence: callRows.map(row => evidenceRef(row, { source: String(row.metadata.trigger || 'call_event') })),
    },
    liveCalendarChecked: false,
  };
}

// ── 7. ownership and response state ─────────────────────────────────────────

/**
 * The same inputs deriveNextAction gives ownership for a Pipeline card, with
 * one deliberate difference: a lead with no Pipeline row passes boardLead null
 * (as the warm-send gate does), never {}, which ownership would read as a board
 * lead with a blank stage.
 */
function buildOwnership({ lead, boardLead, ledgerRows, suppressedEmails, config, now, turns, family }) {
  const board = boardLead || null;
  const boardForRules = board || {};
  const clock = new Date(now);
  const warnings = [];
  const callState = deriveCallLifecycle(boardForRules, { activities: ledgerRows, now: clock });
  const hotState = deriveHotState(boardForRules, { activities: ledgerRows, now: clock });
  let sequenceState = null;
  let ownership = null;
  let operational = null;
  const answeredAt = latestResponseAt(ledgerRows);
  try {
    sequenceState = evaluateStageSequence({
      boardLead: boardForRules, twin: lead || {}, activities: ledgerRows, now: clock.getTime(),
      callState, hotState, suppressedEmails, featureEnabled: config.sequencesEnabled === true,
    });
  } catch (error) {
    warnings.push({ code: 'sequence_state_unavailable', detail: error.message, evidence: [] });
  }
  if (lead && lead.email) {
    try {
      ownership = deriveAutomationOwnership(lead, {
        boardLead: board, activities: ledgerRows, callState, sequenceState,
        now: clock,
        sendingEnabled: config.sendingEnabled === true,
        sequencesEnabled: config.sequencesEnabled === true || Boolean(sequenceState && sequenceState.featureEnabled),
        suppressionReason: item => sendSuppressionReason(item, { suppressedEmails }),
        humanTouchAt: answeredAt,
      });
    } catch (error) {
      warnings.push({ code: 'ownership_unavailable', detail: error.message, evidence: [] });
    }
    try {
      operational = deriveOperationalAction(lead, {
        activities: ledgerRows, boardLead: board, manualFollowUpDate: board ? board.followup : '',
        humanTouchAt: answeredAt,
      });
    } catch (error) {
      warnings.push({ code: 'operational_action_unavailable', detail: error.message, evidence: [] });
    }
  }
  const executable = ownership ? executableOwners(ownership) : [];
  if (executable.length > 1) {
    warnings.push({ code: 'multiple_executable_owners', detail: executable.join(', '), evidence: [] });
  }
  const humanTurns = turns.filter(turn => turn.direction === 'outbound' && turn.actor === 'human');
  // The Phase 0 staffing hold, asked exactly as the reply path asks it (with a
  // healthy outbound observation assumed, since this is a read, not a pass).
  const staffingHold = family === CAMPAIGN_FAMILY.STAFFING && lead
    ? staffingHumanTouchBlock({ lead, activities: ledgerRows, outboundObservationOk: true }) : null;
  return {
    warnings,
    ownership: {
      owner: ownership ? ownership.owner : 'unknown',
      reason: ownership ? ownership.reason : (lead ? 'ownership could not be derived' : 'no ColdEmail record: ownership is derived for the sending twin only'),
      blockedBy: ownership ? ownership.blockedBy : null,
      source: ownership ? ownership.source : null,
      automationAllowed: ownership ? ownership.automationAllowed === true : null,
      sendAllowed: ownership ? ownership.sendAllowed === true : null,
      sequenceAllowed: ownership ? ownership.sequenceAllowed === true : null,
      executableOwners: executable,
      resumeCondition: ownership ? ownership.resumeCondition || null : null,
      resumeAt: ownership ? ownership.resumeAt || null : null,
      evidence: ownership ? ownership.evidence || {} : {},
      inputs: {
        sendingEnabled: config.sendingEnabled === true,
        sequencesEnabled: config.sequencesEnabled === true,
        coldCadenceDue: false,
        replyResponseDecision: null,
      },
      humanTakeover: {
        value: humanTurns.length > 0,
        lastHumanOutboundAt: humanTurns.length ? humanTurns[humanTurns.length - 1].occurredAt : null,
        evidence: humanTurns.map(turnRef),
      },
      staffingAutomationHold: staffingHold
        ? { applies: true, code: staffingHold.code, reason: staffingHold.reason }
        : { applies: false, code: null, reason: null },
      sequence: sequenceState ? {
        status: sequenceState.status || null, sequenceId: sequenceState.sequenceId || null,
        step: sequenceState.step == null ? null : sequenceState.step, offers: [...(sequenceState.offers || [])],
        eligible: sequenceState.eligible === true, stopReason: sequenceState.stopReason || null,
        nextDueAt: sequenceState.nextDueAt || null,
      } : null,
      callStatus: callState.status,
    },
    // Normalised for comparison with turn times; production received it raw.
    answeredAtIso: isoOrNull(answeredAt),
    operational: operational ? {
      action: operational.action || null, owner: operational.owner || null, waitingOn: operational.waitingOn || null,
      dueAt: operational.dueAt || null, dueAtSource: operational.dueAtSource || null,
      reason: operational.reason || null, requiresHumanReview: operational.requiresHumanReview === true,
    } : null,
  };
}

function buildResponseState({ lead, rows, turns, operational, answeredAt }) {
  const prospect = [...turns].reverse().find(isProspectMessage) || null;
  const evidenceRow = answeredAt ? [...rows].reverse().find(row => isResponseEvidence(row) && row.occurredAt === answeredAt) : null;
  let answeredBy = null;
  if (evidenceRow) {
    if (evidenceRow.eventType === HUMAN_OUTBOUND_TYPE) answeredBy = 'human';
    else if (isProspectFacingResponse(evidenceRow)) answeredBy = 'automation';
    else if (evidenceRow.eventType === RECORDED_CONVERSATION_TYPE) answeredBy = 'recorded_conversation';
    else answeredBy = 'meeting';
  }
  let answered = 'no_prospect_message';
  if (prospect) answered = answeredAt && prospect.occurredAt && answeredAt >= prospect.occurredAt ? 'yes' : 'no';
  // Reply operations answers `investigate` for any lead with no trustworthy
  // reply — the normal state of a cold lead nobody has heard from. Ownership
  // treats it as human work only when the lead appears to have replied
  // (leadHasReply); the response state applies exactly that guard.
  const investigateWithoutReply = Boolean(operational && lead
    && operational.action === REPLY_ACTION.INVESTIGATE && !leadHasReply(lead));
  let waitingOn = 'unknown';
  if (operational) waitingOn = investigateWithoutReply ? 'no_reply_yet' : operational.waitingOn;
  return {
    latestProspectMessageAt: prospect ? prospect.occurredAt : null,
    latestResponseAt: answeredAt || null,
    answered,
    answeredBy: answered === 'yes' ? answeredBy : null,
    answerEvidence: answered === 'yes' && evidenceRow ? evidenceRef(evidenceRow) : null,
    waitingOn,
    waitingOnSource: !operational ? null : (investigateWithoutReply ? 'ownership_investigate_guard' : 'reply_operations'),
    operationalAction: operational && !investigateWithoutReply ? operational.action : null,
    dueAt: operational && !investigateWithoutReply ? operational.dueAt : null,
    dueAtSource: operational && !investigateWithoutReply ? operational.dueAtSource : null,
  };
}

// ── 8. legacy tags, research, thread ────────────────────────────────────────

const LEGACY_TAG_MEANINGS = Object.freeze([
  [STAFFING_NOTE.QUALIFY_ASKED, 'qualification.asked (legacy)'],
  [STAFFING_NOTE.QUALIFY_RECEIVED, 'qualification answer received (legacy, no value)'],
  [STAFFING_NOTE.QUALIFIED, 'qualification.productionQualified (legacy)'],
  [STAFFING_NOTE.QUALIFY_UNCLEAR, 'qualification answer unclear (legacy)'],
  [STAFFING_NOTE.INFO_SENT, 'staffing information sent (legacy)'],
  ['[REPLY: Interested]', 'positive reply recorded and promoted'],
  [NOTE_UNSUBSCRIBED, 'terminalState.unsubscribed'],
  [NOTE_NOT_INTERESTED, 'terminalState.notInterested'],
  [NOTE_OOO, 'terminalState.outOfOffice'],
  [NOTE_TIMING, 'terminalState.timingHold'],
  [NOTE_WRONG_PERSON, 'referral'],
  ['[REFERRAL CONTACT:', 'referral contact (evidence only)'],
  ['[REFERRAL EVIDENCE:', 'referral evidence text'],
  [NOTE_ALREADY_HANDLED, 'existing provider / internal BD'],
  [NOTE_NEEDS_HUMAN, 'routed to human review'],
  ['[REPLY: Question', 'question handling note'],
  [MANUAL_HOLD_TAG, 'terminalState.manualHold'],
  ['[RESUME:', 'manual hold resume instant'],
  ['[BOUNCED', 'terminalState.bounced'],
  ['[STAFFING HIGH]', 'research confidence'], ['[STAFFING MEDIUM]', 'research confidence'], ['[STAFFING LOW]', 'research confidence'],
]);

function buildLegacyTags(notes) {
  const out = [];
  for (const match of String(notes || '').matchAll(/\[[^\]]{1,200}\]/g)) {
    const tag = match[0];
    const known = LEGACY_TAG_MEANINGS.find(([prefix]) => tag.toUpperCase().startsWith(prefix.replace(/\]$/, '').toUpperCase()));
    out.push({ tag: tag.length > 120 ? `${tag.slice(0, 117)}...]` : tag, meaning: known ? known[1] : 'unrecognized' });
  }
  return out;
}

function buildResearch({ lead, ledgerRows, turns, family }) {
  if (!lead) return { provenance: null, family: family || null, openingLine: null, openingLineSource: null, icpFit: null, confidenceTag: null, facts: [] };
  const stored = storedResearch(lead, ledgerRows);
  let openingLine = stored.opening || null;
  let openingLineSource = openingLine ? 'lead_record' : null;
  if (!openingLine && family === CAMPAIGN_FAMILY.STAFFING) {
    const step1 = turns.find(turn => turn.direction === 'outbound' && turn.actionType === 'cold_step_1' && turn.contentAvailable);
    const paragraphs = step1 ? step1.content.split(/\n\s*\n/) : [];
    // Locked staffing Email 1: greeting, then the opening, then the offer line.
    if (paragraphs.length >= 3 && /^Hi\b/.test(paragraphs[0].trim())) {
      openingLine = paragraphs[1].trim();
      openingLineSource = 'delivered_step1_body';
    }
  }
  return {
    provenance: 'stored_personalization_research',
    family: family || null,
    openingLine,
    openingLineSource,
    icpFit: stored.icpFit || null,
    confidenceTag: stored.confidenceTag || null,
    facts: stored.facts.map(fact => ({ kind: fact.kind, value: fact.value })),
  };
}

function buildThread({ lead, ledgerRows, turns }) {
  const threadIds = uniq(turns.map(turn => turn.threadId));
  const latestInbound = [...turns].reverse().find(turn => turn.direction === 'inbound' && turn.threadId);
  const latestAny = [...turns].reverse().find(turn => turn.threadId);
  // The sender proof stage sequences already use: one proven mailbox or none.
  const proof = lead ? provenSequenceSenderId(lead, ledgerRows) : { ok: false, reason: 'no ColdEmail record' };
  const observed = uniq(turns.filter(turn => turn.direction === 'outbound').map(turn => turn.senderInboxId)).sort();
  let ownershipStatus = 'unproven';
  if (proof.ok) ownershipStatus = 'proven';
  else if (/conflict/.test(String(proof.reason || ''))) ownershipStatus = 'conflict';
  return {
    primaryThreadId: (latestInbound || latestAny || {}).threadId || null,
    threadIds,
    senderInboxId: proof.ok ? proof.senderInboxId : null,
    senderProof: { ok: proof.ok === true, senderInboxId: proof.senderInboxId || null, reason: proof.reason || null },
    leadSenderInboxId: lead ? String(lead.senderInboxId || '') || null : null,
    observedSenderInboxIds: observed,
    ownershipStatus,
  };
}

// ── 9. warnings ─────────────────────────────────────────────────────────────

function buildWarnings({ normalized, turns, rows, lead, notes, qualification, booking, terminal, thread, family, extra }) {
  const warnings = [...extra];
  for (const dup of normalized.duplicates) {
    warnings.push({ code: 'duplicate_event_rows', detail: `${dup.copies} rows share event id ${dup.eventId}${dup.identical ? '' : ' with different content'}`, evidence: [{ source: 'ledger', eventId: dup.eventId, eventType: null, messageId: null, occurredAt: null }] });
  }
  for (const eventId of normalized.invalidTimestamps) {
    const row = rows.find(item => item.eventId === eventId);
    warnings.push({ code: 'invalid_timestamp', detail: `unusable occurredAt "${row ? row.occurredAtRaw : ''}"`, evidence: [{ source: 'ledger', eventId, eventType: row ? row.eventType : null, messageId: null, occurredAt: null }] });
  }
  for (const eventId of normalized.unparseableMetadata) {
    warnings.push({ code: 'metadata_unparseable', detail: 'metadata is not valid JSON; treated as empty', evidence: [{ source: 'ledger', eventId, eventType: null, messageId: null, occurredAt: null }] });
  }
  for (const turn of turns) {
    if (turn.actor === 'human' && !turn.contentAvailable) {
      warnings.push({ code: 'human_reply_text_unavailable', detail: turn.contentUnavailableReason, evidence: [turnRef(turn)] });
    }
    if (turn.actor === 'automation' && !turn.contentAvailable) {
      warnings.push({ code: 'outbound_content_unavailable', detail: turn.contentUnavailableReason, evidence: [turnRef(turn)] });
    }
    if (turn.direction === 'inbound' && turn.fromOtherAddress) {
      warnings.push({ code: 'inbound_from_other_address', detail: 'the reply came from an address other than the lead\'s', evidence: [turnRef(turn)] });
    }
    if (turn.direction === 'inbound' && turn.decision.status === 'evaluated_decision_missing') {
      warnings.push({ code: 'reply_decision_missing', detail: 'gmail_reply_evaluated names a reply decision that is not in the ledger', evidence: [turnRef(turn)] });
    }
  }
  if (thread.ownershipStatus === 'conflict') {
    warnings.push({ code: 'sender_ownership_conflict', detail: thread.senderProof.reason, evidence: [] });
  }
  if (thread.threadIds.length > 1) {
    warnings.push({ code: 'multiple_threads', detail: `${thread.threadIds.length} Gmail threads carry this conversation`, evidence: [] });
  }
  if (lead && thread.leadSenderInboxId && thread.observedSenderInboxIds.some(id => id !== thread.leadSenderInboxId)) {
    warnings.push({ code: 'sender_mismatch', detail: `lead is pinned to ${thread.leadSenderInboxId} but outbound was observed from ${thread.observedSenderInboxIds.join(', ')}`, evidence: [] });
  }
  if (qualification.applicable) {
    const automated = turns.filter(turn => turn.actor === 'automation');
    const has = action => automated.some(turn => turn.actionType === action);
    if (notes.includes(STAFFING_NOTE.QUALIFIED) && !has(ACTION.AUTO_STAFFING_QUALIFIED)) {
      warnings.push({ code: 'qualified_tag_without_delivery', detail: '[STAFFING QUALIFIED] is present but no delivered qualified reply is in the ledger', evidence: [noteRef(STAFFING_NOTE.QUALIFIED)] });
    }
    if (notes.includes(STAFFING_NOTE.INFO_SENT) && !has(ACTION.AUTO_STAFFING_SEND_INFO)) {
      warnings.push({ code: 'info_sent_tag_without_delivery', detail: '[STAFFING INFO SENT] is present but no delivered info reply is in the ledger', evidence: [noteRef(STAFFING_NOTE.INFO_SENT)] });
    }
    if (notes.includes(STAFFING_NOTE.QUALIFY_ASKED) && !has(ACTION.AUTO_STAFFING_QUALIFY_QUESTION) && !has(ACTION.AUTO_STAFFING_SEND_INFO)) {
      warnings.push({ code: 'qualify_asked_tag_without_delivery', detail: '[STAFFING QUALIFY ASKED] is present but no delivered qualification question is in the ledger', evidence: [noteRef(STAFFING_NOTE.QUALIFY_ASKED)] });
    }
    for (const [action, tag] of [[ACTION.AUTO_STAFFING_QUALIFIED, STAFFING_NOTE.QUALIFIED], [ACTION.AUTO_STAFFING_SEND_INFO, STAFFING_NOTE.INFO_SENT], [ACTION.AUTO_STAFFING_QUALIFY_QUESTION, STAFFING_NOTE.QUALIFY_ASKED]]) {
      if (has(action) && !notes.includes(tag)) {
        warnings.push({ code: 'delivered_reply_without_tag', detail: `${action} was delivered but ${tag} is missing from notes`, evidence: automated.filter(turn => turn.actionType === action).map(turnRef) });
      }
    }
  }
  // A link sent while a booking was live: the last call event before it was a
  // booking, not a cancellation, no-show or completion. Rebooking after a
  // resolved call is expected and is not flagged.
  for (const link of booking.linkSent.evidence) {
    if (!link.occurredAt) continue;
    const before = booking.call.evidence.filter(item => item.occurredAt && item.occurredAt < link.occurredAt);
    const last = before[before.length - 1];
    if (last && CALL_BOOKING_EVENTS.includes(last.eventType)) {
      warnings.push({ code: 'booking_link_while_meeting_booked', detail: 'a booking link was sent while a meeting was already booked', evidence: [last, link] });
    }
  }
  // The same cold step recorded more than once in one thread. Without a shared
  // provider id the records cannot be proven to be one message, so they stay
  // separate turns and the duplication is reported instead of merged.
  const stepRecords = new Map();
  for (const turn of turns) {
    if (turn.actor !== 'automation' || !/^cold_step_\d+$/.test(turn.actionType || '')) continue;
    const key = `${turn.actionType}|${turn.threadId || ''}`;
    stepRecords.set(key, [...(stepRecords.get(key) || []), turn]);
  }
  for (const group of stepRecords.values()) {
    if (group.length < 2) continue;
    const withoutId = group.filter(turn => !turn.messageId).length;
    warnings.push({
      code: 'cold_step_recorded_more_than_once',
      detail: `${group[0].actionType} has ${group.length} records in one thread${withoutId ? `; ${withoutId} without a provider id` : ' with distinct provider ids'}`,
      evidence: group.map(turnRef),
    });
  }
  if (booking.call.meetingAt && !booking.call.evidence.length) {
    warnings.push({ code: 'meeting_without_call_event', detail: 'the board has a meeting time but no call lifecycle event records it', evidence: [] });
  }
  // Automation after the conversation said stop, or after a person took over.
  const terminalAt = uniq([...terminal.unsubscribed.evidence, ...terminal.notInterested.evidence]
    .map(item => item.occurredAt)).sort()[0] || null;
  const humanAt = turns.find(turn => turn.actor === 'human');
  for (const turn of turns) {
    if (turn.actor !== 'automation' || !turn.occurredAt) continue;
    if (terminalAt && turn.occurredAt > terminalAt) {
      warnings.push({ code: 'automation_after_opt_out', detail: `${turn.actionType} was sent after an opt-out or rejection`, evidence: [turnRef(turn)] });
    }
    if (humanAt && humanAt.occurredAt && turn.occurredAt > humanAt.occurredAt && turn.inReplyToMessageId) {
      warnings.push({ code: 'automation_after_human_takeover', detail: `${turn.actionType} answered the prospect after a human had replied`, evidence: [turnRef(turn), turnRef(humanAt)] });
    }
  }
  // Warm-reply reservations with neither a delivery nor a failure.
  for (const row of rows.filter(item => item.eventType === 'prospect_reply_reserved')) {
    const actionId = String(row.metadata.actionId || '');
    const delivered = rows.some(item => item.eventType === 'booking_link_sent' && item.eventId === actionId);
    const failed = rows.some(item => item.eventType === 'prospect_reply_failed' && String(item.metadata.reservationEventId || '') === row.eventId);
    if (!delivered && !failed) {
      warnings.push({ code: 'unresolved_reply_reservation', detail: 'a warm-reply send was reserved but neither delivery nor failure is recorded', evidence: [evidenceRef(row)] });
    }
  }
  if (lead) {
    const stepTurns = turns.filter(turn => /^cold_step_\d+$/.test(turn.actionType || ''));
    const recordedSteps = new Set(stepTurns.map(turn => turn.actionType));
    const highestRecorded = Math.max(0, ...stepTurns.map(turn => Number(turn.actionType.slice('cold_step_'.length)) || 0));
    const leadStep = Number(lead && lead.emailStep) || 0;
    if (leadStep > recordedSteps.size) {
      warnings.push({ code: 'cold_steps_missing_from_ledger', detail: `lead is at step ${leadStep} but ${recordedSteps.size} cold step(s) are in the ledger`, evidence: [] });
    }
    // The reverse: a delivered step the lead row does not reflect.
    if (highestRecorded > leadStep) {
      warnings.push({ code: 'lead_row_behind_ledger', detail: `the ledger records cold step ${highestRecorded} delivered but the lead row is at step ${leadStep}`, evidence: stepTurns.map(turnRef) });
    }
  }
  return warnings;
}

// ── 10. the builder ─────────────────────────────────────────────────────────

/**
 * Build the conversation state for one lead.
 *
 * @param lead            ColdEmail row (the sending twin), or null
 * @param boardLead       Leads (Pipeline) row, or null
 * @param activities      ledger rows for this conversation (see
 *                        conversation-evidence.selectConversationEvidence)
 * @param suppressedEmails Set of suppressed addresses
 * @param messageTexts    optional { [gmailMessageId]: { text, source } } for
 *                        human replies reconstructed from the provider
 * @param config          { sequencesEnabled, sendingEnabled, bookingUrls }
 * @param selection       optional: how conversation-evidence selected the rows
 * @param now             required; the clock the builder reads (production's
 *                        sendSuppressionReason still reads the wall clock for a
 *                        manual hold's resume instant)
 */
function buildConversationState({
  lead = null, boardLead = null, activities = [], suppressedEmails = new Set(),
  messageTexts = {}, config = {}, selection = null, now,
} = {}) {
  const asOf = isoOrNull(now instanceof Date ? now.toISOString() : now);
  if (!asOf) throw new TypeError('buildConversationState requires an explicit, valid `now`');
  if (!lead && !boardLead) throw new TypeError('buildConversationState requires a lead or a boardLead');
  const suppressed = suppressedEmails instanceof Set ? suppressedEmails : new Set(suppressedEmails || []);
  const family = familyOf(lead);
  const bookingUrls = uniq([...(config.bookingUrls || []), BOOKING_URL, family ? bookingUrlForFamily(family) : '']).sort();
  const settings = { sequencesEnabled: config.sequencesEnabled === true, sendingEnabled: config.sendingEnabled === true };
  const notes = text(lead && lead.notes);

  const normalized = normalizeConversationEvidence({ activities });
  const { rows, ledgerRows } = normalized;
  const { turns, recordedConversations, warnings: turnWarnings } = buildTurns({
    rows, ledgerRows, lead, boardLead, messageTexts: messageTexts || {},
  });
  const terminalState = buildTerminalState({ lead, boardLead, rows, turns, suppressedEmails: suppressed, now: asOf });
  const qualification = buildQualification({ lead, turns, notes, family });
  const { questions, objections, referral, ambiguities } = buildQuestionsAndObjections({ turns, rows, family, lead });
  // Terminal precedence: nothing on an opted-out, rejected, bounced or closed
  // conversation is open work. The evidence stays; only the status says so.
  if (terminalState.isTerminal) {
    for (const item of [...questions, ...objections]) {
      if (item.status === 'open' || item.status === 'handed_off') {
        item.status = 'closed_terminal';
        item.closedBy = terminalState.blockedBy;
      }
    }
  }
  if (notes.includes(NOTE_WRONG_PERSON) && referral.status === 'none') {
    referral.status = 'referred';
    referral.evidence.push({ messageId: null, occurredAt: null, source: 'notes_tag' });
  }
  const booking = buildBooking({ turns, rows, ledgerRows, boardLead, notes, bookingUrls, now: asOf });
  const owned = buildOwnership({
    lead, boardLead, ledgerRows, suppressedEmails: suppressed, config: settings, now: asOf, turns, family,
  });
  const responseState = buildResponseState({ lead, rows, turns, operational: owned.operational, answeredAt: owned.answeredAtIso });
  const thread = buildThread({ lead, ledgerRows, turns });

  for (const turn of turns) {
    if (turn.direction === 'inbound' && !turn.classification.value && !turn.canonicalState) {
      ambiguities.push({ code: 'legacy_inbound_without_classification', messageId: turn.messageId, detail: 'no decision, evaluation or stored classification describes this message' });
    }
    if (turn.direction === 'inbound' && turn.decision.status === 'not_evaluated') {
      ambiguities.push({ code: 'inbound_not_evaluated', messageId: turn.messageId, detail: 'no reply decision or evaluation is recorded; it may be pending, historical, or skipped' });
    }
  }

  const evidenceWarnings = buildWarnings({
    normalized, turns, rows, lead, notes, qualification, booking, terminal: terminalState, thread, family,
    extra: [...((selection && selection.warnings) || []), ...turnWarnings, ...owned.warnings],
  });

  const decided = turns.filter(turn => turn.direction === 'inbound');
  const rowsByType = {};
  for (const row of rows) rowsByType[row.eventType || '(blank)'] = (rowsByType[row.eventType || '(blank)'] || 0) + 1;

  const evidenceDigest = sha256({
    lead: lead ? { id: lead.id, email: norm(lead.email), stage: lead.stage, emailStatus: lead.emailStatus, emailStep: lead.emailStep, notes, senderInboxId: lead.senderInboxId, campaign: lead.campaign } : null,
    board: boardLead ? { id: boardLead.id, stage: boardLead.stage, meetingAt: boardLead.meetingAt, outcome: boardLead.outcome, followup: boardLead.followup } : null,
    rows: rows.map(row => [row.eventId, row.eventType, row.occurredAt, row.content, stableStringify(row.metadata)]),
    suppressed: Boolean(lead && suppressed.has(norm(lead.email))),
    texts: Object.keys(messageTexts || {}).sort().map(id => [id, sha256(String((messageTexts[id] || {}).text || ''))]),
    config: { ...settings, bookingUrls },
  });

  return {
    version: CONVERSATION_STATE_VERSION,
    asOf,
    evidenceDigest,
    identity: {
      leadId: lead ? String(lead.id || '') : null,
      boardLeadId: boardLead ? String(boardLead.id || '') : null,
      email: norm((lead && lead.email) || (boardLead && boardLead.email)) || null,
      company: String((lead && lead.company) || (boardLead && boardLead.company) || '') || null,
      contactName: String((lead && lead.contactName) || [boardLead && boardLead.first, boardLead && boardLead.last].filter(Boolean).join(' ') || '') || null,
      family: family || null,
      campaign: lead ? String(lead.campaign || '') || null : null,
      coldStage: lead ? String(lead.stage || '') || null : null,
      boardStage: boardLead ? displayStageFor(boardLead.stage) : null,
      boardStageRaw: boardLead ? String(boardLead.stage || '') || null : null,
      emailStatus: lead ? String(lead.emailStatus || '') || null : null,
      emailStep: lead ? Number(lead.emailStep) || 0 : null,
    },
    thread,
    terminalState,
    turns,
    latest: {
      inbound: latestOf(turns, turn => turn.direction === 'inbound'),
      prospectMessage: latestOf(turns, isProspectMessage),
      outbound: latestOf(turns, turn => turn.direction === 'outbound'),
      humanOutbound: latestOf(turns, turn => turn.actor === 'human'),
      automatedOutbound: latestOf(turns, turn => turn.actor === 'automation'),
    },
    recordedConversations,
    qualification,
    questions,
    objections,
    referral,
    booking,
    responseState,
    ownership: owned.ownership,
    operational: owned.operational,
    decisionCoverage: {
      inboundTurns: decided.length,
      recorded: decided.filter(turn => turn.decision.status === 'recorded').length,
      legacyEvaluated: decided.filter(turn => turn.decision.status === 'legacy_evaluated').length,
      decisionMissing: decided.filter(turn => turn.decision.status === 'evaluated_decision_missing').length,
      notEvaluated: decided.filter(turn => turn.decision.status === 'not_evaluated').length,
    },
    research: buildResearch({ lead, ledgerRows, turns, family }),
    legacyTags: buildLegacyTags(notes),
    evidenceWarnings,
    ambiguities,
    sources: {
      rowsConsidered: rows.length,
      duplicateRowsDropped: normalized.duplicates.reduce((sum, dup) => sum + dup.copies - 1, 0),
      rowsByType: Object.fromEntries(Object.keys(rowsByType).sort().map(key => [key, rowsByType[key]])),
      selection: selection ? { requestedId: selection.requestedId || null, counts: selection.counts || null } : null,
      modelOutputsUsed: false,
      precedence: EVIDENCE_PRECEDENCE,
    },
  };
}

module.exports = {
  CONVERSATION_STATE_VERSION, EVIDENCE_PRECEDENCE, QUALIFICATION_SLOTS,
  normalizeConversationEvidence, buildConversationState, stableStringify,
};
