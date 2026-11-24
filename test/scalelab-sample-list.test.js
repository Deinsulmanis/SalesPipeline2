'use strict';
// ScaleLab sample employer list. Synthetic fixtures only: no real employer or
// prospect data lives in the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const list = require('../integrations/scalelab-sample-list');
const { classifyScaleLabReply, verifiedContext, observationForIntent, INTENTS } = require('../integrations/scalelab-response-classification');
const { needsScaleLabModel } = require('../integrations/scalelab-reply-haiku');
const { planScaleLabRoute } = require('../integrations/scalelab-reply-router');
const flow = require('../integrations/scalelab-sample-list-flow');
const { createGetLeadsJobsClient } = require('../integrations/getleads-jobs');
const { appendStaffingComplianceFooter, staffingComplianceError } = require('../integrations/staffing-compliance');
const { validateRows } = require('../scripts/load-sample-employers');

const NOW = new Date('2026-11-24T18:00:00.000Z');
const daysAgo = days => new Date(NOW.getTime() - days * 86400000).toISOString();
const OFFER = { id: 'gmail:out-2', actor: 'scalelab', text: 'Want me to pull a short sample list of employers hiring in your market?' };
const lead = { id: 'lead-1', clientId: 'scalelab', company: 'Example Staffing', email: 'buyer@example.com',
  stage: 'Contacted', emailStatus: 'emailed', notes: '', contactName: 'Pat Doe',
  campaign_notes: JSON.stringify({ var_first_name: 'Pat', var_company: 'Example Staffing', var_location: 'Fort Worth, TX' }) };

function employer(n, state, extra = {}) {
  return { domain: `employer${n}.example`, company: `Employer ${n}`, city: `Town ${n}`, state, industry: 'Fabrication',
    openRoles: 10 - (n % 7), exampleRoles: ['Welder', 'Machinist'], newestPosting: '2026-11-20', checkedAt: daysAgo(2),
    status: 'hiring', nationalRank: null, ...extra };
}

// ── detection ────────────────────────────────────────────────────────────────
for (const text of ['Yes', 'Sure, send it over', 'Yes please\n\nThanks,\nPat', "I'm interested in the list",
  'What does that look like?', 'Send me the list', 'Sounds good!', 'Please do']) {
  test(`a clear yes to the sample-list offer is a sample_list_request: ${JSON.stringify(text)}`, () => {
    const verdict = list.detectSampleListRequest(text, [OFFER]);
    assert.equal(verdict.match, true);
    assert.equal(verdict.confidence, 'high');
  });
}

for (const text of ['Yes, but what does it cost?', 'Sure, can we schedule a call first?', 'Send it, and how much are your fees?',
  'Maybe, depends who the employers are', 'No thanks', 'Not interested, remove me', 'Yes?',
  'We already have plenty of employer clients but sure']) {
  test(`mixed, conditional or negative replies stay with the owner: ${JSON.stringify(text)}`, () => {
    assert.equal(list.detectSampleListRequest(text, [OFFER]).match, false);
  });
}

test('without our offer in the thread a bare yes is not a sample-list request', () => {
  assert.equal(list.detectSampleListRequest('Yes', [{ id: 'x', actor: 'scalelab', text: 'Worth a quick chat?' }]).match, false);
  assert.equal(list.detectSampleListRequest('Yes', [{ ...OFFER, actor: 'prospect' }]).match, false);
});

test('the offer flag survives the 500-character context excerpt', () => {
  const long = `${'Context sentence. '.repeat(40)}Want me to pull a short sample list of employers hiring in your market?`;
  const rows = [{ eventId: 'gmail:out-2', sourceLeadId: 'lead-1', eventType: 'follow_up_sent', occurredAt: daysAgo(3),
    content: long, metadata: JSON.stringify({ gmailThreadId: 'T1', senderInboxId: 'box', gmailMessageId: 'out-2' }) }];
  const context = verifiedContext(rows, { leadId: 'lead-1', threadId: 'T1', senderInboxId: 'box', messageId: 'in-1', occurredAt: NOW.toISOString() });
  assert.equal(context.length, 1);
  assert.equal(context[0].text.length, 500);
  assert.equal(context[0].offersSampleList, true);
  assert.equal(list.detectSampleListRequest('Yes', context).match, true);
});

