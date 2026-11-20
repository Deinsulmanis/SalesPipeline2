'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyScaleLabReply, scaleLabOwner, verifiedContext, VERSION } = require('../integrations/scalelab-response-classification');
const { planScaleLabRoute, executeScaleLabRoute, routingConfig, routingCandidate, loadRoutingPolicy } = require('../integrations/scalelab-reply-router');
const { laterEvidence, runScaleLabReplyRouting } = require('../integrations/scalelab-reply-pass');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');
const { appendLeadsRow } = require('../integrations/leads-sheet-append');
const { runAgentV2Model } = require('../integrations/agent-v2-model');
const { createScaleLabReplyActionStore } = require('../integrations/scalelab-reply-action-store');
const { deriveNextAction } = require('../integrations/pipeline-state');

const at = '2026-11-19T16:00:00.000Z';
const predecessor = '2026-11-19T15:00:00.000Z';
const sample = { id: 'lead-1', clientId: 'scalelab', company: 'Jole Enterprise', email: 'buyer@example.com',
  stage: 'Contacted', emailStatus: 'emailed', notes: '', lastEmailedAt: predecessor };
const sampleContext = [{ id: 'proven-turn', text: 'Would you like to reschedule our call for later today?' }];
const auditCases = [
  [12, "We're not interested at this time.", 'explicit_rejection'],
  [21, 'unsubscribe\nOffice Manager\nContact us', 'opt_out'],
  [23, 'not interested', 'explicit_rejection'],
  [24, 'Thank you for your message. Our team will get back to you.', 'automated_acknowledgment', { autoSubmitted: 'auto-replied' }],
  [27, 'Please remove us from your mailing list. Thank you.', 'opt_out'],
  [33, 'If you only get paid for meetings I would like more info please\n\nOn Tue, ScaleLab wrote:\n> Reply "unsubscribe" to stop.', 'information_request'],
  [36, 'Can you call me I am free now?', 'meeting_request'],
  [38, 'Can we do 3:30 my time?', 'reschedule_request', { context: sampleContext }],
  [53, 'A buyer has accepted this invitation.', 'calendar_notice', { subject: 'Accepted: Discovery Call', autoSubmitted: 'auto-generated' }],
  [58, 'We just hired a sales rep so Im going o pass on your services for now.', 'explicit_rejection'],
  [61, 'Please let me know if you would like to use our services, I can get you a great rate.', 'reverse_pitch'],
  [64, 'We also do funding and we can set up a consultation at any time.', 'reverse_pitch'],
  [65, 'Bonjour, je suis en congé du 9 au 13 octobre.', 'out_of_office', { subject: 'Réponse automatique : employer accounts' }],
  [75, 'stop\nRegards,\nA buyer', 'opt_out'],
  [82, 'Your message could not be delivered. 550 5.4.1 Recipient address rejected.', 'delivery_failure', { subject: 'Undelivered Mail Returned to Sender' }],
];
for (const [number, text, expected, overrides] of auditCases) {
  test('ScaleLab audit regression ' + number, () => {
    assert.equal(classifyScaleLabReply({ text, ...overrides }).intent, expected);
  });
}

test('stop by and old quote footers cannot unsubscribe a prospect', () => {
  assert.notEqual(classifyScaleLabReply({ text: 'Could you stop by next week?' }).intent, 'opt_out');
  assert.notEqual(classifyScaleLabReply({ text: 'I would like more info\n> Reply unsubscribe to stop' }).intent, 'opt_out');
  assert.equal(classifyScaleLabReply({ text: 'unsubscribe SA-9999\n\nApple Mail sent this email to unsubscribe',
    subject: 'unsubscribe', autoSubmitted: 'auto-replied' }).intent, 'opt_out');
  assert.equal(classifyScaleLabReply({ text: 'We received your message. Click here to unsubscribe.',
    subject: 'Acknowledgment', autoSubmitted: 'auto-generated' }).intent, 'automated_acknowledgment');
});

