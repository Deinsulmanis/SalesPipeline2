'use strict';

// Phase 2.4 — metric definitions.
//
// The bug this phase existed to fix: two classification sources. The Outreach
// cards read legacy [REPLY: ...] tags and reported 22 replies with 4 positive,
// while the funnel read canonical provider evidence and reported 16 genuine
// replies with 3 positive. Same question, two answers, because only one of them
// was handed the activity index.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildReplyMetrics, buildReplyRecords, filterReplyRecords,
  GENUINE_REPLY_CATEGORIES, ANALYTICS_CATEGORY,
} = require('../integrations/reply-analytics');
const { buildFunnelAnalytics, rate } = require('../integrations/funnel-analytics');
const { HUMAN_OUTBOUND_EVENT, outboundEventId } = require('../integrations/human-outbound');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const browser = readSource(path.join(root, 'public', 'index.html'));

// One lead per canonical bucket, each with provider-backed evidence.
const canonical = (id, state, extra = {}) => ({
  eventId: `gmail-reply:${id}`, sourceLeadId: id, leadId: `CE-${id}`,
  eventType: 'positive_reply', occurredAt: '2026-08-10T00:00:00.000Z',
  metadata: JSON.stringify({ canonicalState: state, gmailMessageId: `m-${id}`, ...extra }),
});
const lead = (id, over = {}) => ({
  id, company: `${id} Clinic`, email: `${id}@clinic.test`,
  emailStatus: 'replied', notes: '', ...over,
});

function world() {
  const leads = [
    lead('pos'), lead('neg'), lead('human'), lead('uncl', { notes: '[REPLY: Replied]' }),
    lead('auto'), lead('contact'), lead('unk'),
    lead('cold', { emailStatus: 'emailed' }),           // contacted, never replied
  ];
  const activitiesByLeadId = new Map([
    ['pos', [canonical('pos', 'positive', { reason: 'explicit_evaluation_intent' })]],
    ['neg', [canonical('neg', 'negative', { reason: 'explicit_rejection' })]],
    ['human', [canonical('human', 'needs_human', { reason: 'question_or_objection' })]],
    ['auto', [canonical('auto', 'automated_reply', { subtype: 'temporary_closure' })]],
    ['contact', [canonical('contact', 'contact_change_review', { proposedEmail: 'new@x.test' })]],
  ]);
  return { leads, activitiesByLeadId };
}

// ── 1–4. The partition ──────────────────────────────────────────────────────

test('1. automated replies are excluded from genuine replies', () => {
  const { leads, activitiesByLeadId } = world();
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.automatedReply, 1);
  assert.ok(!GENUINE_REPLY_CATEGORIES.includes(ANALYTICS_CATEGORY.AUTOMATED_REPLY));
  assert.equal(metrics.genuineReplies, metrics.inboundMessages - metrics.automatedReply
    - metrics.contactChangeReview - metrics.unknown);
});

test('2. contact-change is neither positive nor negative', () => {
  const { leads, activitiesByLeadId } = world();
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.contactChangeReview, 1);
  assert.ok(!GENUINE_REPLY_CATEGORIES.includes(ANALYTICS_CATEGORY.CONTACT_CHANGE_REVIEW));
  const records = buildReplyRecords(leads, { activitiesByLeadId });
  const row = records.find(r => r.leadId === 'contact');
  assert.equal(row.category, ANALYTICS_CATEGORY.CONTACT_CHANGE_REVIEW);
});

test('3. unknown stays its own visible bucket, never folded away', () => {
  const { leads, activitiesByLeadId } = world();
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.ok(metrics.unknown >= 1, 'the evidence-free lead is counted as unknown');
  assert.notEqual(metrics.unknown, 0);
  // And it is on screen rather than hidden to make percentages tidy.
  assert.ok(browser.includes('id="ce-stat-unknown"'));
});

test('4. the classification partition reconciles exactly', () => {
  const { leads, activitiesByLeadId } = world();
  const m = buildReplyMetrics(leads, { activitiesByLeadId });
  const sum = m.positive + m.negative + m.needsHuman + m.unclassified
    + m.automatedReply + m.contactChangeReview + m.unknown;
  assert.equal(sum, m.inboundMessages, 'buckets must sum to inbound-message leads');
  assert.equal(m.reconciles, true);
});

// ── 5–7. Denominators ───────────────────────────────────────────────────────

