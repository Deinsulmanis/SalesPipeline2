'use strict';

/**
 * Managed-client campaign namespace.
 *
 * ScaleLab's campaigns are the existing campaign-versions.js registry and are
 * owned by the default client; nothing here redefines them. Managed-client
 * campaigns, lead types and templates live here and each names its client.
 *
 * NAMING RULE. A managed client's identifiers carry its namespace prefix and
 * must never contain a ScaleLab family keyword (`staffing`, `roof`, `dent`).
 * The legacy resolvers (isStaffingLead, familyFromText) match those words
 * anywhere in a lead's fields; a Jole id containing "staffing" would pull a
 * Jole lead into ScaleLab's staffing gate and templates. The registry refuses
 * such an id at load.
 *
 * ICP content is metadata for operators and reporting. Nothing here decides a
 * send on ICP text.
 */

const { DEFAULT_CLIENT_ID, getClient, clientForNamespacedValue } = require('./registry');
const { JOLE_INDUSTRIAL_EMPLOYER_COPY } = require('./jole-copy');

const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'draft',         // configured; copy, senders or leads not final — never sendable
  APPROVED: 'approved',   // copy approved; queueable; sending still needs the client switch
  ACTIVE: 'active',
  DISABLED: 'disabled',   // placeholder or retired — neither queueable nor sendable
});

const CLIENT_LEAD_TYPES = Object.freeze([
  Object.freeze({
    id: 'jole_employer', clientId: 'jole', label: 'Jole · Employer (contractor)',
    // jole_industrial_employer is the niche the employer-acquisition copy uses.
    aliases: Object.freeze(['jole_employer', 'jole employer', 'jole_industrial_employer']),
  }),
]);

const CLIENT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'jole-dc-mission-critical-v1', clientId: 'jole', niche: 'jole_employer',
    name: 'Jole · Data-center / mission-critical contractors', sequenceSteps: 3,
    // Final campaign copy has not been written or approved.
    ready: false, reason: 'Jole Campaign #1 copy is not final; the template is not ready',
  }),
  Object.freeze({
    id: 'jole-gulf-industrial-v1', clientId: 'jole', niche: 'jole_employer',
    name: 'Jole · Gulf Coast industrial contractors', sequenceSteps: 3,
    ready: false, reason: 'Jole Campaign #2 is a placeholder',
  }),
  Object.freeze({
    id: 'jole-shipyard-v1', clientId: 'jole', niche: 'jole_employer',
    name: 'Jole · Shipbuilding / ship-repair contractors', sequenceSteps: 3,
    ready: false, reason: 'Jole Campaign #3 is a placeholder',
  }),
  Object.freeze({
    id: 'jole-industrial-employer-v1', clientId: 'jole', niche: 'jole_employer',
    name: 'Jole BTX · Industrial employer acquisition', sequenceSteps: 3,
    // Final approved copy (jole-copy.js). Still not ready: no send path renders
    // it, and launch needs its own approval (landing page, Jole mailing
    // address, warmed and approved senders, client send authorization).
    copyVersion: JOLE_INDUSTRIAL_EMPLOYER_COPY.copyVersion, copy: JOLE_INDUSTRIAL_EMPLOYER_COPY,
    ready: false, reason: 'Jole employer-acquisition copy is final but not deployed or approved for sending (no send path renders it; launch needs the landing page, Jole mailing address, approved senders and send authorization)',
  }),
]);

