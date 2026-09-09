'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resumePipeline, enrollmentPlan } = require('../integrations/pipeline-resume');
const { SEQUENCES, SEQUENCE_EVENTS, evaluateStageSequence } = require('../integrations/stage-sequences');
const { deriveAutomationOwnership, executableOwners, mayColdSend } = require('../integrations/automation-ownership');
const { hasManualHold, applyHoldToNotes } = require('../integrations/pipeline-state');

const NOW = new Date('2026-09-09T20:00:00.000Z');
const event = (type, at, metadata = {}) => ({ eventId: `${type}:${at}`, eventType: type, occurredAt: at,
  metadata: JSON.stringify(metadata) });
function fixture(stage = 'hot') {
  const activities = [event('human_response_sent', '2026-08-28T16:00:00.000Z',
    { senderInboxId: 'primary', gmailThreadId: 'thread', gmailMessageId: 'message' })];
  if (stage === 'call_booked') activities.push(event('meeting_no_show', '2026-09-01T16:00:00.000Z'));
  return { boardLead: { id: 'CE-fixture', email: 'fixture@example.test', stage },
    twins: [{ id: 'fixture', email: 'fixture@example.test', stage: 'Replied', emailStep: 1,
      senderInboxId: 'primary', notes: '[MANUAL HOLD] keep these notes' }], activities,
    suppressedEmails: new Set(), identityConflict: false, sequencesEnabled: true,
    senders: [{ id: 'primary', sendEligible: true }], observers: [{ senderInboxId: 'primary', health: 'healthy' }] };
}
function harness(state = fixture(), hooks = {}) {
  const calls = { reads: 0, notes: 0, batches: 0, restores: 0, proofs: 0 };
  const deps = {
    now: () => NOW,
    read: async () => { calls.reads++; await hooks.read?.(state, calls); return structuredClone(state); },
    writeNotes: async (twin, notes) => { calls.notes++; state.twins[0].notes = notes; await hooks.release?.(state, calls); },
    restoreHold: async () => { calls.restores++; await hooks.restore?.(state, calls); state.twins[0].notes = applyHoldToNotes(state.twins[0].notes); },
    appendEvents: async rows => { calls.batches++; await hooks.append?.(state, calls, rows); state.activities.push(...structuredClone(rows)); },
    verifyProof: async () => { calls.proofs++; return hooks.proof?.(state, calls) || { ok: true, version: 'verified-thread-v1' }; },
  };
  return { state, calls, run: extra => resumePipeline({ ...deps, ...extra }) };
}

for (const sequenceId of [...Object.keys(SEQUENCES), 'future_journey_v1']) {
  test(`global hold precedence: ${sequenceId} has zero executable owners`, () => {
    const s = fixture();
    const activities = [...s.activities, event(SEQUENCE_EVENTS.ENROLLED, '2026-09-01T16:00:00.000Z', { sequenceId })];
    const sequenceState = evaluateStageSequence({ boardLead: s.boardLead, twin: s.twins[0], activities,
      callState: { status: 'no_show' }, featureEnabled: true, now: NOW });
    assert.match(sequenceState.stopReason, /manual hold/i);
    assert.equal(sequenceState.eligible, false);
    const owner = deriveAutomationOwnership(s.twins[0], { boardLead: s.boardLead,
      sequenceState: { ...sequenceState, eligible: true }, activities, sequencesEnabled: true, sendingEnabled: true });
    assert.deepEqual(executableOwners(owner), []);
    assert.equal(mayColdSend(owner).allowed, false);
  });
}

for (const [stage, journey] of [['hot', 'hot_stale_v1'], ['call_booked', 'no_show_recovery_v1']]) {
  test(`${stage}: Resume releases, enrolls exactly once, assigns recovery, and derives automated Next Action`, async () => {
    const h = harness(fixture(stage));
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.journey, journey);
    assert.equal(result.manualHold, false);
    assert.equal(result.owner, 'recovery_sequence');
    assert.equal(result.blockedBy, null);
    assert.equal(result.nextAction.owner, 'automation');
    assert.match(result.nextAction.label, /automated follow-up (due|scheduled)/);
    assert.ok(result.nextAction.dueAt);
    assert.equal(result.sendTriggered, false);
    assert.equal(mayColdSend(result.ownership).allowed, false);
    assert.ok(executableOwners(result.ownership).length <= 1);
    assert.deepEqual(h.state.activities.slice(-2).map(a => a.eventType), ['automation_hold_released', SEQUENCE_EVENTS.ENROLLED]);
    assert.equal(h.calls.batches, 1);
    assert.equal(h.state.twins[0].notes, 'keep these notes');
    const retry = await h.run();
    assert.equal(retry.alreadyResumed, true);
    assert.equal(retry.owner, 'recovery_sequence');
    assert.equal(h.calls.batches, 1);
    assert.equal(h.calls.notes, 1);
  });
}

