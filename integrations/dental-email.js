'use strict';

const crypto = require('crypto');
const { guaranteeFor } = require('../guarantee');
const { assembleFinalEmail, canonicalCta } = require('./final-email');
const { buildDentalSubject } = require('./dental-subject');

const COLD_SUBJECTS = Object.freeze([
  `3 new patients in 30 days — or you don't pay`,
  `A guarantee for {{company}}`,
  `{{company}}'s missed calls`,
]);

function coldSubjectIndex(lead) {
  return crypto.createHash('sha1').update(String(lead.id || '')).digest()[0] % COLD_SUBJECTS.length;
}

function coldSubjectFor(lead, company) {
  return COLD_SUBJECTS[coldSubjectIndex(lead)].split('{{company}}').join(company);
}

function buildDentalColdEmail({
  lead, name, company, recipientType, link, personalization,
  mailingAddress, signature, reference,
}) {
  const offer = guaranteeFor(company);
  const productContext = `The linked sample demonstrates a complete dental call flow. It never touches your phone line, so there's nothing to switch over to try it.`;
  const casl = `---\n${mailingAddress}\nYou're receiving this because your business is publicly listed. Reply with\n"unsubscribe" and I'll remove you immediately — no hard feelings.  ·  Ref: ${reference}`;
  const personalizationBlocks = personalization.personalizationBlocks.map((text, index) => ({
    text,
    factKey: personalization.claims[index]?.factId || '',
    sourceField: personalization.claims[index]?.evidence?.field || '',
    sourceValue: personalization.claims[index]?.evidence?.snippet || '',
  }));
  const demoIncluded = Boolean(link);
  const cta = canonicalCta({ demoIncluded, recipientType });
  const demoBlock = demoIncluded ? `${personalization.demo.text}\n${link}` : '';
  const requiredBlocks = [personalization.offerBridge, offer, productContext, demoBlock, signature, casl];
  const subjectMetadata = buildDentalSubject({ lead, company, personalization });

  return {
    subject: subjectMetadata.subject,
    body: assembleFinalEmail([
      `Hi ${name},`, ...personalizationBlocks.map(block => block.text),
      personalization.offerBridge, offer, productContext,
      demoBlock, cta, signature, casl,
    ]),
    cta,
    personalizationBlocks,
    demoIncluded,
    requiredBlocks,
    personalizationClaims: personalization.claims,
    verifiedFactIds: personalization.profile.facts.filter(fact => fact.verified).map(fact => fact.id),
    demoCta: personalization.demo,
    approvedGuarantee: offer,
    personalizationMetadata: personalization.metadata,
    subjectMetadata,
  };
}

module.exports = {
  COLD_SUBJECTS,
  coldSubjectIndex,
  coldSubjectFor,
  buildDentalColdEmail,
};
