'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ANALYTICS_CATEGORY,
  analyticsCategoryFor,
  leadHasReply,
  buildReplyMetrics,
  buildStoredClassificationMap,
  planReplyBackfill,
  applyBackfillPlan,
} = require('../integrations/reply-analytics');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'integrations', 'reply-analytics.js'), 'utf8');

function lead(id, notes = '', overrides = {}) {
  return { id, stage: 'Replied', emailStatus: 'replied', notes, ...overrides };
}

test('positive reply increments Positive and Total Replies', () => {
  const metrics = buildReplyMetrics([lead('p', '[REPLY: Interested]')]);
  assert.equal(metrics.totalReplies, 1);
  assert.equal(metrics.positive, 1);
});

test('negative reply increments Negative without requiring unsubscribe', () => {
  const row = lead('n', '[REPLY: Not Interested]', { stage: 'Done', emailStatus: 'done' });
  const before = structuredClone(row);
  const metrics = buildReplyMetrics([row]);
  assert.equal(metrics.negative, 1);
  assert.deepEqual(row, before);
  assert.doesNotMatch(row.notes, /Unsubscribed/);
});

test('question and ambiguous categories increment Needs Human', () => {
  const classificationsByLeadId = new Map([['a', ['ambiguous']]]);
  const metrics = buildReplyMetrics([
    lead('q', '[REPLY: Question — draft awaiting review]'),
    lead('a', ''),
  ], { classificationsByLeadId });
  assert.equal(metrics.needsHuman, 2);
});

test('existing Replies semantics count unique replying leads and exclude OOO-only rows', () => {
  const rows = [
    lead('same', '[REPLY: Interested]'),
    lead('same', '[REPLY: Interested]'),
    lead('status-only', ''),
    lead('ooo', '[REPLY: OOO — retry in 7d]', { emailStatus: 'emailed' }),
  ];
  assert.equal(leadHasReply(rows[2]), true);
  assert.equal(leadHasReply(rows[3]), false);
  assert.equal(buildReplyMetrics(rows).totalReplies, 2);
});

test('historical classified replies use stored classification directly', () => {
  const stored = buildStoredClassificationMap({
    drafts: [{ leadId: 'legacy', classification: 'positive', createdAt: '2026-01-01T00:00:00Z' }],
  });
  const metrics = buildReplyMetrics([lead('legacy', '')], { classificationsByLeadId: stored });
  assert.equal(metrics.positive, 1);
  assert.equal(metrics.unclassified, 0);
});

test('activity and provider classifications feed the same future metric path', () => {
  const stored = buildStoredClassificationMap({
    activities: [{ sourceLeadId: 'activity', eventType: 'meeting_requested', occurredAt: '2026-01-02T00:00:00Z' }],
    providerMappings: [{ internalLeadId: 'provider', normalizedStatus: 'Not interested', lastProviderEventAt: '2026-01-03T00:00:00Z' }],
  });
  const metrics = buildReplyMetrics([lead('activity'), lead('provider')], { classificationsByLeadId: stored });
  assert.equal(metrics.positive, 1);
  assert.equal(metrics.negative, 1);
});

test('legacy category aliases normalize consistently', () => {
  for (const value of ['positive', 'POSITIVE', 'interested', 'replied_positive']) {
    assert.equal(analyticsCategoryFor(value), ANALYTICS_CATEGORY.POSITIVE, value);
  }
  for (const value of ['negative', 'NOT_INTERESTED', 'wrong fit', 'already_solved', 'unsubscribed']) {
    assert.equal(analyticsCategoryFor(value), ANALYTICS_CATEGORY.NEGATIVE, value);
  }
  for (const value of ['needs human', 'NEUTRAL', 'question', 'wrong_person']) {
    assert.equal(analyticsCategoryFor(value), ANALYTICS_CATEGORY.NEEDS_HUMAN, value);
  }
});

test('historical unclassified reply text can be planned with canonical deterministic logic', () => {
  const plan = planReplyBackfill([{ replyId: 'r1', leadId: 'l1', replyText: 'No thanks, not interested' }]);
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].classification, 'NOT_INTERESTED');
});

test('backfill skips already-classified replies and duplicate records', () => {
  const row = { replyId: 'r1', leadId: 'l1', replyText: 'Yes please', classification: 'INTERESTED' };
  const plan = planReplyBackfill([row, row]);
  assert.equal(plan.alreadyClassified, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.ready.length, 0);
});

