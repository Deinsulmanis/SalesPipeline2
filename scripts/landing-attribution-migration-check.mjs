// Executes supabase/migrations/20260925000000_landing_link_attribution.sql against an
// in-memory PostgreSQL (PGlite) with Supabase-like roles, twice (idempotency), then
// exercises every function, view, retention rule and grant. Touches no real database.
//
// PGlite is deliberately not a project dependency. Install it anywhere and point at it:
//   npm install --prefix <dir> @electric-sql/pglite
//   PGLITE_DIR=<dir> node scripts/landing-attribution-migration-check.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.error('Set PGLITE_DIR to a folder where @electric-sql/pglite is installed (see header).'); process.exit(2); }
const { PGlite } = createRequire(path.join(path.resolve(pgliteDir), 'package.json'))('@electric-sql/pglite');
const sql = file => readFileSync(`${REPO}/${file}`, 'utf8');
const MIGRATION = 'supabase/migrations/20260925000000_landing_link_attribution.sql';
const db = new PGlite();
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); } };
const one = async (text, params = []) => (await db.query(text, params)).rows[0];
const all = async (text, params = []) => (await db.query(text, params)).rows;
const rpc = async (fn, p) => one(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]);
const hash = value => createHash('sha256').update(value).digest('hex');

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
`);
await db.exec(sql('supabase/migrations/20260902000000_crm_events.sql'));
await db.exec(sql('supabase/migrations/20260912000000_outreach_leads.sql'));
await check('migration applies', () => db.exec(sql(MIGRATION)));
await check('migration re-applies idempotently', () => db.exec(sql(MIGRATION)));

const issuance = (lead, suffix, over = {}) => ({
  issuance_key: `gmail-cold:${lead}:step:2|staffing_landing`, action_id: `gmail-cold:${lead}:step:2`,
  token_hash: hash(`token-${lead}-${suffix}`), token_key_version: 1, lead_id: lead, source: 'followup_2', trigger_action: null,
  campaign_id: 'industrial_staffing_employer_acquisition_v1', campaign_version: 'industrial_staffing_employer_acquisition_v1',
  template_id: 'industrial-staffing-employer-v1', template_version: 'industrial_staffing_follow_up_v1', sender_inbox_id: 'primary', is_test: false, ...over,
});
const issue = async p => (await all(`select * from public.landing_issue_link($1::jsonb)`, [JSON.stringify(p)]))[0];
const ingest = async (p) => (await rpc('landing_ingest', p)).r;
const batch = (session, plid, tokenHash, events, over = {}) => ({
  token_hash: tokenHash, session_id: session, page_load_id: plid, is_internal: false, is_debug: false, webdriver: false,
  viewport_bucket: 'd', ua_browser: 'chrome', ua_major: 140, ua_os: 'windows', device_class: 'desktop', ua_headless: false, ua_declared_bot: false,
  events, ...over,
});
const ev = (event_name, seq, extra = {}) => ({ event_name, seq, client_ms: seq * 100, is_trusted: null, user_activated: null, props: {}, ...extra });
const session = async id => one(`select * from public.landing_sessions where session_id = $1`, [id]);

await check('issue is idempotent; identity never changes; empty descriptive fields fill in', async () => {
  const first = await issue(issuance('L1', 'a', { template_version: '' }));
  const again = await issue(issuance('L1', 'a', { template_version: 'industrial_staffing_follow_up_v1' }));
  assert.equal(first.issuance_id, again.issuance_id);
  assert.equal(again.template_version, 'industrial_staffing_follow_up_v1');
  assert.equal(again.token_key_version, 1);
  const third = await issue(issuance('L1', 'a', { template_version: 'something_else', token_key_version: 2 }));
  assert.equal(third.template_version, 'industrial_staffing_follow_up_v1');
  assert.equal(third.token_key_version, 1, 'key version is never overwritten');
});

await check('a session that arrives before its issuance is pending, then resolved by the issuance', async () => {
  const sid = randomUUID();
  const early = hash('token-L2-a');
  assert.equal((await ingest(batch(sid, randomUUID(), early, [ev('page_load', 1, { props: { visible: true } })]))).accepted, true);
  assert.equal((await session(sid)).resolution, 'pending');
  const row = await issue(issuance('L2', 'a'));
  const after = await session(sid);
  assert.deepEqual([after.resolution, after.issuance_id], ['resolved', row.issuance_id]);
});

await check('tiers: a jump scroll is only VISIBLE; 10 s makes ENGAGED not INTERACTED; trusted input makes INTERACTED', async () => {
  const row = await issue(issuance('L3', 'a'));
  const sid = randomUUID(); const plid = randomUUID();
  await ingest(batch(sid, plid, row.token_hash, [ev('page_load', 1, { props: { visible: true } }), ev('scroll_depth', 2, { props: { pct: 90, mode: 'jump' } })]));
  let s = await session(sid);
  assert.ok(s.visible_at); assert.equal(s.engaged_at, null); assert.equal(s.interacted_at, null); assert.equal(s.max_scroll_pct, 90);
  await ingest(batch(sid, plid, row.token_hash, [ev('interaction', 3, { is_trusted: false, props: { kind: 'pointer' } })]));
  s = await session(sid);
  assert.equal(s.interacted_at, null, 'untrusted input is not interaction');
  await ingest(batch(sid, plid, row.token_hash, [ev('engaged_10s', 4)]));
  s = await session(sid);
  assert.ok(s.engaged_at); assert.equal(s.engaged_basis, 'visible_10s'); assert.equal(s.interacted_at, null);
  await ingest(batch(sid, plid, row.token_hash, [ev('interaction', 5, { is_trusted: true, user_activated: true, props: { kind: 'pointer' } })]));
  s = await session(sid);
  assert.ok(s.interacted_at); assert.equal(s.intent_at, null);
  await ingest(batch(sid, plid, row.token_hash, [ev('video_playing', 6), ev('page_summary', 7, { props: { visible_ms: 42000, max_scroll_pct: 95, scroll_events: 12, max_jump_px: 400 } })]));
  s = await session(sid);
  assert.ok(s.intent_at); assert.equal(s.visible_ms, 42000); assert.equal(s.max_scroll_pct, 95); assert.equal(s.page_loads, 1);
});

await check('a hidden page is never ENGAGED, even with a video play', async () => {
  const row = await issue(issuance('L4', 'a'));
  const sid = randomUUID();
  await ingest(batch(sid, randomUUID(), row.token_hash, [ev('page_load', 1, { props: { visible: false } }), ev('video_playing', 2)]));
  const s = await session(sid);
  assert.equal(s.visible_at, null); assert.equal(s.engaged_at, null); assert.ok(s.intent_at);
});

await check('duplicate batches and repeated milestones are ignored', async () => {
  const row = await issue(issuance('L5', 'a'));
  const sid = randomUUID(); const plid = randomUUID();
  const events = [ev('page_load', 1, { props: { visible: true } }), ev('video_25', 2)];
  assert.equal((await ingest(batch(sid, plid, row.token_hash, events))).inserted, 2);
  assert.equal((await ingest(batch(sid, plid, row.token_hash, events))).inserted, 0);
  assert.equal((await ingest(batch(sid, plid, row.token_hash, [ev('video_25', 3)]))).inserted, 0, 'milestone once per session');
  const reload = randomUUID();
  assert.equal((await ingest(batch(sid, reload, row.token_hash, [ev('page_load', 1, { props: { visible: true } })]))).inserted, 1);
  assert.equal((await session(sid)).page_loads, 2);
});

await check('a session keeps one token for life; revoked links are ignored', async () => {
  const a = await issue(issuance('L6', 'a'));
  const sid = randomUUID();
  await ingest(batch(sid, randomUUID(), a.token_hash, [ev('page_load', 1)]));
  assert.equal((await ingest(batch(sid, randomUUID(), hash('other'), [ev('page_load', 1)]))).reason, 'token_mismatch');
  await db.query(`update public.landing_link_issuances set status = 'revoked', revoked_at = now() where issuance_id = $1`, [a.issuance_id]);
  assert.equal((await ingest(batch(randomUUID(), randomUUID(), a.token_hash, [ev('page_load', 1)]))).reason, 'revoked');
});

await check('internal browsers without a token are kept apart and flagged', async () => {
  const sid = randomUUID();
  await ingest(batch(sid, randomUUID(), null, [ev('page_load', 1, { props: { visible: true } })], { is_internal: true, is_debug: true }));
  const s = await session(sid);
  assert.deepEqual([s.resolution, s.is_internal, s.is_debug, s.issuance_id], ['none', true, true, null]);
});

await check('mark sent: first values win', async () => {
  await issue(issuance('L7', 'a'));
  const first = (await all(`select * from public.landing_mark_link_sent($1::jsonb)`, [JSON.stringify({ issuance_key: 'gmail-cold:L7:step:2|staffing_landing', sent_at: '2026-09-25T15:00:00Z', provider_message_id: 'gm-7', provider_thread_id: 'th-7' })]))[0];
  assert.equal(first.status, 'sent');
  const again = (await all(`select * from public.landing_mark_link_sent($1::jsonb)`, [JSON.stringify({ issuance_key: 'gmail-cold:L7:step:2|staffing_landing', sent_at: '2026-09-26T15:00:00Z', provider_message_id: 'other' })]))[0];
  assert.equal(new Date(again.sent_at).toISOString(), '2026-09-25T15:00:00.000Z');
  assert.equal(again.provider_message_id, 'gm-7');
});

await check('backfill candidates: pinned sends without an issuance, or not yet marked sent; domain only', async () => {
  const pin = { issuanceKey: 'gmail-cold:L8:step:2|staffing_landing', keyVersion: 1, source: 'followup_2', tracked: true };
  await db.query(`insert into public.crm_events (event_id, lead_id, source_lead_id, email, event_type, occurred_at, metadata)
                  values ('gmail:gm-8', 'CE-L8', 'L8', 'owner@harbour.test', 'follow_up_sent', now(), $1::jsonb),
                         ('cold-reserve:L8:step2:attempt1', 'CE-L8', 'L8', 'owner@harbour.test', 'ordinary_send_reserved', now(), $1::jsonb),
                         ('gmail:gm-x', 'CE-L9', 'L9', 'x@y.test', 'follow_up_sent', now(), '{"step":2}'::jsonb)`, [JSON.stringify({ step: 2, landingLink: pin })]);
  let rows = await all(`select * from public.landing_backfill_candidates($1::jsonb)`, [JSON.stringify({ since: '2026-01-01T00:00:00Z', limit: 50 })]);
  assert.deepEqual(rows.map(r => r.event_id).sort(), ['cold-reserve:L8:step2:attempt1', 'gmail:gm-8']);
  assert.equal(rows[0].recipient_domain, 'harbour.test');
  assert.equal(Object.values(rows[0]).some(v => String(v).includes('owner@')), false);
  await issue(issuance('L8', 'a'));
  rows = await all(`select * from public.landing_backfill_candidates($1::jsonb)`, [JSON.stringify({ since: '2026-01-01T00:00:00Z' })]);
  assert.deepEqual(rows.map(r => r.event_id), ['gmail:gm-8'], 'the send is still unmarked');
  await rpc('landing_mark_link_sent', { issuance_key: pin.issuanceKey, sent_at: new Date().toISOString() });
  rows = await all(`select * from public.landing_backfill_candidates($1::jsonb)`, [JSON.stringify({ since: '2026-01-01T00:00:00Z' })]);
  assert.equal(rows.length, 0);
});

await check('booking attribution labels assistance, and internal clicks never count', async () => {
  const setupLead = async (lead, sentHoursAgo) => {
    const row = await issue(issuance(lead, 'b'));
    await rpc('landing_mark_link_sent', { issuance_key: row.issuance_key, sent_at: new Date(Date.now() - sentHoursAgo * 3600000).toISOString() });
    return row;
  };
  const booked = async (lead, minutesAgo = 0) => db.query(`insert into public.crm_events (event_id, lead_id, source_lead_id, event_type, occurred_at, metadata)
     values ($1, $2, $3, 'call_booked', now() - make_interval(mins => $4), '{"meetingAt":"2026-10-01T17:00:00Z","providerEventId":"g1"}'::jsonb)`,
    [`booking-${lead}`, `CE-${lead}`, lead, minutesAgo]);
  // A: trusted booking click 30 minutes before booking.
  const a = await setupLead('BA', 48);
  const sa = randomUUID(); const pa = randomUUID();
  await ingest(batch(sa, pa, a.token_hash, [ev('page_load', 1, { props: { visible: true } }), ev('booking_cta_click', 2, { is_trusted: true, props: { cta_location: 'hero' } })]));
  await db.query(`update public.landing_events set received_at = now() - interval '30 minutes' where session_id = $1`, [sa]);
  await booked('BA');
  // B: engaged visit five days before booking, no click.
  const b = await setupLead('BB', 24 * 6);
  const sb = randomUUID();
  await ingest(batch(sb, randomUUID(), b.token_hash, [ev('page_load', 1, { props: { visible: true } }), ev('engaged_10s', 2)]));
  await db.query(`update public.landing_sessions set started_at = now() - interval '5 days', engaged_at = now() - interval '5 days' where session_id = $1`, [sb]);
  await booked('BB');
  // C: link sent, never visited.  D: no link at all.
  await setupLead('BC', 72); await booked('BC'); await booked('BD');
  // E: only an INTERNAL browser clicked (you, from Gmail Sent).
  const e = await setupLead('BE', 10);
  const se = randomUUID();
  await ingest(batch(se, randomUUID(), e.token_hash, [ev('page_load', 1, { props: { visible: true } }), ev('booking_cta_click', 2, { is_trusted: true })], { is_internal: true }));
  await booked('BE');
  const labels = Object.fromEntries((await all(`select lead_id, assist_label, attributed_source from public.landing_booking_attribution`)).map(r => [r.lead_id, r]));
  assert.equal(labels.BA.assist_label, 'page_assisted');
  assert.equal(labels.BA.attributed_source, 'followup_2');
  assert.equal(labels.BB.assist_label, 'visited_before_booking');
  assert.equal(labels.BC.assist_label, 'link_sent_no_visit');
  assert.equal(labels.BD.assist_label, 'no_link_issued');
  assert.equal(labels.BE.assist_label, 'link_sent_no_visit');
});

await check('funnel views compute and exclude internal traffic', async () => {
  const funnel = await all(`select * from public.landing_link_funnel where lead_id in ('BA', 'BE')`);
  const byLead = Object.fromEntries(funnel.map(r => [r.lead_id, r]));
  assert.equal(Number(byLead.BA.raw_sessions), 1);
  assert.equal(byLead.BA.booking_cta_clicked, true);
  assert.equal(Number(byLead.BE.raw_sessions), 0, 'internal session excluded');
  const daily = await all(`select * from public.landing_funnel_daily`);
  assert.ok(daily.length >= 1);
  assert.ok(daily.every(r => Number(r.links_sent) >= 1));
});

await check('retention: periods passed in, internal/debug and unresolved expire first', async () => {
  const old = randomUUID(); const pending = randomUUID(); const internal = randomUUID();
  const row = await issue(issuance('R1', 'a'));
  await ingest(batch(old, randomUUID(), row.token_hash, [ev('page_load', 1)]));
  await ingest(batch(pending, randomUUID(), hash('never-issued'), [ev('page_load', 1)]));
  await ingest(batch(internal, randomUUID(), null, [ev('page_load', 1)], { is_internal: true }));
  await db.query(`update public.landing_sessions set started_at = now() - interval '8 days', last_seen_at = now() - interval '8 days' where session_id in ($1, $2)`, [pending, internal]);
  await db.query(`update public.landing_sessions set last_seen_at = now() - interval '400 days' where session_id = $1`, [old]);
  await db.query(`update public.landing_events set received_at = now() - interval '400 days' where session_id = $1`, [old]);
  const result = (await rpc('landing_apply_retention', { events_and_sessions_days: 395, issuances_days: 730, unresolved_sessions_days: 7, internal_and_debug_days: 30 })).r;
  assert.equal(result.unresolved_sessions, 1);
  assert.equal(result.sessions, 1);
  assert.ok(result.events >= 1);
  assert.equal(await session(pending), undefined);
  assert.equal(await session(old), undefined);
  assert.ok(await session(internal), 'internal sessions keep 30 days');
  await assert.rejects(() => rpc('landing_apply_retention', { events_and_sessions_days: 0, issuances_days: 730, unresolved_sessions_days: 7, internal_and_debug_days: 30 }));
});

await check('forget a lead removes its issuances, sessions and events', async () => {
  const row = await issue(issuance('F1', 'a'));
  const sid = randomUUID();
  await ingest(batch(sid, randomUUID(), row.token_hash, [ev('page_load', 1)]));
  assert.equal((await rpc('landing_forget_lead', { lead_id: 'F1' })).r, 1);
  assert.equal(await session(sid), undefined);
  assert.equal(Number((await one(`select count(*) from public.landing_events where session_id = $1`, [sid])).count), 0);
});

await check('grants: anon and authenticated can read or execute nothing; service_role can', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    for (const statement of [
      'select 1 from public.landing_link_issuances limit 1', 'select 1 from public.landing_link_funnel limit 1',
      `select public.landing_ingest('{}'::jsonb)`, `select public.landing_issue_link('{}'::jsonb)`,
      `select * from public.landing_backfill_candidates('{}'::jsonb)`, `select public.landing_forget_lead('{"lead_id":"x"}'::jsonb)`,
    ]) await assert.rejects(() => db.query(statement), /permission denied/, `${role}: ${statement}`);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  await db.query('select count(*) from public.landing_link_funnel');
  await db.query(`select public.landing_resolve_pending_sessions('{}'::jsonb)`);
  await assert.rejects(() => db.query(`select public.landing_refresh_session(gen_random_uuid())`), /permission denied/, 'internal helper');
  await db.exec('reset role');
});

console.log(results.join('\n'));
console.log(`${results.filter(r => r.startsWith('PASS')).length} passed, ${results.filter(r => r.startsWith('FAIL')).length} failed`);
process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0;
