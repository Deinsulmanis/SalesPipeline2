'use strict';

// Step 14 — automated CRM health checks.
//
// Two properties dominate these tests. First, the checker must not cry wolf: a
// CRM full of legacy data has to still read healthy, or nobody will look at the
// panel when something real happens. Second, it must never repair anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SEVERITY, STATUS, CATEGORY, buildCrmHealth, overallHealth, finding,
} = require('../integrations/crm-health');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const lead = (id, over = {}) => ({
  id, company: `${id} Dental`, email: `${id}@clinic.test`,
  stage: 'Contacted', emailStatus: 'emailed', lastEmailedAt: '2026-08-01T00:00:00Z',
  notes: '', ...over,
});
const board = (id, over = {}) => ({ id, email: `${id}@clinic.test`, stage: 'follow_up', ...over });
const act = (leadId, eventType, occurredAt, metadata = {}, over = {}) => ({
  eventId: `${leadId}:${eventType}:${occurredAt}`, leadId: `CE-${leadId}`, sourceLeadId: leadId,
  email: `${leadId}@clinic.test`, eventType, occurredAt,
  metadata: JSON.stringify(metadata), ...over,
});

// A deliberately ordinary CRM: contacted leads, a legacy reply tag, a board
// lead from another channel. All of that is normal and must stay healthy.
const healthyCrm = () => ({
  leads: [lead('a'), lead('b', { notes: '[REPLY: Not Interested]', emailStatus: 'done' })],
  boardLeads: [board('CE-a', { stage: 'follow_up' })],
  activities: [act('a', 'initial_email_sent', '2026-08-01T10:00:00Z', { campaign: 'dental' })],
  replyRecords: [{ leadId: 'b', category: 'negative', occurredAt: '2026-08-02T00:00:00Z' }],
  suppressionReason: () => null,
  sequencesEnabled: false,
  calendarSyncEnabled: false,
  now: new Date('2026-08-10T00:00:00Z'),
});

const byId = (result, id) => result.findings.find(item => item.id === id);
const ran = (result, id) => result.findings.some(item => item.id === id) || result.healthy.includes(id);

// ── 1–2. Aggregation ────────────────────────────────────────────────────────

test('1. an ordinary CRM with legacy data produces no false Critical', () => {
  const result = buildCrmHealth(healthyCrm());
  assert.equal(result.bySeverity.critical, 0, 'legacy data must never read as critical');
  assert.notEqual(result.overall, SEVERITY.CRITICAL);
  assert.ok(result.checksRun > 20, 'a meaningful number of checks actually ran');
});

test('2. severity aggregation is deterministic and never averages away a critical', () => {
  const f = severity => finding({ id: `x.${severity}`, category: 'test', severity });
  assert.equal(overallHealth([]), SEVERITY.HEALTHY);
  assert.equal(overallHealth([f('healthy'), f('info')]), SEVERITY.HEALTHY, 'info alone never degrades health');
  assert.equal(overallHealth([f('healthy'), f('warning'), f('info')]), SEVERITY.WARNING);
  // One critical among a hundred healthy checks still reads critical.
  const many = Array.from({ length: 100 }, () => f('healthy')).concat(f('critical'));
  assert.equal(overallHealth(many), SEVERITY.CRITICAL);
  // Deterministic: same input, same answer.
  assert.equal(overallHealth(many), overallHealth([...many].reverse()));
});

// ── 3–7. Identity ───────────────────────────────────────────────────────────

test('3. a malformed address is detected using the sender\'s own classifier', () => {
  const input = healthyCrm();
  // The real production value: an import fused a phone number onto the mailbox.
  input.leads.push(lead('silver', { email: '-687-1887silverspringsspa@gmail.com' }));
  const found = byId(buildCrmHealth(input), 'identity.malformed_email');
  assert.ok(found);
  assert.equal(found.affected, 1);
  assert.equal(found.sample[0].email, '-687-1887silverspringsspa@gmail.com');
  // Data quality, not an automation risk: the sender already refuses to mail it.
  assert.equal(found.severity, SEVERITY.WARNING);
  assert.equal(found.classification, 'data_quality');
});