// ── classifier, model gate, observation, routing ────────────────────────────
test('the ScaleLab classifier returns sample_list_request deterministically, without the model', () => {
  assert.ok(INTENTS.includes('sample_list_request'));
  const verdict = classifyScaleLabReply({ text: 'Sure, send it over\n\nPat', context: [OFFER], occurredAt: NOW.toISOString() });
  assert.equal(verdict.intent, 'sample_list_request');
  assert.equal(verdict.confidence, 'high');
  assert.equal(needsScaleLabModel(verdict, 'Sure, send it over'), false);
});

test('opt-out and pricing beat the sample-list offer', () => {
  assert.equal(classifyScaleLabReply({ text: 'stop', context: [OFFER] }).intent, 'opt_out');
  assert.equal(classifyScaleLabReply({ text: 'Yes, but how much do you charge?', context: [OFFER] }).intent, 'pricing_request');
});

test('a sample-list request keeps human ownership and routes to Follow Up', () => {
  const observed = observationForIntent({ intent: 'sample_list_request' }, { state: 'unknown' });
  assert.equal(observed.state, 'needs_human');
  assert.equal(observed.genuineHuman, true);
  const plan = planScaleLabRoute({ leadId: 'lead-1', at: NOW.toISOString(), verdict: { intent: 'sample_list_request' } },
    { lead, boards: [], suppressed: new Set(), twins: 1 });
  assert.equal(plan.action, 'create_follow_up');
  assert.equal(plan.targetStage, 'follow_up');
});

// ── agency state and selection ───────────────────────────────────────────────
test('agency state comes from the lead record only', () => {
  assert.deepEqual(list.agencyStates(lead), ['TX']);
  assert.deepEqual(list.agencyStates({ campaign_notes: JSON.stringify({ state: 'Ohio', branch_states: ['PA'] }) }), ['OH', 'PA']);
  assert.deepEqual(list.agencyStates({ city: 'Columbus, OH' }), ['OH']);
  assert.deepEqual(list.agencyStates({ city: 'Vancouver', campaign_notes: '' }), []);
});

test('five or more in-state employers: only in-state, at most 10', () => {
  const pool = [...Array.from({ length: 12 }, (_, i) => employer(i, 'TX')), employer(50, 'OK'), employer(51, 'TX', { status: 'not_hiring' })];
  const picked = list.selectSampleList({ employers: pool, states: ['TX'] });
  assert.equal(picked.employers.length, 10);
  assert.ok(picked.employers.every(item => item.state === 'TX' && item.status === 'hiring'));
  assert.equal(picked.market, 'Texas');
  assert.equal(picked.scope, 'state');
});

test('fewer than five in-state: neighbors, then the national list, never more than 10', () => {
  const pool = [employer(1, 'NM'), employer(2, 'NM'), employer(3, 'AZ'), employer(4, 'TX'),
    ...Array.from({ length: 20 }, (_, i) => employer(100 + i, 'WI', { nationalRank: i + 1 }))];
  const picked = list.selectSampleList({ employers: pool, states: ['NM'] });
  assert.equal(picked.employers.length, 10);
  assert.deepEqual(picked.employers.slice(0, 2).map(e => e.state), ['NM', 'NM']);
  assert.ok(picked.employers.slice(2, 4).every(e => ['AZ', 'TX'].includes(e.state)));
  assert.equal(picked.scope, 'state_neighbors_national');
  assert.equal(picked.market, 'New Mexico and nearby markets');
});

test('unknown agency state uses the national list', () => {
  const pool = Array.from({ length: 20 }, (_, i) => employer(i, 'WI', { nationalRank: i + 1 }));
  const picked = list.selectSampleList({ employers: pool, states: [] });
  assert.equal(picked.employers.length, 10);
  assert.equal(picked.market, 'the U.S.');
  assert.equal(picked.scope, 'national_state_unknown');
});

