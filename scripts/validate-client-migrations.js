#!/usr/bin/env node
'use strict';
/**
 * Validates the multi-client migrations against a REAL PostgreSQL 17 server
 * (official binaries via embedded-postgres). Never touches production.
 *
 *   mkdir /tmp/pgval && cd /tmp/pgval && npm i embedded-postgres@17.9.0-beta.17 pg@8
 *   NODE_PATH=/tmp/pgval/node_modules node scripts/validate-client-migrations.js
 *
 * embedded-postgres is deliberately NOT a project dependency. The cluster is
 * created UTF-8 (as Supabase is) under a temp directory and removed afterwards.
 * Each migration is applied inside a transaction, as Supabase applies them,
 * on top of the production baseline (20260912000000) seeded with production-
 * shaped ScaleLab rows. Exit code 0 only if every check passes.
 *
 * 2026-09-29: PostgreSQL 17.9, encoding UTF8 — 46/46 checks passed.
 */
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const os = require('os');
const WT = process.argv[2] || path.join(__dirname, '..');
const MIG = path.join(WT, 'supabase', 'migrations');
const read = name => fs.readFileSync(path.join(MIG, name), 'utf8');
const BASELINE = read('20260912000000_outreach_leads.sql');
const LEDGER = read('20260930000000_client_ledger.sql');
const CLIENT_ID = read('20260930010000_outreach_leads_client_id.sql');
const TENANT = read('20260930020000_outreach_leads_tenant_scoped_email.sql');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function migrate(db, sql) {
  await db.query('BEGIN');
  try { await db.query(sql); await db.query('COMMIT'); return { ok: true }; }
  catch (error) { await db.query('ROLLBACK'); return { ok: false, code: error.code, message: error.message }; }
}
async function expectError(db, sql, code) {
  await db.query('SAVEPOINT s');
  try { await db.query(sql); await db.query('ROLLBACK TO SAVEPOINT s'); return { ok: false, got: 'no error' }; }
  catch (error) { await db.query('ROLLBACK TO SAVEPOINT s'); return { ok: error.code === code, got: `${error.code} ${error.message.split('\n')[0]}` }; }
}
async function scalar(db, sql, params) { const r = await db.query(sql, params); return r.rows[0] ? Object.values(r.rows[0])[0] : null; }
const indexExists = (db, name) => scalar(db, 'select count(*)::int from pg_indexes where schemaname=$1 and indexname=$2', ['public', name]);
const columnInfo = (db, table, column) => db.query(
  'select data_type, is_nullable, column_default from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',
  ['public', table, column]).then(r => r.rows[0] || null);
