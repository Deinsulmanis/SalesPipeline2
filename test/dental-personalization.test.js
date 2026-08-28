'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDentalColdEmail } = require('../integrations/dental-email');
const {
  buildDentalPersonalizationProfile,
  selectPersonalizationAngle,
  buildDentalPersonalization,
} = require('../integrations/dental-personalization');
const {
  validateFinalEmail,
  sendValidatedFinalEmail,
} = require('../integrations/final-email');

const baseLead = {
  id: 'dental-1', company: 'Cooper Dental', contactName: 'Deborah Lee', first: 'Deborah',
  city: 'Calgary', tradeType: 'Dental clinic', website: 'https://cooperdental.example',
};
const demoUrl = 'https://receptionist.scalelabai.ca/p/e5e47968b6';
const proposalBase = 'https://receptionist.scalelabai.ca/p';

function personalized(siteContext, overrides = {}) {
  return buildDentalPersonalization({ ...baseLead, ...overrides, siteContext }, { siteText: siteContext });
}

function finalEmail(personalization, overrides = {}) {
  const built = buildDentalColdEmail({
    lead: baseLead, name: 'Deborah', company: baseLead.company,
    recipientType: 'owner', link: demoUrl, personalization,
    mailingAddress: 'ScaleLab AI, Vancouver, BC', signature: '— Deins', reference: 'SL-0001',
  });
  return {
    ...built, demoUrl, proposalBase,
    entityHint: baseLead.company,
    ...overrides,
  };
}

test('verified Invisalign selects a relevant Invisalign angle', () => {
  const result = personalized('Services include Invisalign and teeth cleaning.');
  assert.equal(result.angle.id, 'invisalign');
  assert.match(result.personalizationBlocks[0], /Invisalign/);
  assert.match(result.personalizationBlocks[0], /new-patient|valuable/i);
});

test('verified implant service selects an implant-relevant angle', () => {
  const result = personalized('We provide dental implants and general care.');
  assert.equal(result.angle.id, 'implants');
  assert.match(result.personalizationBlocks[0], /Implant inquiries|dental implants/i);
});

test('emergency dentistry selects a time-sensitive angle', () => {
  const result = personalized('Emergency dentistry is available for urgent concerns.');
  assert.equal(result.angle.id, 'emergency');
  assert.match(result.personalizationBlocks[0], /time-sensitive|urgent/i);
});

test('verified office hours select after-hours relevance without claiming missed calls', () => {
  const result = personalized('Office Hours Monday 9am - 5pm. Saturday Closed.');
  assert.equal(result.angle.id, 'published_hours');
  assert.match(result.personalizationBlocks[0], /outside those hours|front desk is closed/i);
  assert.doesNotMatch(result.personalizationBlocks[0], /currently miss|missing calls|losing calls/i);
});

test('accepting-new-patients evidence selects the matching angle', () => {
  const result = personalized('We are accepting new patients of all ages.');
  assert.equal(result.angle.id, 'accepting_new_patients');
  assert.match(result.personalizationBlocks[0], /new patients|new-patient/i);
});

test('unsupported site fact never appears in generated copy', () => {
  const result = personalized('Our lobby has a blue aquarium and imported marble.', { city: '' });
  const copy = result.personalizationBlocks.join(' ');
  assert.equal(result.angle.id, 'generic');
  assert.doesNotMatch(copy, /aquarium|marble/i);
});

test('repeated mentions of one service create one verified fact and one concept', () => {
  const result = personalized('Invisalign consultations are available. Ask our team about Invisalign.');
  assert.equal(result.profile.facts.filter(f => f.type === 'invisalign').length, 1);
  assert.equal((result.personalizationBlocks.join(' ').match(/Invisalign/g) || []).length, 1);
});

test('multiple genuinely different facts select only the strongest angle', () => {
  const result = personalized('We offer Invisalign, emergency dentistry, and sedation dentistry.');
  assert.equal(result.angle.id, 'invisalign');
  assert.equal(result.personalizationBlocks.length, 1);
  assert.doesNotMatch(result.personalizationBlocks[0], /emergency|sedation/i);
});

test('Level 0 means no verified personalization fact', () => {
  const result = personalized('', { city: '' });
  assert.equal(result.level, 0);
  assert.equal(result.claims.length, 0);
});

test('Level 1 means basic verified location only', () => {
  const result = personalized('', { city: 'Calgary' });
  assert.equal(result.angle.id, 'city');
  assert.equal(result.level, 1);
});

