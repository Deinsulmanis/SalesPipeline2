'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildDemoPairActivity, qualifyingDemoPair, demoPairEventId,
  hasUndeliveredDemoPair, planIntentObservation,
} = require('../integrations/demo-intent-state');
const {
  deriveNextAction, ACTION_TYPE, ACTION_OWNER, ACTION_STATUS, MANUAL_HOLD_TAG,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const agent = source('outreach-agent.js');
const server = source('server.js');
const browser = source('public/index.html');
const repair = source('scripts/demo-intent-audit-repair.js');

const lead = {
  id: 'L1', company: 'Example Dental', email: 'hello@example.test',
  senderInboxId: 'secondary', campaign: 'dental', campaignVersion: 'dental_v3',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-09-10T16:00:00.000Z',
};
const play = {
  intro: 1, demo: 1,
  introPlayedAt: '2026-09-11T16:58:44.399Z',
  demoPlayedAt: '2026-09-11T16:58:26.461Z',
  last: '2026-09-11T16:58:44.399Z',
};
const pair = buildDemoPairActivity(lead, play);
const now = new Date('2026-09-11T18:00:00.000Z');

test('verified pair activity is deterministic, replay-safe and preserves evidence without a body', () => {
  const again = buildDemoPairActivity(lead, play);
  assert.equal(pair.eventId, 'demo-pair:L1');
  assert.equal(pair.eventId, demoPairEventId(lead));
  assert.equal(again.eventId, pair.eventId);
  assert.equal(pair.occurredAt, play.introPlayedAt);
  assert.equal(pair.content, '');
  assert.equal(pair.subject, '');
  const metadata = JSON.parse(pair.metadata);
  assert.equal(metadata.introPlayedAt, play.introPlayedAt);
  assert.equal(metadata.demoPlayedAt, play.demoPlayedAt);
  assert.equal(metadata.senderInboxId, 'secondary');
  assert.equal(metadata.campaignVersion, 'dental_v3');
  assert.ok(!pair.metadata.includes('email body'));
});

test('one asset is not a pair and cannot create canonical intent', () => {
  assert.equal(qualifyingDemoPair({ intro: 1, demo: 0, introPlayedAt: play.introPlayedAt }), null);
  assert.equal(qualifyingDemoPair({ intro: 0, demo: 1, demoPlayedAt: play.demoPlayedAt }), null);
});

test('pending is derived from pair present and booking-link delivery absent', () => {
  assert.equal(hasUndeliveredDemoPair(lead, [pair]), true);
  assert.equal(hasUndeliveredDemoPair(lead, [pair, {
    eventId: 'sent', sourceLeadId: lead.id, eventType: 'booking_link_sent', occurredAt: now.toISOString(),
  }]), false);
});

test('canonical Next Action makes blocked pending intent explicit', () => {
  const next = deriveNextAction({ id: 'CE-L1', stage: 'follow_up', email: lead.email }, lead, {
    activities: [pair], now,
    bookingLinkBlocker: {
      code: 'mailbox_observation',
      label: 'Booking link pending — waiting for mailbox health',
      reason: 'owning observer unavailable',
    },
  });
  assert.equal(next.type, ACTION_TYPE.BOOKING_LINK_PENDING);
  assert.equal(next.owner, ACTION_OWNER.AUTOMATION);
  assert.equal(next.status, ACTION_STATUS.BLOCKED);
  assert.equal(next.blockedBy, 'mailbox_observation');
  assert.match(next.label, /waiting for mailbox health/);
  assert.equal(next.intentOccurredAt, pair.occurredAt);
});

test('Outreach-only and Pipeline leads use the same pending action', () => {
  const pipeline = deriveNextAction({ id: 'CE-L1', stage: 'follow_up', email: lead.email }, lead,
    { activities: [pair], now });
  const outreachOnly = deriveNextAction({ id: 'CE-L1', stage: '', email: lead.email }, lead,
    { activities: [pair], now, outreachOnly: true });
  assert.equal(pipeline.type, ACTION_TYPE.BOOKING_LINK_PENDING);
  assert.equal(outreachOnly.type, ACTION_TYPE.BOOKING_LINK_PENDING);
  assert.equal(outreachOnly.status, ACTION_STATUS.DUE_TODAY);
});

test('reply, meeting, hold, suppression and terminal state outrank demo pending', () => {
  const replyTwin = { ...lead, emailStatus: 'replied', notes: '[REPLY: Interested]' };
  const replied = deriveNextAction({ stage: 'follow_up', email: lead.email }, replyTwin, {
    activities: [pair, { eventType: 'positive_reply', occurredAt: now.toISOString(), sourceLeadId: lead.id }], now,
  });
  assert.notEqual(replied.type, ACTION_TYPE.BOOKING_LINK_PENDING);
  assert.equal(replied.owner, ACTION_OWNER.HUMAN);

  const meeting = deriveNextAction({ stage: 'call_booked', meetingAt: '2026-09-12T18:00:00.000Z' }, lead,
    { activities: [pair], now });
  assert.equal(meeting.type, ACTION_TYPE.SALES_CALL);

  const held = deriveNextAction({ stage: 'follow_up' }, { ...lead, notes: MANUAL_HOLD_TAG },
    { activities: [pair], now });
  assert.equal(held.type, ACTION_TYPE.BLOCKED_BY_HOLD);

  const suppressed = deriveNextAction({ stage: 'follow_up' }, lead, {
    activities: [pair], now, suppressedEmails: new Set([lead.email]),
  });
  assert.equal(suppressed.status, ACTION_STATUS.NONE);

  const terminal = deriveNextAction({ stage: 'closed_won' }, lead, { activities: [pair], now });
  assert.equal(terminal.type, ACTION_TYPE.NONE_WON);
});

test('booking_link_sent resolves pending and prevents a second pending action', () => {
  const activities = [pair, {
    eventId: 'booking', sourceLeadId: lead.id, eventType: 'booking_link_sent', occurredAt: now.toISOString(),
  }];
  const next = deriveNextAction({ stage: 'follow_up' }, lead, { activities, now });
  assert.equal(hasUndeliveredDemoPair(lead, activities), false);
  assert.notEqual(next.type, ACTION_TYPE.BOOKING_LINK_PENDING);
});

test('intent observation planning does zero work with no candidates', () => {
  const plan = planIntentObservation([], [{ id: 'primary', sendEligible: true }]);
  assert.equal(plan.providerWorkRequired, false);
  assert.equal(plan.groups.size, 0);
});

test('one secondary candidate scopes work only to secondary', () => {
  const senders = [{ id: 'primary', sendEligible: true }, { id: 'secondary', sendEligible: true }];
  const plan = planIntentObservation([lead], senders);
  assert.deepEqual([...plan.groups.keys()], ['secondary']);
  assert.deepEqual(plan.groups.get('secondary'), [lead]);
});

test('multiple candidates are grouped by established sender and missing proof stays blocked', () => {
  const senders = [{ id: 'primary', sendEligible: true }, { id: 'secondary', sendEligible: true }];
  const a = { ...lead, id: 'A', senderInboxId: 'primary' };
  const b = { ...lead, id: 'B', senderInboxId: 'secondary' };
  const c = { ...lead, id: 'C', senderInboxId: '' };
  const plan = planIntentObservation([a, b, c], senders);
  assert.deepEqual([...plan.groups.keys()], ['primary', 'secondary']);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, 'sender_proof_missing');
});

