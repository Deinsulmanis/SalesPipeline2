-- ScaleLab sample employer list (Industrial Campaign 3 reply capability).
-- Company-level employer data only: no contact names, emails or phones.
-- Rows are loaded from the private sourcing run, never committed to the repo.
CREATE TABLE IF NOT EXISTS public.sample_employers (
  domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  company text NOT NULL,
  city text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  industry text NOT NULL DEFAULT '',
  trade_focus text NOT NULL DEFAULT '',
  open_roles integer NOT NULL DEFAULT 0 CHECK (open_roles >= 0),
  open_roles_label text,
  example_roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(example_roles) = 'array'),
  newest_posting date,
  checked_at timestamptz,
  status text NOT NULL CHECK (status IN ('hiring', 'not_hiring', 'unchecked')),
  national_rank integer CHECK (national_rank BETWEEN 1 AND 20),
  source text NOT NULL DEFAULT 'jole_employer_pool',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'hiring' OR (checked_at IS NOT NULL AND open_roles > 0)),
  CHECK (status = 'hiring' OR national_rank IS NULL)
);
CREATE INDEX IF NOT EXISTS sample_employers_status_state ON public.sample_employers (status, state);
CREATE UNIQUE INDEX IF NOT EXISTS sample_employers_national_rank ON public.sample_employers (national_rank)
  WHERE national_rank IS NOT NULL;
ALTER TABLE public.sample_employers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sample_employers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sample_employers TO service_role;

-- Lists drafted, sent, and their outcome. Idempotent by event_id.
CREATE TABLE IF NOT EXISTS public.scalelab_sample_list_events (
  event_id text PRIMARY KEY,
  client_id text NOT NULL CHECK (client_id = 'scalelab'),
  kind text NOT NULL CHECK (kind IN ('drafted', 'review', 'sent', 'autosend_refused', 'outcome')),
  action_id text,
  lead_id text NOT NULL,
  message_id text,
  thread_id text,
  mailbox_id text,
  market text,
  scope text,
  state text,
  employer_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  gmail_draft_id text,
  outcome text CHECK (outcome IS NULL OR outcome IN ('call_booked', 'declined', 'replied', 'no_reply')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scalelab_sample_list_events_kind_time
  ON public.scalelab_sample_list_events (kind, occurred_at);
CREATE INDEX IF NOT EXISTS scalelab_sample_list_events_lead ON public.scalelab_sample_list_events (lead_id);
ALTER TABLE public.scalelab_sample_list_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scalelab_sample_list_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scalelab_sample_list_events TO service_role;

-- Prospect agency HQ/branch states for the sample list (company level, keyed
-- by agency domain). Kept apart from outreach_leads.campaign_notes, whose V4
-- profile is digest-sealed and must not be rewritten by other writers.
CREATE TABLE IF NOT EXISTS public.scalelab_agency_states (
  domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  states jsonb NOT NULL CHECK (jsonb_typeof(states) = 'array' AND jsonb_array_length(states) >= 1),
  source text NOT NULL CHECK (source IN ('lead_record', 'site_crawl', 'apollo_hq', 'manual')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.scalelab_agency_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scalelab_agency_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scalelab_agency_states TO service_role;
