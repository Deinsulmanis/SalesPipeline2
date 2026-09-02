'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assembleFinalEmail, splitPersonalization, dedupePersonalizationBlocks,
  canonicalCta, validateFinalEmail, sendValidatedFinalEmail,
} = require('../integrations/final-email');

const demoUrl = 'https://receptionist.scalelabai.ca/p/e5e47968b6';
const proposalBase = 'https://receptionist.scalelabai.ca/p';
const offer = `If our AI receptionist doesn't book at least 3 new patient appointments, you don't pay.`;
const product = `I build the receptionist with Cooper Dental's actual appointments and services.`;

function validEmail(overrides = {}) {
  const demoIncluded = overrides.demoIncluded !== undefined ? overrides.demoIncluded : true;
  const cta = overrides.cta || canonicalCta({ demoIncluded, recipientType: 'owner' });
  const personalizationBlocks = overrides.personalizationBlocks || [{ text: 'I noticed Cooper Dental offers Invisalign.', factKey: 'service:invisalign' }];
  const body = overrides.body || assembleFinalEmail([
    'Hi Deborah,', offer, ...personalizationBlocks.map(x => x.text), product,
    demoIncluded ? `→ Here is the demo:\n${demoUrl}` : '', cta, '— Deins',
  ]);
  return {
    subject: overrides.subject || 'A guarantee for Cooper Dental', body,
    demoUrl: demoIncluded ? (overrides.demoUrl === undefined ? demoUrl : overrides.demoUrl) : (overrides.demoUrl || ''),
    proposalBase, demoIncluded, cta, personalizationBlocks,
    entityHint: 'Cooper Dental', requiredBlocks: [offer, product],
  };
}

test('assembler guarantees a blank line after the greeting', () => {
  const body = assembleFinalEmail(['Hi Deborah,', 'If our AI receptionist works...']);
  assert.equal(body, 'Hi Deborah,\n\nIf our AI receptionist works...');
  assert.doesNotMatch(body, /Hi Deborah,If/);
});

test('assembler normalizes line endings and duplicate blank-line explosions', () => {
  assert.equal(assembleFinalEmail(['  Hi Deborah,\r\n\r\n\r\n', '\r\nOffer\r\n']), 'Hi Deborah,\n\nOffer');
});

test('demo URL is isolated on its own line in a valid email', () => {
  const result = validateFinalEmail(validEmail());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.match(result.body, new RegExp(`\\n${demoUrl.replaceAll('.', '\\.')}\\n`));
});

test('CTA text concatenated to a demo URL is rejected', () => {
  const email = validEmail();
  email.body = email.body.replace(demoUrl, `${demoUrl}Worth`);
  const result = validateFinalEmail(email);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'demo_url_not_isolated'));
});

test('demo-present CTA never promises to send the already-included demo', () => {
  const cta = canonicalCta({ demoIncluded: true, recipientType: 'owner' });
  assert.doesNotMatch(cta, /send it over|send .*demo/i);
  assert.match(cta, /Let me know what you think/);
});

test('demo-absent CTA preserves the existing reply-and-send behavior', () => {
  const cta = canonicalCta({ demoIncluded: false, recipientType: 'owner' });
  assert.match(cta, /Reply and I'll send it over/);
  const result = validateFinalEmail(validEmail({ demoIncluded: false, cta }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('two versions of the same Invisalign fact collapse to one', () => {
  const blocks = dedupePersonalizationBlocks([
    'I see that Cooper Dental offers Invisalign, which is explicitly listed in their services section.',
    'I noticed Cooper Dental offers Invisalign among your services in downtown Calgary.',
  ], { entityHint: 'Cooper Dental' });
  assert.equal(blocks.length, 1);
  assert.equal((blocks.map(x => x.text).join(' ').match(/Invisalign/g) || []).length, 1);
});

test('two genuinely different personalization facts are preserved', () => {
  const blocks = dedupePersonalizationBlocks([
    { text: 'I noticed Cooper Dental offers Invisalign.', factKey: 'service:invisalign' },
    { text: 'I saw that the practice is open on Saturdays.', factKey: 'hours:saturday' },
  ], { entityHint: 'Cooper Dental' });
  assert.equal(blocks.length, 2);
});

test('multi-paragraph model output is split before personalization dedupe', () => {
  assert.equal(splitPersonalization('First fact.\n\nSecond fact.').length, 2);
});

test('unresolved placeholder blocks final validation', () => {
  const email = validEmail();
  email.body = email.body.replace('Cooper Dental', '{{company}}');
  const result = validateFinalEmail(email);
  assert.ok(result.errors.some(e => e.code === 'unresolved_artifact'));
});

test('undefined, null and object artifacts block final validation', () => {
  for (const artifact of ['undefined', 'null', '[object Object]']) {
    const email = validEmail();
    email.body = `${email.body}\n\n${artifact}`;
    assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'unresolved_artifact'), artifact);
  }
});

test('validation failure never invokes the send callback', async () => {
  let calls = 0;
  const bad = validEmail();
  bad.body = bad.body.replace(demoUrl, `${demoUrl}Worth`);
  const delivery = await sendValidatedFinalEmail(bad, {}, async () => { calls++; });
  assert.equal(delivery.sent, false);
  assert.equal(calls, 0);
});

test('a valid email follows the normal send callback path unchanged', async () => {
  let calls = 0;
  const delivery = await sendValidatedFinalEmail(validEmail(), {}, async exact => {
    calls++;
    assert.equal(exact.body, validEmail().body);
    return { data: { id: 'mock-only' } };
  });
  assert.equal(delivery.sent, true);
  assert.equal(calls, 1);
  assert.equal(delivery.result.data.id, 'mock-only');
});

test('contradictory CTA is rejected even when URL formatting is valid', () => {
  const email = validEmail();
  email.body = email.body.replace(email.cta, `Worth a look? Reply and I'll send it over.`);
  email.cta = '';
  assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'contradictory_cta'));
});

test('obvious duplicate personalization is rejected if it reaches final validation', () => {
  const p1 = 'I see that Cooper Dental offers Invisalign in its services section.';
  const p2 = 'I noticed Cooper Dental offers Invisalign for patients in Calgary.';
  const email = validEmail({ personalizationBlocks: [{ text: p1 }, { text: p2 }] });
  assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'duplicate_personalization'));
});

test('duplicate canonical CTA blocks final validation', () => {
  const email = validEmail();
  email.body = `${email.body}\n\n${email.cta}`;
  assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'cta_count'));
});

test('the production step-one path validates before its provider send', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const stepOne = source.slice(source.indexOf('// ── New sends (step 1)'), source.indexOf('// ── Follow-up refill'));
  assert.ok(stepOne.indexOf('validateColdEmail') < stepOne.indexOf('await deliverOrdinaryColdStep'));
  assert.match(stepOne, /if \(invalid\)[\s\S]*?continue;/);
});
