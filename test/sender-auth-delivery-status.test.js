'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DELIVERY_CLASS, classifyDeliveryStatus, retractedBounceEventIds, bounceRetractionEventId } = require('../integrations/delivery-status');
const { matchMailboxMessages } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');
const { bouncedLeadIds } = require('../integrations/canonical-sends');
const { sendSuppressionReason } = require('../integrations/pipeline-state');


const SENDER = 'deins@scalelabaiteam.com';
const b64 = text => Buffer.from(text).toString('base64url');
const part = (mimeType, text, extra = {}) => ({ mimeType, body: { data: b64(text) }, headers: [], ...extra });

// A Gmail DSN as the API returns it: human text, machine fields, and the
// returned original — whose DKIM-Signature must never read as an auth failure.
function gmailDsn({ recipient, action, status, diagnostic, human, subject }) {
  return {
    mimeType: 'multipart/report',
    headers: [{ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, { name: 'Subject', value: subject }],
    parts: [
      { mimeType: 'multipart/alternative', headers: [], parts: [part('text/plain', human)] },
      part('message/delivery-status', `Reporting-MTA: dns; googlemail.com\n\nFinal-Recipient: rfc822; ${recipient}\nAction: ${action}\nStatus: ${status}\nDiagnostic-Code: smtp; ${diagnostic}\n`),
      { mimeType: 'message/rfc822', headers: [], parts: [
        part('text/rfc822-headers', `DKIM-Signature: v=1; a=rsa-sha256; d=scalelabaiteam.com\nAuthentication-Results: spf=fail dkim=fail\nTo: ${recipient}\n`),
        part('text/plain', 'Our original cold email body about DMARC policy failures (irrelevant)'),
      ] },
    ],
  };
}
const AUTH_DIAG = '450 4.7.26 Service unavailable, message sent over IPv6 [2a00:1450:4864:20::22e] must pass either SPF or DKIM validation, this message is not signed';
const delayDsn = recipient => gmailDsn({ recipient, action: 'delayed', status: '4.7.26', diagnostic: AUTH_DIAG,
  subject: 'Delivery Status Notification (Delay)',
  human: `** Delivery incomplete **\n\nThere was a temporary problem delivering your message to ${recipient}. Gmail will retry for 47 more hours. You'll be notified if the delivery fails permanently.\n\nThe response was:\n\n${AUTH_DIAG}` });
const authFailureDsn = recipient => gmailDsn({ recipient, action: 'failed', status: '4.7.26', diagnostic: AUTH_DIAG,
  subject: 'Delivery Status Notification (Failure)',
  human: `** Message not delivered **\n\nThere was a problem delivering your message to ${recipient}.\n\nThe response was:\n\n${AUTH_DIAG}` });
const dmarcRejectDsn = recipient => gmailDsn({ recipient, action: 'failed', status: '5.7.26',
  diagnostic: '550 5.7.26 Unauthenticated email from scalelabaiteam.com is not accepted due to domain\'s DMARC policy',
  subject: 'Delivery Status Notification (Failure)',
  human: `** Message blocked **\n\nYour message to ${recipient} has been blocked. The response was: 550 5.7.26 DMARC policy, SPF fail, DKIM fail` });
const hardBounceDsn = recipient => gmailDsn({ recipient, action: 'failed', status: '5.1.1',
  diagnostic: '550 5.1.1 The email account that you tried to reach does not exist.',
  subject: 'Delivery Status Notification (Failure)',
  human: `** Address not found **\n\nYour message wasn't delivered to ${recipient} because the address couldn't be found.` });

const asMessage = (id, payload, at) => ({ id, threadId: id, internalDate: String(Date.parse(at)), labelIds: ['INBOX'], payload, snippet: '' });

test('a multi-recipient DSN never borrows another address failure', () => {
  const text = 'Final-Recipient: rfc822; auth@corp.com\nAction: failed\nStatus: 4.7.26\nDiagnostic-Code: smtp; SPF fail\n\nFinal-Recipient: rfc822; invalid@corp.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; no such user\n';
  assert.equal(classifyDeliveryStatus(text, {recipient:'auth@corp.com'}).category, DELIVERY_CLASS.SENDER_AUTH_FAILURE);
  assert.equal(classifyDeliveryStatus(text, {recipient:'invalid@corp.com'}).category, DELIVERY_CLASS.RECIPIENT_INVALID);
  assert.equal(classifyDeliveryStatus(text, {recipient:'mentioned-only@corp.com'}).category, DELIVERY_CLASS.UNKNOWN);
});

test('the final 4.7.26 event is recorded once and never suppresses the recipient', async () => {
  const leads = [{id:'final',email:'final@corp.com',company:'Corp',lastEmailedAt:'2026-09-30T15:00:00Z'}];
  const observation = {messages:[asMessage('final-dsn',authFailureDsn('final@corp.com'),'2026-10-03T15:00:00Z')],recovered:false};
  const args = {observation,gmail:{},leads,activities:[],senderInboxId:'scalelabaiteam',senderEmail:SENDER};
  const first=await planMailboxEvents(args);
  assert.equal(first.events.length,1);
  assert.equal(first.events[0].eventType,'sender_auth_delivery_failure');
  assert.equal(JSON.parse(first.events[0].metadata).finalFailure,true);
  assert.equal(JSON.parse(first.events[0].metadata).dsnStatus,'4.7.26');
  assert.deepEqual(first.suppressions,[]);
  const second=await planMailboxEvents({...args,activities:first.events});
  assert.equal(second.events.length,0);
  assert.deepEqual(second.suppressions,[]);
});

test('audited false bounces are excluded while genuine bounces remain counted', () => {
  const leads=[{id:'false',email:'false@corp.com',senderInboxId:'scalelabaiteam',campaign:'Industrial Staffing Agency'},{id:'real',email:'real@corp.com',senderInboxId:'scalelabaiteam',campaign:'Industrial Staffing Agency'}];
  const bounce={eventId:'false-bounce',sourceLeadId:'false',leadId:'CE-false',eventType:'email_bounced',metadata:JSON.stringify({senderInboxId:'scalelabaiteam'})};
  const real={...bounce,eventId:'real-bounce',sourceLeadId:'real',leadId:'CE-real'};
  const retract={eventId:bounceRetractionEventId(bounce.eventId),sourceLeadId:'false',eventType:'email_bounce_retracted',metadata:JSON.stringify({retractsEventId:bounce.eventId,decision:'retract_non_recipient_bounce',retractedBy:'incident-review',deliveryClass:'temporary_provider_delay'})};
  const activities=[bounce,real,retract];
  assert.deepEqual([...bouncedLeadIds({leads,activities})],['real']);
  const {buildSenderAnalytics}=require('../integrations/analytics-scope');
  assert.equal(buildSenderAnalytics({leads,activities,senders:[{id:'scalelabaiteam',dailyLimit:40}]}).senders[0].bouncedLeads,1);
  for(const malformed of [{...retract,eventId:'untrusted'},{...retract,sourceLeadId:'real'},{...retract,metadata:'{}'}]) {
    assert.equal(retractedBounceEventIds([bounce,malformed]).size,0);
  }
});

// ── 1–3: classification ──────────────────────────────────────────────────────

test('1. a 450 4.7.26 notice does not mark the recipient invalid (delay or final failure)', () => {
  for (const payload of [delayDsn('a@corp.com'), authFailureDsn('a@corp.com')]) {
    const verdict = classifyDeliveryStatus(payload, { recipient: 'a@corp.com', subject: payload.headers[1].value });
    assert.equal(verdict.category, DELIVERY_CLASS.SENDER_AUTH_FAILURE);
    assert.equal(verdict.recipientInvalid, false);
  }
  assert.equal(classifyDeliveryStatus(delayDsn('a@corp.com'), { recipient: 'a@corp.com' }).final, false);
  assert.equal(classifyDeliveryStatus(authFailureDsn('a@corp.com'), { recipient: 'a@corp.com' }).final, true);
  const leads = [{ id: 'L1', email: 'a@corp.com', lastEmailedAt: '2026-10-02T17:00:00Z' }];
  for (const payload of [delayDsn('a@corp.com'), authFailureDsn('a@corp.com')]) {
    const matched = matchMailboxMessages([asMessage('d1', payload, '2026-10-03T18:00:00Z')], { leads, senderInboxId: 'scalelabaiteam', senderEmail: SENDER });
    assert.equal(matched.bounces.size, 0);
    assert.equal(matched.senderAuthFailures.has('L1'), true);
  }
});

test('2. SPF/DKIM/DMARC sender-auth rejection records a failure but never suppresses', async () => {
  const verdict = classifyDeliveryStatus(dmarcRejectDsn('b@corp.com'), { recipient: 'b@corp.com' });
  assert.equal(verdict.category, DELIVERY_CLASS.SENDER_AUTH_FAILURE);
  assert.equal(verdict.status, '5.7.26');
  const leads = [{ id: 'L2', email: 'b@corp.com', company: 'Corp', lastEmailedAt: '2026-10-02T17:00:00Z' }];
  const plan = await planMailboxEvents({ observation: { messages: [asMessage('m2', dmarcRejectDsn('b@corp.com'), '2026-10-02T17:05:00Z')], recovered: false },
    gmail: {}, leads, activities: [], senderInboxId: 'scalelabaiteam', senderEmail: SENDER });
  assert.deepEqual(plan.suppressions, []);
  assert.equal(plan.events.filter(event => event.eventType === 'email_bounced').length, 0);
  const recorded = plan.events.find(event => event.eventType === 'sender_auth_delivery_failure');
  assert.ok(recorded);
  assert.equal(JSON.parse(recorded.metadata).recipientSuppressed, false);
  // A Gmail delay notice that is NOT auth-related still never suppresses.
  const plainDelay = gmailDsn({ recipient: 'b@corp.com', action: 'delayed', status: '4.4.1', diagnostic: 'Connection refused',
    subject: 'Delivery Status Notification (Delay)', human: 'Delivery incomplete. You\'ll be notified if the delivery fails permanently.' });
  assert.equal(classifyDeliveryStatus(plainDelay, { recipient: 'b@corp.com' }).category, DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY);
});

test('3. a genuine recipient-not-found hard bounce still suppresses', async () => {
  const verdict = classifyDeliveryStatus(hardBounceDsn('c@corp.com'), { recipient: 'c@corp.com' });
  assert.equal(verdict.category, DELIVERY_CLASS.RECIPIENT_INVALID);
  const leads = [{ id: 'L3', email: 'c@corp.com', company: 'Corp', lastEmailedAt: '2026-10-02T17:00:00Z' }];
  const plan = await planMailboxEvents({ observation: { messages: [asMessage('m3', hardBounceDsn('c@corp.com'), '2026-10-02T17:05:00Z')], recovered: false },
    gmail: {}, leads, activities: [], senderInboxId: 'primary', senderEmail: SENDER });
  assert.equal(plan.suppressions.length, 1);
  assert.equal(plan.events[0].eventType, 'email_bounced');
  // Legacy plain-text NDRs keep their existing hard-bounce behaviour.
  assert.equal(classifyDeliveryStatus('550 5.1.1 no such user c@corp.com', { recipient: 'c@corp.com' }).category, DELIVERY_CLASS.RECIPIENT_INVALID);
  assert.equal(classifyDeliveryStatus('4.2.0 delivery incomplete, will retry c@corp.com').category, DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY);
});
