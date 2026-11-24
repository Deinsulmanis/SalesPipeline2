#!/usr/bin/env node
'use strict';
// Load the private sample-employer file into Supabase `sample_employers`.
//   node scripts/load-sample-employers.js <runs-private/.../sample_employers_load.json>          (dry run)
//   node scripts/load-sample-employers.js <file> --apply                                          (upsert)
// The file is company-level only and lives in git-ignored runs-private/.
// Rows carrying contact fields are refused. Secrets come from .env in memory.
require('dotenv').config();
const { readFileSync } = require('node:fs');
const { mirrorConfig } = require('../integrations/supabase-mirror');
const { cleanTitle, STATE_NAMES, noDashes } = require('../integrations/scalelab-sample-list');

const COLUMNS = ['domain', 'company', 'city', 'state', 'industry', 'trade_focus', 'open_roles', 'open_roles_label',
  'example_roles', 'newest_posting', 'checked_at', 'status', 'national_rank'];
const CONTACT_FIELD = /email|phone|contact|first_name|last_name|linkedin|person/i;

function validateRows(rows) {
  const problems = [];
  const ranks = new Set();
  for (const row of rows) {
    const extra = Object.keys(row).filter(key => !COLUMNS.includes(key));
    if (extra.some(key => CONTACT_FIELD.test(key))) problems.push(`${row.domain}: contact field present`);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(row.domain || '')) problems.push(`${row.domain}: bad domain`);
    if (!STATE_NAMES[row.state]) problems.push(`${row.domain}: bad state`);
    if (!['hiring', 'not_hiring', 'unchecked'].includes(row.status)) problems.push(`${row.domain}: bad status`);
    if (row.status === 'hiring' && (!row.checked_at || !(row.open_roles > 0))) problems.push(`${row.domain}: hiring without a check`);
    if (row.national_rank != null && (row.status !== 'hiring' || ranks.has(row.national_rank))) problems.push(`${row.domain}: bad national rank`);
    if (row.national_rank != null) ranks.add(row.national_rank);
  }
  return problems;
}

function prepare(rows) {
  return rows.map(row => {
    const out = Object.fromEntries(COLUMNS.map(key => [key, row[key] ?? null]));
    out.company = noDashes(out.company);
    out.city = noDashes(out.city || '');
    out.industry = out.industry || '';
    out.trade_focus = out.trade_focus || '';
    out.open_roles = Number(out.open_roles) || 0;
    out.example_roles = (out.example_roles || []).map(cleanTitle).filter(Boolean).slice(0, 3);
    out.updated_at = new Date().toISOString();
    return out;
  });
}

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) throw new Error('usage: load-sample-employers.js <file.json> [--apply]');
  const rows = prepare(JSON.parse(readFileSync(file, 'utf8')).rows || []);
  const problems = validateRows(rows);
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
  console.log(JSON.stringify({ rows: rows.length, ...counts, national: rows.filter(r => r.national_rank).length, problems: problems.length }));
  if (problems.length) { console.error(problems.slice(0, 20).join('\n')); process.exitCode = 1; return; }
  if (flag !== '--apply') { console.log('dry run: nothing written (pass --apply to upsert)'); return; }
  const config = mirrorConfig();
  if (!config.enabled) throw new Error(config.reason);
  for (let i = 0; i < rows.length; i += 200) {
    const response = await fetch(`${config.url}/rest/v1/sample_employers?on_conflict=domain`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { apikey: config.key, Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!response.ok) throw new Error(`upsert batch ${i / 200 + 1} failed: ${response.status}`);
  }
  console.log(`upserted ${rows.length} sample employer rows`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateRows, prepare };
