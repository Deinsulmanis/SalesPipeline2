'use strict';

// The audited false-opt-out correction.
//
// Regression case (2026-09-25): an HTML-only iPhone Mail reply — "If you only get
// paid for meetings I would like more info please" — was classified as an opt-out
// because our quoted cold email's footer says Reply "unsubscribe". A human
// recorded reply_classification_override reply-override:50b4510752ce2ff2bf8cb531
// on inbound 1a0d9adeb5af5f83 saying the reply is positive. The lead was already
// held and human-owned, its suppression row removed; only the [REPLY: Unsubscribed]
// tag remained, on the outreach lead and copied onto its Pipeline card, because
// opt-out tags are permanent to every ordinary writer. Contact details below are
// placeholders; identifiers and note structure match production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FALSE_OPT_OUT_TAG, CORRECTION_EVENT, REFUSAL, correctionEventId, removeFalseOptOutTag,
  evaluateFalseOptOutCorrection, correctionActivity, applyFalseOptOutCorrection,
} = require('../integrations/false-opt-out-correction');
const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyLeadChange, fromOutreachLeadRow, preserveSafetyMarkers,
} = require('../integrations/outreach-state');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');
const { deriveAutomationOwnership, NON_COLD_STAGES } = require('../integrations/automation-ownership');
const { recordedTerminalReply } = require('../integrations/inbound-reply-guard');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const LEAD_ID = 'mu5sratzhkzhrw3yv8';
const CARD_ID = `CE-${LEAD_ID}`;
const MESSAGE_ID = '1a0d9adeb5af5f83';
const OVERRIDE_ID = 'reply-override:50b4510752ce2ff2bf8cb531';
const EMAIL = 'jordan@example-enterprise.test';
const OTHER_NOTES = '[REPLY: Question — draft awaiting review] [STAFFING HIGH] [B2 Tier 1] Saw you place pipe fitters and welders for industrial construction contractors.';
const LEAD_NOTES = `${MANUAL_HOLD_TAG} ${FALSE_OPT_OUT_TAG} ${OTHER_NOTES}`;
const CARD_NOTES = `${FALSE_OPT_OUT_TAG} ${OTHER_NOTES}`;

// What the observer stored: the raw Apple Mail HTML, our quoted footer inside.
const RAW_REPLY = '<html><head><meta charset="utf-8"></head><body dir="auto">If you only get paid for meetings I would like more info please&nbsp;<div><div dir="ltr"><br><blockquote type="cite">On Sep 25, 2026, at 12:32 PM, Scalelabai &lt;deins@scalelabai.ca&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr"><p>Hi Jordan,</p><p>This is a commercial email. Not relevant? Reply &quot;unsubscribe&quot; and I won\'t follow up again.</p><p>Ref: SA-48271</p></div></blockquote></div></body></html>';

const lead = (over = {}) => ({
  id: LEAD_ID, email: EMAIL, company: 'Example Enterprise', stage: 'Replied', emailStatus: 'replied',
  emailStep: '1', notes: LEAD_NOTES, senderInboxId: 'primary', ...over,
});
const card = (over = {}) => ({ id: CARD_ID, email: EMAIL, company: 'Example Enterprise', stage: 'call_booked',
  notes: CARD_NOTES, meetingAt: '2026-09-28T15:00:00.000Z', ...over });
const act = (eventType, eventId, metadata = {}, over = {}) => ({
  eventId, leadId: `CE-${LEAD_ID}`, sourceLeadId: LEAD_ID, email: EMAIL, eventType,
  occurredAt: over.occurredAt || '2026-09-25T18:00:00.000Z', subject: '', content: over.content || '',
  metadata: JSON.stringify(metadata),
});
const overrideRecord = (over = {}) => act('reply_classification_override', OVERRIDE_ID, {
  kind: 'reply_classification_override', status: 'active', leadId: CARD_ID, providerMessageId: MESSAGE_ID,
  previous: { state: 'negative', reason: 'unsubscribe_request' },
  next: { state: 'positive', reason: 'send-info interest in the prospect\'s own words' },
  by: 'Deins (applied by Claude Code)', at: '2026-09-25T20:54:05.249Z', ...over,
}, { occurredAt: '2026-09-25T20:54:05.249Z' });
const originalOptOut = (content = RAW_REPLY) => act('unsubscribe_reply', `gmail-reply:${MESSAGE_ID}`,
  { gmailMessageId: MESSAGE_ID, reason: 'unsubscribe_request', canonicalState: 'negative', senderInboxId: 'primary' },
  { occurredAt: '2026-09-25T17:47:15.000Z', content });

