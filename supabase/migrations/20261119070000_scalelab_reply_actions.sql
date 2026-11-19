-- Separate ledger. Never backfill old inbound messages into active routing.
CREATE TABLE public.scalelab_reply_actions (
  action_id text PRIMARY KEY CHECK (action_id ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL CHECK (client_id = 'scalelab'),
  mode text NOT NULL CHECK (mode IN ('shadow', 'apply')),
  lead_id text NOT NULL,
  message_id text NOT NULL,
  mailbox_id text NOT NULL,
  received_at timestamptz NOT NULL,
  source_event_id text NOT NULL,
  verdict jsonb NOT NULL,
  plan jsonb NOT NULL,
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  step text NOT NULL CHECK (step IN ('planned', 'held', 'complete', 'review')),
  outcome jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, mode, mailbox_id, message_id, lead_id),
  CHECK (mode = 'apply' OR step = 'planned')
);
CREATE INDEX scalelab_reply_actions_mode_received_at
  ON public.scalelab_reply_actions (mode, received_at, action_id);
ALTER TABLE public.scalelab_reply_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scalelab_reply_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scalelab_reply_actions TO service_role;
