'use strict';
const { domain, safeUrl } = require('../staffing-research');
const { resolveCampaign } = require('./campaigns');
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
function text(v, max = 1000) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) throw new Error('INVALID_INPUT');
  return v.trim();
}
function normalizeInput(raw = {}) {
  if (!isObject(raw) || JSON.stringify(raw).length > 60000) throw new Error('INVALID_INPUT');
  for (const field of ['company', 'contact', 'campaign']) {
    if (raw[field] !== undefined && !isObject(raw[field])) throw new Error('INVALID_INPUT');
  }
  const company = raw.company || {}, contact = raw.contact || {}, campaign = raw.campaign || {};
  const website = text(company.website), declaredDomain = text(company.domain);
  const normalizedDomain = domain(declaredDomain || website);
  if (website) safeUrl(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  if (declaredDomain) safeUrl(/^https?:\/\//i.test(declaredDomain) ? declaredDomain : `https://${declaredDomain}`);
  if (website && declaredDomain && domain(website) !== domain(declaredDomain)) throw new Error('COMPANY_DOMAIN_MISMATCH');
  if (company.existingData !== undefined && !isObject(company.existingData)) throw new Error('INVALID_INPUT');
  if (campaign.icp !== undefined && !isObject(campaign.icp)) throw new Error('INVALID_INPUT');
  const result = {
    leadId: text(raw.leadId, 250) || null,
    company: { name: text(company.name), domain: normalizedDomain, website, existingData: structuredClone(company.existingData || {}) },
    contact: Object.fromEntries(['firstName', 'lastName', 'title', 'email'].map(k => [k, text(contact[k])])),
    campaign: resolveCampaign({ id: text(campaign.id, 250), name: text(campaign.name), icp: campaign.icp }),
  };
  if (JSON.stringify(result.company.existingData).length > 30000) throw new Error('INVALID_INPUT');
  return result;
}
function fromLead(lead, campaign) {
  return { leadId: lead.id, company: { name: lead.company, website: lead.website || lead.companyWebsite,
    domain: lead.companyDomain, existingData: lead.existingData || lead.apolloData || {} },
  contact: { firstName: lead.firstName || lead.first || (lead.contactName || '').split(' ')[0],
    lastName: lead.lastName || lead.last, title: lead.title, email: lead.email },
  campaign: campaign || { id: lead.intendedCampaignVersion || lead.campaignId || '', name: lead.campaign || '' } };
}
function compareHistorical(historicalDecision, fit) {
  const original = text(historicalDecision, 250) || null;
  // Labels are compared literally, never upgraded from accepted/held or inferred
  // from operational stages. Even exact labels can have different old semantics.
  const comparable = ['HIGH', 'MEDIUM', 'ICP_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'RETRIEVAL_FAILURE'].includes(original);
  return { historicalDecision: original, agentDecision: fit.classification,
    agreement: comparable ? original === fit.classification : null, agentConfidence: fit.confidence,
    note: comparable ? 'Label agreement only; historical HIGH/MEDIUM may also measure copy quality.'
      : original ? 'Ambiguous historical label; no equivalence inferred (including accepted, held, retry or audit failures).'
        : 'No historical decision supplied or stored.' };
}
module.exports = { normalizeInput, fromLead, compareHistorical, text };
