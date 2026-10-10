-- Agent v2 runtime kill switch (execution only; shadow is never gated by it).
--
-- One control row, read live by the outreach agent immediately before any
-- Agent v2 execution, plus an append-only audit of every change. Flipping it
-- needs no code change, deploy or restart. It starts DISARMED; an armed row
-- must carry an expiry, a reason and a named person, so arming is deliberate
-- and lapses by itself. Changes go through one function that updates the row
-- and appends the audit record in the same transaction, with an optimistic
-- version check. Only service_role (the server) may read or change it.

CREATE TABLE public.agent_v2_runtime_control (
  id text PRIMARY KEY CHECK (id = 'agent_v2_execution'),
  armed boolean NOT NULL DEFAULT false,
  armed_until timestamptz,
  reason text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT 'migration',
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT agent_v2_runtime_control_armed_is_deliberate CHECK (
    NOT armed OR (armed_until IS NOT NULL AND length(btrim(reason)) > 0 AND length(btrim(updated_by)) > 0))
);

CREATE TABLE public.agent_v2_runtime_control_events (
  event_id bigserial PRIMARY KEY,
  control_id text NOT NULL REFERENCES public.agent_v2_runtime_control(id),
  armed boolean NOT NULL,
  armed_until timestamptz,
  previous_armed boolean NOT NULL,
  reason text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL
);

ALTER TABLE public.agent_v2_runtime_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_v2_runtime_control_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_v2_runtime_control FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.agent_v2_runtime_control_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.agent_v2_runtime_control_events_event_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.agent_v2_runtime_control TO service_role;
GRANT SELECT ON TABLE public.agent_v2_runtime_control_events TO service_role;

INSERT INTO public.agent_v2_runtime_control (id, armed, reason, updated_by)
VALUES ('agent_v2_execution', false, 'created disarmed', 'migration');

-- The only write path. SECURITY DEFINER so service_role needs no direct
-- UPDATE/INSERT grant; the audit row and the state change commit together.
CREATE FUNCTION public.agent_v2_set_runtime_control(
  p_armed boolean, p_armed_until timestamptz, p_reason text, p_changed_by text, p_expected_version bigint)
RETURNS TABLE (armed boolean, armed_until timestamptz, reason text, updated_by text, updated_at timestamptz, version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  current_row public.agent_v2_runtime_control%ROWTYPE;
BEGIN
  IF p_changed_by IS NULL OR length(btrim(p_changed_by)) = 0 THEN
    RAISE EXCEPTION 'agent_v2_runtime_control: changed_by is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'agent_v2_runtime_control: reason is required';
  END IF;
  IF p_armed AND (p_armed_until IS NULL OR p_armed_until <= now() OR p_armed_until > now() + interval '15 days') THEN
    RAISE EXCEPTION 'agent_v2_runtime_control: arming needs an expiry within 15 days';
  END IF;
  SELECT * INTO current_row FROM public.agent_v2_runtime_control WHERE id = 'agent_v2_execution' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_v2_runtime_control: control row missing'; END IF;
  IF p_expected_version IS NOT NULL AND current_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'agent_v2_runtime_control: version conflict (expected %, found %)', p_expected_version, current_row.version;
  END IF;
  UPDATE public.agent_v2_runtime_control AS c SET
    armed = p_armed,
    armed_until = CASE WHEN p_armed THEN p_armed_until ELSE NULL END,
    reason = btrim(p_reason), updated_by = btrim(p_changed_by), updated_at = now(),
    version = current_row.version + 1
  WHERE c.id = 'agent_v2_execution';
  INSERT INTO public.agent_v2_runtime_control_events
    (control_id, armed, armed_until, previous_armed, reason, changed_by, version)
  VALUES ('agent_v2_execution', p_armed, CASE WHEN p_armed THEN p_armed_until ELSE NULL END,
    current_row.armed, btrim(p_reason), btrim(p_changed_by), current_row.version + 1);
  RETURN QUERY SELECT c.armed, c.armed_until, c.reason, c.updated_by, c.updated_at, c.version
    FROM public.agent_v2_runtime_control AS c WHERE c.id = 'agent_v2_execution';
END;
$$;

REVOKE ALL ON FUNCTION public.agent_v2_set_runtime_control(boolean, timestamptz, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_v2_set_runtime_control(boolean, timestamptz, text, text, bigint)
  TO service_role;
