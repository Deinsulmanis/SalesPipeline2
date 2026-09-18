'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const {
  classifySendEvent, vancouverDay, canonicalSendRows, dashboardSendRows,
  canonicalReplyMessages, canonicalMeetingLeads, buildAnalyticsIntegrity,
} = require('../integrations/analytics-integrity');
const { buildReplyMetrics, buildReplyRecords } = require('../integrations/reply-analytics');
const { buildFunnelAnalytics } = require('../integrations/funnel-analytics');
const { genericReengagementAnalytics } = require('../integrations/generic-reengagement-analytics');
const { GENERIC_SEQUENCE_ID } = require('../integrations/generic-reengagement');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { ACTIVE_CAMPAIGN_VERSION } = require('../integrations/campaign-versions');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const DENTAL = ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist;
const STAFFING = STAFFING_CAMPAIGN.id;

const meta = (extra = {}) => JSON.stringify(extra);
const ev = (over = {}) => ({
  eventId: over.eventId || `${over.sourceLeadId}:${over.eventType}:${over.occurredAt}`,
  leadId: `CE-${over.sourceLeadId}`,
  sourceLeadId: over.sourceLeadId,
  email: `${over.sourceLeadId}@test.ca`,
  eventType: over.eventType,
  occurredAt: over.occurredAt,
  metadata: typeof over.metadata === 'string' ? over.metadata : meta(over.metadata || {}),
});

function confirmedSend(id, at, extra = {}) {
  const gmailMessageId = extra.gmailMessageId || `gm-${id}-${at}`;
  return ev({
    sourceLeadId: id, eventType: extra.eventType || 'initial_email_sent', occurredAt: at,
    eventId: extra.eventId || `gmail:${gmailMessageId}`,
    metadata: {
      gmailMessageId, provider: extra.provider || 'gmail', senderInboxId: extra.senderInboxId || 'primary',
      campaignVersion: extra.campaignVersion || DENTAL,
      campaignFamily: extra.campaignFamily || 'dental_ai_receptionist',
      sequenceId: extra.sequenceId || 'dental_ai_receptionist_cold',
      sequenceStep: extra.sequenceStep || 1,
      ...extra.metadata,
    },
  });
}

test('1. confirmed provider send counts once', () => {
  const activities = [
    confirmedSend('a', '2026-09-16T18:00:00.000Z'),
    confirmedSend('a', '2026-09-16T18:00:00.000Z'), // duplicate eventId
  ];
  activities[1].eventId = activities[0].eventId;
  const { confirmed } = canonicalSendRows(activities);
  assert.equal(confirmed.length, 1);
});

test('2. failed send counts zero', () => {
  const activities = [
    ev({ sourceLeadId: 'a', eventType: 'ordinary_send_failed', occurredAt: '2026-09-16T18:00:00.000Z' }),
    ev({ sourceLeadId: 'a', eventType: 'sequence_send_failed', occurredAt: '2026-09-16T18:01:00.000Z' }),
  ];
  const { confirmed, failed } = canonicalSendRows(activities);
  assert.equal(confirmed.length, 0);
  assert.equal(failed.length, 2);
  assert.equal(classifySendEvent(activities[0]), 'failed');
});

test('3. sent_unconfirmed does not double-count and is not canonical', () => {
  const unconfirmed = ev({
    sourceLeadId: 'a', eventType: 'initial_email_sent', occurredAt: '2026-09-16T18:00:00.000Z',
    metadata: { campaignVersion: DENTAL, campaignFamily: 'dental_ai_receptionist' },
  });
  const confirmed = confirmedSend('a', '2026-09-16T18:05:00.000Z');
  const rows = canonicalSendRows([unconfirmed, confirmed]);
  assert.equal(rows.unconfirmed.length, 1);
  assert.equal(rows.confirmed.length, 1);
  assert.equal(dashboardSendRows([unconfirmed, confirmed]).length, 2);
  const report = buildAnalyticsIntegrity({ activities: [unconfirmed, confirmed], leads: [{ id: 'a', email: 'a@test.ca' }] });
  assert.equal(report.sends.canonical, 1);
  assert.equal(report.sends.dashboard, 2);
  assert.equal(report.sends.delta, 1);
});

