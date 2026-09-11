#!/usr/bin/env node
'use strict';
/**
 * supabase-stage2f-validate.js — hybrid FINAL-RESULT parity + performance.
 * READ-ONLY on both stores (Sheets opened with the readonly scope, Supabase GET).
 *
 * Stage 2 compared metadata. This compares the array the timeline is actually
 * built from — content included — for a representative sample of real leads.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const { COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const { readTimelineHybrid, compareHybridActivities, hybridMayServeTimeline } = require('../integrations/supabase-timeline-hybrid');
const { CONTENT_BEARING_TYPES } = require('../integrations/supabase-timeline');
const { familyForLead } = require('../integrations/campaign-versions');
const { hasManualHold } = require('../integrations/pipeline-state');

const CE = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage',
  'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier',
  'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche',
  'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];

const csv = (rows, columns) => [columns.join(','),
  ...rows.map(row => columns.map(c => {
    const v = String(row[c] ?? '');
    return /[",\n]/.test(v) ? `"${v.split('"').join('""')}"` : v;
  }).join(','))].join('\n');

async function run(outDir) {
  if (!outDir) throw new Error('An output directory is required');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const t0 = Date.now();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X', `${COLD_CALL_ACTIVITY_SHEET}!A:J`],
  });
  const sheetReadMs = Date.now() - t0;
  const leads = res.data.valueRanges[0].values.slice(1)
    .map(r => Object.fromEntries(CE.map((c, i) => [c, r[i] || '']))).filter(l => l.id);
  const allRows = res.data.valueRanges[1].values.slice(1)
    .map(r => Object.fromEntries(COLD_CALL_ACTIVITY_HEADER.map((k, i) => [k, r[i] || ''])));

  const byLead = new Map();
  for (const row of allRows) {
    const key = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(row);
  }
  const loadAll = async () => allRows;   // stands in for the server's lazy Sheets read
  const authoritativeFor = lead => (byLead.get(lead.id) || [])
    .slice().sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0));
  const has = (id, ...types) => (byLead.get(id) || []).some(r => types.includes(r.eventType));
  const contentCount = id => (byLead.get(id) || []).filter(r => String(r.content || '').trim()).length;

  const pick = (label, predicate) => {
    const lead = leads.find(l => predicate(l));
    return lead ? { label, lead } : { label, lead: null };
  };
  const profiles = [
    pick('dental active', l => familyForLead(l) === 'dental_ai_receptionist' && byLead.has(l.id) && !has(l.id, 'positive_reply', 'negative_reply')),
    pick('dental replied', l => has(l.id, 'positive_reply', 'negative_reply', 'needs_human_reply', 'unsubscribe_reply')),
    pick('no-reply', l => byLead.has(l.id) && !has(l.id, 'positive_reply', 'negative_reply', 'needs_human_reply')),
    pick('MANUAL HOLD', l => byLead.has(l.id) && hasManualHold(l.notes || '')),
    pick('resumed', l => has(l.id, 'automation_hold_released', 'sequence_resumed')),
    pick('meeting booked', l => has(l.id, 'call_booked')),
    pick('no-show/cancelled', l => has(l.id, 'meeting_no_show', 'meeting_rescheduled')),
    pick('sequence-driven', l => has(l.id, 'sequence_enrolled', 'sequence_step_sent')),
    pick('reconciled sender/thread', l => has(l.id, 'sender_evidence_reconciled')),
    pick('human_response_sent', l => has(l.id, 'human_response_sent')),
    pick('high-content timeline', l => contentCount(l.id) >= 3),
    pick('no-content timeline', l => byLead.has(l.id) && contentCount(l.id) === 0
      && !(byLead.get(l.id) || []).some(r => CONTENT_BEARING_TYPES.has(r.eventType))),
    pick('empty timeline', l => !byLead.has(l.id)),
    pick('staffing', l => familyForLead(l) === 'industrial_staffing' && byLead.has(l.id)),
    pick('roofing', l => familyForLead(l) === 'roofing_survey' && byLead.has(l.id)),
  ];

  const results = [], fallbacks = [];
  for (const { label, lead } of profiles) {
    if (!lead) { results.push({ profile: label, skipped: 'no lead matches this profile' }); continue; }
    const authoritative = authoritativeFor(lead).map(({ _row, ...row }) => row);
    const started = Date.now();
    const hybrid = await readTimelineHybrid({
      sourceLeadId: lead.id, leadId: `CE-${lead.id}`, email: lead.email,
      loadAuthoritativeActivities: loadAll,
    });
    const ms = Date.now() - started;
    const gate = hybridMayServeTimeline(hybrid, { authoritativeCount: authoritative.length });
    const parity = hybrid.ok ? compareHybridActivities(authoritative, hybrid.activities) : null;
    if (!hybrid.ok) fallbacks.push({ profile: label, leadId: lead.id, reason: hybrid.fallbackReason, detail: hybrid.detail });
    results.push({
      profile: label, company: lead.company, leadId: lead.id, family: familyForLead(lead),
      authoritative: authoritative.length, hybrid: hybrid.ok ? hybrid.activities.length : null,
      contentEvents: contentCount(lead.id), hydrated: hybrid.hydrated,
      sheetsConsulted: hybrid.sheetsConsulted,
      exact: parity ? parity.exact : null,
      missing: parity ? parity.missing.length : null,
      extra: parity ? parity.extra.length : null,
      mismatched: parity ? parity.mismatched.length : null,
      contentMismatched: parity ? parity.contentMismatched.length : null,
      orderMatches: parity ? parity.orderMatches : null,
      parityClean: parity ? parity.parityClean : false,
      mayServe: gate.allowed, fallbackReason: hybrid.fallbackReason || '', readMs: ms,
    });
  }

  // ── performance ───────────────────────────────────────────────────────────
  const sizes = [...byLead.entries()].map(([id, rows]) => ({ id, n: rows.length })).sort((a, b) => b.n - a.n);
  const noContentLead = leads.find(l => byLead.has(l.id)
    && !(byLead.get(l.id) || []).some(r => CONTENT_BEARING_TYPES.has(r.eventType)));
  const bodyHeavy = leads.find(l => contentCount(l.id) >= 3);
  const time = async fn => { const t = Date.now(); const out = await fn(); return { ms: Date.now() - t, out }; };
  const hybridFor = lead => readTimelineHybrid({ sourceLeadId: lead.id, leadId: `CE-${lead.id}`,
    email: lead.email, loadAuthoritativeActivities: loadAll });

  const noContent = noContentLead ? await time(() => hybridFor(noContentLead)) : null;
  const heavy = bodyHeavy ? await time(() => hybridFor(bodyHeavy)) : null;
  const largest = await time(() => readTimelineHybrid({ sourceLeadId: sizes[0].id, loadAuthoritativeActivities: loadAll }));

  // How much of the corpus avoids the sheet entirely under primary mode.
  let skipsSheet = 0;
  for (const [id, rows] of byLead) if (!rows.some(r => CONTENT_BEARING_TYPES.has(r.eventType))) skipsSheet++;

  const perf = {
    existingReaderFullSheetMs: sheetReadMs,
    hybridNoContentMs: noContent ? noContent.ms : null,
    hybridNoContentSheetsConsulted: noContent ? noContent.out.sheetsConsulted : null,
    hybridBodyHeavyMs: heavy ? heavy.ms : null,
    hybridBodyHeavyHydrated: heavy ? heavy.out.hydrated : null,
    hybridLargestMs: largest.ms, hybridLargestEvents: largest.out.activities.length,
    leadsWithActivity: byLead.size, leadsSkippingSheetEntirely: skipsSheet,
    percentSkippingSheet: Math.round((skipsSheet / byLead.size) * 100),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const shown = results.filter(r => !r.skipped);
  fs.writeFileSync(path.join(outDir, 'stage2f-parity.csv'), csv(shown, Object.keys(shown[0])));
  fs.writeFileSync(path.join(outDir, 'stage2f-fallbacks.csv'),
    fallbacks.length ? csv(fallbacks, ['profile', 'leadId', 'reason', 'detail']) : 'profile,leadId,reason,detail');
  fs.writeFileSync(path.join(outDir, 'stage2f-performance.md'), [
    '# Stage 2F hybrid read performance', '',
    '| Scenario | Result |', '|---|---|',
    `| Existing reader: full activity sheet read | ${perf.existingReaderFullSheetMs} ms |`,
    `| Hybrid, no-content lead | ${perf.hybridNoContentMs} ms (sheet consulted: ${perf.hybridNoContentSheetsConsulted}) |`,
    `| Hybrid, body-heavy lead | ${perf.hybridBodyHeavyMs} ms (${perf.hybridBodyHeavyHydrated} bodies hydrated) |`,
    `| Hybrid, largest timeline | ${perf.hybridLargestMs} ms (${perf.hybridLargestEvents} events) |`,
    `| Leads avoiding the sheet entirely | ${perf.leadsSkippingSheetEntirely} / ${perf.leadsWithActivity} (${perf.percentSkippingSheet}%) |`,
    '', 'The existing reader pulls the whole activity tab on every request because',
    'readIntegrationRows is uncached. Hybrid skips that read entirely for leads with',
    'no content-bearing event, and costs the same single read for the rest.',
  ].join('\n'));

  console.log('=== STAGE 2F FINAL-RESULT PARITY ===');
  for (const r of results) {
    if (r.skipped) { console.log(`  ${r.profile.padEnd(26)} SKIPPED — ${r.skipped}`); continue; }
    console.log(`  ${r.profile.padEnd(26)} ${String(r.authoritative).padStart(3)} auth  ${String(r.hybrid).padStart(3)} hybrid  `
      + `content=${r.contentEvents} hydrated=${r.hydrated} sheet=${r.sheetsConsulted ? 'yes' : 'NO '}  `
      + `contentMismatch=${r.contentMismatched} order=${r.orderMatches}  ${r.parityClean ? 'CLEAN' : 'DIFF ' + r.fallbackReason}  ${r.readMs}ms`);
  }
  console.log('\n=== PERFORMANCE ===');
  console.log(JSON.stringify(perf, null, 2));
  const checked = shown.filter(r => r.hybrid !== null);
  const allClean = checked.every(r => r.parityClean);
  console.log(`\nprofiles checked: ${checked.length}  all parity-clean: ${allClean}  fallbacks: ${fallbacks.length}`);
  fs.writeFileSync(path.join(outDir, 'stage2f-production-dual-validation.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), results, fallbacks, perf, allClean }, null, 2));
  return { results, fallbacks, perf, allClean };
}

if (require.main === module) run(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { run };
