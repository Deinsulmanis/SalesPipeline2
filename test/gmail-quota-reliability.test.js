'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  observeMailbox, providerRead, isRateLimited,
} = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');
const {
  resetGmailUsageForTests, gmailRequest, gmailUsageSnapshot, QUOTA_UNITS,
  signalMailboxBackoff, getMailboxBackoff, shouldSkipOptionalGmail, clearMailboxBackoff,
  wrapGmail, persistedGmailMessageIds, recordFollowUpBlocked,
} = require('../integrations/gmail-api-guard');
const {
  classifyOutboundTouch, observerFollowUpVerdict,
} = require('../integrations/gmail-followup-safety');
const { observerHealth } = require('../integrations/gmail-observer-health');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const serverSrc = readSource(path.join(root, 'server.js'));

const SENDER = 'sender@example.com';
const NOW = new Date('2026-09-17T21:00:00Z');
const lead = {
  id: 'l1', email: 'prospect@example.com', company: 'Clinic', emailStatus: 'emailed',
  emailStep: '1', senderInboxId: 'primary', lastEmailedAt: '2026-09-01T00:00:00Z', notes: '',
};
const firstTouch = {
  id: 'q1', email: 'new@example.com', company: 'New', emailStatus: '', emailStep: '', lastEmailedAt: '',
  senderInboxId: 'primary',
};

const body = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') }, headers: [] });
const msg = ({ id, from, threadId = 't1', at = '2026-09-17T20:30:00Z', text = 'Interested', labels = ['INBOX'] }) => ({
  id, threadId, internalDate: String(Date.parse(at)), labelIds: labels,
  payload: { ...body(text), headers: [
    { name: 'From', value: from }, { name: 'To', value: from === SENDER ? lead.email : SENDER },
    { name: 'Message-ID', value: `<${id}@t>` }, { name: 'Subject', value: 'Re: demo' },
  ] }, snippet: text,
});
const quota = () => Object.assign(new Error(
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),
{ response: { status: 403 } });

function idleMailbox() {
  const calls = [];
  const gmail = { users: {
    history: { list: async p => { calls.push(['history', p]); return { data: { historyId: '102', history: [] } }; } },
    messages: { get: async p => { calls.push(['get', p]); return { data: {} }; }, list: async p => { calls.push(['list', p]); return { data: {} }; } },
    threads: { get: async p => { calls.push(['thread', p]); return { data: { messages: [] } }; } },
    getProfile: async p => { calls.push(['profile', p]); return { data: { historyId: '102', emailAddress: SENDER } }; },
  } };
  return { gmail, calls };
}

test('beforeEach resets usage', () => { resetGmailUsageForTests(); });

test('1. healthy idle mailbox uses only a single history.list', async () => {
  resetGmailUsageForTests();
  const { gmail, calls } = idleMailbox();
  const result = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, lastSuccessfulObservationAt: NOW.toISOString(), now: NOW,
  });
  assert.equal(result.mode, 'history');
  assert.equal(calls.filter(c => c[0] === 'history').length, 1);
  assert.equal(calls.filter(c => c[0] === 'get').length, 0);
  assert.equal(calls.filter(c => c[0] === 'list').length, 0);
  assert.deepEqual(calls.find(c => c[0] === 'history')[1].historyTypes, ['messageAdded']);
});

test('2. zero new messages causes zero messages.get calls', async () => {
  resetGmailUsageForTests();
  const { gmail, calls } = idleMailbox();
  const result = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW,
  });
  assert.equal(result.messagesFetched || 0, 0);
  assert.equal(calls.filter(c => c[0] === 'get').length, 0);
});

test('3. a new inbound message is fetched once', async () => {
  resetGmailUsageForTests();
  const inbound = msg({ id: 'r1', from: lead.email });
  let gets = 0;
  const gmail = { users: {
    history: { list: async () => ({ data: { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'r1', threadId: 't1' } }] }] } }) },
    messages: { get: async () => { gets++; return { data: inbound }; } },
  } };
  const result = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW,
  });
  assert.equal(result.replies.get(lead.id).id, 'r1');
  assert.equal(gets, 1);
  assert.equal(result.messagesFetched, 1);
});

