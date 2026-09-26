'use strict';

// Phase 1.5: conversation evidence integrity.
//   A. An automated send is never recorded as a human reply, whichever key its
//      ledger row uses for the provider message id.
//   B. A genuine human reply observed in Gmail keeps its own quote-stripped
//      text, so future conversations can be reconstructed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planMailboxEvents, humanReplyText, HUMAN_REPLY_TEXT_LIMIT } = require('../integrations/mailbox-observation-events');
const { planHumanOutboundIngestion, latestHumanOutboundAt } = require('../integrations/human-outbound');
const { latestResponseAt, isProspectFacingResponse, isResponseEvidence } = require('../integrations/prospect-response');
const { deriveAutomationOwnership } = require('../integrations/automation-ownership');
const { buildConversationState } = require('../integrations/conversation-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const SENDER = 'deins@scalelabai.ca';
const LEAD_EMAIL = 'owner@acme.test';
const lead = {
  id: 'L1', email: LEAD_EMAIL, company: 'Acme Staffing', contactName: 'Alex Acme', stage: 'Replied',
  emailStatus: 'replied', emailStep: '2', lastEmailedAt: '2026-09-18T15:00:00.000Z', senderInboxId: 'primary', notes: '',
};
const b64 = text => Buffer.from(text, 'utf8').toString('base64url');

function sentMessage({ id, at = '2026-09-21T15:30:45.000Z', threadId = 't1', text, html, parts, snippet = '' }) {
  const headers = [
    { name: 'From', value: `Deins <${SENDER}>` }, { name: 'To', value: `Alex <${LEAD_EMAIL}>` },
    { name: 'Subject', value: 'Re: employer accounts' }, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
  ];
  const body = parts || [
    ...(text !== undefined ? [{ mimeType: 'text/plain', body: { data: b64(text) } }] : []),
    ...(html !== undefined ? [{ mimeType: 'text/html', body: { data: b64(html) } }] : []),
  ];
  return { id, threadId, internalDate: String(Date.parse(at)), labelIds: ['SENT'], snippet,
    payload: { mimeType: 'multipart/alternative', headers, parts: body } };
}

// The prospect wrote first, so any later outbound in the thread is a response
// unless the ledger already records it as automation.
const prospectReply = {
  eventId: 'gmail-reply:in1', leadId: 'CE-L1', sourceLeadId: 'L1', email: LEAD_EMAIL, eventType: 'positive_reply',
  occurredAt: '2026-09-20T15:00:00.000Z', subject: 'Re: employer accounts', content: 'Interested',
  metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: 'in1', gmailThreadId: 't1', senderInboxId: 'primary', canonicalState: 'positive' }),
};
const automated = (eventType, idKey, id = 'out1', extra = {}) => ({
  eventId: eventType === 'sequence_step_sent' ? 'seq:CE-L1:hot_stale_v1:1' : (eventType === 'booking_link_sent' ? 'reply-action:abc' : `gmail:${id}`),
  leadId: 'CE-L1', sourceLeadId: 'L1', email: LEAD_EMAIL, eventType, occurredAt: '2026-09-21T15:30:46.085Z',
  subject: '', content: 'Automated body',
  metadata: JSON.stringify({ [idKey]: id, provider: 'gmail', gmailThreadId: 't1', senderInboxId: 'primary', ...extra }),
});
// Any provider read is a failure here: every scenario is decided from the ledger.
const noGmail = { users: { threads: { get: async () => { throw new Error('unexpected Gmail read'); } } } };

async function observe(messages, activities, { recovered = false } = {}) {
  return planMailboxEvents({
    observation: { messages, unavailable: [], recovered }, gmail: noGmail, leads: [lead], activities,
    senderInboxId: 'primary', senderEmail: SENDER, now: new Date('2026-09-21T16:00:00.000Z'),
  });
}
const humanEvents = plan => plan.events.filter(event => event.eventType === 'human_response_sent');

// ── A. automation is never a human reply ─────────────────────────────────

