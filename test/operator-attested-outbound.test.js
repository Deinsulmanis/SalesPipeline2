'use strict';

// Recording a manual email that was NOT an answer.
//
// human-outbound.js refuses to record an outbound message in a thread the
// prospect never wrote into, and that refusal is load-bearing: the first
// version of the module lacked it and proposed a "human response" for every
// automated cold email in the mailbox, which would have marked the whole cold
// campaign as personally answered and silently stopped outreach.
//
// The four Smili follow-ups sent by hand on Sep 15 are exactly that shape —
// replies into the original cold threads, with no inbound message anywhere in
// them. They are real and they must be visible to the CRM, so the refusal is
// not removed. Instead the operator ATTESTS specific provider message ids, one
// by one. A sweep can never attest anything; only a caller naming exact ids can.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planOutboundActivity, planHumanOutboundIngestion, OUTCOME, MATCH, HUMAN_OUTBOUND_EVENT,
} = require('../integrations/human-outbound');

const lead = {
  id: 'mstpu1fb8hj6s3dhrwx', company: 'Smili Dental - Midtown', email: 'info@mtsmili.test',
};
const leadsByEmail = new Map([[lead.email, lead]]);
const message = {
  id: '1a0a693938f5471a', threadId: '1a01afc6869786fe',
  to: [lead.email], subject: 'Re: A quick demo I built for Smili Dental',
  sentAt: '2026-09-15T19:38:04.000Z',
};
const base = { leadsByEmail, leadIdByThread: new Map(), threadsWithInbound: new Set(), existingActivitiesByLead: new Map() };
const attested = { ...base, attestedMessageIds: new Set([message.id]) };

test('without attestation an outbound in a silent cold thread is still refused', () => {
  const plan = planOutboundActivity(message, base);
  assert.equal(plan.outcome, OUTCOME.NOT_A_RESPONSE);
  assert.equal(plan.activity, null);
});

test('a sweep cannot attest anything — the whole batch stays refused', () => {
  const swept = planHumanOutboundIngestion([message], base);
  assert.equal(swept.proposedCount, 0);
  assert.equal(swept.byOutcome[OUTCOME.NOT_A_RESPONSE], 1);
});

test('an attested message id is recorded as canonical human outbound', () => {
  const plan = planOutboundActivity(message, attested);
  assert.equal(plan.outcome, OUTCOME.PROPOSED);
  assert.equal(plan.match, MATCH.EXACT_RECIPIENT);
  assert.equal(plan.activity.eventType, HUMAN_OUTBOUND_EVENT);
  assert.equal(plan.activity.eventId, `gmail-outbound:${message.id}`);
  assert.equal(plan.activity.sourceLeadId, lead.id);
  assert.equal(plan.activity.leadId, `CE-${lead.id}`);
  assert.equal(plan.activity.email, lead.email);
  assert.equal(plan.activity.occurredAt, message.sentAt);
  assert.equal(plan.activity.content, '');
});

test('the attested record says it was attested, and never that a prospect replied', () => {
  const { metadata } = planOutboundActivity(message, attested).activity;
  assert.equal(metadata.gmailMessageId, message.id);
  assert.equal(metadata.gmailThreadId, message.threadId);
  assert.equal(metadata.attested, true);
  assert.equal(metadata.trigger, 'operator_attested_outbound');
  assert.equal(metadata.isResponseToInbound, false);
  assert.equal(metadata.isProspectReply, false);
  assert.equal(metadata.autoSendAllowed, false);
  assert.equal(metadata.identityMutationAllowed, false);
  assert.equal(metadata.actor, 'human');
});

test('attesting one message does not unlock another', () => {
  const other = { ...message, id: 'DIFFERENT', threadId: message.threadId };
  assert.equal(planOutboundActivity(other, attested).outcome, OUTCOME.NOT_A_RESPONSE);
});

test('attestation never bypasses identity or provider proof', () => {
  const unknown = { ...message, to: ['stranger@nowhere.test'] };
  assert.equal(planOutboundActivity(unknown, { ...attested, attestedMessageIds: new Set([unknown.id]) }).outcome, OUTCOME.NO_MATCH);

  const noId = { ...message, id: '' };
  assert.equal(planOutboundActivity(noId, { ...attested, attestedMessageIds: new Set(['']) }).outcome, OUTCOME.NO_MATCH);

  const badLead = { ...lead, email: 'not an address' };
  const broken = { ...attested, leadsByEmail: new Map([['not an address', badLead]]) };
  const plan = planOutboundActivity({ ...message, to: ['not an address'] }, broken);
  assert.equal(plan.outcome, OUTCOME.UNUSABLE_IDENTITY);
});

test('an attested message already recorded proposes nothing a second time', () => {
  const existing = new Map([[lead.id, [{ eventId: `gmail-outbound:${message.id}`, eventType: HUMAN_OUTBOUND_EVENT }]]]);
  const plan = planOutboundActivity(message, { ...attested, existingActivitiesByLead: existing });
  assert.equal(plan.outcome, OUTCOME.ALREADY_RECORDED);
  assert.equal(plan.activity, null);
});

test('a genuine answer in a thread with inbound is unchanged and needs no attestation', () => {
  const withInbound = { ...base, threadsWithInbound: new Set([message.threadId]) };
  const plan = planOutboundActivity(message, withInbound);
  assert.equal(plan.outcome, OUTCOME.PROPOSED);
  assert.equal(plan.activity.metadata.trigger, 'gmail_outbound_ingestion');
  assert.equal(plan.activity.metadata.attested, false);
  assert.equal(plan.activity.metadata.isResponseToInbound, true);
});
