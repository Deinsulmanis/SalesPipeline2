#!/usr/bin/env node
/**
 * check-leads.js — flags junk/malformed emails in leads-enriched.csv before import.
 * Read-only: prints a report, writes nothing. Run after enrich-leads.js.
 *
 *   node check-leads.js                     # checks leads-enriched.csv
 *   node check-leads.js some-other.csv      # checks a named file
 *
 * FLAGGED buckets:
 *   PLACEHOLDER  — template dummy addresses that always bounce
 *   MALFORMED    — concatenation bleed (phone/text glued to the address)
 *   THIRD_PARTY  — tracking/widget domains, not the business's own inbox
 * CLEAN rows are counted and listed so you can eyeball the keep-pile too.
 */

'use strict';
const fs = require('fs');

const FILE = process.argv[2] || 'leads-enriched.csv';

// Template dummies scraped off sites — 100% bounce.
const PLACEHOLDER = [
  'user@domain.com', 'email@example.com', 'your@email.com', 'email@here.com',
  'name@company.com', 'info@example.com', 'test@test.com', 'example@',
];

// Third-party / tracking / widget domains — never the business's real inbox.
const THIRD_PARTY_DOMAINS = [
  'sentry.io', 'wixpress.com', 'maleoptimization.com', 'naturehealthsolution.com',
  'truehealthdigest.com', 'godaddy.com', 'gumdocs.com', 'studiothink.com',
  'ingest.sentry.io',
];

// Simple CSV line splitter (handles quoted fields).
function splitLine(line, delim) {
  const cells = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === delim && !q) { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

function classify(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return 'BLANK';

  if (PLACEHOLDER.some(p => e.includes(p))) return 'PLACEHOLDER';

  const at = e.indexOf('@');
  if (at === -1) return 'MALFORMED';
  const local  = e.slice(0, at);
  const domain = e.slice(at + 1);

  // Leading non-alphanumeric (e.g. %20, -687-1887) or digits-then-info pattern
  if (/^[^a-z0-9]/.test(e)) return 'MALFORMED';
  if (/^\d[\d\-]*[a-z]/.test(local)) return 'MALFORMED';   // 800-7297info, 0939information

  // TLD sanity: real TLD is 2-6 letters. gmail.comhours / gmail.comtel / gmail.com604... fail this.
  const tld = domain.split('.').pop();
  if (!/^[a-z]{2,6}$/.test(tld)) return 'MALFORMED';

  if (THIRD_PARTY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return 'THIRD_PARTY';

  return 'CLEAN';
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}\nRun enrich-leads.js first, or pass the filename.`);
    process.exit(1);
  }
  const raw   = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n').filter(l => l.trim());
  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const header = splitLine(lines[0], delim).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));

  const emailIdx = header.indexOf('email');
  const coIdx    = header.indexOf('company');
  if (emailIdx === -1) { console.error('No "email" column found in header.'); process.exit(1); }

  const buckets = { PLACEHOLDER: [], MALFORMED: [], THIRD_PARTY: [], BLANK: [], CLEAN: [] };

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const email = cells[emailIdx] || '';
    const co    = coIdx > -1 ? (cells[coIdx] || '—') : '—';
    buckets[classify(email)].push({ co, email });
  }

  const flagged = ['PLACEHOLDER', 'MALFORMED', 'THIRD_PARTY'];
  const bar = '─'.repeat(60);

  console.log(`\n${bar}\n  Lead check: ${FILE}\n${bar}`);
  for (const b of flagged) {
    if (!buckets[b].length) continue;
    console.log(`\n🔴 ${b} — REMOVE (${buckets[b].length})`);
    buckets[b].forEach(r => console.log(`   ${r.email.padEnd(45)} ${r.co}`));
  }
  if (buckets.BLANK.length) console.log(`\n⚪ BLANK email — ${buckets.BLANK.length} row(s) (already excluded by import)`);

  console.log(`\n🟢 CLEAN — KEEP (${buckets.CLEAN.length})`);
  buckets.CLEAN.forEach(r => console.log(`   ${r.email.padEnd(45)} ${r.co}`));

  const removeCount = flagged.reduce((n, b) => n + buckets[b].length, 0);
  console.log(`\n${bar}`);
  console.log(`  Keep: ${buckets.CLEAN.length}   Remove: ${removeCount}   Blank: ${buckets.BLANK.length}`);
  console.log(`  → Delete the 🔴 rows from ${FILE} before importing.`);
  console.log(bar + '\n');
}

// CLI when run directly; importable classifier for server.js (import choke
// point) and outreach-agent.js (selectQueued) otherwise — one source of truth.
if (require.main === module) main();

module.exports = { classify, PLACEHOLDER, THIRD_PARTY_DOMAINS };
