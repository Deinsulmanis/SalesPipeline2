'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverStaffingLead } = require('../integrations/staffing-personalization');
const { STAFFING_CAMPAIGN, renderStaffingEmail, validateStaffingEmail } = require('../integrations/staffing-campaign');
const { queueEligibility } = require('../integrations/outreach-queue');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const market = (value = 'manufacturing') => ({ id: 'm', kind: 'employer_market', value,
  evidence: [{ sourceUrl: 'https://example.com/services', quote: 'We staff manufacturers with industrial workers.' }] });
const role = { id: 'r', kind: 'role', value: 'welders', specificRole: true,
  evidence: [{ sourceUrl: 'https://example.com/roles', quote: 'We recruit welders.' }] };
const readyLead = (over = {}) => ({ id: 'salvage1', email: 'ada@example.com', company: 'Example Staffing', firstName: 'Ada',
  stage: 'Import', campaign: STAFFING_CAMPAIGN.name, leadNiche: 'industrial_staffing',
  routingRequired: 'true', notes: '', siteContext: '', emailStatus: '', emailStep: '', lastEmailedAt: '',
  campaign_notes: '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=NONE_REQUIRED;routing_ready=true]', ...over });

test('audited market supports safe fallback without claiming an unproven role pairing', () => {
  const result = recoverStaffingLead({ fitStatus: 'ICP_CONFIRMED', validatedFacts: [role, market()],
    contactUsable: true, safetyClear: true });
  assert.equal(result.personalizationStatus, 'SAFE_FALLBACK');
  assert.equal(result.routingReady, true);
  assert.match(result.opening, /manufacturing staffing/);
  assert.doesNotMatch(result.opening, /welders/);
  assert.deepEqual(result.facts.map(f => f.id), ['m']);
});

test('duplicate market copy does not discard a distinct valid lead', () => {
  const input = { fitStatus: 'ICP_CONFIRMED', validatedFacts: [market()], contactUsable: true, safetyClear: true };
  const first = recoverStaffingLead(input), second = recoverStaffingLead(input);
  assert.equal(first.opening, second.opening);
  assert.equal(second.routingReady, true);
});

test('confirmed industrial lead can use no-opener core offer when no market fact survives audit', () => {
  const result = recoverStaffingLead({ fitStatus: 'ICP_CONFIRMED', validatedFacts: [role],
    contactUsable: true, safetyClear: true });
  assert.equal(result.personalizationStatus, 'NONE_REQUIRED');
  assert.equal(result.opening, '');
  assert.equal(result.routingReady, true);
  const lead = readyLead();
  const email = renderStaffingEmail(lead, 1, STAFFING_RENDER_OPTIONS);
  assert.match(email.body, /generate qualified employer meetings/);
  assert.doesNotMatch(email.body, /that exact market|{{/);
  assert.equal(validateStaffingEmail(email, 1), null);
  assert.equal(queueEligibility(lead, { leads: [lead], ...STAFFING_RENDER_OPTIONS }).ok, true);
});

test('unreviewed blank opener and reviewed held leads remain blocked', () => {
  assert.throws(() => renderStaffingEmail(readyLead({ campaign_notes: '' }), 1, STAFFING_RENDER_OPTIONS), /no stored personalized opening/);
  for (const campaign_notes of [
    '[STAFFING_REVIEW_V1 fit=ICP_REJECT;personalization=FAILED;routing_ready=false]',
    '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=NONE_REQUIRED;routing_ready=false]',
    '[STAFFING_REVIEW_V1 fit=ICP_CONFIRMED;personalization=FAILED;routing_ready=true]',
  ]) {
    const lead = readyLead({ campaign_notes });
    assert.equal(queueEligibility(lead, { leads: [lead], ...STAFFING_RENDER_OPTIONS }).ok, false);
  }
});

test('true nonindustrial and unresolved agencies remain held regardless of copy', () => {
  for (const fitStatus of ['ICP_REJECT', 'ICP_UNRESOLVED']) {
    const result = recoverStaffingLead({ fitStatus, validatedFacts: [market()],
      contactUsable: true, safetyClear: true });
    assert.equal(result.routingReady, false);
    assert.equal(result.opening, '');
  }
});

test('email or compliance failure still blocks an otherwise valid lead', () => {
  for (const options of [{ contactUsable: false, safetyClear: true }, { contactUsable: true, safetyClear: false }]) {
    const result = recoverStaffingLead({ fitStatus: 'ICP_CONFIRMED', validatedFacts: [market()], ...options });
    assert.equal(result.routingReady, false);
  }
});