function productionLedger({ override = overrideRecord(), original = originalOptOut(), extra = [] } = {}) {
  return [
    act('lead_queued', 'lead-queued:0cc038055131dce167e919af', { senderInboxId: 'primary' }, { occurredAt: '2026-09-17T17:22:43.038Z' }),
    act('ordinary_send_reserved', `cold-reserve:${LEAD_ID}:step1:attempt1`, { step: 1, leadId: LEAD_ID }, { occurredAt: '2026-09-25T17:32:04.916Z' }),
    // As production records it: the send carries the campaign's sequenceId, its reservation does not.
    act('initial_email_sent', 'gmail:1a0d99fdbe57df11', { step: 1, gmailMessageId: '1a0d99fdbe57df11', sequenceId: 'industrial_staffing_cold' }, { occurredAt: '2026-09-25T17:32:07.433Z' }),
    original,
    act('reply_decision_recorded', `reply-decision:${LEAD_ID}:${MESSAGE_ID}`, { gmailMessageId: MESSAGE_ID, route: 'question' }),
    act('gmail_reply_evaluated', `gmail-evaluated:primary:${MESSAGE_ID}`, { gmailMessageId: MESSAGE_ID, classification: 'QUESTION' }),
    act('human_response_sent', 'gmail-outbound:1a0d9e798f31afa3', { actor: 'human' }, { occurredAt: '2026-09-25T18:50:29.000Z' }),
    act('pipeline_promoted', 'pipeline-promotion:d869dc5e2c27acee988e4e90', { toStage: 'hot' }),
    act('stage_changed', 'stage-change-1', { fromStage: 'Unsub', toStage: 'Replied' }),
    ...(override ? [override] : []),
    act('call_booked', 'calendar-call-lifecycle-1', { meetingAt: '2026-09-28T15:00:00.000Z' }),
    ...extra,
  ];
}

const clean = { ok: true, unresolved: [], nextSteps: [{ actionId: `gmail-cold:${LEAD_ID}:step:1`, status: 'confirmed' }] };
const evaluate = (over = {}) => evaluateFalseOptOutCorrection({
  lead: lead(), leadMatches: 1, boardLeads: [card()], activities: productionLedger(),
  suppressedEmails: new Set(['someone-else@x.test']), reservations: clean, automationRunning: false,
  messageId: MESSAGE_ID, overrideId: OVERRIDE_ID, ...over,
});

// ── The valid correction ─────────────────────────────────────────────────────

test('valid false opt-out: only the exact tag is released, from the lead and the Pipeline card copy', () => {
  const plan = evaluate();
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.notes, `${MANUAL_HOLD_TAG} ${OTHER_NOTES}`);
  assert.equal(plan.boardNotes, OTHER_NOTES);
  assert.equal(plan.eventId, correctionEventId(LEAD_ID, MESSAGE_ID));
  assert.deepEqual(plan.original, { eventId: `gmail-reply:${MESSAGE_ID}`, eventType: 'unsubscribe_reply',
    reason: 'unsubscribe_request', canonicalState: 'negative' });
  assert.equal(plan.override.eventId, OVERRIDE_ID);
  assert.equal(plan.ownership.blockedBy, 'manual_hold', 'still held after the release');
});