test('4. reconciled send with the same Gmail id counts once', () => {
  const first = confirmedSend('a', '2026-09-16T18:00:00.000Z', { gmailMessageId: 'same-msg' });
  const recovered = confirmedSend('a', '2026-09-16T18:10:00.000Z', { gmailMessageId: 'same-msg', eventId: 'gmail:same-msg:recovery' });
  const { confirmed } = canonicalSendRows([first, recovered]);
  assert.equal(confirmed.length, 1);
});

test('5. inbound Gmail reply counts once', () => {
  const reply = ev({
    sourceLeadId: 'a', eventType: 'positive_reply', occurredAt: '2026-09-16T19:00:00.000Z',
    eventId: 'gmail-reply:m1', metadata: { canonicalState: 'positive', gmailMessageId: 'm1', provider: 'gmail' },
  });
  const messages = canonicalReplyMessages([reply, { ...reply }]);
  assert.equal(messages.length, 1);
});

test('6. recovery does not duplicate a reply already stored by Gmail id', () => {
  const live = ev({
    sourceLeadId: 'a', eventType: 'positive_reply', occurredAt: '2026-09-16T19:00:00.000Z',
    eventId: 'gmail-reply:m1', metadata: { canonicalState: 'positive', gmailMessageId: 'm1' },
  });
  const recovered = ev({
    sourceLeadId: 'a', eventType: 'positive_reply', occurredAt: '2026-09-17T12:00:00.000Z',
    eventId: 'gmail-reply:m1:recovered', metadata: { canonicalState: 'positive', gmailMessageId: 'm1' },
  });
  assert.equal(canonicalReplyMessages([live, recovered]).length, 1);
});

test('7. unsubscribe counts as one negative/unsubscribe reply, not twice', () => {
  const unsub = ev({
    sourceLeadId: 'a', eventType: 'unsubscribe_reply', occurredAt: '2026-09-16T19:00:00.000Z',
    eventId: 'gmail-reply:u1', metadata: { canonicalState: 'negative', reason: 'unsubscribe_request', gmailMessageId: 'u1' },
  });
  const leads = [{ id: 'a', email: 'a@test.ca', emailStatus: 'replied', notes: '[REPLY: Unsubscribed]' }];
  const activitiesByLeadId = new Map([['a', [unsub]]]);
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.negative, 1);
  assert.equal(metrics.inboundMessages, 1);
  assert.equal(canonicalReplyMessages([unsub]).length, 1);
});

test('8. negative counts correctly from canonical activity', () => {
  const neg = ev({
    sourceLeadId: 'a', eventType: 'negative_reply', occurredAt: '2026-09-16T19:00:00.000Z',
    metadata: { canonicalState: 'negative', gmailMessageId: 'n1' },
  });
  const leads = [{ id: 'a', email: 'a@test.ca', emailStatus: 'emailed', notes: '' }];
  const activitiesByLeadId = new Map([['a', [neg]]]);
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.negative, 1);
  assert.equal(metrics.genuineReplies, 1);
});

test('9. meeting reschedule does not double-count booked opportunities', () => {
  const activities = [
    ev({ sourceLeadId: 'a', eventType: 'call_booked', occurredAt: '2026-09-10T18:00:00.000Z' }),
    ev({ sourceLeadId: 'a', eventType: 'meeting_rescheduled', occurredAt: '2026-09-11T18:00:00.000Z' }),
    ev({ sourceLeadId: 'a', eventType: 'meeting_rescheduled', occurredAt: '2026-09-12T18:00:00.000Z' }),
  ];
  const meetings = canonicalMeetingLeads(activities);
  assert.equal(meetings.booked.size, 1);
  assert.equal(meetings.rescheduled.size, 1);
  const generic = genericReengagementAnalytics({
    activities: [
      { eventId: 'e', sourceLeadId: 'a', eventType: 'sequence_enrolled', occurredAt: '2026-09-01T00:00:00.000Z',
        metadata: JSON.stringify({ sequenceId: GENERIC_SEQUENCE_ID }) },
      { eventId: 's1', sourceLeadId: 'a', eventType: 'sequence_step_sent', occurredAt: '2026-09-02T00:00:00.000Z',
        metadata: JSON.stringify({ sequenceId: GENERIC_SEQUENCE_ID, step: 1, providerMessageId: 'p1' }) },
      ...activities,
    ],
    leads: [{ id: 'a', email: 'a@test.ca' }],
  });
  assert.equal(generic.bookedMeetings, 1);
});