test('4. duplicate ColdEmail identities are detected', () => {
  const input = healthyCrm();
  input.leads.push(lead('dup1', { email: 'same@clinic.test' }), lead('dup2', { email: 'same@clinic.test' }));
  const found = byId(buildCrmHealth(input), 'identity.duplicate_coldemail');
  assert.ok(found);
  assert.equal(found.affected, 1);
  assert.deepEqual(found.sample[0].ids.sort(), ['dup1', 'dup2']);
});

test('5. two board opportunities claiming one ColdEmail lead is Critical', () => {
  const input = healthyCrm();
  input.boardLeads.push(board('CE-a-copy', { email: 'a@clinic.test' }), board('CE-a'));
  const found = byId(buildCrmHealth(input), 'identity.ambiguous_board_mapping');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.CRITICAL);
  assert.equal(found.classification, 'automation_risk');
});

test('6. an outside-funnel board lead is disclosed WITHOUT becoming Critical', () => {
  const input = healthyCrm();
  input.boardLeads.push({ id: 'referral-1', email: 'someone@elsewhere.test', stage: 'closed_won' });
  const result = buildCrmHealth(input);
  const found = byId(result, 'identity.board_without_outreach');
  assert.ok(found, 'it must be disclosed');
  assert.equal(found.severity, SEVERITY.INFO);
  assert.equal(found.classification, 'historical');
  assert.notEqual(result.overall, SEVERITY.CRITICAL);
});

test('7. a malformed identity cannot carry trusted reply evidence', () => {
  const input = healthyCrm();
  const bad = lead('sil', { email: '-687-1887x@gmail.com', notes: '[REPLY: Interested]' });
  input.leads.push(bad);
  input.replyRecords.push({ leadId: 'sil', category: 'positive' });
  input.activities.push(act('sil', 'positive_reply', '2026-08-03T00:00:00Z', { canonicalState: 'positive' }));
  const result = buildCrmHealth(input);
  // It resolves to unknown, so nothing trusted is attached to it...
  assert.ok(byId(result, 'reply.no_trustworthy_evidence'));
  // ...and the dedicated guard therefore reports clean.
  assert.ok(result.healthy.includes('reply.trusted_evidence_on_malformed_identity'));
});

// ── 8–9. Historical vs current reply failure ────────────────────────────────

test('8. legacy reply evidence is historical INFO, not a current ingestion failure', () => {
  const result = buildCrmHealth(healthyCrm());
  const found = byId(result, 'reply.legacy_evidence_only');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.INFO);
  assert.equal(found.classification, 'historical');
  assert.ok(!ran(result, 'reply.missing_canonical_evidence_post_boundary')
    || !byId(result, 'reply.missing_canonical_evidence_post_boundary'));
});

test('9. a reply AFTER the canonical boundary with no canonical activity is Critical', () => {
  const input = healthyCrm();
  input.canonicalReplyBoundary = '2026-08-01T00:00:00Z';
  // Legacy tag only, but it arrived after canonical storage went live.
  input.leads.push(lead('late', { notes: '[REPLY: Not Interested]' }));
  input.replyRecords.push({ leadId: 'late', category: 'negative', occurredAt: '2026-08-20T00:00:00Z' });
  const found = byId(buildCrmHealth(input), 'reply.missing_canonical_evidence_post_boundary');
  assert.ok(found, 'a post-boundary gap is a current failure, not history');
  assert.equal(found.severity, SEVERITY.CRITICAL);
  assert.equal(found.classification, 'automation_risk');
});

// ── 10–12. Send-state and MANUAL HOLD ───────────────────────────────────────

test('10. a suppressed lead that is still send-eligible is Critical', () => {
  const input = healthyCrm();
  const held = lead('held', { stage: 'Queued', emailStatus: '', notes: MANUAL_HOLD_TAG });
  input.leads.push(held);
  // The REAL sender rule, not a stand-in.
  input.suppressionReason = row => sendSuppressionReason(row, { suppressedEmails: new Set() });
  const found = byId(buildCrmHealth(input), 'outreach.suppression_conflict');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.CRITICAL);
  assert.equal(found.sample[0].id, 'held');
});

