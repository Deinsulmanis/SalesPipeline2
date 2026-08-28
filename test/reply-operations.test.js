'use strict';

// Phase 2.2 — reply operations and canonical Next Actions.
//
// The property under test throughout: what we should DO is a different question
// from what the prospect SAID, and answering the first must never require
// falsifying the second.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPLY_ACTION, ACTION_OWNER, WAITING_ON, DUE_SOURCE,
  deriveReplyOperation, deriveOperationalAction,
} = require('../integrations/reply-operations');
const {
  REPLY_STATE, NEEDS_HUMAN_REASON, EVIDENCE_SOURCE, classifyReplyText,
} = require('../integrations/canonical-reply');
const {
  OVERRIDE_STATUS, CONTACT_DECISION, buildClassificationOverride, buildActionOverride,
  reverseOverride, activeOverrides, evaluateContactChange, buildContactChangeDecision,
} = require('../integrations/reply-overrides');
const { deriveNextAction, ACTION_TYPE, WAITING_ON: PIPELINE_WAITING_ON } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const LEAD = { id: 'L', company: 'Test Clinic', email: 'a@clinic.test', notes: '' };
const evt = (state, meta = {}, at = '2026-08-10T10:00:00.000Z') => ({
  eventId: `gmail-reply:${meta.gmailMessageId || 'm1'}`, sourceLeadId: 'L', leadId: 'CE-L',
  eventType: 'positive_reply', occurredAt: at,
  metadata: JSON.stringify({ canonicalState: state, gmailMessageId: 'm1', ...meta }),
});
const op = (state, meta = {}, ctx = {}) =>
  deriveReplyOperation(LEAD, { activities: [evt(state, meta)], ...ctx });

// Real message text from the production threads, so classification and
// operation are exercised end to end rather than from hand-made metadata.
const REAL = {
  phoebe: 'Thank you for following up. We are revamping some of our internal infrastructure. Once that has been completed, will reach out to you again.',
  derma: 'Hi there ! What is your question exactly? My name is Afrida . I will be there on 16th . Thanks',
  coquitlam: 'Good Morning, thank you for your message. We will go ahead review and forward to our office manager once she is back in the office next week.',
  glamore: "I'd rather review it over email tbh. If you don't mind. And pricing too.",
  orah: 'We have moved! Our new email address is info@orahspa.com. We will no longer reply from this email.',
  hush: 'Thank you for your email. Our clinic is closed for summer break from July 4-20. We will resume on July 21.',
  surface: 'Automatic reply: the clinic is closed July 1 and we will respond once we are back in office.',
  applecross: 'This is an automated response. Our office monitors this inbox during business hours.',
};
const fromText = (text, ctx = {}) => {
  const c = classifyReplyText(text, { currentEmail: LEAD.email, year: 2026, ...ctx });
  return op(c.state, {
    reason: c.reason, subtype: c.subtype, evidenceSignals: c.signals,
    returnDate: c.returnDate || null, revisitDate: c.revisitDate || null,
    proposedEmail: c.proposedEmail || null, suppliedContact: c.suppliedContact || null,
  });
};

// ── 1–3. Positive intent ────────────────────────────────────────────────────

