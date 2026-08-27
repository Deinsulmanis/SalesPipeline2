'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeStoredActivity, groupedSignalEvent, deriveHistoricalEvents,
  buildActivityTimeline, inspectActivityIntegrity,
} = require('../integrations/activity-timeline');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const lead = { id: 'L1', company: 'Galaxy Dental', email: 'hello@galaxy.test' };

function activity(eventType, occurredAt, overrides = {}) {
  return {
    eventId: `${eventType}:${occurredAt}`, leadId: 'CE-L1', sourceLeadId: 'L1',
    email: lead.email, company: lead.company, eventType, occurredAt,
    subject: '', content: '', metadata: '{}', ...overrides,
  };
}

test('initial email appears once even when the stored callback row is duplicated', () => {
  const row = activity('initial_email_sent', '2026-08-20T10:00:00Z', {
    eventId: 'gmail:m1', subject: 'quick question', metadata: JSON.stringify({ step: 1, gmailMessageId: 'm1' }),
  });
  const timeline = buildActivityTimeline({ lead, activities: [row, { ...row }] });
  assert.equal(timeline.filter(event => event.type === 'initial_email_sent').length, 1);
  assert.equal(timeline[0].summary, 'Subject: quick question');
});

test('follow-up email appears once with step and subject context', () => {
  const timeline = buildActivityTimeline({ lead, activities: [activity('follow_up_sent', '2026-08-23T10:00:00Z', {
    eventId: 'gmail:m2', subject: 'following up', metadata: JSON.stringify({ step: 2, gmailMessageId: 'm2' }),
  })] });
  assert.equal(timeline[0].title, 'Follow-up email sent · step 2');
  assert.equal(timeline[0].summary, 'Subject: following up');
});

test('positive, negative and Needs Human replies use canonical categories', () => {
  const rows = [
    activity('positive_reply', '2026-08-23T10:00:00Z', { content: 'Yes, tell me more' }),
    activity('negative_reply', '2026-08-22T10:00:00Z', { content: 'No thanks' }),
    activity('needs_human_reply', '2026-08-21T10:00:00Z', { content: 'What does this cover?' }),
  ];
  const timeline = buildActivityTimeline({ lead, activities: rows });
  assert.deepEqual(timeline.map(event => event.classification), ['positive', 'negative', 'needs_human']);
  assert.equal(timeline[2].needsHuman, true);
});

test('late reply keeps its text, timestamp, classification and late marker together', () => {
  const row = activity('late_reply', '2026-08-25T15:42:00Z', {
    eventId: 'gmail-reply:r1', content: 'Can you send more info?',
    metadata: JSON.stringify({ classification: 'INTERESTED', detectedAfterSequence: true, gmailMessageId: 'r1' }),
  });
  const event = buildActivityTimeline({ lead, activities: [row] })[0];
  assert.equal(event.title, 'Late Positive reply received');
  assert.equal(event.content, row.content);
  assert.equal(event.occurredAt, '2026-08-25T15:42:00.000Z');
  assert.equal(event.late, true);
});

test('meaningful opens are grouped into one event instead of timeline spam', () => {
  const event = groupedSignalEvent('email_opened', lead, [
    { timestamp: '2026-08-21T10:00:00Z' }, { timestamp: '2026-08-21T11:00:00Z' }, { timestamp: '2026-08-22T10:00:00Z' },
  ]);
  assert.equal(event.type, 'email_opened');
  assert.equal(event.metadata.count, 3);
  assert.match(event.summary, /3 meaningful opens/);
});

test('demo plays are grouped with count and clip types', () => {
  const event = groupedSignalEvent('demo_played', lead, [
    { timestamp: '2026-08-21T10:00:00Z', audioType: 'intro' },
    { timestamp: '2026-08-22T10:00:00Z', audioType: 'demo' },
  ]);
  assert.equal(event.title, 'Demo played again');
  assert.deepEqual(event.metadata.clips, ['intro', 'demo']);
  assert.equal(event.metadata.count, 2);
});