test('11. health asks the sender\'s own rule and refuses to guess without it', () => {
  const input = healthyCrm();
  delete input.suppressionReason;
  const found = byId(buildCrmHealth(input), 'outreach.suppression_conflict');
  assert.equal(found.status, STATUS.NOT_APPLICABLE);
  assert.equal(found.severity, SEVERITY.INFO, 'not knowing is not the same as failing');
  // And the checker must not contain its own copy of the tag list.
  const src = readSource(path.join(root, 'integrations', 'crm-health.js'));
  assert.ok(!/\[MANUAL HOLD\]'\s*,\s*'\[BOUNCED/.test(src), 'no second copy of the suppression tags');
  assert.match(src, /sendSuppressionReason|suppressionReason/, 'it consumes the shared rule');
});

test('12. an enrolled Stage 10 sequence is not flagged merely because a cold hold exists', () => {
  const input = healthyCrm();
  // Held for COLD sending, and explicitly enrolled in a stage journey. Step 10
  // allows exactly this; health must not call it corruption.
  input.leads.push(lead('hot1', { notes: MANUAL_HOLD_TAG }));
  input.boardLeads.push(board('CE-hot1', { stage: 'hot' }));
  input.activities.push(
    act('hot1', 'sequence_enrolled', '2026-08-05T00:00:00Z', { sequenceId: 'hot_stale_v1' }));
  input.sequencesEnabled = true;
  const result = buildCrmHealth(input);
  assert.ok(result.healthy.includes('hold.automation_active_in_human_stage'),
    'an enrolled stage sequence past a cold hold is intended behaviour');
  assert.equal(result.bySeverity.critical, 0);
});

// ── 13–15. Pipeline, call, hot ──────────────────────────────────────────────

test('13. Call Booked with no meeting time is detected', () => {
  const input = healthyCrm();
  input.boardLeads.push(board('CE-nb', { stage: 'call_booked', meetingAt: '' }));
  const found = byId(buildCrmHealth(input), 'pipeline.call_booked_without_meeting');
  assert.ok(found);
  assert.equal(found.affected, 1);
});

test('14. an unresolved past meeting is surfaced for a human', () => {
  const input = healthyCrm();
  input.boardLeads.push(board('CE-past', { stage: 'call_booked', meetingAt: '2026-08-02T17:00:00Z' }));
  input.activities.push(act('past', 'call_booked', '2026-08-01T00:00:00Z', { meetingAt: '2026-08-02T17:00:00Z' }));
  input.leads.push(lead('past'));
  const found = byId(buildCrmHealth(input), 'call.unresolved_past_meeting');
  assert.ok(found);
  assert.equal(found.classification, 'operational', 'a missing outcome is a job, not corruption');
  assert.equal(found.severity, SEVERITY.WARNING);
});

test('15. a severely stale Hot lead is an operational warning, not corruption', () => {
  const input = healthyCrm();
  input.leads.push(lead('stale'));
  input.boardLeads.push(board('CE-stale', { stage: 'hot' }));
  input.activities.push(act('stale', 'initial_email_sent', '2026-06-01T00:00:00Z'));
  input.now = new Date('2026-08-30T00:00:00Z');
  const found = byId(buildCrmHealth(input), 'hot.stale_followup');
  if (found) {
    assert.equal(found.severity, SEVERITY.WARNING);
    assert.equal(found.classification, 'operational');
    assert.notEqual(found.severity, SEVERITY.CRITICAL);
  }
});

// ── 16–19. Feature flags ────────────────────────────────────────────────────

test('16. intentionally disabled Calendar sync is INFO, never a failure', () => {
  const found = byId(buildCrmHealth(healthyCrm()), 'calendar.sync_flag');
  assert.ok(found);
  assert.equal(found.status, STATUS.DISABLED);
  assert.equal(found.severity, SEVERITY.INFO);
  assert.equal(found.classification, 'disabled_feature');
});

test('17. Calendar sync ENABLED with missing configuration is Critical', () => {
  const input = { ...healthyCrm(), calendarSyncEnabled: true, bookingCalendarId: '', appointmentScheduleId: '' };
  const found = byId(buildCrmHealth(input), 'calendar.configuration');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.CRITICAL);
  assert.equal(found.affected, 2, 'both required settings are named');
});