test('1. positive evaluation intent becomes continue-evaluation, owned by a human', () => {
  const result = op(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent', evidenceSignals: ['trial'] });
  assert.equal(result.action, REPLY_ACTION.CONTINUE_EVALUATION);
  assert.equal(result.owner, ACTION_OWNER.HUMAN);
  assert.equal(result.waitingOn, WAITING_ON.US);
  assert.equal(result.automationAllowed, false, 'Phase 2.2 never authorises a send');
});

test('2. a pricing question inside evaluation still routes to a human', () => {
  const result = op(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent', evidenceSignals: ['pricing'] });
  assert.equal(result.action, REPLY_ACTION.CONTINUE_EVALUATION);
  assert.equal(result.dueAtSource, DUE_SOURCE.REPLY_RECEIVED);
});

test('3. an explicit meeting request becomes a booking action', () => {
  const result = op(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent', evidenceSignals: ['meeting'] });
  assert.equal(result.action, REPLY_ACTION.BOOK_CALL);
  assert.equal(result.waitingOn, WAITING_ON.US);
});

// ── 4–8. The named production fixtures ──────────────────────────────────────

test('4. Phoebe defers: revisit_later, and NO date is invented', () => {
  const result = fromText(REAL.phoebe);
  // The reply classification stays needs_human — we do not add a seventh state.
  assert.equal(result.evidence.canonicalState, REPLY_STATE.NEEDS_HUMAN);
  assert.equal(result.evidence.canonicalReason, NEEDS_HUMAN_REASON.DEFERRED_TIMING);
  // ...but the OPERATION is revisit, not "unclear, go read it".
  assert.equal(result.action, REPLY_ACTION.REVISIT_LATER);
  assert.equal(result.dueAt, null, 'she named no date, so none is manufactured');
  assert.equal(result.dueAtSource, DUE_SOURCE.NONE);
  assert.ok(result.requiresHumanReview, 'a person should choose when to revisit');
});

test('5. Derma asks a question: respond, waiting on us', () => {
  const result = fromText(REAL.derma);
  assert.equal(result.evidence.canonicalReason, NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION);
  assert.equal(result.action, REPLY_ACTION.RESPOND);
  assert.equal(result.owner, ACTION_OWNER.HUMAN);
  assert.equal(result.waitingOn, WAITING_ON.US);
});

test('6. Coquitlam forwarding becomes decision-maker follow-up', () => {
  const result = fromText(REAL.coquitlam);
  assert.equal(result.evidence.canonicalReason, NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER);
  assert.equal(result.action, REPLY_ACTION.DECISION_MAKER_FOLLOW_UP);
  assert.equal(result.waitingOn, WAITING_ON.DECISION_MAKER);
});

test('7. a supplied decision-maker address is distinct, and must never be mailed', () => {
  const result = op(REPLY_STATE.NEEDS_HUMAN, {
    reason: NEEDS_HUMAN_REASON.DECISION_MAKER_CONTACT_SUPPLIED,
    suppliedContact: 'manager@ccdentist.ca',
  });
  assert.equal(result.action, REPLY_ACTION.CONTACT_SUPPLIED);
  assert.notEqual(result.action, REPLY_ACTION.DECISION_MAKER_FOLLOW_UP, 'distinct from a generic forward');
  assert.equal(result.evidence.suppliedContact, 'manager@ccdentist.ca');
  assert.equal(result.evidence.autoSendAllowed, false);
  assert.equal(result.evidence.identityMutationAllowed, false,
    'a supplied contact never replaces the prospect identity');
  assert.equal(result.automationAllowed, false);
});

test('8. Glamore: positive now, but later conversation state outranks it', () => {
  const fresh = fromText(REAL.glamore);
  assert.equal(fresh.evidence.canonicalState, REPLY_STATE.POSITIVE);
  assert.equal(fresh.action, REPLY_ACTION.CONTINUE_EVALUATION);

  // We replied -> the ball moves to them.
  const answered = deriveOperationalAction(LEAD, {
    activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })],
    humanTouchAt: '2026-08-11T09:00:00.000Z',
  });
  assert.equal(answered.action, REPLY_ACTION.WAIT);
  assert.equal(answered.source, 'already_answered');

  // They booked -> the calendar owns it.
  const booked = deriveNextAction({ id: 'L', stage: 'call_booked', meetingAt: '2026-09-01T17:00:00.000Z' }, LEAD, {
    activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })],
    now: new Date('2026-08-27T18:00:00.000Z'),
  });
  assert.equal(booked.owner, 'meeting');
  assert.equal(booked.type, ACTION_TYPE.SALES_CALL);
  assert.notEqual(booked.type, ACTION_TYPE.CONTINUE_EVALUATION);
});

test('9. Orah proposes a mailbox: review required, no silent identity change', () => {
  const result = fromText(REAL.orah);
  assert.equal(result.action, REPLY_ACTION.CONTACT_CHANGE_REVIEW);
  assert.equal(result.evidence.proposedEmail, 'info@orahspa.com');
  assert.equal(result.evidence.identityMutationAllowed, false);
  assert.ok(result.requiresHumanReview);
});

// ── 10–12. Automated replies ────────────────────────────────────────────────

