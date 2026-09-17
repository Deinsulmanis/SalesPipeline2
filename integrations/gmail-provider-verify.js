'use strict';

// Positive Gmail proof for an already-known provider message id.
// A lookup miss, timeout, or 5xx is NOT proof of non-send and must never
// make an action sendable.

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

function httpStatus(error) {
  return Number(error?.response?.status || error?.code || 0);
}

function verifyFailure(code, reason) {
  return { ok: false, code, reason, retryableSend: false };
}

async function verifyGmailSentMessage({
  gmail, providerMessageId, expectedSenderEmail, expectedRecipientEmail,
}) {
  const id = String(providerMessageId || '').trim();
  if (!id) return verifyFailure('provider_id_missing', 'provider_message_id is missing; Gmail cannot be verified');
  const sender = String(expectedSenderEmail || '').trim().toLowerCase();
  const recipient = String(expectedRecipientEmail || '').trim().toLowerCase();
  if (!gmail || !sender || !recipient) {
    return verifyFailure('gmail_verify_inputs_incomplete', 'Gmail verification requires mailbox, sender, and recipient');
  }
  let response;
  try {
    response = await gmail.users.messages.get({
      userId: 'me', id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID'],
    });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404) {
      return verifyFailure('gmail_message_not_found', 'Gmail did not return this provider message id; this is not proof of non-send');
    }
    if (!status || status >= 500 || [408, 409, 429].includes(status)) {
      return verifyFailure('gmail_lookup_ambiguous', `Gmail lookup is ambiguous (${error.message || status || 'network'}); this is not proof of non-send`);
    }
    return verifyFailure('gmail_lookup_failed', `Gmail lookup failed: ${error.message || status}`);
  }
  const message = response?.data;
  if (!message || !message.id) {
    return verifyFailure('gmail_message_not_found', 'Gmail did not return this provider message id; this is not proof of non-send');
  }
  const from = addresses(header(message.payload, 'From'));
  const recipients = [...addresses(header(message.payload, 'To')), ...addresses(header(message.payload, 'Cc'))];
  if (!(message.labelIds || []).includes('SENT')) {
    return verifyFailure('gmail_not_in_sent', 'Gmail message is not in SENT');
  }
  if (!from.includes(sender)) {
    return verifyFailure('gmail_sender_mismatch', 'Gmail From does not match the expected sender mailbox');
  }
  if (!recipients.includes(recipient)) {
    return verifyFailure('gmail_recipient_mismatch', 'Gmail recipients do not include the expected lead address');
  }
  const occurredAt = Number(message.internalDate)
    ? new Date(Number(message.internalDate)).toISOString() : '';
  if (!occurredAt) {
    return verifyFailure('gmail_timestamp_unusable', 'Gmail message has no trustworthy provider timestamp');
  }
  return {
    ok: true,
    code: 'gmail_sent_verified',
    retryableSend: false,
    providerMessageId: message.id,
    threadId: message.threadId || '',
    rfcMessageId: header(message.payload, 'Message-ID'),
    subject: header(message.payload, 'Subject'),
    occurredAt,
    senderEmail: sender,
    recipientEmail: recipient,
    labelIds: message.labelIds || [],
  };
}

module.exports = { verifyGmailSentMessage, header, addresses };
