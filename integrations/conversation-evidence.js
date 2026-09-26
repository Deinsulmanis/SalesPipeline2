'use strict';

/**
 * conversation-evidence.js — gather one conversation's evidence for
 * conversation-state.js.
 *
 * indexConversationEvidence and selectConversationEvidence work on a snapshot
 * that is already in memory (the dashboard's cached dataset, or one Sheets
 * batchGet), so building many conversations costs no extra reads.
 *
 * loadHumanReplyTexts is the one provider read, and it is opt-in: it fetches
 * up to `limit` recorded human replies from Gmail, read-only, and accepts a
 * body only when the message is provably the one the ledger recorded — SENT,
 * from the recorded mailbox, in the recorded thread. Nothing here writes.
 */

const { headerValue, parseAddr, firstPlainText, decodeBodies } = require('./gmail-mailbox-observer');
const { stripQuotedReply } = require('./reply-reconciliation');

const HUMAN_TEXT_LIMIT = 1500;
const DEFAULT_HUMAN_FETCH_LIMIT = 10;

const norm = value => String(value || '').trim().toLowerCase();

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')) || {}; } catch (_) { return {}; }
}

function push(map, key, value) {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** One pass over the snapshot; every later selection is a map lookup. */
function indexConversationEvidence({ leads = [], boardLeads = [], activities = [] } = {}) {
  const leadsById = new Map();
  const leadsByEmail = new Map();
  for (const lead of leads || []) {
    const id = String((lead && lead.id) || '').trim();
    if (!id) continue;
    if (!leadsById.has(id)) leadsById.set(id, lead);
    push(leadsByEmail, norm(lead.email), lead);
  }
  const boardById = new Map();
  const boardByEmail = new Map();
  for (const board of boardLeads || []) {
    const id = String((board && board.id) || '').trim();
    if (!id) continue;
    if (!boardById.has(id)) boardById.set(id, board);
    push(boardByEmail, norm(board.email), board);
  }
  const rowsByLeadId = new Map();
  const rowsByBoardId = new Map();
  const rowsByEmail = new Map();
  for (const row of activities || []) {
    if (!row) continue;
    const source = String(row.sourceLeadId || '').trim();
    const leadId = String(row.leadId || '').trim();
    push(rowsByLeadId, source, row);
    if (leadId.startsWith('CE-')) push(rowsByLeadId, leadId.slice(3), row);
    push(rowsByBoardId, leadId, row);
    push(rowsByEmail, norm(row.email), row);
  }
  return { leadsById, leadsByEmail, boardById, boardByEmail, rowsByLeadId, rowsByBoardId, rowsByEmail };
}

/**
 * The lead, its Pipeline card and the ledger rows that belong to this one
 * conversation. `id` may be a ColdEmail id, `CE-<id>`, or a Pipeline id.
 *
 * Rows are matched by lead id, by Pipeline id, and by email. An email match is
 * used only when that address belongs to exactly one ColdEmail lead, and a row
 * that names a DIFFERENT ColdEmail lead is never borrowed.
 */
function selectConversationEvidence(index, id) {
  const key = String(id || '').trim();
  const warnings = [];
  let lead = index.leadsById.get(key) || (key.startsWith('CE-') ? index.leadsById.get(key.slice(3)) : null) || null;
  let boardLead = index.boardById.get(key) || null;
  if (lead && !boardLead) boardLead = index.boardById.get(`CE-${lead.id}`) || null;

  const uniqueByEmail = (map, email) => {
    const bucket = map.get(norm(email)) || [];
    return bucket.length === 1 ? bucket[0] : null;
  };
  if (!lead && boardLead) {
    lead = index.leadsById.get(String(boardLead.id).replace(/^CE-/, '')) || uniqueByEmail(index.leadsByEmail, boardLead.email);
  }
  if (lead && !boardLead) boardLead = uniqueByEmail(index.boardByEmail, lead.email);
  if (!lead && !boardLead) return { lead: null, boardLead: null, activities: [], selection: null };

  const email = norm((lead && lead.email) || (boardLead && boardLead.email));
  const sharing = (index.leadsByEmail.get(email) || []).filter(other => !lead || other.id !== lead.id);
  if (sharing.length) {
    warnings.push({ code: 'email_shared_with_other_leads', detail: `${sharing.length} other ColdEmail lead(s) use this address; email-only matches were not used`, evidence: sharing.map(other => ({ source: 'coldemail_lead', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: String(other.id) })) });
  }
  const boards = (index.boardByEmail.get(email) || []);
  if (boards.length > 1) {
    warnings.push({ code: 'multiple_pipeline_cards', detail: `${boards.length} Pipeline cards use this address`, evidence: boards.map(board => ({ source: 'pipeline_card', eventId: null, eventType: null, messageId: null, occurredAt: null, detail: String(board.id) })) });
  }

  const ownIds = new Set([lead && String(lead.id)].filter(Boolean));
  const ownBoardIds = new Set([lead && `CE-${lead.id}`, boardLead && String(boardLead.id)].filter(Boolean));
  const foreign = (row) => {
    const source = String(row.sourceLeadId || '').trim();
    const leadId = String(row.leadId || '').trim();
    if (source && !ownIds.has(source)) return true;
    if (leadId.startsWith('CE-') && !ownBoardIds.has(leadId) && !ownIds.has(leadId.slice(3))) return true;
    return false;
  };
  const picked = new Map();
  const counts = { byLeadId: 0, byPipelineId: 0, byEmailOnly: 0, foreignExcluded: 0 };
  const take = (row, via) => {
    const rowKey = row;
    if (picked.has(rowKey)) return;
    if (foreign(row)) { counts.foreignExcluded += 1; return; }
    picked.set(rowKey, row);
    counts[via] += 1;
  };
  for (const id of ownIds) for (const row of index.rowsByLeadId.get(id) || []) take(row, 'byLeadId');
  for (const id of ownBoardIds) for (const row of index.rowsByBoardId.get(id) || []) take(row, 'byPipelineId');
  if (email && !sharing.length) for (const row of index.rowsByEmail.get(email) || []) take(row, 'byEmailOnly');

  return {
    lead,
    boardLead,
    activities: [...picked.values()],
    selection: { requestedId: key, leadId: lead ? String(lead.id) : null, boardLeadId: boardLead ? String(boardLead.id) : null, counts, warnings },
  };
}

/**
 * Reconstruct recorded human replies from Gmail, read-only and bounded.
 * `mailboxFor(senderInboxId)` returns { email, gmail } (the server's
 * operationalMailbox). Returns { texts, failures, attempted, providerCalls,
 * skippedOverLimit }; providerCalls counts actual Gmail requests.
 */
async function loadHumanReplyTexts({ activities = [], mailboxFor, limit = DEFAULT_HUMAN_FETCH_LIMIT } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const row of activities || []) {
    if (String(row.eventType || '') !== 'human_response_sent') continue;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || '').trim();
    if (!messageId || seen.has(messageId) || String(row.content || '').trim()) continue;
    seen.add(messageId);
    candidates.push({ messageId, threadId: String(meta.gmailThreadId || '').trim(),
      senderInboxId: String(meta.senderInboxId || '').trim(), occurredAt: String(row.occurredAt || '') });
  }
  // Most recent first: the latest human reply matters most to the conversation.
  candidates.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  const bounded = candidates.slice(0, Math.max(0, Number(limit) || 0));
  const texts = {};
  const failures = [];
  let providerCalls = 0;
  for (const item of bounded) {
    // No recorded mailbox means no provable source: the loader never guesses.
    if (!item.senderInboxId) { failures.push({ messageId: item.messageId, reason: 'mailbox_not_recorded' }); continue; }
    let mailbox;
    try { mailbox = mailboxFor(item.senderInboxId); } catch (_) {
      failures.push({ messageId: item.messageId, reason: 'mailbox_unavailable' });
      continue;
    }
    try {
      providerCalls += 1;
      const response = await mailbox.gmail.users.messages.get({ userId: 'me', id: item.messageId, format: 'full' });
      const message = response && response.data ? response.data : {};
      if (!(message.labelIds || []).includes('SENT')) { failures.push({ messageId: item.messageId, reason: 'not_a_sent_message' }); continue; }
      if (parseAddr(headerValue(message.payload, 'From')) !== norm(mailbox.email)) {
        failures.push({ messageId: item.messageId, reason: 'sender_mismatch' });
        continue;
      }
      if (item.threadId && String(message.threadId || '') !== item.threadId) {
        failures.push({ messageId: item.messageId, reason: 'thread_mismatch' });
        continue;
      }
      const body = stripQuotedReply(firstPlainText(message.payload) || decodeBodies(message.payload) || '').trim();
      if (!body) { failures.push({ messageId: item.messageId, reason: 'empty_body' }); continue; }
      texts[item.messageId] = { text: body.slice(0, HUMAN_TEXT_LIMIT), source: 'gmail_provider_message' };
    } catch (error) {
      const status = Number(error && (error.code || (error.response && error.response.status)));
      failures.push({ messageId: item.messageId, reason: status === 404 ? 'message_not_found' : 'provider_error' });
    }
  }
  return {
    texts, failures, attempted: bounded.length, providerCalls,
    skippedOverLimit: Math.max(0, candidates.length - bounded.length),
  };
}

module.exports = {
  HUMAN_TEXT_LIMIT, DEFAULT_HUMAN_FETCH_LIMIT,
  indexConversationEvidence, selectConversationEvidence, loadHumanReplyTexts,
};
