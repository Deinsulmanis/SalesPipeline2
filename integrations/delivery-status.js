'use strict';
/**
 * delivery-status.js — what a delivery-status notification proves about the RECIPIENT.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bounce suppresses a prospect permanently, so only positive recipient-side
 * evidence may produce one. These notices are explicitly NOT that evidence:
 *
 *   delay        Gmail's "(Delay)" notice says "You'll be notified if the
 *                delivery fails permanently" — the bare word "permanent" once
 *                turned every delay into a hard bounce (Oct 3 2026 incident).
 *   sender auth  SPF/DKIM/DMARC/public-key failures (Microsoft 450 4.7.26 and
 *                friends) describe OUR domain, not their mailbox.
 *   policy       A permanent refusal for reputation, content or the recipient
 *                organisation's rules says nothing about the mailbox. A sender
 *                block would otherwise suppress every prospect it touched.
 *
 * Only the notice's own text is read: the message/delivery-status fields and
 * the human explanation. The returned original message is skipped — its
 * DKIM-Signature / Authentication-Results headers mention DKIM on every DSN.
 * Status codes are read literally from the notice and never inferred.
 */

const DELIVERY_CLASS = Object.freeze({
  RECIPIENT_INVALID: 'recipient_invalid',
  SENDER_AUTH_FAILURE: 'sender_auth_failure',
  TEMPORARY_PROVIDER_DELAY: 'temporary_provider_delay',
  // A final failure whose status is still 4.x.x (retries expired): the message
  // was not delivered, but nothing says the address is bad.
  UNDELIVERED_TEMPORARY: 'undelivered_temporary',
  // Permanent, for reputation, content or the recipient organisation's policy.
  POLICY_REJECTION: 'policy_rejection',
  // Permanent, because the recipient's own mail routing failed (a mail loop).
  RECIPIENT_ROUTING_FAILURE: 'recipient_routing_failure',
  // Permanent, with nothing readable that says why.
  PERMANENT_UNCLASSIFIED: 'permanent_unclassified',
  // A gateway's "could not be delivered" that carries no code and no reason.
  UNDELIVERED_UNSPECIFIED: 'undelivered_unspecified',
  UNKNOWN: 'unknown',
});

// Permanent failures that keep the long-standing bounce + suppression path.
const SUPPRESSING_CLASSES = new Set([DELIVERY_CLASS.RECIPIENT_INVALID,
  DELIVERY_CLASS.RECIPIENT_ROUTING_FAILURE, DELIVERY_CLASS.PERMANENT_UNCLASSIFIED]);
const HARD_CLASSES = new Set([...SUPPRESSING_CLASSES, DELIVERY_CLASS.POLICY_REJECTION]);
const SOFT_CLASSES = new Set([DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY, DELIVERY_CLASS.UNDELIVERED_TEMPORARY]);
// Final failures that stop the next touch of the sequence without suppressing:
// a follow-up must not chase an email that never arrived.
const LATER_TOUCH_BLOCKING_CLASSES = new Set([DELIVERY_CLASS.POLICY_REJECTION, DELIVERY_CLASS.UNDELIVERED_UNSPECIFIED]);

const DELIVERY_DEFERRED_EVENT = 'email_delivery_deferred';
const DELIVERY_FAILED_EVENT = 'email_delivery_failed';

// The existing hard-bounce vocabulary, unchanged. It is consulted only after
// delay and sender-auth notices have been ruled out.
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;