test('the audit record names lead, message, original classification, authorising override, time and human source — nothing sensitive', () => {
  const plan = evaluate();
  const event = correctionActivity(plan, { lead: lead(), by: 'Deins', at: '2026-09-25T21:30:00.000Z' });
  assert.equal(event.eventType, CORRECTION_EVENT);
  assert.equal(event.eventId, plan.eventId);
  assert.equal(event.sourceLeadId, LEAD_ID);
  assert.equal(event.leadId, CARD_ID);
  assert.equal(event.content, '', 'no reply text');
  const data = JSON.parse(event.metadata);
  assert.equal(data.gmailMessageId, MESSAGE_ID);
  assert.equal(data.originalEventId, `gmail-reply:${MESSAGE_ID}`);
  assert.deepEqual(data.originalClassification, { eventType: 'unsubscribe_reply', reason: 'unsubscribe_request', canonicalState: 'negative' });
  assert.equal(data.authorizedByOverrideId, OVERRIDE_ID);
  assert.equal(data.correctedBy, 'Deins');
  assert.equal(data.correctedAt, '2026-09-25T21:30:00.000Z');
  assert.equal(data.source, 'manual_false_opt_out_correction');
  assert.equal(data.automationResumed, false);
  assert.ok(!event.metadata.includes('meetings I would like'), 'no prospect words');
  assert.ok(!event.metadata.includes('pipe fitters'), 'no notes content');
  assert.ok(!/reply|meeting_requested/.test(CORRECTION_EVENT), 'never mistaken for an inbound reply by the replay loop');
});

test('removeFalseOptOutTag removes only the exact tag and the one space it occupied', () => {
  assert.deepEqual(removeFalseOptOutTag(LEAD_NOTES), { notes: `${MANUAL_HOLD_TAG} ${OTHER_NOTES}`, removed: 1 });
  assert.deepEqual(removeFalseOptOutTag(CARD_NOTES), { notes: OTHER_NOTES, removed: 1 });
  assert.deepEqual(removeFalseOptOutTag(`a ${FALSE_OPT_OUT_TAG}`), { notes: 'a', removed: 1 });
  assert.deepEqual(removeFalseOptOutTag('[reply: unsubscribed] kept'), { notes: '[reply: unsubscribed] kept', removed: 0 });
  assert.deepEqual(removeFalseOptOutTag('[REPLY: Not Interested] [BOUNCED] x'), { notes: '[REPLY: Not Interested] [BOUNCED] x', removed: 0 });
});

// ── Refusals: every precondition fails closed ────────────────────────────────

const refused = (plan, code) => { assert.equal(plan.ok, false); assert.equal(plan.code, code, plan.reason); };

test('missing override -> refuse', () => {
  refused(evaluate({ activities: productionLedger({ override: null }) }), REFUSAL.NO_OVERRIDE);
  refused(evaluate({ overrideId: '' }), REFUSAL.MISSING_INPUT);
});

test('an override that is reversed, for another message, not about an unsubscribe, negative, or unsigned -> refuse', () => {
  const reversal = act('reply_classification_override', 'reply-override:reversal', {
    kind: 'reply_classification_override', status: 'reversed', reverses: OVERRIDE_ID, leadId: CARD_ID });
  refused(evaluate({ activities: productionLedger({ extra: [reversal] }) }), REFUSAL.NO_OVERRIDE);
  refused(evaluate({ activities: productionLedger({ override: overrideRecord({ providerMessageId: 'other' }) }) }), REFUSAL.NO_OVERRIDE);
  refused(evaluate({ activities: productionLedger({ override: overrideRecord({ previous: { state: 'negative', reason: 'explicit_rejection' } }) }) }), REFUSAL.NO_OVERRIDE);
  refused(evaluate({ activities: productionLedger({ override: overrideRecord({ next: { state: 'negative', reason: 'x' } }) }) }), REFUSAL.NO_OVERRIDE);
  refused(evaluate({ activities: productionLedger({ override: overrideRecord({ by: '' }) }) }), REFUSAL.NO_OVERRIDE);
});

