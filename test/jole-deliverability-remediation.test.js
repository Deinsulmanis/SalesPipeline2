'use strict';

// Jole deliverability remediation (2026-11-01).
//
// 1. The hold: 91 Proofpoint catch-all leads may never start a sequence. It is
//    decided from reviewed data, so no lead row changes and no queue refill can
//    bring a held lead back.
// 2. Delivery notices: what each one literally says is kept, a recipient failure
//    is told apart from a policy refusal, and only the former suppresses. The
//    notice shapes below are the ones that reached the inboxes between Oct 19 and
//    Nov 1, 2026, including the Cisco, Trend Micro and hop-count notices the
//    observer used to skip.
// 3. Client scope: Jole's inbound health answers for Jole's inboxes only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOLDS = require('../integrations/clients/data/jole-deliverability-holds.json');
const { joleDeliverabilityHold, joleSelectionHold, setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail, clientSelectionHold, clientPersonalizationState } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { queueEligibility } = require('../integrations/outreach-queue');
const { firstTouchMovability } = require('../integrations/sender-balance');
const { DELIVERY_CLASS, classifyDeliveryStatus, isDeliveryNotice, DELIVERY_DEFERRED_EVENT, DELIVERY_FAILED_EVENT } = require('../integrations/delivery-status');
const { matchMailboxMessages } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');
const { provenFailedTouches, unrecoveredTouchBlock } = require('../integrations/same-touch-recovery');
const { clientInboundHealth } = require('../integrations/clients/inbound-health');

