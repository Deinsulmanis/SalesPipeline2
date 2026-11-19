'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyScaleLabWithHaiku, needsScaleLabModel, validateScaleLabModel } = require('../integrations/scalelab-reply-haiku');
const { resolveScaleLabVerdict, runScaleLabReplyRouting } = require('../integrations/scalelab-reply-pass');
const { classifyScaleLabReply, observationForIntent, VERSION } = require('../integrations/scalelab-response-classification');
const { resolveReplyState } = require('../integrations/canonical-reply');

const clock = new Date('2026-11-19T18:00:00Z');
const lead = { id: 'ce-fixture', clientId: 'scalelab', email: 'fixture@example.com', stage: 'Contacted' };
const current = 'If the pilot is still offered, could you send details and pricing?';
const context = [{ id: 'turn1', actor: 'scalelab', text: 'We offer a 30-day employer acquisition pilot.' }];
const firstPass = { intent: 'pricing_request', confidence: 'high', requiresModel: true, version: VERSION };
const candidate = { leadId: lead.id, messageId: 'msg', threadId: 'thread', senderInboxId: 'primary', verdict: firstPass };
const raw = { intent: 'pricing_request', confidence: 0.96, recommendation: 'human_follow_up', buyerInterest: true,
  evidence: [{ ref: 'inbound', quote: 'could you send details and pricing?' }] };
const contextArgs = { current, context, firstPass };

test('clear terminal and plain positive replies bypass Claude; nuanced human replies require it', () => {
  const examples = [
    ['stop', false],
    ['No thanks, we are not interested.', false],
    ['We are not interested for now.', false],
    ['Yes, I am interested.', false],
    [current, true],
    ['Could we reschedule our call?', true],
  ];
  for (const [body, expected] of examples) assert.equal(needsScaleLabModel(classifyScaleLabReply({ text: body }), body), expected, body);
});

test('routing requires grounded buyer intent, no contradiction, and high confidence', () => {
  assert.equal(validateScaleLabModel(raw, contextArgs).intent, 'pricing_request');
  assert.equal(validateScaleLabModel({ ...raw, confidence: 0.89 }, contextArgs).reason, 'low_confidence');
  assert.equal(validateScaleLabModel({ ...raw, intent: 'opt_out' }, contextArgs).reason, 'invalid_output');
  assert.equal(validateScaleLabModel({ ...raw, evidence: [{ ref: 'turn1', quote: 'employer acquisition' }] }, contextArgs).reason, 'invalid_evidence');
  assert.equal(validateScaleLabModel({ ...raw, evidence: [{ ref: 'inbound', quote: 'I am buying' }] }, contextArgs).reason, 'invalid_evidence');
  assert.equal(validateScaleLabModel({ ...raw, buyerInterest: false }, contextArgs).intent, 'unclear');
  assert.equal(validateScaleLabModel(raw, { ...contextArgs, current: 'Not interested, but could you send details and pricing?' }).intent, 'unclear');
  assert.equal(validateScaleLabModel({ ...raw, intent: 'future_contact', recommendation: 'dated_follow_up' }, contextArgs).intent, 'unclear');
});

test('Haiku receives the actual skill and verified context, and never retries an ambiguous provider failure', async () => {
  const args = { ...contextArgs, candidate, lead, apiKey: '' };
  const selected = await classifyScaleLabWithHaiku({ ...args, createMessage: async request => {
    assert.equal(request.model, 'claude-haiku-4-5');
    assert.match(request.system, /scalelab-response-classification/);
    assert.deepEqual(JSON.parse(request.messages[0].content).history, context);
    return { content: [{ type: 'tool_use', name: 'classify_scalelab_reply', input: raw }] };
  } });
  assert.equal(selected.intent, 'pricing_request');
  let attempts = 0;
  const failed = await classifyScaleLabWithHaiku({ ...args, createMessage: async () => {
    attempts++;
    throw Object.assign(Error('network timeout'), { name: 'APIConnectionTimeoutError', status: 503 });
  } });
  assert.equal(failed.reason, 'provider_timeout');
  assert.equal(attempts, 1);
  assert.equal((await classifyScaleLabWithHaiku({ ...args, createMessage: async () => {
    throw Object.assign(Error('invalid credential'), { status: 401 });
  } })).reason, 'provider_authentication_failed');
  assert.equal((await classifyScaleLabWithHaiku(args)).reason, 'key_unavailable');
  assert.equal((await classifyScaleLabWithHaiku({ ...args, createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) })).reason, 'invalid_output');
  assert.equal((await classifyScaleLabWithHaiku({ ...args, lead: { ...lead, clientId: 'jole' },
    createMessage: async () => assert.fail('managed reply called the model') })).reason, 'client_scope');
});