test('10. Hush states a return date: wait until it, sourced from the prospect', () => {
  const result = fromText(REAL.hush);
  assert.equal(result.action, REPLY_ACTION.WAIT_UNTIL_RETURN);
  assert.equal(result.dueAt.slice(0, 10), '2026-07-21');
  assert.equal(result.dueAtSource, DUE_SOURCE.PROSPECT_STATED);
  assert.equal(result.waitingOn, WAITING_ON.DATE);
});

test('11. an undated closure never fabricates a due date', () => {
  const result = fromText(REAL.surface);
  assert.equal(result.evidence.canonicalState, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(result.dueAt, null, 'no date was stated, so none exists');
  assert.equal(result.dueAtSource, DUE_SOURCE.NONE);
  for (const vague of ['back next week', 'once things settle down', 'we will return later']) {
    assert.equal(op(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'out_of_office' }).dueAt, null, vague);
  }
});

test('12. a generic autoresponder creates no human work at all', () => {
  const result = fromText(REAL.applecross);
  assert.equal(result.evidence.canonicalState, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(result.owner, ACTION_OWNER.NONE);
  assert.notEqual(result.owner, ACTION_OWNER.HUMAN, 'a machine reply is not a conversation');
  assert.equal(result.action, REPLY_ACTION.WAIT);
  assert.equal(result.requiresHumanReview, false);
});

// ── 13–17. Terminal, suppressed, precedence ─────────────────────────────────

test('13. a negative reply generates no sales follow-up', () => {
  const result = op(REPLY_STATE.NEGATIVE, { reason: 'explicit_rejection' });
  assert.equal(result.action, REPLY_ACTION.NO_ACTION_SUPPRESSED);
  assert.equal(result.owner, ACTION_OWNER.NONE);
  assert.equal(result.dueAt, null);
});

test('14. a suppressed lead never produces a sales action', () => {
  const twin = { ...LEAD, notes: '[REPLY: Unsubscribed]', emailStatus: 'replied' };
  const result = deriveNextAction({ id: 'L', stage: 'follow_up' }, twin, {
    activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })],
  });
  assert.equal(result.type, ACTION_TYPE.NONE_LOST);
  assert.match(result.reason, /suppressed/);
});

test('15. a future meeting outranks an older reply', () => {
  const result = deriveNextAction({ id: 'L', stage: 'call_booked', meetingAt: '2026-09-01T17:00:00.000Z' }, LEAD, {
    activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: 'question_or_objection' })],
    now: new Date('2026-08-27T18:00:00.000Z'),
  });
  assert.equal(result.type, ACTION_TYPE.SALES_CALL);
  assert.equal(result.source, 'meeting');
});

test('16. a terminal stage outranks an old positive reply', () => {
  for (const stage of ['closed_won', 'closed_lost', 'lost']) {
    const result = deriveNextAction({ id: 'L', stage }, LEAD, {
      activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })],
    });
    assert.ok([ACTION_TYPE.NONE_WON, ACTION_TYPE.NONE_LOST].includes(result.type), stage);
    assert.equal(result.source, 'none');
  }
});

test('17. an unresolved past meeting outranks the reply and demands an outcome', () => {
  const result = deriveNextAction({ id: 'L', stage: 'call_booked', meetingAt: '2026-08-01T17:00:00.000Z' }, LEAD, {
    activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })],
    now: new Date('2026-08-27T18:00:00.000Z'),
  });
  assert.equal(result.type, ACTION_TYPE.RECORD_CALL_OUTCOME);
  assert.ok(result.needsAttention);
});

// ── 18. Waiting-on ──────────────────────────────────────────────────────────

test('18. waiting-on distinguishes every operational situation', () => {
  const seen = new Map();
  seen.set('us', op(REPLY_STATE.NEEDS_HUMAN, { reason: 'question_or_objection' }).waitingOn);
  seen.set('date', op(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'temporary_closure', returnDate: '2026-07-21' }).waitingOn);
  seen.set('decision_maker', op(REPLY_STATE.NEEDS_HUMAN, { reason: 'forwarded_to_decision_maker' }).waitingOn);
  seen.set('review', op(REPLY_STATE.CONTACT_CHANGE_REVIEW, {}).waitingOn);
  seen.set('none', op(REPLY_STATE.NEGATIVE, {}).waitingOn);
  seen.set('prospect', op(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'autoresponder' }).waitingOn);
  assert.deepEqual([...seen.values()], [
    WAITING_ON.US, WAITING_ON.DATE, WAITING_ON.DECISION_MAKER,
    WAITING_ON.HUMAN_REVIEW, WAITING_ON.NONE, WAITING_ON.PROSPECT,
  ]);
  // Step 8's own values are preserved exactly, so Hot behaviour is unchanged.
  const { WAITING_ON: STEP8 } = require('../integrations/pipeline-state');
  for (const key of ['US', 'PROSPECT', 'MEETING']) assert.equal(WAITING_ON[key], STEP8[key]);
});