test('1. a stage-sequence send recorded with providerMessageId is not recorded as a human reply', async () => {
  const message = sentMessage({ id: 'out1', text: 'Following up on this' });
  // Control: without the automated record the same message IS a human reply.
  assert.equal(humanEvents(await observe([message], [prospectReply])).length, 1);
  const plan = await observe([message], [prospectReply, automated('sequence_step_sent', 'providerMessageId', 'out1', { sequenceId: 'hot_stale_v1', step: 1 })]);
  assert.equal(humanEvents(plan).length, 0);
  assert.equal(plan.events.length, 0);
});

test('2. the same send recorded with gmailMessageId is not a human reply', async () => {
  const plan = await observe([sentMessage({ id: 'out1', text: 'x' })],
    [prospectReply, automated('sequence_step_sent', 'gmailMessageId', 'out1', { sequenceId: 'hot_stale_v1', step: 1 })]);
  assert.equal(humanEvents(plan).length, 0);
});

test('3. a cold initial send is not a human reply', async () => {
  const plan = await observe([sentMessage({ id: 'out1', text: 'x' })],
    [prospectReply, automated('initial_email_sent', 'gmailMessageId', 'out1', { step: 1 })]);
  assert.equal(humanEvents(plan).length, 0);
});

test('4. an ordinary cold follow-up is not a human reply', async () => {
  const plan = await observe([sentMessage({ id: 'out1', text: 'x' })],
    [prospectReply, automated('follow_up_sent', 'gmailMessageId', 'out1', { step: 2 })]);
  assert.equal(humanEvents(plan).length, 0);
});

test('5. an automated warm reply is not a human reply', async () => {
  const plan = await observe([sentMessage({ id: 'out1', text: 'x' })],
    [prospectReply, automated('booking_link_sent', 'gmailMessageId', 'out1', { action: 'AUTO_STAFFING_QUALIFY_QUESTION', inboundMessageId: 'in1' })]);
  assert.equal(humanEvents(plan).length, 0);
});

test('a known sequence send re-delivered past the fetch dedupe (thread recovery) is still automation', async () => {
  // Thread recovery pushes every message of a vanished message's thread into
  // the observation, bypassing the known-id fetch filter. The plan-time check
  // is what must hold.
  const recoveredThread = [
    sentMessage({ id: 'out1', text: 'Following up', at: '2026-09-21T15:30:45.000Z' }),
    sentMessage({ id: 'out2', text: 'A real reply from Deins', at: '2026-09-21T17:00:00.000Z' }),
  ];
  const plan = await observe(recoveredThread, [prospectReply,
    automated('sequence_step_sent', 'providerMessageId', 'out1', { sequenceId: 'no_show_recovery_v1', step: 2 })]);
  assert.deepEqual(humanEvents(plan).map(event => event.eventId), ['gmail-outbound:out2']);
});

test('the legacy SENT scan planner also recognises providerMessageId (the path that wrote the historical rows)', () => {
  const context = (rows) => ({
    leadsByEmail: new Map([[LEAD_EMAIL, lead]]),
    existingActivitiesByLead: new Map([['L1', rows]]),
    threadsWithInbound: new Set(['t1']),
  });
  const message = { id: 'out1', threadId: 't1', to: [LEAD_EMAIL], subject: 'Re:', sentAt: '2026-09-21T15:30:45.000Z' };
  assert.equal(planHumanOutboundIngestion([message], context([prospectReply])).plans[0].outcome, 'proposed');
  for (const idKey of ['providerMessageId', 'gmailMessageId']) {
    const report = planHumanOutboundIngestion([message],
      context([prospectReply, automated('sequence_step_sent', idKey, 'out1', { sequenceId: 'demo_follow_up_v1', step: 2 })]));
    assert.equal(report.plans[0].outcome, 'already_recorded', idKey);
    assert.equal(report.proposedCount, 0, idKey);
  }
});

// ── B. human reply text is persisted from Gmail evidence ────────────────

test('6. an actual manual Gmail send becomes human_response_sent', async () => {
  const plan = await observe([sentMessage({ id: 'h1', text: 'Happy to walk you through it.' })], [prospectReply]);
  const [event] = humanEvents(plan);
  assert.ok(event);
  assert.equal(event.eventId, 'gmail-outbound:h1');
  assert.equal(JSON.parse(event.metadata).actor, 'human');
});

