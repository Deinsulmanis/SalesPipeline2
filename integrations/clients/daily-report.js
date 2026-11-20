'use strict';

// Jole's frozen weekday business report. Read-only: it reads the client's own
// leads, activity, meeting ledger and sender status, and writes one snapshot
// row. It never sends, queues, reserves or changes a lead or a sender.
//
// REPORTING PERIOD. A report for date D covers events after the previous
// weekday's 14:00 Central up to and including D's 14:00 Central. Monday's report
// therefore carries Friday afternoon and the weekend. Every event lands in
// exactly one daily report, whatever time it arrived, and a retry at 18:05
// measures the same period as the 14:00 run. Cumulative figures are bounded by
// the same cutoff. A snapshot, once stored, is never rewritten.
const cron = require('node-cron');
const { leadsForClient, resolveSenderClient } = require('./ownership');
const { clientCampaign } = require('./campaigns');
const { canonicalSendRows, uniqueCanonicalBounces } = require('../canonical-sends');
const { REPLY_EVENT_TYPE } = require('./reply-pipeline');
const { coldSenderHolds } = require('../cold-delivery-policy');

const CLIENT_ID = 'jole';
const TIMEZONE = 'America/Chicago';
const REPORT_TITLE = 'Jole BTX — Employer Acquisition';
const REPORT_HOUR = 14;
const REPORT_CRON = '0 14 * * 1-5';
const RETRY_CRON = '5 14-23 * * 1-5';
const WEEKEND = new Set(['Sat', 'Sun']);
const dateParts = now => new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const reportDate = now => { const p = dateParts(now); return `${p.year}-${p.month}-${p.day}`; };
const dayOf = value => {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? reportDate(at) : '';
};
const instant = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? ms : null; };

/** The UTC instant of HOUR:00 Central on a YYYY-MM-DD date (CST or CDT). */
function centralInstant(date, hour = REPORT_HOUR) {
  const [y, m, d] = date.split('-').map(Number);
  for (const offset of [5, 6]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hour + offset));
    const p = dateParts(candidate);
    if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) === hour) return candidate.getTime();
  }
  throw new Error(`no ${hour}:00 Central on ${date}`);
}

/** The weekday before a YYYY-MM-DD date, in Central. */
function previousWeekday(date) {
  let at = centralInstant(date, 12);
  do { at -= 24 * 60 * 60 * 1000; } while (WEEKEND.has(dateParts(new Date(at)).weekday));
  return reportDate(new Date(at));
}

/** [start, cutoff] for a report date: exclusive start, inclusive cutoff, both UTC ms. */
function reportPeriod(date) {
  return { start: centralInstant(previousWeekday(date)), cutoff: centralInstant(date) };
}

const activityLeadId = row => String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '').trim();
const metadata = row => {
  try { return typeof row.metadata === 'object' && row.metadata ? row.metadata : JSON.parse(row.metadata || '{}'); }
  catch (_) { return {}; }
};
const providerMessageId = row => String(metadata(row).gmailMessageId || metadata(row).providerMessageId || '').trim();
const REPLY_TYPES = new Set([
  REPLY_EVENT_TYPE, 'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply',
]);
const pct = (numerator, denominator) => denominator ? Math.round(numerator / denominator * 100000) / 1000 : null;

function due(now = new Date()) {
  const p = dateParts(now);
  return !WEEKEND.has(p.weekday) && Number(p.hour) >= REPORT_HOUR;
}

