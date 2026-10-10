'use strict';

// Static checks that keep the landing attribution migration consistent with the
// code that calls it. The SQL itself is executed end to end by
// scripts/landing-attribution-migration-check.mjs (PGlite, opt-in).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EVENT_PROPS } = require('../integrations/landing-collector');
const { ATTRIBUTION_WINDOW } = require('../integrations/landing-attribution-config');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260925000000_landing_link_attribution.sql'), 'utf8').replace(/\r\n/g, '\n');
// Statements only: comments explain grants in prose and must not trip the checks.
const code = sql.replace(/--.*$/gm, '');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const functions = [...sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map(match => ({ name: match[1], args: match[2] }));
const tables = ['landing_link_issuances', 'landing_sessions', 'landing_events'];
const views = ['landing_session_facts', 'landing_link_funnel', 'landing_booking_attribution', 'landing_funnel_daily'];

test('row level security on every table; nothing granted to anon or authenticated', () => {
  for (const table of tables) assert.match(code, new RegExp(`alter table public\\.${table}\\s+enable row level security;`), table);
  const grants = code.match(/\bgrant\b[^;]*;/gi) || [];
  assert.ok(grants.length >= 10);
  for (const grant of grants) assert.match(grant, /\bto service_role;$/, grant.replace(/\s+/g, ' '));
  assert.match(sql, /revoke all on table public\.landing_link_issuances, public\.landing_sessions, public\.landing_events\s+from public, anon, authenticated;/);
  for (const view of views) {
    assert.match(sql, new RegExp(`create or replace view public\\.${view} with \\(security_invoker = true\\)`), view);
    assert.ok(new RegExp(`revoke all on [^;]*public\\.${view}[^;]*from public, anon, authenticated;`).test(sql), view);
  }
});

test('every function is SECURITY DEFINER with a pinned search_path and revoked from PUBLIC', () => {
  assert.ok(functions.length >= 8);
  for (const { name, args } of functions) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${name}(`));
    assert.match(body.slice(0, 400), /security definer set search_path = public, pg_temp/, name);
    const argType = args.includes('uuid') ? 'uuid' : 'jsonb';
    assert.ok(sql.includes(`revoke all on function public.${name}(${argType})`), `${name} revoked`);
    if (name === 'landing_refresh_session') {
      assert.equal(sql.includes(`grant execute on function public.${name}(`), false, 'internal helper is not callable through PostgREST');
    } else {
      assert.match(code, new RegExp(`grant execute on function public\\.${name}\\(jsonb\\)\\s+to service_role;`), `${name} granted to service_role`);
    }
  }
});

test('the event allowlist matches the collector exactly, in the table and in the ingest filter', () => {
  // Every full list: starts with page_load, ends with page_summary.
  const lists = [...code.matchAll(/\(\s*('page_load'[\s\S]*?'page_summary')\s*\)/g)]
    .map(match => [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]));
  assert.equal(lists.length, 2, 'check constraint and ingest filter');
  for (const list of lists) assert.deepEqual([...list].sort(), Object.keys(EVENT_PROPS).sort());
});

test('booking attribution windows match ATTRIBUTION_WINDOW', () => {
  const view = sql.slice(sql.indexOf('create or replace view public.landing_booking_attribution'));
  assert.ok(view.includes(`interval '${ATTRIBUTION_WINDOW.ctaBeforeBookingMinutes} minutes'`));
  assert.ok(view.includes(`interval '${ATTRIBUTION_WINDOW.engagedSessionLookbackDays} days'`));
  for (const label of ['page_assisted', 'visited_before_booking', 'link_sent_no_visit', 'no_link_issued']) assert.ok(view.includes(`'${label}'`), label);
});

test('every RPC the server calls exists, with the retention and candidate fields it sends', () => {
  const names = functions.map(f => f.name);
  const store = read('integrations/landing-attribution-store.js');
  for (const called of [...store.matchAll(/callRpc\('(\w+)'/g)].map(m => m[1])) assert.ok(names.includes(called), called);
  const reconcile = read('integrations/landing-attribution-reconcile.js');
  for (const key of ['events_and_sessions_days', 'issuances_days', 'unresolved_sessions_days', 'internal_and_debug_days']) {
    assert.ok(reconcile.includes(key) && sql.includes(`p->>'${key}'`), key);
  }
  for (const column of ['event_id', 'event_type', 'source_lead_id', 'occurred_at', 'recipient_domain', 'metadata']) {
    assert.ok(reconcile.includes(`row.${column}`) || column === 'event_id' || column === 'metadata', column);
  }
});

test('no table stores contact details, network identifiers or the raw token', () => {
  for (const table of tables) {
    const start = sql.indexOf(`create table if not exists public.${table}`);
    const definition = sql.slice(start, sql.indexOf(');', start));
    assert.equal(/\b(email|company|contact_name|first_name|ip|ip_address|user_agent|cookie|referer|referrer|token)\b\s+(text|inet|varchar)/i.test(definition), false, table);
  }
  assert.match(sql, /token_hash\s+text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});