// ── freshness ────────────────────────────────────────────────────────────────
test('stale employers are re-checked one at a time and anyone not hiring is dropped', async () => {
  let active = 0; let peak = 0; const calls = [];
  const recheck = async item => {
    active += 1; peak = Math.max(peak, active); calls.push(item.domain);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return item.domain === 'employer2.example' ? { hiring: false, openRoles: 0, exampleRoles: [], newestPosting: null }
      : { hiring: true, openRoles: 3, exampleRoles: ['Assembler'], newestPosting: '2026-11-22' };
  };
  const result = await list.freshenEmployers({ now: NOW, recheck,
    employers: [employer(1, 'TX', { checkedAt: daysAgo(20) }), employer(2, 'TX', { checkedAt: daysAgo(15) }), employer(3, 'TX', { checkedAt: daysAgo(5) })] });
  assert.equal(peak, 1);
  assert.deepEqual(calls, ['employer1.example', 'employer2.example']);
  assert.deepEqual(result.dropped, ['employer2.example']);
  assert.deepEqual(result.employers.map(e => e.domain), ['employer1.example', 'employer3.example']);
  assert.equal(result.employers[0].openRoles, 3);
  assert.equal(result.updates.length, 2);
});

test('GetLeads failure: stored data only within 21 days, otherwise the owner reviews', async () => {
  const fail = async () => { const error = new Error('busy'); error.code = 'getleads_busy'; throw error; };
  const usable = await list.freshenEmployers({ now: NOW, recheck: fail,
    employers: [employer(1, 'TX', { checkedAt: daysAgo(16) }), employer(2, 'TX', { checkedAt: daysAgo(20) })] });
  assert.equal(usable.status, 'ok');
  assert.equal(usable.usedStoredFallback, true);
  assert.equal(usable.employers.length, 2);
  const tooOld = await list.freshenEmployers({ now: NOW, recheck: fail,
    employers: [employer(1, 'TX', { checkedAt: daysAgo(16) }), employer(2, 'TX', { checkedAt: daysAgo(25) })] });
  assert.equal(tooOld.status, 'review');
  assert.equal(tooOld.reason, 'freshness_unavailable');
});

test('a dropped employer is replaced on re-selection', async () => {
  const pool = Array.from({ length: 6 }, (_, i) => employer(i, 'TX', { checkedAt: i === 0 ? daysAgo(30) : daysAgo(1), openRoles: 20 - i }));
  const built = await list.buildSampleList({ employers: pool, lead, now: NOW,
    recheck: async () => ({ hiring: false, openRoles: 0, exampleRoles: [], newestPosting: null }) });
  assert.equal(built.status, 'ready');
  assert.equal(built.employers.length, 5);
  assert.ok(!built.employers.some(e => e.domain === 'employer0.example'));
  assert.deepEqual(built.updates.map(u => u.domain), ['employer0.example']);
});

test('postings count only fresh hands-on roles in the stored state', () => {
  const summary = list.summarizePostings([
    { title: 'Welder - 2nd Shift', posted_at: '2026-11-20 10:00:00', geo_admin_district: 'TX' },
    { title: 'CNC MACHINIST', posted_at: '2026-11-18', geo_admin_district: 'TX' },
    { title: 'Production Supervisor', posted_at: '2026-11-21', geo_admin_district: 'TX' },
    { title: 'Welder', posted_at: '2026-10-01', geo_admin_district: 'TX' },
    { title: 'Assembler', posted_at: '2026-11-21', geo_admin_district: 'OK' },
  ], { now: NOW, state: 'TX' });
  assert.deepEqual(summary, { hiring: true, openRoles: 2, exampleRoles: ['Welder', 'Cnc Machinist'], newestPosting: '2026-11-20' });
});

// ── rendering ────────────────────────────────────────────────────────────────
test('the draft is a plain-text table with no links, no dashes and the standard footer', () => {
  const employers = [employer(1, 'TX', { company: 'Alpha — Steel', exampleRoles: ['Pipe Welder', 'Fitter – Class A'] }),
    employer(2, 'TX', { openRolesLabel: '11+' })];
  const body = list.renderSampleListBody({ firstName: 'Pat', company: 'Example Staffing', market: 'Texas', employers });
  assert.match(body, /^Hi Pat,\n\nHere are 2 employers in Texas hiring the trades you place right now:\n\nCompany +\| City, State +\| Open roles \| Example roles\n-+\n/);
  assert.match(body, /Alpha - Steel +\| Town 1, TX +\| \d+ +\| Pipe Welder, Fitter - Class A/);
  assert.match(body, /\| 11\+ +\|/);
  assert.match(body, /These are the kinds of companies we'd reach and book meetings with for Example Staffing\.\n\nWorth a 15-minute call to walk through how we'd approach them\?\n\nDeins$/);
  assert.equal(list.sampleListBodyProblem(body), null);
  const full = appendStaffingComplianceFooter(body, { companyName: 'ScaleLabAi', website: 'scalelabai.ca',
    mailingAddress: '100 Example Street, Suite 2, Springfield, IL 62701' });
  assert.equal(staffingComplianceError(full), null);
  assert.equal(list.renderSampleListBody({ firstName: '', company: '', market: 'Texas', employers }).split('\n')[0], 'Hi there,');
});