test('missing MANUAL HOLD -> refuse', () => {
  refused(evaluate({ lead: lead({ notes: `${FALSE_OPT_OUT_TAG} ${OTHER_NOTES}` }) }), REFUSAL.NO_MANUAL_HOLD);
});

test('genuine opt-out -> refuse, even with an override', () => {
  // The prospect's own words opt out; only the quote is ours.
  const own = RAW_REPLY.replace('If you only get paid for meetings I would like more info please', 'Please unsubscribe me.');
  refused(evaluate({ activities: productionLedger({ original: originalOptOut(own) }) }), REFUSAL.GENUINE_OPT_OUT);
  // A clean, model-classified opt-out keeps its recorded verdict.
  refused(evaluate({ activities: productionLedger({ original: originalOptOut('Please stop contacting our office.') }) }), REFUSAL.GENUINE_OPT_OUT);
  // Another inbound reply from the same lead that is a real opt-out.
  const second = act('unsubscribe_reply', 'gmail-reply:second', { gmailMessageId: 'second', reason: 'unsubscribe_request' },
    { content: 'unsubscribe', occurredAt: '2026-09-25T19:00:00.000Z' });
  refused(evaluate({ activities: productionLedger({ extra: [second] }) }), REFUSAL.OTHER_OPT_OUT);
  // No opt-out was ever recorded for that message.
  refused(evaluate({ messageId: 'not-an-opt-out' }), REFUSAL.NO_ORIGINAL_OPT_OUT);
});

test('not human-owned, still suppressed, or ambiguous identity -> refuse', () => {
  refused(evaluate({ lead: lead({ stage: 'Contacted', emailStatus: 'emailed' }) }), REFUSAL.NOT_HUMAN_OWNED);
  refused(evaluate({ lead: lead({ stage: 'Unsub', emailStatus: 'done' }) }), REFUSAL.NOT_HUMAN_OWNED);
  refused(evaluate({ lead: lead({ stage: 'Queued', emailStatus: '' }) }), REFUSAL.NOT_HUMAN_OWNED);
  refused(evaluate({ boardLeads: [card({ stage: 'follow_up' })] }), REFUSAL.NOT_HUMAN_OWNED);
  refused(evaluate({ boardLeads: [card(), card({ id: 'CE-other' })] }), REFUSAL.PIPELINE_AMBIGUOUS);
  refused(evaluate({ suppressedEmails: new Set([EMAIL]) }), REFUSAL.STILL_SUPPRESSED);
  refused(evaluate({ lead: null, leadMatches: 0 }), REFUSAL.LEAD_NOT_FOUND);
  refused(evaluate({ leadMatches: 2 }), REFUSAL.AMBIGUOUS_LEAD);
  refused(evaluate({ lead: lead({ notes: `${MANUAL_HOLD_TAG} ${OTHER_NOTES}` }) }), REFUSAL.TAG_ABSENT);
});

test('any live or unverifiable send reservation, pending automated action, or running pass -> refuse', () => {
  refused(evaluate({ reservations: { ok: true, unresolved: [{ leadId: LEAD_ID, status: 'sent_unconfirmed' }], nextSteps: [] } }), REFUSAL.RESERVATION_ACTIVE);
  refused(evaluate({ reservations: { ok: true, unresolved: [], nextSteps: [{ actionId: `gmail-cold:${LEAD_ID}:step:2`, status: 'reserved' }] } }), REFUSAL.RESERVATION_ACTIVE);
  refused(evaluate({ reservations: { ok: false, reason: 'send lock unreachable' } }), REFUSAL.RESERVATION_UNVERIFIED);
  refused(evaluate({ reservations: null }), REFUSAL.RESERVATION_UNVERIFIED);
  const reservedNoDelivery = act('ordinary_send_reserved', `cold-reserve:${LEAD_ID}:step2:attempt1`, { step: 2 });
  refused(evaluate({ activities: productionLedger({ extra: [reservedNoDelivery] }) }), REFUSAL.AUTOMATION_PENDING);
  const pendingV2 = act('reply_decision_pending_execution', 'pending-1', { gmailMessageId: MESSAGE_ID });
  refused(evaluate({ activities: productionLedger({ extra: [pendingV2] }) }), REFUSAL.AUTOMATION_PENDING);
  const enrolled = act('sequence_enrolled', 'seq-1', { sequenceId: 'hot_stale_v1' }, { occurredAt: '2026-09-25T21:00:00.000Z' });
  refused(evaluate({ activities: productionLedger({ extra: [enrolled] }) }), REFUSAL.AUTOMATION_PENDING);
  refused(evaluate({ automationRunning: true }), REFUSAL.AUTOMATION_RUNNING);
});

