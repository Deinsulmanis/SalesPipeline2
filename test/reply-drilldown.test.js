'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ANALYTICS_CATEGORY,
  buildReplyMetrics,
  buildReplyRecords,
  buildReplyEvidenceMap,
  filterReplyRecords,
} = require('../integrations/reply-analytics');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout hands these tests CRLF
// source while an editor-written file is LF. Normalising on read keeps the
// slicing and regexes below independent of how git materialised the file.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

function lead(id, notes = '', overrides = {}) {
  return {
    id, company: `${id} Dental`, contactName: `Dr ${id}`, email: `${id}@example.com`,
    stage: 'Replied', emailStatus: 'replied', lastEmailedAt: '2026-08-01T00:00:00.000Z',
    notes, ...overrides,
  };
}

function activity(sourceLeadId, eventType, occurredAt, content, metadata = {}) {
  return {
    eventId: `${sourceLeadId}-${occurredAt}`, leadId: `CE-${sourceLeadId}`, sourceLeadId,
    email: `${sourceLeadId}@example.com`, company: `${sourceLeadId} Dental`,
    eventType, occurredAt, subject: 'Re: your note', content,
    metadata: JSON.stringify(metadata),
  };
}

// A cross-section covering every canonical bucket plus non-reply noise.
const LEADS = [
  lead('a', '[REPLY: Interested]'),
  lead('b', '[REPLY: Meeting Requested]'),
  lead('c', '[REPLY: Not Interested]'),
  lead('d', '[REPLY: Question]'),
  lead('e', ''),                                         // emailStatus 'replied' only
  lead('f', '[REPLY: OOO]', { emailStatus: 'emailed' }), // excluded: not a human reply
  lead('g', '', { emailStatus: 'emailed' }),             // contacted, never replied
];
const ACTIVITIES = [
  activity('a', 'positive_reply', '2026-08-10T10:00:00.000Z', 'Yes please, send details.'),
  activity('b', 'meeting_requested', '2026-08-12T10:00:00.000Z', 'Can we talk Tuesday?'),
  activity('d', 'late_reply', '2026-08-11T10:00:00.000Z', 'What does this cost?', { detectedAfterSequence: true }),
];

function records() {
  return buildReplyRecords(LEADS, { evidenceByLeadId: buildReplyEvidenceMap(ACTIVITIES) });
}

// ── Card ↔ drill-down reconciliation ────────────────────────────────────────

test('drill-down row count matches every card count', () => {
  const metrics = buildReplyMetrics(LEADS);
  const all = records();
  assert.equal(all.length, metrics.totalReplies);
  assert.equal(filterReplyRecords(all, 'positive').length, metrics.positive);
  assert.equal(filterReplyRecords(all, 'negative').length, metrics.negative);
  assert.equal(filterReplyRecords(all, 'needs_human').length, metrics.needsHuman);
  assert.equal(filterReplyRecords(all, 'unclassified').length, metrics.unclassified);
});

