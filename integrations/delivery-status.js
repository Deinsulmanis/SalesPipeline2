'use strict';
/**
 * delivery-status.js — what a delivery-status notification proves about the RECIPIENT.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bounce suppresses a prospect permanently, so only positive recipient-side
 * evidence may produce one. Two notices are explicitly NOT that evidence:
 *
 *   delay        Gmail's "(Delay)" notice says "You'll be notified if the
 *                delivery fails permanently" — the bare word "permanent" once
 *                turned every delay into a hard bounce (Oct 3 2026 incident).
 *   sender auth  SPF/DKIM/DMARC/public-key failures (Microsoft 450 4.7.26 and
 *                friends) describe OUR domain, not their mailbox.
 *
 * Only the notice's own text is read: the message/delivery-status fields and
 * the human explanation. The returned original message is skipped — its
 * DKIM-Signature / Authentication-Results headers mention DKIM on every DSN.
 */

const DELIVERY_CLASS = Object.freeze({
  RECIPIENT_INVALID: 'recipient_invalid',
  SENDER_AUTH_FAILURE: 'sender_auth_failure',
  TEMPORARY_PROVIDER_DELAY: 'temporary_provider_delay',
  // A final failure whose status is still 4.x.x (retries expired): the message
  // was not delivered, but nothing says the address is bad.
  UNDELIVERED_TEMPORARY: 'undelivered_temporary',
  UNKNOWN: 'unknown',
});

// The existing hard-bounce vocabulary, unchanged. It is consulted only after
// delay and sender-auth notices have been ruled out.
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;

// X.7.23 SPF validation failed · X.7.25 sending IP has no valid reverse DNS ·
// X.7.26 unauthenticated mail (SPF/DKIM/DMARC). All describe the sender.
const SENDER_AUTH_STATUS = /^[45]\.7\.(?:23|25|26)$/;
const SENDER_AUTH_CODE = /\b[45]\.7\.(?:23|25|26)\b/;
const SENDER_AUTH_TEXT = [
  /must pass either spf or dkim/i,
  /this message is not signed/i,
  /unauthenticated (?:e-?mail|mail|message|sender)/i,
  /sender (?:domain )?authentication/i,
  /\b(?:spf|dkim|dmarc)\b[^.\n]{0,60}\b(?:fail\w*|did not pass|not pass|validation|reject\w*|policy)\b/i,
  /\b(?:fail\w*|did not pass)\b[^.\n]{0,60}\b(?:spf|dkim|dmarc)\b/i,
  /\bpublic key\b[^.\n]{0,40}\b(?:not found|invalid|fail\w*|missing|unavailable)\b/i,
];

const DELAY_SUBJECT = /\(delay\)|^delivery delayed|^delayed mail|^warning: (?:message|delayed)/i;
const DELAY_TEXT = /delivery (?:is )?incomplete|will (?:retry|keep trying|try again)|has been delayed|being delayed/i;

// Where an MTA inlines the returned message into its human text part.
const RETURNED_COPY = /^[ \t>-]*(?:-{2,}[^\n]*)?(?:this is a copy of the message|original message headers:|original message follows|the header of the original message|-+ ?original message ?-+|-+ ?forwarded message ?-+)/im;

const decode = data => Buffer.from(String(data || ''), 'base64url').toString('utf8');
const stripHtml = html => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const norm = value => String(value || '').trim().toLowerCase();

/** The notice's own parts — never the returned message. */
function noticeParts(payload) {
  const status = []; const plain = []; const html = [];
  const walk = (part, returned) => {
    if (!part) return;
    const type = norm(part.mimeType);
    const inReturned = returned || type === 'message/rfc822' || type === 'text/rfc822-headers' || type === 'message/rfc822-headers';
    if (!inReturned && part.body?.data) {
      const text = decode(part.body.data);
      if (type === 'message/delivery-status' || type === 'message/global-delivery-status') status.push(text);
      else if (type === 'text/html') html.push(stripHtml(text));
      else if (!type || type.startsWith('text/')) plain.push(text);
    }
    for (const child of part.parts || []) walk(child, inReturned);
  };
  walk(payload, false);
  const human = (plain.length ? plain : html).join('\n');
  const cut = human.search(RETURNED_COPY);
  return { status: status.join('\n'), human: cut >= 0 ? human.slice(0, cut) : human };
}

/** Per-recipient field blocks of an RFC 3464 report (or inline DSN fields). */
function recipientBlocks(text) {
  const blocks = [];
  let current = null; let lastField = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const continuation = /^[ \t]+\S/.test(raw) && current && lastField;
    if (continuation) { current[lastField] += ` ${raw.trim()}`; continue; }
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(raw.trim());
    if (!match) { lastField = ''; continue; }
    const field = match[1].toLowerCase();
    if (field === 'final-recipient' || (field === 'original-recipient' && (!current || current['final-recipient']))) {
      current = {}; blocks.push(current);
    }
    if (!current) { current = {}; blocks.push(current); }
    if (['final-recipient', 'original-recipient', 'action', 'status', 'diagnostic-code', 'will-retry-until'].includes(field)) {
      current[field] = current[field] ? `${current[field]} ${match[2]}` : match[2];
      lastField = field;
    } else lastField = '';
  }
  return blocks.filter(block => block.action || block.status || block['diagnostic-code']);
}

const recipientOf = block => norm(String(block['final-recipient'] || block['original-recipient'] || '').replace(/^[^;]*;/, ''));

