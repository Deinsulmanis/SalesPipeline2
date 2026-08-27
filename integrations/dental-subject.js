'use strict';

const crypto = require('crypto');

const SUBJECT_VARIANTS = Object.freeze({
  invisalign: Object.freeze([
    'quick question about Invisalign',
    'question about Invisalign',
  ]),
  implants: Object.freeze([
    'question about dental implants',
    'quick question about implants',
  ]),
  emergency: Object.freeze([
    'quick question about emergency patients',
    'question about emergency dental calls',
  ]),
  cosmetic: Object.freeze([
    'question about cosmetic dentistry',
    'quick question about cosmetic dentistry',
  ]),
  orthodontics: Object.freeze([
    'quick question about orthodontics',
    'question about orthodontic patients',
  ]),
  sedation: Object.freeze([
    'quick question about sedation',
    'question about sedation dentistry',
  ]),
  pediatric: Object.freeze([
    'quick question about pediatric patients',
    'question about pediatric dentistry',
  ]),
  accepting_new_patients: Object.freeze([
    'quick question about new patients',
    'question about new patient calls',
  ]),
  published_hours: Object.freeze([
    'question about after-hours calls',
    'quick question about your office hours',
  ]),
});

const SERVICE_ANGLES = new Set([
  'invisalign', 'implants', 'emergency', 'cosmetic',
  'orthodontics', 'sedation', 'pediatric',
]);
const OPERATIONAL_ANGLES = new Set(['accepting_new_patients', 'published_hours']);
const PROMOTIONAL_PATTERN = /\b(?:guarantee(?:d)?|pricing|price|you don['’]?t pay|you do not pay|3\s+(?:new\s+)?patients?|30\s+days?|AI receptionist|ROI|return on investment|limited[- ]time|special offer)\b/i;
const ARTIFACT_PATTERN = /\b(?:undefined|null)\b|\[object Object\]|\{\{[^}\n]+\}\}|\$\{[^}\n]+\}|<<[^>\n]+>>/i;
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stableChoice(lead, angleId, variants) {
  const key = `${lead.id || lead.email || lead.company || ''}|subject|${angleId}`;
  const byte = crypto.createHash('sha1').update(key).digest()[0];
  return variants[byte % variants.length];
}

function firstNameFor(lead, personalization) {
  return clean(personalization?.profile?.contactFirstName || lead.first || String(lead.contactName || '').split(/\s+/)[0]);
}

function practiceFallback(company) {
  const name = clean(company);
  const candidate = `quick question about ${name}`;
  return name && candidate.split(/\s+/).length <= 7 && candidate.length <= 60
    ? candidate
    : 'quick question about your practice';
}

function allowedSubjectsFor({ lead = {}, company = '', personalization } = {}) {
  const angleId = personalization?.angle?.id || 'generic';
  if (SUBJECT_VARIANTS[angleId]) return [...SUBJECT_VARIANTS[angleId]];
  if (angleId === 'city') return [practiceFallback(company || personalization?.profile?.practiceName || lead.company)];
  const first = firstNameFor(lead, personalization);
  return first ? [`quick question, ${first}`] : ['quick question'];
}

function subjectLevel(angleId) {
  if (SERVICE_ANGLES.has(angleId)) return 3;
  if (OPERATIONAL_ANGLES.has(angleId)) return 2;
  if (angleId === 'city') return 1;
  return 0;
}

function validateDentalSubject({ subject, lead = {}, company = '', personalization } = {}) {
  const value = clean(subject);
  const angleId = personalization?.angle?.id || 'generic';
  const fact = personalization?.angle?.fact || null;
  const allowedSubjects = allowedSubjectsFor({ lead, company, personalization });
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const words = value ? value.split(/\s+/) : [];

  if (!value) add('empty_subject', 'subject is empty');
  if (value.length > 60 || words.length > 7) add('subject_length', 'subject exceeds the dental campaign length limit');
  if (PROMOTIONAL_PATTERN.test(value)) add('promotional_subject', 'subject contains promotional or offer language');
  if (ARTIFACT_PATTERN.test(value)) add('subject_artifact', 'subject contains an unresolved placeholder or runtime artifact');
  if (EMOJI_PATTERN.test(value)) add('subject_emoji', 'subject contains an emoji');
  if (/!!!|[!?.,;:]{2,}|[\r\n]/.test(String(subject || ''))) add('subject_punctuation', 'subject contains malformed or spammy punctuation');
  if ((value.match(/[.!?]/g) || []).length > 1 || /[.!?].+\S/.test(value)) add('subject_sentences', 'subject contains multiple sentences');
  const letters = value.match(/[A-Za-z]/g) || [];
  const capitals = value.match(/[A-Z]/g) || [];
  if (letters.length >= 6 && capitals.length / letters.length > 0.55) add('subject_caps', 'subject contains excessive capitalization');
  if (/^(?:re|fwd?)\s*:/i.test(value)) add('deceptive_subject', 'subject falsely implies an existing conversation');

  if (angleId !== 'city' && angleId !== 'generic') {
    if (!fact || fact.verified !== true || fact.type !== angleId || !String(fact.id || '').startsWith('site:')) {
      add('unsupported_subject_angle', 'subject angle is not backed by the selected verified fact');
    }
  }
  if (!allowedSubjects.includes(value)) add('subject_angle_mismatch', 'subject does not match the selected body personalization angle');

  return { valid: errors.length === 0, errors, subject: value, angleId, level: subjectLevel(angleId), allowedSubjects };
}

function buildDentalSubject({ lead = {}, company = '', personalization } = {}) {
  const angleId = personalization?.angle?.id || 'generic';
  const variants = allowedSubjectsFor({ lead, company, personalization });
  const subject = stableChoice(lead, angleId, variants);
  const validation = validateDentalSubject({ subject, lead, company, personalization });
  return {
    subject: validation.subject,
    level: validation.level,
    angleId,
    factId: personalization?.angle?.fact?.id || '',
    validation,
  };
}

module.exports = {
  SUBJECT_VARIANTS,
  SERVICE_ANGLES,
  OPERATIONAL_ANGLES,
  PROMOTIONAL_PATTERN,
  allowedSubjectsFor,
  subjectLevel,
  validateDentalSubject,
  buildDentalSubject,
};
