'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EMAIL_TEMPLATES, normalizeNiche, validateRoute, routedLeadReady } = require('../integrations/campaign-routing');

const primary = { id: 'primary', email: 'primary@example.com', sendEligible: true, deliveryImplemented: true };
const warming = { id: 'warm', email: 'warm@example.com', sendEligible: false, deliveryImplemented: false };

test('niche normalization keeps dental and roofing separated', () => {
  assert.equal(normalizeNiche('Dentists'), 'dental');
  assert.equal(normalizeNiche('Roofer'), 'roofing');
  assert.notEqual(normalizeNiche('Roofer'), normalizeNiche('Dentist'));
});

test('route validation requires compatible ready copy and delivery-capable inbox', () => {
  assert.equal(validateRoute({ niche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes: [primary] }).ok, true);
  assert.match(validateRoute({ niche: 'roofing', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes: [primary] }).reason, /cannot be used/);
  assert.match(validateRoute({ niche: 'roofing', senderInboxId: 'primary', emailTemplateId: 'roofing-survey-v1', inboxes: [primary] }).reason, /workflow is disabled/);
  assert.equal(validateRoute({ niche: 'roofing', senderInboxId: 'primary', emailTemplateId: 'roofing-survey-v1', inboxes: [primary], requireReady: false }).ok, true);
  assert.match(validateRoute({ niche: 'dental', senderInboxId: 'warm', emailTemplateId: 'dental-guarantee-v1', inboxes: [warming] }).reason, /not eligible/);
});

test('legacy leads retain behavior while newly routed leads fail closed', () => {
  assert.deepEqual(routedLeadReady({}), { ok: true, legacy: true });
  assert.match(routedLeadReady({ routingRequired: 'true', leadNiche: 'dental' }).reason, /incomplete/);
  assert.equal(routedLeadReady({ routingRequired: 'true', leadNiche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1' }).ok, true);
});

test('agent guards initial and follow-up selection without changing legacy sender credentials', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /routedLeadReady\(l\)/);
  assert.match(agent, /routedLeadCanUseCurrentSender\(l\)/);
  assert.match(agent, /lead\.senderInboxId === 'primary'/);
  assert.match(agent, /process\.env\.GMAIL_TOKEN_JSON/);
});

test('campaign import and queue UI require durable routing choices', () => {
  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(browser, /id="campaign-niche-input"/);
  assert.match(browser, /id="queue-route-inbox"/);
  assert.match(browser, /id="queue-route-template"/);
  assert.match(browser, /id="ce-niche-filter"/);
  assert.match(browser, /\/api\/coldemail\/queue/);
  assert.match(server, /'leadNiche','senderInboxId','emailTemplateId','routingRequired'/);
  assert.match(server, /app\.post\('\/api\/coldemail\/queue', requireAuth/);
});

test('roofing copy is registered as a one-step niche-specific profile and disabled by default', () => {
  const roofing = EMAIL_TEMPLATES.find(template => template.id === 'roofing-survey-v1');
  assert.equal(roofing.ready, false);
  assert.equal(roofing.niche, 'roofing');
  assert.equal(roofing.sequenceSteps, 1);
  assert.equal(roofing.profile, 'roofing_survey_reply_first');
});
