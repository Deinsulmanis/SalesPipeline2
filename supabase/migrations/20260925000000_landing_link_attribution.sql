-- Staffing landing-page link attribution (first party).
--
-- One opaque token per staffing landing-page LINK ISSUANCE (Follow-up #2 or an
-- automated positive reply). The token is derived in SalesPipeline2 from the
-- send's deterministic action id (integrations/landing-link-token.js); this
-- database stores only its SHA-256 hash, never the token itself, and never a
-- name, email address or company. Lead identity stays in outreach_leads.
--
--   landing_link_issuances  one row per issued link          (lead, source, sender, template)
--   landing_sessions        one row per browser-tab session  (tier timestamps, coarse UA classes)
--   landing_events          allowlisted page events          (idempotent per page load + sequence)
--
-- The tiers are behavioural confidence levels, NOT proof that a visitor is human:
--   RAW        the page's script ran and reported with a token
--   VISIBLE    the document was visible
--   ENGAGED    visible AND (10 s visible | trusted input | trusted scroll input |
--              video playing | trusted booking click | booking dialog opened)
--   INTERACTED trusted pointer / touch / key / wheel input or trusted scroll input.
--              Ten seconds visible alone never makes a session INTERACTED, and a
--              scripted or instant scroll is never input.
--   INTENT     video playing, trusted booking click or booking dialog opened
--
-- Booking attribution (landing_booking_attribution) labels ASSISTANCE, not
-- causation. The positive-reply email carries its own direct booking link, so
-- a booking with no page click in the preceding window is never labelled
-- page_assisted.
--
-- Access: row level security on, no policies. Only service_role (the
-- server-side secret key held by SalesPipeline2 on Railway) can execute the
-- functions or read the views. Nothing is granted to anon or authenticated,
-- and no key for this data reaches a browser or Netlify.
--
-- Retention is applied by landing_apply_retention(), called by the
-- SalesPipeline2 reconciler with the periods defined in
-- integrations/landing-attribution-config.js (RETENTION_DAYS).
--
-- Apply once, by hand, after review (SQL editor or psql), then verify through
-- PostgREST with the server key. Every statement is idempotent; re-running is
-- safe. gen_random_uuid() is core PostgreSQL (13+), so no extension is needed.

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.landing_link_issuances (
  issuance_id          uuid primary key default gen_random_uuid(),
  issuance_key         text not null unique check (issuance_key ~ '\|staffing_landing$'),
  action_id            text not null,
  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_key_version    smallint not null check (token_key_version > 0),
  lead_id              text not null,
  source               text not null check (source in ('followup_2', 'positive_reply')),
  trigger_action       text check (trigger_action is null or trigger_action in ('AUTO_STAFFING_SEND_INFO', 'AUTO_STAFFING_QUALIFIED')),
  campaign_id          text not null,
  campaign_version     text,
  template_id          text not null default '',
  template_version     text not null default '',
  sender_inbox_id      text not null default '',
  is_test              boolean not null default false,
  status               text not null default 'issued' check (status in ('issued', 'sent', 'revoked')),
  issued_at            timestamptz not null default now(),
  sent_at              timestamptz,
  provider_message_id  text,
  provider_thread_id   text,
  revoked_at           timestamptz,
  updated_at           timestamptz not null default now()
);
comment on table public.landing_link_issuances is
  'One row per staffing landing-page link issuance. token_hash is SHA-256 of the opaque ?t= token; the token itself is never stored.';
comment on column public.landing_link_issuances.status is
  'issued before the send, sent after provider success, revoked by hand. A revoked link still loads the page; its events are ignored.';

create index if not exists landing_link_issuances_lead_idx   on public.landing_link_issuances (lead_id, issued_at desc);
create index if not exists landing_link_issuances_source_idx on public.landing_link_issuances (source, sent_at desc);
create index if not exists landing_link_issuances_unsent_idx on public.landing_link_issuances (issued_at) where status = 'issued';

