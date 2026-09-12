#!/usr/bin/env node
'use strict';
/**
 * supabase-outreach-schema-check.js — verify outreach_leads after the migration.
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only. Confirms the applied schema matches what the Stage 3 mirror expects,
 * using the only introspection a service key reaches: the PostgREST OpenAPI spec.
 *
 * WHAT THIS CAN AND CANNOT SEE
 *
 * PostgREST exposes tables, columns, types, nullability, defaults, generated
 * columns and the primary key. It does NOT expose indexes, unique constraints
 * other than the PK, or RLS state — those live in the catalogue, and reading the
 * catalogue needs SQL, which a service key cannot execute over PostgREST.
 *
 * So this script reports what it verified and says plainly what it could not,
 * and prints the SQL to run in the Supabase SQL editor for the rest. It never
 * writes a probe row to infer a constraint: this runs against production, and
 * inferring a unique index by provoking a 409 would mean inserting and deleting
 * real rows in the authoritative-adjacent store.
 *
 *   node scripts/supabase-outreach-schema-check.js
 *   node scripts/supabase-outreach-schema-check.js --table=crm_events
 */

require('dotenv').config();
const { mirrorConfig } = require('../integrations/supabase-mirror');
const { TABLE, FIELD_MAP } = require('../integrations/outreach-state');

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const target = value('table', TABLE);

// Columns the mirror writes that are not ColdEmail fields.
const MIRROR_COLUMNS = ['last_emailed_at_ts', 'email_step_int', 'sheet_row', 'updated_at', 'mirrored_at'];
// Columns the schema must carry for later stages, unused today.
const RESERVED_COLUMNS = ['revision', 'created_at', 'email_normalized'];

const EXPECTED_TEXT = new Set(Object.values(FIELD_MAP));

async function main() {
  const config = mirrorConfig();
  if (!config.enabled) {
    console.error(`Supabase is not configured: ${config.reason}`);
    process.exitCode = 2;
    return;
  }
  const headers = { apikey: config.key, Authorization: `Bearer ${config.key}` };

  const probe = await fetch(`${config.url}/rest/v1/${target}?select=*&limit=0`, { headers });
  console.log(`table ${target}: HTTP ${probe.status} ${probe.ok ? '— EXISTS' : '— NOT FOUND'}`);
  if (!probe.ok) {
    console.error('\nThe migration has not been applied. Nothing below can be verified.');
    process.exitCode = 1;
    return;
  }

  const spec = await (await fetch(`${config.url}/rest/v1/`, { headers })).json();
  const definition = (spec.definitions || {})[target];
  if (!definition) {
    console.error(`PostgREST exposes ${target} but publishes no column definition for it.`);
    process.exitCode = 1;
    return;
  }
  const properties = definition.properties || {};
  const actual = Object.keys(properties);

  let failures = 0;
  const fail = message => { failures++; console.log(`  FAIL  ${message}`); };
  const pass = message => console.log(`  ok    ${message}`);

  console.log('\n── columns ────────────────────────────────────────────');
  for (const column of EXPECTED_TEXT) {
    const property = properties[column];
    if (!property) { fail(`${column} is missing`); continue; }
    if (property.format !== 'text') {
      fail(`${column} has type "${property.format}", expected text — the runtime compares these as strings`);
      continue;
    }
    if (property.default !== undefined) {
      fail(`${column} has a DEFAULT (${JSON.stringify(property.default)}); a coerced value would break parity`);
      continue;
    }
    pass(`${column} (text, no default)`);
  }

  console.log('\n── derived and mirror-side columns ────────────────────');
  const expectedTypes = {
    last_emailed_at_ts: 'timestamp with time zone', email_step_int: 'integer',
    sheet_row: 'integer', updated_at: 'timestamp with time zone',
    mirrored_at: 'timestamp with time zone', created_at: 'timestamp with time zone',
    revision: 'bigint', email_normalized: 'text',
  };
  for (const column of [...MIRROR_COLUMNS, ...RESERVED_COLUMNS]) {
    const property = properties[column];
    if (!property) { fail(`${column} is missing`); continue; }
    const want = expectedTypes[column];
    if (want && property.format !== want) fail(`${column} is "${property.format}", expected ${want}`);
    else pass(`${column} (${property.format})`);
  }

  console.log('\n── key and generated columns ──────────────────────────');
  const pk = actual.filter(c => /<pk/.test(String(properties[c].description || '')));
  if (pk.length === 1 && pk[0] === 'lead_id') pass('primary key is lead_id — upserts are idempotent');
  else fail(`primary key is ${pk.length ? pk.join(', ') : '(none found)'}, expected lead_id`);

  const generated = String(properties.email_normalized?.description || '');
  const normalizedIsGenerated = /generated/i.test(generated) || properties.email_normalized?.readOnly === true;
  if (normalizedIsGenerated) pass('email_normalized is generated — it cannot drift from email');
  else console.log('  note  email_normalized generated-ness is not visible via PostgREST; confirm with the SQL below');

  console.log('\n── unexpected columns ─────────────────────────────────');
  const unexpected = actual.filter(c => !EXPECTED_TEXT.has(c)
    && !MIRROR_COLUMNS.includes(c) && !RESERVED_COLUMNS.includes(c));
  if (unexpected.length) fail(`unexpected column(s): ${unexpected.join(', ')}`);
  else pass('no columns beyond the 24 ColdEmail fields + derived + reserved');

  console.log(`\n── what PostgREST CANNOT verify ───────────────────────`);
  console.log('  Indexes, the partial unique index on email_normalized, and RLS state are');
  console.log('  catalogue facts that a service key cannot read over PostgREST. Run this in');
  console.log('  the Supabase SQL editor to confirm them:\n');
  console.log(`    select indexname, indexdef from pg_indexes`);
  console.log(`     where schemaname = 'public' and tablename = '${target}' order by indexname;`);
  console.log(`    select relrowsecurity as rls_enabled from pg_class`);
  console.log(`     where oid = 'public.${target}'::regclass;`);
  console.log(`    select count(*) as policy_count from pg_policies`);
  console.log(`     where schemaname = 'public' and tablename = '${target}';`);
  console.log('\n  Expected: 8 indexes (1 primary key + outreach_leads_email_normalized_key');
  console.log('  + 6 lookup indexes), rls_enabled = true, policy_count = 0.');

  console.log(`\n  VERDICT: ${failures === 0
    ? 'SCHEMA OK — every column the mirror writes exists with the expected type.'
    : `${failures} problem(s) found.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(`schema check failed: ${error.message}`);
  process.exitCode = 1;
});