test('7. the persisted human text is quote-stripped and never taken from the snippet or HTML', async () => {
  const text = [
    'Happy to walk you through it — what roles do you place?',
    '',
    'On Mon, Sep 21, 2026 at 8:00 AM Alex Acme <owner@acme.test> wrote:',
    '> Sounds good, tell me more',
    '> — Alex',
  ].join('\n');
  const plan = await observe([sentMessage({ id: 'h1', text, html: '<div>Happy to walk you through it<blockquote>Sounds good</blockquote></div>',
    snippet: 'Happy to walk you through it On Mon, Sep 21 Alex wrote: Sounds good' })], [prospectReply]);
  const [event] = humanEvents(plan);
  assert.equal(event.content, 'Happy to walk you through it — what roles do you place?');
  assert.doesNotMatch(event.content, /wrote:|^>|blockquote|<div>/m);
  assert.equal(JSON.parse(event.metadata).contentCapture, 'quote_stripped_plain_text');
});

test('8. the persisted human text is capped at 1,500 characters', async () => {
  const plan = await observe([sentMessage({ id: 'h1', text: 'x'.repeat(2000) })], [prospectReply]);
  const [event] = humanEvents(plan);
  assert.equal(HUMAN_REPLY_TEXT_LIMIT, 1500);
  assert.equal(event.content.length, 1500);
  assert.equal(JSON.parse(event.metadata).contentTruncated, true);
  const short = humanEvents(await observe([sentMessage({ id: 'h2', text: 'Short' })], [prospectReply]))[0];
  assert.equal(JSON.parse(short.metadata).contentTruncated, false);
});

test('9. message, thread, inbox, time and lead identity are preserved', async () => {
  const plan = await observe([sentMessage({ id: 'h9', at: '2026-09-21T17:04:05.000Z', text: 'Thanks Alex' })], [prospectReply]);
  const [event] = humanEvents(plan);
  const metadata = JSON.parse(event.metadata);
  assert.equal(event.eventId, 'gmail-outbound:h9');
  assert.equal(event.leadId, 'CE-L1');
  assert.equal(event.sourceLeadId, 'L1');
  assert.equal(event.email, LEAD_EMAIL);
  assert.equal(event.occurredAt, '2026-09-21T17:04:05.000Z');
  assert.equal(metadata.gmailMessageId, 'h9');
  assert.equal(metadata.gmailThreadId, 't1');
  assert.equal(metadata.senderInboxId, 'primary');
  assert.equal(metadata.rfcMessageId, '<h9@mail.gmail.com>');
  assert.equal(metadata.sentAt, '2026-09-21T17:04:05.000Z');
  assert.equal(metadata.trigger, 'gmail_outbound_ingestion');
});

test('10. a missing or unreadable body still records the human evidence with blank content', async () => {
  const unreadable = sentMessage({ id: 'h3', text: 'x' });
  Object.defineProperty(unreadable.payload, 'parts', { get() { throw new Error('corrupt MIME tree'); } });
  const cases = [
    sentMessage({ id: 'h1', parts: [] }),                                     // no body at all
    sentMessage({ id: 'h2', html: '<p>HTML only <blockquote>quoted</blockquote></p>' }), // never the HTML part
    unreadable,                                                                  // extraction throws
  ];
  const plan = await observe(cases, [prospectReply]);
  const events = humanEvents(plan);
  assert.deepEqual(events.map(event => event.eventId), ['gmail-outbound:h1', 'gmail-outbound:h2', 'gmail-outbound:h3']);
  for (const event of events) {
    assert.equal(event.content, '');
    assert.equal(JSON.parse(event.metadata).contentCapture, 'unavailable');
  }
  assert.deepEqual(humanReplyText(null), { text: '', truncated: false });
});

// ── idempotency ─────────────────────────────────────────────────────────

