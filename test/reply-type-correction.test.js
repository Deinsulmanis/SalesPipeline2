'use strict';

// Reply type correction from the Analytics reply list (2026-11-24): a person
// fixes a reply the agent read wrong, and every analytics count follows it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildReplyRecords, buildReplyMetrics } = require('../integrations/reply-analytics');
const { buildClassificationOverride, reverseOverride, OVERRIDE_KIND } = require('../integrations/reply-overrides');

const LEAD = { id: 'L77', email: 'owner@acme-test.invalid', company: 'Acme Staffing', emailStatus: 'emailed', stage: 'Contacted', notes: '' };

const reply = (state, at = '2026-11-20T15:00:00.000Z') => ({
  eventId: `reply-${state}-${at}`, leadId: `CE-${LEAD.id}`, sourceLeadId: LEAD.id, email: LEAD.email, company: LEAD.company,
  eventType: state === 'positive' ? 'positive_reply' : 'negative_reply', occurredAt: at, subject: 'Re: hello',
  content: 'reply text', metadata: JSON.stringify({ canonicalState: state, reason: state === 'negative' ? 'not_interested' : '' }),
});

// The same row the server writes: an append-only override activity.
function overrideRow({ state, subtype = null, at = '2026-11-21T10:00:00.000Z', fromPanel = false }) {
  const built = buildClassificationOverride({ leadId: `CE-${LEAD.id}`, previousState: 'negative', state, subtype,
    reason: 'agent misread it', by: 'crm_user', at });
  assert.equal(built.ok, true, built.error);
  return { eventId: `override-${state}-${at}`, leadId: `CE-${LEAD.id}`, sourceLeadId: fromPanel ? '' : LEAD.id,
    email: LEAD.email, company: LEAD.company, eventType: OVERRIDE_KIND.CLASSIFICATION, occurredAt: at,
    subject: 'Reply type corrected', content: 'agent misread it', metadata: JSON.stringify(built.record) };
}

function reversalRow(original, at = '2026-11-22T10:00:00.000Z') {
  const reversed = reverseOverride({ ...JSON.parse(original.metadata), overrideId: original.eventId }, { by: 'crm_user', at, reason: 'undo' });
  return { ...original, eventId: `reversal-${at}`, occurredAt: at, metadata: JSON.stringify(reversed.record) };
}

// Grouped exactly as the snapshot does (server: sourceLeadId, else leadId without CE-).
function byLead(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
    map.set(key, [...(map.get(key) || []), row]);
  }
  return map;
}

const recordFor = rows => buildReplyRecords([LEAD], { activitiesByLeadId: byLead(rows) })[0];
const metricsFor = rows => buildReplyMetrics([LEAD], { activitiesByLeadId: byLead(rows) });

test('the agent\'s reading stands until a person corrects it', () => {
  const record = recordFor([reply('negative')]);
  assert.equal(record.category, 'negative');
  assert.equal(record.override, null);
  assert.equal(metricsFor([reply('negative')]).negative, 1);
});

test('a correction changes the category and every count, and records what it replaced', () => {
  const rows = [reply('negative'), overrideRow({ state: 'positive' })];
  const record = recordFor(rows);
  assert.equal(record.category, 'positive');
  assert.equal(record.override.state, 'positive');
  assert.equal(record.override.previousState, 'negative');
  assert.equal(record.override.reason, 'agent misread it');
  const metrics = metricsFor(rows);
  assert.equal(metrics.positive, 1);
  assert.equal(metrics.negative, 0);
  assert.equal(metrics.reconciles, true);
});

test('undo restores the agent\'s reading; the audit trail keeps both records', () => {
  const correction = overrideRow({ state: 'positive' });
  const rows = [reply('negative'), correction, reversalRow(correction)];
  const record = recordFor(rows);
  assert.equal(record.category, 'negative');
  assert.equal(record.override, null);
  assert.equal(metricsFor(rows).negative, 1);
});

