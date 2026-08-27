'use strict';

const crypto = require('crypto');

// Capabilities are evidence-backed by the deployed dental demo transcript.
// This is deliberately narrower than the product's eventual capabilities:
// email copy may reference only behavior the linked recording actually proves.
const DENTAL_DEMO_CAPABILITIES = Object.freeze({
  new_patient_booking: {
    id: 'new_patient_booking',
    evidence: 'audio/demo-dental-timings.json lines 0-13',
  },
  urgent_dental_call: {
    id: 'urgent_dental_call',
    evidence: 'audio/demo-dental-timings.json lines 10-11',
  },
});

const FACT_DEFINITIONS = [
  { type: 'invisalign', label: 'Offers Invisalign', priority: 100, pattern: /\binvisalign(?:\u00ae)?\b/i },
  { type: 'implants', label: 'Offers dental implants', priority: 99, pattern: /\b(?:dental\s+)?implants?\b/i },
  { type: 'emergency', label: 'Offers emergency dental care', priority: 95, pattern: /\b(?:emergency\s+(?:dentistry|dentist|dental|appointments?|care|help)|dental\s+emergenc(?:y|ies))\b/i },
  { type: 'accepting_new_patients', label: 'Accepting new patients', priority: 90, pattern: /\b(?:(?:accepting|welcome|welcoming|taking)\s+(?:families\s+and\s+)?new\s+patients|new\s+patients\s+welcome)\b/i },
  { type: 'published_hours', label: 'Publishes office hours', priority: 80, pattern: /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)[^.!?]{0,220}(?:closed|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i },
  { type: 'cosmetic', label: 'Offers cosmetic dentistry', priority: 70, pattern: /\bcosmetic\s+dentistry\b/i },
  { type: 'orthodontics', label: 'Offers orthodontic care', priority: 65, pattern: /\borthodont(?:ic|ics|ist)\b/i },
  { type: 'sedation', label: 'Offers sedation dentistry', priority: 60, pattern: /\bsedation\s+dentistry\b/i },
  { type: 'pediatric', label: 'Offers pediatric dentistry', priority: 55, pattern: /\b(?:pediatric|children(?:'s)?)\s+dentistry\b/i },
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function evidenceSnippet(text, match) {
  const source = cleanText(text);
  const index = Math.max(0, match.index || 0);
  const start = Math.max(0, index - 70);
  const end = Math.min(source.length, index + String(match[0]).length + 110);
  return `${start ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

function factFromDefinition(definition, siteText, lead) {
  const match = definition.pattern.exec(siteText);
  if (!match) return null;
  return {
    id: `site:${definition.type}`,
    type: definition.type,
    value: definition.label,
    priority: definition.priority,
    verified: true,
    confidence: 'high',
    source: {
      field: 'siteContext',
      url: String(lead.website || '').trim(),
      snippet: evidenceSnippet(siteText, match),
    },
  };
}

function buildDentalPersonalizationProfile(lead, { siteText = lead.siteContext || '' } = {}) {
  const text = cleanText(siteText === '__scraped__' ? '' : siteText);
  const facts = FACT_DEFINITIONS.map(definition => factFromDefinition(definition, text, lead)).filter(Boolean);

  const city = cleanText(lead.city);
  if (city) {
    facts.push({
      id: 'lead:city', type: 'city', value: city, priority: 20,
      verified: true, confidence: 'medium',
      source: { field: 'city', url: '', snippet: city },
    });
  }

  const reviewCount = Number(String(lead.reviewCount || '').replace(/,/g, '')) || 0;
  const rating = Number(lead.rating) || 0;
  const reviewSignal = reviewCount > 0 && rating > 0
    ? { reviewCount, rating, source: { field: 'reviewCount/rating', url: '', snippet: `${rating} rating from ${reviewCount} reviews` } }
    : null;

  return {
    version: 1,
    practiceName: cleanText(lead.company),
    contactFirstName: cleanText(lead.first || String(lead.contactName || '').split(/\s+/)[0]),
    city,
    sourceUrl: cleanText(lead.website),
    facts,
    reviewSignal, // retained for future analytics; intentionally not used in copy
  };
}

function selectPersonalizationAngle(profile) {
  const eligible = profile.facts.filter(fact => fact.verified && fact.type !== 'city')
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  if (eligible.length) return { id: eligible[0].type, fact: eligible[0], supportingFact: null };
  const city = profile.facts.find(fact => fact.type === 'city');
  if (city) return { id: 'city', fact: city, supportingFact: null };
  return { id: 'generic', fact: null, supportingFact: null };
}

function stableVariant(lead, angleId, variants) {
  if (variants.length === 1) return variants[0];
  const byte = crypto.createHash('sha1').update(`${lead.id || lead.email || lead.company}|${angleId}`).digest()[0];
  return variants[byte % variants.length];
}

function angleCopy(angle, lead, company) {
  const city = cleanText(lead.city);
  const variants = {
    invisalign: [
      `${company} lists Invisalign among its services. Those higher-consideration new-patient inquiries make reliable call handling especially relevant.`,
      `I reached out because ${company} offers Invisalign. Calls about a service like that can represent valuable new-patient opportunities.`,
    ],
    implants: [
      `${company} lists dental implants among its services. Implant inquiries can represent especially valuable new-patient opportunities.`,
      `I reached out because ${company} offers dental implants. Reliable handling matters when a prospective patient is considering that kind of care.`,
    ],
    emergency: [
      `${company} advertises emergency dental care. Those calls can be time-sensitive, so prompt handling matters.`,
      `I reached out because ${company} handles dental emergencies. An urgent caller is less likely to wait through voicemail.`,
    ],
    accepting_new_patients: [
      `${company} says it is accepting new patients. That makes reliable handling of new-patient calls directly relevant.`,
      `I saw that ${company} welcomes new patients. A receptionist that can consistently handle those first calls fits that stated availability.`,
    ],
    published_hours: [
      `${company} publishes specific office hours. A receptionist that can handle inquiries outside those hours could keep new-patient conversations moving.`,
      `Your posted schedule leaves times when the front desk is closed. That makes after-hours call coverage a practical fit for ${company}.`,
    ],
    cosmetic: [
      `${company} lists cosmetic dentistry among its services. Those consultation-style inquiries make a clear, responsive first call especially useful.`,
    ],
    orthodontics: [
      `${company} offers orthodontic care. Those longer-consideration new-patient inquiries benefit from a clear first conversation.`,
    ],
    sedation: [
      `${company} lists sedation dentistry. Callers asking about it may need a calm, clear first conversation before booking.`,
    ],
    pediatric: [
      `${company} offers pediatric dentistry. Parents making a first inquiry benefit from clear call handling and an easy booking path.`,
    ],
    city: [
      `I came across ${company} while looking at dental practices in ${city}.`,
    ],
    generic: [
      `I wanted to reach out about a receptionist demo for ${company}.`,
    ],
  };
  return stableVariant(lead, angle.id, variants[angle.id] || variants.generic);
}

function demoSelection(angle) {
  if (angle.id === 'accepting_new_patients') {
    return {
      text: 'Listen to how the demo handles a new-patient booking.',
      capabilityId: 'new_patient_booking',
      capabilityConfirmed: true,
      capabilityEvidence: DENTAL_DEMO_CAPABILITIES.new_patient_booking.evidence,
    };
  }
  if (angle.id === 'emergency') {
    return {
      text: 'Listen for how the demo handles an urgent dental concern.',
      capabilityId: 'urgent_dental_call',
      capabilityConfirmed: true,
      capabilityEvidence: DENTAL_DEMO_CAPABILITIES.urgent_dental_call.evidence,
    };
  }
  return {
    text: 'Give the dental receptionist demo a quick listen.',
    capabilityId: 'generic_listen',
    capabilityConfirmed: true,
    capabilityEvidence: 'the linked page contains the deployed dental demo audio',
  };
}

function personalizationLevel(angle, demo) {
  if (!angle.fact) return 0;
  if (angle.id === 'city') return 1;
  if (demo.capabilityId !== 'generic_listen' && demo.capabilityConfirmed) return 3;
  return 2;
}

function buildDentalPersonalization(lead, options = {}) {
  const profile = buildDentalPersonalizationProfile(lead, options);
  const angle = selectPersonalizationAngle(profile);
  const company = profile.practiceName || 'the practice';
  const text = angleCopy(angle, lead, company);
  const demo = demoSelection(angle);
  const level = personalizationLevel(angle, demo);
  const claim = angle.fact ? {
    text,
    factId: angle.fact.id,
    factType: angle.fact.type,
    evidence: angle.fact.source,
    confidence: angle.fact.confidence,
    supported: angle.fact.verified === true,
  } : null;

  return {
    profile,
    angle,
    personalizationBlocks: [text],
    claims: claim ? [claim] : [],
    offerBridge: angle.fact && angle.id !== 'city'
      ? 'That is why I structured the offer around a concrete new-patient result:'
      : 'The offer is structured around a concrete new-patient result:',
    demo,
    level,
    metadata: {
      profileVersion: profile.version,
      selectedAngle: angle.id,
      supportingFact: angle.fact ? angle.fact.value : '',
      evidence: angle.fact ? angle.fact.source : null,
      personalizationLevel: level,
      demoCta: demo.text,
      demoCapabilityId: demo.capabilityId,
      demoCapabilityConfirmed: demo.capabilityConfirmed,
    },
  };
}

module.exports = {
  DENTAL_DEMO_CAPABILITIES,
  buildDentalPersonalizationProfile,
  selectPersonalizationAngle,
  buildDentalPersonalization,
  personalizationLevel,
};