// ── 19–21. Overrides ────────────────────────────────────────────────────────

test('19. a manual classification override outranks derived evidence', () => {
  const built = buildClassificationOverride({
    leadId: 'L', previousState: 'negative', state: 'positive',
    reason: 'read the thread — clear buying intent', by: 'deins',
  });
  assert.ok(built.ok);
  const result = deriveReplyOperation(LEAD, {
    activities: [evt(REPLY_STATE.NEGATIVE, { reason: 'explicit_rejection' })],
    manualOverride: activeOverrides([built.record], 'L').classification,
  });
  assert.equal(result.evidence.canonicalState, REPLY_STATE.POSITIVE);
  assert.equal(result.evidence.evidenceSource, 'manual_override');
  assert.equal(result.action, REPLY_ACTION.CONTINUE_EVALUATION);
});

test('20. an action override changes what we DO without falsifying what they SAID', () => {
  const built = buildActionOverride({
    leadId: 'L', action: REPLY_ACTION.REVISIT_LATER,
    reason: 'revisit in Q4 once their migration lands', dueAt: '2026-12-01', by: 'deins',
  });
  assert.ok(built.ok);
  // The record cannot even express a reply state.
  assert.equal(built.record.state, undefined);
  assert.equal(built.record.canonicalState, undefined);

  const result = deriveOperationalAction(LEAD, {
    activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: 'question_or_objection' })],
    manualActionOverride: activeOverrides([built.record], 'L').action,
  });
  assert.equal(result.action, REPLY_ACTION.REVISIT_LATER);
  assert.equal(result.source, 'manual_action_override');
  // The underlying classification is untouched.
  const underlying = deriveReplyOperation(LEAD, { activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: 'question_or_objection' })] });
  assert.equal(underlying.evidence.canonicalState, REPLY_STATE.NEEDS_HUMAN);
});

test('21. overrides are auditable and reversible, never destructive', () => {
  const built = buildClassificationOverride({
    leadId: 'L', previousState: 'negative', state: 'positive', reason: 'misread', by: 'deins',
  });
  const reversed = reverseOverride(built.record, { by: 'deins', reason: 'actually the tag was right' });
  assert.equal(reversed.record.status, OVERRIDE_STATUS.REVERSED);
  // The original assertion and what it replaced both survive.
  assert.equal(reversed.record.previous.state, 'negative');
  assert.equal(reversed.record.next.state, 'positive');
  assert.equal(reversed.record.reversalReason, 'actually the tag was right');
  // And it stops applying.
  assert.equal(activeOverrides([reversed.record], 'L').classification, null);
  // History is still readable.
  assert.equal(activeOverrides([built.record], 'L').history.length, 1);
});

test('an override must justify itself and use a real state/action', () => {
  assert.equal(buildClassificationOverride({ leadId: 'L', state: 'made_up', reason: 'x' }).ok, false);
  assert.equal(buildClassificationOverride({ leadId: 'L', state: 'positive', reason: '' }).ok, false);
  assert.equal(buildActionOverride({ leadId: 'L', action: 'nonsense', reason: 'x' }).ok, false);
  assert.equal(buildActionOverride({ leadId: 'L', action: REPLY_ACTION.WAIT, reason: 'x', dueAt: 'soon' }).ok, false);
});

// ── 22–27. Contact change ───────────────────────────────────────────────────

const cleanEval = () => evaluateContactChange({
  leadId: 'L', currentEmail: 'info@orahspasalon.com', proposedEmail: 'info@orahspa.com',
  leads: [{ id: 'L', email: 'info@orahspasalon.com' }], providerEvidence: { gmailMessageId: 'm1' },
});

