'use strict';

// Shadow-only configuration. No dependency on campaign activation or send routing.
// Sources: staffing-personalization.js POLICY and the September 15 batch-2
// discovery report/screen. This conservative baseline retains the newer screening
// requirements as well as the older fact/territory rules; it never rewrites either.
const { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_LABELS } = require('../staffing-campaign');
const STAFFING_ID = STAFFING_CAMPAIGN.id;
const STAFFING_ICP = {
  policyVersion: 'staffing_research_baseline_20260915',
  targetCompanyTypes: ['employer-facing staffing agency', 'temporary or contract labor supplier'],
  targetIndustries: ['light industrial', 'manufacturing', 'warehouse', 'logistics', 'construction', 'skilled trades'],
  targetMarkets: ['United States'],
  positiveSignals: [
    'Explicit industrial staffing service descriptions; staffing relationship must be proven.',
    'Diversified firms can qualify; professional services alongside industrial staffing are not automatically disqualifying.',
    'Industrial labor must be a meaningful service line, not incidental job listings or client industries alone.',
  ],
  highRequirements: [
    'Company/domain identity confirmed on its own website; no unresolved domain flags.',
    'Temporary/contract staffing, employer-facing language, a named industrial service line, at least three worker-level roles, and industrial work as the majority of service signals.',
  ],
  mediumRequirements: [
    'Named industrial line or at least two worker-level roles; industrial work is at least 35% of evidenced service signals, or one of at most three service lines with a worker role.',
    'Identity confirmed; not primarily IT or engineering recruiting; temporary/contract service established.',
  ],
  disqualifiers: [
    'Affirmatively non-staffing business, job board, union local, software/platform, general contractor or construction management firm.',
    'Healthcare-only, IT-only, engineering/professional/management-only, executive-search-only, RPO-only, primarily PEO/HR/payroll, office/clerical-only, auto-dealership-only or food-service-only.',
    'National giants, franchise networks or their brands (including Employbridge/ProLogistix/ResourceMFG, TrueBlue/PeopleReady/Labor Ready/PeopleScout, Randstad, ManpowerGroup/Experis, Aerotek/Actalent/Aston Carter/Allegis, Kelly, Insight Global, Kforce, HireQuest/Snelling/LINK Staffing/Trojan Labor, Express Employment, Labor Finders, PrideStaff, Adecco, TAD PGS, Orion Talent, Spherion, LaborMAX, Sedona Staffing, FPC, MRINetwork, Global Recruiters Network, Staffing 360 Solutions, AppleOne, Robert Half, Staffmark, Tradesmen International, Volt, NESCO, Elwood Staffing). Require evidence of identity/affiliation.',
    'Fluor/global EPC contracting is not an agency supplying industrial staffing labor.',
    'Affirmative evidence of exclusively non-US operations.',
  ],
  uncertaintyRules: [
    'Unknown industrial share, unconfirmed identity, missing temp/contract evidence or direct-hire-only industrial recruitment requires INSUFFICIENT_EVIDENCE, not automatic mismatch.',
    'Never invent percentages or staffing role counts; if the source cannot establish a requirement, it is unknown.',
    'Missing geography is not a mismatch. Geography in research means explicit employer service territory, never HQ/office/job locations.',
    'Company size alone does not establish national-giant status; large regional agencies may qualify.',
    'A broad Apollo industry label alone cannot establish fit. Website evidence takes precedence.',
  ],
  scope: 'Company fit only. Duplicate screening, buyer seniority, email verification/catch-all tier and send eligibility remain separate controls.',
};
const registry = { [STAFFING_ID]: { id: STAFFING_ID, name: STAFFING_CAMPAIGN.name, icp: STAFFING_ICP } };
function resolveCampaign(campaign = {}) {
  // Explicit inline criteria support other campaigns and isolated experiments.
  // They are snapshotted per run and never saved back to the campaign registry.
  const id = campaign.id || (STAFFING_CAMPAIGN_LABELS.includes(campaign.name) ? STAFFING_ID : '');
  const known = registry[id];
  return structuredClone({ id, name: campaign.name || known?.name || '',
    icp: campaign.icp === undefined ? known?.icp || {} : campaign.icp });
}
module.exports = { STAFFING_ID, STAFFING_ICP, resolveCampaign };