const CLIENT_CAMPAIGNS = Object.freeze([
  Object.freeze({
    id: 'JOLE_DC_MISSION_CRITICAL', clientId: 'jole', number: 1,
    label: 'Jole #1 — Data-center / mission-critical contractors',
    status: CAMPAIGN_STATUS.DRAFT,
    leadType: 'jole_employer', emailTemplateId: 'jole-dc-mission-critical-v1',
    audience: 'employers',
    icp: Object.freeze({
      geography: 'United States',
      summary: 'Contractors with verified data-center / mission-critical construction and a directly employed relevant craft workforce.',
      contractorTypes: Object.freeze([
        'electrical contractor', 'mechanical contractor', 'piping contractor',
        'MEP contractor', 'multi-trade contractor',
      ]),
      workerCategories: Object.freeze([
        'electricians', 'journeyman electricians', 'electrical field crews',
        'electrical foremen', 'pipefitters', 'welders', 'mechanical skilled trades',
        'field supervision',
      ]),
      requiredEvidence: Object.freeze([
        'verified data-center or mission-critical project history',
        'directly employed craft workforce',
      ]),
    }),
  }),
  Object.freeze({
    id: 'JOLE_GULF_INDUSTRIAL', clientId: 'jole', number: 2,
    label: 'Jole #2 — Gulf Coast refinery / petrochemical / pipeline contractors',
    status: CAMPAIGN_STATUS.DISABLED,
    leadType: 'jole_employer', emailTemplateId: 'jole-gulf-industrial-v1',
    audience: 'employers',
    icp: Object.freeze({
      geography: 'U.S. Gulf Coast',
      summary: 'Refinery, petrochemical and pipeline contractors. Placeholder.',
      contractorTypes: Object.freeze([]), workerCategories: Object.freeze([]), requiredEvidence: Object.freeze([]),
    }),
  }),
  Object.freeze({
    id: 'JOLE_SHIPYARD', clientId: 'jole', number: 3,
    label: 'Jole #3 — Shipbuilding / ship-repair contractors',
    status: CAMPAIGN_STATUS.DISABLED,
    leadType: 'jole_employer', emailTemplateId: 'jole-shipyard-v1',
    audience: 'employers',
    icp: Object.freeze({
      geography: 'United States',
      summary: 'Shipbuilding and ship-repair contractors. Placeholder.',
      contractorTypes: Object.freeze([]), workerCategories: Object.freeze([]), requiredEvidence: Object.freeze([]),
    }),
  }),
  // The Jole campaign every Jole sender is scoped to (client senderPolicy).
  // Configured, never sendable while DRAFT: its template is not ready, Jole
  // sending is disabled and Jole senders are paused.
  Object.freeze({
    id: 'jole-btx-employer-acquisition', clientId: 'jole', number: 4,
    label: 'Jole BTX — Industrial Employer Acquisition',
    campaignVersion: 'jole_industrial_employer_acquisition_v1',
    status: CAMPAIGN_STATUS.DRAFT,
    leadType: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1',
    audience: 'employers',
    // Jole sells skilled-trade labor TO these employers. Not ScaleLab's
    // staffing-agency campaign: no shared copy, offer or audience.
    icp: Object.freeze({
      geography: 'United States',
      summary: 'Industrial end employers (not contractors-for-hire, not staffing agencies) with verified skilled-trade hiring in the last 30 days at a named site.',
      contractorTypes: Object.freeze([]),
      workerCategories: Object.freeze([
        'skilled trades', 'welders', 'maintenance technicians', 'machinists / CNC', 'electricians', 'mechanics',
        'instrument technicians', 'fabricators / fitters', 'millwrights', 'pipefitters',
      ]),
      requiredEvidence: Object.freeze(['verified active hiring for the role and location, or a reviewed employer record']),
      sectors: Object.freeze([
        'Industrial fabrication / machinery', 'Metals / mining / paper / heavy industrial',
        'Refining / petrochemical / LNG / chemical', 'Power / utilities', 'Shipyard / marine',
        'Pipeline / midstream', 'Oil & gas producers / operators',
      ]),
      buyerRoles: Object.freeze([
        'Plant / operations / production leadership', 'HR / talent acquisition', 'Maintenance / reliability',
        'Owner / executive (small and mid companies, or site executives)', 'Superintendent / site leadership',
      ]),
      excluded: Object.freeze([
        'staffing, recruiting and labor-service firms', 'SpaceX family', 'Kiewit family / KOS', 'Karpower', 'current Jole clients',
      ]),
      sendOrder: 'Tier A before Tier B; within a tier, non-catch-all contacts at the exact hiring site first',
    }),
  }),
]);

