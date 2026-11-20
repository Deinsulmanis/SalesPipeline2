"""Run settings shared by every V4 sourcing tool. Nothing here is run-specific in code:
each value comes from an environment variable, with a safe default.

  V4_RUN_DATE        Run date (YYYY-MM-DD). Ad freshness and observed_at are measured from it.
                     Default: today (UTC).
  V4_WAVE            Wave label written on every contact row, e.g. "wave2-2026-12-01".
                     Default: "wave-<V4_RUN_DATE>".
  V4_SCORING_VERSION Scoring version label. Default: "initial-2026-11-18" (the approved 40/25/15/10/10).
  V4_AD_WINDOW_DAYS  An ad is CURRENT if seen within this many days of the run date. Default: 30.

  JEV_MODEL          TypeSafe model id. Default: "jev-1.14.0" (pin the model used in each run report).
  JEV_URL            Default: "https://api.typesafe.ai/v1/systemone".
  TYPESAFE_API_KEY   Jev key. In the Claude cloud environment the proxy injects the real key, so
                     leave this unset (the header is sent as "Bearer proxy-injected"). Anywhere
                     else (Codex, a laptop), export your own key here.

  ADYNTEL_EMAIL / ADYNTEL_API_KEY   Adyntel credentials, sent in the request body (never printed).
"""
import datetime
import os

RUN_DATE = os.environ.get("V4_RUN_DATE") or datetime.datetime.now(datetime.timezone.utc).date().isoformat()
RUN_DAY = datetime.date.fromisoformat(RUN_DATE)
WAVE = os.environ.get("V4_WAVE") or f"wave-{RUN_DATE}"
SCORING_VERSION = os.environ.get("V4_SCORING_VERSION") or "initial-2026-11-18"
AD_WINDOW_DAYS = int(os.environ.get("V4_AD_WINDOW_DAYS") or 30)

JEV_MODEL = os.environ.get("JEV_MODEL") or "jev-1.14.0"
JEV_URL = os.environ.get("JEV_URL") or "https://api.typesafe.ai/v1/systemone"


def jev_headers():
    """Authorization for Jev: your own TYPESAFE_API_KEY, or the cloud proxy's injected key."""
    key = os.environ.get("TYPESAFE_API_KEY") or "proxy-injected"
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def adyntel_credentials():
    email, key = os.environ.get("ADYNTEL_EMAIL"), os.environ.get("ADYNTEL_API_KEY")
    if not email or not key:
        raise SystemExit("ADYNTEL_EMAIL and ADYNTEL_API_KEY must be set (fail closed; no substitute provider)")
    return email, key