test('ledger reservations are matched to their own delivery kind, and an unknown kind counts as live', () => {
  const { pendingAutomation } = require('../integrations/false-opt-out-correction');
  // Production shape: the cold step-1 reservation is delivered even though the send carries a sequenceId.
  assert.deepEqual(pendingAutomation(productionLedger(), LEAD_ID), []);
  const seqReserved = act('sequence_send_reserved', `seq:${CARD_ID}:hot_stale_v1:1:attempt:1`,
    { sequenceId: 'hot_stale_v1', step: 1, stepEventId: `seq:${CARD_ID}:hot_stale_v1:1` });
  const seqSent = act('sequence_step_sent', `seq:${CARD_ID}:hot_stale_v1:1`, { sequenceId: 'hot_stale_v1', step: 1 });
  const seqStopped = act('sequence_stopped', 'seq-stop', { sequenceId: 'hot_stale_v1' }, { occurredAt: '2026-09-25T23:00:00.000Z' });
  assert.deepEqual(pendingAutomation(productionLedger({ extra: [seqReserved, seqSent, seqStopped] }), LEAD_ID), []);
  assert.equal(pendingAutomation(productionLedger({ extra: [seqReserved, seqStopped] }), LEAD_ID).length, 1, 'a sequence reservation with no send');
  const unknown = act('booking_send_uncertain', 'mystery-1', { step: 1 });
  assert.equal(pendingAutomation(productionLedger({ extra: [unknown] }), LEAD_ID).length, 1, 'unknown reservation kinds fail closed');
});

// ── The orchestrator: idempotent, serialised, writes only through its writers ──

function fakeProduction({ activities = productionLedger(), leadState = lead(), cardState = card(), failLeadWriteOnce = false } = {}) {
  const store = { lead: { ...leadState }, card: cardState ? { ...cardState } : null, activities: [...activities], calls: [] };
  let failed = !failLeadWriteOnce;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const deps = {
    loadState: async () => {
      await tick();
      return {
        lead: { ...store.lead }, leadMatches: 1, row: 1999,
        boardLeads: store.card ? [{ ...store.card }] : [], boardRow: 26,
        activities: [...store.activities], suppressedEmails: new Set(), reservations: clean, automationRunning: false,
      };
    },
    writeLeadNotes: async ({ lead: target, notes, expectedState, optOutCorrection }) => {
      await tick();
      store.calls.push({ kind: 'lead', notes, optOutCorrection });
      if (!failed) { failed = true; throw new Error('transient canonical write failure'); }
      // Compare-and-set against the evaluated state, as applyCanonicalChange does.
      for (const [field, value] of Object.entries(expectedState)) {
        if (String(store.lead[field]) !== String(value)) throw new Error(`refused: ${field} moved`);
      }
      assert.equal(target.id, LEAD_ID);
      store.lead.notes = notes;
    },
    writeBoardNotes: async ({ boardId, expectedNotes, notes }) => {
      await tick();
      store.calls.push({ kind: 'card', notes });
      if (store.card.id !== boardId || store.card.notes !== expectedNotes) throw new Error('card changed');
      store.card.notes = notes;
    },
    appendActivity: async event => { await tick(); store.calls.push({ kind: 'audit', eventId: event.eventId }); store.activities.push(event); },
    now: () => '2026-09-25T21:30:00.000Z',
  };
  return { store, deps };
}
const request = { leadId: LEAD_ID, messageId: MESSAGE_ID, overrideId: OVERRIDE_ID, by: 'Deins' };