const ENV = Object.freeze({ JOLE_COMMERCIAL_MAILING_ADDRESS: '2738 Dallas Ave, Ingleside, TX 78362' });
const heldId = 'JHOLD1';
const lead = (id, extra = {}) => ({
  id, company: 'Gulf Fabrication LLC', contactName: 'Pat Rivera', email: `pat.${id.toLowerCase()}@gulffab.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', routingRequired: 'true', senderInboxId: 'jole_group_jorge', clientId: 'jole', sheetRow: 5000, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow({
    first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'Plant / operations / production',
    company_domain: 'gulffab.com', sector: 'Industrial fabrication / machinery', site_tie: 'EXACT', hiring_site: 'Mont Belvieu, TX',
    verified_role: 'Millwright', posting_date: '2026-10-01', hiring_evidence_url: 'https://example.org/jobs/1', verified_at: '2026-10-07',
  }) })),
  ...extra,
});
const classify = () => setJoleClassificationForTests({
  deliverabilityHolds: { [heldId]: { reason: 'catch-all domain behind Proofpoint' } },
  '*': () => ({ mode: 'general_craft', role: null, location: null }),
});

test.afterEach(() => setJoleClassificationForTests(null));

// ── the hold ─────────────────────────────────────────────────────────────────

test('the reviewed hold list carries evidence and no contact details', () => {
  const entries = Object.entries(HOLDS.leads);
  assert.equal(HOLDS.schema, 'jole_deliverability_holds_v1');
  assert.equal(entries.length, HOLDS.summary.held);
  assert.ok(entries.length > 0 && entries.length <= 91);
  assert.equal(HOLDS.summary.candidates, 91);
  assert.equal(HOLDS.summary.held + HOLDS.summary.excluded, 91);
  for (const [id, entry] of entries) {
    assert.match(id, /^[a-z0-9]{12,}$/);
    assert.equal(entry.segment, 'proofpoint_catch_all');
    assert.equal(entry.evidence.domainCatchAll, true);
    assert.match(entry.evidence.mxHost, /pphosted\.com$|ppe-hosted\.com$/);
    assert.equal(entry.originalState.stage, 'Queued');
    assert.equal(entry.originalState.emailStatus, '');
    assert.equal(entry.originalState.emailStep, '');
    assert.equal(entry.originalState.lastEmailedAt, '');
  }
  assert.ok(!JSON.stringify(HOLDS).includes('@'), 'the manifest must never carry an email address');
});

test('every lead on the reviewed list is refused a first touch by the data, whatever its row says', () => {
  for (const id of Object.keys(HOLDS.leads)) {
    assert.match(joleDeliverabilityHold({ id }), /^Jole deliverability hold: /);
    assert.match(joleSelectionHold({ id }), /^Jole deliverability hold: /);
  }
  assert.equal(joleDeliverabilityHold({ id: 'not-on-the-list' }), '');
});

test('a held lead never renders Touch 1, so a stage change or requeue cannot release it', () => {
  classify();
  assert.throws(() => renderClientLeadEmail(lead(heldId), 1, { env: ENV }), error => error.code === 'selection_hold');
  // Moving the row between stages is not a release: the hold reads the id.
  assert.throws(() => renderClientLeadEmail(lead(heldId, { stage: 'Import' }), 1, { env: ENV }), error => error.code === 'selection_hold');
  assert.match(clientSelectionHold(lead(heldId, { stage: 'Import' })), /deliverability hold/);
  assert.equal(renderClientLeadEmail(lead('JOPEN'), 1, { env: ENV }).step, 1);
});

test('the operator view shows a held lead as held', () => {
  classify();
  assert.equal(clientPersonalizationState(lead(heldId), { env: ENV }).status, 'hold');
});

test('the queue preflight refuses a held lead and admits its neighbour', () => {
  classify();
  const held = lead(heldId); const open = lead('JOPEN');
  const refused = queueEligibility(held, { env: ENV, leads: [held] });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /deliverability hold/);
  assert.equal(queueEligibility(open, { env: ENV, leads: [open] }).ok, true);
});

test('a scheduled refill cannot move or count a held lead', () => {
  classify();
  const ctx = lead => ({ lockedLeadIds: new Set(), activitiesByLead: new Map(), suppressedEmails: new Set(), env: { ...ENV, CLIENT_SENDING_AUTHORIZED: 'jole' }, renderOptions: { env: ENV }, leads: [lead], boardLeads: [] });
  const held = lead(heldId);
  const verdict = firstTouchMovability(held, ctx(held));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /deliverability hold/);
  const open = lead('JOPEN');
  assert.equal(firstTouchMovability(open, ctx(open)).ok, true);
});

test('a contacted lead keeps its thread even if its id is on the list', () => {
  classify();
  const contacted = lead(heldId, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-21T12:00:03.000Z' });
  assert.equal(renderClientLeadEmail(contacted, 2, { env: ENV }).step, 2);
  assert.equal(renderClientLeadEmail(contacted, 1, { env: ENV }).step, 1);
});

test('the send path re-renders before any reservation, so the hold is enforced at delivery', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const delivery = agent.slice(agent.indexOf('async function deliverOrdinaryColdStep'));
  assert.ok(delivery.indexOf('clientDeliveryCopyProblem(lead, step, body') > -1);
  assert.ok(delivery.indexOf('clientDeliveryCopyProblem(lead, step, body') < delivery.indexOf('reservationEventId = `cold-reserve'));
  assert.ok(agent.indexOf('isClientTemplateId(l.emailTemplateId) && clientSelectionHold(l)') > -1);
});

// ── delivery notices ─────────────────────────────────────────────────────────

