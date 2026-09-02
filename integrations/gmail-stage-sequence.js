'use strict';

const crypto = require('crypto');

function sequenceRfcMessageId(eventId, senderEmail) {
  const digest = crypto.createHash('sha256').update(String(eventId)).digest('hex').slice(0, 32);
  const domain = String(senderEmail || '').split('@')[1] || 'scalelabai.ca';
  return `<stage-sequence-${digest}@${domain}>`;
}

function header(payload, name) {
  return ((payload && payload.headers) || [])
    .find(item => String(item.name || '').toLowerCase() === String(name).toLowerCase())?.value || '';
}

function addresses(value) {
  return String(value || '').split(',').map(part => {
    const match = /<([^>]+)>/.exec(part);
    return String(match ? match[1] : part).trim().toLowerCase();
  }).filter(Boolean);
}

async function verifyThreadOwnership({ gmail, threadId, senderEmail, recipientEmail }) {
  if (!gmail || !threadId || !senderEmail || !recipientEmail) {
    return { ok: false, reason: 'thread verification inputs are incomplete' };
  }
  try {
    const response = await gmail.users.threads.get({
      userId: 'me', id: threadId, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Message-ID'],
    });
    const sender = String(senderEmail).trim().toLowerCase();
    const recipient = String(recipientEmail).trim().toLowerCase();
    const messages = response.data.messages || [];
    const outbound = messages.filter(message => {
      const from = addresses(header(message.payload, 'From'));
      const to = addresses(header(message.payload, 'To'));
      return from.includes(sender) && to.includes(recipient);
    });
    if (!outbound.length) return { ok: false, reason: 'thread does not contain an outbound message from the owning mailbox to this lead' };
    const latest = outbound.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))[0];
    return {
      ok: true, threadId, rfcMessageId: header(latest.payload, 'Message-ID'),
      providerMessageId: latest.id || '',
    };
  } catch (error) {
    return { ok: false, reason: `thread is not readable in the owning mailbox: ${error.message}` };
  }
}

async function findSuccessfulSequenceSend({ gmail, rfcMessageId }) {
  if (!gmail || !rfcMessageId) return null;
  const response = await gmail.users.messages.list({
    userId: 'me', q: `in:sent rfc822msgid:${rfcMessageId}`, maxResults: 1,
  });
  const stub = (response.data.messages || [])[0];
  if (!stub) return null;
  const full = await gmail.users.messages.get({
    userId: 'me', id: stub.id, format: 'metadata', metadataHeaders: ['Message-ID'],
  });
  return {
    providerMessageId: full.data.id || stub.id,
    threadId: full.data.threadId || '',
    rfcMessageId: header(full.data.payload, 'Message-ID') || rfcMessageId,
    occurredAt: Number(full.data.internalDate)
      ? new Date(Number(full.data.internalDate)).toISOString() : null,
  };
}

module.exports = { sequenceRfcMessageId, verifyThreadOwnership, findSuccessfulSequenceSend };