test('render refuses more than 10 employers and flags links', () => {
  assert.throws(() => list.renderSampleListBody({ firstName: 'A', company: 'B', market: 'Texas',
    employers: Array.from({ length: 11 }, (_, i) => employer(i, 'TX')) }), /1 to 10/);
  assert.match(list.sampleListBodyProblem('see www.example.com'), /link/);
});

// ── auto-send policy ─────────────────────────────────────────────────────────
test('auto-send is off unless SCALELAB_SAMPLE_LIST_AUTOSEND is exactly true', () => {
  const good = { verdict: { intent: 'sample_list_request', confidence: 'high' }, now: NOW, draftedAt: daysAgo(1),
    list: { status: 'ready', usedStoredFallback: false, state: 'TX', scope: 'state' }, replyText: 'Yes' };
  assert.deepEqual(list.autoSendDecision({ ...good, env: {} }), { send: false, reason: 'autosend_off' });
  assert.equal(list.autoSendDecision({ ...good, env: { SCALELAB_SAMPLE_LIST_AUTOSEND: 'false' } }).send, false);
  const on = { SCALELAB_SAMPLE_LIST_AUTOSEND: 'true' };
  assert.equal(list.autoSendDecision({ ...good, env: on }).send, true);
  assert.equal(list.autoSendDecision({ ...good, env: on, draftedAt: new Date(NOW - 5 * 60000).toISOString() }).reason, 'delay_pending');
  assert.equal(list.autoSendDecision({ ...good, env: on, replyText: 'yes, then unsubscribe me' }).reason, 'negative_signal');
  assert.equal(list.autoSendDecision({ ...good, env: on, list: { ...good.list, usedStoredFallback: true } }).reason, 'list_not_fresh');
  assert.equal(list.autoSendDecision({ ...good, env: on, list: { ...good.list, state: null, scope: 'national_state_unknown' } }).reason, 'agency_state_unknown');
  assert.equal(list.autoSendDecision({ ...good, env: on, verdict: { intent: 'interest', confidence: 'high' } }).reason, 'not_high_confidence');
});

// ── GetLeads client ──────────────────────────────────────────────────────────
function fakeGetLeads({ busyFirst = 0 } = {}) {
  let active = 0; let peak = 0; let busy = busyFirst; const calls = [];
  const fetchImpl = async (url, init) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active -= 1;
    const payload = JSON.parse(init.body);
    calls.push(payload.method);
    const headers = { get: name => (name === 'Mcp-Session-Id' ? 'S1' : null) };
    if (payload.method === 'tools/call' && busy > 0) {
      busy -= 1;
      return { ok: false, status: 503, headers, text: async () => 'Contact database query admission timeout: too many concurrent queries' };
    }
    const result = payload.method === 'tools/call'
      ? { content: [{ type: 'text', text: JSON.stringify({ data: [{ title: 'Welder', posted_at: '2026-11-20', geo_admin_district: 'TX' }], total_results: 1 }) }] }
      : {};
    return { ok: true, status: 200, headers, text: async () => (payload.id ? `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })}` : '') };
  };
  return { fetchImpl, calls, peak: () => peak };
}

test('GetLeads calls are serialized and 503 busy responses are retried with backoff', async () => {
  const fake = fakeGetLeads({ busyFirst: 2 });
  const sleeps = [];
  const client = createGetLeadsJobsClient({ env: { GETLEADS_API_KEY: 'test' }, fetchImpl: fake.fetchImpl,
    sleep: async ms => { sleeps.push(ms); }, backoff: [10, 20, 30] });
  const [a, b] = await Promise.all([client.searchCompanyJobs('a.example', { now: NOW }), client.searchCompanyJobs('b.example', { now: NOW })]);
  assert.equal(a.data.length, 1);
  assert.equal(b.data.length, 1);
  assert.equal(fake.peak(), 1);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(fake.calls.filter(m => m === 'initialize').length, 1);
});

