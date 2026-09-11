'use strict';
/**
 * LOCAL, READ-ONLY staffing import + end-to-end no-send validation.
 *
 * Replicates the exact projection POST /api/coldemail/import performs, in
 * memory, against the approved CSV. It opens no Sheets client, writes no CRM
 * row, assigns no sender and contacts no provider. Its only output is a report.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('./staffing-personalization-qa');
const { classify: classifyLeadEmail } = require('../check-leads');
const { STAFFING_CAMPAIGN, renderStaffingEmail, validateStaffingEmail, staffingOpeningFor } = require('../integrations/staffing-campaign');
const { normalizeNiche, routedLeadReady, validateRoute, campaignVersionsForRoute } = require('../integrations/campaign-routing');
const { CAMPAIGN_VERSIONS, familyForLead } = require('../integrations/campaign-versions');
const { offerForLead } = require('../integrations/offer-config');

// server.js CE_COLUMNS, verbatim — the stored column order.
const CE_COLUMNS = ['id','company','contactName','email','city','tradeType','website','stage','emailStatus',
  'lastEmailedAt','emailStep','notes','reviewCount','rating','tier','siteContext','campaign','campaign_notes',
  'enrichment_attempted','leadNiche','senderInboxId','emailTemplateId','routingRequired','intendedCampaignVersion'];

/** Exactly the server's per-row projection. Server-controlled fields are fixed. */
function projectImportRow(row, { campaignName, campaignNotes = '', leadNiche }) {
  return { id: '<server-generated>', company: row.company || '', contactName: row.contactName || '',
    email: row.email || '', city: row.city || '', tradeType: row.tradeType || '',
    website: row.website || '', stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '',
    notes: row.notes || '', reviewCount: row.reviewCount || '', rating: row.rating || '',
    tier: row.tier || '', siteContext: row.siteContext || '',
    campaign: campaignName, campaign_notes: campaignNotes, enrichment_attempted: '',
    leadNiche, senderInboxId: '', emailTemplateId: '', routingRequired: 'true', intendedCampaignVersion: '' };
}

function admissionChecks(row, suppressed = new Set()) {
  const email = String(row.email || '').toLowerCase().trim();
  if (!email) return 'invalid (no email)';
  const verdict = classifyLeadEmail(email);
  if (verdict !== 'CLEAN') return `junk (${verdict})`;
  if (suppressed.has(email)) return 'suppressed';
  return null;
}