const b64 = text => Buffer.from(text).toString('base64url');
const part = (mimeType, text, extra = {}) => ({ mimeType, body: { data: b64(text) }, headers: [], ...extra });
const headers = (from, subject, extra = []) => [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...extra];
const REPORT = [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="x"' }];

function dsn({ recipient, action, status, diagnostic, human = '', subject = 'Delivery Status Notification (Failure)', from = 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }) {
  return { mimeType: 'multipart/report', headers: headers(from, subject, REPORT), parts: [
    { mimeType: 'multipart/alternative', headers: [], parts: [part('text/plain', human || `There was a problem delivering your message to ${recipient}.`)] },
    part('message/delivery-status', `Reporting-MTA: dns; example\n\nFinal-Recipient: rfc822; ${recipient}\nAction: ${action}\nStatus: ${status}\nRemote-MTA: dns; mx.example.net\n${diagnostic ? `Diagnostic-Code: smtp; ${diagnostic}\n` : ''}`),
  ] };
}
const proofpointDbeb = r => dsn({ recipient: r, action: 'failed', status: '5.4.1', subject: 'Returned mail: see transcript for details', from: 'Mail Delivery Subsystem <MAILER-DAEMON@mx0b-002c4401.pphosted.com>',
  diagnostic: '550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors [MN7PEPF.namprd04.prod.outlook.com]' });
const microsoftNotFound = r => dsn({ recipient: r, action: 'failed', status: '5.1.10', subject: 'Undeliverable: Re: Lab Fabricators', from: 'postmaster@tenant.onmicrosoft.com',
  diagnostic: `550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient ${r} not found by SMTP address lookup` });
const ciscoGateway = r => dsn({ recipient: r, action: 'failed', status: '5.0.0 (permanent failure)', from: 'Mail Delivery System <noreply@ces.cisco.com>',
  human: `The following message to <${r}> was undeliverable.\nThe reason for the problem:\n5.1.0 - Unknown address error 550-'5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors'\n` });
const trendMicro = r => ({ mimeType: 'multipart/mixed', headers: headers('<no-reply@tmes.trendmicro.com>', 'Undelivered Mail Returned to Sender'), parts: [
  part('text/plain', `This is to inform you that your email message could not be delivered to the intended recipients.\nDo not reply to this generated email message.\n\nFrom: j.guerrero@jolebtxteam.com\nTo: ${r}\nSubject: Maintenance Technicians\n`),
] });
const hopCount = r => ({ mimeType: 'multipart/report', headers: headers('MEC Postmaster <postmaster@mecinc.com>', '[Postmaster] Email Delivery Failure', REPORT), parts: [
  part('text/plain', `This is a delivery failure notification message indicating that\nan email you addressed to email address :\n-- ${r}\n\ncould not be delivered. The problem appears to be :\n-- Recipient email server rejected the message\n\nAdditional information follows :\n-- 5.4.14 Hop count exceeded - possible mail loop ATTR34 [BN2PEPF.namprd02.prod.outlook.com]\n`),
] });
const reputationBlock = r => dsn({ recipient: r, action: 'failed', status: '5.7.1', diagnostic: '554 5.7.1 Message rejected due to poor sender reputation. Blocked using Proofpoint Dynamic Reputation' });
const tenantPolicy = r => dsn({ recipient: r, action: 'failed', status: '5.7.0', diagnostic: '550 5.7.705 Access denied, tenant has exceeded threshold. AS(21510)' });
const genericBlock = r => dsn({ recipient: r, action: 'failed', status: '5.7.1', diagnostic: '550 5.7.1 Recipient address rejected: Access denied' });
const mailboxUnavailable = r => dsn({ recipient: r, action: 'failed', status: '5.7.0', diagnostic: '550 Requested action not taken: mailbox unavailable' });
const delay = r => dsn({ recipient: r, action: 'delayed', status: '4.4.1', subject: 'Delivery Status Notification (Delay)', diagnostic: 'The recipient server did not accept our requests to connect.' });
const finalTemporary = r => dsn({ recipient: r, action: 'failed', status: '4.4.4', diagnostic: '451 4.4.4 Mail received as unauthenticated, incoming to a recipient domain configured in a hosted tenant which has no mail-enabled subscriptions. ATTR5',
  human: `Your message to ${r} failed permanently after retries.` });

test('each real notice shape reads as what it literally says', () => {
  const r = 'pat@corp.com';
  const cases = [
    [proofpointDbeb(r), DELIVERY_CLASS.RECIPIENT_INVALID, '5.4.1', '550', true, 'hard'],
    [microsoftNotFound(r), DELIVERY_CLASS.RECIPIENT_INVALID, '5.1.10', '550', true, 'hard'],
    [ciscoGateway(r), DELIVERY_CLASS.RECIPIENT_INVALID, '5.1.0', '550', true, 'hard'],
    [hopCount(r), DELIVERY_CLASS.RECIPIENT_ROUTING_FAILURE, '5.4.14', '', true, 'hard'],
    [mailboxUnavailable(r), DELIVERY_CLASS.RECIPIENT_INVALID, '5.7.0', '550', true, 'hard'],
    [reputationBlock(r), DELIVERY_CLASS.POLICY_REJECTION, '5.7.1', '554', false, 'hard'],
    [tenantPolicy(r), DELIVERY_CLASS.POLICY_REJECTION, '5.7.705', '550', false, 'hard'],
    [genericBlock(r), DELIVERY_CLASS.POLICY_REJECTION, '5.7.1', '550', false, 'hard'],
    [delay(r), DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY, '4.4.1', '', false, 'soft'],
    [finalTemporary(r), DELIVERY_CLASS.UNDELIVERED_TEMPORARY, '4.4.4', '451', false, 'soft'],
  ];
  for (const [payload, category, code, smtp, suppress, bounceType] of cases) {
    const verdict = classifyDeliveryStatus(payload, { recipient: r, subject: payload.headers.find(h => h.name === 'Subject').value });
    assert.equal(verdict.category, category, verdict.diagnostic);
    assert.equal(verdict.enhancedCode, code, verdict.diagnostic);
    assert.equal(verdict.smtpCode, smtp, verdict.diagnostic);
    assert.equal(verdict.suppress, suppress, verdict.diagnostic);
    assert.equal(verdict.bounceType, bounceType, verdict.diagnostic);
    assert.ok(!verdict.diagnostic.includes('pat@'), 'the recipient address is masked');
  }
});

test('a notice with no code stays code-less: nothing is inferred', () => {
  const verdict = classifyDeliveryStatus(trendMicro('pat@corp.com'), { recipient: 'pat@corp.com', subject: 'Undelivered Mail Returned to Sender' });
  assert.equal(verdict.category, DELIVERY_CLASS.UNDELIVERED_UNSPECIFIED);
  assert.equal(verdict.enhancedCode, '');
  assert.equal(verdict.smtpCode, '');
  assert.equal(verdict.bounceType, null);
  assert.equal(verdict.suppress, false);
});

test('IP fragments are never read as status codes', () => {
  const verdict = classifyDeliveryStatus(dsn({ recipient: 'a@corp.com', action: 'failed', status: '4.4.1', diagnostic: '[10.5.1.1] [52.101.41.26] connection timed out' }), { recipient: 'a@corp.com' });
  assert.equal(verdict.enhancedCode, '4.4.1');
  assert.equal(verdict.category, DELIVERY_CLASS.UNDELIVERED_TEMPORARY);
});

test('gateway notices are recognised, and a person writing about delivery is not one', () => {
  const senderOf = payload => (/<([^>]+)>/.exec(payload.headers[0].value) || [null, payload.headers[0].value])[1].toLowerCase();
  for (const payload of [ciscoGateway('a@corp.com'), trendMicro('a@corp.com'), hopCount('a@corp.com')]) assert.equal(isDeliveryNotice(payload, senderOf(payload)), true);
  const person = { mimeType: 'text/plain', headers: headers('Pat <pat@corp.com>', 'Undeliverable address on your list?'), body: { data: b64('Hi') } };
  assert.equal(isDeliveryNotice(person, 'pat@corp.com'), false);
  const noReplyNewsletter = { mimeType: 'text/plain', headers: headers('<no-reply@news.example.com>', 'Weekly digest'), body: { data: b64('Hi') } };
  assert.equal(isDeliveryNotice(noReplyNewsletter, 'no-reply@news.example.com'), false);
});

const SENDER = 'j.guerrero@jolebtxteam.com';
const INBOX = 'jole_team_jguerrero';
const noticeMessage = (id, payload, at, labelIds = ['INBOX'], threadId = id) => ({ id, threadId, internalDate: String(Date.parse(at)), labelIds, payload, snippet: '' });
const prospect = { id: 'L1', email: 'pat@corp.com', company: 'Corp', lastEmailedAt: '2026-10-27T13:00:00Z', clientId: 'jole' };
const sent = (step, at, thread = 'thread-1', id = `sent-${step}`) => ({
  eventId: `send-${step}`, leadId: 'CE-L1', sourceLeadId: 'L1', email: prospect.email, eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: at,
  metadata: JSON.stringify({ step, gmailMessageId: id, providerMessageId: id, gmailThreadId: thread, senderInboxId: INBOX }),
});
const plan = (messages, activities = [sent(1, '2026-10-27T13:00:00Z')], leads = [prospect]) => planMailboxEvents({
  observation: { messages, recovered: false }, gmail: {}, leads, activities, senderInboxId: INBOX, senderEmail: SENDER });

test('a hard bounce keeps its suppression and now records why, and for which send', async () => {
  const { events, suppressions } = await plan([noticeMessage('dsn-1', proofpointDbeb(prospect.email), '2026-10-27T13:05:00Z', ['INBOX'], 'thread-1')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'email_bounced');
  assert.deepEqual(suppressions.map(s => [s.email, s.reason]), [[prospect.email, 'bounce']]);
  const data = JSON.parse(events[0].metadata);
  assert.equal(data.deliveryClass, DELIVERY_CLASS.RECIPIENT_INVALID);
  assert.equal(data.bounceType, 'hard');
  assert.equal(data.dsnStatus, '5.4.1');
  assert.equal(data.smtpCode, '550');
  assert.match(data.diagnostic, /Recipient address rejected/);
  assert.equal(data.senderInboxId, INBOX);
  assert.equal(data.originalGmailMessageId, 'sent-1');
  assert.equal(data.step, 1);
  assert.equal(data.recipientSuppressed, true);
});

test('a Cisco notice filed in spam is a recorded bounce, not silence', async () => {
  const { events, suppressions } = await plan([noticeMessage('dsn-cisco', ciscoGateway(prospect.email), '2026-10-27T13:06:00Z', ['SPAM'])]);
  assert.deepEqual(events.map(e => e.eventType), ['email_bounced']);
  assert.equal(suppressions.length, 1);
  assert.equal(JSON.parse(events[0].metadata).originalGmailMessageId, 'sent-1', 'a new thread still finds its send');
});

test('two gateways reporting one failed delivery make one bounce row', async () => {
  const first = await plan([noticeMessage('dsn-a', proofpointDbeb(prospect.email), '2026-10-27T13:05:00Z'), noticeMessage('dsn-b', ciscoGateway(prospect.email), '2026-10-27T13:06:00Z')]);
  assert.equal(first.events.length, 1);
  const again = await plan([noticeMessage('dsn-c', proofpointDbeb(prospect.email), '2026-10-27T14:00:00Z')], [sent(1, '2026-10-27T13:00:00Z'), ...first.events]);
  assert.equal(again.events.length, 0);
});

test('a delay is recorded once across repeats and never suppresses or blocks', async () => {
  const notices = [noticeMessage('d1', delay(prospect.email), '2026-10-27T17:00:00Z'), noticeMessage('d2', delay(prospect.email), '2026-10-28T17:00:00Z')];
  const { events, suppressions } = await plan(notices);
  assert.deepEqual(events.map(e => e.eventType), [DELIVERY_DEFERRED_EVENT]);
  assert.deepEqual(suppressions, []);
  const data = JSON.parse(events[0].metadata);
  assert.equal(data.bounceType, 'soft');
  assert.equal(data.dsnStatus, '4.4.1');
  assert.equal(data.finalFailure, false);
  assert.equal(data.blocksLaterTouches, false);
  const activities = [sent(1, '2026-10-27T13:00:00Z'), ...events];
  assert.equal(unrecoveredTouchBlock({ id: 'L1' }, activities, 2), null);
  const repeat = await plan([noticeMessage('d3', delay(prospect.email), '2026-10-29T17:00:00Z')], activities);
  assert.equal(repeat.events.length, 0);
});

test('a final temporary failure is recorded without suppressing, and follow-ups stay eligible', async () => {
  const { events, suppressions } = await plan([noticeMessage('t1', finalTemporary(prospect.email), '2026-10-29T17:00:00Z')]);
  assert.deepEqual(events.map(e => e.eventType), [DELIVERY_FAILED_EVENT]);
  assert.deepEqual(suppressions, []);
  assert.equal(JSON.parse(events[0].metadata).deliveryClass, DELIVERY_CLASS.UNDELIVERED_TEMPORARY);
  assert.equal(unrecoveredTouchBlock({ id: 'L1' }, [sent(1, '2026-10-27T13:00:00Z'), ...events], 2), null);
});

test('a reputation refusal never suppresses, but the next touch does not chase it', async () => {
  const { events, suppressions } = await plan([noticeMessage('p1', reputationBlock(prospect.email), '2026-10-27T13:05:00Z')]);
  assert.deepEqual(events.map(e => e.eventType), [DELIVERY_FAILED_EVENT]);
  assert.deepEqual(suppressions, []);
  const data = JSON.parse(events[0].metadata);
  assert.equal(data.deliveryClass, DELIVERY_CLASS.POLICY_REJECTION);
  assert.equal(data.blocksLaterTouches, true);
  assert.equal(data.requiresHumanAttention, true);
  const activities = [sent(1, '2026-10-27T13:00:00Z'), ...events];
  assert.equal(provenFailedTouches(activities, 'L1').length, 1);
  assert.match(unrecoveredTouchBlock({ id: 'L1' }, activities, 2).reason, /Touch 1 provably failed/);
});

test('a code-less gateway notice is recorded and blocks the next touch without suppressing', async () => {
  const { events, suppressions } = await plan([noticeMessage('tm', trendMicro(prospect.email), '2026-10-27T13:05:00Z')]);
  assert.deepEqual(events.map(e => e.eventType), [DELIVERY_FAILED_EVENT]);
  assert.deepEqual(suppressions, []);
  assert.equal(JSON.parse(events[0].metadata).enhancedCode, null);
  assert.ok(unrecoveredTouchBlock({ id: 'L1' }, [sent(1, '2026-10-27T13:00:00Z'), ...events], 2));
});

test('a failure of Touch 2 names Touch 2', async () => {
  const activities = [sent(1, '2026-10-27T13:00:00Z'), sent(2, '2026-10-30T15:30:00Z', 'thread-1', 'sent-2')];
  const { events } = await plan([noticeMessage('m', microsoftNotFound(prospect.email), '2026-10-30T15:32:00Z', ['INBOX'], 'thread-1')], activities);
  const data = JSON.parse(events[0].metadata);
  assert.equal(data.step, 2);
  assert.equal(data.originalGmailMessageId, 'sent-2');
});

test('a warm-up failure matches no lead and records nothing', async () => {
  const { events, suppressions, ignored } = await plan([noticeMessage('w', finalTemporary('someone@warmup-pool.example'), '2026-10-27T13:05:00Z')]);
  assert.deepEqual(events, []);
  assert.deepEqual(suppressions, []);
  assert.equal(ignored[0].reason, 'unmatched_or_irrelevant');
});

test('a notice stays inside the client whose inbox received it', () => {
  const message = noticeMessage('dsn', proofpointDbeb('shared@corp.com'), '2026-10-27T13:05:00Z');
  const joleLeads = [{ id: 'J', email: 'other@corp.com', lastEmailedAt: '2026-10-27T13:00:00Z' }];
  const matched = matchMailboxMessages([message], { leads: joleLeads, activities: [], senderInboxId: INBOX, senderEmail: SENDER });
  assert.equal(matched.bounces.size, 0);
  assert.equal(matched.deliveryNotices.size, 0);
});

test('history stays as written: an old bounce row with no code still counts and is never rewritten', async () => {
  const legacy = { eventId: 'gmail-bounce:old', leadId: 'CE-L1', sourceLeadId: 'L1', email: prospect.email, eventType: 'email_bounced', occurredAt: '2026-10-27T13:01:00Z',
    metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: 'old', senderInboxId: INBOX }) };
  const { events } = await plan([noticeMessage('newer', proofpointDbeb(prospect.email), '2026-10-27T13:05:00Z')], [sent(1, '2026-10-27T13:00:00Z'), legacy]);
  assert.deepEqual(events, [], 'the same delivery is not bounced twice');
  assert.equal(JSON.parse(legacy.metadata).dsnStatus, undefined);
});

