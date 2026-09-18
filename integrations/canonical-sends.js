'use strict';

/**
 * Canonical send / reply / bounce / digest counting.
 *
 * One event type, one source, counted once. Provider confirmation is required
 * for a send to count. Reservations, failures, and unconfirmed send-typed rows
 * count zero. Reporting timezone is America/Vancouver.
 */

const { parseMetadata, attributionFromActivity, LEGACY_UNKNOWN } = require('./campaign-versions');

const REPORTING_TIMEZONE = 'America/Vancouver';

const CONFIRMED_SEND_TYPES = Object.freeze([
  'initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent',
]);
const SEND_TYPE_SET = new Set(CONFIRMED_SEND_TYPES);
const RESERVED_TYPES = new Set(['ordinary_send_reserved', 'sequence_send_reserved']);
const FAILED_TYPES = new Set(['ordinary_send_failed', 'sequence_send_failed']);
const REPLY_MESSAGE_TYPES = new Set([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply',
  'needs_human_reply', 'out_of_office_reply',
]);
const DIGEST_REPLY_LABELS = Object.freeze({
  positive: 'Interested',
  negative: 'Not Interested',
  unsubscribe: 'Unsubscribed',
  wrong_person: 'Wrong Person',
  out_of_office: 'OOO',
  needs_human: 'Needs Human',
  other: 'Other',
});

function vancouverDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE });
}

function eventKey(row) {
  return String(row.eventId || `${row.leadId || row.sourceLeadId}:${row.eventType}:${row.occurredAt}`);
}

function providerMessageId(row) {
  const meta = parseMetadata(row.metadata);
  return String(meta.gmailMessageId || meta.providerMessageId || row.provider_message_id || '').trim();
}

function providerName(row) {
  const meta = parseMetadata(row.metadata);
  const named = String(meta.provider || '').trim().toLowerCase();
  if (named) return named;
  const id = String(row.eventId || '');
  if (id.startsWith('gmail:') || id.startsWith('gmail-')) return 'gmail';
  if (id.startsWith('smartlead:') || named === 'smartlead') return 'smartlead';
  return named || 'unknown';
}

function sourceLeadId(row) {
  return String(row.sourceLeadId || row.source_lead_id || '').trim()
    || String(row.leadId || row.lead_id || '').replace(/^CE-/, '').trim();
}

function classifySendEvent(row = {}) {
  const type = String(row.eventType || row.event_type || '');
  if (RESERVED_TYPES.has(type)) return 'reserved';
  if (FAILED_TYPES.has(type)) return 'failed';
  if (!SEND_TYPE_SET.has(type)) return 'ignored';
  return providerMessageId(row) ? 'confirmed' : 'unconfirmed';
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function groupCount(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row) || '(blank)';
    groups[key] = (groups[key] || 0) + 1;
  }
  return groups;
}

function classifyReplyEvent(row = {}) {
  const type = String(row.eventType || row.event_type || '');
  if (type === 'unsubscribe_reply') return 'unsubscribe';
  if (type === 'negative_reply') return 'negative';
  if (type === 'positive_reply' || type === 'meeting_requested') return 'positive';
  if (type === 'out_of_office_reply') return 'out_of_office';
  if (type === 'wrong_person_reply') return 'wrong_person';
  if (type === 'needs_human_reply' || type === 'question_reply' || type === 'late_reply') return 'needs_human';
  return 'other';
}

function canonicalSendRows(activities = []) {
  const confirmed = [];
  const unconfirmed = [];
  const reserved = [];
  const failed = [];
  const seenEvents = new Set();
  for (const row of activities) {
    const key = eventKey(row);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const kind = classifySendEvent(row);
    if (kind === 'confirmed') confirmed.push(row);
    else if (kind === 'unconfirmed') unconfirmed.push(row);
    else if (kind === 'reserved') reserved.push(row);
    else if (kind === 'failed') failed.push(row);
  }
  const confirmedOnce = uniqueBy(confirmed, row => providerMessageId(row) || eventKey(row));
  return { confirmed: confirmedOnce, unconfirmed, reserved, failed };
}

function dashboardSendRows(activities = []) {
  return canonicalSendRows(activities).confirmed.filter(row => Number.isFinite(new Date(row.occurredAt).getTime()));
}