/**
 * Classify one notice for one recipient.
 *
 * @param input    a Gmail message payload, or plain notice text
 * @param recipient the lead address (selects its block in a multi-recipient report)
 * @param subject  the notice subject, when known
 * @returns { category, action, status, final, senderAuth, recipientInvalid }
 */
function classifyDeliveryStatus(input, { recipient = '', subject = '' } = {}) {
  const parts = typeof input === 'string' ? { status: '', human: input } : noticeParts(input);
  const human = (() => { const cut = parts.human.search(RETURNED_COPY); return cut >= 0 ? parts.human.slice(0, cut) : parts.human; })();
  const all = recipientBlocks(`${parts.status}\n${human}`);
  const wanted = norm(recipient);
  const mine = wanted ? all.filter(block => recipientOf(block) === wanted) : [];
  // An address mentioned in the returned copy is not another DSN recipient.
  // Never borrow another recipient's failure when a structured report exists.
  const named = all.filter(block => recipientOf(block));
  if (wanted && named.length && !mine.length) return {
    category: DELIVERY_CLASS.UNKNOWN, action: '', status: '', final: false,
    senderAuth: false, recipientInvalid: false,
  };
  const blocks = mine.length ? mine : all;
  const actions = blocks.map(block => norm(block.action).split(/\s/)[0]).filter(Boolean);
  const statuses = blocks.map(block => (/\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(block.status || '') || [])[1]).filter(Boolean);
  const diagnostics = blocks.map(block => block['diagnostic-code'] || '').filter(Boolean).join('\n');
  const evidence = `${diagnostics}\n${named.length > 1 && mine.length ? '' : human}`;

  const action = actions.includes('failed') ? 'failed' : actions[0] || '';
  const status = statuses.find(code => code.startsWith('5.')) || statuses[0] || '';
  const senderAuth = statuses.some(code => SENDER_AUTH_STATUS.test(code))
    || SENDER_AUTH_CODE.test(evidence) || SENDER_AUTH_TEXT.some(pattern => pattern.test(evidence));
  const delayed = action === 'delayed'
    || (!action && (DELAY_SUBJECT.test(String(subject || '')) || DELAY_TEXT.test(human)));
  const final = !delayed && (action === 'failed' || !action);
  const result = (category, extra = {}) => ({ category, action, status, final, senderAuth,
    recipientInvalid: category === DELIVERY_CLASS.RECIPIENT_INVALID, ...extra });

  if (senderAuth) return result(DELIVERY_CLASS.SENDER_AUTH_FAILURE);
  if (delayed) return result(DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY);
  if (status.startsWith('5.') || PERMANENT_FAILURE.test(evidence)) return result(DELIVERY_CLASS.RECIPIENT_INVALID);
  if (action === 'failed' || status.startsWith('4.')) return result(DELIVERY_CLASS.UNDELIVERED_TEMPORARY);
  return result(DELIVERY_CLASS.UNKNOWN);
}

// ── Audited retraction of a misclassified bounce ─────────────────────────────
// email_bounced rows are append-only. A bounce the classifier invented is
// corrected by an email_bounce_retracted row naming it exactly; readers that
// count bounces skip the retracted event. Nothing is inferred: a malformed
// retraction retracts nothing.
const BOUNCE_RETRACTED_EVENT = 'email_bounce_retracted';
const RETRACTION_DECISION = 'retract_non_recipient_bounce';
const NON_RECIPIENT_CLASSES = new Set([DELIVERY_CLASS.SENDER_AUTH_FAILURE, DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY]);

const parseMeta = row => {
  if (row && typeof row.metadata === 'object' && row.metadata) return row.metadata;
  try { return JSON.parse(String((row && row.metadata) || '{}')) || {}; } catch (_) { return {}; }
};
const leadOf = row => String(row?.sourceLeadId || '').trim() || String(row?.leadId || '').replace(/^CE-/, '').trim();

function bounceRetractionEventId(bounceEventId) {
  return `bounce-retraction:${bounceEventId}`;
}

/** eventIds of email_bounced rows an audited retraction has withdrawn. PURE. */
function retractedBounceEventIds(activities = []) {
  const bounces = new Map();
  for (const row of activities || []) {
    if (row && String(row.eventType || row.event_type || '') === 'email_bounced' && row.eventId) bounces.set(String(row.eventId), row);
  }
  const retracted = new Set();
  for (const row of activities || []) {
    if (!row || String(row.eventType || row.event_type || '') !== BOUNCE_RETRACTED_EVENT) continue;
    const data = parseMeta(row);
    const target = String(data.retractsEventId || '').trim();
    const bounce = bounces.get(target);
    if (!bounce || row.eventId !== bounceRetractionEventId(target)) continue;
    if (data.decision !== RETRACTION_DECISION || !String(data.retractedBy || '').trim()) continue;
    if (!NON_RECIPIENT_CLASSES.has(data.deliveryClass)) continue;
    if (leadOf(row) !== leadOf(bounce)) continue;
    retracted.add(target);
  }
  return retracted;
}

module.exports = {
  DELIVERY_CLASS, PERMANENT_FAILURE, classifyDeliveryStatus, noticeParts, recipientBlocks,
  BOUNCE_RETRACTED_EVENT, RETRACTION_DECISION, NON_RECIPIENT_CLASSES,
  bounceRetractionEventId, retractedBounceEventIds,
};