test('GetLeads fails closed without an API key', async () => {
  const client = createGetLeadsJobsClient({ env: {}, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(client.searchCompanyJobs('a.example'), error => error.code === 'getleads_unconfigured');
});

// ── flow ─────────────────────────────────────────────────────────────────────
function memoryStore(employers) {
  const events = new Map(); const checks = [];
  return { events, checks,
    async listHiring() { return employers.filter(e => e.status === 'hiring'); },
    async listPool() { return employers; },
    async recordCheck(update) { checks.push(update); const row = employers.find(e => e.domain === update.domain);
      Object.assign(row, { status: update.hiring ? 'hiring' : 'not_hiring', checkedAt: update.checkedAt }); return { ...row }; },
    async getEvent(id) { return events.get(id) || null; },
    async logEvent(event) {
      if (!events.has(event.eventId)) events.set(event.eventId, { event_id: event.eventId, kind: event.kind, action_id: event.actionId,
        lead_id: event.leadId, thread_id: event.threadId || null, mailbox_id: event.mailboxId || null, state: event.state || null,
        scope: event.scope || null, gmail_draft_id: null, outcome: event.outcome || null, detail: event.detail || {}, occurred_at: event.occurredAt });
      return events.get(event.eventId);
    },
    async updateEvent(id, patch) { const row = { ...events.get(id), ...patch }; events.set(id, row); return row; },
  };
}

const action = { id: 'a'.repeat(64), leadId: 'lead-1', messageId: 'in-1', mailboxId: 'box', step: 'complete',
  verdict: { intent: 'sample_list_request', confidence: 'high', reason: 'affirmed_sample_list_offer' }, receivedAt: daysAgo(0.1) };
const inbound = { threadId: 'T1', subject: 'Employer accounts for Example Staffing', rfcMessageId: '<in-1@example>', text: 'Yes' };

function deps(store, overrides = {}) {
  const drafts = []; const tasks = []; const pushes = [];
  return { drafts, tasks, pushes, deps: { store, recheck: async () => { throw new Error('not expected'); },
    createDraft: async draft => { drafts.push(draft); return { id: `draft-${drafts.length}` }; },
    publishTask: async task => { tasks.push(task); }, notify: async push => { pushes.push(push); },
    appendFooter: body => `${body}\n\nFOOTER`, ...overrides } };
}

test('a routed sample-list request gets exactly one Gmail draft, a dashboard task and a push', async () => {
  const store = memoryStore(Array.from({ length: 6 }, (_, i) => employer(i, 'TX')));
  const harness = deps(store);
  const first = await flow.draftSampleListForAction({ action, inbound, lead, now: NOW, deps: harness.deps });
  assert.equal(first.status, 'drafted');
  assert.equal(harness.drafts.length, 1);
  assert.equal(harness.drafts[0].subject, 'Re: Employer accounts for Example Staffing');
  assert.match(harness.drafts[0].body, /^Hi Pat,\n\nHere are 6 employers in Texas/);
  assert.match(harness.drafts[0].body, /FOOTER$/);
  assert.equal(harness.tasks[0].eventType, 'scalelab_sample_list_drafted');
  assert.equal(JSON.parse(harness.tasks[0].metadata).autoSendAllowed, false);
  assert.equal(harness.pushes.length, 1);
  const row = store.events.get(`sample-list:draft:${action.id}`);
  assert.equal(row.gmail_draft_id, 'draft-1');
  assert.equal(row.detail.status, 'ready');
  const again = await flow.draftSampleListForAction({ action, inbound, lead, now: NOW, deps: harness.deps });
  assert.equal(again.status, 'existing');
  assert.equal(harness.drafts.length, 1);
});

test('no draft for an unrouted, suppressed or stale request', async () => {
  const store = memoryStore(Array.from({ length: 6 }, (_, i) => employer(i, 'TX')));
  const harness = deps(store);
  assert.equal((await flow.draftSampleListForAction({ action: { ...action, step: 'held' }, inbound, lead, now: NOW, deps: harness.deps })).status, 'skipped');
  const suppressed = await flow.draftSampleListForAction({ action: { ...action, id: 'b'.repeat(64) }, inbound, now: NOW,
    lead: { ...lead, notes: '[MANUAL HOLD] [REPLY: Unsubscribed]' }, deps: harness.deps });
  assert.equal(suppressed.status, 'review');
  const old = await flow.draftSampleListForAction({ action: { ...action, id: 'c'.repeat(64), receivedAt: daysAgo(5) }, inbound, lead, now: NOW, deps: harness.deps });
  assert.equal(old.reason, 'request_too_old');
  assert.equal(harness.drafts.length, 0);
  assert.equal(harness.pushes.length, 2);
});

test('the routing hold alone does not stop the draft', async () => {
  const store = memoryStore(Array.from({ length: 6 }, (_, i) => employer(i, 'TX')));
  const harness = deps(store);
  const result = await flow.draftSampleListForAction({ action, inbound, lead: { ...lead, notes: '[MANUAL HOLD]' }, now: NOW, deps: harness.deps });
  assert.equal(result.status, 'drafted');
});

test('GetLeads down and the stored list too old: the owner gets it, no draft', async () => {
  const store = memoryStore(Array.from({ length: 6 }, (_, i) => employer(i, 'TX', { checkedAt: daysAgo(25) })));
  const harness = deps(store, { recheck: async () => { const e = new Error('down'); e.code = 'getleads_busy'; throw e; } });
  const result = await flow.draftSampleListForAction({ action, inbound, lead, now: NOW, deps: harness.deps });
  assert.equal(result.status, 'review');
  assert.equal(result.reason, 'freshness_unavailable');
  assert.equal(harness.drafts.length, 0);
});

test('a claimed draft with no saved Gmail id is never drafted again', async () => {
  const store = memoryStore(Array.from({ length: 6 }, (_, i) => employer(i, 'TX')));
  await store.logEvent({ kind: 'drafted', eventId: `sample-list:draft:${action.id}`, actionId: action.id, leadId: 'lead-1',
    detail: { status: 'claimed', claimId: 'other' }, occurredAt: new Date(NOW - 20 * 60000).toISOString() });
  const harness = deps(store);
  const result = await flow.draftSampleListForAction({ action, inbound, lead, now: NOW, deps: harness.deps });
  assert.equal(result.reason, 'draft_outcome_unconfirmed');
  assert.equal(harness.drafts.length, 0);
});

test('sent and outcome are logged from later activity', async () => {
  const store = memoryStore([]);
  const draft = await store.logEvent({ kind: 'drafted', eventId: 'sample-list:draft:x', actionId: 'x', leadId: 'lead-1', threadId: 'T1',
    detail: { status: 'ready', draftedAt: daysAgo(20) }, occurredAt: daysAgo(20) });
  const sentRow = { eventId: 'human-out-1', sourceLeadId: 'lead-1', eventType: 'human_response_sent', occurredAt: daysAgo(19),
    metadata: JSON.stringify({ gmailThreadId: 'T1' }) };
  let written = await flow.recordSentAndOutcomes({ events: [draft], activities: [sentRow], store, now: NOW });
  assert.deepEqual(written.map(row => row.kind), ['sent', 'outcome']);
  assert.equal(store.events.get('sample-list:outcome:x').outcome, 'no_reply');

  const store2 = memoryStore([]);
  const draft2 = await store2.logEvent({ ...{ kind: 'drafted', eventId: 'sample-list:draft:y', actionId: 'y', leadId: 'lead-1', threadId: 'T1' },
    detail: { status: 'ready', draftedAt: daysAgo(3) }, occurredAt: daysAgo(3) });
  written = await flow.recordSentAndOutcomes({ events: [draft2], store: store2, now: NOW,
    activities: [{ ...sentRow, occurredAt: daysAgo(2) }, { eventId: 'cal-1', sourceLeadId: 'lead-1', eventType: 'call_booked', occurredAt: daysAgo(1) }] });
  assert.equal(store2.events.get('sample-list:outcome:y').outcome, 'call_booked');

  assert.equal(list.sampleListOutcome({ sentAt: daysAgo(3), leadId: 'lead-1', now: NOW, activities: [{ eventId: 'gmail-reply:r', sourceLeadId: 'lead-1',
    occurredAt: daysAgo(1), metadata: JSON.stringify({ scalelabReply: { intent: 'explicit_rejection' } }) }] }), 'declined');
});

test('auto-send never runs while off, and logs a refusal from the warm-reply gate when on', async () => {
  const store = memoryStore([]);
  const ready = { kind: 'drafted', action_id: 'z', lead_id: 'lead-1', state: 'TX', scope: 'state', thread_id: 'T1', gmail_draft_id: 'd1',
    detail: { status: 'ready', draftedAt: daysAgo(1), usedStoredFallback: false, verdict: { intent: 'sample_list_request', confidence: 'high' } } };
  let delivered = 0;
  const off = await flow.autoSendReadyDrafts({ events: [ready], env: {}, now: NOW, deps: { store, deliver: async () => { delivered += 1; } } });
  assert.deepEqual(off, []);
  assert.equal(delivered, 0);
  const on = { SCALELAB_SAMPLE_LIST_AUTOSEND: 'true' };
  await flow.autoSendReadyDrafts({ events: [ready], env: on, now: NOW, deps: { store,
    deliver: async () => { delivered += 1; return { delivered: false, code: 'manual_hold' }; } } });
  assert.equal(delivered, 1);
  assert.equal(store.events.get('sample-list:autosend:z').detail.reason, 'manual_hold');
  const pushes = [];
  const store2 = memoryStore([]);
  await flow.autoSendReadyDrafts({ events: [ready], env: on, now: NOW, deps: { store: store2,
    notify: async push => pushes.push(push), deliver: async () => ({ delivered: true }) } });
  assert.equal(store2.events.get('sample-list:sent:z').detail.source, 'autosend');
  assert.equal(pushes.length, 1);
});

test('weekly restock tops each state up to the target, one check at a time, within the cap', async () => {
  const pool = [employer(1, 'TX', { checkedAt: daysAgo(9) }), employer(2, 'TX'),
    ...Array.from({ length: 5 }, (_, i) => employer(10 + i, 'TX', { status: 'unchecked', checkedAt: null })),
    ...Array.from({ length: 3 }, (_, i) => employer(20 + i, 'OK', { status: 'unchecked', checkedAt: null }))];
  const store = memoryStore(pool);
  let active = 0; let peak = 0;
  const summary = await flow.restockSampleEmployers({ store, now: NOW, perState: 4, maxChecks: 50,
    recheck: async item => { active += 1; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 1)); active -= 1;
      return { hiring: item.domain !== 'employer10.example', openRoles: 2, exampleRoles: ['Welder'], newestPosting: '2026-11-20' }; } });
  assert.equal(peak, 1);
  assert.equal(summary.states.TX, 4);
  assert.equal(summary.states.OK, 3);
  assert.ok(store.checks.some(c => c.domain === 'employer1.example'));
  const capped = await flow.restockSampleEmployers({ store: memoryStore(pool.map(e => ({ ...e, status: 'unchecked', checkedAt: null }))),
    now: NOW, perState: 10, maxChecks: 2, recheck: async () => ({ hiring: true, openRoles: 1, exampleRoles: [], newestPosting: '2026-11-20' }) });
  assert.equal(capped.checks, 2);
});

