'use strict';

// Multi-reply conversations — the P0 for a conversational sales agent.
//
// THE BUG THIS LOCKS OUT
//
// runReplyCheckPass selected candidates with
//
//   leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email))
//
// and the same pass moves a lead OFF 'emailed' onto 'replied' the moment it
// answers. So the first prospect reply permanently removed that lead from
// mailbox observation. A real pre-booking conversation —
//
//   "Interested" → answer → "How much?" → answer → "Send me your calendar"
//
// died after the first message: everything the prospect said afterwards was
// invisible to the CRM.
//
// THE CORRECT RULE, asserted below: deduplicate individual Gmail MESSAGES,
// never ignore a lead because it once replied. Observation candidacy keys off
// "has this lead been emailed at all", and canonical identity is
// gmail-reply:<messageId>, so message 2 and message 3 are new events while a
// re-observed message 1 is not.
//
// Nothing here touches Google or the network; the Gmail client is a fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { observeMailbox } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const plannerSrc = readSource(path.join(root, 'integrations', 'mailbox-observation-events.js'));

const SENDER = 'sender@example.com';
const NOW = new Date('2026-09-09T04:00:00Z');

// A lead that has ALREADY replied once: emailStatus 'replied' is exactly the
// state the old selector excluded.
const repliedLead = {
  id: 'l1', email: 'prospect@example.com', company: 'Clinic',
  emailStatus: 'replied', emailStep: '1', senderInboxId: 'primary',
  lastEmailedAt: '2026-09-01T00:00:00Z', notes: '',
};

const message = (id, from, text, { sent = false, at = '2026-09-08T18:00:00Z', thread = 't1' } = {}) => ({
  id, threadId: thread, internalDate: String(Date.parse(at)),
  labelIds: sent ? ['SENT'] : ['INBOX'],
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: sent ? repliedLead.email : SENDER },
      { name: 'Subject', value: 'Re: a quick demo' },
      { name: 'Message-ID', value: `<${id}@test>` },
    ],
    body: { data: Buffer.from(text).toString('base64url') },
  },
});

// Incremental History mode — the healthy steady state a live conversation runs
// in, not the outage path the recovery suite covers.
function fixture(messages, { threadMessages = null } = {}) {
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '300', emailAddress: SENDER } }),
    history: { list: async () => ({ data: { historyId: '301',
      history: messages.map(m => ({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })) } }) },
    messages: {
      list: async () => ({ data: { messages: messages.map(m => ({ id: m.id, threadId: m.threadId })) } }),
      get: async p => ({ data: messages.find(m => m.id === p.id) }),
    },
    threads: { get: async () => ({ data: { messages: threadMessages || messages } }) },
  } };
  return { gmail, input: {
    gmail, leads: [repliedLead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, historyId: '300', lastSuccessfulObservationAt: '2026-09-09T03:00:00Z', now: NOW,
  } };
}

const replyEvents = plan => plan.events.filter(event => /reply|meeting_requested/.test(event.eventType));

// ── 1. The regression itself ────────────────────────────────────────────────

test('1. an already-replied lead is still observed for new inbound', async () => {
  // The selector must not key off emailStatus, because the reply pass itself
  // sets it to 'replied'.
  const selector = agentSrc.slice(agentSrc.indexOf('async function runReplyCheckPass'),
    agentSrc.indexOf('async function runReplyCheckPass') + 400);
  assert.match(selector, /leads\.filter\(l => isValidEmail\(l\.email\) && \(l\.lastEmailedAt \|\| Number\(l\.emailStep\) > 0\)\)/);
  assert.ok(!/emailStatus === 'emailed'/.test(selector),
    'candidacy must not exclude a lead that already replied');
  // And every CRM identity is offered to the mailbox, not just leads pinned to
  // this sender — an already-replied lead can write again.
  assert.match(agentSrc, /an already-replied lead can write again/);

  const { gmail, input } = fixture([message('m2', repliedLead.email, 'How much does it cost?')]);
  const observation = await observeMailbox(input);
  const plan = await planMailboxEvents({ ...input, gmail, observation });
  assert.equal(replyEvents(plan).length, 1, 'a second reply from a replied lead is still ingested');
});

// ── 2–6. A whole conversation ───────────────────────────────────────────────