// ── client scope ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-01T20:00:00Z');
const observerRow = (id, health = 'healthy', error = '') => [id, '100', '2026-11-01T19:45:00Z', '2026-11-01T19:45:00Z', error, health, 'history', 'complete', '0', '', '', '', '', '', ''];
const OBSERVER_HEADER = ['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health', 'mode', 'bootstrapState', 'messagesObserved', 'recoveryActive', 'recoverySince', 'recoveryAnchor', 'recoveryThroughId', 'recoveryProcessed', 'backoffUntil'];
const joleSenders = ['jole_group_jorge', 'jole_team_jorge'].map(id => ({ id, email: `${id}@example.com`, clientId: 'jole', status: 'active', credentialConfigured: true, observerEnabled: true }));
const scalelabSenders = [{ id: 'primary', email: 'deins@scalelabai.ca', clientId: 'scalelab', status: 'active', credentialConfigured: true, observerEnabled: true }];
const reply = (id, senderInboxId) => ({ eventId: `gmail-reply:${id}`, eventType: 'positive_reply', occurredAt: '2026-10-30T12:00:00Z', metadata: JSON.stringify({ gmailMessageId: id, senderInboxId }) });

test("Jole's inbound health ignores every other client's mailbox and replies", () => {
  const health = clientInboundHealth({ clientId: 'jole', senders: [...joleSenders, ...scalelabSenders], now: NOW,
    observerRows: [OBSERVER_HEADER, observerRow('jole_group_jorge'), observerRow('jole_team_jorge'), observerRow('primary'), observerRow('tryscalelabai')],
    activities: Array.from({ length: 114 }, (_, i) => reply(`s${i}`, i % 2 ? 'primary' : 'tryscalelabai')) });
  assert.deepEqual(health.inboxes.map(i => i.senderInboxId), ['jole_group_jorge', 'jole_team_jorge']);
  assert.equal(health.pendingManagedHandler, 0);
  assert.equal(health.verdict, 'healthy');
  assert.equal(health.receivingNormally, true);
});

