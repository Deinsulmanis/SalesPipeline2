'use strict';

const crypto = require('crypto');
const { analyticsCategoryFor, ANALYTICS_CATEGORY } = require('./reply-analytics');
const { displayStageFor } = require('./cold-call-pipeline');
const { activitySender } = require('./sender-visibility');

const REPLY_TYPES = new Set([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'pipeline_promoted',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply',
  'needs_human_reply', 'out_of_office_reply',
]);

const SOURCE_BY_TYPE = Object.freeze({
  lead_created: 'CRM', lead_queued: 'CRM', stage_changed: 'CRM',
  automation_held: 'CRM', reactivation_scheduled: 'CRM', reactivation_cancelled: 'CRM',
  initial_email_sent: 'Automation', follow_up_sent: 'Automation', booking_link_sent: 'Automation',
  email_opened: 'Prospect', demo_played: 'Demo', demo_pair_played: 'Demo',
  positive_reply: 'Prospect', meeting_requested: 'Prospect', late_reply: 'Prospect',
  pipeline_promoted: 'CRM',
  question_reply: 'Prospect', negative_reply: 'Prospect', unsubscribe_reply: 'Prospect',
  wrong_person_reply: 'Prospect', needs_human_reply: 'Prospect', out_of_office_reply: 'Prospect',
  conversation_note: 'Human', call_booked: 'Meeting', meeting_rescheduled: 'Meeting',
  meeting_cancelled: 'Meeting', meeting_completed: 'Meeting', meeting_outcome: 'Meeting', closed_won: 'CRM', closed_lost: 'CRM',
  sales_outcome_recorded: 'CRM',
});

const OUTCOME_LABELS = Object.freeze({
  no_show: 'No-show', ghosted: 'Ghosted', not_interested: 'Not interested',
  not_fit: 'Bad fit', timing: 'Wrong timing', other: 'Other', active: 'Active conversation', booked: 'Call booked',
});