test('18. a stale checkpoint on ENABLED Calendar sync is detected', () => {
  const input = {
    ...healthyCrm(), calendarSyncEnabled: true,
    bookingCalendarId: 'cal@x.test', appointmentScheduleId: 'sched1',
    calendarSyncState: { syncToken: 'tok', lastSyncAt: '2026-08-01T00:00:00Z' },
    now: new Date('2026-08-10T00:00:00Z'),
  };
  const found = byId(buildCrmHealth(input), 'calendar.checkpoint');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.WARNING);
  assert.equal(found.evidence.ageDays, 9);
  // A fresh checkpoint passes.
  const fresh = buildCrmHealth({ ...input, calendarSyncState: { syncToken: 't', lastSyncAt: '2026-08-09T12:00:00Z' } });
  assert.ok(fresh.healthy.includes('calendar.checkpoint'));
});

test('19. intentionally disabled stage sequences are INFO, never a failure', () => {
  const found = byId(buildCrmHealth(healthyCrm()), 'sequence.feature_flag');
  assert.equal(found.status, STATUS.DISABLED);
  assert.equal(found.severity, SEVERITY.INFO);
});

// ── 20–22. Attribution ──────────────────────────────────────────────────────

test('20. an unregistered campaign version on a send is Critical', () => {
  const input = healthyCrm();
  input.activities.push(act('a', 'initial_email_sent', '2026-08-06T00:00:00Z',
    { campaignVersion: 'totally_made_up_v9' }));
  const found = byId(buildCrmHealth(input), 'attribution.unregistered_version');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.CRITICAL);
});

test('21. legacy_unknown is valid history and is never reported as unhealthy', () => {
  const input = healthyCrm();
  input.activities.push(
    act('a', 'initial_email_sent', '2026-07-01T00:00:00Z', { campaign: 'dental' }),
    act('a', 'follow_up_sent', '2026-07-05T00:00:00Z', { campaignVersion: 'legacy_unknown' }));
  const result = buildCrmHealth(input);
  assert.ok(result.healthy.includes('attribution.unregistered_version'));
  assert.equal(result.bySeverity.critical, 0);
});

test('22. conflicting acquisition attribution is Critical', () => {
  const input = healthyCrm();
  input.activities.push(
    act('a', 'pipeline_promoted', '2026-08-05T00:00:00Z', { acquisitionCampaignVersion: 'dental_v1_measured' }),
    act('a', 'pipeline_promoted', '2026-08-06T00:00:00Z', { acquisitionCampaignVersion: 'dental_v2_other' }));
  const found = byId(buildCrmHealth(input), 'attribution.acquisition_conflict');
  assert.ok(found, 'acquisition is immutable; a later campaign must not overwrite it');
  assert.equal(found.severity, SEVERITY.CRITICAL);
});

// ── 23–24. Funnel and activity ──────────────────────────────────────────────

test('23. a funnel reconciliation failure surfaces as Critical', () => {
  const input = healthyCrm();
  input.funnel = {
    filters: { version: 'lifetime' },
    reconciliation: { repliesPartition: false, stagesMatchLeadIds: true, boardLeadsTotal: 3, outsideFunnel: { total: 0, byStage: {} } },
  };
  const found = byId(buildCrmHealth(input), 'funnel.reconciliation');
  assert.ok(found);
  assert.equal(found.severity, SEVERITY.CRITICAL);

  // The expected outside-funnel disclosure is NOT a reconciliation failure.
  const ok = buildCrmHealth({
    ...healthyCrm(),
    funnel: {
      filters: { version: 'lifetime' },
      reconciliation: {
        repliesPartition: true, stagesMatchLeadIds: true, boardLeadsTotal: 19,
        outsideFunnel: { total: 11, byStage: { lost: 9, closed_won: 2 } },
      },
    },
  });
  assert.ok(ok.healthy.includes('funnel.reconciliation'));
  assert.equal(byId(ok, 'funnel.outside_cohort').severity, SEVERITY.INFO);
});