create table if not exists public.landing_sessions (
  session_id        uuid primary key,
  issuance_id       uuid references public.landing_link_issuances (issuance_id) on delete cascade,
  token_hash        text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  resolution        text not null check (resolution in ('resolved', 'pending', 'revoked', 'none')),
  started_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  page_loads        smallint not null default 0,
  visible_at        timestamptz,
  engaged_at        timestamptz,
  engaged_basis     text,
  interacted_at     timestamptz,
  intent_at         timestamptz,
  visible_ms        integer not null default 0,
  max_scroll_pct    smallint,
  is_internal       boolean not null default false,
  is_debug          boolean not null default false,
  webdriver         boolean not null default false,
  ua_browser        text,
  ua_major          smallint,
  ua_os             text,
  device_class      text,
  ua_headless       boolean not null default false,
  ua_declared_bot   boolean not null default false,
  viewport_bucket   text check (viewport_bucket is null or viewport_bucket in ('m', 't', 'd'))
);
comment on table public.landing_sessions is
  'One row per browser-tab session on the staffing page. No IP, raw user agent, cookie or referrer is stored.';

create index if not exists landing_sessions_issuance_idx on public.landing_sessions (issuance_id, started_at);
create index if not exists landing_sessions_pending_idx  on public.landing_sessions (token_hash) where issuance_id is null;
create index if not exists landing_sessions_started_idx  on public.landing_sessions (started_at);

create table if not exists public.landing_events (
  event_id        bigint generated always as identity primary key,
  session_id      uuid not null references public.landing_sessions (session_id) on delete cascade,
  page_load_id    uuid not null,
  seq             integer not null check (seq >= 0),
  event_name      text not null check (event_name in (
    'page_load', 'visible', 'engaged_10s', 'interaction', 'scroll_input', 'scroll_depth',
    'video_visible', 'video_playing', 'video_25', 'video_50', 'video_75', 'video_complete',
    'meeting_section_visible', 'booking_cta_click', 'booking_dialog_open', 'booking_embed_loaded',
    'booking_new_tab', 'page_summary')),
  client_ms       integer,
  received_at     timestamptz not null default now(),
  is_trusted      boolean,
  user_activated  boolean,
  props           jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object' and pg_column_size(props) <= 1024),
  unique (page_load_id, seq)
);
-- Milestones count once per session, however often a page reports them.
create unique index if not exists landing_events_milestone_once on public.landing_events (session_id, event_name)
  where event_name in ('visible', 'engaged_10s', 'video_visible', 'video_playing', 'video_25', 'video_50',
                       'video_75', 'video_complete', 'meeting_section_visible', 'booking_embed_loaded');
create index if not exists landing_events_session_idx on public.landing_events (session_id, received_at);
create index if not exists landing_events_name_idx    on public.landing_events (event_name, received_at);

alter table public.landing_link_issuances enable row level security;
alter table public.landing_sessions        enable row level security;
alter table public.landing_events          enable row level security;

-- ── Functions (SECURITY DEFINER, pinned search_path, service_role only) ────

-- Insert the issuance if absent and return the stored row. Identity (token
-- hash, key version) never changes; empty descriptive fields are filled in.
create or replace function public.landing_issue_link(p jsonb)
returns setof public.landing_link_issuances
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text := p->>'issuance_key';
begin
  if v_key is null or p->>'token_hash' is null then
    raise exception 'issuance_key and token_hash are required';
  end if;
  insert into public.landing_link_issuances as i (
    issuance_key, action_id, token_hash, token_key_version, lead_id, source, trigger_action,
    campaign_id, campaign_version, template_id, template_version, sender_inbox_id, is_test)
  values (
    v_key, p->>'action_id', p->>'token_hash', (p->>'token_key_version')::smallint, p->>'lead_id', p->>'source',
    nullif(p->>'trigger_action', ''), p->>'campaign_id', nullif(p->>'campaign_version', ''),
    coalesce(p->>'template_id', ''), coalesce(p->>'template_version', ''), coalesce(p->>'sender_inbox_id', ''),
    coalesce((p->>'is_test')::boolean, false))
  on conflict (issuance_key) do update set
    campaign_version = coalesce(i.campaign_version, excluded.campaign_version),
    template_version = case when i.template_version = '' then excluded.template_version else i.template_version end,
    sender_inbox_id  = case when i.sender_inbox_id = '' then excluded.sender_inbox_id else i.sender_inbox_id end,
    updated_at       = now();
  -- Sessions that arrived before this issuance existed.
  update public.landing_sessions s
     set issuance_id = i.issuance_id,
         resolution  = case when i.status = 'revoked' then 'revoked' else 'resolved' end
    from public.landing_link_issuances i
   where i.issuance_key = v_key and s.issuance_id is null and s.token_hash = i.token_hash;
  return query select * from public.landing_link_issuances where issuance_key = v_key;
