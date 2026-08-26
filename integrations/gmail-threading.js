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

async function findOriginalSentThread({ gmail, email, expectedSubject, maxResults = 20 } = {}) {
  if (!gmail || !email || !expectedSubject) return null;
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: `in:sent to:"${escapeGmailQuery(email)}" subject:"${escapeGmailQuery(expectedSubject)}"`,
    maxResults,
  });
  const candidates = [];
  for (const stub of response.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: 'me', id: stub.id, format: 'full' });
    const message = full.data || {};
    const subject = headerValue(message.payload, 'Subject');
    if (subject !== expectedSubject) continue;
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

module.exports = { headerValue, appendReference, escapeGmailQuery, decodeBody, findOriginalSentThread };