test('22. a clean contact change can be approved, and only then may identity move', () => {
  const evaluation = cleanEval();
  assert.ok(evaluation.ok);
  assert.equal(evaluation.identityMutationAllowed, true);
  const decision = buildContactChangeDecision({
    leadId: 'L', decision: CONTACT_DECISION.APPROVED, currentEmail: 'info@orahspasalon.com',
    proposedEmail: 'info@orahspa.com', evaluation, by: 'deins',
  });
  assert.ok(decision.ok);
  assert.equal(decision.record.identityMutationAllowed, true);
});

test('23. rejection is recorded and grants nothing', () => {
  const decision = buildContactChangeDecision({
    leadId: 'L', decision: CONTACT_DECISION.REJECTED,
    currentEmail: 'a@x.test', proposedEmail: 'b@x.test', by: 'deins', reason: 'not their real inbox',
  });
  assert.ok(decision.ok);
  assert.equal(decision.record.identityMutationAllowed, false);
  assert.equal(decision.record.decision, CONTACT_DECISION.REJECTED);
});

test('24. a duplicate proposed identity fails closed', () => {
  const evaluation = evaluateContactChange({
    leadId: 'L', currentEmail: 'a@x.test', proposedEmail: 'taken@x.test',
    leads: [{ id: 'OTHER', email: 'taken@x.test' }], providerEvidence: { gmailMessageId: 'm' },
  });
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.conflicts.join(' '), /already belongs/);
  assert.equal(buildContactChangeDecision({
    leadId: 'L', decision: CONTACT_DECISION.APPROVED, evaluation,
  }).ok, false, 'approval must be impossible while a conflict stands');
});

test('25. a suppressed proposed identity fails closed', () => {
  const evaluation = evaluateContactChange({
    leadId: 'L', currentEmail: 'a@x.test', proposedEmail: 'no@x.test',
    suppressedEmails: new Set(['no@x.test']), providerEvidence: { gmailMessageId: 'm' },
  });
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.conflicts.join(' '), /suppression list/);
});

test('a malformed or unevidenced proposal fails closed', () => {
  const malformed = evaluateContactChange({
    leadId: 'L', currentEmail: 'a@x.test', proposedEmail: '-687-1887x@gmail.com',
    providerEvidence: { gmailMessageId: 'm' },
  });
  assert.equal(malformed.ok, false);
  const unevidenced = evaluateContactChange({
    leadId: 'L', currentEmail: 'a@x.test', proposedEmail: 'fine@x.test',
  });
  assert.equal(unevidenced.ok, false);
  assert.match(unevidenced.conflicts.join(' '), /provider-backed evidence/);
});