function parseMetadata(value) {
  if (value && typeof value === 'object') return { ...value };
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function validTime(value) {
  const raw = String(value || '').trim();
  const numeric = /^\d{10,13}$/.test(raw) ? Number(raw) * (raw.length === 10 ? 1000 : 1) : NaN;
  const ms = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function deriveHistoricalEvents(lead = {}, activities = []) {
  const events = [];
  const types = new Set(activities.map(row => String(row.eventType || '')));
  const createdAt = validTime(lead.created);
  if (createdAt && !types.has('lead_created')) {
    events.push(normalizeStoredActivity({
      eventId: stableId('historical-lead-created', [lead.id, createdAt]), leadId: lead.id,
      eventType: 'lead_created', occurredAt: createdAt, subject: '', content: '',
      metadata: { historical: true, derivedFrom: 'Leads.created' },
    }));
  }
  const sentAt = validTime(lead.lastEmailedAt);
  const step = Number.parseInt(lead.emailStep, 10);
  if (sentAt && step > 0) {
    const hasStep = activities.some(row => {
      if (!['initial_email_sent', 'follow_up_sent'].includes(row.eventType)) return false;
      const metadata = parseMetadata(row.metadata);
      return Number(metadata.step || (row.eventType === 'initial_email_sent' ? 1 : 0)) === step;
    });
    if (!hasStep) {
      events.push(normalizeStoredActivity({
        eventId: stableId('historical-send', [lead.id, step, sentAt]), leadId: lead.id,
        eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: sentAt,
        subject: '', content: '', metadata: { step, historical: true, derivedFrom: 'ColdEmail.lastEmailedAt+emailStep' },
      }));
    }
  }
  return events;
}

function stableId(prefix, parts) {
  return `${prefix}:${crypto.createHash('sha1').update(parts.map(value => String(value || '')).join('|')).digest('hex').slice(0, 24)}`;
}

function prettyStage(value) {
  const text = String(value || '').trim().replace(/_/g, ' ');
  return text ? text.replace(/\b\w/g, char => char.toUpperCase()) : 'Unknown';
}

function classificationFor(row, metadata) {
  if (row.eventType === 'positive_reply') return 'positive';
  if (row.eventType === 'meeting_requested') return 'positive';
  if (row.eventType === 'negative_reply') return 'negative';
  if (row.eventType === 'unsubscribe_reply') return 'negative';
  if (row.eventType === 'needs_human_reply' || row.eventType === 'question_reply' || row.eventType === 'wrong_person_reply') return 'needs_human';
  const normalized = analyticsCategoryFor(metadata.classification);
  return normalized === ANALYTICS_CATEGORY.EXCLUDED ? 'excluded' : normalized;
}

function replyTitle(classification, late, type) {
  if (type === 'meeting_requested') return late ? 'Late meeting request received' : 'Meeting requested';
  const label = classification === 'positive' ? 'Positive'
    : classification === 'negative' ? 'Negative'
      : classification === 'needs_human' ? 'Needs Human'
        : classification === 'excluded' ? 'Automated'
          : 'Unclassified';
  return `${late ? 'Late ' : ''}${label} reply received`;
}

function eventPresentation(row, metadata, context = {}) {
  const type = String(row.eventType || 'activity');
  const step = Number(metadata.step || 0);
  const outcome = OUTCOME_LABELS[metadata.outcome] || prettyStage(metadata.outcome || '');
  if (REPLY_TYPES.has(type)) {
    const classification = classificationFor(row, metadata);
    const late = type === 'late_reply' || metadata.detectedAfterSequence === true;
    return { title: replyTitle(classification, late, type), classification, late,
      needsHuman: classification === 'needs_human' || metadata.requiresHumanAttention === true };
  }
  switch (type) {
    case 'lead_created': return { title: 'Lead created' };
    case 'lead_queued': return { title: 'Lead queued for outreach' };
    case 'initial_email_sent': return { title: 'Initial email sent', summary: row.subject ? `Subject: ${row.subject}` : '' };
    case 'follow_up_sent': return { title: step ? `Follow-up email sent · step ${step}` : 'Follow-up email sent', summary: row.subject ? `Subject: ${row.subject}` : '' };
    case 'email_opened': return { title: 'Email opened' };
    case 'demo_played': return { title: metadata.count > 1 ? 'Demo played again' : 'Demo played' };
    case 'demo_pair_played': return { title: 'Both demo clips played' };
    case 'booking_link_sent': return { title: 'Booking-link follow-up sent' };
    case 'pipeline_promoted': return { title: row.subject || 'Added to Sales Pipeline', summary: metadata.trigger ? `Reason: ${String(metadata.trigger).replace(/_/g, ' ')}` : '' };
    case 'stage_changed': {
      const from = prettyStage(metadata.fromStage);
      const to = prettyStage(metadata.toStage);
      if (String(metadata.toStage || '').toLowerCase() === 'closed_won') return { title: 'Closed Won', summary: `${from} → ${to}` };
      if (String(metadata.toStage || '').toLowerCase() === 'closed_lost') return { title: 'Closed Lost', summary: `${from} → ${to}` };
      return { title: 'Stage changed', summary: `${from} → ${to}` };
    }
    case 'automation_held': return { title: 'Manual hold applied', summary: 'Automated follow-up stopped' };
    case 'reactivation_scheduled': return { title: metadata.automationResumed === false ? 'Reopened for human follow-up' : 'Automation resume scheduled' };
    case 'reactivation_cancelled': return { title: 'Scheduled reactivation cancelled' };
    case 'conversation_note': return { title: row.subject || 'Conversation context updated' };
    case 'call_booked': return { title: 'Call booked', summary: metadata.meetingAt ? `Meeting: ${metadata.meetingAt}` : '' };
    case 'meeting_rescheduled': return { title: 'Call rescheduled',
      summary: metadata.previousMeetingAt && metadata.meetingAt
        ? `${metadata.previousMeetingAt} -> ${metadata.meetingAt}`
        : metadata.meetingAt ? `New time: ${metadata.meetingAt}` : '' };
    case 'meeting_cancelled': return { title: 'Meeting cancelled' };
    case 'meeting_completed': return { title: 'Call completed', summary: metadata.meetingAt ? `Meeting: ${metadata.meetingAt}` : '' };
    case 'meeting_no_show': return { title: 'No show', summary: metadata.meetingAt ? `Meeting: ${metadata.meetingAt}` : '' };
    case 'meeting_outcome': return { title: 'Meeting outcome updated', summary: metadata.outcome ? outcome : '' };
    // Somebody recorded a sales result. Deliberately NOT phrased as a closure:
    // this event never moves the Pipeline stage, and the historical record has
    // to be able to tell "we wrote down that they ghosted us" apart from "the
    // opportunity was closed". The stage it was recorded against is shown so a
    // reader can see the lead was still open at the time.
    case 'sales_outcome_recorded': return {
      title: row.subject || `Sales outcome recorded${metadata.outcome ? ` — ${outcome}` : ''}`,
      summary: metadata.stageAtRecord ? `Stage unchanged: ${prettyStage(metadata.stageAtRecord)}` : '',
    };
    case 'closed_won': return { title: 'Closed Won', summary: metadata.trigger === 'close_action' ? 'Stage moved to Closed Won' : '' };
    case 'closed_lost': {
      // A closed_lost row that was never a closure. Before the explicit Close
      // action existed, saving a loss outcome appended one of these while the
      // stage stayed where it was — so production carries rows claiming a deal
      // was lost on leads that are still open.
      //
      // The row is HISTORY and is never rewritten or deleted. It is simply
      // described accurately: no close_action trigger, and a lead that is not
      // in fact Closed Lost, together prove this recorded an outcome rather
      // than a closure.
      const fromCloseAction = metadata.trigger === 'close_action';
      const leadIsClosed = String(context.stage || '') === 'closed_lost';
      if (!fromCloseAction && context.stage && !leadIsClosed) {
        return {
          title: metadata.outcome ? `Sales outcome recorded — ${outcome}` : 'Sales outcome recorded',
          summary: `Recorded against ${prettyStage(context.stage)}; the opportunity was not closed`,
        };
      }
      return { title: metadata.outcome ? `Closed Lost — ${outcome}` : 'Closed Lost',
        summary: fromCloseAction ? 'Stage moved to Closed Lost' : '' };
    }
    default: return { title: row.subject || prettyStage(type) };
  }
}

// Outbound events whose sender is worth naming. A reply or a stage change has
// no sending inbox, so no subline is offered for one.
const SENDER_VISIBLE_EVENTS = new Set([
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent',
  'booking_link_sent', 'human_response_sent',
]);

function normalizeStoredActivity(row, index = 0, context = {}) {
  const metadata = parseMetadata(row.metadata);
  const type = String(row.eventType || 'activity');
  const occurredAt = validTime(row.occurredAt);
  const id = String(row.eventId || '').trim() || stableId('activity', [row.leadId, row.sourceLeadId, type, row.occurredAt, row.subject, row.content, index]);
  const presentation = eventPresentation(row, metadata, context);
  // "Sent from deins@tryscalelabai.ca". Present only when the event itself
  // stored the attribution — historical sender is never reconstructed, because
  // for a message sent before the field existed the only honest answer is that
  // we do not know which mailbox it left from.
  const sender = SENDER_VISIBLE_EVENTS.has(type)
    ? activitySender(row, context.senders || [])
    : null;
  return {
    id, leadId: String(row.leadId || row.sourceLeadId || ''), type,
    sender: sender ? { senderId: sender.senderId, email: sender.email, label: sender.label, role: sender.role } : null,
    senderNote: SENDER_VISIBLE_EVENTS.has(type)
      ? (sender ? `Sent from ${sender.label}` : 'Sender unavailable for legacy event')
      : '',
    occurredAt, source: SOURCE_BY_TYPE[type] || 'CRM',
    title: presentation.title, summary: presentation.summary || '',
    subject: String(row.subject || ''), content: String(row.content || ''), metadata,
    classification: presentation.classification || '', late: presentation.late === true,
    needsHuman: presentation.needsHuman === true,
  };
}

function groupedSignalEvent(type, lead, rows) {
  const valid = (rows || []).map(row => ({ ...row, occurredAt: validTime(row.timestamp || row.occurredAt) }))
    .filter(row => row.occurredAt).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (!valid.length) return null;
  const firstAt = valid[0].occurredAt;
  const lastAt = valid[valid.length - 1].occurredAt;
  const metadata = { count: valid.length, firstAt, lastAt };
  if (type === 'demo_played') metadata.clips = [...new Set(valid.map(row => row.audioType || row.audio_type || 'demo'))];
  const row = {
    eventId: stableId(type, [lead.id, firstAt, lastAt, valid.length]), leadId: lead.id,
    eventType: type, occurredAt: lastAt, metadata,
  };
  const normalized = normalizeStoredActivity(row);
  normalized.summary = type === 'email_opened'
    ? `${valid.length} meaningful open${valid.length === 1 ? '' : 's'}${valid.length > 1 ? ` · first ${firstAt}` : ''}`
    : `${valid.length} play${valid.length === 1 ? '' : 's'} · ${metadata.clips.join(' + ')}`;
  return normalized;
}

function sortTimeline(events) {
  return events.slice().sort((a, b) => {
    const time = String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''));
    return time || String(a.id).localeCompare(String(b.id));
  });
}

