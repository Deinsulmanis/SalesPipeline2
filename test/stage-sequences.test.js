'use strict';

// Stage-specific recovery journeys. The two properties that matter most:
// the production gate is OFF so nothing can send, and [MANUAL HOLD] keeps
// blocking the COLD sequence while an explicitly enrolled stage journey is
// scoped past it. Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SEQUENCES, SEQUENCE_PRECEDENCE, SEQUENCE_STATUS, SEQUENCE_EVENTS, SEQUENCE_TIMING,
  stageSequenceSuppressionReason, sequenceStopReason, deriveSequenceState,
  evaluateStageSequence, sequenceStepEventId, buildSequenceEmail,
  automaticEnrollmentDecision,
} = require('../integrations/stage-sequences');
const {
  deriveNextAction, ACTION_TYPE, ACTION_OWNER, ACTION_STATUS, MANUAL_HOLD_TAG,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agent = readSource(path.join(root, 'outreach-agent.js'));
const server = readSource(path.join(root, 'server.js'));

const NOW = new Date('2026-08-27T19:00:00.000Z');
const ev = (eventType, occurredAt, metadata = {}) => ({ eventType, occurredAt, metadata: JSON.stringify(metadata) });
const enrolled = (id, at = '2026-08-25T10:00:00.000Z') => ev(SEQUENCE_EVENTS.ENROLLED, at, { sequenceId: id });
const ON = { featureEnabled: true };

const evalSeq = (over = {}) => evaluateStageSequence({ now: NOW, ...ON, ...over });
const hotStale = { staleness: 'stale', waitingOn: 'waiting_on_prospect' };

// The agent's stage pass, sliced for source assertions.
const pass = agent.slice(agent.indexOf('async function runStageSequencePass'), agent.indexOf('async function run()'));

// ── GLOBAL SAFETY (1–15) ────────────────────────────────────────────────────

test('1. only one journey is ever active, chosen by explicit precedence', () => {
  // A lead that looks eligible for several gets exactly one, by precedence.
  const verdict = evalSeq({
    boardLead: { stage: 'hot' }, hotState: hotStale,
    callState: { status: 'no_show' },
    activities: [ev('booking_link_sent', '2026-08-10T10:00:00.000Z')],
  });
  assert.equal(verdict.offer, 'no_show_recovery_v1', 'meeting reality outranks the rest');
  assert.ok(verdict.offers.length > 1, 'several were possible');
  assert.deepEqual(SEQUENCE_PRECEDENCE, [
    'no_show_recovery_v1', 'cancelled_rebook_v1', 'hot_stale_v1', 'demo_follow_up_v1', 'timing_recontact_v1',
  ]);
  // deriveSequenceState never reports two at once: a new enrolment supersedes.
  const state = deriveSequenceState([enrolled('hot_stale_v1', '2026-08-20T10:00:00.000Z'), enrolled('no_show_recovery_v1', '2026-08-22T10:00:00.000Z')]);
  assert.equal(state.sequenceId, 'no_show_recovery_v1');
  assert.equal(state.step, 0, 'and the new journey starts from step 0');
});

test('2/3/4/5. any inbound reply after enrolment stops the journey', () => {
  for (const type of ['positive_reply', 'needs_human_reply', 'negative_reply', 'unsubscribe_reply', 'question_reply', 'late_reply']) {
    const verdict = evalSeq({
      boardLead: { stage: 'hot' },
      activities: [enrolled('hot_stale_v1'), ev(type, '2026-08-26T10:00:00.000Z')],
    });
    assert.equal(verdict.eligible, false, `${type} must stop the sequence`);
    assert.equal(verdict.stopReason, 'the prospect replied');
  }
  // A reply BEFORE enrolment is just history the human already saw.
  const before = evalSeq({
    boardLead: { stage: 'hot' },
    activities: [ev('positive_reply', '2026-08-20T10:00:00.000Z'), enrolled('hot_stale_v1')],
  });
  assert.equal(before.stopReason, null);
});

test('6/7. bounce, opt-out and the durable list block every stage send', () => {
  for (const notes of ['[BOUNCED 2026-01-01]', '[REPLY: Unsubscribed]']) {
    const verdict = evalSeq({ boardLead: { stage: 'hot' }, twin: { notes }, activities: [enrolled('hot_stale_v1')] });
    assert.equal(verdict.eligible, false, `${notes} must block`);
    assert.match(verdict.stopReason, /suppressed/);
  }
  const listed = evalSeq({
    boardLead: { stage: 'hot' }, twin: { email: 'a@x.test' },
    suppressedEmails: new Set(['a@x.test']), activities: [enrolled('hot_stale_v1')],
  });
  assert.equal(listed.eligible, false);
  assert.match(listed.stopReason, /durable suppression list/);
  // The scoped helper agrees on its own.
  assert.match(stageSequenceSuppressionReason({ notes: '[BOUNCED x]' }), /suppressed/);
  assert.equal(stageSequenceSuppressionReason({ notes: 'ordinary' }), null);
});

test('8. a booking stops any running journey', () => {
  const verdict = evalSeq({
    boardLead: { stage: 'hot' },
    activities: [enrolled('hot_stale_v1'), ev('call_booked', '2026-08-26T10:00:00.000Z')],
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.stopReason, 'a meeting was booked');
  // A live booking blocks it even without a fresh event.
  const scheduled = evalSeq({
    boardLead: { stage: 'hot' }, callState: { status: 'scheduled' }, activities: [enrolled('hot_stale_v1')],
  });
  assert.equal(scheduled.stopReason, 'a meeting is on the calendar');
});

test('9/10. terminal opportunities stop every journey', () => {
  for (const [stage, reason] of [['closed_won', 'opportunity closed won'], ['closed_lost', 'opportunity closed lost']]) {
    const verdict = evalSeq({ boardLead: { stage }, activities: [enrolled('hot_stale_v1')] });
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.stopReason, reason);
  }
});

test('11. a human taking over stops the journey', () => {
  for (const type of ['human_response_sent', 'conversation_note']) {
    const verdict = evalSeq({
      boardLead: { stage: 'hot' },
      activities: [enrolled('hot_stale_v1'), ev(type, '2026-08-26T10:00:00.000Z')],
    });
    assert.equal(verdict.eligible, false, `${type} must stop it`);
    assert.equal(verdict.stopReason, 'a human took the conversation over');
  }
});

test('12. an identity conflict blocks the journey', () => {
  const verdict = evalSeq({ boardLead: { stage: 'hot' }, identityConflict: true, activities: [enrolled('hot_stale_v1')] });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.stopReason, 'identity mapping conflict');
});