test("a real pending Jole reply still warns, and a real Jole observer error is not hidden", () => {
  const pending = clientInboundHealth({ clientId: 'jole', senders: joleSenders, now: NOW,
    observerRows: [OBSERVER_HEADER, observerRow('jole_group_jorge'), observerRow('jole_team_jorge')],
    activities: [reply('j1', 'jole_group_jorge')] });
  assert.equal(pending.verdict, 'warning');
  assert.equal(pending.pendingManagedHandler, 1);
  const broken = clientInboundHealth({ clientId: 'jole', senders: joleSenders, now: NOW,
    observerRows: [OBSERVER_HEADER, observerRow('jole_group_jorge', 'error', 'invalid_grant'), observerRow('jole_team_jorge')], activities: [] });
  assert.equal(broken.verdict, 'critical');
  assert.equal(broken.inboxes[0].lastError, 'invalid_grant');
  const missing = clientInboundHealth({ clientId: 'jole', senders: joleSenders, now: NOW, observerRows: [OBSERVER_HEADER, observerRow('jole_team_jorge')], activities: [] });
  assert.equal(missing.inboxes.length, 2, 'an inbox with no observer row is reported, not dropped');
  assert.equal(missing.verdict, 'critical');
});

// ── delivery health report ───────────────────────────────────────────────────

