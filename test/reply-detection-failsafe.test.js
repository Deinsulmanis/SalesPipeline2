'use strict';

// Fail-safe inbound reply detection.
//
// Two production messages arrived in Gmail and were either misclassified
// (We Smile: "Please remove us from your mailing list" → needs_human) or
// classified correctly but never applied to CRM (MapleLeaf: "Not interested"
// persisted as negative_reply while emailStatus stayed emailed). These tests
// lock the stop-the-bleeding contract: deterministic phrases, no cursor
// advance on Gmail quota, recovery classification, no duplicate events, and
// terminal CRM mutations that stop every future send.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyReplyText, REPLY_STATE, hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase,
} = require('../integrations/canonical-reply');
const {
  deterministicReplyCategory, classifyReply, failSafeReplyCategory,
} = require('../integrations/reply-classifier');
const {
  observeMailbox, listChangedIds, isRateLimited, byIdAscending,
} = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');
const { sendSuppressionReason } = require('../integrations/pipeline-state');
const { sequenceStopReason } = require('../integrations/stage-sequences');
const { observerHealth } = require('../integrations/gmail-observer-health');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));

const WE_SMILE = 'Please remove us from your mailing list.';
const MAPLELEAF = 'Not interested';
const SENDER = 'sender@example.com';
const NOW = new Date('2026-09-17T18:00:00Z');
const LAST = '2026-09-17T16:00:00Z';
const lead = {
  id: 'l1', email: 'prospect@example.com', company: 'Clinic', emailStatus: 'emailed',
  emailStep: '3', senderInboxId: 'primary', lastEmailedAt: '2026-09-17T15:00:00Z', notes: '',
};

const message = (id, from, text, at = '2026-09-17T16:03:00Z') => ({
  id, threadId: 't-' + id, internalDate: String(Date.parse(at)), labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'To', value: SENDER },
    { name: 'Subject', value: 'Re: question' }, { name: 'Message-ID', value: `<${id}@t>` }],
  body: { data: Buffer.from(text).toString('base64url') } },
});
const quota = () => Object.assign(new Error(
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),
{ response: { status: 403 } });

function mailbox(messages, { failOn = null, historyFail = false, historyPages = null, startHistoryId = '100' } = {}) {
  const reads = [];
  let historyCalls = 0;
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '200', emailAddress: SENDER } }),
    history: { list: async p => {
      historyCalls++;
      if (historyFail) throw quota();
      if (Array.isArray(historyPages)) {
        const page = historyPages[p.pageToken ? 1 : 0] || historyPages[0];
        if (page.error) throw quota();
        return { data: page };
      }
      return { data: { historyId: '200', history: messages.map(m => ({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })) } };
    } },
    messages: {
      list: async () => ({ data: { messages: messages.map(m => ({ id: m.id, threadId: m.threadId })) } }),
      get: async p => {
        reads.push(p.id);
        if (failOn && p.id === failOn) throw quota();
        return { data: messages.find(m => m.id === p.id) };
      },
    },
    threads: { get: async () => ({ data: { messages } }) },
  } };
  return { gmail, reads, historyCalls, startHistoryId };
}

const base = gmail => ({
  gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER,
  historyId: '100', lastSuccessfulObservationAt: LAST, now: NOW, sleep: async () => {},
});

// 1. explicit unsubscribe is detected deterministically
test('1. "Please remove us from your mailing list" is a deterministic unsubscribe', () => {
  const result = classifyReplyText(WE_SMILE);
  assert.equal(result.state, REPLY_STATE.NEGATIVE);
  assert.equal(result.reason, 'unsubscribe_request');
  assert.equal(result.confidence, 'high');
  assert.equal(deterministicReplyCategory(WE_SMILE), 'UNSUBSCRIBE');
  assert.equal(failSafeReplyCategory(WE_SMILE), 'UNSUBSCRIBE');
  assert.equal(hasExplicitUnsubscribePhrase(WE_SMILE), true);
});

test('1b. unsubscribe still wins when the model would have guessed needs_human', async () => {
  const category = await classifyReply({
    plainTextReply: WE_SMILE + ' Thank you.',
    createMessage: async () => ({ content: [{ text: 'NEEDS_HUMAN' }] }),
  });
  assert.equal(category, 'UNSUBSCRIBE');
});

test('1c. unsubscribe still wins when the model throws', async () => {
  const category = await classifyReply({
    plainTextReply: 'Please remove us from your mailing list. Thank you.',
    createMessage: async () => { throw new Error('haiku unavailable'); },
  });
  assert.equal(category, 'UNSUBSCRIBE');
});

