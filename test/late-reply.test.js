'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_LATE_REPLY_LOOKBACK_DAYS,
  latestOutboundReferences,
  existingLateReplyEventIds,
  selectLateReplyCandidates,
  lateReplyEventId,
  processLateReply,
} = require('../integrations/late-reply');
const { buildReplyMetrics, buildStoredClassificationMap } = require('../integrations/reply-analytics');

const NOW = '2026-08-26T19:00:00.000Z';
const recent = '2026-08-20T19:00:00.000Z';

function lead(overrides = {}) {
  return {
    id: 'lead-1', company: 'Example Dental', email: 'owner@example.ca', stage: 'Done',
    emailStatus: 'done', lastEmailedAt: recent, emailStep: '3', notes: '', ...overrides,
  };
}

function outbound(overrides = {}) {
  return {
    eventId: 'gmail:sent-1', leadId: 'CE-lead-1', sourceLeadId: 'lead-1',
    eventType: 'follow_up_sent', occurredAt: recent,
    metadata: JSON.stringify({ gmailMessageId: 'sent-1', gmailThreadId: 'thread-1' }),
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    messageId: 'reply-1', threadId: 'thread-1', rfcMessageId: '<reply-1@example.ca>',
    fromAddr: 'owner@example.ca', occurredAt: '2026-08-24T18:00:00.000Z',
    subject: 'Re: quick question', body: 'Sure, I am interested.', ...overrides,
  };
}

function harness(classification = 'INTERESTED') {
  const writes = [];
  const suppressions = [];
  const activities = [];
  const eventIds = new Set();
  return {
    writes, suppressions, activities, eventIds,
    deps: {
      classify: async () => classification,
      existingEventIds: eventIds,
      writeNotes: async (_lead, notes) => writes.push(notes),
      addSuppression: async target => suppressions.push(target.email),
      recordActivity: async activity => activities.push(activity),
    },
  };
}

test('active emailed reply checking remains scoped to emailed leads', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(source, /leads\.filter\(l => l\.emailStatus === 'emailed' && isValidEmail\(l\.email\)\)/);
  assert.match(source, /await runReplyCheckPass\(all, todaySent\)/);
});

test('recent done lead with recorded Gmail identity is eligible', () => {
  const plan = selectLateReplyCandidates([lead()], [outbound()], { now: NOW });
  assert.equal(DEFAULT_LATE_REPLY_LOOKBACK_DAYS, 60);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].outbound.threadId, 'thread-1');
});

test('old done lead outside lookback is not polled or altered', () => {
  const old = lead({ lastEmailedAt: '2026-05-01T00:00:00.000Z' });
  assert.equal(selectLateReplyCandidates([old], [outbound()], { now: NOW }).candidates.length, 0);
  assert.equal(old.emailStatus, 'done');
});

test('terminal lead without both Gmail message and thread identity is skipped', () => {
  const missingThread = outbound({ metadata: JSON.stringify({ gmailMessageId: 'sent-1' }) });
  const plan = selectLateReplyCandidates([lead()], [missingThread], { now: NOW });
  assert.equal(plan.stats.usableIdentity, 0);
  assert.equal(plan.candidates.length, 0);
});

test('latest usable outbound identity is selected', () => {
  const refs = latestOutboundReferences([
    outbound(),
    outbound({ eventId: 'gmail:sent-2', occurredAt: '2026-08-21T00:00:00Z', metadata: JSON.stringify({ gmailMessageId: 'sent-2', gmailThreadId: 'thread-2' }) }),
  ]);
  assert.deepEqual(refs.get('lead-1'), { messageId: 'sent-2', threadId: 'thread-2', occurredAt: '2026-08-21T00:00:00Z', attribution: { campaignVersion: 'legacy_unknown' } });
});

test('unsubscribed, bounced, suppressed, malformed, and non-done leads are excluded', () => {
  const inputs = [
    lead({ id: 'u', notes: '[REPLY: Unsubscribed]' }),
    lead({ id: 'b', notes: '[BOUNCED]' }),
    lead({ id: 's', email: 'blocked@example.ca' }),
    lead({ id: 'm', email: 'bad' }),
    lead({ id: 'a', emailStatus: 'emailed' }),
  ];
  const acts = inputs.map((item, index) => outbound({ sourceLeadId: item.id, leadId: `CE-${item.id}`, eventId: `s-${index}` }));
  const plan = selectLateReplyCandidates(inputs, acts, { now: NOW, suppressedEmails: new Set(['blocked@example.ca']) });
  assert.equal(plan.candidates.length, 0);
});

test('batch limit bounds additional Gmail checks', () => {
  const leads = Array.from({ length: 5 }, (_, i) => lead({ id: `l${i}`, email: `l${i}@example.ca` }));
  const acts = leads.map(item => outbound({ sourceLeadId: item.id, leadId: `CE-${item.id}` }));
  const plan = selectLateReplyCandidates(leads, acts, { now: NOW, batchLimit: 2 });
  assert.equal(plan.stats.eligible, 5);
  assert.equal(plan.candidates.length, 2);
});

