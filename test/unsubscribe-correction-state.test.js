'use strict';

// Phase 1 conversation state must treat an opt-out released by the audited
// false-opt-out correction as no longer current, keep it visible as history,
// and never let anything else — an unrelated, reversed, forged or unproven
// correction — clear a real opt-out.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConversationState } = require('../integrations/conversation-state');
const { buildClassificationOverride, reverseOverride } = require('../integrations/reply-overrides');
const { correctionEventId, correctedOptOutMessageIds, CORRECTION_SOURCE } = require('../integrations/false-opt-out-correction');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const LEAD_ID = 'mu5sratzhkzhrw3yv8';
const FALSE_MESSAGE = '1a0d9adeb5af5f83';
const OVERRIDE_ID = 'reply-override:50b4510752ce2ff2bf8cb531';
const EMAIL = 'jordan@example-enterprise.test';
const NOW = '2026-10-01T15:00:00.000Z';
const RAW_REPLY = '<html><body dir="auto">If you only get paid for meetings I would like more info please&nbsp;<blockquote type="cite"><p>This is a commercial email. Not relevant? Reply &quot;unsubscribe&quot; and I won\'t follow up again.</p></blockquote></body></html>';

const lead = (over = {}) => ({ id: LEAD_ID, email: EMAIL, company: 'Example Enterprise',
  campaign: STAFFING_CAMPAIGN.name, leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, stage: 'Review', emailStatus: 'replied', emailStep: '1',
  notes: '[REPLY: Needs human] [MANUAL HOLD] [STAFFING HIGH]', senderInboxId: 'primary', clientId: 'scalelab', ...over });
const row = (eventType, eventId, metadata = {}, over = {}) => ({ eventId, leadId: `CE-${LEAD_ID}`, sourceLeadId: LEAD_ID,
  email: EMAIL, company: 'Example Enterprise', eventType, occurredAt: over.occurredAt || '2026-09-25T17:47:15.000Z',
  subject: over.subject || '', content: over.content || '', metadata: JSON.stringify(metadata) });

const falseOptOut = () => row('unsubscribe_reply', `gmail-reply:${FALSE_MESSAGE}`, { gmailMessageId: FALSE_MESSAGE,
  gmailThreadId: 't1', senderInboxId: 'primary', reason: 'unsubscribe_request', genuineHuman: true }, { content: RAW_REPLY });
function override({ messageId = FALSE_MESSAGE, id = OVERRIDE_ID, previousReason = 'unsubscribe_request', state = 'positive' } = {}) {
  const built = buildClassificationOverride({ leadId: `CE-${LEAD_ID}`, providerMessageId: messageId,
    previousState: 'negative', previousReason, state, reason: 'Prospect asked for more info; the opt-out came from our quoted footer.',
    by: 'Deins', at: '2026-09-25T20:54:05.249Z' });
  return row('reply_classification_override', id, built.record, { occurredAt: '2026-09-25T20:54:05.249Z' });
}
function correction({ messageId = FALSE_MESSAGE, overrideId = OVERRIDE_ID, eventId, by = 'Deins', source = CORRECTION_SOURCE,
  decision = 'release_false_opt_out', leadId = LEAD_ID } = {}) {
  return { ...row('false_opt_out_corrected', eventId || correctionEventId(leadId, messageId), {
    decision, source, correctedBy: by, correctedAt: '2026-09-26T02:57:21.338Z', gmailMessageId: messageId,
    originalEventId: `gmail-reply:${messageId}`, authorizedByOverrideId: overrideId, overrideBy: by,
    overrideState: 'positive', automationResumed: false }, { occurredAt: '2026-09-26T02:57:21.338Z' }),
  sourceLeadId: leadId, leadId: `CE-${leadId}` };
}
const realOptOut = (messageId, occurredAt) => row('unsubscribe_reply', `gmail-reply:${messageId}`,
  { gmailMessageId: messageId, gmailThreadId: 't1', senderInboxId: 'primary', reason: 'unsubscribe_request', genuineHuman: true },
  { occurredAt, content: 'Please unsubscribe me from this list.' });
const state = (activities, over = {}) => buildConversationState({ lead: lead(over), activities, now: NOW,
  config: { sequencesEnabled: true, sendingEnabled: true } });

test('1. a real unsubscribe with no correction is terminal', () => {
  const s = state([realOptOut('real-1', '2026-09-25T17:47:15.000Z')]);
  assert.equal(s.terminalState.unsubscribed.value, true);
  assert.equal(s.terminalState.blockedBy, 'unsubscribed');
  assert.deepEqual(s.terminalState.unsubscribed.corrected, []);
});