test('stage transition shows previous and new stage and same-stage anomalies are reported', () => {
  const changed = normalizeStoredActivity(activity('stage_changed', '2026-08-22T10:00:00Z', {
    metadata: JSON.stringify({ fromStage: 'follow_up', toStage: 'hot' }),
  }));
  assert.equal(changed.summary, 'Follow Up → Hot');
  const report = inspectActivityIntegrity([activity('stage_changed', '2026-08-22T10:00:00Z', {
    metadata: JSON.stringify({ fromStage: 'hot', toStage: 'hot' }),
  })]);
  assert.equal(report.identicalStageTransitions.length, 1);
  assert.match(server, /const isTransition = displayStageFor\(nextStage\) !== displayStageFor\(previousStage\)/);
});

test('manual hold and reactivation decisions remain separate append-only history', () => {
  const timeline = buildActivityTimeline({ lead, activities: [
    activity('automation_held', '2026-08-20T10:00:00Z'),
    activity('reactivation_scheduled', '2026-08-21T10:00:00Z', { metadata: JSON.stringify({ resumeAt: '2026-09-01T10:00:00Z' }) }),
    activity('reactivation_cancelled', '2026-08-22T10:00:00Z'),
  ] });
  assert.deepEqual(timeline.map(event => event.title), ['Scheduled reactivation cancelled', 'Automation resume scheduled', 'Manual hold applied']);
});

test('meeting booked, rescheduled and cancelled are reliable distinct events', () => {
  const timeline = buildActivityTimeline({ lead, activities: [
    activity('call_booked', '2026-08-20T10:00:00Z', { metadata: JSON.stringify({ meetingAt: '2026-08-27T18:00:00Z' }) }),
    activity('meeting_rescheduled', '2026-08-21T10:00:00Z', { metadata: JSON.stringify({ meetingAt: '2026-08-28T18:00:00Z' }) }),
    activity('meeting_cancelled', '2026-08-22T10:00:00Z'),
  ] });
  // Step 9 renamed these to the "Call ..." family so the meeting journey reads
  // as one story. Chronology (newest first) and distinctness are unchanged.
  assert.deepEqual(timeline.map(event => event.title), ['Meeting cancelled', 'Call rescheduled', 'Call booked']);
  assert.match(server, /eventType = !oldMeetingAt && meetingAt \? 'call_booked'/);
});

test('Closed Won and Closed Lost retain outcome context and reopen history', () => {
  const timeline = buildActivityTimeline({ lead, activities: [
    activity('stage_changed', '2026-08-20T10:00:00Z', { metadata: JSON.stringify({ fromStage: 'call_booked', toStage: 'closed_won' }) }),
    activity('closed_lost', '2026-08-21T10:00:00Z', { metadata: JSON.stringify({ outcome: 'ghosted' }) }),
    activity('reactivation_scheduled', '2026-08-22T10:00:00Z', { metadata: JSON.stringify({ automationResumed: false }) }),
  ] });
  assert.deepEqual(timeline.map(event => event.title), ['Reopened for human follow-up', 'Closed Lost — Ghosted', 'Closed Won']);
});

test('timeline ordering is newest-first with deterministic id tie-break', () => {
  const same = '2026-08-20T10:00:00Z';
  const timeline = buildActivityTimeline({ lead, activities: [
    activity('conversation_note', same, { eventId: 'b' }), activity('stage_changed', same, { eventId: 'a' }),
    activity('initial_email_sent', '2026-08-19T10:00:00Z', { eventId: 'z' }),
  ] });
  assert.deepEqual(timeline.map(event => event.id), ['a', 'b', 'z']);
});

test('missing historical timestamp is not invented', () => {
  const event = normalizeStoredActivity(activity('conversation_note', '', { eventId: 'missing' }));
  assert.equal(event.occurredAt, null);
});

