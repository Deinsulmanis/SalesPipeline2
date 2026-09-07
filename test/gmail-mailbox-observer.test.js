'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchMailboxMessages, observeMailbox } = require('../integrations/gmail-mailbox-observer');

const body = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') }, headers: [] });
const message = ({ id, from, threadId, at, text, labels = [] }) => ({ id, threadId, internalDate: String(Date.parse(at)), labelIds: labels,
  payload: { ...body(text), headers: [{ name: 'From', value: from }, { name: 'Message-ID', value: `<${id}@test>` }] }, snippet: text });

test('mailbox messages match locally by exact address or canonical thread', () => {
  const leads = [{ id: 'a', email: 'a@example.com', lastEmailedAt: '2026-09-01T00:00:00Z' },
    { id: 'b', email: 'info@example.com', lastEmailedAt: '2026-09-01T00:00:00Z' }];
  const activities = [{ sourceLeadId: 'b', metadata: JSON.stringify({ senderInboxId: 'primary', gmailThreadId: 'tb' }) }];
  const result = matchMailboxMessages([
    message({ id: 'r1', from: 'a@example.com', threadId: 'new', at: '2026-09-02T00:00:00Z', text: 'Yes' }),
    message({ id: 'r2', from: 'owner@elsewhere.com', threadId: 'tb', at: '2026-09-03T00:00:00Z', text: 'Talk to me' }),
  ], { leads, activities, senderInboxId: 'primary', senderEmail: 'deins@scalelabai.ca' });
  assert.equal(result.replies.get('a').id, 'r1');
  assert.equal(result.replies.get('b').id, 'r2');
});

test('bootstrap checkpoints now and replays no historical messages for 1,000 leads', async () => {
  let lists = 0; let gets = 0; let profiles = 0;
  const gmail = { users: {
    messages: { list: async () => { lists++; return { data: { messages: [] } }; }, get: async () => { gets++; } },
    getProfile: async () => { profiles++; return { data: { historyId: '100' } }; },
    history: { list: async () => { throw new Error('not used'); } },
  } };
  const leads = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), email: `lead${i}@example.com`, lastEmailedAt: '2026-09-01T00:00:00Z' }));
  const result = await observeMailbox({ gmail, leads, activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com' });
  assert.equal(result.mode, 'bootstrap');
  assert.equal(result.messagesInspected, 0);
  assert.deepEqual({ lists, gets, profiles }, { lists: 0, gets: 0, profiles: 1 });
});

test('expired History performs a controlled bootstrap without replaying recent mail', async () => {
  let lists = 0; let profiles = 0;
  const error = new Error('history expired'); error.response = { status: 404 };
  const gmail = { users: {
    history: { list: async () => { throw error; } },
    messages: { list: async () => { lists++; return { data: { messages: [{ id: 'old' }] } }; }, get: async () => { throw new Error('must not fetch old mail'); } },
    getProfile: async () => { profiles++; return { data: { historyId: '200' } }; },
  } };
  const result = await observeMailbox({ gmail, historyId: '100', leads: [], activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com' });
  assert.equal(result.mode, 'bootstrap_after_stale_history');
  assert.equal(result.messagesInspected, 0);
  assert.deepEqual({ lists, profiles }, { lists: 0, profiles: 1 });
});

test('a truncated History listing fails closed instead of skipping events', async () => {
  const gmail = { users: {
    history: { list: async () => ({ data: { historyId: '102', nextPageToken: 'more', history: [] } }) },
    messages: { get: async () => { throw new Error('not reached'); } },
  } };
  await assert.rejects(() => observeMailbox({ gmail, historyId: '100', maxPages: 1, leads: [], activities: [],
    senderInboxId: 'primary', senderEmail: 'sender@example.com' }), /checkpoint was not advanced/);
});

test('incremental runs use Gmail History and fetch only added messages', async () => {
  let historyCalls = 0; let messageLists = 0; let gets = 0;
  const reply = message({ id: 'r1', from: 'lead@example.com', threadId: 't1', at: '2026-09-02T00:00:00Z', text: 'Interested' });
  const gmail = { users: {
    history: { list: async () => { historyCalls++; return { data: { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'r1' } }] }] } }; } },
    messages: { list: async () => { messageLists++; return { data: {} }; }, get: async () => { gets++; return { data: reply }; } },
    getProfile: async () => ({ data: { historyId: '102' } }),
  } };
  const result = await observeMailbox({ gmail, historyId: '100', leads: [{ id: 'l1', email: 'lead@example.com', lastEmailedAt: '2026-09-01T00:00:00Z' }], activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com' });
  assert.equal(result.replies.get('l1').id, 'r1');
  assert.deepEqual({ historyCalls, messageLists, gets }, { historyCalls: 1, messageLists: 0, gets: 1 });
});

test('permanent bounce is matched locally and a transient delay is not', () => {
  const leads = [{ id: 'a', email: 'a@example.com', lastEmailedAt: '2026-09-01T00:00:00Z' }];
  const permanent = message({ id: 'b1', from: 'Mailer-Daemon <mailer-daemon@gmail.com>', threadId: 'x', at: '2026-09-02T00:00:00Z', text: '550 5.1.1 no such user a@example.com' });
  const transient = message({ id: 'b2', from: 'postmaster@example.net', threadId: 'y', at: '2026-09-03T00:00:00Z', text: '4.2.0 delivery incomplete, will retry a@example.com' });
  assert.equal(matchMailboxMessages([permanent], { leads, activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com' }).bounces.get('a').id, 'b1');
  assert.equal(matchMailboxMessages([transient], { leads, activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com' }).bounces.size, 0);
});