test('Jorge regression: one correction releases lead + card, keeps every other state, and is audited once', async () => {
  const { store, deps } = fakeProduction();
  const result = await applyFalseOptOutCorrection(request, deps);
  assert.equal(result.status, 'corrected');
  assert.equal(result.writes, 3);
  assert.deepEqual(result.releasedFrom, ['outreach_lead_notes', 'pipeline_card_notes']);
  assert.equal(store.lead.notes, `${MANUAL_HOLD_TAG} ${OTHER_NOTES}`, 'unrelated notes preserved, hold kept');
  assert.equal(store.card.notes, OTHER_NOTES, 'Pipeline card copy corrected');
  assert.deepEqual([store.lead.stage, store.lead.emailStatus, store.lead.emailStep], ['Replied', 'replied', '1']);
  assert.deepEqual([store.card.stage, store.card.meetingAt], ['call_booked', '2026-09-28T15:00:00.000Z'], 'booking untouched');
  assert.equal(store.activities.filter(row => row.eventType === CORRECTION_EVENT).length, 1);
  assert.ok(store.activities.some(row => row.eventId === OVERRIDE_ID), 'override history kept');
  assert.ok(store.activities.some(row => row.eventId === `gmail-reply:${MESSAGE_ID}` && row.content === RAW_REPLY), 'original event not rewritten');
  const leadWrite = store.calls.find(call => call.kind === 'lead');
  assert.deepEqual(leadWrite.optOutCorrection, { leadId: LEAD_ID, providerMessageId: MESSAGE_ID, overrideId: OVERRIDE_ID,
    correctionEventId: correctionEventId(LEAD_ID, MESSAGE_ID) });
});

test('running it twice changes nothing the second time', async () => {
  const { store, deps } = fakeProduction();
  await applyFalseOptOutCorrection(request, deps);
  const callsAfterFirst = store.calls.length;
  const again = await applyFalseOptOutCorrection(request, deps);
  assert.deepEqual(again, { status: 'already_corrected', eventId: correctionEventId(LEAD_ID, MESSAGE_ID), writes: 0 });
  assert.equal(store.calls.length, callsAfterFirst);
  assert.equal(store.activities.filter(row => row.eventType === CORRECTION_EVENT).length, 1);
});

test('concurrent invocations write once', async () => {
  const { store, deps } = fakeProduction();
  const results = await Promise.all([1, 2, 3].map(() => applyFalseOptOutCorrection(request, deps)));
  assert.deepEqual(results.map(r => r.status).sort(), ['already_corrected', 'already_corrected', 'corrected']);
  assert.equal(store.calls.filter(call => call.kind === 'audit').length, 1);
  assert.equal(store.calls.filter(call => call.kind === 'lead').length, 1);
  assert.equal(store.calls.filter(call => call.kind === 'card').length, 1);
});

test('a failed release is finished by the next run under the same single audit record', async () => {
  const { store, deps } = fakeProduction({ failLeadWriteOnce: true });
  await assert.rejects(applyFalseOptOutCorrection(request, deps), /transient/);
  assert.equal(store.lead.notes, LEAD_NOTES, 'nothing half-released');
  const retried = await applyFalseOptOutCorrection(request, deps);
  assert.equal(retried.status, 'corrected');
  assert.equal(store.activities.filter(row => row.eventType === CORRECTION_EVENT).length, 1);
  assert.equal(store.lead.notes, `${MANUAL_HOLD_TAG} ${OTHER_NOTES}`);
});

