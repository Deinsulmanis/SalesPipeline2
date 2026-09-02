'use strict';

function headerValue(payload, name) {
  const header = (payload?.headers || []).find(item => String(item.name || '').toLowerCase() === String(name || '').toLowerCase());
  return header?.value || '';
}

function appendReference(existing, messageId) {
  const values = `${existing || ''} ${messageId || ''}`.trim().split(/\s+/).filter(Boolean);
  return [...new Set(values)].join(' ');
}

function escapeGmailQuery(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function decodeBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8').trim();
  }
  for (const part of payload.parts || []) {
    const body = decodeBody(part);
    if (body) return body;
  }
  if (!payload.mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8').trim();
  }
  return '';
}

function parseMetadata(value) {
  try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '{}')); }
  catch (_) { return {}; }
}

function normalizeMailbox(value) {
  const match = String(value || '').match(/<([^<>\s]+@[^<>\s]+)>/);
  return String(match ? match[1] : value || '').trim().toLowerCase();
}

async function resolveColdFollowUpThread({ gmail, lead = {}, activities = [], expectedSenderId = '' } = {}) {
  const leadId = String(lead.id || '').trim();
  const email = normalizeMailbox(lead.email);
  if (!gmail || !leadId || !email) return null;
  const outboundTypes = new Set(['initial_email_sent', 'follow_up_sent']);
  const mine = activities.filter(row => outboundTypes.has(String(row.eventType || ''))
    && (String(row.sourceLeadId || '') === leadId || String(row.leadId || '') === `CE-${leadId}`));
  const initials = mine.filter(row => row.eventType === 'initial_email_sent');
  const originalSubjects = [...new Set(initials.map(row => String(row.subject || '').trim()).filter(Boolean))];
  if (!initials.length || originalSubjects.length !== 1) return null;

  const evidence = mine.map(row => ({ row, metadata: parseMetadata(row.metadata) }))
    .filter(item => item.metadata.gmailMessageId && item.metadata.gmailThreadId);
  const senderIds = [...new Set(evidence.map(item => String(item.metadata.senderInboxId || 'primary').trim()).filter(Boolean))];
  if (senderIds.length !== 1 || (expectedSenderId && senderIds[0] !== expectedSenderId)) return null;
  const threadIds = [...new Set(evidence.map(item => String(item.metadata.gmailThreadId).trim()).filter(Boolean))];
  if (!evidence.length || threadIds.length !== 1) return null;
  const threadId = threadIds[0];

  const conflictingOwner = activities.some(row => {
    if (!outboundTypes.has(String(row.eventType || ''))) return false;
    if (String(parseMetadata(row.metadata).gmailThreadId || '').trim() !== threadId) return false;
    return String(row.sourceLeadId || '') !== leadId && String(row.leadId || '') !== `CE-${leadId}`;
  });
  if (conflictingOwner) return null;

  evidence.sort((a, b) => new Date(b.row.occurredAt || 0) - new Date(a.row.occurredAt || 0));
  const latest = evidence[0];
  const response = await gmail.users.messages.get({ userId: 'me', id: latest.metadata.gmailMessageId, format: 'full' });
  const message = response.data || {};
  const messageId = headerValue(message.payload, 'Message-ID').trim();
  const recipient = normalizeMailbox(headerValue(message.payload, 'To'));
  if (!messageId || String(message.threadId || '') !== threadId || recipient !== email) return null;
  const originalSubject = originalSubjects[0].replace(/^Re:\s*/i, '');
  return {
    threadId,
    inReplyTo: messageId,
    references: appendReference(headerValue(message.payload, 'References'), messageId),
    subject: `Re: ${originalSubject}`,
    originalSubject,
    ...(expectedSenderId ? { senderInboxId: senderIds[0] } : {}),
  };
}

async function findOriginalSentThread({ gmail, email, expectedSubject, expectedSubjects, maxResults = 20 } = {}) {
  const subjects = [...new Set((expectedSubjects || [expectedSubject]).map(value => String(value || '').trim()).filter(Boolean))];
  if (!gmail || !email || !subjects.length) return null;
  const stubs = new Map();
  for (const expected of subjects) {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: `in:sent to:"${escapeGmailQuery(email)}" subject:"${escapeGmailQuery(expected)}"`,
      maxResults,
    });
    for (const stub of response.data.messages || []) stubs.set(stub.id, stub);
  }
  const candidates = [];
  for (const stub of stubs.values()) {
    const full = await gmail.users.messages.get({ userId: 'me', id: stub.id, format: 'full' });
    const message = full.data || {};
    const subject = headerValue(message.payload, 'Subject');
    if (!subjects.includes(subject)) continue;
    const messageId = headerValue(message.payload, 'Message-ID').trim();
    if (!message.threadId || !messageId) continue;
    candidates.push({
      threadId: message.threadId,
      inReplyTo: messageId,
      references: appendReference(headerValue(message.payload, 'References'), messageId),
      subject,
      content: decodeBody(message.payload),
      internalDate: Number(message.internalDate || 0),
    });
  }
  candidates.sort((a, b) => b.internalDate - a.internalDate);
  return candidates[0] || null;
}

module.exports = {
  headerValue, appendReference, escapeGmailQuery, decodeBody,
  findOriginalSentThread, resolveColdFollowUpThread,
};