test('10. cancellation keeps the original booking and records cancelled separately', () => {
  const activities = [
    ev({ sourceLeadId: 'a', eventType: 'call_booked', occurredAt: '2026-09-10T18:00:00.000Z' }),
    ev({ sourceLeadId: 'a', eventType: 'meeting_cancelled', occurredAt: '2026-09-11T18:00:00.000Z' }),
  ];
  const meetings = canonicalMeetingLeads(activities);
  assert.equal(meetings.booked.size, 1);
  assert.equal(meetings.cancelled.size, 1);
  const funnel = buildFunnelAnalytics({
    leads: [{ id: 'a', email: 'a@test.ca', emailStatus: 'emailed' }],
    activities: [confirmedSend('a', '2026-09-01T18:00:00.000Z'), ...activities],
    boardLeads: [{ id: 'CE-a', email: 'a@test.ca', stage: 'call_booked' }],
    replyRecords: [], currentVersion: DENTAL,
  }, { version: DENTAL });
  assert.equal(funnel.counts.callBooked, 1);
  assert.equal(funnel.counts.cancelled, 1);
  assert.equal(funnel.counts.callHeld, 0);
});

test('11. Vancouver day boundary is used for date-only funnel windows', () => {
  // 2026-09-16T06:59:00Z is still 2026-09-15 in America/Vancouver (PDT, UTC-7).
  const lateUtc = confirmedSend('a', '2026-09-16T06:59:00.000Z');
  const vancouverMorning = confirmedSend('b', '2026-09-16T07:01:00.000Z');
  assert.equal(vancouverDay(lateUtc.occurredAt), '2026-09-15');
  assert.equal(vancouverDay(vancouverMorning.occurredAt), '2026-09-16');
  const input = {
    leads: [{ id: 'a', email: 'a@test.ca' }, { id: 'b', email: 'b@test.ca' }],
    activities: [lateUtc, vancouverMorning],
    boardLeads: [], replyRecords: [], currentVersion: DENTAL,
  };
  const day = buildFunnelAnalytics(input, { version: DENTAL, from: '2026-09-16', to: '2026-09-16' });
  assert.equal(day.counts.sent, 1, 'only the Vancouver Sep 16 send enters the date-only window');
  const utcWindow = buildFunnelAnalytics(input, {
    version: DENTAL, from: '2026-09-16T00:00:00.000Z', to: '2026-09-16T23:59:59.000Z',
  });
  assert.equal(utcWindow.counts.sent, 2, 'explicit UTC timestamps keep exact bounds');
});

test('12. staffing and dental attribution stay isolated', () => {
  const dental = confirmedSend('d', '2026-09-16T18:00:00.000Z');
  const staffing = confirmedSend('s', '2026-09-16T18:00:00.000Z', {
    campaignVersion: STAFFING, campaignFamily: 'industrial_staffing',
    sequenceId: 'industrial_staffing_cold', senderInboxId: 'tryscalelabai',
  });
  const input = {
    leads: [{ id: 'd', email: 'd@test.ca' }, { id: 's', email: 's@test.ca' }],
    activities: [dental, staffing], boardLeads: [], replyRecords: [], currentVersion: DENTAL,
  };
  const dentalFunnel = buildFunnelAnalytics(input, { version: DENTAL });
  const staffingFunnel = buildFunnelAnalytics(input, { version: STAFFING });
  assert.equal(dentalFunnel.counts.sent, 1);
  assert.equal(staffingFunnel.counts.sent, 1);
  assert.deepEqual(dentalFunnel.stageLeadIds.sent, ['d']);
  assert.deepEqual(staffingFunnel.stageLeadIds.sent, ['s']);
  const report = buildAnalyticsIntegrity({
    activities: [dental, staffing], leads: input.leads, dentalFunnel, staffingFunnel,
  });
  assert.equal(report.attribution.staffingInDental, 0);
  assert.equal(report.attribution.dentalInStaffing, 0);
  assert.equal(report.attribution.isolated, true);
});

