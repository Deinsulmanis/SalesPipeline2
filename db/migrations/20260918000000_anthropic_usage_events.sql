-- Observational Anthropic usage log.
--
-- This table is NOT a lead, send, or CRM authority. It records metadata about
-- Claude API calls so token spikes can be attributed per feature. Nothing in
-- the send path, Gmail observer, or Supabase outreach tables reads it.
--
-- Wired only through SEND_LOCK_DATABASE_URL when that Postgres is available.
-- Application code also keeps an in-process + JSONL copy so usage recording
-- never depends on this table being present.
--
-- Retention: the writer deletes rows older than 14 days. Do not treat this
-- as an unbounded audit log.

create table if not exists anthropic_usage_events (
  id                           bigserial primary key,
  occurred_at                  timestamptz not null,
  model                        text not null,
  feature                      text not null,
  operation                    text,
  campaign                     text,
  lead_id                      text,
  message_id                   text,
  thread_id                    text,
  input_tokens                 integer not null default 0,
  output_tokens                integer not null default 0,
  cache_creation_input_tokens  integer not null default 0,
  cache_read_input_tokens      integer not null default 0,
  total_tokens                 integer not null default 0,
  latency_ms                   integer,
  success                      boolean not null,
  retry_number                 integer not null default 0,
  error_code                   text
);

create index if not exists anthropic_usage_events_occurred_at_idx
  on anthropic_usage_events (occurred_at);
create index if not exists anthropic_usage_events_feature_occurred_at_idx
  on anthropic_usage_events (feature, occurred_at);
create index if not exists anthropic_usage_events_model_occurred_at_idx
  on anthropic_usage_events (model, occurred_at);