// 2. "not interested" is detected deterministically
test('2. "Not interested" is a deterministic negative without a model', async () => {
  const result = classifyReplyText(MAPLELEAF);
  assert.equal(result.state, REPLY_STATE.NEGATIVE);
  assert.equal(result.reason, 'explicit_rejection');
  assert.equal(deterministicReplyCategory(MAPLELEAF), 'NOT_INTERESTED');
  assert.equal(failSafeReplyCategory(MAPLELEAF), 'NOT_INTERESTED');
  assert.equal(hasExplicitNegativePhrase(MAPLELEAF), true);
  const category = await classifyReply({
    plainTextReply: MAPLELEAF,
    createMessage: async () => ({ content: [{ text: 'NEEDS_HUMAN' }] }),
  });
  assert.equal(category, 'NOT_INTERESTED');
});

test('2b. buying intent still outranks a coincidental "not interested"', () => {
  const mixed = classifyReplyText('Not interested in AI hype, but send me your pricing anyway.');
  assert.equal(mixed.state, REPLY_STATE.POSITIVE);
  assert.equal(hasExplicitNegativePhrase('Not interested in AI hype, but send me your pricing anyway.'), false);
});

// 3. rate-limit failure does not advance Gmail history cursor
test('3. a 403 on users.history.list does not return a new history cursor', async () => {
  const { gmail } = mailbox([], { historyFail: true });
  await assert.rejects(
    () => observeMailbox(base(gmail)),
    error => {
      assert.equal(isRateLimited(error), true);
      assert.equal(error.observerDetails?.action, 'users.history.list');
      return /Quota exceeded|quota|rate/i.test(String(error.message));
    });
});

test('3b. a partial history listing never adopts HEAD', async () => {
  await assert.rejects(
    () => listChangedIds({ users: { history: { list: async () => ({ data: { historyId: '999', nextPageToken: 'more', history: [] } }) } } },
      { historyId: '100', maxPages: 1, sleep: async () => {} }),
    /checkpoint was not advanced/);
});

test('3c. incremental quota keeps the START historyId, not HEAD', async () => {
  const first = message('r1', lead.email, MAPLELEAF);
  const second = message('r2', lead.email, WE_SMILE, '2026-09-17T16:10:00Z');
  const ordered = ['r1', 'r2'].sort(byIdAscending);
  const { gmail } = mailbox([first, second], { failOn: ordered[1] });
  const observed = await observeMailbox({ ...base(gmail), lastSuccessfulObservationAt: NOW.toISOString() });
  assert.equal(observed.historyIncomplete, true);
  assert.equal(observed.trustworthy, false);
  assert.equal(observed.observerHealth, 'unhealthy_quota');
  assert.equal(observed.nextHistoryId, '100', 'cursor stays at the start of the unread window');
  assert.ok(observed.quotaBackoff);
});

// 4. retry/catch-up reprocesses the missed message
test('4. the next pass retries the message that quota interrupted', async () => {
  const first = message('r1', lead.email, MAPLELEAF);
  const second = message('r2', lead.email, WE_SMILE, '2026-09-17T16:10:00Z');
  const ordered = ['r1', 'r2'].sort(byIdAscending);
  const interrupted = mailbox([first, second], { failOn: ordered[1] });
  const observed = await observeMailbox({ ...base(interrupted.gmail), lastSuccessfulObservationAt: NOW.toISOString() });
  assert.equal(observed.historyIncomplete, true);

  const retry = mailbox([first, second]);
  const again = await observeMailbox({ ...base(retry.gmail), lastSuccessfulObservationAt: NOW.toISOString() });
  assert.equal(again.historyIncomplete, false);
  assert.equal(again.trustworthy, true);
  assert.ok(retry.reads.includes(ordered[0]));
  assert.ok(retry.reads.includes(ordered[1]), 'the previously unread id is fetched on retry');
});

// 5. recovery messages pass through normal reply classification
test('5. a recovered unsubscribe is classified the same way as a live history event', async () => {
  const recovered = message('u1', lead.email, WE_SMILE);
  const { gmail } = mailbox([recovered]);
  const observation = await observeMailbox({
    ...base(gmail), historyId: 'STALE',
    gmail: {
      ...gmail,
      users: {
        ...gmail.users,
        history: { list: async p => {
          if (p.startHistoryId === 'STALE') {
            const error = new Error('Requested entity was not found.');
            error.response = { status: 404 };
            throw error;
          }
          return { data: { historyId: '200', history: [] } };
        } },
      },
    },
  });
  assert.equal(observation.mode, 'catchup');
  assert.equal(observation.recovered, true);
  const plan = await planMailboxEvents({ ...base(gmail), gmail, observation });
  const event = plan.events.find(row => row.sourceLeadId === lead.id);
  assert.equal(event.eventType, 'unsubscribe_reply');
  assert.equal(JSON.parse(event.metadata).reason, 'unsubscribe_request');
  assert.equal(JSON.parse(event.metadata).autoSendAllowed, false);
  assert.deepEqual(plan.suppressions.map(item => item.reason), ['unsubscribe']);
  assert.equal(plan.replies[0].canonical.reason, 'unsubscribe_request');
});