function buildConfirmedSendActivity(activities = []) {
  const dailySends = new Map();
  for (const row of dashboardSendRows(activities)) {
    const date = vancouverDay(row.occurredAt);
    if (!date) continue;
    dailySends.set(date, (dailySends.get(date) || 0) + 1);
  }
  return [...dailySends.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

function canonicalReplyMessages(activities = []) {
  const rows = [];
  const seenEvents = new Set();
  for (const row of activities) {
    if (!REPLY_MESSAGE_TYPES.has(String(row.eventType || row.event_type || ''))) continue;
    const key = eventKey(row);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    rows.push(row);
  }
  return uniqueBy(rows, row => providerMessageId(row) || eventKey(row));
}

function canonicalMeetingLeads(activities = []) {
  const booked = new Set();
  const rescheduled = new Set();
  const cancelled = new Set();
  const noShow = new Set();
  const completed = new Set();
  for (const row of activities) {
    const id = sourceLeadId(row);
    if (!id) continue;
    const type = String(row.eventType || row.event_type || '');
    if (type === 'call_booked') booked.add(id);
    else if (type === 'meeting_rescheduled') rescheduled.add(id);
    else if (type === 'meeting_cancelled') cancelled.add(id);
    else if (type === 'meeting_no_show') noShow.add(id);
    else if (type === 'meeting_completed') completed.add(id);
  }
  return { booked, rescheduled, cancelled, noShow, completed };
}

/**
 * One bounce per provider message id, else per lead. Activity, a [BOUNCED]
 * note, and a suppression row for the same evidence collapse to one.
 */
function uniqueCanonicalBounces({ leads = [], activities = [], suppressedEmails = [] } = {}) {
  const byKey = new Map();
  const remember = (key, extra) => {
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      for (const source of extra.sources || []) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
      return;
    }
    byKey.set(key, { key, leadId: extra.leadId || '', providerMessageId: extra.providerMessageId || '', sources: extra.sources || [] });
  };
  const leadHasEvent = new Set();
  for (const row of activities) {
    if (String(row.eventType || row.event_type || '') !== 'email_bounced') continue;
    const leadId = sourceLeadId(row);
    const pid = providerMessageId(row);
    if (leadId) leadHasEvent.add(leadId);
    remember(pid || (leadId ? `lead:${leadId}` : eventKey(row)), {
      leadId, providerMessageId: pid, sources: ['activity'],
    });
  }
  for (const lead of leads) {
    const id = String(lead.id || '').trim();
    const tagged = /\[BOUNCED/i.test(String(lead.notes || ''));
    if (!tagged || !id) continue;
    const existing = [...byKey.values()].find(item => item.leadId === id);
    if (existing) remember(existing.key, { leadId: id, sources: ['note'] });
    else remember(`lead:${id}`, { leadId: id, sources: ['note'] });
  }
  const suppressed = new Set([...suppressedEmails].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
  if (suppressed.size) {
    for (const lead of leads) {
      const email = String(lead.email || '').trim().toLowerCase();
      const id = String(lead.id || '').trim();
      if (!email || !id || !suppressed.has(email)) continue;
      if (!/\[BOUNCED/i.test(String(lead.notes || '')) && !leadHasEvent.has(id)) continue;
      const existing = [...byKey.values()].find(item => item.leadId === id);
      if (existing) remember(existing.key, { leadId: id, sources: ['suppression'] });
      else remember(`lead:${id}`, { leadId: id, sources: ['suppression'] });
    }
  }
  return [...byKey.values()];
}

function canonicalDelivered({ leads = [], activities = [], suppressedEmails = [] } = {}) {
  const confirmed = canonicalSendRows(activities).confirmed.length;
  const bounces = uniqueCanonicalBounces({ leads, activities, suppressedEmails }).length;
  return Math.max(0, confirmed - bounces);
}

function bouncedLeadIds({ leads = [], activities = [], suppressedEmails = [] } = {}) {
  const ids = new Set();
  for (const bounce of uniqueCanonicalBounces({ leads, activities, suppressedEmails })) {
    if (bounce.leadId) ids.add(bounce.leadId);
  }
  return ids;
}

function flattenActivitiesByLeadId(activitiesByLeadId = new Map()) {
  const out = [];
  for (const rows of activitiesByLeadId.values()) {
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

function classifyCrmSendAgainstProvider(row, providerIds = new Set()) {
  const kind = classifySendEvent(row);
  if (kind === 'reserved') return 'RESERVATION_ONLY';
  if (kind === 'failed') return 'FAILED_PRE_DELIVERY';
  if (kind === 'unconfirmed') return 'UNCONFIRMED_SEND';
  if (kind === 'confirmed') {
    const pid = providerMessageId(row);
    if (pid && providerIds.has(pid)) return 'CONFIRMED_SEND';
    return 'RECONCILIATION_REQUIRED';
  }
  return 'IGNORED';
}

function classifyProviderSendAgainstCrm(message, crmProviderIds = new Set()) {
  const pid = String(message.providerMessageId || message.id || '').trim();
  if (!pid) return 'RECONCILIATION_REQUIRED';
  return crmProviderIds.has(pid) ? 'CONFIRMED_SEND' : 'RECONCILIATION_REQUIRED';
}

function buildCanonicalDigest({ day, activities = [], leads = [] } = {}) {
  const sends = canonicalSendRows(activities);
  const onDay = rows => rows.filter(row => vancouverDay(row.occurredAt) === day);
  const sentToday = onDay(sends.confirmed);
  const repliesToday = onDay(canonicalReplyMessages(activities));
  const byClassification = groupCount(repliesToday, classifyReplyEvent);
  const breakdown = {};
  for (const [key, count] of Object.entries(byClassification)) {
    const label = DIGEST_REPLY_LABELS[key] || key;
    if (count) breakdown[label] = count;
  }
  const bookingsToday = uniqueBy(
    activities.filter(row => String(row.eventType || '') === 'call_booked' && vancouverDay(row.occurredAt) === day),
    sourceLeadId,
  );
  return {
    date: day,
    emailsSent: sentToday.length,
    replies: {
      total: repliesToday.length,
      breakdown,
      positive: byClassification.positive || 0,
      negative: byClassification.negative || 0,
      unsubscribes: byClassification.unsubscribe || 0,
      needsHuman: byClassification.needs_human || 0,
    },
    bookings: bookingsToday.length,
    sendClasses: {
      confirmed: sentToday.length,
      unconfirmed: onDay(sends.unconfirmed).length,
      reserved: onDay(sends.reserved).length,
      failed: onDay(sends.failed).length,
    },
  };
}

const SOURCE_LAG_TYPES = Object.freeze({
  send: CONFIRMED_SEND_TYPES,
  reply: [...REPLY_MESSAGE_TYPES],
  unsubscribe: ['unsubscribe_reply'],
  negative: ['negative_reply'],
  booking: ['call_booked'],
});

function normalizeLagRow(row = {}) {
  return {
    eventId: String(row.eventId || row.event_id || ''),
    eventType: String(row.eventType || row.event_type || ''),
    occurredAt: String(row.occurredAt || row.occurred_at || ''),
    providerMessageId: providerMessageId(row),
    sourceLeadId: sourceLeadId(row),
  };
}

function lagStatusFor(sheetsRows, crmRows) {
  const sheetIds = new Set(sheetsRows.map(row => row.eventId).filter(Boolean));
  const crmIds = new Set(crmRows.map(row => row.eventId).filter(Boolean));
  const missingInCrm = [...sheetIds].filter(id => !crmIds.has(id));
  const extraInCrm = [...crmIds].filter(id => !sheetIds.has(id));
  const crmDupes = crmRows.length - crmIds.size;
  const latest = rows => rows.map(row => row.occurredAt).filter(Boolean).sort().at(-1) || '';
  const sheetsLatest = latest(sheetsRows);
  const crmLatest = latest(crmRows);
  let status = 'same';
  if (crmDupes > 0) status = 'duplicated';
  else if (missingInCrm.length > 0 && extraInCrm.length === 0) status = crmRows.length ? 'lagging' : 'missing';
  else if (missingInCrm.length > 0) status = 'missing';
  else if (sheetsLatest && crmLatest && sheetsLatest > crmLatest) status = 'lagging';
  else if (extraInCrm.length > 0) status = 'duplicated';
  return {
    status,
    sheets: sheetsRows.length,
    crmEvents: crmRows.length,
    missingInCrm: missingInCrm.length,
    extraInCrm: extraInCrm.length,
    duplicateCrmIds: crmDupes,
    sheetsLatest: sheetsLatest || null,
    crmLatest: crmLatest || null,
  };
}

function compareSourceLag(sheetsActivities = [], crmEvents = [], { sinceDay = '' } = {}) {
  const inWindow = row => {
    if (!sinceDay) return true;
    const day = vancouverDay(row.occurredAt || row.occurred_at);
    return day && day >= sinceDay;
  };
  const sheets = sheetsActivities.filter(inWindow).map(normalizeLagRow);
  const crm = crmEvents.filter(inWindow).map(normalizeLagRow);
  const byKind = {};
  for (const [kind, types] of Object.entries(SOURCE_LAG_TYPES)) {
    const typeSet = new Set(types);
    byKind[kind] = lagStatusFor(
      sheets.filter(row => typeSet.has(row.eventType)),
      crm.filter(row => typeSet.has(row.eventType)),
    );
  }
  const order = ['missing', 'duplicated', 'lagging', 'same'];
  const worst = Object.values(byKind).reduce((acc, item) => (
    order.indexOf(item.status) < order.indexOf(acc) ? item.status : acc
  ), 'same');
  return { status: worst, sinceDay: sinceDay || null, byKind };
}

function recentReportingDays(now = Date.now(), { completeBusinessDays = 3 } = {}) {
  const start = new Date(now);
  const days = [];
  const seen = new Set();
  const push = date => {
    const day = date.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE });
    if (seen.has(day)) return;
    seen.add(day);
    const weekday = new Date(`${day}T12:00:00-07:00`).toLocaleDateString('en-US', { weekday: 'short', timeZone: REPORTING_TIMEZONE });
    days.push({ day, weekday, weekend: weekday === 'Sat' || weekday === 'Sun' });
  };
  push(start);
  const yesterday = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  push(yesterday);
  let cursor = new Date(yesterday.getTime());
  let complete = 0;
  while (complete < completeBusinessDays) {
    const weekday = cursor.toLocaleDateString('en-US', { weekday: 'short', timeZone: REPORTING_TIMEZONE });
    const day = cursor.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE });
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      if (!seen.has(day)) complete++;
      push(cursor);
    }
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    if (days.length > 14) break;
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

function countsForDay(activities, day) {
  const sends = canonicalSendRows(activities);
  const onDay = rows => rows.filter(row => vancouverDay(row.occurredAt) === day);
  const replies = onDay(canonicalReplyMessages(activities));
  const meetings = uniqueBy(
    activities.filter(row => String(row.eventType || '') === 'call_booked' && vancouverDay(row.occurredAt) === day),
    sourceLeadId,
  );
  return {
    canonicalSends: onDay(sends.confirmed).length,
    unconfirmedSends: onDay(sends.unconfirmed).length,
    reserved: onDay(sends.reserved).length,
    failed: onDay(sends.failed).length,
    canonicalReplyMessages: replies.length,
    canonicalReplyLeads: new Set(replies.map(sourceLeadId).filter(Boolean)).size,
    canonicalMeetings: meetings.length,
    unsubscribes: replies.filter(row => classifyReplyEvent(row) === 'unsubscribe').length,
    negatives: replies.filter(row => classifyReplyEvent(row) === 'negative').length,
    positives: replies.filter(row => classifyReplyEvent(row) === 'positive').length,
  };
}

module.exports = {
  REPORTING_TIMEZONE,
  CONFIRMED_SEND_TYPES,
  SEND_TYPE_SET,
  RESERVED_TYPES,
  FAILED_TYPES,
  REPLY_MESSAGE_TYPES,
  vancouverDay,
  eventKey,
  providerMessageId,
  providerName,
  sourceLeadId,
  classifySendEvent,
  uniqueBy,
  groupCount,
  classifyReplyEvent,
  canonicalSendRows,
  dashboardSendRows,
  buildConfirmedSendActivity,
  canonicalReplyMessages,
  canonicalMeetingLeads,
  uniqueCanonicalBounces,
  canonicalDelivered,
  bouncedLeadIds,
  flattenActivitiesByLeadId,
  classifyCrmSendAgainstProvider,
  classifyProviderSendAgainstCrm,
  buildCanonicalDigest,
  compareSourceLag,
  recentReportingDays,
  countsForDay,
  parseMetadata,
  attributionFromActivity,
  LEGACY_UNKNOWN,
};
