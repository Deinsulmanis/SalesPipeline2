-- Stage 1 — canonical CRM activity mirror.
--
-- Google Sheets (the ColdCallActivity tab) remains the authoritative store.
-- This table is a SHADOW COPY written after a Sheets append has already
-- succeeded, so nothing in production reads from it and nothing depends on it.
--
-- The shape is the existing canonical activity model, not a new one. The Sheets
-- header is:
--
--   eventId | leadId | sourceLeadId | email | company | eventType
--           | occurredAt | subject | content | metadata
--
-- Every column below is either one of those fields or a value lifted out of the
-- metadata JSON that the application already writes. Nothing is invented, and
-- every field that historical rows may lack stays nullable — most production
-- activity predates campaign, sender and sequence attribution, and a NOT NULL
-- here would either reject those rows or invite a fabricated default.
--
-- `content` is deliberately absent: it holds email bodies and reply text, and
-- Stage 1 mirrors identifiers and metadata only.

create table if not exists public.crm_events (
  -- The canonical event id exactly as Sheets holds it. Deterministic for most
  -- writers -- stableActivityId() emits "<prefix>:<sha1-24>", provider-backed
  -- events use "gmail:<messageId>", "gmail-reply:<messageId>" and
  -- "gmail-outbound:<messageId>" -- so replaying an event upserts onto itself
  -- instead of duplicating. Rows written with a random UUID simply never
  -- collide. Text, not uuid: these ids are namespaced strings.
  event_id            text primary key,

  -- Identity. lead_id is the board/foreign form ("CE-<coldEmailId>" for
  -- outreach-acquired leads); source_lead_id is the bare ColdEmail row id.
  -- Both are kept because the application matches on either.
  lead_id             text,
  source_lead_id      text,
  email               text,
  company             text,

  event_type          text not null,

  -- Nullable on purpose: a handful of historical rows carry an unparseable or
  -- empty timestamp, and the existing code treats that as "time unknown"
  -- rather than substituting now(). The mirror must not be more confident than
  -- the record it is copying.
  occurred_at         timestamptz,
  subject             text,

  -- Attribution promoted out of metadata for queryability. All nullable: they
  -- appear only on events written after each feature shipped.
  campaign_version    text,
  campaign_family     text,
  copy_version        text,
  sender_inbox_id     text,
  provider_message_id text,
  provider_thread_id  text,
  sequence_id         text,
  sequence_step       integer,

  -- The complete metadata object, unmodified. The promoted columns above are a
  -- convenience; this is the record of what the application actually wrote.
  metadata            jsonb not null default '{}'::jsonb,

  -- When the mirror observed it, distinct from when the event occurred. Lets a
  -- backfilled row be told apart from one mirrored live.
  mirrored_at         timestamptz not null default now()
);

comment on table public.crm_events is
  'Stage 1 shadow mirror of the authoritative ColdCallActivity sheet. Observational only: no production read path depends on it.';
comment on column public.crm_events.event_id is
  'Canonical event id from Google Sheets. Primary key, so re-mirroring an event is idempotent.';
comment on column public.crm_events.occurred_at is
  'When the event happened. Null where the canonical record has no usable timestamp.';
comment on column public.crm_events.mirrored_at is
  'When this row was written to Supabase. Not a business timestamp.';

-- Read patterns Stage 1 actually needs: a lead''s history, a recency check for
-- the health diagnostic, and counting by type.
create index if not exists crm_events_source_lead_id_idx on public.crm_events (source_lead_id);
create index if not exists crm_events_lead_id_idx        on public.crm_events (lead_id);
create index if not exists crm_events_occurred_at_idx    on public.crm_events (occurred_at desc nulls last);
create index if not exists crm_events_event_type_idx     on public.crm_events (event_type);
create index if not exists crm_events_mirrored_at_idx    on public.crm_events (mirrored_at desc);

-- Defence in depth. Stage 1 reaches Supabase only with the server-side secret
-- key, which bypasses RLS; enabling it with no policy means that if a
-- publishable/anon key ever did reach a browser, it would still read nothing.
alter table public.crm_events enable row level security;