// RFC 3463 enhanced codes, not IP fragments: 10.5.1.1 and 52.101.41.26 never match.
const ENHANCED_CODE = /(?<![\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d.])/g;
const SMTP_REPLY = /(?:^|[\s;'"(])([245]\d{2})(?=[ -])/;
const POLICY_TEXT = /\bspam\b|spamhaus|spamcop|black ?list|block ?list|\breputation\b|\bbanned\b|\bunsolicited\b|content (?:rejected|filter)|rejected (?:by|due to|because of) (?:policy|content|security)|policy (?:violation|rejection|restriction|reasons?)|(?:blocked|denied) by (?:policy|administrator|recipient|sender)|message (?:was |has been )?(?:blocked|quarantined)|sender (?:is |was |has been )?(?:blocked|denied|not allowed|rejected)|not (?:allowed|authorized|permitted) to (?:send|relay)|does not allow external/i;
const RECIPIENT_TEXT = /recipient (?:address )?(?:rejected|not found)|recipientnotfound|user unknown|unknown (?:user|address|recipient)|no such (?:user|mailbox|address|recipient)|address not found|does(?: not|n['’]?t) exist|mailbox (?:unavailable|not found|full|is full)|invalid (?:recipient|mailbox)|account (?:has been )?(?:disabled|closed|suspended)/i;
const ROUTING_TEXT = /hop count|mail loop|too many hops|routing loop|no route to/i;
const UNDELIVERED_TEXT = /could not be delivered|couldn'?t be delivered|was not delivered|wasn'?t delivered|undeliverable|delivery (?:has )?failed/i;
// 5.1.7/5.1.8 are about the SENDER's address; 5.2.1 is a disabled mailbox.
const RECIPIENT_CODE = /^5\.1\.(?!7$|8$)\d+$|^5\.2\.[12]$/;

// A delivery notice, however its gateway dresses it. Cisco and Trend Micro send
// theirs from noreply addresses, so the From line alone misses them. A person's
// reply is never one: the subject rule needs an automated sender.
const NOTICE_SUBJECT = /^(?:\[postmaster\]\s*)?(?:undeliverable\b|undelivered mail|delivery status notification|delivery (?:has )?failed|delivery failure|email delivery failure|mail delivery (?:failed|failure|subsystem)|returned mail|failure notice|message (?:not delivered|could not be delivered))/i;
const AUTOMATED_NOTICE_SENDER = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|mail-?delivery|bounces?@/i;
function isDeliveryNotice(payload = {}, fromAddress = '') {
  const header = name => (payload?.headers || []).find(item => norm(item.name) === name)?.value || '';
  if (/mailer-daemon|postmaster/i.test(fromAddress)) return true;
  if (/report-type="?delivery-status/i.test(header('content-type'))) return true;
  const hasStatusPart = part => Boolean(part) && (/^message\/(?:global-)?delivery-status$/i.test(part.mimeType || '')
    || (part.parts || []).some(hasStatusPart));
  if (hasStatusPart(payload)) return true;
  return AUTOMATED_NOTICE_SENDER.test(fromAddress) && NOTICE_SUBJECT.test(header('subject'));
}

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
// Microsoft NDRs title it "Original Message Headers" with no colon, and the
// relay Authentication-Results lines below it (spf=softfail, dmarc=fail) once
// turned a 550 5.1.10 RecipientNotFound into a sender-auth failure.
const RETURNED_COPY = /^[ \t>-]*(?:-{2,}[^\n]*)?(?:this is a copy of the message|original message headers:?|original message follows|the header of the original message|-+ ?original message ?-+|-+ ?forwarded message ?-+)/im;

const decode = data => Buffer.from(String(data || ''), 'base64url').toString('utf8');
const stripHtml = html => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const norm = value => String(value || '').trim().toLowerCase();

/** The notice's own parts — never the returned message. */
function noticeParts(payload) {
  const status = []; const plain = []; const html = [];
  // Gmail can expose a report's fields as a text/plain CHILD of the
  // message/delivery-status part (Microsoft NDRs do); those are still fields.
  const walk = (part, returned, inStatus) => {
    if (!part) return;
    const type = norm(part.mimeType);
    const inReturned = returned || type === 'message/rfc822' || type === 'text/rfc822-headers' || type === 'message/rfc822-headers';
    const isStatus = inStatus || type === 'message/delivery-status' || type === 'message/global-delivery-status';
    if (!inReturned && part.body?.data) {
      const text = decode(part.body.data);
      if (isStatus) status.push(text);
      else if (type === 'text/html') html.push(stripHtml(text));
      else if (!type || type.startsWith('text/')) plain.push(text);
    }
    for (const child of part.parts || []) walk(child, inReturned, isStatus);
  };
  walk(payload, false, false);
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
    if (['final-recipient', 'original-recipient', 'action', 'status', 'diagnostic-code', 'will-retry-until', 'remote-mta'].includes(field)) {
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
 * @returns { category, action, status, final, senderAuth, recipientInvalid,
 *   suppress, bounceType, enhancedCode, smtpCode, diagnostic, remoteMta }
 *   suppress    this notice proves a permanent recipient-side failure
 *   legacyBounce the original rule (any 5.x.x or permanent wording). ScaleLab's
 *                inboxes keep it, so their suppression behaviour is unchanged.
 *   bounceType  'hard' (permanent), 'soft' (temporary) or null (the notice does not say)
 *   enhancedCode, smtpCode, diagnostic  literal notice text; '' when it has none
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
    senderAuth: false, recipientInvalid: false, suppress: false, legacyBounce: false, bounceType: null,
    enhancedCode: '', smtpCode: '', diagnostic: '', remoteMta: '',
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
  // The reason as the notice states it: the machine field, or else the human
  // line naming a code. Addresses are masked; nothing is added or inferred.
  const humanEvidence = named.length > 1 && mine.length ? '' : human;
  const reason = diagnostics || humanEvidence;
  const codes = [...new Set([...`${diagnostics}\n${humanEvidence}`.matchAll(ENHANCED_CODE)].map(match => match[1]))];
  const specific = [...codes, ...statuses].find(code => !/^[245]\.0\.0$/.test(code)) || status || codes[0] || '';
  const smtpCode = (SMTP_REPLY.exec(reason) || [])[1] || '';
  const namesCode = new RegExp(ENHANCED_CODE.source);
  const reasonLine = diagnostics || String(humanEvidence).split(/\r?\n/).find(line => namesCode.test(line)) || humanEvidence;
  const diagnostic = String(reasonLine || '').replace(/\s+/g, ' ').trim()
    .replace(/[a-z0-9._%+=-]+@/gi, '***@').slice(0, 300);
  const remoteMta = String(blocks.map(block => block['remote-mta'] || '').find(Boolean) || '')
    .replace(/^[^;]*;\s*/, '').trim().slice(0, 120);
  const result = (category, extra = {}) => ({ category, action, status, final, senderAuth,
    recipientInvalid: category === DELIVERY_CLASS.RECIPIENT_INVALID,
    suppress: SUPPRESSING_CLASSES.has(category),
    legacyBounce: !senderAuth && !delayed && (status.startsWith('5.') || PERMANENT_FAILURE.test(evidence)),
    bounceType: HARD_CLASSES.has(category) ? 'hard' : SOFT_CLASSES.has(category) ? 'soft'
      : category === DELIVERY_CLASS.SENDER_AUTH_FAILURE ? (status.startsWith('5.') ? 'hard' : status.startsWith('4.') ? 'soft' : null) : null,
    enhancedCode: specific, smtpCode, diagnostic, remoteMta, ...extra });

  if (senderAuth) return result(DELIVERY_CLASS.SENDER_AUTH_FAILURE);
  if (delayed) return result(DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY);
  // A report's own 4.x.x status outranks loose wording such as "permanently".
  if (status.startsWith('4.')) return result(DELIVERY_CLASS.UNDELIVERED_TEMPORARY);
  if (status.startsWith('5.') || codes.some(code => code.startsWith('5.')) || PERMANENT_FAILURE.test(evidence)) {
    const policyCode = [status, ...codes].some(code => /^5\.7\./.test(code));
    if (POLICY_TEXT.test(reason) || (policyCode && /access denied/i.test(reason))) return result(DELIVERY_CLASS.POLICY_REJECTION);
    if (RECIPIENT_TEXT.test(reason) || codes.some(code => RECIPIENT_CODE.test(code)) || RECIPIENT_CODE.test(status)) return result(DELIVERY_CLASS.RECIPIENT_INVALID);
    if (ROUTING_TEXT.test(reason) || [status, ...codes].some(code => /^5\.4\./.test(code))) return result(DELIVERY_CLASS.RECIPIENT_ROUTING_FAILURE);
    if (policyCode) return result(DELIVERY_CLASS.POLICY_REJECTION);
    return result(DELIVERY_CLASS.PERMANENT_UNCLASSIFIED);
  }
  if (action === 'failed') return result(DELIVERY_CLASS.UNDELIVERED_TEMPORARY);
  if (UNDELIVERED_TEXT.test(human)) return result(DELIVERY_CLASS.UNDELIVERED_UNSPECIFIED);
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
  DELIVERY_CLASS, PERMANENT_FAILURE, classifyDeliveryStatus, noticeParts, recipientBlocks, isDeliveryNotice,
  SUPPRESSING_CLASSES, LATER_TOUCH_BLOCKING_CLASSES, DELIVERY_DEFERRED_EVENT, DELIVERY_FAILED_EVENT,
  BOUNCE_RETRACTED_EVENT, RETRACTION_DECISION, NON_RECIPIENT_CLASSES,
  bounceRetractionEventId, retractedBounceEventIds,
};