end $$;

-- Mark an issuance sent. First values win; a revoked row stays revoked.
create or replace function public.landing_mark_link_sent(p jsonb)
returns setof public.landing_link_issuances
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.landing_link_issuances
     set status              = case when status = 'revoked' then status else 'sent' end,
         sent_at             = coalesce(sent_at, nullif(p->>'sent_at', '')::timestamptz, now()),
         provider_message_id = coalesce(provider_message_id, nullif(p->>'provider_message_id', '')),
         provider_thread_id  = coalesce(provider_thread_id, nullif(p->>'provider_thread_id', '')),
         updated_at          = now()
   where issuance_key = p->>'issuance_key';
  return query select * from public.landing_link_issuances where issuance_key = p->>'issuance_key';
end $$;

-- Recompute one session's rollups from its events. Internal helper.
create or replace function public.landing_refresh_session(p_session uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visible_at    timestamptz;
  v_time_at       timestamptz;
  v_input_at      timestamptz;
  v_video_at      timestamptz;
  v_click_at      timestamptz;
  v_dialog_at     timestamptz;
  v_visible_ms    integer;
  v_engaged_at    timestamptz;
  v_basis         text;
begin
  select
    min(received_at) filter (where event_name = 'visible' or (event_name = 'page_load' and (props->>'visible') = 'true')),
    min(received_at) filter (where event_name = 'engaged_10s'
                               or (event_name = 'page_summary' and coalesce((props->>'visible_ms')::integer, 0) >= 10000)),
    min(received_at) filter (where event_name in ('interaction', 'scroll_input') and is_trusted is true),
    min(received_at) filter (where event_name = 'video_playing'),
    min(received_at) filter (where event_name = 'booking_cta_click' and is_trusted is true),
    min(received_at) filter (where event_name = 'booking_dialog_open')
    into v_visible_at, v_time_at, v_input_at, v_video_at, v_click_at, v_dialog_at
    from public.landing_events where session_id = p_session;

  select coalesce(sum(per_load), 0) into v_visible_ms from (
    select max((props->>'visible_ms')::integer) as per_load
      from public.landing_events
     where session_id = p_session and event_name = 'page_summary'
     group by page_load_id) loads;

  if v_visible_at is not null then
    select basis, happened_at into v_basis, v_engaged_at from (values
      ('visible_10s', v_time_at), ('input', v_input_at), ('video', v_video_at),
      ('booking_click', v_click_at), ('booking_dialog', v_dialog_at)) candidates(basis, happened_at)
     where happened_at is not null order by happened_at limit 1;
  end if;

  update public.landing_sessions s set
    visible_at     = v_visible_at,
    engaged_at     = v_engaged_at,
    engaged_basis  = v_basis,
    interacted_at  = v_input_at,
    intent_at      = least(v_video_at, v_click_at, v_dialog_at),
    visible_ms     = v_visible_ms,
    page_loads     = (select count(distinct page_load_id) from public.landing_events
                       where session_id = p_session and event_name = 'page_load'),
    max_scroll_pct = (select max(greatest(
                        case when event_name = 'scroll_depth' then (props->>'pct')::integer end,
                        case when event_name = 'page_summary' then (props->>'max_scroll_pct')::integer end))
                        from public.landing_events where session_id = p_session),
    last_seen_at   = greatest(s.last_seen_at, coalesce((select max(received_at) from public.landing_events where session_id = p_session), s.last_seen_at))
  where s.session_id = p_session;
end $$;

-- One collector batch: create the session on first sight, insert events
-- idempotently, refresh the rollups. A session belongs to one token for life.
create or replace function public.landing_ingest(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session    uuid := (p->>'session_id')::uuid;
  v_token      text := nullif(p->>'token_hash', '');
  v_internal   boolean := coalesce((p->>'is_internal')::boolean, false);
  v_debug      boolean := coalesce((p->>'is_debug')::boolean, false);
  v_existing   public.landing_sessions%rowtype;
  v_issuance   public.landing_link_issuances%rowtype;
  v_resolution text;
  v_inserted   integer := 0;
begin
  select * into v_existing from public.landing_sessions where session_id = v_session for update;
  if found then
    if v_existing.token_hash is distinct from v_token then
      return jsonb_build_object('accepted', false, 'reason', 'token_mismatch');
    end if;
    if v_existing.resolution = 'revoked' then
      return jsonb_build_object('accepted', false, 'reason', 'revoked');
    end if;
    -- Internal and debug marks are sticky within a session.
    update public.landing_sessions
       set is_internal = is_internal or v_internal, is_debug = is_debug or v_debug
     where session_id = v_session;
  else
    if v_token is null then
      v_resolution := 'none';
    else
      select * into v_issuance from public.landing_link_issuances where token_hash = v_token;
      v_resolution := case when not found then 'pending' when v_issuance.status = 'revoked' then 'revoked' else 'resolved' end;
    end if;
    if v_resolution = 'revoked' then
      return jsonb_build_object('accepted', false, 'reason', 'revoked');
    end if;
    insert into public.landing_sessions (
      session_id, issuance_id, token_hash, resolution, is_internal, is_debug, webdriver,
      ua_browser, ua_major, ua_os, device_class, ua_headless, ua_declared_bot, viewport_bucket)
    values (
      v_session, v_issuance.issuance_id, v_token, v_resolution, v_internal, v_debug,
      coalesce((p->>'webdriver')::boolean, false), nullif(p->>'ua_browser', ''),
      (p->>'ua_major')::smallint, nullif(p->>'ua_os', ''), nullif(p->>'device_class', ''),
      coalesce((p->>'ua_headless')::boolean, false), coalesce((p->>'ua_declared_bot')::boolean, false),
      nullif(p->>'viewport_bucket', ''))
    on conflict (session_id) do nothing;
  end if;

  insert into public.landing_events (session_id, page_load_id, seq, event_name, client_ms, is_trusted, user_activated, props)
  select v_session, (p->>'page_load_id')::uuid, (e->>'seq')::integer, e->>'event_name',
         (e->>'client_ms')::integer, (e->>'is_trusted')::boolean, (e->>'user_activated')::boolean,
         case when jsonb_typeof(e->'props') = 'object' then e->'props' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p->'events', '[]'::jsonb)) as e
   where e->>'event_name' in (
     'page_load', 'visible', 'engaged_10s', 'interaction', 'scroll_input', 'scroll_depth',
     'video_visible', 'video_playing', 'video_25', 'video_50', 'video_75', 'video_complete',
     'meeting_section_visible', 'booking_cta_click', 'booking_dialog_open', 'booking_embed_loaded',
     'booking_new_tab', 'page_summary')
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  perform public.landing_refresh_session(v_session);
  return jsonb_build_object('accepted', true, 'inserted', v_inserted);