function assertNamespaced(kind, id, clientId) {
  const client = getClient(clientId);
  if (client.isDefault) throw new Error(`${kind} ${id} belongs to the default client; define it in the legacy registry`);
  if (clientForNamespacedValue(id) !== client.id) throw new Error(`${kind} ${id} must carry the ${client.namespace}_ namespace`);
  const lower = String(id).toLowerCase();
  const legacy = getClient(DEFAULT_CLIENT_ID).legacyFamilyKeywords
    .find(keyword => lower.includes(keyword));
  if (legacy) throw new Error(`${kind} ${id} contains the ScaleLab family keyword "${legacy}"`);
}

function validateCatalog() {
  const seen = new Set();
  const unique = (kind, id) => {
    const key = `${kind}:${String(id).toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate ${kind} ${id}`);
    seen.add(key);
  };
  for (const type of CLIENT_LEAD_TYPES) { unique('lead type', type.id); assertNamespaced('Lead type', type.id, type.clientId); }
  for (const template of CLIENT_TEMPLATES) {
    unique('template', template.id); assertNamespaced('Template', template.id, template.clientId);
    const type = CLIENT_LEAD_TYPES.find(item => item.id === template.niche);
    if (!type || type.clientId !== template.clientId) throw new Error(`Template ${template.id} lead type belongs to another client`);
  }
  for (const campaign of CLIENT_CAMPAIGNS) {
    unique('campaign', campaign.id); assertNamespaced('Campaign', campaign.id, campaign.clientId);
    // A campaign version is a second name for the same campaign: same namespace
    // rules, and it may not collide with any campaign id or other version.
    if (campaign.campaignVersion) { unique('campaign', campaign.campaignVersion); assertNamespaced('Campaign version', campaign.campaignVersion, campaign.clientId); }
    if (!Object.values(CAMPAIGN_STATUS).includes(campaign.status)) throw new Error(`Campaign ${campaign.id} has an invalid status`);
    const template = CLIENT_TEMPLATES.find(item => item.id === campaign.emailTemplateId);
    if (!template || template.clientId !== campaign.clientId) throw new Error(`Campaign ${campaign.id} template belongs to another client`);
    if (template.niche !== campaign.leadType) throw new Error(`Campaign ${campaign.id} template and lead type disagree`);
  }
  return true;
}
validateCatalog();

const byId = (list, id) => list.find(item => item.id.toLowerCase() === String(id || '').trim().toLowerCase()) || null;
// By id, or by the campaign version a lead stores in intendedCampaignVersion.
const clientCampaign = id => byId(CLIENT_CAMPAIGNS, id)
  || CLIENT_CAMPAIGNS.find(item => item.campaignVersion && item.campaignVersion.toLowerCase() === String(id || '').trim().toLowerCase()) || null;
const clientTemplate = id => byId(CLIENT_TEMPLATES, id);
const clientLeadType = id => {
  const value = String(id || '').trim().toLowerCase();
  return CLIENT_LEAD_TYPES.find(type => type.id === value || type.aliases.includes(value)) || null;
};

function campaignsForClient(clientId) {
  return CLIENT_CAMPAIGNS.filter(campaign => campaign.clientId === clientId);
}

/** May leads be queued/sent under this campaign as far as the campaign itself is concerned? */
function campaignSendable(campaign) {
  if (!campaign) return { ok: false, code: 'campaign_unknown', reason: 'campaign is not registered' };
  if (campaign.status === CAMPAIGN_STATUS.DISABLED) return { ok: false, code: 'campaign_disabled', reason: `${campaign.id} is disabled` };
  if (campaign.status === CAMPAIGN_STATUS.DRAFT) return { ok: false, code: 'campaign_draft', reason: `${campaign.id} is a draft` };
  const template = clientTemplate(campaign.emailTemplateId);
  if (!template?.ready) return { ok: false, code: 'template_not_ready', reason: template?.reason || 'campaign template is not ready' };
  return { ok: true };
}

module.exports = {
  CAMPAIGN_STATUS, CLIENT_LEAD_TYPES, CLIENT_TEMPLATES, CLIENT_CAMPAIGNS,
  validateCatalog, clientCampaign, clientTemplate, clientLeadType, campaignsForClient, campaignSendable,
};