function observation(text, headers = []) {
  return {
    messages: [{ id: 'm1', threadId: 't1', internalDate: String(Date.parse(at)),
      payload: { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') },
        headers: [{ name: 'From', value: sample.email }, { name: 'Subject', value: 'Re: employer accounts' }, ...headers] } }],
    unavailable: [],
  };
}
function sent(lead = sample) {
  return { sourceLeadId: lead.id, leadId: 'CE-' + lead.id, eventId: 'outbound', eventType: 'initial_email_sent',
    occurredAt: predecessor, email: lead.email, content: 'Can we set up a call?',
    metadata: JSON.stringify({ senderInboxId: 'scale-mailbox', gmailThreadId: 't1', gmailMessageId: 'out-1', clientId: lead.clientId }) };
}
const scope = mode => ({ mode, since: Date.parse(predecessor), owns: () => true });
function makePlan(obs, mode, lead = sample) {
  return planMailboxEvents({ observation: obs, leads: [lead], activities: [sent(lead)], now: new Date(at),
    senderInboxId: 'scale-mailbox', senderEmail: 'seller@example.com', scaleLab: mode ? scope(mode) : null });
}

test('observer shadow keeps the baseline reply and suppression while recording its proposal', async () => {
  const normal = await makePlan(observation('stop\nRegards,'), null);
  const shadow = await makePlan(observation('stop\nRegards,'), 'shadow');
  assert.deepEqual(shadow.suppressions, normal.suppressions);
  assert.equal(shadow.events[0].eventType, normal.events[0].eventType);
  assert.equal(JSON.parse(shadow.events[0].metadata).scalelabReply.intent, 'opt_out');
  const active = await makePlan(observation('stop\nRegards,'), 'apply');
  assert.equal(active.suppressions[0].scaleLabLeadId, sample.id);
  assert.equal(active.events[0].eventType, 'unsubscribe_reply');
  let cursor = 0;
  await assert.rejects(commitObservation({ observation: {}, plan: active, activities: [],
    suppress: async () => { throw Error('unverified'); }, appendEvents: async () => {},
    checkpoint: async () => { cursor++; } }), /unverified/);
  assert.equal(cursor, 0);
});

test('ScaleLab reports a 5.4.1 failure without recipient suppression or a human reply', async () => {
  const obs = observation('Undelivered. 550 5.4.1 Recipient address rejected. Your message could not be delivered.',
    [{ name: 'Subject', value: 'ignored duplicate header' }]);
  obs.messages[0].payload.headers[1].value = 'Undelivered Mail Returned to Sender';
  const plan = await makePlan(obs, 'apply');
  assert.equal(plan.replies.length, 0);
  assert.equal(plan.suppressions.length, 0);
  assert.ok(plan.events.some(row => row.eventType === 'scalelab_delivery_review'));
  assert.ok(plan.events.some(row => row.eventType === 'email_delivery_failed'));
});

test('managed, inferred, and ambiguous identities cannot enter the ScaleLab reply path', async () => {
  assert.equal(scaleLabOwner(sample), true);
  const managed = { ...sample, clientId: 'jole', company: 'ScaleLab AI' };
  const conflicting = { ...sample, leadNiche: 'jole_employer' };
  for (const lead of [managed, { ...sample, clientId: '' }, conflicting]) {
    assert.equal(scaleLabOwner(lead), false);
    const baseline = await makePlan(observation('stop'), null, lead);
    const candidate = await makePlan(observation('stop'), 'apply', lead);
    assert.deepEqual(candidate, baseline);
  }
  const noHistory = await planMailboxEvents({ observation: observation('stop'), leads: [sample], activities: [], now: new Date(at),
    senderInboxId: 'reassigned', senderEmail: 'seller@example.com', scaleLab: scope('apply') });
  assert.equal(noHistory.suppressions.length, 0);
  const wrongTurns = verifiedContext([sent()], { leadId: sample.id, senderInboxId: 'reassigned', threadId: 't1', occurredAt: at });
  assert.deepEqual(wrongTurns, []);
});