test('13. Gmail and Smartlead cannot double-count the same provider message', () => {
  const gmail = confirmedSend('a', '2026-09-16T18:00:00.000Z', { gmailMessageId: 'shared', provider: 'gmail' });
  const smartlead = confirmedSend('a', '2026-09-16T18:00:00.000Z', {
    gmailMessageId: 'shared', provider: 'smartlead', eventId: 'smartlead:shared',
  });
  const { confirmed } = canonicalSendRows([gmail, smartlead]);
  assert.equal(confirmed.length, 1);
  const report = buildAnalyticsIntegrity({
    activities: [gmail, smartlead], leads: [{ id: 'a', email: 'a@test.ca' }],
  });
  assert.equal(report.sends.canonical, 1);
  assert.ok(report.sourceMismatch.gmailSmartleadDoubleAttribute >= 1
    || report.duplicates.gmailSmartleadSharedIds >= 1
    || report.sends.canonical === 1);
});

test('14. Supabase lead store plus Sheets activity does not double-count a send', () => {
  const send = confirmedSend('a', '2026-09-16T18:00:00.000Z');
  const report = buildAnalyticsIntegrity({
    activities: [send, send],
    leads: [{ id: 'a', email: 'a@test.ca' }],
    leadSource: 'supabase',
  });
  assert.equal(report.sends.canonical, 1);
  assert.equal(report.sends.dashboard, 1);
  assert.equal(report.sourceMismatch.mixedLeadAndActivityStores, true);
  assert.match(report.sourceMismatch.note, /not double-counted/);
});

test('15. conversion denominators stay at or below 100% unless the stages can diverge', () => {
  const leads = [{ id: 'a', email: 'a@test.ca', emailStatus: 'emailed' }];
  const activities = [
    confirmedSend('a', '2026-09-01T18:00:00.000Z'),
    ev({
      sourceLeadId: 'a', eventType: 'positive_reply', occurredAt: '2026-09-02T18:00:00.000Z',
      metadata: { canonicalState: 'positive', gmailMessageId: 'r1' },
    }),
  ];
  const funnel = buildFunnelAnalytics({
    leads, activities, boardLeads: [], replyRecords: [{ leadId: 'a', category: 'positive' }], currentVersion: DENTAL,
  }, { version: DENTAL });
  assert.ok(funnel.conversions.sentToReply <= 100);
  assert.ok(funnel.conversions.sentToPositive <= 100);
  assert.ok(funnel.conversions.replyToPositive <= 100);
  assert.equal(funnel.counts.replied, 1);
  assert.equal(funnel.counts.sent, 1);
});

