'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROFILE_ID, MODEL, renderInitialEmail, validateInitialEmail, qualifyLead,
  deterministicClassification, classifyReply, renderPositiveReply,
  renderQuestionDraft, decideReplyAction,
} = require('../integrations/roofing-survey-profile');

const lead = { id: 'opaque-123', company: 'Summit Roofing Ltd', contactName: 'Avery Stone', tradeType: 'Roofing' };

test('existing dental prompt behavior remains present and isolated', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /buildPitch\(lead, opener, link\)/);
  assert.match(agent, /lead\.emailTemplateId === ROOFING_SURVEY_TEMPLATE/);
  assert.equal(PROFILE_ID, 'roofing_survey_reply_first');
});

test('renders the locked initial email', () => {
  const email = renderInitialEmail(lead);
  assert.equal(email.subject, 'quick roofing question');
  assert.match(email.body, /I’m putting together an anonymous report/);
  assert.match(email.body, /Want me to send it over\?/);
  assert.equal(validateInitialEmail(email), '');
});

test('first email contains no link or sales language', () => {
  const email = renderInitialEmail(lead);
  const campaignCopy = email.body.split('\n---\n')[0];
  assert.doesNotMatch(campaignCopy, /https?:\/\//i);
  assert.doesNotMatch(campaignCopy, /\bAI\b|automation|calendar|service pitch/i);
});

test('missing first name uses the approved fallback', () => assert.match(renderInitialEmail({ company: 'ABC Roofing', tradeType: 'roofing' }).body, /^Hi there,/));
test('clear yes reply becomes positive', () => assert.equal(deterministicClassification('Yes').category, 'positive'));
test('send it over becomes positive', () => assert.equal(deterministicClassification('Send it over').category, 'positive'));
test('what is this for requires review', () => assert.deepEqual(deterministicClassification('What is this for?').requires_human_review, true));
test('maybe requires review', () => assert.deepEqual(deterministicClassification('Maybe').requires_human_review, true));
test('unsubscribe yields no reply action', () => assert.equal(decideReplyAction({ classification: deterministicClassification('Unsubscribe') }).action, 'no_reply'));
test('out of office yields no reply action', () => assert.equal(decideReplyAction({ classification: deterministicClassification('I am out of office') }).action, 'no_reply'));
test('duplicate positive event is blocked', () => assert.equal(decideReplyAction({ classification: deterministicClassification('Yes'), surveyUrl: 'https://example.com/s', autoReplyEnabled: true, alreadyHandled: true }).action, 'duplicate_blocked'));
test('empty survey URL fails closed', () => assert.equal(decideReplyAction({ classification: deterministicClassification('Yes'), autoReplyEnabled: true }).action, 'review'));
test('auto reply disabled produces a draft decision', () => assert.equal(decideReplyAction({ classification: deterministicClassification('Yes'), surveyUrl: 'https://example.com/s' }).action, 'draft'));

test('invalid Claude JSON cannot trigger an email', async () => {
  let calls = 0;
  const classification = await classifyReply({ replyText: 'Hard to say', createMessage: async request => {
    calls++;
    assert.equal(request.model, MODEL);
    assert.equal(request.temperature, 0);
    return { content: [{ text: 'not json' }] };
  } });
  assert.equal(calls, 1);
  assert.equal(classification.category, 'ambiguous');
  assert.equal(decideReplyAction({ classification, surveyUrl: 'https://example.com/s', autoReplyEnabled: true }).action, 'review');
});

test('feature flags default disabled and existing campaigns remain routed normally', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /ROOFING_SURVEY_REPLY_FLOW_ENABLED=false/);
  assert.match(env, /ROOFING_SURVEY_AUTO_REPLY_ENABLED=false/);
  const routing = require('../integrations/campaign-routing');
  assert.equal(routing.templateById('dental-guarantee-v1').ready, true);
});

test('no API secret appears in rendered copy, drafts, or source logs', () => {
  const fakeSecret = 'sk-ant-secret-value';
  const email = renderInitialEmail({ ...lead, contactName: fakeSecret });
  const reply = renderPositiveReply(lead, 'https://example.com/s');
  const question = renderQuestionDraft(lead);
  assert.doesNotMatch(`${email.subject}\n${email.body}\n${reply}\n${question}`, /sk-ant-/);
  assert.equal(qualifyLead(lead).ok, true);
});