test('a losing classifier and a process restart cannot pay for the same inbound twice', async () => {
  let record;
  let paid = 0;
  const store = {
    claimClassification: async (id, next, now) => {
      if (record) return { acquired: false, record };
      record = { decision_id: id, status: 'pending', started_at: now.toISOString() };
      return { acquired: true, record };
    },
    finishClassification: async (attempt, verdict) => {
      record = { ...attempt, status: 'finished', verdict };
      return verdict;
    },
  };
  const state = { ...contextArgs, lead };
  const result = validateScaleLabModel(raw, contextArgs);
  const classify = async () => { paid++; await new Promise(resolve => setImmediate(resolve)); return result; };
  await Promise.all([resolveScaleLabVerdict(candidate, state, { store, classify, now: clock }),
    resolveScaleLabVerdict(candidate, state, { store, classify, now: clock })]);
  assert.equal(paid, 1);
  assert.equal((await resolveScaleLabVerdict(candidate, state, { store, classify, now: clock })).intent, 'pricing_request');
  assert.equal(paid, 1);
  record = { ...record, status: 'pending', started_at: new Date(clock.getTime() - 61000).toISOString() };
  assert.equal((await resolveScaleLabVerdict(candidate, state, { store, classify, now: clock })).reason,
    'classification_attempt_unconfirmed');
  assert.equal(paid, 1);
});

test('an unresolved reply commits human protection and model failure produces review without writers', async () => {
  const pending = observationForIntent(firstPass, {});
  assert.equal(pending.genuineHuman, true);
  const event = { eventId: 'gmail-reply:msg', eventType: 'needs_human_reply', sourceLeadId: lead.id,
    leadId: 'CE-' + lead.id, email: lead.email, occurredAt: clock.toISOString(), content: current,
    metadata: JSON.stringify({ clientId: 'scalelab', matchedColdEmailId: lead.id, gmailMessageId: 'msg',
      gmailThreadId: 'thread', senderInboxId: 'primary', canonicalState: pending.state,
      reason: pending.reason, genuineHuman: true, scalelabReply: firstPass, scalelabMode: 'apply' }) };
  assert.equal(resolveReplyState(lead, { activities: [event] }).state, 'needs_human');
  let record;
  const bomb = async () => assert.fail('review must not invoke a writer');
  await runScaleLabReplyRouting({
    config: { mode: 'apply', since: clock.getTime() - 1000 }, activities: [event], leads: [lead], owns: () => true,
    readState: async () => ({ lead, current, context, boards: [], suppressed: new Set() }),
    store: { listSince: async () => [], claimClassification: async () => ({ acquired: true, record: { status: 'pending' } }),
      finishClassification: async (_, v) => v, record: async (_, plan) => { record = { plan, step: 'planned' }; return record; },
      get: async () => record, advance: async (_, step, outcome) => { record = { ...record, step, outcome }; return record; } },
    classify: async () => classifyScaleLabWithHaiku({ ...contextArgs, candidate, lead, apiKey: '' }),
    hold: bomb, appendCard: bomb, publishTask: bomb, onError: assert.fail,
  });
  assert.equal(record.step, 'review');
  assert.equal(record.plan.reason, 'unclear');
});
