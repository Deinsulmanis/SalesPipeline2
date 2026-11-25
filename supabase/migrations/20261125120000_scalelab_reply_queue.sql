-- ScaleLab fast reply mode: one row per routed prospect reply that needs the
-- owner (interest, information, pricing, meeting, reschedule). Holds the reply
-- screen state, the editable draft and the single owner alert. Prospect email
-- bodies are NOT stored here; the screen reads the live Gmail thread.
CREATE TABLE IF NOT EXISTS public.scalelab_reply_queue (
  action_id text PRIMARY KEY CHECK (action_id ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL CHECK (client_id = 'scalelab'),
  lead_id text NOT NULL,
  message_id text NOT NULL,
  thread_id text NOT NULL,
  mailbox_id text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('interest', 'information_request', 'pricing_request', 'meeting_request', 'reschedule_request')),
  received_at timestamptz NOT NULL,
  first_name text NOT NULL DEFAULT '',
  company text NOT NULL DEFAULT '',
  state text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'gmail_draft', 'dismissed')),
  draft_text text,
  draft_source text,
  draft_updated_at timestamptz,
  alert_status text NOT NULL DEFAULT 'pending' CHECK (alert_status IN ('pending', 'queued', 'sending', 'sent', 'failed', 'disabled')),
  alert_send_after timestamptz,
  alert_attempts integer NOT NULL DEFAULT 0 CHECK (alert_attempts BETWEEN 0 AND 2),
  alert_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_message_id text,
  gmail_draft_id text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, mailbox_id, message_id, lead_id)
);
CREATE INDEX IF NOT EXISTS scalelab_reply_queue_status ON public.scalelab_reply_queue (status, received_at DESC);
CREATE INDEX IF NOT EXISTS scalelab_reply_queue_alerts ON public.scalelab_reply_queue (alert_status, alert_send_after);
ALTER TABLE public.scalelab_reply_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scalelab_reply_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scalelab_reply_queue TO service_role;
