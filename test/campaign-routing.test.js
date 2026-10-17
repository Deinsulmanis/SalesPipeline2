'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EMAIL_TEMPLATES, normalizeNiche, campaignVersionsForRoute, validateCampaignVersionRoute, validateRoute, routedLeadReady } = require('../integrations/campaign-routing');

const primary = { id: 'primary', email: 'primary@example.com', sendEligible: true, deliveryImplemented: true };
const warming = { id: 'warm', email: 'warm@example.com', sendEligible: false, deliveryImplemented: false };

test('niche normalization keeps dental and roofing separated', () => {
  assert.equal(normalizeNiche('Dentists'), 'dental');
  assert.equal(normalizeNiche('Roofer'), 'roofing');
  assert.notEqual(normalizeNiche('Roofer'), normalizeNiche('Dentist'));
});

test('route validation requires compatible ready copy and delivery-capable inbox', () => {
  // The dental offer is retired (2026-09-30): no dental route validates, whatever the inbox or copy.
  const dental = validateRoute({ niche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes: [primary] });
  assert.equal(dental.ok, false);
  assert.equal(dental.code, 'offer_retired');
  // Roofing was retired the same day: no roofing route validates either, even with readiness waived.
  for (const requireReady of [true, false]) {
    assert.equal(validateRoute({ niche: 'roofing', senderInboxId: 'primary', emailTemplateId: 'roofing-survey-v1', inboxes: [primary], requireReady }).code, 'offer_retired');
  }
  // The mechanics, on the one live routed offer (staffing).
  const staffingTemplate = 'industrial-staffing-employer-v1';
  assert.match(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes: [primary] }).reason, /cannot be used/);
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary', emailTemplateId: staffingTemplate, inboxes: [primary], requireReady: false }).ok, true);
  assert.match(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'warm', emailTemplateId: staffingTemplate, inboxes: [warming], requireReady: false }).reason, /not eligible/);
});

test('legacy leads retain behavior while newly routed leads fail closed', () => {
  assert.deepEqual(routedLeadReady({}), { ok: true, legacy: true });
  assert.match(routedLeadReady({ routingRequired: 'true', leadNiche: 'industrial_staffing' }).reason, /incomplete/);
  assert.equal(routedLeadReady({ routingRequired: 'true', leadNiche: 'roofing' }).code, 'offer_retired');
  // Retired dental fails closed routed or legacy — the legacy bypass never reaches it.
  assert.equal(routedLeadReady({ routingRequired: 'true', leadNiche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1' }).code, 'offer_retired');
  assert.equal(routedLeadReady({ routingRequired: '', tradeType: 'Dentist', campaign: 'Surrey Dentists' }).code, 'offer_retired');
});

test('agent guards initial and follow-up selection through canonical sender routing', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /routedLeadReady\(l\)/);
  assert.match(agent, /routedLeadCanUseCurrentSender\(l\)/);
  assert.match(agent, /chooseSender\(/);
  assert.match(agent, /expectedSenderId: selectedSender\.id/);
  assert.match(agent, /process\.env\.GMAIL_TOKEN_JSON/);
});

test('campaign import and queue UI require durable routing choices', () => {
  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(browser, /id="campaign-niche-input"/);
  assert.match(browser, /id="queue-route-inbox"/);
  assert.match(browser, /id="queue-route-template"/);
  assert.match(browser, /id="queue-route-version"/);
  assert.match(browser, /id="ce-niche-filter"/);
  assert.match(browser, /\/api\/coldemail\/queue/);
  assert.match(server, /'leadNiche','senderInboxId','emailTemplateId','routingRequired'/);
  assert.match(server, /'intendedCampaignVersion'/);
  assert.match(server, /app\.post\('\/api\/coldemail\/queue', requireAuth/);
});

test('campaign versions are derived from the canonical registry and reject incompatible copy', () => {
  // Every dental version is retired, so none is offered and none validates.
  assert.deepEqual(campaignVersionsForRoute({ niche: 'dental' }).map(version => version.id), []);
  assert.match(validateCampaignVersionRoute({ niche: 'dental', emailTemplateId: 'dental-guarantee-v1', campaignVersionId: 'dental_v3_pay_per_booking' }).reason, /approved registered campaign version/);
  assert.deepEqual(campaignVersionsForRoute({ niche: 'roofing' }).map(version => version.id), [], 'roofing retired 2026-09-30');
  assert.deepEqual(campaignVersionsForRoute({ niche: 'industrial_staffing' }).map(version => version.id), ['industrial_staffing_employer_acquisition_v1']);
  assert.match(validateCampaignVersionRoute({ niche: 'industrial_staffing', emailTemplateId: 'dental-guarantee-v1', campaignVersionId: 'industrial_staffing_employer_acquisition_v1' }).reason, /does not use/);
  assert.match(validateCampaignVersionRoute({ niche: 'dental', emailTemplateId: 'industrial-staffing-employer-v1', campaignVersionId: 'industrial_staffing_employer_acquisition_v1' }).reason, /cannot be used/);
});

test('queue preview and submitted payload use the same explicit campaign route', () => {
  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(browser, /versionText[\s\S]{0,220}templateText[\s\S]{0,80}inboxText/);
  assert.match(browser, /JSON\.stringify\(\{ ids, senderInboxId, campaignVersionId, emailTemplateId \}\)/);
});

test('roofing copy is registered as a one-step niche-specific profile and disabled by default', () => {
  const roofing = EMAIL_TEMPLATES.find(template => template.id === 'roofing-survey-v1');
  assert.equal(roofing.ready, false);
  assert.equal(roofing.niche, 'roofing');
  assert.equal(roofing.sequenceSteps, 1);
  assert.equal(roofing.profile, 'roofing_survey_reply_first');
});