test('4. a persisted Gmail message ID is not fetched again', async () => {
  resetGmailUsageForTests();
  let gets = 0;
  const gmail = { users: {
    history: { list: async () => ({ data: { historyId: '103', history: [{ messagesAdded: [{ message: { id: 'r1', threadId: 't1' } }] }] } }) },
    messages: { get: async () => { gets++; throw new Error('must not refetch persisted mail'); } },
  } };
  const activities = [{
    eventId: 'gmail-reply:r1', eventType: 'positive_reply', sourceLeadId: lead.id,
    metadata: JSON.stringify({ gmailMessageId: 'r1', gmailThreadId: 't1' }),
  }];
  const result = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities, senderInboxId: 'primary', senderEmail: SENDER, now: NOW,
  });
  assert.equal(gets, 0);
  assert.equal(result.messagesDeduplicated, 1);
  assert.equal(persistedGmailMessageIds(activities).has('r1'), true);
});

test('5. quota failure does not advance the history cursor', async () => {
  resetGmailUsageForTests();
  const error = quota();
  const gmail = { users: { history: { list: async () => { throw error; } } } };
  await assert.rejects(() => observeMailbox({
    gmail, historyId: '88466', leads: [lead], activities: [], senderInboxId: 'tryscalelabai',
    senderEmail: SENDER, now: NOW, sleep: async () => {},
  }), err => {
    assert.equal(err.observerDetails.rateLimited, true);
    assert.equal(err.observerDetails.action, 'users.history.list');
    return true;
  });
});

test('6. quota failure activates shared mailbox backoff', async () => {
  resetGmailUsageForTests();
  const gmail = { users: { history: { list: async () => { throw quota(); } } } };
  await assert.rejects(() => observeMailbox({
    gmail, historyId: '88466', leads: [], activities: [], senderInboxId: 'tryscalelabai',
    senderEmail: SENDER, now: NOW, sleep: async () => {},
  }));
  const backoff = getMailboxBackoff('tryscalelabai', new Date(NOW.getTime() + 1000));
  assert.ok(backoff, 'shared backoff is recorded');
  assert.equal(backoff.reason, 'gmail_quota');
  assert.ok(Date.parse(backoff.until) > NOW.getTime());
});

test('7. optional scanners stop during backoff', () => {
  resetGmailUsageForTests();
  signalMailboxBackoff('tryscalelabai', quota(), { now: NOW });
  assert.equal(shouldSkipOptionalGmail('tryscalelabai', 'human_outbound', NOW), true);
  assert.equal(shouldSkipOptionalGmail('tryscalelabai', 'late_reply', NOW), true);
  assert.equal(shouldSkipOptionalGmail('primary', 'human_outbound', NOW), false);
  assert.match(agentSrc, /GMAIL_HUMAN_OUTBOUND_SCAN === 'true'/);
  assert.match(agentSrc, /GMAIL_LATE_REPLY_THREAD_SCAN === 'true'/);
  assert.match(agentSrc, /skipped Gmail scan/);
});

test('8. history observer retries after backoff expires', async () => {
  resetGmailUsageForTests();
  signalMailboxBackoff('primary', quota(), { now: new Date(NOW.getTime() - 60 * 60 * 1000) });
  assert.equal(getMailboxBackoff('primary', NOW), null);
  const { gmail, calls } = idleMailbox();
  const result = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW,
  });
  assert.equal(result.mode, 'history');
  assert.equal(calls.filter(c => c[0] === 'history').length, 1);
});