test('answered prospect reply may hand off; an unresolved reply may not', async () => {
  const s = fixture();
  s.activities.unshift(event('positive_reply', '2026-08-27T16:00:00.000Z', { canonicalState: 'positive' }));
  const result = await harness(s).run();
  assert.equal(result.owner, 'recovery_sequence');
  assert.equal(result.nextAction.owner, 'automation');
});

test('Northbridge existing enrollment retains step one and timing, without re-enrolling', async () => {
  const s = fixture('call_booked');
  s.activities.push(event(SEQUENCE_EVENTS.ENROLLED, '2026-09-02T16:00:00.000Z', { sequenceId: 'no_show_recovery_v1' }),
    event(SEQUENCE_EVENTS.STEP_SENT, '2026-09-09T15:00:00.000Z', { sequenceId: 'no_show_recovery_v1', step: 1 }));
  const h = harness(s);
  const result = await h.run();
  assert.equal(result.owner, 'recovery_sequence');
  assert.equal(result.sequenceState.step, 1);
  assert.equal(result.sequenceState.enrolledAt, '2026-09-02T16:00:00.000Z');
  assert.match(result.nextAction.label, /#2.*scheduled/);
  assert.equal(s.activities.filter(a => a.eventType === SEQUENCE_EVENTS.ENROLLED).length, 1);
  assert.equal(s.activities.at(-1).eventType, SEQUENCE_EVENTS.RESUMED);
  assert.equal((await h.run()).alreadyResumed, true);
  assert.equal(h.calls.batches, 1);
});

test('provider evidence changes during commit: hold restored and newly enrolled journey cancelled', async () => {
  const h = harness(fixture(), { proof: (_, calls) => ({ ok: true, version: calls.proofs > 2 ? 'new-reply' : 'original' }) });
  await assert.rejects(h.run(), error => error.code === 'proof_changed' && error.holdRestored);
  assert.equal(hasManualHold(h.state.twins[0].notes), true);
  assert.equal(h.state.activities.at(-2).eventType, SEQUENCE_EVENTS.CANCELLED);
  const { deriveSequenceState } = require('../integrations/stage-sequences');
  assert.equal(deriveSequenceState(h.state.activities).status, 'cancelled');
});

test('scheduler stop caused only by manual hold is resumable without resetting steps', async () => {
  const s = fixture('call_booked');
  s.activities.push(event(SEQUENCE_EVENTS.ENROLLED, '2026-09-02T16:00:00.000Z', { sequenceId: 'no_show_recovery_v1' }),
    event(SEQUENCE_EVENTS.STEP_SENT, '2026-09-03T16:00:00.000Z', { sequenceId: 'no_show_recovery_v1', step: 1 }),
    event(SEQUENCE_EVENTS.STOPPED, '2026-09-04T16:00:00.000Z', { sequenceId: 'no_show_recovery_v1', reason: 'manual hold — human owns this lead' }));
  const result = await harness(s).run();
  assert.equal(result.sequenceState.status, 'active');
  assert.equal(result.sequenceState.step, 1);
  assert.equal(result.owner, 'recovery_sequence');
  assert.equal(s.activities.filter(a => a.eventType === SEQUENCE_EVENTS.ENROLLED).length, 1);
});

test('Galaxy with ambiguous canonical thread evidence remains held with a specific blocker', async () => {
  const s = fixture();
  s.activities[0].metadata = JSON.stringify({ senderInboxId: 'primary', candidateThreadIds: ['thread-a', 'thread-b'] });
  const h = harness(s);
  await assert.rejects(h.run(), error => error.code === 'thread_ambiguous');
  assert.equal(h.calls.notes + h.calls.batches, 0);
});

test('double-click calls share one transaction and a preview cannot mutate', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  let handler, release;
  const h = harness();
  const blocker = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const sandbox = { app: { post: (_path, _auth, fn) => { handler = fn; } }, requireAuth: () => {},
    resumeRequests: new Map(), automationLaunchReserved: false, agentState: { running: false },
    outreachCache: null, ceRowMap: new Map(), process: { env: {} },
    readResumeState: () => {}, writeResumeNotes: () => {}, restoreResumeHold: () => {},
    appendColdCallActivities: () => {}, verifyResumeProof: () => {},
    resumePipeline: async () => { runs++; await blocker; return h.run(); } };
  vm.runInNewContext(source.slice(source.indexOf("app.post('/api/leads/:id/resume-automation'"),
    source.indexOf("app.post('/api/leads/:id/human-response'")), sandbox);
  const response = () => ({ status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } });
  const a = response(), b = response();
  const first = handler({ params: { id: 'CE-fixture' } }, a);
  const preview = response();
  await handler({ params: { id: 'CE-fixture' }, body: { checkOnly: true } }, preview);
  assert.equal(preview.statusCode, 409, 'preview cannot join a mutating operation');
  const second = handler({ params: { id: 'CE-fixture' } }, b);
  assert.equal(runs, 1);
  assert.equal(sandbox.automationLaunchReserved, true);
  release();
  await Promise.all([first, second]);
  assert.equal(a.body.ok, true);
  assert.deepEqual(a.body, b.body);
  assert.equal(h.calls.batches, 1);
  assert.equal(sandbox.automationLaunchReserved, false);
});

