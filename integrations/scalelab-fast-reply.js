'use strict';
// ScaleLab fast reply mode: PURE policy. Which replies alert, quiet hours,
// the SMS text, the reply-screen link, threading headers for a reply in the
// same Gmail thread, and the placeholder rule that blocks Send. No I/O.

const ALERT_INTENTS = Object.freeze(['interest', 'information_request', 'pricing_request', 'meeting_request', 'reschedule_request']);
const TIMEZONE = 'America/Vancouver';
const ACTIVE_START_HOUR = 6;    // 06:00 Pacific
const ACTIVE_END_HOUR = 21;     // 21:00 Pacific
const PLACEHOLDER = /\[FILL:[^\]]*\]/i;
const DEFAULT_DASHBOARD_URL = 'https://receptionist.scalelabai.ca';
const RECENT_MS = 48 * 60 * 60 * 1000;

function fastReplyConfig(env = process.env) {
  return {
    enabled: env.SCALELAB_FAST_REPLY_ENABLED === 'true',
    smsEnabled: env.SCALELAB_FAST_REPLY_ENABLED === 'true' && env.SCALELAB_REPLY_SMS_ENABLED === 'true',
    dashboardUrl: String(env.DASHBOARD_PUBLIC_URL || DEFAULT_DASHBOARD_URL).replace(/\/+$/, ''),
  };
}

// Wall-clock parts in Pacific time without a timezone library.
function pacificParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(date));
  const get = type => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function inActiveHours(now = new Date()) {
  const { hour } = pacificParts(now);
  return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR;
}

/** Now if inside 06:00–21:00 Pacific, else the next 06:00 Pacific. */
function nextAlertTime(now = new Date()) {
  const at = new Date(now);
  if (inActiveHours(at)) return at;
  // Step forward a minute at a time to the first 06:00 Pacific (DST-safe, at most ~9h).
  const probe = new Date(Math.ceil(at.getTime() / 60000) * 60000);
  for (let i = 0; i < 24 * 60; i += 1) {
    const p = pacificParts(probe);
    if (p.hour === ACTIVE_START_HOUR && p.minute === 0) return probe;
    probe.setTime(probe.getTime() + 60000);
  }
  return probe;
}

const INTENT_LABEL = Object.freeze({ interest: 'interested', information_request: 'wants info', pricing_request: 'asked about pricing',
  meeting_request: 'wants a meeting', reschedule_request: 'wants to reschedule' });

function replyLink(dashboardUrl, actionId) {
  return `${String(dashboardUrl || DEFAULT_DASHBOARD_URL).replace(/\/+$/, '')}/#replies?id=${encodeURIComponent(actionId)}`;
}

/**
 * "{first name} at {company} replied ({intent}). Open: {link}". Never the
 * prospect's email body or address. Names are trimmed and stripped of
 * anything that looks like an email address or URL.
 */
function smsText({ firstName, company, intent, link }) {
  const clean = value => String(value || '').replace(/\S+@\S+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const who = clean(firstName) || 'A prospect';
  const at = clean(company);
  return `${who}${at ? ` at ${at}` : ''} replied (${INTENT_LABEL[intent] || intent}). Open: ${link}`;
}

/** True when the SMS would leak the prospect's address or a slice of their email. */
function smsLeaksPersonal(text, { email = '', body = '' } = {}) {
  const lower = String(text).toLowerCase();
  if (email && lower.includes(String(email).toLowerCase())) return true;
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return true;
  const words = String(body).replace(/\s+/g, ' ').trim();
  for (let i = 0; i + 24 <= words.length; i += 12) {
    if (lower.includes(words.slice(i, i + 24).toLowerCase())) return true;
  }
  return false;
}

function hasPlaceholder(text) {
  return PLACEHOLDER.test(String(text || ''));
}

/** In-Reply-To / References for a reply to the latest inbound message of a thread. */
function replyHeaders({ inboundMessageId, references = '' }) {
  const id = String(inboundMessageId || '').trim();
  if (!/^<[^<>\s]+>$/.test(id)) throw new Error('inbound RFC Message-ID missing or malformed');
  const chain = String(references || '').split(/\s+/).filter(item => /^<[^<>\s]+>$/.test(item));
  if (!chain.includes(id)) chain.push(id);
  return { inReplyTo: id, references: chain.join(' ') };
}

function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const encodeHeader = value => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

/** base64url RFC 822 message for Gmail (plain text, same thread headers). */
function buildReplyRaw({ fromEmail, fromName, to, subject, body, inReplyTo, references }) {
  if (!inReplyTo || !references) throw new Error('reply must carry In-Reply-To and References');
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${fromEmail}>`, `To: ${to}`, `Subject: ${encodeHeader(replySubject(subject))}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', `In-Reply-To: ${inReplyTo}`, `References: ${references}`,
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${String(body)}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isRecent(receivedAt, now = new Date()) {
  const at = Date.parse(receivedAt || '');
  return Number.isFinite(at) && new Date(now).getTime() - at <= RECENT_MS;
}

module.exports = { ALERT_INTENTS, TIMEZONE, ACTIVE_START_HOUR, ACTIVE_END_HOUR, PLACEHOLDER, DEFAULT_DASHBOARD_URL,
  fastReplyConfig, pacificParts, inActiveHours, nextAlertTime, replyLink, smsText, smsLeaksPersonal, hasPlaceholder,
  replyHeaders, replySubject, buildReplyRaw, isRecent };
