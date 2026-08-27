'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendReference, findOriginalSentThread } = require('../integrations/gmail-threading');

function message(id, subject, threadId, messageId, internalDate, references = '') {
  return { id, threadId, internalDate: String(internalDate), payload: { headers: [
    { name: 'Subject', value: subject },
    ...(messageId ? [{ name: 'Message-ID', value: messageId }] : []),
    ...(references ? [{ name: 'References', value: references }] : []),
  ] } };
}

test('thread resolver selects the newest exact-subject outbound message', async () => {
  const records = {
    old: message('old', "Galaxy Dental's missed calls", 'thread-original', '<old@gmail>', 100, '<root@gmail>'),
    newest: message('newest', "Galaxy Dental's missed calls", 'thread-newest', '<new@gmail>', 200),
    unrelated: message('unrelated', 'Re: a quick demo I built for Galaxy Dental', 'thread-wrong', '<wrong@gmail>', 300),
  };
  const calls = [];
  const gmail = { users: { messages: {
    list: async input => { calls.push(input); return { data: { messages: Object.keys(records).map(id => ({ id })) } }; },
    get: async ({ id }) => ({ data: records[id] }),
  } } };
  const result = await findOriginalSentThread({ gmail, email: 'seton@galaxydental.ca', expectedSubject: "Galaxy Dental's missed calls" });
  assert.equal(result.threadId, 'thread-newest');
  assert.equal(result.inReplyTo, '<new@gmail>');
  assert.equal(result.references, '<new@gmail>');
  assert.equal(result.subject, "Galaxy Dental's missed calls");
  assert.match(calls[0].q, /in:sent to:"seton@galaxydental\.ca"/);
});

test('thread resolver preserves the reference chain and fails closed without required IDs', async () => {
  assert.equal(appendReference('<root@gmail> <prior@gmail>', '<prior@gmail>'), '<root@gmail> <prior@gmail>');
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [{ id: 'broken' }] } }),
    get: async () => ({ data: message('broken', 'Subject', '', '', 1) }),
  } } };
  assert.equal(await findOriginalSentThread({ gmail, email: 'owned@example.com', expectedSubject: 'Subject' }), null);
});

test('thread resolver accepts current and historical exact subjects', async () => {
  const records = {
    historical: message('historical', "Cooper Dental's missed calls", 'thread-old', '<old@gmail>', 100),
    current: message('current', 'quick question about Invisalign', 'thread-current', '<current@gmail>', 200),
    impostor: message('impostor', 'quick question about implants', 'thread-wrong', '<wrong@gmail>', 300),
  };
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: Object.keys(records).map(id => ({ id })) } }),
    get: async ({ id }) => ({ data: records[id] }),
  } } };
  const result = await findOriginalSentThread({
    gmail, email: 'owner@example.com',
    expectedSubjects: ['quick question about Invisalign', "Cooper Dental's missed calls"],
  });
  assert.equal(result.threadId, 'thread-current');
  assert.equal(result.subject, 'quick question about Invisalign');
});

test('dental intent path supplies all Gmail thread requirements and remains fail closed', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /expectedSubjects: \[currentSubject, legacySubject\]/);
  assert.match(agent, /threadId: thread\.threadId, inReplyTo: thread\.inReplyTo, references: thread\.references/);
  assert.match(agent, /original Gmail thread could not be verified/);
  assert.match(agent, /if \(fired\.has\(`\$\{lead\.id\}\|both-audios`\)\) continue/);
});