end $$;

-- Link sessions whose issuance arrived after them. Returns how many.
create or replace function public.landing_resolve_pending_sessions(p jsonb default '{}'::jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  update public.landing_sessions s
     set issuance_id = i.issuance_id,
         resolution  = case when i.status = 'revoked' then 'revoked' else 'resolved' end
    from public.landing_link_issuances i
   where s.issuance_id is null and s.token_hash is not null and s.token_hash = i.token_hash;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Canonical reservations and sends (mirrored in crm_events) that carry a
-- tracked landing pin whose issuance is missing, or whose send is not yet
-- recorded. Returns the recipient's domain only, never the address.
create or replace function public.landing_backfill_candidates(p jsonb default '{}'::jsonb)
returns table (event_id text, event_type text, source_lead_id text, occurred_at timestamptz, recipient_domain text, metadata jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.event_id, e.event_type, e.source_lead_id, e.occurred_at,
         lower(split_part(coalesce(e.email, ''), '@', 2)), e.metadata
    from public.crm_events e
    left join public.landing_link_issuances i on i.issuance_key = e.metadata->'landingLink'->>'issuanceKey'
   where e.event_type in ('ordinary_send_reserved', 'prospect_reply_reserved', 'follow_up_sent', 'booking_link_sent')
     and e.metadata->'landingLink'->>'tracked' = 'true'
     and coalesce(e.occurred_at, e.mirrored_at) >= coalesce(nullif(p->>'since', '')::timestamptz, now() - interval '30 days')
     and (i.issuance_id is null or (e.event_type in ('follow_up_sent', 'booking_link_sent') and i.status = 'issued'))
   order by coalesce(e.occurred_at, e.mirrored_at)
   limit least(greatest(coalesce((p->>'limit')::integer, 200), 1), 1000);
$$;

-- Retention. Periods are passed in from SalesPipeline2 (RETENTION_DAYS).
create or replace function public.landing_apply_retention(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d_events     integer := (p->>'events_and_sessions_days')::integer;
  d_issuances  integer := (p->>'issuances_days')::integer;
  d_unresolved integer := (p->>'unresolved_sessions_days')::integer;
  d_internal   integer := (p->>'internal_and_debug_days')::integer;
  n_internal integer; n_unresolved integer; n_events integer; n_sessions integer; n_issuances integer;
begin
  if d_events is null or d_issuances is null or d_unresolved is null or d_internal is null
     or least(d_events, d_issuances, d_unresolved, d_internal) < 1 then
    raise exception 'every retention period must be a positive number of days';
  end if;
  delete from public.landing_sessions where (is_internal or is_debug) and last_seen_at < now() - make_interval(days => d_internal);
  get diagnostics n_internal = row_count;
  delete from public.landing_sessions where issuance_id is null and resolution = 'pending' and started_at < now() - make_interval(days => d_unresolved);
  get diagnostics n_unresolved = row_count;
  delete from public.landing_events where received_at < now() - make_interval(days => d_events);
  get diagnostics n_events = row_count;
  delete from public.landing_sessions where last_seen_at < now() - make_interval(days => d_events);
  get diagnostics n_sessions = row_count;
  delete from public.landing_link_issuances where issued_at < now() - make_interval(days => d_issuances);
  get diagnostics n_issuances = row_count;
  return jsonb_build_object('internal_sessions', n_internal, 'unresolved_sessions', n_unresolved,
    'events', n_events, 'sessions', n_sessions, 'issuances', n_issuances);
end $$;

-- Deletion request for one lead: removes its issuances, sessions and events.
create or replace function public.landing_forget_lead(p jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  if coalesce(p->>'lead_id', '') = '' then raise exception 'lead_id is required'; end if;
  delete from public.landing_link_issuances where lead_id = p->>'lead_id';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ── Views (security_invoker; service_role only) ────────────────────────────

-- Sessions with their issuance's categories and per-session event flags.
create or replace view public.landing_session_facts with (security_invoker = true) as
select s.*, i.lead_id, i.source, i.trigger_action, i.campaign_id, i.campaign_version, i.template_id,
       i.template_version, i.sender_inbox_id, coalesce(i.is_test, false) as is_test, i.sent_at,
       case when i.sent_at is not null then floor(extract(epoch from (s.started_at - i.sent_at)))::integer end as seconds_after_send,
       coalesce(ev.video_playing, false) as video_playing, coalesce(ev.video_25, false) as video_25,
       coalesce(ev.video_50, false) as video_50, coalesce(ev.video_75, false) as video_75,
       coalesce(ev.video_complete, false) as video_complete, coalesce(ev.meeting_section_visible, false) as meeting_section_visible,
       coalesce(ev.booking_cta_click, false) as booking_cta_click, coalesce(ev.booking_dialog_open, false) as booking_dialog_open,
       coalesce(ev.scroll_jump, false) as scroll_jump
  from public.landing_sessions s
  left join public.landing_link_issuances i on i.issuance_id = s.issuance_id
  left join lateral (
    select bool_or(e.event_name = 'video_playing') as video_playing,
           bool_or(e.event_name = 'video_25') as video_25,
           bool_or(e.event_name = 'video_50') as video_50,
           bool_or(e.event_name = 'video_75') as video_75,
           bool_or(e.event_name = 'video_complete') as video_complete,
           bool_or(e.event_name = 'meeting_section_visible') as meeting_section_visible,
           bool_or(e.event_name = 'booking_cta_click' and e.is_trusted is true) as booking_cta_click,
           bool_or(e.event_name = 'booking_dialog_open') as booking_dialog_open,
           bool_or(e.event_name = 'scroll_depth' and e.props->>'mode' = 'jump') as scroll_jump
      from public.landing_events e where e.session_id = s.session_id) ev on true;

-- One row per issued link: the funnel for that link, excluding internal,
-- debug and test traffic.
create or replace view public.landing_link_funnel with (security_invoker = true) as
select i.issuance_id, i.lead_id, i.source, i.trigger_action, i.campaign_id, i.campaign_version,
       i.template_id, i.template_version, i.sender_inbox_id, i.status, i.issued_at, i.sent_at,
       count(f.session_id)                                        as raw_sessions,
       count(f.session_id) filter (where f.visible_at is not null)    as visible_sessions,
       count(f.session_id) filter (where f.engaged_at is not null)    as engaged_sessions,
       count(f.session_id) filter (where f.interacted_at is not null) as interacted_sessions,
       count(f.session_id) filter (where f.intent_at is not null)     as intent_sessions,
       min(f.started_at) as first_raw_at,
       min(f.engaged_at) as first_engaged_at,
       coalesce(bool_or(f.video_playing), false)           as video_played,
       coalesce(bool_or(f.video_50), false)                as video_half_watched,
       coalesce(bool_or(f.video_complete), false)          as video_completed,
       coalesce(bool_or(f.meeting_section_visible), false) as meeting_section_viewed,
       coalesce(bool_or(f.booking_cta_click), false)       as booking_cta_clicked,
       coalesce(bool_or(f.booking_dialog_open), false)     as booking_dialog_opened,
       count(f.session_id) > 1                             as repeat_visit
  from public.landing_link_issuances i
  left join public.landing_session_facts f
         on f.issuance_id = i.issuance_id and not f.is_internal and not f.is_debug
 where not i.is_test
 group by i.issuance_id;

-- Bookings from the Google Calendar sync (call_booked, matched to a lead by
-- exact attendee email upstream) with landing-page ASSISTANCE:
--   page_assisted           trusted booking click or dialog open on the lead's
--                           link within 120 minutes before the booking
--   visited_before_booking  an ENGAGED session on the lead's link within 30 days
--   link_sent_no_visit      a link was sent before the booking, no engaged visit
--   no_link_issued          no tracked link was sent before the booking
-- booked_at is the calendar event's update time as recorded by the sync.
-- The windows are ATTRIBUTION_WINDOW in landing-attribution-config.js.
create or replace view public.landing_booking_attribution with (security_invoker = true) as
with bookings as (
  select b.event_id as booking_event_id,
         coalesce(nullif(b.source_lead_id, ''), case when b.lead_id like 'CE-%' then substr(b.lead_id, 4) end) as lead_id,
         b.occurred_at as booked_at,
         b.metadata->>'meetingAt' as meeting_at,
         b.metadata->>'providerEventId' as provider_event_id
    from public.crm_events b
   where b.event_type = 'call_booked' and b.occurred_at is not null
)
select bk.booking_event_id, bk.lead_id, bk.booked_at, bk.meeting_at, bk.provider_event_id,
       cta.issuance_id  as cta_issuance_id,  cta.session_id as cta_session_id, cta.clicked_at,
       eng.issuance_id  as engaged_issuance_id, eng.session_id as engaged_session_id, eng.engaged_at,
       last_link.issuance_id as last_link_issuance_id, last_link.sent_at as last_link_sent_at,
       coalesce(cta.issuance_id, eng.issuance_id, last_link.issuance_id) as attributed_issuance_id,
       (select a.source from public.landing_link_issuances a
         where a.issuance_id = coalesce(cta.issuance_id, eng.issuance_id, last_link.issuance_id)) as attributed_source,
       case when cta.issuance_id is not null then 'page_assisted'
            when eng.issuance_id is not null then 'visited_before_booking'
            when last_link.issuance_id is not null then 'link_sent_no_visit'
            else 'no_link_issued' end as assist_label
  from bookings bk
  left join lateral (
    select f.issuance_id, f.session_id, e.received_at as clicked_at
      from public.landing_events e
      join public.landing_session_facts f on f.session_id = e.session_id
     where f.lead_id = bk.lead_id and not f.is_internal and not f.is_debug and not f.is_test
       and ((e.event_name = 'booking_cta_click' and e.is_trusted is true) or e.event_name = 'booking_dialog_open')
       and e.received_at between bk.booked_at - interval '120 minutes' and bk.booked_at
     order by e.received_at desc limit 1) cta on true
  left join lateral (
    select f.issuance_id, f.session_id, f.engaged_at
      from public.landing_session_facts f
     where f.lead_id = bk.lead_id and not f.is_internal and not f.is_debug and not f.is_test
       and f.engaged_at is not null
       and f.started_at between bk.booked_at - interval '30 days' and bk.booked_at
     order by f.started_at desc limit 1) eng on true
  left join lateral (
    select i.issuance_id, i.sent_at
      from public.landing_link_issuances i
     where i.lead_id = bk.lead_id and not i.is_test and i.sent_at is not null and i.sent_at <= bk.booked_at
     order by i.sent_at desc limit 1) last_link on true;

-- Daily funnel by source, campaign, sender and template (sent date, Pacific).
create or replace view public.landing_funnel_daily with (security_invoker = true) as
select (f.sent_at at time zone 'America/Vancouver')::date as sent_date,
       f.source, f.campaign_id, f.campaign_version, f.sender_inbox_id, f.template_version,
       count(*)                                           as links_sent,
       count(distinct f.lead_id)                          as leads_sent,
       count(*) filter (where f.raw_sessions > 0)         as links_with_raw_visit,
       count(*) filter (where f.visible_sessions > 0)     as links_visible,
       count(*) filter (where f.engaged_sessions > 0)     as links_engaged,
       count(*) filter (where f.interacted_sessions > 0)  as links_interacted,
       count(*) filter (where f.intent_sessions > 0)      as links_with_intent,
       count(*) filter (where f.video_played)             as links_video_played,
       count(*) filter (where f.video_completed)          as links_video_completed,
       count(*) filter (where f.meeting_section_viewed)   as links_meeting_section_viewed,
       count(*) filter (where f.booking_cta_clicked)      as links_booking_cta_clicked,
       count(*) filter (where f.repeat_visit)             as links_repeat_visit,
       count(distinct f.lead_id) filter (where exists (
         select 1 from public.landing_booking_attribution b
          where b.lead_id = f.lead_id and b.booked_at >= f.sent_at)) as leads_booked_after_send
  from public.landing_link_funnel f
 where f.sent_at is not null
 group by 1, 2, 3, 4, 5, 6;

-- ── Grants: nothing for public, anon or authenticated; service_role only ───

revoke all on table public.landing_link_issuances, public.landing_sessions, public.landing_events
  from public, anon, authenticated;
grant select, insert, update, delete on table public.landing_link_issuances, public.landing_sessions, public.landing_events
  to service_role;
revoke all on sequence public.landing_events_event_id_seq from public, anon, authenticated;
grant usage, select on sequence public.landing_events_event_id_seq to service_role;

revoke all on public.landing_session_facts, public.landing_link_funnel, public.landing_booking_attribution, public.landing_funnel_daily
  from public, anon, authenticated;
grant select on public.landing_session_facts, public.landing_link_funnel, public.landing_booking_attribution, public.landing_funnel_daily
  to service_role;

-- Functions are executable by PUBLIC by default; without these revokes the
-- publishable key could call them through PostgREST.
revoke all on function public.landing_issue_link(jsonb)               from public, anon, authenticated;
revoke all on function public.landing_mark_link_sent(jsonb)           from public, anon, authenticated;
revoke all on function public.landing_refresh_session(uuid)           from public, anon, authenticated, service_role;
revoke all on function public.landing_ingest(jsonb)                   from public, anon, authenticated;
revoke all on function public.landing_resolve_pending_sessions(jsonb) from public, anon, authenticated;
revoke all on function public.landing_backfill_candidates(jsonb)      from public, anon, authenticated;
revoke all on function public.landing_apply_retention(jsonb)          from public, anon, authenticated;
revoke all on function public.landing_forget_lead(jsonb)              from public, anon, authenticated;
grant execute on function public.landing_issue_link(jsonb)               to service_role;
grant execute on function public.landing_mark_link_sent(jsonb)           to service_role;
grant execute on function public.landing_ingest(jsonb)                   to service_role;
grant execute on function public.landing_resolve_pending_sessions(jsonb) to service_role;
grant execute on function public.landing_backfill_candidates(jsonb)      to service_role;
grant execute on function public.landing_apply_retention(jsonb)          to service_role;
grant execute on function public.landing_forget_lead(jsonb)              to service_role;

notify pgrst, 'reload schema';