test('backfill application is idempotent and writes classification metadata only through its callback', async () => {
  const plan = planReplyBackfill([{ replyId: 'r1', leadId: 'l1', replyText: 'Yes please' }]);
  const existingKeys = new Set();
  const writes = [];
  const writer = async item => writes.push(item);
  assert.deepEqual(await applyBackfillPlan(plan, { existingKeys, writeClassification: writer }), { written: 1, skipped: 0 });
  assert.deepEqual(await applyBackfillPlan(plan, { existingKeys, writeClassification: writer }), { written: 0, skipped: 1 });
  assert.equal(writes.length, 1);
});

test('unclassifiable or missing historical text is never guessed or sent to a model', () => {
  const plan = planReplyBackfill([
    { replyId: 'unclear', leadId: 'l1', replyText: 'Maybe later' },
    { replyId: 'empty', leadId: 'l2', replyText: '' },
  ]);
  assert.equal(plan.ready.length, 0);
  assert.equal(plan.requiresExternalClassification, 1);
  assert.equal(plan.noText, 1);
});

test('unsubscribe remains a negative analytic reply and its existing suppression tag is untouched', () => {
  const row = lead('u', '[REPLY: Unsubscribed]', { stage: 'Unsub', emailStatus: 'done' });
  const metrics = buildReplyMetrics([row]);
  assert.equal(metrics.negative, 1);
  assert.equal(row.notes, '[REPLY: Unsubscribed]');
});

test('new canonical reply tags automatically feed metrics', () => {
  const cases = [
    ['[REPLY: Interested]', 'positive'],
    ['[REPLY: Not Interested]', 'negative'],
    ['[REPLY: Needs human]', 'needsHuman'],
  ];
  for (const [notes, metric] of cases) assert.equal(buildReplyMetrics([lead(metric, notes)])[metric], 1);
});

test('metrics reconcile including Unclassified', () => {
  const metrics = buildReplyMetrics([
    lead('p', '[REPLY: Interested]'), lead('n', '[REPLY: Not Interested]'),
    lead('h', '[REPLY: Needs human]'), lead('u', ''),
  ]);
  assert.equal(metrics.totalReplies, 4);
  assert.equal(metrics.reconciles, true);
  assert.equal(metrics.totalReplies, metrics.positive + metrics.negative + metrics.needsHuman + metrics.unclassified);
});

test('Positive Reply Rate uses positive unique leads over delivered contacted leads', () => {
  const metrics = buildReplyMetrics([
    lead('p', '[REPLY: Interested]'),
    lead('n', '[REPLY: Not Interested]'),
    lead('sent', '', { stage: 'Contacted', emailStatus: 'emailed' }),
    lead('bounce', '[BOUNCED]', { stage: 'Done', emailStatus: 'done' }),
  ]);
  assert.equal(metrics.delivered, 3);
  assert.ok(Math.abs(metrics.positiveReplyRate - 100 / 3) < 1e-10);
});

test('existing Outreach counts remain in the compact stats response', () => {
  assert.match(server, /const counts = \{ queued: 0, emailed: 0, replied: 0, done: 0 \}/);
  assert.match(server, /res\.json\(\{ \.\.\.counts, replied: replyMetrics\.totalReplies, replyMetrics \}\)/);
  assert.match(browser, /ce-stat-total/);
  assert.match(browser, /ce-stat-queued/);
  assert.match(browser, /ce-stat-emailed/);
  assert.match(browser, /ce-stat-opens/);
  assert.match(browser, /ce-stat-warm/);
});

test('reply analytics and backfill contain no send or stage/status mutation path', () => {
  assert.doesNotMatch(analyticsSource, /sendEmail\(|spreadsheets\.values|lead\.stage\s*=|lead\.emailStatus\s*=/i);
});

test('desktop reply cards use the existing six-column visual system', () => {
  assert.match(browser, /\.reply-metrics-bar\s*\{[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  for (const id of ['ce-stat-replied','ce-stat-positive','ce-stat-negative','ce-stat-needs-human','ce-stat-unclassified','ce-stat-positive-rate']) {
    assert.match(browser, new RegExp(`id="${id}"`));
  }
});

test('mobile reply cards collapse to two columns without horizontal layout dependence', () => {
  const desktopRule = browser.indexOf('grid-template-columns: repeat(6, minmax(0, 1fr))');
  const effectiveMobileRule = browser.indexOf('.reply-metrics-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }', desktopRule);
  assert.ok(desktopRule >= 0);
  assert.ok(effectiveMobileRule > desktopRule, 'mobile override must follow the desktop rule in the cascade');
});