test('13/14. MANUAL HOLD still blocks COLD sending and is never removed', () => {
  // The cold guard is untouched: suppressionReason keeps returning the tag.
  // The cold-send guard now lives in pipeline-state, shared with health checks.
  assert.match(readSource(path.join(root, 'integrations', 'pipeline-state.js')),
    /if \(tag === MANUAL_HOLD_TAG && manualHoldReleased\(notes\)\) continue;/);
  const { SEND_SUPPRESSION_TAGS } = require('../integrations/pipeline-state');
  assert.ok(SEND_SUPPRESSION_TAGS.includes('[MANUAL HOLD]'), 'the hold must stay a cold-send suppression tag');
  // The stage pass never removes it, and never touches cold state.
  assert.ok(!/applyHoldToNotes|removeHold|clearHold/.test(pass), 'the stage pass never rewrites the hold');
  assert.ok(!/emailStep|lastEmailedAt|markSent/.test(pass), 'and never touches cold sequence state');
  // Safer rule: demo/Hot automation cannot silently override human ownership.
  const held = evalSeq({
    boardLead: { stage: 'hot' }, twin: { notes: MANUAL_HOLD_TAG + ' promoted' },
    activities: [enrolled('hot_stale_v1')],
  });
  assert.equal(held.eligible, false);
  assert.match(held.stopReason, /manual hold/);
  assert.match(stageSequenceSuppressionReason({ notes: MANUAL_HOLD_TAG }), /manual hold/);
  // Explicit lifecycle actions are the narrow authorization exception.
  assert.equal(stageSequenceSuppressionReason({ notes: MANUAL_HOLD_TAG }, new Set(),
    { explicitLifecycleAuthorization: true }), null);
});