const { clientDeliveryHealth } = require('../integrations/clients/delivery-health');
const auditScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'audit-gmail-crm-sends.js'), 'utf8');

test('the delivery report separates classes, keeps history unclassified and ignores other clients', () => {
  const senders = [{ id: 'jole_a', email: 'a@one.example', clientId: 'jole' }, { id: 'jole_b', email: 'b@two.example', clientId: 'jole' }, { id: 'primary', email: 'x@scalelabai.ca', clientId: 'scalelab' }];
  const row = (eventType, lead, inbox, at, data = {}) => ({ eventId: eventType + ':' + lead + ':' + at, eventType, sourceLeadId: lead, occurredAt: at, metadata: JSON.stringify({ senderInboxId: inbox, ...data }) });
  const activities = [
    ...Array.from({ length: 50 }, (_, i) => row('initial_email_sent', 'A' + i, 'jole_a', '2026-11-02T14:00:00Z')),
    row('email_bounced', 'A1', 'jole_a', '2026-11-02T14:05:00Z'),
    row('email_bounced', 'A2', 'jole_a', '2026-11-02T14:05:00Z', { deliveryClass: 'recipient_invalid' }),
    row('email_bounced', 'A3', 'jole_a', '2026-11-02T14:05:00Z', { deliveryClass: 'recipient_routing_failure' }),
    row(DELIVERY_FAILED_EVENT, 'A4', 'jole_a', '2026-11-02T14:05:00Z', { deliveryClass: DELIVERY_CLASS.POLICY_REJECTION }),
    row(DELIVERY_DEFERRED_EVENT, 'A5', 'jole_a', '2026-11-02T14:05:00Z', { deliveryClass: DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY }),
    row('initial_email_sent', 'B1', 'jole_b', '2026-11-02T14:00:00Z'),
    row('initial_email_sent', 'S1', 'primary', '2026-11-02T14:00:00Z'),
    row('email_bounced', 'S1', 'primary', '2026-11-02T14:05:00Z', { deliveryClass: 'recipient_invalid' }),
  ];
  const report = clientDeliveryHealth({ clientId: 'jole', senders, activities });
  assert.equal(report.totals.firstTouches, 51);
  assert.equal(report.totals.hardBounces, 3);
  assert.equal(report.totals.unclassified, 1);
  assert.deepEqual(report.totals.bouncesByClass, { recipient_invalid: 1, recipient_routing_failure: 1 });
  assert.equal(report.totals.policyRejections, 1);
  assert.equal(report.totals.deferred, 1);
  assert.deepEqual(report.inboxes.map(i => i.senderInboxId), ['jole_a', 'jole_b']);
  const domain = report.domains.find(d => d.domain === 'one.example');
  assert.equal(domain.lastThreeSendDays.bouncedRecipients, 3);
  assert.equal(domain.lastThreeSendDays.bounceRatePct, 6);
  assert.equal(domain.lastThreeSendDays.flag, 'over_reduce_line');
  assert.equal(report.domains.find(d => d.domain === 'two.example').lastThreeSendDays.flag, 'too_few_first_touches');
  assert.equal(report.sends + report.writes, 0);
});