test('5b. a recovered "Not interested" is classified as explicit_rejection', async () => {
  const recovered = message('n1', lead.email, MAPLELEAF);
  const { gmail } = mailbox([recovered]);
  const observation = await observeMailbox({
    ...base(gmail), historyId: 'STALE',
    gmail: {
      ...gmail,
      users: {
        ...gmail.users,
        history: { list: async p => {
          if (p.startHistoryId === 'STALE') {
            const error = new Error('Requested entity was not found.');
            error.response = { status: 404 };
            throw error;
          }
          return { data: { historyId: '200', history: [] } };
        } },
      },
    },
  });
  const plan = await planMailboxEvents({ ...base(gmail), gmail, observation });
  const event = plan.events.find(row => row.sourceLeadId === lead.id);
  assert.equal(event.eventType, 'negative_reply');
  assert.equal(JSON.parse(event.metadata).reason, 'explicit_rejection');
  assert.equal(plan.replies[0].canonical.state, REPLY_STATE.NEGATIVE);
});

// 6. duplicate recovery does not duplicate timeline events
test('6. re-observing the same Gmail message writes no second event', async () => {
  const recovered = message('u1', lead.email, WE_SMILE);
  const { gmail, input } = (() => {
    const boxed = mailbox([recovered]);
    return { gmail: boxed.gmail, input: base(boxed.gmail) };
  })();
  const observation = await observeMailbox({ ...input, lastSuccessfulObservationAt: NOW.toISOString() });
  const first = await planMailboxEvents({ ...input, gmail, observation });
  assert.equal(first.events.filter(row => row.eventType === 'unsubscribe_reply').length, 1);
  const again = await planMailboxEvents({ ...input, gmail, observation, activities: first.events });
  assert.equal(again.events.filter(row => /reply/.test(row.eventType)).length, 0);
  assert.equal(again.replies.length, 1, 'terminal replies are re-queued for CRM mutation');
  assert.equal(again.replies[0].alreadyRecorded, true);
});

test('6b. commitObservation is idempotent across a crash-before-checkpoint', async () => {
  const recovered = message('u1', lead.email, WE_SMILE);
  const { gmail } = mailbox([recovered]);
  const observation = await observeMailbox({ ...base(gmail), lastSuccessfulObservationAt: NOW.toISOString() });
  const plan = await planMailboxEvents({ ...base(gmail), gmail, observation });
  const activities = [];
  let checkpoints = 0;
  await commitObservation({
    observation, plan, activities, suppress: async () => {},
    appendEvent: async () => {},
    checkpoint: async () => { checkpoints++; },
  });
  assert.equal(checkpoints, 1);
  const retry = await planMailboxEvents({ ...base(gmail), gmail, observation, activities });
  await commitObservation({
    observation, plan: retry, activities, suppress: async () => {},
    appendEvent: async () => { throw new Error('must not append a duplicate'); },
    checkpoint: async () => { checkpoints++; },
  });
  assert.equal(activities.filter(row => row.eventId === 'gmail-reply:u1').length, 1);
});