test('26/27. approving a contact change sends nothing and resumes nothing', () => {
  const decision = buildContactChangeDecision({
    leadId: 'L', decision: CONTACT_DECISION.APPROVED, currentEmail: 'info@orahspasalon.com',
    proposedEmail: 'info@orahspa.com', evaluation: cleanEval(), by: 'deins',
  });
  assert.equal(decision.record.automationResumeAllowed, false,
    'Phase 2.3 owns automation; approval must not restart outreach');
  // No module in this phase can send or enrol.
  for (const file of ['reply-operations.js', 'reply-overrides.js']) {
    const src = readSource(path.join(root, 'integrations', file));
    for (const forbidden of [
      'sendEmail', 'sendMail', 'googleapis', 'values.update', 'values.append',
      'batchUpdate', 'enrollSequence', 'evaluateStageSequence', 'promotionDecision',
    ]) {
      assert.ok(!src.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
  }
});

// ── 28–30. Health, analytics, safety ────────────────────────────────────────

test('28. an actionable human reply always yields a usable Next Action', () => {
  // Health depends on this: a genuine human reply with no derivable action
  // would be an operational hole.
  for (const reason of Object.values(NEEDS_HUMAN_REASON)) {
    const result = op(REPLY_STATE.NEEDS_HUMAN, { reason });
    assert.ok(result.action, `no action derived for ${reason}`);
    assert.ok(result.waitingOn, `no waitingOn for ${reason}`);
    assert.notEqual(result.action, REPLY_ACTION.INVESTIGATE,
      `${reason} is a real human reply and must not fall through to investigate`);
  }
});

test('29. deriving an operational action changes no reply classification', () => {
  const activities = [evt(REPLY_STATE.NEEDS_HUMAN, { reason: 'deferred_timing' })];
  const before = JSON.stringify({ LEAD, activities });
  const result = deriveOperationalAction(LEAD, { activities });
  assert.equal(result.action, REPLY_ACTION.REVISIT_LATER);
  // Inputs untouched, and the classification the funnel reads is unchanged.
  assert.equal(JSON.stringify({ LEAD, activities }), before);
  assert.equal(result.evidence.canonicalState, REPLY_STATE.NEEDS_HUMAN);
});

test('30. unknown and unexpected state fails safely rather than inventing work', () => {
  // No evidence at all.
  const none = deriveReplyOperation(LEAD, { activities: [] });
  assert.equal(none.action, REPLY_ACTION.INVESTIGATE);
  assert.equal(none.dueAt, null);

  // Malformed identity.
  const malformed = deriveReplyOperation(
    { id: 'S', email: '-687-1887x@gmail.com', notes: '[REPLY: Interested]' }, { activities: [] });
  assert.equal(malformed.action, REPLY_ACTION.INVESTIGATE);
  assert.match(malformed.reason, /malformed/);

  // An unrecognised canonical state does not throw or produce a sales action.
  const weird = op('some_future_state', {});
  assert.ok(weird.action);
  assert.notEqual(weird.action, REPLY_ACTION.CONTINUE_EVALUATION);

  // Garbage input.
  const garbage = deriveOperationalAction({}, { activities: [null, {}], boardLead: null });
  assert.ok(garbage.action);
});

test('31. canonical provider evidence drives the real CRM Next Action ahead of a stale legacy tag', () => {
  const twin = { id: 'L', email: LEAD.email, notes: '[REPLY: Not Interested]', emailStatus: 'replied' };
  const activities = [evt(REPLY_STATE.NEEDS_HUMAN, {
    reason: NEEDS_HUMAN_REASON.DEFERRED_TIMING,
  })];
  const next = deriveNextAction({ id: 'L', stage: 'follow_up' }, twin, { activities, now: new Date('2026-08-27T18:00:00Z') });
  assert.equal(next.type, ACTION_TYPE.REVISIT_LATER);
  assert.equal(next.replyState.canonicalState, REPLY_STATE.NEEDS_HUMAN);
  assert.equal(next.replyState.evidenceSource, EVIDENCE_SOURCE.CANONICAL_ACTIVITY);
  assert.equal(next.dueAt, null, 'an undated deferral remains undated');
});

test('32. the real CRM engine still uses a legacy reply tag when no canonical activity exists', () => {
  const twin = { id: 'L', email: LEAD.email, notes: '[REPLY: Interested]', emailStatus: 'replied' };
  const next = deriveNextAction({ id: 'L', stage: 'follow_up' }, twin, { activities: [] });
  assert.equal(next.type, ACTION_TYPE.CONTINUE_EVALUATION);
  assert.equal(next.replyState.evidenceSource, EVIDENCE_SOURCE.LEGACY_TAG);
});

test('33. richer waiting states extend, rather than fork, the pipeline vocabulary', () => {
  for (const key of Object.keys(WAITING_ON)) assert.equal(WAITING_ON[key], PIPELINE_WAITING_ON[key]);
});

test('34. historical unclear evidence can yield a narrow operational deferral from preserved CRM context', () => {
  const activities = [evt(REPLY_STATE.NEEDS_HUMAN, { reason: NEEDS_HUMAN_REASON.UNCLEAR_INTENT })];
  const twin = { ...LEAD, emailStatus: 'replied', notes: '[REPLY: Interested]' };
  const next = deriveNextAction({ id: 'L', stage: 'follow_up',
    notes: 'They are rebuilding internal infrastructure and will reach back out when finished.' }, twin,
  { activities, now: new Date('2026-08-27T18:00:00Z') });
  assert.equal(next.type, ACTION_TYPE.REVISIT_LATER);
  assert.equal(next.dueAt, null);
  assert.equal(next.source, 'crm_context_interpretation');
  assert.equal(next.replyState.canonicalReason, NEEDS_HUMAN_REASON.UNCLEAR_INTENT,
    'historical classification remains intact');
  assert.equal(next.replyState.operationalReason, NEEDS_HUMAN_REASON.DEFERRED_TIMING);
});