test('Total Replies drill-down returns every counted reply', () => {
  const all = filterReplyRecords(records(), 'all');
  assert.deepEqual(all.map(r => r.leadId).sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('Positive opens only positive records', () => {
  const rows = filterReplyRecords(records(), 'positive');
  assert.deepEqual(rows.map(r => r.leadId).sort(), ['a', 'b']);
  assert.ok(rows.every(r => r.category === ANALYTICS_CATEGORY.POSITIVE));
});

test('Negative opens only negative records', () => {
  const rows = filterReplyRecords(records(), 'negative');
  assert.deepEqual(rows.map(r => r.leadId), ['c']);
  assert.ok(rows.every(r => r.category === ANALYTICS_CATEGORY.NEGATIVE));
});

test('Needs Human opens only the canonical needs-human bucket', () => {
  const rows = filterReplyRecords(records(), 'needs_human');
  assert.deepEqual(rows.map(r => r.leadId), ['d']);
  assert.ok(rows.every(r => r.category === ANALYTICS_CATEGORY.NEEDS_HUMAN));
});

test('a row with no reply evidence is UNKNOWN, not Unclassified', () => {
  // Lead 'e' only has emailStatus 'replied' — a spreadsheet cell, not a message.
  assert.deepEqual(filterReplyRecords(records(), 'unclassified').map(r => r.leadId), []);
  const unknown = filterReplyRecords(records(), 'unknown');
  assert.deepEqual(unknown.map(r => r.leadId), ['e']);
  assert.ok(unknown.every(r => r.category === ANALYTICS_CATEGORY.UNKNOWN));
});

test('categories partition the total exactly, leaving no orphan rows', () => {
  const all = records();
  const sum = ['positive', 'negative', 'needs_human', 'unclassified', 'unknown']
    .reduce((total, category) => total + filterReplyRecords(all, category).length, 0);
  assert.equal(sum, all.length);
});

// ── Counting semantics ──────────────────────────────────────────────────────

test('rows use unique-lead semantics: multiple replies collapse to one row', () => {
  const many = [
    activity('a', 'positive_reply', '2026-08-10T10:00:00.000Z', 'First reply.'),
    activity('a', 'late_reply', '2026-08-15T10:00:00.000Z', 'Second reply.'),
    activity('a', 'positive_reply', '2026-08-12T10:00:00.000Z', 'Third reply.'),
  ];
  const rows = buildReplyRecords([lead('a', '[REPLY: Interested]')], {
    evidenceByLeadId: buildReplyEvidenceMap(many),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].replyCount, 3);
  assert.equal(rows[0].replyText, 'Second reply.', 'row shows the latest reply');
});

test('a duplicated lead id is never rendered twice', () => {
  const duped = [lead('a', '[REPLY: Interested]'), lead('a', '[REPLY: Interested]')];
  assert.equal(buildReplyRecords(duped).length, 1);
  assert.equal(buildReplyMetrics(duped).totalReplies, 1);
});

// ── Sorting ─────────────────────────────────────────────────────────────────

test('rows are sorted newest reply first', () => {
  const times = records().map(r => r.occurredAt);
  const sorted = [...times].sort().reverse();
  assert.deepEqual(times, sorted);
});

test('needs-human rows carry the reply timestamp used for sorting', () => {
  const row = filterReplyRecords(records(), 'needs_human')[0];
  assert.equal(row.occurredAt, '2026-08-11T10:00:00.000Z');
});

// ── Row content ─────────────────────────────────────────────────────────────

test('reply text is inspectable and identifying fields are present', () => {
  const row = filterReplyRecords(records(), 'positive').find(r => r.leadId === 'a');
  assert.equal(row.replyText, 'Yes please, send details.');
  assert.equal(row.hasText, true);
  assert.equal(row.company, 'a Dental');
  assert.equal(row.contactName, 'Dr a');
  assert.equal(row.email, 'a@example.com');
});

test('missing reply text is an explicit flag, not a blank string', () => {
  const row = filterReplyRecords(records(), 'unknown')[0];
  assert.equal(row.hasText, false);
  assert.equal(row.replyText, '');
  assert.match(browser, /Reply text unavailable/);
});

test('late replies surface existing metadata rather than new logic', () => {
  const row = filterReplyRecords(records(), 'needs_human')[0];
  assert.equal(row.late, true);
  assert.equal(filterReplyRecords(records(), 'positive').find(r => r.leadId === 'a').late, false);
});

test('stage travels to the client for display only', () => {
  assert.ok(records().every(r => typeof r.stage === 'string'));
  // rdStageLabel reads stage; no drill-down code path writes one.
  assert.match(browser, /function rdStageLabel\(record\)/);
  assert.ok(!/rdStageLabel[\s\S]{0,400}(setCeLeadStage|moveLeadToStage)/.test(browser));
});

// ── Existing analytics unchanged ────────────────────────────────────────────

test('existing reply counts are unchanged by the drill-down refactor', () => {
  const metrics = buildReplyMetrics(LEADS);
  assert.equal(metrics.totalReplies, 5);
  assert.equal(metrics.positive, 2);
  assert.equal(metrics.negative, 1);
  assert.equal(metrics.needsHuman, 1);
  assert.equal(metrics.unclassified, 0, 'no row is merely unclassified any more');
  assert.equal(metrics.unknown, 1, 'the evidence-free row is explicitly unknown');
  assert.equal(metrics.reconciles, true);
});

test('positive reply rate is unchanged and still divides by delivered', () => {
  const metrics = buildReplyMetrics(LEADS);
  assert.equal(metrics.delivered, 7);
  assert.equal(metrics.contacted, 7);
  assert.equal(metrics.positiveReplyRate, 2 / 7 * 100);
});

test('supplying reply evidence never changes the counts', () => {
  const bare = buildReplyMetrics(LEADS);
  const withEvidence = buildReplyMetrics(LEADS, { evidenceByLeadId: buildReplyEvidenceMap(ACTIVITIES) });
  assert.deepEqual(withEvidence, bare);
});

// ── API and UI wiring ───────────────────────────────────────────────────────

test('the replies endpoint is read-only, authenticated, and category-filtered', () => {
  assert.match(server, /app\.get\('\/api\/coldemail\/replies', requireAuth/);
  const handler = server.slice(server.indexOf("app.get('/api/coldemail/replies'"));
  const body = handler.slice(0, handler.indexOf('\napp.'));
  // Records are built once in the shared snapshot; the endpoint filters them.
  assert.match(server, /buildReplyRecords\(leads, \{/);
  assert.match(body, /filterReplyRecords\(dataset\.replyRecords, category\)/);
  assert.ok(!/values\.(update|append|batchUpdate|clear)/.test(body), 'endpoint performs no sheet writes');
});

test('drill-down reuses canonical records instead of reclassifying in the browser', () => {
  assert.match(browser, /fetch\('\/api\/coldemail\/replies\?category=all' \+ version\)/);
  // No second category mapping in the browser: rows carry the server's category.
  assert.ok(!/INTERESTED|MEETING_REQUEST|NOT_INTERESTED/.test(browser.slice(
    browser.indexOf('function openReplyDrill'), browser.indexOf('function renderReplyDrill'))));
});

test('all five cards are keyboard-activatable buttons, not click-only divs', () => {
  for (const category of ['all', 'positive', 'negative', 'needs_human', 'unclassified']) {
    const pattern = new RegExp(`<button type="button" class="stat[^"]*stat-clickable"[^>]*openReplyDrill\\('${category}'\\)`);
    assert.match(browser, pattern, `${category} card is a button`);
  }
  assert.match(browser, /\.stat-clickable:focus-visible \{ outline:2px solid var\(--accent\)/);
  assert.match(browser, /\.stat-clickable \{[^}]*cursor:pointer/);
});

test('clicking a company opens the existing lead drawer, not a second UI', () => {
  assert.match(browser, /function rdOpenLead\(leadId\) \{\s*closeReplyDrill\(\);\s*openCeDetail\(leadId\);/);
  assert.match(browser, /class="rd-company" onclick="rdOpenLead\(/);
});

test('category tabs and Escape allow switching and closing without reopening', () => {
  assert.match(browser, /role="tablist"/);
  assert.match(browser, /aria-selected="\$\{c\.id === rdCategory\}"/);
  assert.match(browser, /if \(e\.key !== 'Escape'\) return;[\s\S]*closeReplyDrill\(\)/);
});

test('the panel title names the category and its count', () => {
  assert.match(browser, /Replies — \$\{RD_CATEGORY_LABEL\[rdCategory\]\} \(\$\{all\.length\}\)/);
});

test('desktop and mobile layouts are both defined for the panel', () => {
  assert.match(browser, /\.rd-panel \{ width: 640px; max-width: 100vw; \}/);
  const mobile = browser.slice(browser.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.rd-panel \{ width:100vw/);
  assert.match(mobile, /\.rd-row-top \{ flex-direction:column/);
  assert.match(mobile, /#reply-drill-overlay \.modal-close \{ min-width:44px; min-height:44px; \}/);
  // Reply bodies wrap instead of forcing horizontal scroll.
  assert.match(browser, /\.rd-reply \{[^}]*white-space:pre-wrap; word-break:break-word/);
});

// ── Safety ──────────────────────────────────────────────────────────────────

test('no card interaction can mutate: the drill-down issues only GETs', () => {
  const start = browser.indexOf('// ── REPLY DRILL-DOWN');
  const block = browser.slice(start, browser.indexOf('function closeCeDetail'));
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(block), 'no mutating fetch');
  assert.ok(!/sendEmail|suppress|setCeLeadStage|moveLeadToStage|reclassif/i.test(block),
    'no send, suppression, stage, or classification path');
  assert.equal((block.match(/fetch\(/g) || []).length, 1, 'exactly one read request');
});

test('the analytics module stays free of sending and suppression paths', () => {
  const source = readSource(path.join(root, 'integrations', 'reply-analytics.js'));
  assert.ok(!/sendEmail|addSuppression|gmail\(|sheets\(/.test(source));
});