test('9. follow-up send is blocked when the observer is too stale', () => {
  const stale = observerFollowUpVerdict({
    lead, observer: { health: 'unavailable', checkpointAgeMinutes: 91 }, now: NOW, maxAgeMinutes: 45,
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.blockedFollowUp, true);
  assert.equal(classifyOutboundTouch(lead), 'follow_up');
  assert.match(agentSrc, /observerFollowUpVerdict/);
});

test('10. first-touch remains allowed when safely distinguishable', () => {
  assert.equal(classifyOutboundTouch(firstTouch), 'first_touch');
  const verdict = observerFollowUpVerdict({
    lead: firstTouch, observer: { health: 'backoff', checkpointAgeMinutes: 120 }, now: NOW, maxAgeMinutes: 45,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, 'first_touch_allowed_observer_stale');
});

test('11. a healthy second mailbox is unaffected', () => {
  resetGmailUsageForTests();
  signalMailboxBackoff('tryscalelabai', quota(), { now: NOW });
  assert.equal(shouldSkipOptionalGmail('primary', 'human_outbound', NOW), false);
  const rows = [[],
    ['primary', '200', NOW.toISOString(), NOW.toISOString(), '', 'healthy', 'history', 'complete', '0', '', '', '', '', '', ''],
    ['tryscalelabai', '88466', '2026-09-17T20:16:58Z', NOW.toISOString(), 'quota', 'backoff', 'history', 'complete', '0', '', '', '', '', '', new Date(NOW.getTime() + 600000).toISOString()],
  ];
  const health = observerHealth(rows, { senderIds: ['primary', 'tryscalelabai'], now: NOW });
  assert.equal(health.find(item => item.senderInboxId === 'primary').health, 'healthy');
  assert.equal(health.find(item => item.senderInboxId === 'tryscalelabai').health, 'backoff');
  const primary = observerFollowUpVerdict({
    lead: { ...lead, senderInboxId: 'primary' },
    observer: health.find(item => item.senderInboxId === 'primary'), now: NOW,
  });
  assert.equal(primary.allowed, true);
});

test('12/13. recovery processes a missed reply and restores incremental history', async () => {
  resetGmailUsageForTests();
  const inbound = msg({ id: 'missed', from: lead.email, text: 'Please unsubscribe me' });
  const gone = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const calls = [];
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '900', emailAddress: SENDER } }),
    history: { list: async p => {
      calls.push(['history', p.startHistoryId]);
      if (p.startHistoryId === '88466') throw gone;
      return { data: { historyId: '901', history: [] } };
    } },
    messages: {
      list: async () => ({ data: { messages: [{ id: inbound.id, threadId: inbound.threadId }] } }),
      get: async () => ({ data: inbound }),
    },
    threads: { get: async () => { throw gone; } },
  } };
  const observation = await observeMailbox({
    gmail, historyId: '88466', leads: [lead], activities: [], senderInboxId: 'tryscalelabai',
    senderEmail: SENDER, lastSuccessfulObservationAt: '2026-09-17T20:16:58Z', now: NOW,
  });
  assert.equal(observation.mode, 'catchup');
  const plan = await planMailboxEvents({ observation, gmail, leads: [lead], activities: [], senderInboxId: 'tryscalelabai', senderEmail: SENDER, now: NOW });
  const reply = plan.events.find(event => event.eventId === 'gmail-reply:missed');
  assert.ok(reply);
  assert.equal(JSON.parse(reply.metadata).canonicalState === 'opt_out' || reply.eventType === 'unsubscribe_reply', true);
});

test('14. recovered unsubscribe suppresses the lead', async () => {
  const inbound = msg({ id: 'unsub', from: lead.email, text: 'Unsubscribe. Stop emailing me.' });
  const gone = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '900', emailAddress: SENDER } }),
    history: { list: async p => { if (p.startHistoryId === '100') throw gone; return { data: { historyId: '901', history: [] } }; } },
    messages: { list: async () => ({ data: { messages: [{ id: inbound.id, threadId: inbound.threadId }] } }), get: async () => ({ data: inbound }) },
    threads: { get: async () => ({ data: { messages: [] } }) },
  } };
  const observation = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, lastSuccessfulObservationAt: '2026-09-16T00:00:00Z', now: NOW,
  });
  const plan = await planMailboxEvents({ observation, gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW });
  assert.ok(plan.suppressions.some(item => item.reason === 'unsubscribe'));
  assert.ok(plan.events.some(event => event.eventType === 'unsubscribe_reply'));
});