const inbound = (intent = 'interest') => ({ sourceLeadId: sample.id, eventId: 'gmail-reply:m1',
  occurredAt: at, email: sample.email,
  metadata: JSON.stringify({ clientId: 'scalelab', matchedColdEmailId: sample.id, senderInboxId: 'scale-mailbox',
    gmailThreadId: 't1', gmailMessageId: 'm1', scalelabReply: { intent, version: VERSION },
    scalelabMode: 'apply' }) });
const config = scope('apply');
const candidate = routingCandidate(inbound(), sample, config);
function state(boards = []) { return { lead: { ...sample }, boards, suppressed: new Set() }; }
const board = stage => ({ id: 'CE-' + sample.id, email: sample.email, stage });

test('qualifying new leads go to Follow Up and advanced or terminal stages are preserved', () => {
  assert.equal(planScaleLabRoute(candidate, state()).targetStage, 'follow_up');
  for (const stage of ['follow_up', 'hot', 'call_booked', 'call_held', 'proposal_sent']) {
    const plan = planScaleLabRoute(candidate, state([board(stage)]));
    assert.equal(plan.action, 'attach_task');
    assert.equal(plan.targetStage, stage);
  }
  for (const stage of ['closed_won', 'closed_lost', 'archived']) {
    assert.equal(planScaleLabRoute(candidate, state([board(stage)])).action, 'review');
  }
  assert.equal(planScaleLabRoute(candidate, { ...state(), suppressed: new Set([sample.email]) }).reason, 'protected_lead');
  assert.equal(planScaleLabRoute(candidate, { ...state(), newer: true }).reason, 'stale_or_recovered_message');
  assert.equal(planScaleLabRoute(candidate, { ...state(), twins: 2 }).action, 'review');
  assert.equal(routingCandidate(inbound(), { ...sample, clientId: 'jole' }, config), null);
});

function routeHarness() {
  const live = state();
  const plan = planScaleLabRoute(candidate, live);
  let current = { action_id: candidate.id, mode: 'apply', plan, step: 'planned' };
  let holds = 0, appends = 0, tasks = 0, published;
  const adapter = {
    store: { get: async () => current, advance: async (record, step, outcome) => {
      if (record.step === current.step) current = { ...current, step, outcome };
      return current;
    } },
    readState: async () => live,
    hold: async () => { holds++; live.lead.notes = '[MANUAL HOLD]'; },
    appendCard: async () => { appends++; live.boards.push(board('follow_up')); },
    publishTask: async event => { tasks++; published = event; },
  };
  return { live, adapter, calls: () => [holds, appends, tasks], task: () => published };
}

test('partial external writes recover after restart without a duplicate card or task', async () => {
  const h = routeHarness();
  const first = h.adapter.appendCard;
  await assert.rejects(executeScaleLabRoute(candidate, { ...h.adapter, appendCard: async () => {
    await first(); throw Error('lost response after append');
  } }), /lost response/);
  assert.equal((await h.adapter.store.get()).step, 'held');
  assert.equal((await executeScaleLabRoute(candidate, h.adapter)).step, 'complete');
  await executeScaleLabRoute(candidate, h.adapter);
  assert.deepEqual(h.calls(), [1, 1, 1]);
  const task = h.task();
  assert.equal(JSON.parse(task.metadata).autoSendAllowed, false);
  assert.equal(deriveNextAction(board('follow_up'), h.live.lead, { activities: [task], now: new Date(at) }).source, 'scalelab-reply-routing');
});

