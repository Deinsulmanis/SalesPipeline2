'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { persistActivityEvents } = require('../integrations/activity-ledger-batch');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');

const header = ['eventId', 'leadId', 'sourceLeadId', 'email', 'company',
  'eventType', 'occurredAt', 'subject', 'content', 'metadata'];
const rowOf = event => header.map(field => String(event[field] ?? ''));
const event = id => ({ eventId: id, leadId: 'CE-lead', sourceLeadId: 'lead',
  email: 'lead@example.com', company: 'Clinic', eventType: 'human_response_sent',
  occurredAt: '2026-09-22T12:00:00.000Z', subject: 'Re: hello', content: '',
  metadata: JSON.stringify({ gmailMessageId: id, autoSendAllowed: false }) });

function ledger(initial = []) {
  const rows = [header, ...initial.map(rowOf)];
  const calls = { reads: 0, writes: 0, batches: [], mirrors: [] };
  let append = async values => { rows.push(...values); };
  const values = {
    get: async () => { calls.reads++; return { data: { values: rows.map(row => [...row]) } }; },
    append: async args => {
      calls.writes++;
      const batch = args.requestBody.values;
      calls.batches.push(batch);
      await append(batch);
      return { data: { updates: { updatedRows: batch.length } } };
    },
  };
  const persist = events => persistActivityEvents({ events, values, spreadsheetId: 'test',
    sheetName: 'ColdCallActivity', header, ensureSheet: async () => {},
    mirrorEvents: events => calls.mirrors.push(...events) });
  return { rows, calls, values, persist, setAppend: fn => { append = fn; } };
}

function observerBurst() {
  const leads = [1, 2].map(n => ({ id: `lead-${n}`, email: `lead${n}@example.com`, company: `Clinic ${n}` }));
  const at = Date.parse('2026-09-22T12:00:00.000Z');
  const activities = leads.map((lead, i) => ({ eventId: `prior-${i}`, sourceLeadId: lead.id,
    eventType: 'positive_reply', occurredAt: new Date(at - 60000).toISOString(),
    metadata: JSON.stringify({ gmailThreadId: `thread-${i}` }) }));
  const messages = leads.map((lead, i) => ({ id: `sent-${i}`, threadId: `thread-${i}`,
    internalDate: String(at + i), labelIds: ['SENT'], payload: { headers: [
      { name: 'From', value: 'sender@example.com' }, { name: 'To', value: lead.email },
      { name: 'Subject', value: 'Re: hello' }, { name: 'Message-ID', value: `<sent-${i}@example.com>` },
    ] } }));
  const observation = { messages, unavailable: Array.from({ length: 46 }, (_, i) =>
    ({ id: `missing-${i}`, threadId: `lost-${i % 4}`, status: 404 })), recovered: false,
    nextHistoryId: '201', trustworthy: true };
  return { observation, leads, activities };
}

test('single event keeps the same row, identity, deduplication and result', async () => {
  const store = ledger();
  const item = event('gmail-human:one');
  assert.deepEqual(await store.persist([item]), { candidates: 1, deduplicated: 0, persisted: 1 });
  assert.deepEqual(store.rows[1], rowOf(item));
  assert.equal(store.calls.reads, 2);
  assert.equal(store.calls.writes, 1);
  assert.deepEqual(await store.persist([item]), { candidates: 1, deduplicated: 1, persisted: 0 });
  assert.equal(store.calls.writes, 1);
  assert.equal(store.rows.length, 2);
  assert.deepEqual(store.calls.mirrors.map(row => row.eventId), [item.eventId]);
});

