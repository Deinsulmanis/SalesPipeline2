'use strict';

// Read-only audit of the 41 latest failed personalization records. Persists
// research and the existing audit result locally; never changes a CRM row.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const path = require('node:path');
const { previewStaffingPersonalization } = require('../integrations/staffing-personalization');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { researchStaffingCompany } = require('../integrations/staffing-research');

const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_PATH, 'utf8'));
const cacheDir = process.env.RESEARCH_CACHE_DIR;
const outputDir = process.env.RECHECK_DIR;
fs.mkdirSync(outputDir, { recursive: true });
const records = inventory.records.filter(row => row.fit === 'ICP_CONFIRMED'
  && row.personalization === 'FAILED' && !row.leadId.startsWith('muj'));
if (records.length !== 41) throw new Error(`Expected 41 newer failures; found ${records.length}`);

let next = 0;
async function worker() {
  while (next < records.length) {
    const row = records[next++];
    const file = path.join(outputDir, `${row.leadId}.json`);
    if (fs.existsSync(file)) continue;
    const lead = row.lead;
    const catchAll = /catch-all=yes/i.test(lead.notes);
    if (!/catch-all=(?:yes|no)/i.test(lead.notes) || !/Apollo work email verified/i.test(lead.notes)) {
      throw new Error(`Stored verifier evidence missing for ${row.leadId}`);
    }
    const source = { id: lead.id, company: lead.company, email: lead.email,
      companyWebsite: lead.website, contactName: lead.contactName,
      firstName: lead.contactName.split(/\s+/)[0],
      emailStatus: catchAll ? 'verified catch-all' : 'verified NOT catch-all',
      campaign: STAFFING_CAMPAIGN.name, campaignId: STAFFING_CAMPAIGN.id };
    const cachePath = cacheDir && path.join(cacheDir, `${row.leadId}.json`);
    const cached = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : null;
    const useCache = cached?.research?.pages?.length > 0 && !cached.research.reviewRequired;
    const research = useCache ? cached.research : await researchStaffingCompany(source);
    const result = await previewStaffingPersonalization(source, { researchCompany: async () => research });
    fs.writeFileSync(file, JSON.stringify({ leadId: row.leadId, company: row.company,
      auditedAt: new Date().toISOString(), researchSource: useCache ? '2026-10-05_saved_first_party' : 'current_first_party',
      research, result }, null, 2));
    console.log(`${row.leadId} ${result.classification} ${result.primaryReason || ''}`);
  }
}

Promise.all(Array.from({ length: 3 }, worker)).then(() => {
  console.log(JSON.stringify({ selected: records.length,
    completed: records.filter(r => fs.existsSync(path.join(outputDir, `${r.leadId}.json`))).length }));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