test('2/3/4/5/6. each prospect message becomes its own canonical event, once', async () => {
  const first = message('m1', repliedLead.email, 'Yes, I am interested', { at: '2026-09-08T15:00:00Z' });
  const ourAnswer = message('a1', SENDER, 'Great — happy to explain pricing.', { sent: true, at: '2026-09-08T15:30:00Z' });
  const second = message('m2', repliedLead.email, 'How much does it cost?', { at: '2026-09-08T16:00:00Z' });
  const third = message('m3', repliedLead.email, 'Send me your calendar please', { at: '2026-09-08T17:00:00Z' });
  const thread = [first, ourAnswer, second, third];

  // Pass 1: the first reply is observed.
  const one = fixture([first], { threadMessages: thread });
  const planOne = await planMailboxEvents({ ...one.input, gmail: one.gmail, observation: await observeMailbox(one.input) });
  assert.equal(replyEvents(planOne).length, 1);
  assert.equal(replyEvents(planOne)[0].eventId, 'gmail-reply:m1');

  // Pass 2: our automated answer is recorded as OUR message, not a reply, and
  // the prospect's second question is a NEW canonical event.
  const two = fixture([ourAnswer, second], { threadMessages: thread });
  const planTwo = await planMailboxEvents({
    ...two.input, gmail: two.gmail, activities: planOne.events,
    observation: await observeMailbox(two.input),
  });
  assert.ok(planTwo.events.some(event => event.eventType === 'human_response_sent'),
    'our outbound is recorded as an outbound');
  const secondReply = replyEvents(planTwo);
  assert.equal(secondReply.length, 1, 'the second prospect message is observed');
  assert.equal(secondReply[0].eventId, 'gmail-reply:m2');
  // The first reply is NOT re-emitted.
  assert.ok(!planTwo.events.some(event => event.eventId === 'gmail-reply:m1'),
    'an already-recorded message is never duplicated');

  // Pass 3: a third prospect message is observed too.
  const three = fixture([third], { threadMessages: thread });
  const planThree = await planMailboxEvents({
    ...three.input, gmail: three.gmail, activities: [...planOne.events, ...planTwo.events],
    observation: await observeMailbox(three.input),
  });
  assert.equal(replyEvents(planThree).length, 1);
  assert.equal(replyEvents(planThree)[0].eventId, 'gmail-reply:m3');

  // Three distinct prospect messages, three distinct canonical events.
  const ids = [...replyEvents(planOne), ...replyEvents(planTwo), ...replyEvents(planThree)].map(e => e.eventId);
  assert.deepEqual(ids, ['gmail-reply:m1', 'gmail-reply:m2', 'gmail-reply:m3']);
  assert.equal(new Set(ids).size, 3);
});

test('re-observing the whole thread produces nothing new', async () => {
  // The overlap window deliberately re-reads recent mail. Dedupe is per
  // MESSAGE, so a full re-scan of a settled conversation is a no-op.
  const messages = [
    message('m1', repliedLead.email, 'Interested', { at: '2026-09-08T15:00:00Z' }),
    message('m2', repliedLead.email, 'How much?', { at: '2026-09-08T16:00:00Z' }),
    message('m3', repliedLead.email, 'Send your calendar', { at: '2026-09-08T17:00:00Z' }),
  ];
  const { gmail, input } = fixture(messages, { threadMessages: messages });
  const observation = await observeMailbox(input);
  const first = await planMailboxEvents({ ...input, gmail, observation });
  assert.equal(replyEvents(first).length, 3);
  const again = await planMailboxEvents({ ...input, gmail, observation, activities: first.events });
  assert.equal(again.events.length, 0, 'a repeat scan writes nothing');
});

// ── 7–8. What stops the conversation ────────────────────────────────────────

test('7. a booked meeting stops pre-booking response automation', async () => {
  // Observation still INGESTS — the record must stay complete — but ownership
  // hands the lead to the meeting, so no pre-booking automation may execute.
  const { OWNER, deriveAutomationOwnership, mayColdSend, maySequenceSend, executableOwners } =
    require('../integrations/automation-ownership');
  const booked = deriveAutomationOwnership(
    { ...repliedLead, notes: '' },
    {
      boardLead: { stage: 'call_booked', email: repliedLead.email },
      activities: [], suppressionReason: () => null,
      callState: { status: 'scheduled', meetingAt: '2026-09-20T17:00:00.000Z' },
      sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
    });
  assert.equal(booked.owner, OWNER.MEETING);
  assert.equal(mayColdSend(booked).allowed, false);
  assert.equal(maySequenceSend(booked).allowed, false);
  assert.equal(executableOwners(booked).length, 0);
});

test('8. a manual Deins outbound takes the conversation off automation', async () => {
  const { BLOCKED_BY, deriveAutomationOwnership, executableOwners } =
    require('../integrations/automation-ownership');
  // An observed manual reply that the CRM has not yet recorded fails closed.
  const unrecorded = deriveAutomationOwnership(repliedLead, {
    boardLead: { stage: 'hot', email: repliedLead.email },
    activities: [], suppressionReason: () => null, unrecordedHumanTouch: true,
    sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
  });
  assert.equal(unrecorded.blockedBy, BLOCKED_BY.UNRECORDED_HUMAN_TOUCH);
  assert.equal(executableOwners(unrecorded).length, 0);

  // And a prospect reply the human now owns likewise executes nothing.
  const humanOwned = deriveAutomationOwnership(repliedLead, {
    boardLead: { stage: 'hot', email: repliedLead.email },
    activities: [{ eventType: 'positive_reply', occurredAt: '2026-09-08T16:00:00Z',
      metadata: JSON.stringify({ canonicalState: 'positive' }) }],
    suppressionReason: () => null, sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
  });
  assert.equal(executableOwners(humanOwned).length, 0);
});

// ── The rule, stated structurally ───────────────────────────────────────────

test('dedupe is per Gmail message, never per lead', () => {
  // Canonical identity is the provider message id.
  assert.match(plannerSrc, /const eventId = `gmail-reply:\$\{message\.id\}`/);
  assert.match(plannerSrc, /activities\.some\(row => meta\(row\)\.gmailMessageId === message\.id/);
  // Nothing in the planner skips a lead for having replied before.
  const code = plannerSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/emailStatus\s*===\s*'replied'/.test(code));
  assert.ok(!/stage\s*===\s*'Replied'/.test(code));
  // The agent's own reply loop dedupes on the message id too.
  assert.match(agentSrc, /activities\.some\(row => row\.eventId === `gmail-reply:\$\{message\.messageId\}`\)/);
});