test('46 missing Gmail IDs and two human sends persist as 48 ordered rows in one Sheets append', async () => {
  const input = observerBurst();
  const plan = await planMailboxEvents({ ...input, senderInboxId: 'primary', senderEmail: 'sender@example.com',
    now: new Date('2026-09-22T13:00:00.000Z'), gmail: { users: { threads: { get: async () => assert.fail('no thread fetch needed') } } } });
  assert.equal(plan.events.filter(row => row.eventType === 'gmail_observation_gap').length, 46);
  assert.equal(plan.events.filter(row => row.eventType === 'human_response_sent').length, 2);
  assert.equal(new Set(plan.events.map(row => row.eventId)).size, 48);
  const store = ledger(input.activities);
  let checkpoints = 0;
  const cycle = [...input.activities];
  await commitObservation({ observation: input.observation, plan, activities: cycle,
    suppress: async () => {}, appendEvents: store.persist, checkpoint: async () => { checkpoints++; } });
  assert.equal(checkpoints, 1);
  assert.deepEqual(store.rows.slice(1 + input.activities.length), plan.events.map(rowOf));
  assert.equal(store.calls.reads, 2, 'one pre-read and one verification read');
  assert.equal(store.calls.writes, 1);
  assert.equal(store.calls.reads + store.calls.writes, 3);
  assert.equal(store.calls.batches[0].length, 48);
  assert.equal(cycle.length, input.activities.length + 48);
  assert.equal(store.calls.mirrors.length, 48);
});

test('existing and in-batch duplicates are suppressed, and replay writes nothing', async () => {
  const old = event('old');
  const one = event('one');
  const two = event('two');
  const store = ledger([old]);
  assert.deepEqual(await store.persist([old, one, one, two]),
    { candidates: 4, deduplicated: 2, persisted: 2 });
  assert.deepEqual(store.calls.batches[0], [rowOf(one), rowOf(two)]);
  assert.deepEqual(await store.persist([old, one, two]),
    { candidates: 3, deduplicated: 3, persisted: 0 });
  assert.equal(store.calls.writes, 1);
  assert.equal(new Set(store.rows.slice(1).map(row => row[0])).size, 3);
});

test('ambiguous accepted append reconciles without a second write', async () => {
  const store = ledger();
  store.setAppend(async rows => {
    store.rows.push(...rows);
    throw new Error('response lost after accept');
  });
  assert.equal((await store.persist([event('one'), event('two')])).persisted, 2);
  assert.equal(store.calls.writes, 1);
  assert.equal(store.rows.length, 3);
});

test('partial append fails closed; replay appends only missing rows before checkpoint', async () => {
  const store = ledger();
  const planned = [event('one'), event('two'), event('three')];
  let checkpoints = 0;
  const cycle = [];
  store.setAppend(async rows => {
    store.rows.push(rows[0]);
    throw new Error('partial acceptance');
  });
  const args = { observation: { nextHistoryId: '201' }, plan: { events: planned, suppressions: [] },
    activities: cycle, suppress: async () => {}, appendEvents: store.persist,
    checkpoint: async () => { checkpoints++; } };
  await assert.rejects(() => commitObservation(args), /readback failed for 2 of 3/);
  assert.equal(checkpoints, 0);
  assert.equal(cycle.length, 0);
  store.setAppend(async rows => { store.rows.push(...rows); });
  await commitObservation(args);
  assert.equal(checkpoints, 1);
  assert.equal(store.calls.batches[1].length, 2);
  assert.equal(new Set(store.rows.slice(1).map(row => row[0])).size, 3);
});

test('definitive failed append and failed readback cannot mark persistence successful', async () => {
  const store = ledger();
  store.setAppend(async () => { throw new Error('Sheets unavailable'); });
  await assert.rejects(() => store.persist([event('one')]), /readback failed for 1 of 1/);
  assert.equal(store.rows.length, 1);
  assert.equal(store.calls.mirrors.length, 0);
});

test('verification read failure keeps the checkpoint old; replay finds the accepted row', async () => {
  const store = ledger();
  const ordinaryGet = store.values.get;
  store.values.get = async args => {
    if (store.calls.writes) throw new Error('Sheets read unavailable');
    return ordinaryGet(args);
  };
  const item = event('one');
  const cycle = [];
  let checkpoints = 0;
  const args = { observation: { nextHistoryId: '201' }, plan: { events: [item], suppressions: [] },
    activities: cycle, suppress: async () => {}, appendEvents: store.persist,
    checkpoint: async () => { checkpoints++; } };
  await assert.rejects(() => commitObservation(args), /Sheets read unavailable/);
  assert.equal(checkpoints, 0);
  assert.equal(cycle.length, 0);
  assert.equal(store.calls.mirrors.length, 1, 'an acknowledged Sheets write still reaches the shadow mirror');
  store.values.get = ordinaryGet;
  await commitObservation(args);
  assert.equal(checkpoints, 1);
  assert.equal(store.calls.writes, 1);
  assert.equal(store.rows.length, 2);
});
