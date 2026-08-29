'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendReference, findOriginalSentThread, resolveColdFollowUpThread } = require('../integrations/gmail-threading');

function message(id, subject, threadId, messageId, internalDate, references = '') {
  return { id, threadId, internalDate: String(internalDate), payload: { headers: [
    { name: 'Subject', value: subject },
    { name: 'To', value: 'Deborah <owner@cooperdental.example>' },
    ...(messageId ? [{ name: 'Message-ID', value: messageId }] : []),
    ...(references ? [{ name: 'References', value: references }] : []),
  ] } };
}

const activity = (eventType, id, at, subject, threadId = 'thread-1', leadId = 'lead-1') => ({
  eventType, eventId: `gmail:${id}`, sourceLeadId: leadId, leadId: `CE-${leadId}`,
  email: leadId === 'lead-1' ? 'owner@cooperdental.example' : 'other@example.test',
  occurredAt: at, subject,
  metadata: JSON.stringify({ gmailMessageId: id, gmailThreadId: threadId }),
});

test('ordinary step 2 replies to the provider-backed initial Gmail message and preserves its personalized subject', async () => {
  const activities = [activity('initial_email_sent', 'm1', '2026-08-01T10:00:00Z', 'quick question about Invisalign')];
  const gmail = { users: { messages: { get: async () => ({ data: message('m1', 'quick question about Invisalign', 'thread-1', '<m1@gmail>', 1) }) } } };
  const result = await resolveColdFollowUpThread({ gmail, lead: { id: 'lead-1', email: 'owner@cooperdental.example' }, activities });
  assert.deepEqual(result, {
    threadId: 'thread-1', inReplyTo: '<m1@gmail>', references: '<m1@gmail>',
    subject: 'Re: quick question about Invisalign', originalSubject: 'quick question about Invisalign',
  });
});

test('ordinary step 3 replies to the newest message in the same original thread', async () => {
  const activities = [
    activity('initial_email_sent', 'm1', '2026-08-01T10:00:00Z', 'quick question about implants'),
    activity('follow_up_sent', 'm2', '2026-08-04T10:00:00Z', 'Re: quick question about implants'),
  ];
  const gmail = { users: { messages: { get: async ({ id }) => {
    assert.equal(id, 'm2');
    return { data: message('m2', 'Re: quick question about implants', 'thread-1', '<m2@gmail>', 2, '<m1@gmail>') };
  } } } };
  const result = await resolveColdFollowUpThread({ gmail, lead: { id: 'lead-1', email: 'owner@cooperdental.example' }, activities });
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.inReplyTo, '<m2@gmail>');
  assert.equal(result.references, '<m1@gmail> <m2@gmail>');
  assert.equal(result.subject, 'Re: quick question about implants');
});

test('cold follow-up resolution fails closed for missing, conflicting, or cross-lead thread evidence', async () => {
  const gmail = { users: { messages: { get: async () => ({ data: message('m1', 'quick question about Invisalign', 'thread-1', '<m1@gmail>', 1) }) } } };
  const lead = { id: 'lead-1', email: 'owner@cooperdental.example' };
  assert.equal(await resolveColdFollowUpThread({ gmail, lead, activities: [] }), null);
  const conflicting = [
    activity('initial_email_sent', 'm1', '2026-08-01T10:00:00Z', 'quick question about Invisalign'),
    activity('follow_up_sent', 'm2', '2026-08-04T10:00:00Z', 'Re: quick question about Invisalign', 'thread-2'),
  ];
  assert.equal(await resolveColdFollowUpThread({ gmail, lead, activities: conflicting }), null);
  const crossLead = [
    activity('initial_email_sent', 'm1', '2026-08-01T10:00:00Z', 'quick question about Invisalign'),
    activity('initial_email_sent', 'other', '2026-08-01T11:00:00Z', 'quick question about implants', 'thread-1', 'lead-2'),
  ];
  assert.equal(await resolveColdFollowUpThread({ gmail, lead, activities: crossLead }), null);
});

test('ordinary follow-up send paths use real Gmail reply headers and no independent subjects', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const ordinary = agent.slice(agent.indexOf('// ── Follow-ups (steps 2 & 3)'), agent.indexOf("console.log(`\\nDone."));
  assert.match(ordinary, /resolveColdFollowUpThread/);
  assert.match(ordinary, /threadId: thread\.threadId, inReplyTo: thread\.inReplyTo, references: thread\.references/g);
  assert.doesNotMatch(ordinary, /Re: a quick demo I built|Last note —/);
  assert.match(agent, /runReplyCheckPass\(all[\s\S]*runHumanOutboundPass|runHumanOutboundPass[\s\S]*selectFollowUps/);
});

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