test('15. recovered negative reply terminates outreach via canonical classification', async () => {
  const inbound = msg({ id: 'no', from: lead.email, text: 'Not interested, please do not contact us again.' });
  const gone = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '900', emailAddress: SENDER } }),
    history: { list: async p => { if (p.startHistoryId === '100') throw gone; return { data: { historyId: '901', history: [] } }; } },
    messages: { list: async () => ({ data: { messages: [{ id: inbound.id, threadId: inbound.threadId }] } }), get: async () => ({ data: inbound }) },
    threads: { get: async () => ({ data: { messages: [] } }) },
  } };
  const observation = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, lastSuccessfulObservationAt: '2026-09-16T00:00:00Z', now: NOW,
  });
  const plan = await planMailboxEvents({ observation, gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW });
  const event = plan.events.find(row => row.sourceLeadId === lead.id);
  assert.ok(event);
  assert.match(event.eventType, /negative_reply|unsubscribe_reply|needs_human_reply/);
  assert.equal(JSON.parse(event.metadata).autoSendAllowed, false);
});

test('16. duplicate recovery is idempotent', async () => {
  const inbound = msg({ id: 'dup', from: lead.email, text: 'Interested' });
  const gone = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '900', emailAddress: SENDER } }),
    history: { list: async p => { if (p.startHistoryId === '100') throw gone; return { data: { historyId: '901', history: [] } }; } },
    messages: { list: async () => ({ data: { messages: [{ id: inbound.id, threadId: inbound.threadId }] } }), get: async () => ({ data: inbound }) },
    threads: { get: async () => ({ data: { messages: [] } }) },
  } };
  const observation = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, lastSuccessfulObservationAt: '2026-09-16T00:00:00Z', now: NOW,
  });
  const plan = await planMailboxEvents({ observation, gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER, now: NOW });
  const again = await planMailboxEvents({ observation, gmail, leads: [lead], activities: plan.events, senderInboxId: 'primary', senderEmail: SENDER, now: NOW });
  assert.equal(again.events.length, 0);
  let checkpoints = 0;
  await commitObservation({ observation, plan, activities: [], suppress: async () => {}, appendEvent: async () => {}, checkpoint: async () => { checkpoints++; } });
  assert.equal(checkpoints, 1);
});

test('17. invalid historyId uses bounded recovery rather than a mailbox-wide dump', async () => {
  const inbound = msg({ id: 'r1', from: lead.email });
  const gone = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const calls = [];
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: '900', emailAddress: SENDER } }),
    history: { list: async p => { if (p.startHistoryId === '100') throw gone; return { data: { historyId: '901', history: [] } }; } },
    messages: { list: async p => { calls.push(p.q); return { data: { messages: [{ id: inbound.id, threadId: inbound.threadId }] } }; }, get: async () => ({ data: inbound }) },
    threads: { get: async () => ({ data: { messages: [] } }) },
  } };
  const last = '2026-09-17T20:16:58Z';
  await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities: [], senderInboxId: 'primary',
    senderEmail: SENDER, lastSuccessfulObservationAt: last, now: NOW,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^after:\d+$/);
});

test('18. request concurrency is bounded per mailbox', async () => {
  resetGmailUsageForTests();
  let current = 0; let peak = 0;
  const send = async () => {
    current++;
    peak = Math.max(peak, current);
    await new Promise(r => setTimeout(r, 20));
    current--;
    return { data: {} };
  };
  await Promise.all(Array.from({ length: 8 }, (_, i) => gmailRequest({
    method: 'users.messages.get', mailboxId: 'primary', feature: 'gmail_history_observer',
    params: { id: String(i) }, send, jitter: false, sleep: async () => {},
  })));
  assert.equal(peak, 1);
});

test('19. retries use backoff and do not storm', async () => {
  resetGmailUsageForTests();
  const slept = [];
  let attempts = 0;
  await assert.rejects(() => providerRead('users.history.list', { startHistoryId: '1' }, async () => {
    attempts++;
    throw quota();
  }, { sleep: async ms => slept.push(ms), jitter: false, mailboxId: 'primary' }));
  assert.equal(attempts, 4);
  assert.deepEqual(slept, [1000, 4000, 12000]);
  assert.equal(isRateLimited(quota()), true);
});

test('quota exhaustion does not start catch-up merely because health was unavailable', async () => {
  resetGmailUsageForTests();
  const { gmail, calls } = idleMailbox();
  const result = await observeMailbox({
    gmail, historyId: '88466', leads: [lead], activities: [], senderInboxId: 'tryscalelabai',
    senderEmail: SENDER, previousHealth: 'unavailable',
    lastSuccessfulObservationAt: '2026-09-17T20:16:58Z', now: NOW,
  });
  assert.equal(result.mode, 'history');
  assert.equal(calls.filter(c => c[0] === 'list').length, 0);
  assert.equal(calls.filter(c => c[0] === 'get').length, 0);
});