const refusals = [
  ['observer unavailable', 'observer_unavailable', s => { s.observers[0].health = 'recovering'; }],
  ['sender unknown', 'sender_unproven', s => { s.twins[0].senderInboxId = ''; s.activities[0].metadata = JSON.stringify({ gmailThreadId: 'thread' }); }],
  ['sender conflict', 'sender_unproven', s => { s.twins[0].senderInboxId = 'secondary'; }],
  ['thread missing', 'thread_unproven', s => { s.activities[0].metadata = JSON.stringify({ senderInboxId: 'primary' }); }],
  ['unresolved inbound', 'human_ownership', s => { s.activities.push(event('positive_reply', '2026-09-08T16:00:00.000Z', { canonicalState: 'positive' })); }],
  ['suppression', 'suppression', s => { s.suppressedEmails.add(s.twins[0].email); }],
  ['unsubscribe', 'suppression', s => { s.twins[0].notes += ' [REPLY: Unsubscribed]'; }],
  ['bounce', 'suppression', s => { s.twins[0].notes += ' [BOUNCED 2026-09-01]'; }],
  ['invalid email', 'invalid_identity', s => { s.twins[0].email = s.boardLead.email = 'invalid'; }],
  ['meeting ownership', 'meeting_ownership', s => { s.boardLead.meetingAt = '2026-09-15T16:00:00.000Z'; }],
  ['multiple candidates', 'ambiguous_journey', s => { s.activities.push(event('meeting_no_show', '2026-09-01T16:00:00.000Z')); }],
  ['no journey', 'no_journey', s => { s.boardLead.stage = 'follow_up'; }],
  ['identity conflict', 'identity_conflict', s => { s.identityConflict = true; }],
  ['duplicate identity', 'identity_conflict', s => { s.twins.push({ ...s.twins[0], id: 'other' }); }],
  ['closed won', 'terminal_stage', s => { s.boardLead.stage = 'closed_won'; }],
  ['closed lost', 'terminal_stage', s => { s.boardLead.stage = 'closed_lost'; }],
  ['existing journey', 'existing_journey', s => { s.activities.push(event(SEQUENCE_EVENTS.ENROLLED, NOW.toISOString(), { sequenceId: 'demo_follow_up_v1' })); }],
];
for (const [label, code, change] of refusals) {
  test(`${label}: precise refusal retains hold without enrollment`, async () => {
    const s = fixture(); change(s); const h = harness(s);
    await assert.rejects(h.run(), error => error.code === code);
    assert.equal(h.calls.notes, 0);
    assert.equal(h.calls.batches, 0);
    assert.equal(hasManualHold(s.twins[0].notes), true);
  });
}

for (const [label, change] of [
  ['reply', s => s.activities.push(event('positive_reply', NOW.toISOString(), { canonicalState: 'positive' }))],
  ['meeting', s => { s.boardLead.meetingAt = '2026-09-15T16:00:00.000Z'; }],
  ['suppression', s => s.suppressedEmails.add(s.twins[0].email)],
  ['human notes', s => { s.twins[0].notes += ' new operator note'; }],
]) {
  test(`${label} arrives after release: no enrollment, hold restored, concurrent data preserved`, async () => {
    const h = harness(fixture(), { release: change });
    await assert.rejects(h.run(), error => error.holdRestored === true);
    assert.equal(hasManualHold(h.state.twins[0].notes), true);
    assert.equal(h.state.activities.some(a => a.eventType === SEQUENCE_EVENTS.ENROLLED), false);
    assert.equal(h.state.activities.at(-1).eventType, 'automation_held');
    if (label === 'human notes') assert.match(h.state.twins[0].notes, /new operator note/);
  });
}