test('15. with the feature flag OFF nothing is ever eligible', () => {
  const cases = [
    { boardLead: { stage: 'hot' }, activities: [enrolled('hot_stale_v1')] },
    { boardLead: { stage: 'call_booked' }, callState: { status: 'no_show' }, activities: [enrolled('no_show_recovery_v1')] },
    { boardLead: { stage: 'follow_up' }, activities: [ev('booking_link_sent', '2026-08-10T10:00:00.000Z'), enrolled('demo_follow_up_v1', '2026-08-10T10:00:00.000Z')] },
  ];
  for (const input of cases) {
    const off = evaluateStageSequence({ now: NOW, featureEnabled: false, ...input });
    assert.equal(off.eligible, false, 'flag OFF must mean not eligible');
    assert.equal(off.dueNow, true, 'even though the step is genuinely due');
    const on = evaluateStageSequence({ now: NOW, featureEnabled: true, ...input });
    assert.equal(on.eligible, true, 'and ON would have sent it');
  }
  // The agent checks the flag before doing anything at all.
  assert.match(pass, /if \(!STAGE_SEQUENCES_ENABLED\) \{/);
  assert.ok(pass.indexOf('STAGE_SEQUENCES_ENABLED') < pass.indexOf('readBoardLeads'),
    'the gate precedes even the fallback snapshot read');
  assert.match(agent, /const STAGE_SEQUENCES_ENABLED = process\.env\.STAGE_SEQUENCES_ENABLED === 'true';/);
});

// ── DEMO (16–20) ────────────────────────────────────────────────────────────

test('16/17. verified demo evidence qualifies for automatic persisted enrollment', () => {
  const none = evalSeq({ boardLead: { stage: 'follow_up' }, activities: [] });
  assert.equal(none.offer, null, 'no demo trigger, no journey');
  const after = evalSeq({
    boardLead: { stage: 'follow_up' },
    activities: [ev('booking_link_sent', '2026-08-18T10:00:00.000Z')],
  });
  assert.equal(after.offer, 'demo_follow_up_v1');
  assert.equal(after.eligible, false, 'the activity ledger must first persist enrollment');
  assert.equal(SEQUENCES.demo_follow_up_v1.requiresEnrollment, true);
  const decision = automaticEnrollmentDecision({
    verdict: after, activities: [ev('booking_link_sent', '2026-08-18T10:00:00.000Z')],
    senderProof: { ok: true, senderInboxId: 'primary' }, thread: { threadId: 'T' }, now: NOW,
  });
  assert.equal(decision.sequenceId, 'demo_follow_up_v1');
  const active = evalSeq({
    boardLead: { stage: 'follow_up' },
    activities: [ev('booking_link_sent', '2026-08-18T10:00:00.000Z'), enrolled('demo_follow_up_v1', '2026-08-18T10:00:00.000Z')],
  });
  // Step 1 is three business days after that existing email, not a duplicate.
  assert.equal(SEQUENCE_TIMING.DEMO_STEP_1_BUSINESS_DAYS, 3);
  assert.equal(active.nextDueAt.slice(0, 10), '2026-08-21');
});

test('18/19/20. replies and bookings stop the demo journey, and it is bounded', () => {
  const base = [ev('booking_link_sent', '2026-08-18T10:00:00.000Z')];
  assert.equal(evalSeq({ boardLead: { stage: 'follow_up' }, activities: [...base, ev('positive_reply', '2026-08-20T10:00:00.000Z')] }).eligible, false);
  assert.equal(evalSeq({ boardLead: { stage: 'follow_up' }, activities: [...base, ev('call_booked', '2026-08-20T10:00:00.000Z')] }).eligible, false);
  assert.equal(SEQUENCES.demo_follow_up_v1.maxSteps, 2);
  const done = evalSeq({
    boardLead: { stage: 'follow_up' },
    activities: [...base, enrolled('demo_follow_up_v1', '2026-08-18T11:00:00.000Z'),
      ev(SEQUENCE_EVENTS.STEP_SENT, '2026-08-21T10:00:00.000Z', { step: 1 }),
      ev(SEQUENCE_EVENTS.STEP_SENT, '2026-08-26T10:00:00.000Z', { step: 2 })],
  });
  assert.equal(done.status, SEQUENCE_STATUS.COMPLETE);
  assert.equal(done.eligible, false, 'it never loops past its maximum');
});

// ── HOT (21–28) ─────────────────────────────────────────────────────────────

test('21/22/23. a fresh positive reply never auto-enrols; stale Hot is offered', () => {
  // Waiting on US (they just replied) — not offered at all.
  const fresh = evalSeq({ boardLead: { stage: 'hot' }, hotState: { staleness: 'overdue', waitingOn: 'waiting_on_us' }, activities: [] });
  assert.equal(fresh.offer, null, 'we owe them a reply; automation must not step in');
  // Waiting on THEM and stale — offered, but still not running.
  const stale = evalSeq({ boardLead: { stage: 'hot' }, hotState: hotStale, activities: [] });
  assert.equal(stale.offer, 'hot_stale_v1');
  assert.equal(stale.eligible, false, 'offered is not enrolled');
  assert.match(stale.reason, /nobody has enrolled this lead/);
  assert.equal(SEQUENCES.hot_stale_v1.requiresEnrollment, true);
  // Active only once a human enrolled it.
  assert.equal(evalSeq({ boardLead: { stage: 'hot' }, hotState: hotStale, activities: [enrolled('hot_stale_v1')] }).eligible, true);
});

test('24. starting the Hot journey does not restart the cold sequence', () => {
  const held = { notes: MANUAL_HOLD_TAG + ' [REPLY: Interested]', emailStatus: 'replied', emailStep: '2' };
  const before = JSON.stringify(held);
  const verdict = evalSeq({ boardLead: { stage: 'hot' }, twin: held, activities: [enrolled('hot_stale_v1')] });
  assert.equal(verdict.eligible, false, 'MANUAL HOLD keeps Hot automation fail-closed');
  assert.equal(JSON.stringify(held), before, 'the cold twin is untouched');
  assert.ok(held.notes.includes(MANUAL_HOLD_TAG), 'and still held');
  // The module cannot write anything at all.
  const src = readSource(path.join(root, 'integrations', 'stage-sequences.js'));
  assert.ok(!/sheets\(|await |fetch\(|sendEmail/.test(src), 'the engine is pure');
});

test('25/26/27/28. replies, human responses and bookings stop Hot; it is capped at two', () => {
  const stop = extra => evalSeq({ boardLead: { stage: 'hot' }, hotState: hotStale, activities: [enrolled('hot_stale_v1'), extra] });
  assert.equal(stop(ev('positive_reply', '2026-08-26T10:00:00.000Z')).eligible, false);
  assert.equal(stop(ev('human_response_sent', '2026-08-26T10:00:00.000Z')).eligible, false);
  assert.equal(stop(ev('call_booked', '2026-08-26T10:00:00.000Z')).eligible, false);
  assert.equal(SEQUENCES.hot_stale_v1.maxSteps, 2);
  assert.equal(Object.keys(require('../integrations/stage-sequences').SEQUENCE_COPY.hot_stale_v1).length, 2);
});

// ── NO SHOW (29–34) ─────────────────────────────────────────────────────────

test('29/30/31. no-show recovery needs the explicit state AND explicit enrolment', () => {
  // A passed meeting alone offers nothing.
  assert.equal(evalSeq({ boardLead: { stage: 'call_booked' }, callState: { status: 'outcome_pending' }, activities: [] }).offer, null);
  // The recorded no-show offers it, but does not start it.
  const offered = evalSeq({ boardLead: { stage: 'call_booked' }, callState: { status: 'no_show' }, activities: [] });
  assert.equal(offered.offer, 'no_show_recovery_v1');
  assert.equal(offered.eligible, false);
  assert.equal(SEQUENCES.no_show_recovery_v1.requiresEnrollment, true);
  assert.equal(evalSeq({ boardLead: { stage: 'call_booked' }, callState: { status: 'no_show' }, activities: [enrolled('no_show_recovery_v1')] }).eligible, true);
});

test('32/33/34. a new booking, a reply or a close stops no-show recovery', () => {
  const run = (over, extra = []) => evalSeq({
    boardLead: { stage: 'call_booked', ...over }, callState: { status: 'no_show' },
    activities: [enrolled('no_show_recovery_v1'), ...extra],
  });
  assert.equal(run({}, [ev('call_booked', '2026-08-26T10:00:00.000Z')]).stopReason, 'a meeting was booked');
  assert.equal(run({}, [ev('positive_reply', '2026-08-26T10:00:00.000Z')]).stopReason, 'the prospect replied');
  assert.equal(run({ stage: 'closed_lost' }).stopReason, 'opportunity closed lost');
});

// ── CANCELLED (35–37) ───────────────────────────────────────────────────────

test('35/36/37. cancelled rebooking needs the cancelled state and stops on rebooking', () => {
  const offered = evalSeq({ boardLead: { stage: 'call_booked' }, callState: { status: 'cancelled' }, activities: [] });
  assert.equal(offered.offer, 'cancelled_rebook_v1');
  // A replacement booking makes the call lifecycle authoritative again.
  assert.equal(evalSeq({
    boardLead: { stage: 'call_booked' }, callState: { status: 'scheduled' },
    activities: [enrolled('cancelled_rebook_v1')],
  }).stopReason, 'a meeting is on the calendar');
  assert.equal(evalSeq({
    boardLead: { stage: 'call_booked' }, callState: { status: 'cancelled' },
    activities: [enrolled('cancelled_rebook_v1'), ev('positive_reply', '2026-08-26T10:00:00.000Z')],
  }).stopReason, 'the prospect replied');
});

// ── TIMING (38–41) ──────────────────────────────────────────────────────────

test('38/39/40/41. timing re-contact needs an explicit date and waits for it', () => {
  assert.equal(SEQUENCES.timing_recontact_v1.requiresEnrollment, true);
  assert.equal(SEQUENCES.timing_recontact_v1.maxSteps, 1);
  // The server refuses enrolment without a future date.
  const route = server.slice(server.indexOf("app.post('/api/leads/:id/sequence'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /Choose a future re-contact date\./);
  // It does not fire before the chosen date.
  const future = evalSeq({
    boardLead: { stage: 'follow_up' },
    activities: [ev(SEQUENCE_EVENTS.ENROLLED, '2026-08-25T10:00:00.000Z',
      { sequenceId: 'timing_recontact_v1', recontactAt: '2026-11-01T17:00:00.000Z' })],
  });
  assert.equal(future.dueNow, false, 'it waits for the date');
  assert.equal(future.nextDueAt, '2026-11-01T17:00:00.000Z');
  assert.equal(future.eligible, false);
  // And it never rewrites cold send history.
  assert.ok(!/lastEmailedAt|emailStep/.test(body), 'enrolment writes no cold state');
});

// ── IDEMPOTENCY (42–45) ─────────────────────────────────────────────────────

test('42/43/44/45. a step is deterministic and provider failures do not consume quota', () => {
  assert.equal(sequenceStepEventId('L1', 'hot_stale_v1', 1), 'seq:L1:hot_stale_v1:1');
  assert.equal(sequenceStepEventId('L1', 'hot_stale_v1', 1), sequenceStepEventId('L1', 'hot_stale_v1', 1));
  assert.notEqual(sequenceStepEventId('L1', 'hot_stale_v1', 1), sequenceStepEventId('L1', 'hot_stale_v1', 2));
  // The pass skips a step whose event already exists.
  assert.match(pass, /if \(activities\.some\(row => row\.eventId === eventId\)\) continue;/);
  assert.match(pass, /sequenceRfcMessageId\(eventId, sender\.email\)/);
  assert.match(pass, /findSuccessfulSequenceSend/);
  assert.match(pass, /A provider failure consumes no quota\./);
  const providerBlock = pass.slice(pass.indexOf('let result;'));
  assert.ok(providerBlock.indexOf('result = await sendEmail(') < providerBlock.indexOf('todaySent++;'));
  // Duplicated step events do not double-advance the counter.
  const state = deriveSequenceState([enrolled('hot_stale_v1'),
    ev(SEQUENCE_EVENTS.STEP_SENT, '2026-08-26T10:00:00.000Z', { step: 1 }),
    ev(SEQUENCE_EVENTS.STEP_SENT, '2026-08-26T10:00:00.000Z', { step: 1 })]);
  assert.equal(state.step, 1);
});

// ── TIMELINE / NEXT ACTION (46–53) ──────────────────────────────────────────

test('46/47/48/49/50. every lifecycle moment is a canonical activity event', () => {
  for (const type of ['sequence_enrolled', 'sequence_step_sent', 'sequence_paused', 'sequence_resumed', 'sequence_cancelled']) {
    assert.ok(Object.values(SEQUENCE_EVENTS).includes(type), `${type} is canonical`);
  }
  const route = server.slice(server.indexOf("app.post('/api/leads/:id/sequence'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /stableActivityId\('sequence'/, 'derived id, so retries dedupe');
  assert.match(body, /if \(!ctx\.allActivities\.some\(a => a\.eventId === eventId\)\)/);
  assert.match(pass, /eventType: SEQUENCE_EVENTS\.STEP_SENT/);
  // Stops are derived from the reply/booking events already recorded — the
  // timeline is not flooded with a row per selector check.
  assert.ok(!/sequence_checked|selector_ran/.test(server));
});

test('51/52/53. Next Action reflects active, paused and finished journeys', () => {
  const ctx = seq => ({ now: NOW, activities: [], sequenceState: seq });
  const active = deriveNextAction({ stage: 'hot' }, null, ctx({
    status: 'active', sequenceId: 'hot_stale_v1', label: 'Hot follow-up', step: 0,
    nextDueAt: '2026-08-30T10:00:00.000Z', featureEnabled: true, reason: 'step 1 is due',
  }));
  assert.equal(active.type, ACTION_TYPE.SEQUENCE_STEP);
  assert.equal(active.owner, ACTION_OWNER.AUTOMATION);
  assert.equal(active.label, 'Hot follow-up #1');
  assert.equal(active.dueAt, '2026-08-30T10:00:00.000Z');

  const paused = deriveNextAction({ stage: 'hot' }, null, ctx({
    status: 'paused', sequenceId: 'hot_stale_v1', label: 'Hot follow-up', stopReason: 'paused by hand',
  }));
  assert.equal(paused.type, ACTION_TYPE.SEQUENCE_REVIEW);
  assert.equal(paused.owner, ACTION_OWNER.HUMAN);
  assert.equal(paused.needsAttention, true);
  assert.match(paused.label, /Review paused/);

  const done = deriveNextAction({ stage: 'hot' }, null, ctx({
    status: 'complete', sequenceId: 'hot_stale_v1', label: 'Hot follow-up', step: 2,
  }));
  assert.equal(done.type, ACTION_TYPE.SEQUENCE_REVIEW);
  assert.equal(done.owner, ACTION_OWNER.HUMAN);
  assert.match(done.label, /finished/);

  // Flag OFF is stated in the reason rather than silently pretending it will send.
  const off = deriveNextAction({ stage: 'hot' }, null, ctx({
    status: 'active', sequenceId: 'hot_stale_v1', label: 'Hot follow-up', step: 0, featureEnabled: false, reason: 'step 1 is due',
  }));
  assert.match(off.reason, /stage sending is currently disabled/);
});

// ── ARCHITECTURE ────────────────────────────────────────────────────────────

test('the API can enrol and pause but can never send', () => {
  const start = server.indexOf('// ── STAGE SEQUENCES ─');
  const block = server.slice(start, server.indexOf('// ── CALL LIFECYCLE ─'));
  assert.ok(!/sendEmail|nodemailer|gmail\(|transporter/i.test(block), 'no send path in the API');
  // It writes activity only — no lead column is touched.
  assert.ok(!/values\.update|values\.batchUpdate/.test(block), 'enrolment writes no lead state');
  assert.match(block, /appendColdCallActivities\(\[/);
  assert.match(block, /automationResumed: false/);
});

test('the copy is short, and states no offer, price or guarantee', () => {
  const lead = { contactName: 'Dr Sarah Chen', company: 'City Centre Dentistry' };
  for (const [id, def] of Object.entries(SEQUENCES)) {
    for (let step = 1; step <= def.maxSteps; step++) {
      const mail = buildSequenceEmail(id, step, lead);
      assert.ok(!mail.error, `${id} step ${step} builds`);
      assert.ok(mail.body.length < 500, `${id} step ${step} stays short (${mail.body.length})`);
      assert.ok(!/guarantee|\$|price|pricing|refund|30 days/i.test(mail.body), `${id} step ${step} restates no commercial terms`);
      assert.ok(!/\{\{|\$\{|undefined|null/.test(mail.body), 'no unresolved placeholders');
      assert.ok(mail.subject.length > 0 && !/undefined/.test(mail.subject));
    }
  }
  // A missing step is refused rather than improvised.
  assert.match(buildSequenceEmail('hot_stale_v1', 9, lead).error, /no step 9/);
  assert.match(buildSequenceEmail('nope', 1, lead).error, /unknown sequence/);
});

test('the greeting never addresses a prospect by their company name', () => {
  // Caught by the production dry run: some board rows carry the company in the
  // name fields, which produced "Hi Galaxy," for Galaxy Dental.
  const greet = lead => buildSequenceEmail('demo_follow_up_v1', 1, lead).body.split(/\r?\n/)[0];
  assert.equal(greet({ first: 'Galaxy', last: 'Dental', company: 'Galaxy Dental' }), 'Hi,');
  assert.equal(greet({ contactName: 'Dental', company: 'Dental Care Group' }), 'Hi,');
  assert.equal(greet({ company: 'City Centre Dentistry' }), 'Hi,', 'no name at all is fine');
  // The guard is deliberately narrow: it drops a "name" that is a word of the
  // company. A name that merely looks industry-ish but is absent from the
  // company (e.g. "Dental" at "City Centre Dentistry") is NOT detectable
  // without guessing, and guessing would reject real surnames.
  // A genuine first name still gets used.
  assert.equal(greet({ contactName: 'Dr Sarah Chen', company: 'City Centre Dentistry' }), 'Hi Sarah,');
  assert.equal(greet({ first: 'Seton', company: 'Galaxy Dental' }), 'Hi Seton,');
  // And nothing that is not a plausible name slips through.
  assert.equal(greet({ contactName: '   ', company: 'X' }), 'Hi,');
  assert.equal(greet({ contactName: '123', company: 'X' }), 'Hi,');
});

test('the engine adds no per-lead sheet read', () => {
  const reads = (pass.match(/spreadsheets\.values\.get/g) || []).length;
  assert.equal(reads, 0, 'the pass reuses the cycle snapshot');
  assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*await[^}]*spreadsheets/.test(pass), 'no per-lead read');
  assert.match(pass, /activitiesForCycle \|\| await withAuth\(readColdCallActivities\)/);
});

test('no SMS and no Calendly were introduced', () => {
  const src = readSource(path.join(root, 'integrations', 'stage-sequences.js'));
  for (const text of [src, pass]) {
    assert.ok(!/twilio|sms|calendly/i.test(text));
  }
});

// ── THREADING (Step 10 completion) ──────────────────────────────────────────

const browser = readSource(path.join(root, 'public', 'index.html'));
const { resolveSequenceThread } = require('../integrations/stage-sequences');

test('the canonical thread is resolved from the timeline, newest first', () => {
  const acts = [
    ev('initial_email_sent', '2026-08-01T10:00:00.000Z', { gmailThreadId: 'T1', rfcMessageId: '<a@m>' }),
    ev('positive_reply', '2026-08-05T10:00:00.000Z', { gmailThreadId: 'T1', rfcMessageId: '<b@m>' }),
  ];
  assert.deepEqual(resolveSequenceThread(acts), { threadId: 'T1', rfcMessageId: '<b@m>' });
  // Nothing verifiable means no thread — never a guess.
  assert.equal(resolveSequenceThread([]), null);
  assert.equal(resolveSequenceThread([ev('conversation_note', '2026-08-05T10:00:00.000Z')]), null);
  assert.equal(resolveSequenceThread([ev('positive_reply', '2026-08-05T10:00:00.000Z', { gmailThreadId: '   ' })]), null);
  // Malformed metadata is skipped rather than throwing.
  assert.equal(resolveSequenceThread([{ eventType: 'positive_reply', occurredAt: 'x', metadata: '{bad' }]), null);
});

test('"Re:" is used ONLY when the message really goes into that thread', () => {
  const lead = { contactName: 'Dr Sarah Chen', company: 'City Centre Dentistry' };
  const thread = { threadId: 'T1', rfcMessageId: '<b@m>' };
  for (const [id, def] of Object.entries(SEQUENCES)) {
    for (let step = 1; step <= def.maxSteps; step++) {
      const threaded = buildSequenceEmail(id, step, lead, { thread });
      assert.match(threaded.subject, /^Re: /, `${id} step ${step} threads with Re:`);
      assert.equal(threaded.replyToThread, true);
      assert.equal(threaded.threadId, 'T1');
      assert.equal(threaded.inReplyTo, '<b@m>');
      assert.equal(threaded.references, '<b@m>');

      const fresh = buildSequenceEmail(id, step, lead, { thread: null });
      assert.doesNotMatch(fresh.subject, /^Re:/, `${id} step ${step} must NOT fake Re: without a thread`);
      assert.equal(fresh.replyToThread, false);
      assert.equal(fresh.threadId, '');
      assert.equal(fresh.inReplyTo, '');
      assert.ok(fresh.subject.length > 0 && !/undefined/.test(fresh.subject));
      // Same message either way — only the subject and headers differ.
      assert.equal(fresh.body, threaded.body);
    }
  }
  // A blank/whitespace thread id is treated as no thread at all.
  assert.equal(buildSequenceEmail('hot_stale_v1', 1, lead, { thread: { threadId: '  ' } }).replyToThread, false);
  assert.equal(buildSequenceEmail('hot_stale_v1', 1, lead).replyToThread, false, 'no options means no thread');
});

test('the agent sends into the thread and records it for the next step', () => {
  assert.match(pass, /resolveSequenceThread\(mine, \{ senderInboxId: sender\.id \}\)/);
  assert.match(pass, /buildSequenceEmail\(verdict\.sequenceId, step, boardLead, \{ thread: verifiedThread \}\)/);
  // Threading headers are passed ONLY when the message really is a reply.
  assert.match(pass, /\.\.\.\(built\.replyToThread \? \{/);
  assert.match(pass, /threadId: built\.threadId,/);
  assert.match(pass, /inReplyTo: built\.inReplyTo \|\| undefined,/);
  // The resulting thread is stored so step 2 chains onto step 1.
  assert.match(pass, /gmailThreadId: data\.threadId \|\| built\.threadId \|\| '',/);
  assert.match(pass, /repliedInThread: built\.replyToThread,/);
});

test('the preview resolves the same thread the sender would', () => {
  const route = server.slice(server.indexOf("app.get('/api/leads/:id/sequence'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /resolveSequenceThread\(ctx\.activities, \{ senderInboxId: senderProof\.senderInboxId \}\)/);
  assert.match(body, /buildSequenceEmail\(previewId, step, ctx\.lead, \{ thread \}\)/);
  assert.match(body, /replyToThread: preview\.replyToThread/);
  assert.match(body, /wouldSend: false/);
});

// ── DRAWER UI (Step 10 completion) ──────────────────────────────────────────

test('the drawer offers enrol, pause, resume and cancel by state', () => {
  const ui = browser.slice(browser.indexOf('async function renderSequenceControls'), browser.indexOf('function closeSeqModal'));
  assert.match(ui, /if \(!running && data\.offer && !automaticOffer\)/,
    'automatic journeys do not require a redundant enroll button');
  assert.match(ui, /Start \$\{esc\(label\)\}/);
  assert.match(ui, /if \(data\.status === 'active'\)/);
  assert.match(ui, /openSeqModal\('pause'\)/);
  assert.match(ui, /openSeqModal\('cancel'\)/);
  assert.match(ui, /if \(data\.status === 'paused'\)/);
  assert.match(ui, /openSeqModal\('resume'\)/);
  // Nothing to offer means nothing rendered — the drawer is not cluttered.
  assert.match(ui, /if \(!running && !data\.offer\) return;/);
  // Eligibility comes from the server, not recomputed here.
  assert.match(ui, /fetch\(`\/api\/leads\/\$\{encodeURIComponent\(leadId\)\}\/sequence`\)/);
  assert.ok(!/hotState|waitingOn|SEQUENCE_PRECEDENCE/.test(ui), 'the browser derives no eligibility');
});

test('enrolment, pause and cancel all require explicit confirmation', () => {
  const open = browser.slice(browser.indexOf('function openSeqModal(action)'), browser.indexOf('async function submitSeqAction'));
  assert.ok(!/fetch\(/.test(open), 'opening the modal writes nothing');
  assert.match(open, /onclick="submitSeqAction\('\$\{action\}'\)"/);
  // The modal states what will happen and how it stops.
  assert.match(open, /up to \$\{def\.maxSteps \|\| '\?'\} message\(s\)/);
  assert.match(browser, /It stops on its own if the prospect replies, a meeting is booked/);
  assert.match(browser, /Unsubscribes and bounces block it outright/);
  // Timing re-contact demands an explicit date in the modal.
  assert.match(open, /id="seq-recontact"/);
  assert.match(browser, /Choose a re-contact date\./);
});

test('no UI path can send an email', () => {
  const block = browser.slice(browser.indexOf('// ── STAGE FOLLOW-UP SEQUENCES'), browser.indexOf('// ── CALL LIFECYCLE'));
  assert.ok(!/sendEmail|send_now|\/send/i.test(block), 'the sequence UI has no send path');
  // Exactly two requests: read the state, and move the state.
  const fetches = block.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 2, 'one read, one state change');
  assert.match(block, /method: 'POST'[\s\S]{0,120}JSON\.stringify\(payload\)/);
  assert.ok(!/action: 'send'/.test(block));
  // And the flag being off is stated rather than hidden.
  assert.match(browser, /Automated stage follow-ups are switched off/);
});

test('the sequence preview and controls work on mobile', () => {
  const mobile = browser.slice(browser.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.btn-seq \{ min-height:44px/, 'touch target');
  assert.match(mobile, /\.seq-preview-head \{ flex-direction:column/, 'header stacks');
  assert.match(mobile, /\.seq-preview-body \{ font-size:13px/, 'body stays readable');
  // The preview wraps rather than forcing horizontal scroll.
  assert.match(browser, /\.seq-preview-body \{[^}]*white-space:pre-wrap; word-break:break-word/);
  assert.match(browser, /role="dialog" aria-modal="true" aria-labelledby="seq-title"/);
});

test('legacy raw stage values are normalised, so a closed lead is still stopped', () => {
  // Found while verifying against production: the engine compared the RAW stage
  // cell, but legacy rows store values like 'lost' and 'closed'. server.js notes
  // 11 such rows exist. A raw compare left a closed-lost lead un-stopped.
  const running = [enrolled('hot_stale_v1')];
  for (const raw of ['lost', 'closed', 'closed_lost']) {
    const verdict = evalSeq({ boardLead: { stage: raw }, activities: running });
    assert.equal(verdict.eligible, false, `raw stage "${raw}" must stop the sequence`);
    assert.equal(verdict.stopReason, 'opportunity closed lost');
  }
  assert.equal(evalSeq({ boardLead: { stage: 'closed_won' }, activities: running }).stopReason, 'opportunity closed won');
  // And the offer side normalises too: a capitalised 'Hot' is still Hot.
  for (const raw of ['hot', 'Hot']) {
    assert.deepEqual(evalSeq({ boardLead: { stage: raw }, hotState: hotStale, activities: [] }).offers,
      ['hot_stale_v1'], `raw stage "${raw}" should offer the Hot journey`);
  }
  // The module uses the shared normaliser rather than its own copy.
  const src = readSource(path.join(root, 'integrations', 'stage-sequences.js'));
  assert.match(src, /const \{ displayStageFor \} = require\('\.\/cold-call-pipeline'\);/);
  assert.ok(!/function displayStageFor/.test(src), 'no second copy of the stage rules');
});