// 7. unsubscribe suppresses all future provider sends
test('7. unsubscribe notes and the durable list both block every send path', () => {
  const unsubbed = { ...lead, stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed]' };
  assert.match(sendSuppressionReason(unsubbed, { suppressedEmails: new Set() }) || '', /Unsubscribed/);
  assert.match(
    sendSuppressionReason({ ...lead, notes: '' }, { suppressedEmails: new Set([lead.email]) }) || '',
    /suppression-list/);
  const stop = sequenceStopReason({
    boardLead: { stage: 'follow_up' }, twin: unsubbed, activities: [],
    suppressedEmails: new Set(), enrolledAt: '2026-09-01T00:00:00Z',
  });
  assert.match(stop, /Unsubscribed|suppressed/);
  assert.match(agentSrc, /await addSuppression\(lead\.email, 'unsubscribe'/);
  const unsubHandler = agentSrc.slice(agentSrc.indexOf('async function handleUnsubscribe'),
    agentSrc.indexOf('async function handleOutOfOffice'));
  assert.match(unsubHandler, /stage: 'Unsub'/);
  assert.match(unsubHandler, /emailStatus: 'done'/);
});

// 8. negative reply stops sequence sends
test('8. a Not Interested reply stops cold follow-ups and stage sequences', () => {
  const done = { ...lead, stage: 'Done', emailStatus: 'done', notes: '[REPLY: Not Interested]' };
  const selector = agentSrc.slice(agentSrc.indexOf('function selectFollowUps'), agentSrc.indexOf('function countTodaySends'));
  assert.match(selector, /emailStatus !== 'emailed'/);
  assert.equal(done.emailStatus !== 'emailed', true);
  const stop = sequenceStopReason({
    boardLead: { stage: 'follow_up' }, twin: done,
    activities: [{ eventType: 'negative_reply', occurredAt: '2026-09-17T16:03:00Z' }],
    suppressedEmails: new Set(), enrolledAt: '2026-09-01T00:00:00Z',
  });
  assert.equal(stop, 'suppressed ([REPLY: Not Interested])');
  const handler = agentSrc.slice(agentSrc.indexOf('async function handleNotInterested'),
    agentSrc.indexOf('async function handleUnsubscribe'));
  assert.match(handler, /stage: 'Done'/);
  assert.match(handler, /emailStatus: 'done'/);
  assert.match(handler, /\[REPLY: Not Interested\]/);
});

// 9. Gmail observer remains fail-closed on incomplete history reads
test('9. an incomplete incremental read is unhealthy and does not advance the checkpoint', async () => {
  const first = message('r1', lead.email, MAPLELEAF);
  const second = message('r2', lead.email, WE_SMILE, '2026-09-17T16:10:00Z');
  const ordered = ['r1', 'r2'].sort(byIdAscending);
  const { gmail } = mailbox([first, second], { failOn: ordered[1] });
  const observed = await observeMailbox({ ...base(gmail), lastSuccessfulObservationAt: NOW.toISOString() });
  assert.equal(observed.trustworthy, false);
  assert.equal(observed.historyIncomplete, true);
  assert.equal(observed.nextHistoryId, '100');

  const pass = agentSrc.slice(agentSrc.indexOf('async function runReplyCheckPass'),
    agentSrc.indexOf('async function commitMailboxObservationCheckpoints'));
  assert.match(pass, /historyIncomplete/);
  assert.match(pass, /incomplete Gmail history read; quota exhausted; cursor not advanced/);
  assert.match(pass, /observerHealth/);

  const rows = [[], ['primary', '100', LAST, NOW.toISOString(),
    'incomplete Gmail history read; quota exhausted; cursor not advanced', 'unavailable', 'history_incomplete']];
  const health = observerHealth(rows, { senderIds: ['primary'], now: NOW })[0];
  assert.equal(health.health, 'unavailable');
  assert.equal(health.quotaBackoff, true);
});

test('9b. a truncated History listing still fails closed', async () => {
  await assert.rejects(
    () => observeMailbox({
      ...base({ users: {
        history: { list: async () => ({ data: { historyId: '102', nextPageToken: 'more', history: [] } }) },
        messages: { get: async () => { throw new Error('not reached'); } },
      } }),
      maxPages: 1,
    }),
    /checkpoint was not advanced/);
});

// 10. existing send-lock and staffing safety tests remain green — asserted here
// as the invariants this change must not relax, plus the dedicated test files.
test('10. send-lock and staffing safety invariants are untouched', () => {
  const sendLock = readSource(path.join(root, 'integrations', 'send-lock.js'));
  assert.match(sendLock, /withGmailProviderSend|withOutboundReservation/);
  const staffing = readSource(path.join(root, 'integrations', 'staffing-launch-gate.js'));
  assert.match(staffing, /staffingSendBlockReason|assertStaffingSendAllowed/);
  const pass = agentSrc.slice(agentSrc.indexOf('async function runReplyCheckPass'),
    agentSrc.indexOf('async function commitMailboxObservationCheckpoints'));
  assert.match(pass, /const maySend\s*=\s*!CHECK_ONLY && !historical/);
  assert.match(agentSrc, /if \(CHECK_ONLY\) \{/);
  const question = agentSrc.slice(agentSrc.indexOf('async function handleQuestion'),
    agentSrc.indexOf('async function handleNeedsHuman'));
  assert.match(question, /CHECK_ONLY is observation-only and cannot send/);
  const observer = readSource(path.join(root, 'integrations', 'gmail-mailbox-observer.js'));
  const planner = readSource(path.join(root, 'integrations', 'mailbox-observation-events.js'));
  for (const source of [observer, planner]) {
    for (const forbidden of ['messages.send', 'sendEmail', 'nodemailer']) {
      assert.ok(!source.includes(forbidden), `${forbidden} must not appear in observation`);
    }
  }
});