for (const [classification, expectedNote] of [
  ['INTERESTED', '[REPLY: Interested]'],
  ['NOT_INTERESTED', '[REPLY: Not Interested]'],
  ['NEEDS_HUMAN', '[REPLY: Needs human]'],
]) {
  test(`late ${classification.toLowerCase()} reply is classified, surfaced, and recorded`, async () => {
    const h = harness(classification);
    const result = await processLateReply({ lead: lead(), message: message(), ...h.deps });
    assert.equal(result.status, 'recorded');
    assert.match(h.writes[0], /\[LATE REPLY:/);
    assert.match(h.writes[0], new RegExp(expectedNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(h.activities.length, 1);
    assert.equal(JSON.parse(h.activities[0].metadata).classification, classification);
  });
}

test('same Gmail reply message is recorded once across repeated polling', async () => {
  const h = harness('INTERESTED');
  const first = await processLateReply({ lead: lead(), message: message(), ...h.deps });
  const second = await processLateReply({ lead: lead(), message: message(), ...h.deps });
  assert.equal(first.status, 'recorded');
  assert.equal(second.status, 'duplicate');
  assert.equal(h.activities.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.eventIds.has(lateReplyEventId('reply-1')), true);
});

test('persisted late-reply event ids deduplicate after process restart', () => {
  const ids = existingLateReplyEventIds([{ eventId: 'gmail-reply:reply-1', eventType: 'late_reply' }]);
  assert.equal(ids.has('gmail-reply:reply-1'), true);
});

for (const [classification, metric] of [
  ['INTERESTED', 'positive'], ['NOT_INTERESTED', 'negative'], ['NEEDS_HUMAN', 'needsHuman'],
]) {
  test(`late ${classification.toLowerCase()} reply feeds ${metric} Outreach analytics`, async () => {
    const h = harness(classification);
    const target = lead();
    await processLateReply({ lead: target, message: message(), ...h.deps });
    const classificationsByLeadId = buildStoredClassificationMap({ activities: h.activities });
    const metrics = buildReplyMetrics([target], { classificationsByLeadId });
    assert.equal(metrics.totalReplies, 1);
    assert.equal(metrics[metric], 1);
    assert.equal(metrics.reconciles, true);
  });
}

test('late unsubscribe invokes durable suppression and ordinary negative does not', async () => {
  const optOut = harness('UNSUBSCRIBE');
  await processLateReply({ lead: lead(), message: message({ body: 'unsubscribe me' }), ...optOut.deps });
  assert.deepEqual(optOut.suppressions, ['owner@example.ca']);
  assert.match(optOut.writes[0], /\[REPLY: Unsubscribed\]/);

  const negative = harness('NOT_INTERESTED');
  await processLateReply({ lead: lead(), message: message({ messageId: 'reply-2', body: 'not interested' }), ...negative.deps });
  assert.equal(negative.suppressions.length, 0);
});

test('late reply leaves all automation state and MANUAL HOLD unchanged', async () => {
  const target = lead({ notes: '[MANUAL HOLD]\nowner reviewing', emailStatus: 'done', stage: 'Done', emailStep: '3' });
  const before = { emailStatus: target.emailStatus, stage: target.stage, lastEmailedAt: target.lastEmailedAt, emailStep: target.emailStep };
  const h = harness('INTERESTED');
  await processLateReply({ lead: target, message: message(), ...h.deps });
  assert.deepEqual({ emailStatus: target.emailStatus, stage: target.stage, lastEmailedAt: target.lastEmailedAt, emailStep: target.emailStep }, before);
  assert.match(target.notes, /\[MANUAL HOLD\]/);
});

test('late-reply processor has no outbound send dependency or sequence restart path', async () => {
  const h = harness('QUESTION');
  let sends = 0;
  await processLateReply({ lead: lead(), message: message(), ...h.deps, sendEmail: async () => { sends++; } });
  assert.equal(sends, 0);
  const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'late-reply.js'), 'utf8');
  assert.doesNotMatch(source, /sendEmail|emailStatus\s*=\s*['"]emailed|lastEmailedAt\s*=/);
});

test('late watcher uses known threads without broad Gmail message search', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const body = source.slice(source.indexOf('async function getLateReplyMessages'), source.indexOf('const REPLY_CATEGORIES'));
  assert.match(body, /gmail\(\)\.users\.threads\.get/);
  assert.doesNotMatch(body, /users\.messages\.list/);
});

test('late watcher runs daily inside existing check-only scheduler without changing send cadence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /cron\.schedule\('0,30 8-11 \* \* 1-5'/);
  assert.match(source, /cron\.schedule\('15,45 \* \* \* \*'/);
  assert.match(source, /clock\.hour === '12' && clock\.minute === '15'/);
  assert.match(source, /LATE_REPLY_CHECK: 'true'/);
});

test('Outreach UI marks late replies and activity timeline uses the same event', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(source, /late_reply: 'Late reply — needs attention'/);
  assert.match(source, /\[LATE REPLY:/);
  assert.match(source, />Late reply</);
});