const schemaShape = db => db.query(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') d
  from information_schema.columns where table_schema='public' order by 1,2`).then(r => r.rows.map(x => `${x.table_name}.${x.column_name}:${x.data_type}:${x.is_nullable}:${x.d}`));
const indexShape = db => db.query(`select indexname from pg_indexes where schemaname='public' order by 1`).then(r => r.rows.map(x => x.indexname));
// Checksum of every ORIGINAL outreach_leads column, to prove existing data is untouched.
const ORIGINAL = ['lead_id','company','contact_name','email','city','trade_type','website','stage','email_status','last_emailed_at','email_step','notes','review_count','rating','tier','site_context','campaign','campaign_notes','enrichment_attempted','lead_niche','sender_inbox_id','email_template_id','routing_required','intended_campaign_version','email_normalized','last_emailed_at_ts','email_step_int','sheet_row','revision','created_at','updated_at','mirrored_at'];
const checksum = db => scalar(db, `select md5(string_agg(row(${ORIGINAL.join(',')})::text, '|' order by lead_id)) from public.outreach_leads`);

async function seedScaleLab(db) {
  // Representative production shapes (2026-09-29 audit): dental, staffing,
  // roofing, blank legacy, blank emails (allowed twice by the partial index).
  const rows = [
    ['d1', 'office@smiles.example.com', 'dental', 'dental-guarantee-v1', 'dental_v3_pay_per_booking', 'Ontario List', 'primary'],
    ['d2', 'front@teeth.example.com', 'dental', 'dental-guarantee-v1', '', 'BC Dentists — 33 Cities — Aug 2026', 'tryscalelabai'],
    ['s1', 'ceo@staffco.example.com', 'industrial_staffing', 'industrial-staffing-employer-v1', 'industrial_staffing_employer_acquisition_v1', 'Industrial Staffing Agency', 'scalelabaiteam'],
    ['r1', 'owner@roofs.example.com', 'roofing', 'roofing-survey-v1', '', 'BC Roofing Survey', ''],
    ['l1', 'legacy@old.example.com', '', '', '', 'toronto-medspa-jul', ''],
    ['b1', '', '', '', '', '', ''], ['b2', '', '', '', '', '', ''],
  ];
  for (const r of rows) {
    await db.query(`insert into public.outreach_leads (lead_id,email,lead_niche,email_template_id,intended_campaign_version,campaign,sender_inbox_id,stage,notes,revision)
      values ($1,$2,$3,$4,$5,$6,$7,'Contacted','[REPLY: Interested]',3)`, r);
  }
  return rows.length;
}

async function freshDb(pgServer, name) {
  await pgServer.createDatabase(name);
  const db = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pgval', database: name });
  await db.connect();
  const base = await migrate(db, BASELINE);
  if (!base.ok) throw new Error('baseline failed: ' + base.message);
  return db;
}

const PORT = 54329;
(async () => {
  const pgServer = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pgval-')), user: 'postgres', password: 'pgval', port: PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pgServer.initialise();
  await pgServer.start();
  try {
    // ── Main path: baseline → ledger → client_id → tenant ─────────────────
    const db = await freshDb(pgServer, 'main_path');
    const version = await scalar(db, 'show server_version');
    console.log(`PostgreSQL ${version} encoding=${await scalar(db, 'show server_encoding')}`);
    const seeded = await seedScaleLab(db);
    const before = await checksum(db);
    const shapeBefore = await schemaShape(db);
    const indexesBefore = await indexShape(db);

    // A. Ledger migration
    let r = await migrate(db, LEDGER);
    check('A1 ledger migration applies cleanly', r.ok, r.message);
    check('A2 clients seeded (scalelab, jole)', (await scalar(db, "select string_agg(client_id, ',' order by client_id) from public.clients")) === 'jole,scalelab');
    r = await migrate(db, LEDGER);
    check('A3 ledger migration re-run is safe (idempotent)', r.ok && (await scalar(db, 'select count(*)::int from public.clients')) === 2, r.message);
    const rls = await scalar(db, `select count(*)::int from pg_class where relname in ('clients','client_opportunities','client_meetings','client_clarifications','client_suppressions','client_ledger_events') and relrowsecurity`);
    check('A4 RLS enabled on all six ledger tables', rls === 6, `${rls}/6`);
    await db.query('BEGIN');
    await db.query(`insert into public.client_opportunities (opportunity_id, client_id, lead_id) values ('opp:jole:x','jole','x')`);
    let e = await expectError(db, `insert into public.client_meetings (meeting_id, client_id, opportunity_id, lead_id, meeting_status, booked_at) values ('m1','scalelab','opp:jole:x','x','BOOKED',now())`, '23503');
    check('A5 a meeting cannot attach to another client\'s opportunity (composite FK)', e.ok, e.got);
    e = await expectError(db, `insert into public.client_clarifications (clarification_id, client_id, opportunity_id, lead_id, question) values ('c1','scalelab','opp:jole:x','x','q')`, '23503');
    check('A6 a clarification cannot attach to another client\'s opportunity', e.ok, e.got);
    e = await expectError(db, `insert into public.client_meetings (meeting_id, client_id, opportunity_id, lead_id, meeting_status, booked_at, billable) values ('m2','jole','opp:jole:x','x','HELD',now(),true)`, '23514');
    check('A7 billable requires QUALIFIED_HELD + held_at + qualified (check constraint)', e.ok, e.got);
    e = await expectError(db, `insert into public.client_meetings (meeting_id, client_id, opportunity_id, lead_id, meeting_status, booked_at) values ('m3','jole','opp:jole:x','x','SCHEDULED',now())`, '23514');
    check('A8 unknown meeting status refused', e.ok, e.got);
    e = await expectError(db, `insert into public.client_opportunities (opportunity_id, client_id, lead_id) values ('opp:acme:y','acme','y')`, '23503');
    check('A9 unknown client refused (FK to clients)', e.ok, e.got);
    e = await expectError(db, `insert into public.client_suppressions (client_id, match_type, match_value) values ('jole','phone','1')`, '23514');
    check('A10 client suppression match_type constrained', e.ok, e.got);
    e = await expectError(db, `insert into public.client_opportunities (opportunity_id, client_id, lead_id) values ('opp:jole:x2','jole','x')`, '23505');
    check('A11 one opportunity per (client, lead)', e.ok, e.got);
    await db.query(`insert into public.client_meetings (meeting_id, client_id, opportunity_id, lead_id, meeting_status, booked_at, held_at, qualification_status, billable, performance_fee_cents, currency, invoice_status)
      values ('m4','jole','opp:jole:x','x','QUALIFIED_HELD',now(),now(),'qualified',true,35000,'USD','pending')`);
    check('A12 a held, qualified meeting can be billable', (await scalar(db, `select billable from public.client_meetings where meeting_id='m4'`)) === true);
    await db.query('ROLLBACK');

    // B. client_id migration
    r = await migrate(db, CLIENT_ID);
    check('B1 client_id migration applies cleanly on production-shaped data', r.ok, r.message);
    const col = await columnInfo(db, 'outreach_leads', 'client_id');
    check('B2 client_id is text NOT NULL DEFAULT scalelab', col && col.data_type === 'text' && col.is_nullable === 'NO' && /'scalelab'/.test(col.column_default), JSON.stringify(col));
    check('B3 every existing row backfilled to scalelab', (await scalar(db, `select count(*)::int from public.outreach_leads where client_id <> 'scalelab'`)) === 0
      && (await scalar(db, 'select count(*)::int from public.outreach_leads')) === seeded, `${seeded} rows`);
    check('B4 existing row data byte-for-byte unchanged (checksum of all original columns)', (await checksum(db)) === before);
    check('B5 FK outreach_leads_client_id_fkey present', (await scalar(db, `select count(*)::int from pg_constraint where conname='outreach_leads_client_id_fkey'`)) === 1);
    check('B6 per-client unique index added', (await indexExists(db, 'outreach_leads_client_email_key')) === 1);
    check('B7 global email index still present (drop is a separate migration)', (await indexExists(db, 'outreach_leads_email_normalized_key')) === 1);
    await db.query('BEGIN');
    await db.query(`insert into public.outreach_leads (lead_id, email) values ('new1','new@legacy.example.com')`);
    check('B8 old-code insert without client_id gets scalelab', (await scalar(db, `select client_id from public.outreach_leads where lead_id='new1'`)) === 'scalelab');
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('j1','office@smiles.example.com','jole')`, '23505');
    check('B9 while the global index exists, a cross-client duplicate is still refused', e.ok, e.got);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('d9','office@smiles.example.com','scalelab')`, '23505');
    check('B10 same-client duplicate refused', e.ok, e.got);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('x1','x1@a.example.com',null)`, '23502');
    check('B11 NULL client_id refused', e.ok, e.got);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('x2','x2@a.example.com','acme')`, '23503');
    check('B12 unknown client_id refused (FK)', e.ok, e.got);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('x3','x3@a.example.com','')`, '23503');
    check('B13 blank client_id refused (FK)', e.ok, e.got);
    await db.query(`insert into public.outreach_leads (lead_id, email, client_id) values ('j2','ops@voltline.example.com','jole')`);
    check('B14 a managed client lead is accepted with its explicit owner', (await scalar(db, `select client_id from public.outreach_leads where lead_id='j2'`)) === 'jole');
    await db.query('ROLLBACK');
    const beforeRerun = await checksum(db);
    r = await migrate(db, CLIENT_ID);
    check('B15 client_id migration re-run is safe and changes nothing', r.ok && (await checksum(db)) === beforeRerun, r.message);

    // C. tenant-scoped email migration
    await db.query('BEGIN');
    await db.query(TENANT);
    check('C1 (in a transaction) global index dropped', (await indexExists(db, 'outreach_leads_email_normalized_key')) === 0);
    await db.query('ROLLBACK');
    check('C2 rollback restores the global index (transactional DDL)', (await indexExists(db, 'outreach_leads_email_normalized_key')) === 1);
    r = await migrate(db, TENANT);
    check('C3 tenant-scoped migration applies cleanly', r.ok, r.message);
    check('C4 global index gone, per-client index remains', (await indexExists(db, 'outreach_leads_email_normalized_key')) === 0 && (await indexExists(db, 'outreach_leads_client_email_key')) === 1);
    await db.query('BEGIN');
    await db.query(`insert into public.outreach_leads (lead_id, email, client_id) values ('j3','office@smiles.example.com','jole')`);
    check('C5 the same address may now be a lead of two clients', (await scalar(db, `select count(*)::int from public.outreach_leads where email_normalized='office@smiles.example.com'`)) === 2);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('j4','OFFICE@smiles.example.com ','jole')`, '23505');
    check('C6 never twice inside one client (normalized: case + spaces)', e.ok, e.got);
    e = await expectError(db, `insert into public.outreach_leads (lead_id, email, client_id) values ('d8','office@smiles.example.com','scalelab')`, '23505');
    check('C7 ScaleLab still cannot hold the address twice', e.ok, e.got);
    await db.query(`insert into public.outreach_leads (lead_id, email, client_id) values ('b3','','jole'),('b4','','jole')`);
    check('C8 blank addresses remain unconstrained (partial index)', true);
    await db.query('ROLLBACK');
    r = await migrate(db, TENANT);
    check('C9 tenant-scoped migration re-run is safe', r.ok, r.message);
    check('C10 existing row data still unchanged after all three migrations', (await checksum(db)) === before);
    const shapeAfter = await schemaShape(db);
    const removedColumns = shapeBefore.filter(x => !shapeAfter.includes(x));
    const addedOutreach = shapeAfter.filter(x => x.startsWith('outreach_leads.') && !shapeBefore.includes(x));
    check('C11 no existing column removed or altered', removedColumns.length === 0, removedColumns.join('; '));
    check('C12 the only new outreach_leads column is client_id', addedOutreach.length === 1 && addedOutreach[0].startsWith('outreach_leads.client_id:'), addedOutreach.join('; '));
    const indexesAfter = await indexShape(db);
    const droppedIndexes = indexesBefore.filter(x => !indexesAfter.includes(x));
    check('C13 the only index dropped is the global email index', droppedIndexes.length === 1 && droppedIndexes[0] === 'outreach_leads_email_normalized_key', droppedIndexes.join(','));
    await db.end();

    // D. Failure / ordering behaviour on fresh databases
    const g = await freshDb(pgServer, 'guard_path');
    await g.query(`insert into public.outreach_leads (lead_id, email, lead_niche) values ('bad','x@y.example.com','jole_employer')`);
    await migrate(g, LEDGER);
    r = await migrate(g, CLIENT_ID);
    check('D1 client_id migration refuses if a row already names a managed client', !r.ok && /already holds rows naming a managed client/.test(r.message), r.message);
    check('D2 …and rolls back completely (no column, no index)', !(await columnInfo(g, 'outreach_leads', 'client_id')) && (await indexExists(g, 'outreach_leads_client_email_key')) === 0);
    await g.end();

    const o = await freshDb(pgServer, 'order_path');
    await seedScaleLab(o);
    r = await migrate(o, CLIENT_ID);
    check('D3 client_id migration without the ledger migration fails (clients table missing)', !r.ok, r.code);
    check('D4 …and leaves the table exactly as it was', !(await columnInfo(o, 'outreach_leads', 'client_id')));
    r = await migrate(o, TENANT);
    check('D5 tenant-scoped migration before client_id is refused', !r.ok && /apply 20260930010000 first/.test(r.message), r.message);
    check('D6 …and the global email index is untouched', (await indexExists(o, 'outreach_leads_email_normalized_key')) === 1);
    await o.end();
  } finally {
    await pgServer.stop();
  }
  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(error => { console.error('HARNESS ERROR', error); process.exitCode = 2; });