test('5/6. the two positive rates use different denominators and different labels', () => {
  const { leads, activitiesByLeadId } = world();
  const m = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(m.positiveReplyRate, m.positive / m.delivered * 100, 'positive / delivered');
  assert.equal(m.positiveOfReplies, m.positive / m.genuineReplies * 100, 'positive / genuine replies');
  assert.notEqual(m.positiveReplyRate, m.positiveOfReplies, 'they are not the same number');
  // ...so they must never share a label.
  for (const label of ['Positive Reply Rate', 'Positive of Replies', 'Genuine Reply Rate']) {
    assert.ok(browser.includes(label), label);
  }
});

test('7. a zero denominator renders unavailable, never a fake 0%', () => {
  const m = buildReplyMetrics([], {});
  assert.equal(m.genuineReplyRate, null);
  assert.equal(m.positiveReplyRate, null);
  assert.equal(m.positiveOfReplies, null);
  assert.equal(rate(0, 0), null);
  // The browser renders an em dash for null rather than 0.0%.
  assert.match(browser, /const pct = value => \(value === null \|\| value === undefined \? '—'/);
});

// ── 8–9. Sends vs contacted ─────────────────────────────────────────────────

test('8. send events and unique contacted leads are different metrics', () => {
  const leads = [
    { id: 'a', email: 'a@x.test', emailStatus: 'emailed', lastEmailedAt: '2026-08-01T00:00:00Z' },
    { id: 'b', email: 'b@x.test', emailStatus: 'emailed', lastEmailedAt: '2026-08-01T00:00:00Z' },
  ];
  // Lead 'a' was mailed three times; contacted counts the LEAD once.
  const activities = [
    { eventId: 's1', sourceLeadId: 'a', eventType: 'initial_email_sent', occurredAt: '2026-08-01T00:00:00Z', metadata: '{}' },
    { eventId: 's2', sourceLeadId: 'a', eventType: 'follow_up_sent', occurredAt: '2026-08-04T00:00:00Z', metadata: '{}' },
    { eventId: 's3', sourceLeadId: 'a', eventType: 'follow_up_sent', occurredAt: '2026-08-09T00:00:00Z', metadata: '{}' },
    { eventId: 's4', sourceLeadId: 'b', eventType: 'initial_email_sent', occurredAt: '2026-08-01T00:00:00Z', metadata: '{}' },
  ];
  const funnel = buildFunnelAnalytics({ leads, activities, boardLeads: [], replyRecords: [], currentVersion: 'v' }, { version: 'lifetime' });
  assert.equal(funnel.counts.sent, 2, 'contacted is lead-based');
  assert.equal(funnel.eventCounts.emailsSent, 4, 'sends are message-based');
  assert.notEqual(funnel.counts.sent, funnel.eventCounts.emailsSent);
  // The UI must not call one the other.
  assert.ok(!/stat-label">Contacted<\/div>[\s\S]{0,200}emailsSent/.test(browser));
});

test('9. Daily Sends is server-aggregated and independent of page or filter', () => {
  const server = readSource(path.join(root, 'server.js'));
  assert.match(server, /const sendTypes = new Set\(\['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent'\]\)/);
  assert.match(server, /timeZone: 'America\/Vancouver'/);
  assert.match(server, /if \(seenSendEvents\.has\(eventKey\)\) continue;/, 'deduped by event id');
  // The chart reads the server aggregate, never the visible rows.
  assert.match(browser, /ceOutreachStats\?\.sendActivity/);
  // Scoped to the function BODY — anchoring on the first mention would match
  // the call site in loadWorkspace and prove nothing.
  const chart = browser.slice(browser.indexOf('function buildSendChart'), browser.indexOf('function renderCeTable'));
  assert.ok(!/ceLeads/.test(chart), 'the chart is never rebuilt from the loaded page');
  assert.match(chart, /ceOutreachStats\?\.sendActivity/);
  assert.match(chart, /CHART_DAYS = 14/);
});

// ── 10. Human outbound ──────────────────────────────────────────────────────

test('10. human_response_sent never touches reply metrics', () => {
  const { leads, activitiesByLeadId } = world();
  const before = buildReplyMetrics(leads, { activitiesByLeadId });
  const withOutbound = new Map(activitiesByLeadId);
  withOutbound.set('pos', [...activitiesByLeadId.get('pos'), {
    eventId: outboundEventId('gm-1'), sourceLeadId: 'pos', eventType: HUMAN_OUTBOUND_EVENT,
    occurredAt: '2026-08-11T00:00:00.000Z', metadata: JSON.stringify({ direction: 'outbound', actor: 'human' }),
  }]);
  const after = buildReplyMetrics(leads, { activitiesByLeadId: withOutbound });
  for (const key of ['inboundMessages', 'genuineReplies', 'positive', 'negative', 'needsHuman',
    'unclassified', 'automatedReply', 'contactChangeReview', 'unknown']) {
    assert.equal(after[key], before[key], `${key} must not move when WE reply`);
  }
});

// ── 11–13. Attribution ──────────────────────────────────────────────────────

test('11/12. acquisition attribution survives a later recovery send', () => {
  const leads = [{ id: 'a', email: 'a@x.test', emailStatus: 'replied', notes: '[REPLY: Interested]' }];
  const activities = [
    { eventId: 's1', sourceLeadId: 'a', eventType: 'initial_email_sent', occurredAt: '2026-08-01T00:00:00Z',
      metadata: JSON.stringify({ campaignVersion: 'dental_v1_measured' }) },
    { eventId: 'p1', sourceLeadId: 'a', eventType: 'pipeline_promoted', occurredAt: '2026-08-05T00:00:00Z',
      metadata: JSON.stringify({ toStage: 'hot', acquisitionCampaignVersion: 'dental_v1_measured' }) },
    // A later recovery send under a different journey must not steal credit.
    { eventId: 's2', sourceLeadId: 'a', eventType: 'sequence_step_sent', occurredAt: '2026-08-20T00:00:00Z',
      metadata: JSON.stringify({ campaignVersion: 'dental_v1_measured', sequenceId: 'no_show_recovery_v1' }) },
  ];
  const boardLeads = [{ id: 'CE-a', email: 'a@x.test', stage: 'hot' }];
  const funnel = buildFunnelAnalytics({ leads, activities, boardLeads, replyRecords: [{ leadId: 'a', category: 'positive' }], currentVersion: 'dental_v1_measured' }, { version: 'dental_v1_measured' });
  assert.equal(funnel.counts.hot, 1, 'the acquiring campaign keeps the downstream outcome');
});

test('13. legacy_unknown never enters a measured campaign', () => {
  const leads = [{ id: 'old', email: 'old@x.test', emailStatus: 'emailed', lastEmailedAt: '2026-07-01T00:00:00Z' }];
  const measured = buildFunnelAnalytics({ leads, activities: [], boardLeads: [], replyRecords: [], currentVersion: 'dental_v1_measured' }, { version: 'dental_v1_measured' });
  assert.equal(measured.counts.sent, 0, 'unattributed history stays out of the measured cohort');
  const legacy = buildFunnelAnalytics({ leads, activities: [], boardLeads: [], replyRecords: [], currentVersion: 'dental_v1_measured' }, { version: 'legacy_unknown' });
  assert.equal(legacy.counts.sent, 1, 'and is counted as legacy');
});

// ── 14–15. Drill parity and cohort integrity ────────────────────────────────

test('14. every card count equals the unique ids its drill-down returns', () => {
  const { leads, activitiesByLeadId } = world();
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  const records = buildReplyRecords(leads, { activitiesByLeadId });
  const pairs = [
    ['all', metrics.inboundMessages], ['genuine', metrics.genuineReplies],
    ['positive', metrics.positive], ['negative', metrics.negative],
    ['needs_human', metrics.needsHuman], ['unclassified', metrics.unclassified],
    ['automated_reply', metrics.automatedReply],
    ['contact_change_review', metrics.contactChangeReview], ['unknown', metrics.unknown],
  ];
  for (const [category, count] of pairs) {
    const rows = filterReplyRecords(records, category);
    assert.equal(rows.length, count, `${category} card and drill-down disagree`);
    assert.equal(new Set(rows.map(r => r.leadId)).size, rows.length, `${category} contains a lead twice`);
  }
});

test('15. an outside-funnel opportunity never inflates cold funnel conversion', () => {
  const leads = [{ id: 'a', email: 'a@x.test', emailStatus: 'emailed', lastEmailedAt: '2026-08-01T00:00:00Z' }];
  const boardLeads = [
    { id: 'CE-a', email: 'a@x.test', stage: 'follow_up' },
    { id: 'referral-1', email: 'elsewhere@x.test', stage: 'closed_won' },   // another channel
  ];
  const funnel = buildFunnelAnalytics({ leads, activities: [], boardLeads, replyRecords: [], currentVersion: 'v' }, { version: 'lifetime' });
  assert.equal(funnel.counts.won, 0, 'a win from another channel is not a cold-outreach win');
  assert.ok(funnel.reconciliation.outsideFunnel.total >= 1, 'but it is disclosed, not dropped');
  assert.equal(funnel.reconciliation.outsideFunnel.byStage.closed_won, 1);
});

// ── 16–18. Rates and history ────────────────────────────────────────────────

test('16/17. show rate and win rate use their stated denominators', () => {
  const mk = (held, noShow, won, lost) => {
    const leads = [], activities = [], boardLeads = [], replyRecords = [];
    let n = 0;
    const add = (kind, stage) => {
      const id = `l${n++}`;
      leads.push({ id, email: `${id}@x.test`, emailStatus: 'emailed', lastEmailedAt: '2026-08-01T00:00:00Z' });
      boardLeads.push({ id: `CE-${id}`, email: `${id}@x.test`, stage });
      activities.push({ eventId: `p-${id}`, sourceLeadId: id, eventType: 'pipeline_promoted',
        occurredAt: '2026-08-02T00:00:00Z', metadata: JSON.stringify({ toStage: 'hot', acquisitionCampaignVersion: 'legacy_unknown' }) });
      if (kind) activities.push({ eventId: `c-${id}`, sourceLeadId: id, eventType: kind, occurredAt: '2026-08-03T00:00:00Z', metadata: '{}' });
    };
    for (let i = 0; i < held; i++) add('meeting_completed', 'call_booked');
    for (let i = 0; i < noShow; i++) add('meeting_no_show', 'call_booked');
    for (let i = 0; i < won; i++) add('meeting_completed', 'closed_won');
    for (let i = 0; i < lost; i++) add('meeting_completed', 'closed_lost');
    return buildFunnelAnalytics({ leads, activities, boardLeads, replyRecords, currentVersion: 'v' }, { version: 'lifetime' });
  };
  const f = mk(3, 1, 2, 2);
  assert.equal(f.conversions.showRate, f.counts.callHeld / (f.counts.callHeld + f.counts.noShow) * 100);
  assert.equal(f.conversions.winRate, f.counts.won / (f.counts.won + f.counts.lost) * 100);
  // Zero denominators stay unavailable.
  const empty = buildFunnelAnalytics({ leads: [], activities: [], boardLeads: [], replyRecords: [], currentVersion: 'v' }, { version: 'lifetime' });
  assert.equal(empty.conversions.showRate, null);
  assert.equal(empty.conversions.winRate, null);
});

test('18. current stage never rewrites historical reply classification', () => {
  // The lead is closed now; the positive reply still happened.
  const leads = [{ id: 'a', email: 'a@x.test', emailStatus: 'replied', notes: '' }];
  const activitiesByLeadId = new Map([['a', [canonical('a', 'positive', { reason: 'explicit_evaluation_intent' })]]]);
  const metrics = buildReplyMetrics(leads, { activitiesByLeadId });
  assert.equal(metrics.positive, 1, 'history is measured, not overwritten by current state');
  const records = buildReplyRecords(leads, { activitiesByLeadId });
  assert.equal(records[0].category, ANALYTICS_CATEGORY.POSITIVE);
});

// ── One classification source ───────────────────────────────────────────────

test('the cards and the funnel read the SAME classification source', () => {
  const server = readSource(path.join(root, 'server.js'));
  // Both are handed the activity index; only one of them used to be, which is
  // exactly why the Outreach cards and the funnel disagreed in production.
  assert.match(server, /const metrics = buildReplyMetrics\(leads, \{[\s\S]{0,160}activitiesByLeadId,/);
  assert.match(server, /const replyRecords = buildReplyRecords\(leads, \{[\s\S]{0,160}activitiesByLeadId,/);
  // And the index is built before either of them.
  assert.ok(server.indexOf('const activitiesByLeadId = new Map();')
    < server.indexOf('const metrics = buildReplyMetrics(leads, {'));
});

// ── 19–23. Labels must state the metric they actually carry ─────────────────
//
// Every failure below is the same failure in a different place: a label that
// survives a change of meaning. These pin the label to the definition.

const sliceFn = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
};

test('19. the send chart is named for all outbound sends, because that is what it counts', () => {
  const server = readSource(path.join(root, 'server.js'));
  const types = server.slice(server.indexOf('sendTypes'), server.indexOf('sendTypes') + 260);
  for (const type of ['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent']) {
    assert.ok(types.includes(type), `${type} must be part of the aggregate the chart renders`);
  }
  // Counting four send types while calling it "Daily Sends" left the reader to
  // guess whether stage-sequence and booking-link sends were in it.
  assert.ok(browser.includes('All Outbound Sends — Last 14 Days'));
  assert.ok(!/>Daily Sends — Last 14 Days</.test(browser));
});

test('20. unique contacted is labelled lead-based, so it cannot be read as a send count', () => {
  const card = browser.slice(browser.indexOf('id="ce-stat-emailed"') - 400, browser.indexOf('id="ce-stat-emailed"') + 120);
  assert.ok(card.includes('Unique Contacted'));
  assert.ok(/Lead-based/.test(card), 'the card must say it counts leads, not messages');
  assert.ok(!/>Emailed</.test(card), 'the ambiguous "Emailed" label must be gone');
});

test('21. every funnel rate KPI names its denominator', () => {
  const body = sliceFn(browser, 'renderFunnelAnalytics');
  for (const label of ['Reply Rate / Sent', 'Positive Rate / Sent', 'Demo Rate / Sent']) {
    assert.ok(body.includes(label), `${label} must state its denominator`);
  }
  // The funnel divides by the sent cohort, the Outreach cards by delivered.
  // Sharing the bare label "Reply Rate" is what made the two look contradictory.
  assert.ok(!/\['Reply Rate',/.test(body));
  assert.ok(browser.includes('Genuine Reply Rate') && browser.includes('divided by delivered'));
});

test('22. campaign rows classify replies canonically, not from legacy tags', () => {
  const body = sliceFn(browser, 'buildCampaignStats');
  assert.ok(body.includes("GENUINE_REPLY_CATEGORIES.has(l.replyCategory)"));
  assert.ok(body.includes("l.replyCategory === 'positive'"));
  // The old campaign table read [REPLY: Interested] tags — a third classifier
  // that could disagree with both the cards and the funnel for the same leads.
  assert.ok(!body.includes('[REPLY: Interested]'), 'legacy tag classification must be gone');
  assert.ok(!body.includes('ceHasReplied'), 'the legacy reply predicate must not decide campaign stats');
  // And the browser's genuine set must match the backend's, exactly.
  const declared = body ? browser.slice(browser.indexOf("const GENUINE_REPLY_CATEGORIES = new Set("), browser.indexOf("const GENUINE_REPLY_CATEGORIES = new Set(") + 140) : '';
  for (const category of GENUINE_REPLY_CATEGORIES) assert.ok(declared.includes(`'${category}'`), `${category} missing from the browser genuine set`);
});

test('23. provider-reported campaign rows are marked as provider counts', () => {
  const body = sliceFn(browser, 'buildCampaignStats');
  assert.ok(body.includes("statsSource: 'smartlead'") && body.includes("statsSource: 'crm'"));
  assert.ok(browser.includes('Smartlead counts'), 'a provider-sourced row must say so rather than pass as canonical');
});

test('24. the Inbox states that it counts every inbound message, not genuine replies', () => {
  const note = browser.slice(browser.indexOf('id="inbox-note"'), browser.indexOf('id="inbox-note"') + 700);
  assert.ok(/Inbound Messages/.test(note) && /Genuine Replies/.test(note));
  // Inbox filter counts must come from the same predicate the list renders.
  const body = sliceFn(browser, 'renderInboxWorkspace');
  assert.ok(body.includes('inboxMatches(record, inboxActionFor(record))'));
  assert.ok(/INBOX_FILTERS\.map[\s\S]{0,400}inboxMatches/.test(body), 'tab counts must use the render predicate');
});

test('25. the Settings agent summary uses the same names as the analytics surfaces', () => {
  const block = browser.slice(browser.indexOf('id="as-queued"'), browser.indexOf('id="as-done"') + 200);
  // /api/coldemail/stats returns replied = metrics.totalReplies, i.e. every
  // inbound message. Calling that "Total Replies" here while Outreach called
  // the same number "Inbound Messages" is exactly the two-names-one-metric
  // problem this phase exists to remove.
  assert.ok(block.includes('Inbound Messages') && block.includes('Unique Contacted'));
  assert.ok(!/>Total Replies</.test(block) && !/>Emailed</.test(block));
  assert.ok(!/>Emailed</.test(browser), 'no surface may still say the ambiguous "Emailed"');
});