test('Level 2 means verified fact plus controlled business implication', () => {
  const result = personalized('We offer Invisalign consultations.');
  assert.equal(result.level, 2);
  assert.equal(result.demo.capabilityId, 'generic_listen');
});

test('Level 3 requires a verified fact and matching confirmed demo capability', () => {
  const result = personalized('We welcome new patients.');
  assert.equal(result.level, 3);
  assert.equal(result.demo.capabilityId, 'new_patient_booking');
  assert.equal(result.demo.capabilityConfirmed, true);
});

test('specific demo CTA is selected only for supported behavior', () => {
  const result = personalized('Emergency dental care is available.');
  assert.equal(result.demo.capabilityId, 'urgent_dental_call');
  assert.match(result.demo.text, /urgent dental concern/i);
  assert.ok(result.demo.capabilityEvidence);
});

test('unsupported service behavior falls back to a generic listening CTA', () => {
  const result = personalized('We offer Invisalign consultations.');
  assert.equal(result.demo.capabilityId, 'generic_listen');
  assert.equal(result.demo.text, 'Give the dental answering and booking demo a quick listen.');
  assert.doesNotMatch(result.demo.text, /ask.*Invisalign/i);
});

test('personalization cannot restate or modify guarantee values', () => {
  const p = personalized('We offer Invisalign consultations.');
  const email = finalEmail(p);
  email.body = `${email.body}\n\nWe guarantee 4 new patient appointments.`;
  const validation = validateFinalEmail(email);
  assert.ok(validation.errors.some(e => e.code === 'offer_conflict'));
});

test('risk-reversal framing never invents financial ROI', () => {
  for (const text of [
    personalized('We offer Invisalign.').personalizationBlocks[0],
    personalized('Dental implants are available.').personalizationBlocks[0],
  ]) {
    assert.doesNotMatch(text, /\$|pays for|revenue of|worth \d|profit/i);
  }
});

test('missing enrichment falls back safely without invented facts', () => {
  const result = personalized('', { city: '' });
  assert.equal(result.angle.id, 'generic');
  assert.equal(result.metadata.evidence, null);
  assert.match(result.personalizationBlocks[0], /24\/7 answering and booking software demo for Cooper Dental/);
});

test('an old lead with only legacy siteContext still generates safely', () => {
  const oldLead = { id: 'old', company: 'Legacy Dental', city: 'Surrey', tradeType: 'Dentist', siteContext: 'Emergency dentistry and general care.', website: 'https://legacy.example' };
  const result = buildDentalPersonalization(oldLead);
  assert.equal(result.angle.id, 'emergency');
  assert.equal(result.claims[0].evidence.field, 'siteContext');
});

test('every factual claim retains source field, snippet, confidence, and optional URL', () => {
  const result = personalized('Our services include dental implants.');
  const claim = result.claims[0];
  assert.equal(claim.supported, true);
  assert.equal(claim.evidence.field, 'siteContext');
  assert.match(claim.evidence.snippet, /dental implants/i);
  assert.equal(claim.evidence.url, baseLead.website);
  assert.equal(claim.confidence, 'high');
});

test('unsupported personalization evidence blocks final validation', () => {
  const p = personalized('We offer Invisalign.');
  const email = finalEmail(p);
  email.personalizationClaims = [{ ...p.claims[0], supported: false }];
  assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'unsupported_personalization'));
});

test('specific demo copy without confirmed capability blocks final validation', () => {
  const p = personalized('We welcome new patients.');
  const email = finalEmail(p);
  email.demoCta = { ...p.demo, capabilityConfirmed: false, capabilityEvidence: '' };
  assert.ok(validateFinalEmail(email).errors.some(e => e.code === 'unsupported_demo_capability'));
});

test('valid personalized email reaches only the existing mocked send callback', async () => {
  const email = finalEmail(personalized('We welcome new patients.'));
  let calls = 0;
  const result = await sendValidatedFinalEmail(email, {}, async exact => {
    calls++;
    assert.equal(exact.body, email.body);
    return { data: { id: 'mock-personalized' } };
  });
  assert.equal(result.sent, true);
  assert.equal(calls, 1);
});

test('profile keeps reliable review signals for analytics but never uses them in copy', () => {
  const profile = buildDentalPersonalizationProfile({ ...baseLead, reviewCount: '128', rating: '4.8' }, { siteText: '' });
  const angle = selectPersonalizationAngle(profile);
  assert.deepEqual(profile.reviewSignal.reviewCount, 128);
  assert.notEqual(angle.id, 'review_signal');
});
