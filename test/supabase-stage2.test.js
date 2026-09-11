'use strict';
/**
 * Supabase Stage 2 — canonical timeline reader, parity and fallback.
 *
 * The property that matters: an unavailable or incomplete mirror must never be
 * read as "this lead has no history", and must never replace a good
 * authoritative answer with a worse one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  timelineMode, toCanonicalActivity, sortCanonical, readCanonicalTimeline,
  compareTimelines, supabaseMayServeTimeline, CONTENT_BEARING_TYPES,
} = require('../integrations/supabase-timeline');
const { toCrmEvent, describeUnmirrorable } = require('../integrations/supabase-mirror');
const { fieldsDiffer, sameInstant, stable } = require('../scripts/supabase-parity-audit');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const sheetRow = (over = {}) => ({
  eventId: 'gmail:abc123', leadId: 'CE-lead1', sourceLeadId: 'lead1',
  email: 'a@b.com', company: 'Acme', eventType: 'initial_email_sent',
  occurredAt: '2026-09-01T10:00:00.000Z', subject: 'hello', content: 'body text',
  metadata: JSON.stringify({ senderInboxId: 'primary', gmailMessageId: 'abc123' }), ...over });
// Shaped exactly as the mirror writes it, including the columns toCrmEvent
// promotes out of metadata — a fixture missing those would fake a mismatch.
const mirrorRow = (over = {}) => ({
  event_id: 'gmail:abc123', lead_id: 'CE-lead1', source_lead_id: 'lead1',
  email: 'a@b.com', company: 'Acme', event_type: 'initial_email_sent',
  occurred_at: '2026-09-01T10:00:00+00:00', subject: 'hello',
  campaign_version: null, campaign_family: null, copy_version: null,
  sender_inbox_id: 'primary', provider_message_id: 'abc123',
  provider_thread_id: null, sequence_id: null, sequence_step: null,
  metadata: { senderInboxId: 'primary', gmailMessageId: 'abc123' }, ...over });

// ── A/B/C/D. reader shape, ordering, normalisation ─────────────────────────
test('A. a mirrored row round-trips into the canonical activity shape', () => {
  const canonical = toCanonicalActivity(mirrorRow());
  assert.equal(canonical.eventId, 'gmail:abc123');
  assert.equal(canonical.eventType, 'initial_email_sent');
  assert.equal(canonical.sourceLeadId, 'lead1');
  assert.equal(canonical.leadId, 'CE-lead1');
  assert.equal(canonical.occurredAt, '2026-09-01T10:00:00.000Z');
  assert.equal(JSON.parse(canonical.metadata).senderInboxId, 'primary');
  // content is never mirrored, and the reader says so rather than inventing it.
  assert.equal(canonical.content, '');
  assert.deepEqual(Object.keys(canonical).sort(),
    ['company', 'content', 'email', 'eventId', 'eventType', 'leadId', 'metadata', 'occurredAt', 'sourceLeadId', 'subject']);
});

test('B. ordering is deterministic, with event id breaking timestamp ties', () => {
  const rows = [
    { eventId: 'b', occurredAt: '2026-09-01T10:00:00.000Z' },
    { eventId: 'a', occurredAt: '2026-09-01T10:00:00.000Z' },
    { eventId: 'c', occurredAt: '2026-09-01T09:00:00.000Z' },
    { eventId: 'd', occurredAt: '' },
  ];
  assert.deepEqual(sortCanonical(rows).map(r => r.eventId), ['c', 'a', 'b', 'd']);
  assert.deepEqual(sortCanonical(rows, 'desc').map(r => r.eventId), ['b', 'a', 'c', 'd'],
    'unknown timestamps stay last in both directions');
  // Same input, same output.
  assert.deepEqual(sortCanonical(rows).map(r => r.eventId), sortCanonical(rows).map(r => r.eventId));
});

test('C. the same instant compares equal across offset spellings', () => {
  assert.equal(sameInstant('2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00+00:00'), true);
  assert.equal(sameInstant('2026-09-01T10:00:00.000Z', '2026-09-01T12:00:00+02:00'), true);
  assert.equal(sameInstant('2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'), false);
  assert.equal(sameInstant('', ''), true);
  assert.equal(sameInstant('2026-09-01T10:00:00Z', ''), false, 'a missing timestamp is not equal to a real one');
});

test('D. only genuinely non-semantic differences are normalised away', () => {
  // jsonb key reordering is not a difference.
  assert.equal(stable({ a: 1, b: 2 }), stable({ b: 2, a: 1 }));
  const canonical = toCrmEvent(sheetRow());
  assert.deepEqual(fieldsDiffer(canonical, mirrorRow()), [], 'an identical pair has no differences');
  // But meaningful fields are never hidden.
  for (const [field, changed] of [
    ['event_type', { event_type: 'follow_up_sent' }],
    ['occurred_at', { occurred_at: '2026-09-02T10:00:00+00:00' }],
    ['source_lead_id', { source_lead_id: 'other' }],
    ['sender_inbox_id', { sender_inbox_id: 'tryscalelabai' }],
    ['provider_message_id', { provider_message_id: 'zzz' }],
    ['metadata', { metadata: { senderInboxId: 'primary', gmailMessageId: 'DIFFERENT' } }],
  ]) {
    const diffs = fieldsDiffer(canonical, mirrorRow(changed));
    assert.ok(diffs.includes(field), `${field} must be reported`);
  }
});

// ── E/F/G/H. divergence detection ──────────────────────────────────────────
test('E/F/G/H. missing, extra, mismatched and duplicate identities are each detected', () => {
  const a = sheetRow(), b = sheetRow({ eventId: 'gmail:two', occurredAt: '2026-09-02T10:00:00.000Z' });
  // missing
  let parity = compareTimelines([a, b], [toCanonicalActivity(mirrorRow())]);
  assert.deepEqual(parity.missing, ['gmail:two']);
  assert.equal(parity.parityClean, false);
  // extra
  parity = compareTimelines([a], [toCanonicalActivity(mirrorRow()), toCanonicalActivity(mirrorRow({ event_id: 'ghost' }))]);
  assert.deepEqual(parity.extra, ['ghost']);
  assert.equal(parity.parityClean, false);
  // payload mismatch
  parity = compareTimelines([a], [toCanonicalActivity(mirrorRow({ event_type: 'follow_up_sent' }))]);
  assert.equal(parity.mismatched.length, 1);
  assert.ok(parity.mismatched[0].fields.includes('eventType'));
  // duplicate identity on the mirror side collapses to one, and the count says so
  parity = compareTimelines([a], [toCanonicalActivity(mirrorRow()), toCanonicalActivity(mirrorRow())]);
  assert.equal(parity.mirroredCount, 1, 'a duplicate event_id cannot inflate the mirrored set');
  // clean
  parity = compareTimelines([a, b], [toCanonicalActivity(mirrorRow()),
    toCanonicalActivity(mirrorRow({ event_id: 'gmail:two', occurred_at: '2026-09-02T10:00:00+00:00' }))]);
  assert.equal(parity.parityClean, true);
  assert.equal(parity.exact, 2);
  assert.equal(parity.orderMatches, true);
});

// ── I/J/K. failure and fallback behaviour ──────────────────────────────────
test('I/J. an unconfigured or unreachable mirror returns a refusal, never an empty history', async () => {
  const result = await readCanonicalTimeline({ sourceLeadId: 'lead1', env: {} });
  assert.equal(result.ok, false, 'no config means no answer, not "no events"');
  assert.equal(result.events.length, 0);
  assert.ok(result.reason);
  // A caller can therefore always tell "failed" from "genuinely empty".
  assert.equal(supabaseMayServeTimeline(result).allowed, false);
  // Missing identity is refused rather than returning the whole table.
  const noIdentity = await readCanonicalTimeline({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'k' } });
  assert.equal(noIdentity.ok, false);
  assert.match(noIdentity.reason, /identity/);
});

test('K. an empty mirror result cannot replace a non-empty authoritative result', () => {
  const empty = { ok: true, events: [], contentAvailable: false, contentBearingCount: 0 };
  assert.equal(supabaseMayServeTimeline(empty, { authoritativeCount: 12 }).allowed, false,
    'mirror says zero, Sheets says twelve — Sheets wins');
  assert.match(supabaseMayServeTimeline(empty, { authoritativeCount: 12 }).reason, /no events while the authoritative store has some/);
  // A genuinely empty lead is allowed through.
  assert.equal(supabaseMayServeTimeline(empty, { authoritativeCount: 0 }).allowed, true);
});

test('the content gap blocks promotion to primary rather than silently blanking bodies', () => {
  const withContent = { ok: true, events: [{ eventType: 'initial_email_sent' }], contentAvailable: false, contentBearingCount: 1 };
  const gate = supabaseMayServeTimeline(withContent, { authoritativeCount: 1 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /content is not mirrored/);
  // Event types that carry body text are named, not guessed.
  for (const type of ['initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent', 'human_response_sent'])
    assert.ok(CONTENT_BEARING_TYPES.has(type), type);
  assert.ok(!CONTENT_BEARING_TYPES.has('lead_queued'));
});

// ── L/M/N/O. mirror writer and backfill guarantees ─────────────────────────
test('L/M/N. the backfill is a dry run by default and idempotent by primary key', () => {
  const backfill = read('scripts/supabase-backfill.js');
  assert.match(backfill, /DRY RUN IS THE DEFAULT/);
  assert.match(backfill, /--apply/);
  assert.match(backfill, /spreadsheets\.readonly/, 'it cannot write to Sheets even if asked');
  // Replay converges: the same activity maps to the same primary key.
  const a = toCrmEvent(sheetRow()), b = toCrmEvent(sheetRow());
  assert.equal(a.event_id, b.event_id);
  assert.equal(stable(a), stable(b));
  const mirror = read('integrations/supabase-mirror.js');
  assert.match(mirror, /resolution=merge-duplicates/, 'writes are upserts, so replay cannot duplicate');
});

test('O. an unrepresentable event is reported, never fabricated', () => {
  assert.equal(describeUnmirrorable({ eventId: 'x', eventType: 'y' }), null);
  assert.match(describeUnmirrorable({ eventType: 'y' }), /missing eventId/);
  assert.match(describeUnmirrorable({ eventId: 'x' }), /missing eventType/);
  // No id is invented to make it mirrorable.
  assert.equal(toCrmEvent({ eventType: 'y' }).event_id, '');
});

// ── P–V. current event coverage, from the repository not from memory ───────
test('P/Q/R/S/T/U. every current canonical event type maps through the mirror', () => {
  // Types taken from the real writers, not a remembered list.
  const types = ['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'demo_pair_played',
    'positive_reply', 'negative_reply', 'unsubscribe_reply', 'out_of_office_reply', 'wrong_person_reply',
    'needs_human_reply', 'human_response_sent', 'conversation_note', 'stage_changed', 'lead_queued',
    'automation_held', 'automation_hold_released', 'sequence_enrolled', 'sequence_resumed',
    'sequence_step_sent', 'sequence_send_reserved', 'sequence_stopped', 'sequence_cancelled',
    'call_booked', 'meeting_rescheduled', 'meeting_no_show', 'closed_lost', 'pipeline_promoted',
    'sender_evidence_reconciled', 'gmail_observation_gap', 'gmail_observation_recovered',
    'ordinary_send_reserved', 'ordinary_send_failed', 'email_bounced', 'next_action_override'];
  for (const eventType of types) {
    const row = toCrmEvent(sheetRow({ eventType, eventId: `id:${eventType}` }));
    assert.equal(row.event_type, eventType);
    assert.equal(row.event_id, `id:${eventType}`);
    assert.equal(describeUnmirrorable(sheetRow({ eventType, eventId: `id:${eventType}` })), null);
  }
});

test('V/W/X. campaign attribution survives for staffing, dental and roofing alike', () => {
  const cases = [
    ['industrial_staffing', 'industrial_staffing_employer_acquisition_v1'],
    ['dental_ai_receptionist', 'dental_v3_pay_per_booking'],
    ['roofing_survey', 'roofing_survey_v1_measured'],
  ];
  for (const [family, version] of cases) {
    const row = toCrmEvent(sheetRow({ metadata: JSON.stringify({ campaignFamily: family, campaignVersion: version, senderInboxId: 'primary' }) }));
    assert.equal(row.campaign_family, family);
    assert.equal(row.campaign_version, version);
    assert.equal(row.sender_inbox_id, 'primary');
    // And it survives the read back out.
    const back = toCanonicalActivity(mirrorRow({ metadata: { campaignFamily: family, campaignVersion: version } }));
    assert.equal(JSON.parse(back.metadata).campaignFamily, family);
  }
  // No cross-contamination: one family's attribution never appears on another.
  const staffing = toCrmEvent(sheetRow({ metadata: JSON.stringify({ campaignFamily: 'industrial_staffing' }) }));
  assert.notEqual(staffing.campaign_family, 'dental_ai_receptionist');
});

// ── Y/Z. contract and blast radius ─────────────────────────────────────────
test('Y. the timeline API contract is unchanged: Sheets still serves every response', () => {
  const server = read('server.js');
  // The probe is fire-and-forget and the authoritative array is what is returned.
  assert.match(server, /stage2TimelineProbe\(\{[\s\S]{0,220}authoritative: activities \}\)/);
  assert.match(server, /\.catch\(\(\) => \{ \/\* a parity probe may never affect the response \*\/ \}\)/);
  assert.match(server, /const timeline = timelineForLead\(/, 'the timeline is still built from the authoritative rows');
  // Default mode is off, so deploying this changes nothing on its own.
  assert.equal(timelineMode({}), 'off');
  assert.equal(timelineMode({ SUPABASE_TIMELINE_MODE: 'dual' }), 'dual');
  assert.equal(timelineMode({ SUPABASE_TIMELINE_MODE: 'primary' }), 'primary');
  assert.equal(timelineMode({ SUPABASE_TIMELINE_MODE: 'nonsense' }), 'off', 'an unknown mode fails safe');
});

test('Z. Stage 2 touches no sending, ownership, quota, suppression or observer path', () => {
  const reader = read('integrations/supabase-timeline.js');
  // The reader issues GETs only.
  assert.ok(!/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(reader), 'the Stage 2 reader never writes');
  assert.ok(!/sendEmail|chooseSender|stageSendGate|suppress|quota|observer/i.test(reader),
    'the reader has no send, sender, quota, suppression or observer surface');
  // The agent still never reads timelines from Supabase.
  const agent = read('outreach-agent.js');
  assert.ok(!/supabase-timeline/.test(agent), 'automation decisions still come from canonical state');
  assert.match(agent, /require\('\.\/integrations\/supabase-mirror'\)/, 'the agent still only mirrors, never reads');
});