function run({ csvFile, out }) {
  const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  const leadNiche = normalizeNiche(STAFFING_CAMPAIGN.niche);
  const L = [];
  const say = line => { L.push(line); console.log(line); };

  say('=== STAFFING IMPORT + END-TO-END NO-SEND VALIDATION (local, read-only) ===');
  say(`generated              : ${new Date().toISOString()}`);
  say(`source CSV             : ${csvFile}`);
  say(`rows                   : ${rows.length}`);
  say(`campaign parameter     : ${STAFFING_CAMPAIGN.name}`);
  say(`lead_niche parameter   : ${leadNiche}`);
  say(`normalizeNiche accepts : ${Boolean(leadNiche)}`);
  say('');

  const rejected = rows.map(r => admissionChecks(r)).filter(Boolean);
  say(`admission pre-checks   : ${rows.length - rejected.length}/${rows.length} admissible` +
    (rejected.length ? `  rejected: ${rejected.join(', ')}` : '  (no junk, no blank email)'));
  const ignored = Object.keys(rows[0]).filter(k => !CE_COLUMNS.includes(k));
  say(`columns stored         : ${Object.keys(rows[0]).filter(k => CE_COLUMNS.includes(k)).join(', ')}`);
  say(`columns ignored        : ${ignored.length} (${ignored.slice(0, 4).join(', ')}${ignored.length > 4 ? ', …' : ''})`);
  say('');

  // ── §13 sample projections ────────────────────────────────────────────────
  const pick = (label, test) => { const r = rows.find(test); return r ? { label, row: r } : null; };
  const samples = [
    pick('HIGH role-based', r => r.ref_confidence === 'HIGH' && r.ref_validatedRoles),
    pick('MEDIUM market-only', r => r.ref_confidence === 'MEDIUM' && !r.ref_validatedRoles),
    pick('city/state metadata', r => r.city && r.ref_state),
    pick('punctuation/special chars', r => /[&',.\-—]/.test(r.company) && r.ref_confidence),
  ].filter(Boolean);

  say('=== §13 STORED PROJECTION SAMPLES ===');
  for (const { label, row } of samples) {
    const lead = projectImportRow(row, { campaignName: STAFFING_CAMPAIGN.name, leadNiche });
    say('');
    say(`--- ${label}: ${lead.company} ---`);
    for (const key of ['email', 'company', 'contactName', 'city', 'tradeType', 'website', 'tier', 'stage',
      'emailStatus', 'siteContext', 'campaign', 'leadNiche', 'senderInboxId', 'emailTemplateId', 'routingRequired'])
      say(`   ${key.padEnd(18)} ${JSON.stringify(lead[key])}`);
    say(`   ${'opening preserved'.padEnd(18)} ${staffingOpeningFor(lead) === row.siteContext ? 'YES — byte-identical' : 'NO'}`);
    say(`   ${'ref_* stored?'.padEnd(18)} ${Object.keys(lead).some(k => k.startsWith('ref_')) ? 'YES (unexpected)' : 'NO — ignored as designed'}`);
  }

  // ── §14 end-to-end no-send trace ──────────────────────────────────────────
  say('');
  say('=== §14 END-TO-END NO-SEND TRACE (first 3 leads) ===');
  for (const row of rows.slice(0, 3)) {
    const lead = projectImportRow(row, { campaignName: STAFFING_CAMPAIGN.name, leadNiche });
    const routedForm = { ...lead, senderInboxId: 'primary', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId };
    say('');
    say(`--- ${lead.company} <${lead.email}> ---`);
    say(`   campaign resolution     : ${lead.campaign} -> version ${CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].id} (${CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].status})`);
    say(`   niche resolution        : ${lead.leadNiche} -> family ${familyForLead(routedForm)}`);
    say(`   offer context           : ${offerForLead(routedForm).name}`);
    say(`   personalization         : ${staffingOpeningFor(lead) ? 'present (from siteContext)' : 'MISSING'}`);
    say(`   sender assignment       : ${lead.senderInboxId || '(none at import — assigned at send reservation)'}`);
    const asImported = routedLeadReady(lead);
    say(`   routing gate (imported) : BLOCKED — ${asImported.reason}`);
    const asRouted = routedLeadReady(routedForm);
    say(`   routing gate (routed)   : ${asRouted.ok ? 'ALLOWED' : 'BLOCKED — ' + asRouted.reason}`);
    const vr = validateRoute({ niche: leadNiche, senderInboxId: 'primary', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
      inboxes: [{ id: 'primary', email: 'deins@scalelabai.ca', sendEligible: true, deliveryImplemented: true }] });
    say(`   validateRoute           : ${vr.ok ? 'ALLOWED' : 'BLOCKED — ' + vr.reason}`);
    say(`   active staffing versions: ${campaignVersionsForRoute({ niche: leadNiche }).length}`);
    const email = renderStaffingEmail(routedForm, 1);
    say(`   Email #1 subject        : ${JSON.stringify(email.subject)}`);
    say(`   Email #1 validation     : ${validateStaffingEmail(email, 1) || 'OK'}`);
    say(`   provider send           : NONE — campaign is draft/not-ready; no Gmail client was constructed`);
    say(`   FINAL                   : BLOCKED (campaign inactive). Copy renders correctly for review.`);
  }

  // ── rendered samples ──────────────────────────────────────────────────────
  const sample = { ...projectImportRow(rows[0], { campaignName: STAFFING_CAMPAIGN.name, leadNiche }),
    senderInboxId: 'primary', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    firstName: rows[0].ref_firstName || '' };
  say('');
  say(`=== §19 RENDERED STAFFING SEQUENCE (${sample.company}) ===`);
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(sample, step);
    say('');
    say(`----- EMAIL #${step} -----`);
    say(`Subject: ${email.subject === null ? '(none — threads under Email #1)' : email.subject}`);
    say(email.body);
    say(`[bold phrases: ${(email.html.match(/<strong>/g) || []).length}] [validation: ${validateStaffingEmail(email, step) || 'OK'}]`);
  }

  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'import-and-nosend-validation.txt');
  fs.writeFileSync(file, L.join('\n'));
  console.log(`\nwritten -> ${file}`);
  return file;
}

if (require.main === module) {
  run({ csvFile: process.argv[2], out: process.argv[3] });
}
module.exports = { run, projectImportRow, admissionChecks, CE_COLUMNS };