test('deterministic historical reconstruction is idempotent and only uses proven fields', () => {
  const historical = { ...lead, created: '1724151600000', lastEmailedAt: '2026-08-20T10:00:00Z', emailStep: '1' };
  const first = deriveHistoricalEvents(historical, []);
  const second = deriveHistoricalEvents(historical, []);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(event => event.type), ['lead_created', 'initial_email_sent']);
  assert.equal(deriveHistoricalEvents(historical, [activity('initial_email_sent', historical.lastEmailedAt, { metadata: JSON.stringify({ step: 1 }) })]).filter(event => event.type === 'initial_email_sent').length, 0);
});

test('integrity audit reports duplicate ids, send/reply ids, invalid dates and orphan leads without deleting', () => {
  const rows = [
    activity('initial_email_sent', 'bad', { eventId: 'dup', metadata: JSON.stringify({ gmailMessageId: 'm1' }) }),
    activity('follow_up_sent', '2026-08-20T10:00:00Z', { eventId: 'dup', metadata: JSON.stringify({ gmailMessageId: 'm1' }) }),
    activity('positive_reply', '2026-08-21T10:00:00Z', { eventId: 'r1', leadId: 'CE-missing', sourceLeadId: 'missing', metadata: JSON.stringify({ gmailMessageId: 'reply1' }) }),
    activity('late_reply', '2026-08-22T10:00:00Z', { eventId: 'r2', leadId: 'CE-missing', sourceLeadId: 'missing', metadata: JSON.stringify({ gmailMessageId: 'reply1' }) }),
  ];
  const report = inspectActivityIntegrity(rows, new Set(['L1']));
  assert.deepEqual(report.duplicateActivityIds, ['dup']);
  assert.deepEqual(report.duplicateSendIds, ['m1']);
  assert.deepEqual(report.duplicateReplyIds, ['reply1']);
  assert.equal(report.invalidTimestamps.length, 1);
  assert.equal(report.orphanActivityIds.length, 2);
  assert.equal(rows.length, 4);
});

test('Outreach timeline is lazy and initial lead loading never fetches all timelines', () => {
  assert.match(browser, /fetch\(`\/api\/coldemail\/\$\{encodeURIComponent\(id\)\}\/activity`\)/);
  const initialLoader = browser.slice(browser.indexOf('async function loadCeLeads'), browser.indexOf('function cleanCompanyName'));
  assert.doesNotMatch(initialLoader, /\/activity/);
  assert.match(server, /app\.get\('\/api\/coldemail\/:id\/activity'/);
  assert.match(server, /const DEFAULT_CE_PAGE = 100/);
});

test('reply drill-down opens the same Outreach drawer and canonical timeline', () => {
  assert.match(browser, /function rdOpenLead\(leadId\)[\s\S]*openCeDetail\(leadId\)/);
  assert.match(browser, /renderActivityTimeline\(data\.activities, 'ce-d-activity'\)/);
});

test('long reply content is expandable and raw metadata JSON is never rendered', () => {
  assert.match(browser, /<details class="activity-details">/);
  const renderer = browser.slice(browser.indexOf('function renderActivityTimeline'), browser.indexOf('async function loadColdCallActivity'));
  assert.doesNotMatch(renderer, /JSON\.stringify|event\.metadata/);
});

test('new activity work contains no outbound send invocation', () => {
  const moduleSource = fs.readFileSync(path.join(root, 'integrations', 'activity-timeline.js'), 'utf8');
  assert.doesNotMatch(moduleSource, /sendEmail|gmail\(\)|nodemailer/);
  const route = server.slice(server.indexOf("app.get('/api/coldemail/:id/activity'"), server.indexOf("app.patch('/api/coldemail/:id/stage'"));
  assert.doesNotMatch(route, /sendEmail|gmail\(|values\.(?:append|update|batchUpdate)/);
  assert.match(agent, /const MIN_DELAY = 45 \* 1000/);
  assert.match(agent, /const MAX_DELAY = 120 \* 1000/);
});
