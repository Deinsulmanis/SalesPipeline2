'use strict';

const ARTIFACT_PATTERN = /\b(?:undefined|null)\b|\[object Object\]|\{\{[^}\n]+\}\}|\$\{[^}\n]+\}|<<[^>\n]+>>/i;
const FUTURE_DEMO_PATTERN = /reply and I['’]ll send it over|I can send (?:you )?(?:the|a) demo|send (?:you )?(?:the|a) demo/i;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function normalizeBlock(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
}

function assembleFinalEmail(blocks) {
  return (blocks || []).map(normalizeBlock).filter(Boolean).join('\n\n');
}

function splitPersonalization(value) {
  const normalized = normalizeBlock(value);
  if (!normalized) return [];
  return normalized
    .split(/\n\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map(normalizeBlock)
    .filter(Boolean);
}

const FACT_STOP_WORDS = new Set([
  'about', 'after', 'among', 'business', 'clinic', 'company', 'dental', 'explicitly',
  'listed', 'noticed', 'offers', 'section', 'seeing', 'services', 'their', 'there',
  'these', 'wanted', 'while', 'with', 'your',
]);

function normalizedWords(text, entityHint = '') {
  const ignored = new Set(String(entityHint).toLowerCase().match(/[a-z0-9]+/g) || []);
  return [...new Set((String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(word => word.length >= 5 && !FACT_STOP_WORDS.has(word) && !ignored.has(word)))];
}

function normalizedText(text) {
  return String(text).toLowerCase().replace(/\b(?:i see that|i noticed|noticed|i saw that|i see)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function namedEntities(text, entityHint = '') {
  const ignored = new Set([
    'came', 'cooper', 'dental', 'noticed', 'seeing',
    ...(String(entityHint).toLowerCase().match(/[a-z0-9]+/g) || []),
  ]);
  return [...new Set((String(text).match(/\b[A-Z][A-Za-z0-9-]{3,}\b/g) || [])
    .map(word => word.toLowerCase()).filter(word => !ignored.has(word)))];
}

function samePersonalizationFact(left, right, entityHint = '') {
  if (left.factKey && right.factKey && left.factKey === right.factKey) return true;
  if (left.sourceField && right.sourceField && left.sourceField === right.sourceField &&
      left.sourceValue && right.sourceValue && left.sourceValue === right.sourceValue) return true;
  if (normalizedText(left.text) === normalizedText(right.text)) return true;

  const a = normalizedWords(left.text, entityHint);
  const b = normalizedWords(right.text, entityHint);
  if (!a.length || !b.length) return false;
  const overlap = a.filter(word => b.includes(word));
  // A shared named service/entity (such as "Invisalign") is a safe fact key.
  // Ordinary long words are not enough: that would over-collapse distinct facts.
  const leftEntities = namedEntities(left.text, entityHint);
  const rightEntities = namedEntities(right.text, entityHint);
  if (leftEntities.some(entity => rightEntities.includes(entity))) return true;
  return overlap.length / new Set([...a, ...b]).size >= 0.72;
}

function dedupePersonalizationBlocks(blocks, { entityHint = '' } = {}) {
  const kept = [];
  for (const raw of blocks || []) {
    const item = typeof raw === 'string' ? { text: normalizeBlock(raw) } : { ...raw, text: normalizeBlock(raw.text) };
    if (!item.text) continue;
    if (!kept.some(existing => samePersonalizationFact(existing, item, entityHint))) kept.push(item);
  }
  return kept;
}

function canonicalCta({ demoIncluded, recipientType = 'owner' }) {
  const forwarding = recipientType === 'owner'
    ? ''
    : ` — and if bookings aren't your area, feel free to forward this to whoever handles them.`;
  const base = demoIncluded
    ? 'Worth a look? Let me know what you think'
    : `Worth a look? Reply and I'll send it over`;
  return forwarding ? `${base}${forwarding}` : `${base}.`;
}

function validStructuredDemoUrl(demoUrl, proposalBase) {
  try {
    const url = new URL(demoUrl);
    const base = new URL(proposalBase);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) return false;
    if (url.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/$/, '');
    if (basePath.endsWith('/p')) {
      const suffix = url.pathname.slice(basePath.length);
      return url.search === '' && /^\/[0-9a-f]{6,64}$/i.test(suffix);
    }
    return url.pathname === `${basePath}/` && url.searchParams.has('company');
  } catch (_) {
    return false;
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return String(haystack).split(needle).length - 1;
}

function inferredPersonalizationBlocks(body) {
  return normalizeBlock(body).split(/\n\n+/)
    .filter(block => /^(?:I see|I noticed|I saw|Noticed|Came across)\b/i.test(block));
}

function validateFinalEmail({
  subject, body, demoUrl = '', proposalBase = '', demoIncluded = Boolean(demoUrl),
  cta = '', personalizationBlocks = [], entityHint = '', requiredBlocks = [],
  personalizationClaims = [], verifiedFactIds = [], demoCta = null,
  approvedGuarantee = '', subjectValidation = null,
}) {
  const errors = [];
  const finalSubject = normalizeBlock(subject);
  const finalBody = normalizeBlock(body);
  const add = (code, message) => errors.push({ code, message });

  if (!finalSubject) add('empty_subject', 'subject is empty');
  if (subjectValidation && (!subjectValidation.valid || subjectValidation.subject !== finalSubject)) {
    const subjectErrors = subjectValidation.errors || [];
    if (subjectErrors.length) {
      for (const error of subjectErrors) add(error.code || 'invalid_subject', error.message || 'subject failed campaign validation');
    } else {
      add('invalid_subject', 'subject differs from the validated campaign subject');
    }
  }
  if (!finalBody) add('empty_body', 'body is empty');
  if (finalBody && !/^Hi [^,\n]+,\n\n/.test(finalBody)) add('greeting_separator', 'greeting is not separated from the body by a blank line');
  if (/^Hi [^,\n]+,(?:If|I|We|Our|The|A)\b/m.test(finalBody)) add('merged_greeting', 'body text is merged into the greeting');
  if (ARTIFACT_PATTERN.test(`${finalSubject}\n${finalBody}`)) add('unresolved_artifact', 'email contains an unresolved placeholder or runtime artifact');

  for (const required of requiredBlocks) {
    if (required && !finalBody.includes(normalizeBlock(required))) add('missing_component', 'a required email component is missing');
  }

  if (approvedGuarantee) {
    const exact = normalizeBlock(approvedGuarantee);
    if (countOccurrences(finalBody, exact) !== 1) add('guarantee_count', 'approved guarantee must appear exactly once');
    const outsideGuarantee = finalBody.replace(exact, '');
    if (/\b\d+\s+new[- ]patient appointments?\b|\b(?:guarantee|don['’]?t pay|do not pay|no charge)\b/i.test(outsideGuarantee)) {
      add('offer_conflict', 'copy outside the approved guarantee appears to modify or restate the commercial promise');
    }
  }

  const urls = finalBody.match(URL_PATTERN) || [];
  if (demoIncluded) {
    if (!demoUrl) add('missing_demo_url', 'demo state is present but the structured URL is empty');
    else if (!validStructuredDemoUrl(demoUrl, proposalBase)) add('invalid_demo_url', 'demo URL does not match the accepted application URL structure');
    const escaped = String(demoUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (demoUrl && !new RegExp(`(?:^|\\n)${escaped}(?:\\n|$)`).test(finalBody)) add('demo_url_not_isolated', 'demo URL is missing or has text/punctuation attached');
    if (FUTURE_DEMO_PATTERN.test(finalBody)) add('contradictory_cta', 'email includes a demo but promises to send it later');
  } else if (demoUrl) {
    add('demo_state_mismatch', 'demo URL exists while demoIncluded is false');
  }
  if (urls.some(url => /\/p\/[0-9a-f]{6,64}[g-z][a-z]*/i.test(url))) add('malformed_demo_url', 'demo URL contains an invalid text suffix');

  if (cta && countOccurrences(finalBody, normalizeBlock(cta)) !== 1) add('cta_count', 'canonical CTA must appear exactly once');

  if (demoCta) {
    const demoText = normalizeBlock(demoCta.text);
    if (!demoText || countOccurrences(finalBody, demoText) !== 1) add('demo_cta_count', 'selected demo CTA must appear exactly once');
    if (demoCta.capabilityId !== 'generic_listen' && (!demoCta.capabilityConfirmed || !demoCta.capabilityEvidence)) {
      add('unsupported_demo_capability', 'practice-specific demo CTA is not backed by a confirmed demo capability');
    }
  }

  const supplied = (personalizationBlocks || []).map(item => typeof item === 'string' ? { text: item } : item);
  const candidates = supplied.length ? supplied : inferredPersonalizationBlocks(finalBody).map(text => ({ text }));
  if (dedupePersonalizationBlocks(candidates, { entityHint }).length !== candidates.filter(x => normalizeBlock(x.text)).length) {
    add('duplicate_personalization', 'email contains repeated personalization for the same fact');
  }

  const verified = new Set(verifiedFactIds || []);
  const claimFactIds = [];
  for (const claim of personalizationClaims || []) {
    const claimText = normalizeBlock(claim.text);
    if (!claim.supported || !claim.factId || !verified.has(claim.factId)) {
      add('unsupported_personalization', 'personalization claim does not map to a verified fact');
      continue;
    }
    if (!claim.evidence || !claim.evidence.field || !normalizeBlock(claim.evidence.snippet)) {
      add('missing_personalization_evidence', 'verified personalization claim is missing source evidence');
    }
    if (!claimText || !finalBody.includes(claimText)) add('personalization_claim_missing', 'validated personalization claim is missing from the final body');
    claimFactIds.push(claim.factId);
  }
  if (new Set(claimFactIds).size !== claimFactIds.length) add('duplicate_personalization_fact', 'the same verified fact is used more than once');

  return { valid: errors.length === 0, errors, subject: finalSubject, body: finalBody };
}

async function sendValidatedFinalEmail(email, context, send) {
  const validation = validateFinalEmail({ ...context, ...email });
  if (!validation.valid) return { sent: false, validation };
  return { sent: true, validation, result: await send({ subject: validation.subject, body: validation.body }) };
}

module.exports = {
  normalizeBlock, assembleFinalEmail, splitPersonalization, dedupePersonalizationBlocks,
  canonicalCta, validStructuredDemoUrl, validateFinalEmail, sendValidatedFinalEmail,
};