test('enrollment write failure restores hold, records failure and permits a safe later retry', async () => {
  let rejected = false;
  const h = harness(fixture(), { append: (_, calls, rows) => {
    if (!rejected && rows.some(a => a.eventType === SEQUENCE_EVENTS.ENROLLED)) { rejected = true; throw Error('storage unavailable'); }
  } });
  await assert.rejects(h.run(), error => error.holdRestored && error.code === 'persistence_failed');
  assert.equal(hasManualHold(h.state.twins[0].notes), true);
  assert.equal(h.state.activities.filter(a => a.eventType === SEQUENCE_EVENTS.ENROLLED).length, 0);
  assert.equal((await h.run()).owner, 'recovery_sequence');
});

test('lost successful append response is reconciled without duplicate events', async () => {
  const h = harness(fixture(), { append: (s, calls, rows) => {
    if (calls.batches === 1) { s.activities.push(...structuredClone(rows)); throw Error('lost response'); }
  } });
  assert.equal((await h.run()).ok, true);
  assert.equal(h.state.activities.filter(a => a.eventType === SEQUENCE_EVENTS.ENROLLED).length, 1);
  assert.equal(h.calls.restores, 0);
});

test('readback failure restores hold using the independent notes reader', async () => {
  const h = harness(fixture(), { read: (_, calls) => { if (calls.reads === 3) throw Error('readback unavailable'); } });
  await assert.rejects(h.run(), error => error.holdRestored);
  assert.equal(hasManualHold(h.state.twins[0].notes), true);
  assert.equal(h.state.activities.some(a => a.eventType === SEQUENCE_EVENTS.ENROLLED), false);
});

test('an unconfirmed rollback is surfaced and requests the scheduler lock remain held', async () => {
  const h = harness(fixture(), { release: () => { throw Error('uncertain release'); }, restore: () => { throw Error('storage outage'); } });
  await assert.rejects(h.run(), error => error.rollbackUnconfirmed && error.code === 'rollback_unconfirmed');
});

test('proof changes while released: fail closed and restore hold', async () => {
  const h = harness(fixture(), { proof: (_, calls) => ({ ok: true, version: String(calls.proofs) }) });
  await assert.rejects(h.run(), error => error.holdRestored && error.code === 'proof_changed');
  assert.equal(h.state.activities.some(a => a.eventType === SEQUENCE_EVENTS.ENROLLED), false);
});

test('CHECK_ONLY has no notes or activity mutation', async () => {
  const h = harness(); const before = structuredClone(h.state);
  const result = await h.run({ checkOnly: true });
  assert.equal(result.wouldEnroll, 'hot_stale_v1');
  assert.equal(result.automationResumed, false);
  assert.deepEqual(h.state, before);
  assert.equal(h.calls.notes + h.calls.batches + h.calls.restores, 0);
});

test('Resume capabilities cannot send, reserve, spend quota or launch cron', () => {
  const module = fs.readFileSync(require.resolve('../integrations/pipeline-resume'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  const route = server.slice(server.indexOf('// ── RESUME AUTOMATION'), server.indexOf("app.post('/api/leads/:id/human-response'"));
  for (const code of [module, route]) {
    assert.doesNotMatch(code, /messages\.send|sendEmail\(|sendGmail\(|spawn\(|startAgentProcess\(|runOutreach\(|reserveSend\(|sendsToday|senderCountsToday|dailyLimit/);
  }
  assert.match(route, /agentState\.running \|\| automationLaunchReserved/);
  assert.match(route, /resumeRequests\.get\(leadId\)/);
  assert.match(route, /if \(error\.rollbackUnconfirmed\) releaseLock = false/);
});

test('Pipeline UX suppresses irrelevant Reactivate and refreshes on both success and failure', () => {
  const browser = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const react = browser.slice(browser.indexOf('async function renderReactivationControls'), browser.indexOf('function closeReactivateModal'));
  assert.match(react, /pipelineLead && !\['closed_won', 'closed_lost'\]\.includes/);
  const submit = browser.slice(browser.indexOf('async function submitResumeAutomation'), browser.indexOf('// ── EXPLICIT CLOSE'));
  assert.equal((submit.match(/await refreshLeadEverywhere\(leadId\)/g) || []).length, 3);
  assert.match(submit, /resumeSubmitting/);
  assert.match(browser, /Nothing sends immediately/);
  assert.doesNotMatch(browser, /sends no email and enrols nothing/);
});
