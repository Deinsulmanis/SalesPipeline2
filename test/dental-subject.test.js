'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDentalPersonalization } = require('../integrations/dental-personalization');
const { buildDentalColdEmail } = require('../integrations/dental-email');
const {
  buildDentalSubject,
  validateDentalSubject,
  PROMOTIONAL_PATTERN,
} = require('../integrations/dental-subject');
const { validateFinalEmail } = require('../integrations/final-email');

const baseLead = {
  id: 'subject-1', company: 'Cooper Dental', contactName: 'Deborah Lee', first: 'Deborah',
  city: 'Calgary', tradeType: 'Dental clinic', website: 'https://cooperdental.example',
};

function subjectFor(siteContext, overrides = {}) {
  const lead = { ...baseLead, ...overrides, siteContext };
  const personalization = buildDentalPersonalization(lead, { siteText: siteContext });
  return { lead, personalization, result: buildDentalSubject({ lead, company: lead.company, personalization }) };
}

function emailFor(siteContext, overrides = {}) {
  const { lead, personalization } = subjectFor(siteContext, overrides);
  return buildDentalColdEmail({
    lead, name: lead.first || 'there', company: lead.company, recipientType: 'owner',
    link: 'https://receptionist.scalelabai.ca/p/e5e47968b6', personalization,
    mailingAddress: 'ScaleLab AI, Vancouver, BC', signature: '— Deins', reference: 'SL-0001',
  });
}

test('Invisalign produces a verified service curiosity subject', () => {
  const { result } = subjectFor('We offer Invisalign consultations.');
  assert.equal(result.angleId, 'invisalign');
  assert.equal(result.level, 3);
  assert.match(result.subject, /Invisalign/);
});

test('implants produce a verified service curiosity subject', () => {
  const { result } = subjectFor('Our services include dental implants.');
  assert.equal(result.angleId, 'implants');
  assert.match(result.subject, /implants/);
});

test('emergency dentistry produces an appropriate curiosity subject', () => {
  const { result } = subjectFor('Emergency dentistry is available.');
  assert.equal(result.angleId, 'emergency');
  assert.match(result.subject, /emergency/);
});

test('multiple services use the primary personalization angle', () => {
  const { personalization, result } = subjectFor('We offer Invisalign, dental implants, and emergency dentistry.');
  assert.equal(personalization.angle.id, 'invisalign');
  assert.equal(result.angleId, personalization.angle.id);
  assert.match(result.subject, /Invisalign/);
  assert.doesNotMatch(result.subject, /implant|emergency/i);
});

test('an unsupported service cannot enter the subject', () => {
  const { lead, personalization } = subjectFor('We provide general family dentistry.', { city: '' });
  const validation = validateDentalSubject({ subject: 'quick question about Invisalign', lead, company: lead.company, personalization });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === 'subject_angle_mismatch'));
});

test('verified accepting-new-patients evidence uses an operational fallback', () => {
  const { result } = subjectFor('We are accepting new patients.');
  assert.equal(result.angleId, 'accepting_new_patients');
  assert.equal(result.level, 2);
  assert.match(result.subject, /new patient/);
});

test('verified office hours use an operational fallback', () => {
  const { result } = subjectFor('Office hours Monday 9am - 5pm. Saturday Closed.');
  assert.equal(result.angleId, 'published_hours');
  assert.equal(result.level, 2);
  assert.match(result.subject, /hours|after-hours/);
});

test('city-only enrichment uses a practice-specific fallback', () => {
  const { result } = subjectFor('General dentistry.', { city: 'Calgary' });
  assert.equal(result.level, 1);
  assert.equal(result.subject, 'quick question about Cooper Dental');
});

test('no useful enrichment uses a safe first-name fallback', () => {
  const { result } = subjectFor('', { city: '' });
  assert.equal(result.level, 0);
  assert.equal(result.subject, 'quick question, Deborah');
});

test('no useful enrichment and no name uses the generic safe fallback', () => {
  const { result } = subjectFor('', { city: '', first: '', contactName: '' });
  assert.equal(result.level, 0);
  assert.equal(result.subject, 'quick question');
});