test('manual stage advancement during a restart wins and newer replies block stale work', async () => {
  const h = routeHarness();
  const hold = h.adapter.hold;
  h.adapter.hold = async lead => { await hold(lead); h.live.boards.push(board('call_booked')); };
  const result = await executeScaleLabRoute(candidate, h.adapter);
  assert.equal(result.outcome.stage, 'call_booked');
  assert.deepEqual(h.calls(), [1, 0, 1]);
  assert.equal(laterEvidence([{ ...inbound(), eventId: 'gmail-reply:later', occurredAt: '2026-11-19T16:00:01Z' }], candidate), true);
  assert.equal(laterEvidence([{ ...inbound(), eventId: 'gmail-reply:earlier', occurredAt: predecessor }], candidate), false);
  const stale = routeHarness();
  stale.live.newer = true;
  assert.equal((await executeScaleLabRoute(candidate, stale.adapter)).step, 'review');
  assert.deepEqual(stale.calls(), [0, 0, 0]);
});

test('duplicate Crew Staffing events produce one shadow action and no operational writes', async () => {
  const row = inbound();
  row.metadata = row.metadata.replace('"apply"', '"shadow"');
  let written = 0;
  const bomb = async () => assert.fail('shadow invoked an operational writer');
  await runScaleLabReplyRouting({ config: scope('shadow'), activities: [row, { ...row }], leads: [sample],
    owns: () => true, readState: async () => state(),
    store: { listSince: async () => [], record: async () => { written++; return { step: 'planned' }; } },
    hold: bomb, appendCard: bomb, publishTask: bomb, onError: assert.fail });
  assert.equal(written, 1);
});

test('provider identity guard commits card and identity in one request, and reconciles an ambiguous response', async () => {
  const rows = [['id']];
  let batches = 0;
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: rows } }) },
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 2, title: 'Leads' } }] } }),
    batchUpdate: async ({ requestBody }) => {
      batches++;
      const [identity, append] = requestBody.requests;
      assert.ok(identity.createDeveloperMetadata.developerMetadata.metadataId > 0);
      rows.push([append.appendCells.rows[0].values[0].userEnteredValue.stringValue]);
      throw Error('response lost');
    } } };
  const work = { sheets, spreadsheetId: 'fixture', values: ['CE-sample'], atomicIdentity: true };
  await Promise.all([appendLeadsRow(work), appendLeadsRow(work)]);
  assert.equal(batches, 1);
  assert.deepEqual(rows, [['id'], ['CE-sample']]);
});

test('both skill files are used by their components with a local model stub', async t => {
  assert.equal(loadRoutingPolicy().newStage, 'follow_up');
  const before = process.env.SCALELAB_REPLY_DRAFTS_ENABLED;
  process.env.SCALELAB_REPLY_DRAFTS_ENABLED = 'true';
  t.after(() => { if (before === undefined) delete process.env.SCALELAB_REPLY_DRAFTS_ENABLED;
    else process.env.SCALELAB_REPLY_DRAFTS_ENABLED = before; });
  let prompt;
  await runAgentV2Model({ client: { clientId: 'scalelab', campaignAuthorized: true } }, {
    createMessage: async payload => { prompt = payload.system; return { content: [], usage: {} }; },
  });
  assert.match(prompt, /scalelab-response-classification/);
  assert.equal(routingConfig({}), null);
});

test('durable store reads back an already committed action and updates only the expected step', async () => {
  const calls = [];
  const saved = { action_id: candidate.id, client_id: 'scalelab', lead_id: candidate.leadId, mode: 'apply',
    message_id: candidate.messageId, mailbox_id: candidate.senderInboxId, step: 'planned' };
  const store = createScaleLabReplyActionStore({ env: { SUPABASE_URL: 'http://localhost', SUPABASE_SECRET_KEY: 'fixture' },
    fetchImpl: async (url, opts) => {
      calls.push([new URL(url), opts]);
      const rows = opts.method === 'POST' ? [] : opts.method === 'PATCH' ? [{ ...saved, step: 'held' }] : [saved];
      return { ok: true, json: async () => rows };
    } });
  assert.equal((await store.record(candidate, planScaleLabRoute(candidate, state()), 'apply')).action_id, candidate.id);
  assert.equal((await store.advance(saved, 'held', {})).step, 'held');
  assert.equal(calls[0][0].searchParams.get('on_conflict'), 'action_id');
  assert.equal(calls[2][0].searchParams.get('step'), 'eq.planned');
});