test('a card without the copied tag is left alone; a refusal writes nothing', async () => {
  const noCopy = fakeProduction({ cardState: card({ notes: OTHER_NOTES }) });
  const done = await applyFalseOptOutCorrection(request, noCopy.deps);
  assert.deepEqual(done.releasedFrom, ['outreach_lead_notes']);
  assert.equal(noCopy.store.calls.filter(call => call.kind === 'card').length, 0);

  const noOverride = fakeProduction({ activities: productionLedger({ override: null }) });
  const refusedRun = await applyFalseOptOutCorrection(request, noOverride.deps);
  assert.equal(refusedRun.status, 'refused');
  assert.equal(refusedRun.code, REFUSAL.NO_OVERRIDE);
  assert.equal(noOverride.store.calls.length, 0);
  const unsigned = await applyFalseOptOutCorrection({ ...request, by: '' }, fakeProduction().deps);
  assert.equal(unsigned.status, 'refused');
});

// ── The canonical write: the authorisation is the only key ───────────────────

async function canonicalWrite(options) {
  const db = createPostgrestDouble({ rows: [{ lead_id: LEAD_ID, company: 'Example Enterprise', email: EMAIL,
    stage: 'Replied', email_status: 'replied', email_step: '1', notes: LEAD_NOTES, sender_inbox_id: 'primary' }] });
  const env = await db.start({ SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' });
  const batches = [];
  const sheetsClient = { spreadsheets: { values: { batchUpdate: async args => { batches.push(args.requestBody.data); return {}; } } } };
  try {
    let result = null; let error = null;
    try {
      result = await applyLeadChange(LEAD_ID, { notes: `${MANUAL_HOLD_TAG} ${OTHER_NOTES}` },
        { row: 1999, sheetsClient, spreadsheetId: 's', env, logger: { warn() {}, log() {}, error() {} }, ...options });
    } catch (caught) { error = caught; }
    return { result, error, canonical: fromOutreachLeadRow(db.row(LEAD_ID)), batches };
  } finally { await db.stop(); }
}
const authorization = { leadId: LEAD_ID, providerMessageId: MESSAGE_ID, overrideId: OVERRIDE_ID,
  correctionEventId: correctionEventId(LEAD_ID, MESSAGE_ID) };

test('canonical write releases the tag only with the correction authorization, and mirrors Sheets', async () => {
  const released = await canonicalWrite({ optOutCorrection: authorization,
    expectedState: { stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: LEAD_NOTES } });
  assert.equal(released.result.ok, true, released.result && released.result.reason);
  assert.equal(released.canonical.notes, `${MANUAL_HOLD_TAG} ${OTHER_NOTES}`);
  assert.equal(released.batches[0].find(entry => entry.range === 'ColdEmail!L1999').values[0][0], released.canonical.notes);

  const ordinary = await canonicalWrite({});
  assert.equal(ordinary.canonical.notes, `${FALSE_OPT_OUT_TAG} ${MANUAL_HOLD_TAG} ${OTHER_NOTES}`, 'an ordinary writer cannot lift it');
  assert.deepEqual(ordinary.result.keptMarkers, [FALSE_OPT_OUT_TAG]);

  const wrongLead = await canonicalWrite({ optOutCorrection: { ...authorization, leadId: 'someone-else' } });
  assert.match(String(wrongLead.error && wrongLead.error.message), /names a different lead/);
  assert.equal(wrongLead.canonical.notes, LEAD_NOTES, 'nothing written');

  const moved = await canonicalWrite({ optOutCorrection: authorization,
    expectedState: { stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: `${LEAD_NOTES} changed` } });
  assert.match(String(moved.error && moved.error.message), /refused/);
  assert.equal(moved.canonical.notes, LEAD_NOTES, 'compare-and-set refuses a moved lead');
});

test('the authorization releases the opt-out tag and nothing else', () => {
  const all = `${MANUAL_HOLD_TAG} ${FALSE_OPT_OUT_TAG} [REPLY: Not Interested] [BOUNCED] x`;
  assert.deepEqual(preserveSafetyMarkers(all, 'x', { optOutCorrection: authorization }),
    { notes: '[REPLY: Not Interested] [BOUNCED] [MANUAL HOLD] x', kept: ['[REPLY: Not Interested]', '[BOUNCED]', MANUAL_HOLD_TAG] });
  assert.deepEqual(preserveSafetyMarkers(all, 'x', { optOutCorrection: { leadId: LEAD_ID } }).kept.length, 4, 'incomplete authorization releases nothing');
  assert.deepEqual(preserveSafetyMarkers(`${FALSE_OPT_OUT_TAG} a`, 'a', { releaseMarkers: [FALSE_OPT_OUT_TAG] }).kept, [FALSE_OPT_OUT_TAG],
    'releaseMarkers still cannot lift an opt-out');
});

// ── After the correction, automation is exactly as blocked as before ─────────

test('automation remains blocked after correction', async () => {
  const { store, deps } = fakeProduction();
  await applyFalseOptOutCorrection(request, deps);
  const corrected = store.lead;
  assert.equal(sendSuppressionReason(corrected, { suppressedEmails: new Set() }), MANUAL_HOLD_TAG, 'send-time guard still refuses');
  const ownership = deriveAutomationOwnership(corrected, {
    boardLead: store.card, activities: store.activities, sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
    callState: { status: 'scheduled', meetingAt: store.card.meetingAt },
    suppressionReason: item => sendSuppressionReason(item, { suppressedEmails: new Set() }),
  });
  assert.equal(ownership.sendAllowed, false);
  assert.equal(ownership.sequenceAllowed, false);
  assert.equal(ownership.blockedBy, 'manual_hold');
  // Cold selectors: step 1 needs Queued + blank status, follow-ups need status "emailed".
  assert.equal(corrected.stage === 'Queued' && corrected.emailStatus === '', false);
  assert.equal(corrected.emailStatus === 'emailed' && !NON_COLD_STAGES.includes(corrected.stage.toLowerCase()), false);
  // The check-only replay re-reads the stored opt-out and does not re-apply it.
  const replays = store.activities.filter(row => /reply|meeting_requested/.test(row.eventType)
    && row.eventType !== 'reply_classification_override')
    .map(row => recordedTerminalReply(row, { currentEmail: EMAIL }))
    .filter(verdict => verdict.unsubscribe || verdict.rejection);
  assert.equal(replays.length, 0);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('only the correction route passes an opt-out authorization; it cannot send, and Resume stays the one releaseMarkers caller', () => {
  const server = read('server.js');
  const sources = [['server.js', server], ['outreach-agent.js', read('outreach-agent.js')],
    ...fs.readdirSync(path.join(root, 'integrations')).filter(file => file.endsWith('.js') && file !== 'outreach-state.js')
      .map(file => [file, read(`integrations/${file}`)])];
  const passers = sources.flatMap(([file, src]) => (src.match(/optOutCorrection(?:: \{| \})/g) || []).map(() => file));
  assert.deepEqual([...new Set(passers)].sort(), ['false-opt-out-correction.js', 'server.js']);
  const route = server.slice(server.indexOf("app.post('/api/coldemail/:id/false-opt-out-correction'"),
    server.indexOf("app.post('/api/leads/:id/contact-change'"));
  assert.match(route, /requireAuth/);
  for (const forbidden of ['withOutboundReservation', 'messages.send', 'sendEmail', 'spawnAgent', 'addSuppression', 'applyManualHold', 'releaseMarkers']) {
    assert.ok(!route.includes(forbidden), `the correction route must not use ${forbidden}`);
  }
  const moduleSrc = read('integrations/false-opt-out-correction.js');
  for (const forbidden of ["require('./send-lock')", "require('googleapis')", 'messages.send', 'nodemailer', 'withOutboundReservation']) {
    assert.ok(!moduleSrc.includes(forbidden), `the correction module must not reference ${forbidden}`);
  }
  const releaseDeclarations = sources.flatMap(([file, src]) => (src.match(/releaseMarkers: \[/g) || []).map(() => file));
  assert.deepEqual(releaseDeclarations, ['server.js'], 'Resume remains the one releaseMarkers caller');
});