test('the loader refuses contact fields and bad rows', () => {
  const base = { domain: 'employer1.example', company: 'E', city: 'X', state: 'TX', status: 'hiring', open_roles: 2, checked_at: daysAgo(1), national_rank: null };
  assert.deepEqual(validateRows([base]), []);
  assert.match(validateRows([{ ...base, contact_email: 'a@b.c' }])[0], /contact field/);
  assert.match(validateRows([{ ...base, state: 'XX' }])[0], /bad state/);
  assert.match(validateRows([{ ...base, open_roles: 0 }])[0], /hiring without a check/);
});

test('the sample-list code never sends by itself and the agent pass is feature-gated', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  for (const file of ['integrations/scalelab-sample-list.js', 'integrations/scalelab-sample-list-flow.js',
    'integrations/scalelab-sample-list-store.js', 'integrations/getleads-jobs.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /messages\.send|drafts\.send|sendEmail\(|guardProviderSend/, file);
  }
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
  assert.match(agent, /if \(scaleLab\.mode === 'apply' && sampleListConfig\(\)\.enabled\) \{\s+try \{\s+await withAuth\(\(\) => runSampleListPass/);
  // Auto-send reuses the hardened warm-reply delivery (final gate + reservation).
  assert.match(agent, /async function deliverSampleListDraft[\s\S]{0,1600}return deliverHardenedWarmReply\(/);
  assert.equal(flow.sampleListConfig({}).enabled, false);
  assert.equal(flow.sampleListConfig({}).autosend, false);
  assert.equal(flow.sampleListConfig({}).restock, false);
});