function buildJoleDailyReport({ dataset, meetings = [], senders = [], inboxes = [], now = new Date(), env = process.env }) {
  const date = reportDate(now);
  const { start, cutoff } = reportPeriod(date);
  const inPeriod = value => { const ms = instant(value); return ms !== null && ms > start && ms <= cutoff; };
  const byCutoff = value => { const ms = instant(value); return ms !== null && ms <= cutoff; };
  const leads = leadsForClient(dataset.leads || [], CLIENT_ID);
  const ids = new Set(leads.map(lead => String(lead.id)));
  const activeIds = new Set((dataset.rows || []).filter(row => ids.has(String(row.id))).map(row => String(row.id)));
  const leadById = new Map(leads.map(lead => [String(lead.id), lead]));
  const activities = (dataset.activities || []).filter(row => ids.has(activityLeadId(row)));
  const sendEvidence = canonicalSendRows(activities);
  const undatedSendEvidence = [...sendEvidence.confirmed, ...sendEvidence.unconfirmed].some(row => !dayOf(row.occurredAt));
  // Evidence recorded after the cutoff belongs to the next report.
  const confirmed = sendEvidence.confirmed.filter(row => byCutoff(row.occurredAt));
  const sendsInPeriod = confirmed.filter(row => inPeriod(row.occurredAt));
  const contacted = new Set(confirmed.map(activityLeadId));
  const everContacted = new Set(sendEvidence.confirmed.map(activityLeadId));
  // A step-1 lead whose copy failed validation is parked as emailStatus 'draft'
  // (outreach-agent markColdStepDrafted) and was never sent, so its status is no
  // contact signal. Only while nothing else disagrees: a contact stage, a step,
  // a send timestamp or any unconfirmed, reserved or failed send row keeps it uncertain.
  const sendAttemptLeads = new Set([...sendEvidence.unconfirmed, ...sendEvidence.reserved, ...sendEvidence.failed].map(activityLeadId));
  const parkedUnsentDraft = lead => String(lead.emailStatus || '').trim().toLowerCase() === 'draft'
    && String(lead.stage || '') === 'Queued' && !(Number(lead.emailStep || 0) > 0)
    && !String(lead.lastEmailedAt || '').trim() && !sendAttemptLeads.has(String(lead.id));
  const uncertainContacted = leads.filter(lead =>
    (String(lead.emailStatus || '').trim() || Number(lead.emailStep || 0) > 0
      || ['Contacted', 'Replied', 'Done', 'Unsub', 'Unsubscribed'].includes(String(lead.stage || '')))
    && !everContacted.has(String(lead.id)) && !parkedUnsentDraft(lead));
  const replyRecords = (dataset.replyRecords || []).filter(row => ids.has(String(row.leadId)));
  const replyEvents = activities.filter(row => REPLY_TYPES.has(String(row.eventType || '')));
  const earliestReplyByLead = new Map();
  for (const row of replyEvents) {
    const id = activityLeadId(row);
    const ms = instant(row.occurredAt);
    if (ms === null) continue;
    if (!earliestReplyByLead.has(id) || ms < earliestReplyByLead.get(id)) earliestReplyByLead.set(id, ms);
  }
  const allGenuine = replyRecords.filter(row => ['positive', 'negative', 'needs_human', 'unclassified'].includes(row.category));
  const dailyRepliesAvailable = allGenuine.every(row => earliestReplyByLead.has(String(row.leadId)));
  // A reply first seen after the cutoff is the next report's; an undated one
  // cannot be placed and is counted cumulatively (daily figures go unavailable).
  const genuine = allGenuine.filter(row => !earliestReplyByLead.has(String(row.leadId))
    || earliestReplyByLead.get(String(row.leadId)) <= cutoff);
  const unconfirmedReplyContact = genuine.some(row => !contacted.has(String(row.leadId)));
  const periodReplies = genuine.filter(row => earliestReplyByLead.has(String(row.leadId))
    && earliestReplyByLead.get(String(row.leadId)) > start);
  const ownMeetings = meetings.filter(row => row.client_id === CLIENT_ID);
  const meetingsDated = ownMeetings.every(row => instant(row.booked_at) !== null);
  const meetingsToCutoff = ownMeetings.filter(row => instant(row.booked_at) === null || byCutoff(row.booked_at));
  const canonicalBounces = uniqueCanonicalBounces({ leads, activities });
  const canonicalBounceKeys = new Set(canonicalBounces.map(row => row.key));
  const bounceKey = row => providerMessageId(row) || `lead:${activityLeadId(row)}`;
  const datedBounces = activities.filter(row => row.eventType === 'email_bounced' && instant(row.occurredAt) !== null
    && canonicalBounceKeys.has(bounceKey(row)));
  const bouncesAvailable = canonicalBounces.every(row => datedBounces.some(event => bounceKey(event) === row.key));
  const periodBounceKeys = new Set(datedBounces.filter(row => inPeriod(row.occurredAt)).map(bounceKey));
  const clientSenders = senders.filter(sender => {
    const owner = resolveSenderClient(sender);
    return owner.ok && owner.clientId === CLIENT_ID;
  });
  const holds = coldSenderHolds(env);
  const ownInboxStatus = inboxes.filter(inbox => clientSenders.some(sender => sender.id === inbox.id));
  const perSender = clientSenders.map(sender => {
    const sent = sendsInPeriod.filter(row => (metadata(row).senderInboxId || leadById.get(activityLeadId(row))?.senderInboxId) === sender.id).length;
    const attributable = periodReplies.filter(row => leadById.get(String(row.leadId))?.senderInboxId === sender.id);
    const status = ownInboxStatus.find(row => row.id === sender.id);
    return {
      sender_id: sender.id, email: sender.email || sender.id, sent_today: sent,
      replies_attributable: attributable.length,
      health: status?.observerHealth || 'unavailable', status: sender.status || 'unknown',
      // A held or capped inbox's zero is a decision, not a failure: say so.
      daily_limit: Number.isInteger(sender.dailyLimit) ? sender.dailyLimit : null,
      cold_hold: holds.get(sender.id) || null,
    };
  });
  const unavailable = { sends_attempted: 'No complete, client-attributed append-only attempt ledger is available.' };
  const unconfirmedInPeriod = sendEvidence.unconfirmed.some(row => inPeriod(row.occurredAt));
  if (unconfirmedInPeriod || undatedSendEvidence) unavailable.successful_sends = 'A send event lacks provider confirmation or a reliable date.';
  if (uncertainContacted.length) {
    for (const name of ['untouched_remaining', 'contacted_cumulative', 'reply_rate', 'positive_reply_rate', 'meeting_rate']) {
      unavailable[name] = 'A contacted lead lacks a provider-confirmed send record.';
    }
  }
  if (!dailyRepliesAvailable) {
    for (const name of ['replies', 'positive_replies', 'negative_replies', 'unsubscribe_requests']) {
      unavailable[name] = 'At least one reply lacks a reliable dated inbound event.';
    }
  }
  if (unconfirmedReplyContact) {
    for (const name of ['reply_rate', 'positive_reply_rate', 'meeting_rate']) {
      unavailable[name] = 'A replying lead lacks a provider-confirmed send record.';
    }
  }
  if (!meetingsDated) unavailable.meetings_booked = 'At least one meeting lacks a booked timestamp.';
  if (!bouncesAvailable) unavailable.bounces = 'At least one canonical bounce lacks a dated event.';
  if (!dailyRepliesAvailable || periodReplies.some(row => !clientSenders.some(sender => sender.id === leadById.get(String(row.leadId))?.senderInboxId))) {
    unavailable.per_sender_replies = 'Some replies lack a reliable sender attribution.';
    for (const row of perSender) row.replies_attributable = null;
  }
  if (unconfirmedInPeriod || undatedSendEvidence || perSender.reduce((sum, row) => sum + row.sent_today, 0) !== sendsInPeriod.length) {
    unavailable.per_sender_sends = 'Some confirmed sends lack a reliable sender attribution.';
    for (const row of perSender) row.sent_today = null;
  }
  const senderHealthAvailable = clientSenders.every(sender => ownInboxStatus.some(row => row.id === sender.id && row.observerHealth));
  if (!senderHealthAvailable) unavailable.sender_health = 'Observer health is missing for at least one configured Jole inbox.';
  const campaign = clientCampaign('jole-btx-employer-acquisition');
  const positive = genuine.filter(row => row.category === 'positive').length;
  const ratesAvailable = !uncertainContacted.length && !unconfirmedReplyContact;
  return {
    client_id: CLIENT_ID, report_date: date, generated_at: now.toISOString(), timezone: TIMEZONE,
    campaign_id: campaign?.id || 'jole-btx-employer-acquisition', campaign_version: campaign?.campaignVersion || null,
    sends_attempted: null, successful_sends: unconfirmedInPeriod || undatedSendEvidence ? null : sendsInPeriod.length,
    replies: dailyRepliesAvailable ? periodReplies.length : null,
    positive_replies: dailyRepliesAvailable ? periodReplies.filter(row => row.category === 'positive').length : null,
    negative_replies: dailyRepliesAvailable ? periodReplies.filter(row => row.category === 'negative' && !row.unsubscribe).length : null,
    unsubscribe_requests: dailyRepliesAvailable ? periodReplies.filter(row => row.unsubscribe).length : null,
    bounces: bouncesAvailable ? periodBounceKeys.size : null,
    meetings_booked: meetingsDated ? ownMeetings.filter(row => inPeriod(row.booked_at)).length : null,
    untouched_remaining: uncertainContacted.length ? null : leads.filter(lead => activeIds.has(String(lead.id)) && !contacted.has(String(lead.id))).length,
    contacted_cumulative: uncertainContacted.length ? null : contacted.size,
    replies_cumulative: genuine.length,
    positive_replies_cumulative: positive,
    meetings_cumulative: meetingsToCutoff.length,
    reply_rate: ratesAvailable ? pct(genuine.length, contacted.size) : null,
    positive_reply_rate: ratesAvailable ? pct(positive, contacted.size) : null,
    meeting_rate: ratesAvailable ? pct(meetingsToCutoff.length, contacted.size) : null,
    per_sender: perSender,
    sender_health: {
      healthy: senderHealthAvailable ? perSender.filter(row => row.health === 'healthy').length : null,
      total: perSender.length,
      observed_at: now.toISOString(),
      period_start: new Date(start).toISOString(),
      period_end: new Date(cutoff).toISOString(),
    },
    unavailable,
  };
}