function buildActivityTimeline({ lead = {}, activities = [], opens = [], demos = [], senders = [] } = {}) {
  const seen = new Set();
  const events = [];
  for (const [index, row] of activities.entries()) {
    // The lead's CURRENT stage is what proves whether a historical closure
    // event ever corresponded to a real one. Passed only when the lead actually
    // HAS a stage: displayStageFor('') defaults to follow_up, and an absent
    // stage is missing evidence, not evidence that the lead is open.
    const event = normalizeStoredActivity(row, index, {
      ...(lead.stage ? { stage: displayStageFor(lead.stage) } : {}),
      senders,
    });
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  for (const event of deriveHistoricalEvents(lead, activities)) {
    if (!seen.has(event.id)) { seen.add(event.id); events.push(event); }
  }
  for (const event of [groupedSignalEvent('email_opened', lead, opens), groupedSignalEvent('demo_played', lead, demos)]) {
    if (event && !seen.has(event.id)) { seen.add(event.id); events.push(event); }
  }
  return sortTimeline(events);
}

function inspectActivityIntegrity(activities = [], validLeadIds = new Set()) {
  const ids = new Set();
  const sendIds = new Set();
  const replyIds = new Set();
  const report = {
    total: activities.length, duplicateActivityIds: [], duplicateSendIds: [], duplicateReplyIds: [],
    invalidTimestamps: [], orphanActivityIds: [], identicalStageTransitions: [],
  };
  for (const [index, row] of activities.entries()) {
    const id = String(row.eventId || '').trim();
    const ref = id || `row:${index + 2}`;
    if (id && ids.has(id)) report.duplicateActivityIds.push(id); else if (id) ids.add(id);
    if (!validTime(row.occurredAt)) report.invalidTimestamps.push(ref);
    const leadIds = [row.leadId, row.sourceLeadId].map(value => String(value || '').replace(/^CE-/, '').trim()).filter(Boolean);
    if (validLeadIds.size && leadIds.length && !leadIds.some(leadId => validLeadIds.has(leadId))) report.orphanActivityIds.push(ref);
    const metadata = parseMetadata(row.metadata);
    if (['initial_email_sent', 'follow_up_sent'].includes(row.eventType) && metadata.gmailMessageId) {
      if (sendIds.has(metadata.gmailMessageId)) report.duplicateSendIds.push(metadata.gmailMessageId); else sendIds.add(metadata.gmailMessageId);
    }
    if (REPLY_TYPES.has(row.eventType) && metadata.gmailMessageId) {
      if (replyIds.has(metadata.gmailMessageId)) report.duplicateReplyIds.push(metadata.gmailMessageId); else replyIds.add(metadata.gmailMessageId);
    }
    if (row.eventType === 'stage_changed' && metadata.fromStage && metadata.fromStage === metadata.toStage) report.identicalStageTransitions.push(ref);
  }
  return report;
}

module.exports = {
  REPLY_TYPES, parseMetadata, normalizeStoredActivity, groupedSignalEvent,
  deriveHistoricalEvents, sortTimeline, buildActivityTimeline, inspectActivityIntegrity,
};