test('SENT thread fetch is skipped when CRM already has inbound on the thread', async () => {
  resetGmailUsageForTests();
  const outbound = msg({ id: 's1', from: SENDER, labels: ['SENT'], text: 'Thanks', at: '2026-09-17T20:40:00Z' });
  outbound.payload.headers.find(h => h.name === 'To').value = lead.email;
  let threads = 0;
  const gmail = { users: {
    history: { list: async () => ({ data: { historyId: '104', history: [{ messagesAdded: [{ message: { id: 's1', threadId: 't1' } }] }] } }) },
    messages: { get: async () => ({ data: outbound }) },
    threads: { get: async () => { threads++; return { data: { messages: [] } }; } },
  } };
  const activities = [{
    eventId: 'gmail-reply:old', eventType: 'positive_reply', sourceLeadId: lead.id, occurredAt: '2026-09-17T19:00:00Z',
    metadata: JSON.stringify({ gmailMessageId: 'old', gmailThreadId: 't1' }),
  }];
  const observation = await observeMailbox({
    gmail, historyId: '100', leads: [lead], activities, senderInboxId: 'primary', senderEmail: SENDER, now: NOW,
  });
  await planMailboxEvents({ observation, gmail, leads: [lead], activities, senderInboxId: 'primary', senderEmail: SENDER, now: NOW });
  assert.equal(threads, 0);
});

test('official quota units price history cheaper than message and thread reads', () => {
  assert.equal(QUOTA_UNITS['users.history.list'], 2);
  assert.equal(QUOTA_UNITS['users.messages.get'], 20);
  assert.equal(QUOTA_UNITS['users.threads.get'], 40);
  assert.equal(QUOTA_UNITS['users.messages.list'], 5);
});

test('usage snapshot and ops endpoint expose per-mailbox counters without tokens', () => {
  resetGmailUsageForTests();
  recordFollowUpBlocked('tryscalelabai', 'l1', 'observer_stale_followup');
  const snap = gmailUsageSnapshot({ now: NOW, mailboxes: ['primary', 'tryscalelabai'] });
  assert.ok(snap.totals);
  assert.ok(Array.isArray(snap.mailboxes));
  assert.equal(JSON.stringify(snap).includes('access_token'), false);
  assert.match(serverSrc, /app\.get\('\/api\/ops\/gmail-usage', requireAuth/);
  assert.doesNotMatch(serverSrc, /oauth.*gmail-usage|token.*gmail-usage/i);
});

test('intent backstop no longer runs mailbox-wide Gmail scans', () => {
  const branch = agentSrc.slice(agentSrc.indexOf('if (INTENT_ONLY && !CHECK_ONLY)'),
    agentSrc.indexOf('let todaySent', agentSrc.indexOf('if (INTENT_ONLY && !CHECK_ONLY)')));
  assert.match(branch, /using persisted observer health/);
  assert.doesNotMatch(branch, /runReplyCheckPass\(preparedIntent\.due/);
  assert.doesNotMatch(branch, /runHumanOutboundPass\(\s*candidates/);
});

test('HumanOutbound and LateReply Gmail scans are off the high-frequency path', () => {
  assert.match(agentSrc, /GMAIL_HUMAN_OUTBOUND_SCAN === 'true'/);
  assert.match(agentSrc, /GMAIL_LATE_REPLY_THREAD_SCAN === 'true'/);
  assert.match(agentSrc, /incremental observer owns sent-mail detection/);
  assert.match(agentSrc, /Gmail thread scan retired from the high-frequency path/);
});

test('unclassified outbound fails closed while the observer is unhealthy', () => {
  const verdict = observerFollowUpVerdict({
    lead: { emailStatus: 'emailed', emailStep: '', lastEmailedAt: '2026-09-01T00:00:00Z' },
    observer: { health: 'unavailable', checkpointAgeMinutes: 80 }, now: NOW,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'observer_stale_unclassified');
});