test('the send audit reaches a managed client inbox without gaining any way to change mail', () => {
  assert.match(auditScript, /--client=/);
  assert.match(auditScript, /withDefaultInboxes\(registry\)\.filter\(entry => entry\.clientId === CLIENT\)/);
  assert.match(auditScript, /CLIENT \? 'metadata' : 'full'/);
  assert.doesNotMatch(auditScript, /messages\.(?:send|modify|trash|delete|batchModify)|threads\.(?:modify|trash|delete)|labels\.(?:create|update|delete)/);
});

// ── ScaleLab keeps the rules it always had ───────────────────────────────────

const scalelabLead = { id: 'S1', email: 'sam@agency.com', company: 'Agency', lastEmailedAt: '2026-10-27T13:00:00Z' };
const scalelabPlan = messages => planMailboxEvents({ observation: { messages, recovered: false }, gmail: {}, leads: [scalelabLead],
  activities: [], senderInboxId: 'primary', senderEmail: 'deins@scalelabai.ca' });

test('a ScaleLab inbox still bounces and suppresses on any 5.x.x from a mailer-daemon', async () => {
  for (const payload of [reputationBlock(scalelabLead.email), proofpointDbeb(scalelabLead.email), tenantPolicy(scalelabLead.email)]) {
    const { events, suppressions } = await scalelabPlan([noticeMessage('s-dsn', payload, '2026-10-27T13:05:00Z')]);
    assert.deepEqual(events.map(e => e.eventType), ['email_bounced']);
    assert.equal(suppressions.length, 1);
  }
});

test('a ScaleLab inbox records no new delivery events and does not read gateway notices', async () => {
  for (const payload of [delay(scalelabLead.email), ciscoGateway(scalelabLead.email), trendMicro(scalelabLead.email)]) {
    const { events, suppressions } = await scalelabPlan([noticeMessage('s-n', payload, '2026-10-27T13:05:00Z')]);
    assert.deepEqual(events, []);
    assert.deepEqual(suppressions, []);
  }
  const lateFinal = await scalelabPlan([noticeMessage('s-f', finalTemporary(scalelabLead.email), '2026-10-27T13:05:00Z')]);
  assert.deepEqual(lateFinal.events.map(e => e.eventType), ['email_bounced'], 'a 4.x notice worded "permanently" keeps its old ScaleLab result');
});