function createJoleDailyReportService({ store, loadDataset, listMeetings, senders, senderStatus, env = process.env, now = () => new Date(), log = console }) {
  let inFlight = null;
  async function generateIfDue() {
    const at = now();
    if (!due(at) || !store?.enabled) return null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const date = reportDate(at);
      const existing = await store.get(CLIENT_ID, date);
      if (existing) return existing;
      const [dataset, meetings, inboxes] = await Promise.all([loadDataset(), listMeetings(CLIENT_ID), senderStatus()]);
      const report = buildJoleDailyReport({ dataset, meetings, senders: senders(), inboxes, now: at, env });
      await store.insertIfAbsent(report);
      return store.get(CLIENT_ID, date);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  function start() {
    if (!store?.enabled) return null;
    const run = () => generateIfDue().catch(error => log.error(`[daily-report] ${error.code || error.message}`));
    const tasks = [cron.schedule(REPORT_CRON, run, { timezone: TIMEZONE }), cron.schedule(RETRY_CRON, run, { timezone: TIMEZONE })];
    // A missed 14:00 run is caught up only during the same Central reporting date.
    // The unique DB key makes this safe across restarts and process replicas.
    setImmediate(run);
    return { stop: () => tasks.forEach(task => task.stop()) };
  }
  return { generateIfDue, start };
}

module.exports = {
  CLIENT_ID, TIMEZONE, REPORT_TITLE, REPORT_CRON, RETRY_CRON, reportDate, reportPeriod, previousWeekday, due,
  buildJoleDailyReport, createJoleDailyReportService,
};
