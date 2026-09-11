#!/usr/bin/env node
'use strict';
/**
 * supabase-stage2-validate.js — cross-campaign parity + performance. READ-ONLY.
 *
 * Samples real leads across every campaign family and event profile, reads the
 * same lead from both stores, and compares. Google is opened with the READONLY
 * scope and Supabase is only ever GET, so this cannot mutate either side.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const { COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const { readCanonicalTimeline, readCanonicalTimelines, compareTimelines,
  supabaseMayServeTimeline } = require('../integrations/supabase-timeline');
const { familyForLead } = require('../integrations/campaign-versions');

const CE = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage',
  'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier',
  'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche',
  'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];

async function run(outDir) {
  if (!outDir) throw new Error('An output directory is required');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X', `${COLD_CALL_ACTIVITY_SHEET}!A:J`],
  });
  const leads = res.data.valueRanges[0].values.slice(1)
    .map(r => Object.fromEntries(CE.map((c, i) => [c, r[i] || '']))).filter(l => l.id);
  const acts = res.data.valueRanges[1].values.slice(1)
    .map(r => Object.fromEntries(COLD_CALL_ACTIVITY_HEADER.map((k, i) => [k, r[i] || ''])));

  const byLead = new Map();
  for (const row of acts) {
    const key = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(row);
  }
  const has = (id, ...types) => (byLead.get(id) || []).some(r => types.includes(r.eventType));

  // A sample chosen by PROFILE, not convenience: every family and every
  // behaviour class the prompt names.
  const pick = (label, predicate) => {
    const lead = leads.find(l => byLead.has(l.id) && predicate(l));
    return lead ? { label, lead } : null;
  };
  const profiles = [
    pick('dental', l => familyForLead(l) === 'dental_ai_receptionist'),
    pick('roofing', l => familyForLead(l) === 'roofing_survey'),
    pick('industrial_staffing', l => familyForLead(l) === 'industrial_staffing'),
    pick('replied', l => has(l.id, 'positive_reply', 'negative_reply', 'needs_human_reply', 'unsubscribe_reply')),
    pick('no-reply', l => (byLead.get(l.id) || []).length > 0 && !has(l.id, 'positive_reply', 'negative_reply', 'needs_human_reply')),
    pick('held/resumed', l => has(l.id, 'automation_held', 'automation_hold_released')),
    pick('meeting lifecycle', l => has(l.id, 'call_booked', 'meeting_no_show', 'meeting_rescheduled', 'closed_lost')),
    pick('sequence-driven', l => has(l.id, 'sequence_enrolled', 'sequence_step_sent', 'sequence_resumed')),
    pick('reconciled legacy', l => has(l.id, 'sender_evidence_reconciled')),
    pick('human outbound', l => has(l.id, 'human_response_sent')),
    pick('observer events', l => has(l.id, 'gmail_observation_gap', 'gmail_observation_recovered')),
  ].filter(Boolean);

  const results = [];
  for (const { label, lead } of profiles) {
    const authoritative = (byLead.get(lead.id) || []).map(({ _row, ...row }) => row);
    const started = Date.now();
    const mirrored = await readCanonicalTimeline({
      sourceLeadId: lead.id, leadId: `CE-${lead.id}`, email: lead.email });
    const ms = Date.now() - started;
    const parity = mirrored.ok ? compareTimelines(authoritative, mirrored.events) : null;
    const gate = supabaseMayServeTimeline(mirrored, { authoritativeCount: authoritative.length });
    results.push({
      profile: label, company: lead.company, leadId: lead.id,
      family: familyForLead(lead), campaign: lead.campaign || '',
      authoritative: authoritative.length, mirrored: mirrored.ok ? mirrored.events.length : null,
      exact: parity ? parity.exact : null,
      missing: parity ? parity.missing.length : null,
      extra: parity ? parity.extra.length : null,
      mismatched: parity ? parity.mismatched.length : null,
      orderMatches: parity ? parity.orderMatches : null,
      parityClean: parity ? parity.parityClean : false,
      contentBearing: parity ? parity.contentBearingAuthoritative : null,
      mayServePrimary: gate.allowed, mayServeReason: gate.reason,
      readMs: ms,
    });
  }

  // ── performance ───────────────────────────────────────────────────────────
  const sizes = [...byLead.entries()].map(([id, rows]) => ({ id, n: rows.length })).sort((a, b) => b.n - a.n);
  const largest = sizes[0];
  const emptyLead = leads.find(l => !byLead.has(l.id));
  const time = async fn => { const t = Date.now(); const out = await fn(); return { ms: Date.now() - t, out }; };

  const one = await time(() => readCanonicalTimeline({ sourceLeadId: profiles[0].lead.id }));
  const big = await time(() => readCanonicalTimeline({ sourceLeadId: largest.id }));
  const none = await time(() => readCanonicalTimeline({ sourceLeadId: emptyLead ? emptyLead.id : 'no-such-lead' }));
  const hundredIds = sizes.slice(0, 100).map(s => s.id);
  const batch = await time(() => readCanonicalTimelines({ sourceLeadIds: hundredIds }));
  const serial = await time(async () => {
    const t0 = Date.now();
    for (const id of hundredIds.slice(0, 10)) await readCanonicalTimeline({ sourceLeadId: id });
    return Date.now() - t0;
  });

  const perf = {
    oneLeadMs: one.ms, oneLeadEvents: one.out.events.length,
    largestLeadMs: big.ms, largestLeadEvents: big.out.events.length, largestLeadId: largest.id,
    emptyLeadMs: none.ms, emptyLeadEvents: none.out.events.length,
    batch100Ms: batch.ms, batch100LeadsReturned: batch.out.byLead ? batch.out.byLead.size : 0,
    serial10Ms: serial.ms,
    projectedSerial100Ms: Math.round((serial.ms / 10) * 100),
    batchSpeedupVsSerial100: serial.ms ? Number((((serial.ms / 10) * 100) / Math.max(batch.ms, 1)).toFixed(1)) : null,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const columns = Object.keys(results[0]);
  fs.writeFileSync(path.join(outDir, 'stage2-cross-campaign-parity.csv'),
    [columns.join(','), ...results.map(r => columns.map(c => {
      const v = String(r[c] ?? '');
      return /[",\n]/.test(v) ? `"${v.split('"').join('""')}"` : v;
    }).join(','))].join('\n'));
  fs.writeFileSync(path.join(outDir, 'stage2-performance-report.md'),
    ['# Stage 2 Supabase read performance', '',
      '| Scenario | Result |', '|---|---|',
      `| One lead timeline | ${perf.oneLeadMs} ms (${perf.oneLeadEvents} events) |`,
      `| Largest-history lead | ${perf.largestLeadMs} ms (${perf.largestLeadEvents} events) |`,
      `| Empty-history lead | ${perf.emptyLeadMs} ms (${perf.emptyLeadEvents} events) |`,
      `| 100 leads, one batched query | ${perf.batch100Ms} ms (${perf.batch100LeadsReturned} leads returned) |`,
      `| 10 leads, one query each | ${perf.serial10Ms} ms |`,
      `| 100 leads serially (projected) | ${perf.projectedSerial100Ms} ms |`,
      `| Batch speed-up vs serial | ${perf.batchSpeedupVsSerial100}x |`, '',
      'The batched reader exists so a 100-lead view costs one request rather than 100.',
    ].join('\n'));

  console.log('=== CROSS-CAMPAIGN PARITY ===');
  for (const r of results) {
    console.log(`  ${r.profile.padEnd(20)} ${String(r.authoritative).padStart(4)} sheets  ${String(r.mirrored).padStart(4)} supabase  `
      + `exact=${r.exact} missing=${r.missing} extra=${r.extra} mismatch=${r.mismatched} order=${r.orderMatches}  `
      + `${r.parityClean ? 'CLEAN' : 'DIFF'}  [${r.family}]  ${r.readMs}ms`);
  }
  console.log('\n=== PERFORMANCE ===');
  console.log(JSON.stringify(perf, null, 2));
  const allClean = results.every(r => r.parityClean);
  console.log(`\nall profiles parity-clean: ${allClean}`);
  return { results, perf, allClean };
}

if (require.main === module) run(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { run };