test('2. a false unsubscribe released by the audited correction is not current; its history stays', () => {
  const s = state([falseOptOut(), override(), correction()]);
  assert.equal(s.terminalState.unsubscribed.value, false);
  assert.notEqual(s.terminalState.blockedBy, 'unsubscribed');
  assert.deepEqual(s.terminalState.unsubscribed.corrected.map(item => item.messageId), [FALSE_MESSAGE]);
  // The original classification and the correction are still in the conversation.
  assert.ok(s.turns.some(turn => turn.messageId === FALSE_MESSAGE && turn.direction === 'inbound'));
  assert.deepEqual([...correctedOptOutMessageIds([falseOptOut(), override(), correction()], LEAD_ID)], [FALSE_MESSAGE]);
});

test('3. a later real unsubscribe after a correction is terminal again', () => {
  const s = state([falseOptOut(), override(), correction(), realOptOut('real-2', '2026-09-29T10:00:00.000Z')]);
  assert.equal(s.terminalState.unsubscribed.value, true);
  assert.equal(s.terminalState.blockedBy, 'unsubscribed');
  assert.deepEqual(s.terminalState.unsubscribed.evidence.map(item => item.messageId), ['real-2']);
  assert.deepEqual(s.terminalState.unsubscribed.corrected.map(item => item.messageId), [FALSE_MESSAGE]);
});

test('4. an unrelated, reversed, forged or unproven correction cannot clear an unsubscribe', () => {
  const reversed = reverseOverride(JSON.parse(override().metadata), { by: 'Deins', reason: 'mistake' }).record;
  const cases = {
    'correction for another message': [falseOptOut(), override({ messageId: 'other' }), correction({ messageId: 'other' })],
    'no authorising override': [falseOptOut(), correction()],
    'override reversed': [falseOptOut(), override(), row('reply_classification_override', 'reply-override:reversal',
      { ...reversed, reverses: OVERRIDE_ID }, { occurredAt: '2026-09-27T00:00:00.000Z' }), correction()],
    'override names another message': [falseOptOut(), override({ messageId: 'other' }), correction()],
    'override does not correct an unsubscribe': [falseOptOut(), override({ previousReason: 'explicit_rejection' }), correction()],
    'override re-asserts a negative meaning': [falseOptOut(), override({ state: 'negative' }), correction()],
    'forged event id': [falseOptOut(), override(), correction({ eventId: 'false-opt-out-correction:forged' })],
    'wrong decision': [falseOptOut(), override(), correction({ decision: 'something_else' })],
    'wrong source': [falseOptOut(), override(), correction({ source: 'script' })],
    'no named human': [falseOptOut(), override(), correction({ by: '' })],
    'another lead\'s correction': [falseOptOut(), override(), correction({ leadId: 'someone-else' })],
  };
  for (const [name, activities] of Object.entries(cases)) {
    const s = state(activities);
    assert.equal(s.terminalState.unsubscribed.value, true, name);
    assert.equal(s.terminalState.blockedBy, 'unsubscribed', name);
  }
  // A lead still carrying the opt-out tag (the correction never released it) stays opted out.
  assert.equal(state([falseOptOut(), override(), correction()], { notes: '[REPLY: Unsubscribed] [MANUAL HOLD]' })
    .terminalState.unsubscribed.value, true);
  assert.equal(state([falseOptOut(), override(), correction()], { stage: 'Unsub' }).terminalState.unsubscribed.value, true);
});

test('5. Jole historical fixture: effective unsubscribe is false and the lead is held for a human', () => {
  const activities = [
    row('initial_email_sent', 'jole-initial', { step: 1 }, { occurredAt: '2026-09-25T17:32:07.433Z' }),
    falseOptOut(), override(), correction(),
    row('human_response_sent', 'h1', { gmailMessageId: '1a0d9e798f31afa3', gmailThreadId: 't1', senderInboxId: 'primary' },
      { occurredAt: '2026-09-25T18:50:29.000Z', content: 'Yes exactly. We only get paid when we generate a qualified employer meeting.' }),
  ];
  const s = state(activities);
  assert.equal(s.terminalState.unsubscribed.value, false);
  assert.equal(s.terminalState.isTerminal, false);
  assert.equal(s.terminalState.blockedBy, 'manual_hold');
  assert.equal(s.terminalState.unsubscribed.corrected.length, 1);
});