test('runtime persists pair before delivery and cold cadence excludes pending intent', () => {
  const prepare = agent.slice(agent.indexOf('async function prepareDemoIntentCandidates'),
    agent.indexOf('async function runIntentTriggerPass'));
  const intent = agent.slice(agent.indexOf('async function runIntentTriggerPass'), agent.indexOf('// ── SELECTION'));
  const selector = agent.slice(agent.indexOf('function selectFollowUps'), agent.indexOf('function countTodaySends'));
  assert.match(prepare, /buildDemoPairActivity/);
  assert.match(prepare, /recordColdCallActivityStrict\(event\)/);
  assert.ok(agent.indexOf('prepareDemoIntentCandidates(all, snapshot)')
    < agent.indexOf('runHumanOutboundPass(\n        candidates'));
  assert.match(intent, /deliverHardenedWarmReply/);
  assert.match(intent, /BOOKING_LINK_EVENT/);
  assert.match(selector, /hasUndeliveredDemoPair\(l, activities\)/);
});

test('three-minute worker exits before Gmail with zero candidates and scopes Sent queries by recipient', () => {
  const branch = agent.slice(agent.indexOf('if (INTENT_ONLY && !CHECK_ONLY)'),
    agent.indexOf('let todaySent', agent.indexOf('if (INTENT_ONLY && !CHECK_ONLY)')));
  assert.ok(branch.indexOf('if (!preparedIntent.due.length)') < branch.indexOf('runHumanOutboundPass('));
  assert.match(branch, /planIntentObservation\(preparedIntent\.due, GMAIL_SENDERS\)/);
  assert.match(branch, /runReplyCheckPass\(preparedIntent\.due,[\s\S]*intentSenderIds,[\s\S]*advanceCheckpoint: false/);
  assert.match(branch, /must never advance the mailbox-wide cursor/);
  assert.match(agent, /candidate_observation_no_cursor_advance/);
  assert.match(agent, /candidateOnly[\s\S]*recipientScope/);
});

test('Outreach detail returns canonical Next Action and drawer contains no cold-date decision fork', () => {
  const endpoint = server.slice(server.indexOf("app.get('/api/coldemail/:id/activity'"),
    server.indexOf("app.patch('/api/coldemail/:id/stage'"));
  const drawer = browser.slice(browser.indexOf('function openCeDetail(id)'),
    browser.indexOf('// Table cell text'));
  assert.match(endpoint, /nextAction = deriveNextAction/);
  assert.match(endpoint, /nextAction,/);
  assert.match(browser, /lead\.canonicalNextAction = data\.pipeline && data\.pipeline\.nextAction/);
  assert.match(drawer, /const next = lead\.canonicalNextAction/);
  assert.doesNotMatch(drawer, /delayDays = stepNum|nextDate\.setDate|Follow-up sends in/);
});

test('historical repair is targeted, confirmed, evidence-based and has no send path', () => {
  assert.match(repair, /--repair-lead=/);
  assert.match(repair, /--confirm-no-send/);
  assert.match(repair, /--backfill-fired-deliveries/);
  assert.match(repair, /buildDemoPairActivity/);
  assert.match(repair, /booking link was delivered after audit; refusing/);
  assert.doesNotMatch(repair, /sendEmail|gmail\.users|messages\.send|deliverProspectReply/);
});