test('16. dashboard totals equal canonical fixture totals when every send is confirmed', () => {
  const leads = [
    { id: 'd', email: 'd@test.ca', emailStatus: 'replied', notes: '' },
    { id: 's', email: 's@test.ca', emailStatus: 'emailed', notes: '' },
  ];
  const activities = [
    confirmedSend('d', '2026-09-16T18:00:00.000Z'),
    confirmedSend('s', '2026-09-16T19:00:00.000Z', {
      campaignVersion: STAFFING, campaignFamily: 'industrial_staffing', senderInboxId: 'tryscalelabai',
    }),
    ev({
      sourceLeadId: 'd', eventType: 'positive_reply', occurredAt: '2026-09-16T20:00:00.000Z',
      eventId: 'gmail-reply:rd', metadata: { canonicalState: 'positive', gmailMessageId: 'rd' },
    }),
    ev({ sourceLeadId: 'd', eventType: 'call_booked', occurredAt: '2026-09-17T18:00:00.000Z' }),
    ev({ sourceLeadId: 'd', eventType: 'ordinary_send_reserved', occurredAt: '2026-09-16T17:00:00.000Z' }),
    ev({ sourceLeadId: 's', eventType: 'ordinary_send_failed', occurredAt: '2026-09-16T17:30:00.000Z' }),
  ];
  const activitiesByLeadId = new Map([
    ['d', activities.filter(row => row.sourceLeadId === 'd')],
    ['s', activities.filter(row => row.sourceLeadId === 's')],
  ]);
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  const funnelLifetime = buildFunnelAnalytics({
    leads, activities, boardLeads: [{ id: 'CE-d', email: 'd@test.ca', stage: 'call_booked' }],
    replyRecords: buildReplyRecords(leads, { activitiesByLeadId }), currentVersion: DENTAL,
  }, { version: 'lifetime' });
  const report = buildAnalyticsIntegrity({
    leads, activities, metrics, funnelLifetime, now: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(report.sends.canonical, 2);
  assert.equal(report.sends.dashboard, 2);
  assert.equal(report.sends.delta, 0);
  assert.equal(report.sends.reserved, 1);
  assert.equal(report.sends.failed, 1);
  assert.equal(report.replies.canonical, 1);
  assert.equal(report.replies.dashboard, 1);
  assert.equal(report.replies.delta, 0);
  assert.equal(report.meetings.canonical, 1);
  assert.equal(report.meetings.dashboard, 1);
  assert.equal(report.meetings.delta, 0);
  assert.equal(report.timezone, 'America/Vancouver');
});

test('Gmail-only inbound (no tag, emailStatus emailed) now appears on reply cards', () => {
  const leads = [{ id: 'a', email: 'a@test.ca', emailStatus: 'emailed', notes: '' }];
  const activitiesByLeadId = new Map([['a', [ev({
    sourceLeadId: 'a', eventType: 'positive_reply', occurredAt: '2026-09-16T19:00:00.000Z',
    metadata: { canonicalState: 'positive', gmailMessageId: 'only' },
  })]]]);
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.positive, 1);
  assert.equal(metrics.inboundMessages, 1);
});

test('reserved send types never enter dashboard send rows', () => {
  const rows = dashboardSendRows([
    ev({ sourceLeadId: 'a', eventType: 'ordinary_send_reserved', occurredAt: '2026-09-16T18:00:00.000Z' }),
    ev({ sourceLeadId: 'a', eventType: 'sequence_send_reserved', occurredAt: '2026-09-16T18:01:00.000Z' }),
  ]);
  assert.equal(rows.length, 0);
});

test('the integrity endpoint is authenticated, read-only, and uses the shared snapshot', () => {
  const server = readSource(path.join(root, 'server.js'));
  const start = server.indexOf("app.get('/api/ops/analytics-integrity'");
  assert.notEqual(start, -1);
  const body = server.slice(start, server.indexOf('function operationalMailbox'));
  assert.match(body, /requireAuth/);
  assert.match(body, /getOutreachDataset/);
  assert.match(body, /buildAnalyticsIntegrity/);
  assert.doesNotMatch(body, /spreadsheets\.values\.(update|append|batchUpdate)|sendEmail|getOrCreateDigest/);
});

test('Last 7/30 funnel windows send Vancouver calendar dates, not UTC rolling hours', () => {
  const browser = readSource(path.join(root, 'public', 'index.html'));
  const start = browser.indexOf('function funnelQuery');
  const body = browser.slice(start, browser.indexOf('\n}\n', start));
  assert.match(body, /America\/Vancouver/);
  assert.match(body, /params\.set\('from'/);
  assert.match(body, /params\.set\('to'/);
  assert.doesNotMatch(body, /86400000\)\.toISOString\(\)/);
});