test('11. the same human message observed twice is recorded once', async () => {
  const message = sentMessage({ id: 'h1', text: 'Happy to help' });
  const first = await observe([message, message], [prospectReply]);
  assert.equal(humanEvents(first).length, 1, 'twice in one observation');
  const second = await observe([message], [prospectReply, ...first.events]);
  assert.equal(second.events.length, 0, 'again on the next pass');
});

test('12. the same automated sequence message observed twice never becomes human', async () => {
  const message = sentMessage({ id: 'out1', text: 'Following up' });
  const ledger = [prospectReply, automated('sequence_step_sent', 'providerMessageId', 'out1', { sequenceId: 'hot_stale_v1', step: 1 })];
  const first = await observe([message], ledger);
  const second = await observe([message, message], [...ledger, ...first.events], { recovered: true });
  assert.equal(humanEvents(first).length + humanEvents(second).length, 0);
});

// ── Phase 1 conversation state ──────────────────────────────────────────

test('13. the conversation-state builder reads the persisted human text from the ledger', async () => {
  const [event] = humanEvents(await observe([sentMessage({ id: 'h1', text: 'Happy to walk you through it.\n\nOn Mon Alex wrote:\n> hi' })], [prospectReply]));
  const state = buildConversationState({ lead, activities: [prospectReply, event], now: '2026-09-22T18:00:00.000Z' });
  const human = state.turns.find(turn => turn.actor === 'human');
  assert.equal(human.contentAvailable, true);
  assert.equal(human.content, 'Happy to walk you through it.');
  assert.equal(human.contentSource, 'ledger_human_reply_text');
  assert.equal(human.contentTruncated, false);
  assert.ok(!state.evidenceWarnings.some(item => item.code === 'human_reply_text_unavailable'));
});

test('14. an old human_response_sent row with blank content is still reported as unavailable', () => {
  const old = {
    eventId: 'gmail-outbound:old1', leadId: 'CE-L1', sourceLeadId: 'L1', email: LEAD_EMAIL, eventType: 'human_response_sent',
    occurredAt: '2026-09-15T19:50:26.000Z', subject: 'Re:', content: '',
    metadata: JSON.stringify({ provider: 'gmail', direction: 'outbound', actor: 'human', trigger: 'gmail_outbound_ingestion', gmailMessageId: 'old1', gmailThreadId: 't1' }),
  };
  const state = buildConversationState({ lead, activities: [prospectReply, old], now: '2026-09-22T18:00:00.000Z' });
  const human = state.turns.find(turn => turn.actor === 'human');
  assert.equal(human.contentAvailable, false);
  assert.equal(human.contentUnavailableReason, 'human_reply_body_not_persisted');
  assert.ok(state.evidenceWarnings.some(item => item.code === 'human_reply_text_unavailable'));
});

// ── no send behaviour changes ───────────────────────────────────────────

test('15. captured text changes no send-gate evidence, and observation still cannot send', async () => {
  const [withText] = humanEvents(await observe([sentMessage({ id: 'h1', text: 'Happy to help' })], [prospectReply]));
  const blank = { ...withText, content: '' };
  const gates = rows => ({
    human: latestHumanOutboundAt(rows), answered: latestResponseAt(rows),
    facing: rows.map(isProspectFacingResponse), evidence: rows.map(isResponseEvidence),
    owner: deriveAutomationOwnership(lead, { activities: rows, suppressionReason: () => null, sendingEnabled: true,
      now: new Date('2026-09-22T18:00:00.000Z') }),
  });
  assert.deepEqual(gates([prospectReply, withText]), gates([prospectReply, blank]));

  const observer = readSource('integrations/mailbox-observation-events.js');
  for (const forbidden of [/sendEmail/, /messages\.send/, /deliverProspectReply/, /recordColdCallActivity/, /applyLeadChange/]) {
    assert.doesNotMatch(observer, forbidden, String(forbidden));
  }
  assert.match(observer, /if \(mine\.some\(row => providerMessageId\(row\) === message\.id\)\) continue;/);
  assert.match(readSource('integrations/human-outbound.js'), /\|\| providerMessageId\(row\) === String\(message\.id\)\);/);
});