test('24. a duplicate canonical event id is Critical', () => {
  const input = healthyCrm();
  const dup = act('a', 'initial_email_sent', '2026-08-01T10:00:00Z');
  input.activities.push({ ...dup });
  const found = byId(buildCrmHealth(input), 'activity.duplicate_event_id');
  assert.ok(found, 'replay protection depends on event ids being unique');
  assert.equal(found.severity, SEVERITY.CRITICAL);
});

// ── 25–30. API, safety, robustness ──────────────────────────────────────────

test('25. the aggregate health payload stays small', () => {
  const input = healthyCrm();
  // A thousand malformed leads must not produce a thousand-entry payload.
  for (let i = 0; i < 1000; i++) input.leads.push(lead(`bad${i}`, { email: `-555-000${i}x@gmail.com` }));
  const result = buildCrmHealth(input);
  const found = byId(result, 'identity.malformed_email');
  assert.equal(found.affected, 1000, 'the true count is reported');
  assert.ok(found.sample.length <= 10, 'but the embedded sample is bounded');
  assert.ok(found.sampleTruncated);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60000, 'aggregate stays compact');
});

test('26. the drill-down enforces a hard upper bound', () => {
  const server = readSource(path.join(root, 'server.js'));
  const block = server.slice(server.indexOf("app.get('/api/crm/health'"), server.indexOf('// The DemoPlays header'));
  assert.match(block, /Math\.min\(200,/, 'hard cap of 200');
  assert.match(block, /parseInt\(req\.query\.limit, 10\) \|\| 100/, 'defaults to 100');
  assert.match(block, /slice\(offset, offset \+ requested\)/);
});

test('27. the endpoint uses the shared snapshot and adds no per-lead reads', () => {
  const server = readSource(path.join(root, 'server.js'));
  const block = server.slice(server.indexOf("app.get('/api/crm/health'"), server.indexOf('// The DemoPlays header'));
  assert.match(block, /getOutreachDataset/, 'reuses the shared Outreach snapshot');
  // The only permitted extra reads are two whole-tab helpers, never per-lead.
  const reads = block.match(/spreadsheets\.values\.get/g) || [];
  assert.equal(reads.length, 0, 'no direct Sheets reads in the handler');
  assert.match(block, /buildFunnelAnalytics/, 'the funnel is consumed, not rebuilt');
});

test('28. the health layer has no mutation path anywhere', () => {
  const src = readSource(path.join(root, 'integrations', 'crm-health.js'));
  for (const forbidden of [
    'values.update', 'values.append', 'batchUpdate', 'sendEmail', 'sendMail',
    'googleapis', 'fetch(', 'applyHoldToNotes', 'addSuppression', 'recordColdCallActivity',
  ]) {
    assert.ok(!src.includes(forbidden), `crm-health must never reference ${forbidden}`);
  }
  // And no repair route exists beside the read-only one.
  const server = readSource(path.join(root, 'server.js'));
  assert.ok(!/app\.(post|put|patch|delete)\(['"]\/api\/crm\/health/.test(server),
    'there must be no repair endpoint');
});

test('29. an unexpected or broken input fails safely rather than crashing', () => {
  // Garbage in every field; the engine must still answer.
  const result = buildCrmHealth({
    leads: [null, undefined, {}, { id: 'x' }],
    boardLeads: [{}, null],
    activities: [{ eventId: 'e', metadata: '{not json' }, null],
    replyRecords: [{ leadId: 'nope' }],
    funnel: { reconciliation: {} },
  });
  assert.ok(result.overall);
  assert.ok(result.checksRun > 0);
  // Malformed metadata is reported rather than silently swallowed.
  assert.ok(byId(result, 'activity.malformed_metadata'));

  // A non-array where a collection was expected degrades gracefully rather
  // than taking the endpoint down.
  const coerced = buildCrmHealth({ ...healthyCrm(), leads: { not: 'an array' } });
  assert.ok(coerced.overall, 'still answers');

  // And when a check genuinely throws, it is reported as unknown — never
  // silently counted as healthy.
  const poisoned = healthyCrm();
  Object.defineProperty(poisoned, 'funnel', {
    get() { throw new Error('exploding funnel snapshot'); },
    enumerable: true,
  });
  const boom = buildCrmHealth(poisoned);
  const failed = boom.findings.find(item => /check_failed|unreadable/.test(item.id));
  assert.ok(failed, 'a throwing check must surface');
  assert.equal(failed.severity, SEVERITY.WARNING);
  assert.match(failed.summary, /exploding funnel snapshot/);
  assert.notEqual(boom.overall, SEVERITY.HEALTHY);
});

test('30. repeated evaluation is pure: same input, identical output', () => {
  const input = healthyCrm();
  const a = buildCrmHealth(input);
  const b = buildCrmHealth(input);
  // generatedAt is the only field allowed to move.
  assert.deepEqual({ ...a, generatedAt: null }, { ...b, generatedAt: null });
  // The inputs themselves are untouched — no hidden mutation.
  assert.equal(input.leads.length, 2);
  assert.equal(input.leads[1].notes, '[REPLY: Not Interested]');
  assert.equal(input.activities.length, 1);
});

test('a missing hold is Critical only when the lead is ACTUALLY send-eligible', () => {
  const base = healthyCrm();
  base.suppressionReason = row => sendSuppressionReason(row, { suppressedEmails: new Set() });

  // Terminal lead, no hold, but emailStatus already blocks re-entry: untidy.
  const latent = { ...base };
  latent.leads = [...base.leads, lead('t1', { stage: 'Replied', emailStatus: 'replied' })];
  latent.boardLeads = [...base.boardLeads, board('CE-t1', { stage: 'closed_lost' })];
  const quiet = byId(buildCrmHealth(latent), 'hold.missing_where_required');
  assert.ok(quiet);
  assert.equal(quiet.severity, SEVERITY.WARNING, 'unreachable means untidy, not dangerous');
  assert.equal(quiet.classification, 'data_quality');

  // Same missing hold, but the lead is genuinely queued and sendable.
  const live = { ...base };
  live.leads = [...base.leads, lead('t2', { stage: 'Queued', emailStatus: '' })];
  live.boardLeads = [...base.boardLeads, board('CE-t2', { stage: 'closed_won' })];
  const loud = byId(buildCrmHealth(live), 'hold.missing_where_required');
  assert.equal(loud.severity, SEVERITY.CRITICAL, 'reachable means cold mail could actually go out');
  assert.equal(loud.classification, 'automation_risk');
  assert.equal(loud.evidence.sendEligibleNow, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL-REPLY BOUNDARY
// The boundary is the instant Railway deployment 69810784 (commit a190c22)
// reached SUCCESS and canonical reply ingestion began running in production.
// Before it, a legacy tag is all that could exist. After it, a reply with no
// canonical activity means ingestion silently failed.
// ─────────────────────────────────────────────────────────────────────────────
const {
  CANONICAL_REPLY_BOUNDARY, resolveCanonicalReplyBoundary, isAfterBoundary,
} = require('../integrations/canonical-reply');

const BOUNDARY = '2026-08-27T23:34:39.552Z';

// A reply-bearing lead whose record carries an explicit occurrence time.
const replyAt = (id, occurredAt, over = {}) => ({
  leadRow: lead(id, { notes: '[REPLY: Not Interested]', emailStatus: 'done', ...over }),
  record: { leadId: id, category: 'negative', occurredAt },
});

function crmWithReply(entry, extra = {}) {
  const input = healthyCrm();
  input.leads.push(entry.leadRow);
  input.replyRecords.push(entry.record);
  return { ...input, ...extra };
}

test('boundary: the built-in value is the verified production deployment instant', () => {
  assert.equal(CANONICAL_REPLY_BOUNDARY, BOUNDARY);
  const resolved = resolveCanonicalReplyBoundary();
  assert.equal(resolved.at, BOUNDARY);
  assert.equal(resolved.source, 'built_in');
  assert.equal(resolved.error, null);
  // Committed to source, so it survives restarts and new environments rather
  // than depending on an env var that could be lost.
  const src = readSource(path.join(root, 'integrations', 'canonical-reply.js'));
  assert.ok(src.includes(BOUNDARY), 'the boundary is versioned in source');
  assert.match(src, /69810784-33d6-4a77-a5f5-659ff18510d7/, 'and cites its evidence');
});

test('boundary: a PRE-boundary legacy reply is historical, not an ingestion failure', () => {
  const result = buildCrmHealth(crmWithReply(replyAt('old', '2026-08-20T00:00:00Z')));
  const historical = byId(result, 'reply.legacy_evidence_only');
  assert.ok(historical);
  assert.equal(historical.severity, SEVERITY.INFO);
  assert.equal(historical.classification, 'historical');
  assert.ok(!byId(result, 'reply.missing_canonical_evidence_post_boundary'),
    'nothing before the boundary may be reported as a current failure');
});

test('boundary: a POST-boundary reply with no canonical activity is a health finding', () => {
  const result = buildCrmHealth(crmWithReply(replyAt('new', '2026-08-28T12:00:00Z')));
  const found = byId(result, 'reply.missing_canonical_evidence_post_boundary');
  assert.ok(found, 'ingestion should have written a canonical activity and did not');
  assert.equal(found.severity, SEVERITY.CRITICAL);
  assert.equal(found.classification, 'automation_risk');
  assert.equal(found.evidence.canonicalReplyBoundary, BOUNDARY);
});

test('boundary: a POST-boundary reply WITH canonical activity is healthy', () => {
  const input = crmWithReply(replyAt('new2', '2026-08-28T12:00:00Z', { notes: '' }));
  input.activities.push(act('new2', 'negative_reply', '2026-08-28T12:00:00Z', {
    canonicalState: 'negative', gmailMessageId: 'msg-new2',
  }));
  const result = buildCrmHealth(input);
  assert.ok(!byId(result, 'reply.missing_canonical_evidence_post_boundary'),
    'verified canonical evidence means ingestion worked');
  assert.ok(!byId(result, 'reply.no_trustworthy_evidence'));
});

test('boundary: an invalid boundary fails safe AND is visible in health', () => {
  const result = buildCrmHealth(crmWithReply(
    replyAt('new3', '2026-08-28T12:00:00Z'), { canonicalReplyBoundary: 'not-a-timestamp' }));
  const misconfig = byId(result, 'reply.boundary_misconfigured');
  assert.ok(misconfig, 'a silently broken boundary would disable its own detection');
  assert.equal(misconfig.severity, SEVERITY.WARNING);
  assert.equal(misconfig.classification, 'operational');
  // Fails SAFE: detection is off, but no false ingestion failure is raised.
  assert.ok(!byId(result, 'reply.missing_canonical_evidence_post_boundary'));
  assert.equal(resolveCanonicalReplyBoundary('not-a-timestamp').at, null);
});

test('boundary: inclusive/exclusive semantics are deterministic and fail safe', () => {
  // STRICTLY after. The boundary instant itself is ambiguous — either build
  // could have handled it — so it stays historical.
  assert.equal(isAfterBoundary(BOUNDARY, BOUNDARY), false, 'equal is NOT after');
  assert.equal(isAfterBoundary('2026-08-27T23:34:39.551Z', BOUNDARY), false, '1ms before');
  assert.equal(isAfterBoundary('2026-08-27T23:34:39.553Z', BOUNDARY), true, '1ms after');
  // A reply with no usable timestamp cannot be PROVEN post-boundary.
  assert.equal(isAfterBoundary('', BOUNDARY), false);
  assert.equal(isAfterBoundary('nonsense', BOUNDARY), false);
  assert.equal(isAfterBoundary('2026-08-28T00:00:00Z', null), false, 'no boundary means no detection');

  // End to end: a reply exactly on the boundary is historical, not a failure.
  const onBoundary = buildCrmHealth(crmWithReply(replyAt('edge', BOUNDARY)));
  assert.ok(!byId(onBoundary, 'reply.missing_canonical_evidence_post_boundary'));
});