test('an opt-out correction counts as negative and as an unsubscribe', () => {
  const rows = [reply('positive'), overrideRow({ state: 'negative', subtype: 'unsubscribe_request' })];
  const record = recordFor(rows);
  assert.equal(record.category, 'negative');
  assert.equal(record.unsubscribe, true);
  const metrics = metricsFor(rows);
  assert.equal(metrics.negative, 1);
  assert.equal(metrics.unsubscribed, 1);
  // Only a negative correction may be marked as an opt-out.
  assert.equal(buildClassificationOverride({ leadId: 'CE-1', state: 'positive', subtype: 'unsubscribe_request', reason: 'x' }).ok, false);
  assert.equal(buildClassificationOverride({ leadId: 'CE-1', state: 'negative', subtype: 'made_up', reason: 'x' }).ok, false);
});

test('a correction made from the lead panel counts the same way', () => {
  const record = recordFor([reply('negative'), overrideRow({ state: 'needs_human', fromPanel: true })]);
  assert.equal(record.category, 'needs_human');
  assert.equal(record.override.previousState, 'negative');
});

test('a later correction wins over an earlier one', () => {
  const rows = [reply('negative'), overrideRow({ state: 'positive' }),
    overrideRow({ state: 'automated_reply', at: '2026-11-23T10:00:00.000Z' })];
  assert.equal(recordFor(rows).category, 'automated_reply');
});

// ── Server and page wiring ───────────────────────────────────────────────────
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const routeBody = start => {
  const at = server.indexOf(start);
  assert.ok(at >= 0, start);
  return server.slice(at, server.indexOf('\n});', at));
};

test('server: the correction is an audited activity row on the outreach lead, scoped and fresh, and changes nothing else', () => {
  const save = routeBody("app.post('/api/coldemail/:id/reply-classification', requireAuth");
  assert.match(save, /getOutreachDataset\(\{ force: true \}\)/, 'reads fresh state, not a cached display snapshot');
  assert.match(save, /outreachClientView\(dataset, req\.query\)/, 'scoped to the active workspace');
  assert.match(save, /this lead has no reply to classify/);
  assert.match(save, /buildClassificationOverride\(\{/);
  assert.match(save, /leadId: `CE-\$\{id\}`, sourceLeadId: id/);
  assert.match(save, /appendColdCallActivities\(\[/);
  for (const forbidden of [/sendEmail|deliver[A-Z]\w*\(/, /addSuppression|handleUnsubscribe/, /applyLeadChange|stage:/, /applyHoldToNotes|MANUAL HOLD/]) {
    assert.doesNotMatch(save, forbidden);
  }
  const undo = routeBody("app.post('/api/coldemail/:id/reply-classification/reverse'");
  assert.match(undo, /reverseOverride\(/);
  assert.match(undo, /outreachLeadOverrideRow\(row, id\)/, 'only a correction belonging to this lead can be undone');
  assert.doesNotMatch(undo, /sendEmail|addSuppression|applyLeadChange/);
});

test('page: each reply in the Analytics list can be corrected with a labelled type and reason, and undone', () => {
  assert.match(html, /const RD_CORRECTION_OPTIONS = Object\.freeze\(\[/);
  for (const label of ['Positive', 'Negative (not interested)', 'Opt-out / unsubscribe', 'Needs Human',
    'Automated (out of office, autoresponder)', 'Contact change', 'Not a real reply (Unknown)']) {
    assert.ok(html.includes(`label: '${label}'`), label);
  }
  assert.match(html, /onclick="startReplyCorrection\(this\.dataset\.lead\)">Change type<\/button>/);
  assert.match(html, /<label for="rd-fix-type">What was this reply really\?/);
  assert.match(html, /<label for="rd-fix-reason">Why \(kept in the audit trail\)/);
  assert.match(html, /\/reply-classification\?client=\$\{encodeURIComponent\(activeClientId\)\}/);
  assert.match(html, /\/reply-classification\/reverse\?client=/);
  assert.match(html, /data-kind="corrected"/);
  // After a correction the list and the cards above it recount.
  assert.match(html, /async function reloadReplyRecordsAfterCorrection\(\) \{[\s\S]*?loadCeLeads\(\)/);
});

test('funnel: a corrected lead\'s per-step reply follows the correction', () => {
  const funnel = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'funnel-analytics.js'), 'utf8');
  assert.match(funnel, /const correctedLeads = new Set\(replyRecords\.filter\(row => row\.override\)/);
  assert.match(funnel, /correctedLeads\.has\(id\) \? categoryByLead\.get\(id\) : categoryForReply\(reply, categoryByLead\.get\(id\)\)/);
});