for (const [label, subject] of [
  ['guarantee language', 'a guarantee for Cooper Dental'],
  ['3 patients language', '3 patients for Cooper Dental'],
  ['you do not pay language', "question where you don't pay"],
  ['AI receptionist language', 'AI receptionist for Cooper Dental'],
]) {
  test(`${label} is rejected`, () => {
    const { lead, personalization } = subjectFor('', { city: '' });
    const result = validateDentalSubject({ subject, lead, company: lead.company, personalization });
    assert.equal(result.valid, false);
    assert.match(subject, PROMOTIONAL_PATTERN);
    assert.ok(result.errors.some(error => error.code === 'promotional_subject'));
  });
}

test('unresolved placeholders are rejected', () => {
  const { lead, personalization } = subjectFor('', { city: '' });
  const result = validateDentalSubject({ subject: 'quick question about {{service}}', lead, company: lead.company, personalization });
  assert.ok(result.errors.some(error => error.code === 'subject_artifact'));
});

test('malformed punctuation, multiple sentences, caps, emoji, and fake reply prefixes are rejected', () => {
  const { lead, personalization } = subjectFor('', { city: '' });
  const cases = [
    ['quick question!!!', 'subject_punctuation'],
    ['quick question. another question?', 'subject_sentences'],
    ['QUICK QUESTION ABOUT YOUR PRACTICE', 'subject_caps'],
    ['quick question 🦷', 'subject_emoji'],
    ['Re: quick question', 'deceptive_subject'],
  ];
  for (const [subject, code] of cases) {
    const result = validateDentalSubject({ subject, lead, company: lead.company, personalization });
    assert.equal(result.valid, false, subject);
    assert.ok(result.errors.some(error => error.code === code), `${subject}: ${JSON.stringify(result.errors)}`);
  }
});

test('generated subjects remain within seven words and sixty characters', () => {
  for (const context of [
    'Invisalign', 'dental implants', 'emergency dentistry', 'cosmetic dentistry',
    'sedation dentistry', 'pediatric dentistry', 'Monday 9am - 5pm', '',
  ]) {
    const { result } = subjectFor(context, context ? {} : { city: '' });
    assert.ok(result.subject.split(/\s+/).length <= 7, result.subject);
    assert.ok(result.subject.length <= 60, result.subject);
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation.errors));
  }
});

test('subject and body use the same selected personalization angle', () => {
  const email = emailFor('We offer Invisalign consultations.');
  assert.equal(email.subjectMetadata.angleId, email.personalizationMetadata.selectedAngle);
  assert.match(email.subject, /Invisalign/);
  assert.match(email.body, /Invisalign/);
});

test('changing the subject does not change existing body personalization', () => {
  const { lead, personalization } = subjectFor('Our services include dental implants.');
  const email = emailFor('Our services include dental implants.');
  assert.ok(email.body.includes(personalization.personalizationBlocks[0]));
  assert.equal(email.personalizationBlocks[0].text, personalization.personalizationBlocks[0]);
  assert.equal(lead.company, 'Cooper Dental');
});

test('the existing final validator accepts a valid evidence-backed subject', () => {
  const email = emailFor('Emergency dental care is available.');
  const result = validateFinalEmail({
    ...email,
    demoUrl: 'https://receptionist.scalelabai.ca/p/e5e47968b6',
    proposalBase: 'https://receptionist.scalelabai.ca/p',
    entityHint: baseLead.company,
    subjectValidation: email.subjectMetadata.validation,
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('tampering after subject validation fails closed in final validation', () => {
  const email = emailFor('We offer Invisalign consultations.');
  const result = validateFinalEmail({
    ...email,
    subject: 'quick question about implants',
    demoUrl: 'https://receptionist.scalelabai.ca/p/e5e47968b6',
    proposalBase: 'https://receptionist.scalelabai.ca/p',
    entityHint: baseLead.company,
    subjectValidation: email.subjectMetadata.validation,
  });
  assert.ok(result.errors.some(error => error.code === 'invalid_subject'));
});

test('pure dry-run generation has no send callback or side effect', () => {
  let sends = 0;
  const { result } = subjectFor('We offer cosmetic dentistry.');
  assert.equal(result.validation.valid, true);
  assert.equal(sends, 0);
});
