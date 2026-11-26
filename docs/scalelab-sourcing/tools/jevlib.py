"""Shared Jev access for the newer V4 stages (shadow pre-filter, owner-gap pick).

The run-wide Jev cap is V4_JEV_BUDGET_USD, enforced against the run's own ledger
<run>/jev_usage.jsonl, the same ledger qualify.py, icp_gate.py and ads_score.py append to.
So every Jev stage of a run shares one budget. A request is never started if its reserved
token count could cross the cap; the reservation is corrected from the response's usage.
Fail closed: no key/proxy, an HTTP error after retries or a missing cap raises, and the
caller records the company as not scored. Never substitute another model or vendor.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402


class Budget:
    def __init__(self, run, require_cap=True):
        self.ledger = os.path.join(run, 'jev_usage.jsonl')
        self.cap = v4config.JEV_BUDGET_USD
        if require_cap and not self.cap:
            raise SystemExit('V4_JEV_BUDGET_USD must be set (fail closed)')
        self.lock = threading.Lock()
        self.spent = self.ledger_usd()
        self.f = open(self.ledger, 'a')

    def ledger_usd(self):
        tok = 0
        if os.path.exists(self.ledger):
            for line in open(self.ledger):
                try:
                    u = json.loads(line).get('usage') or {}
                except ValueError:
                    continue
                tok += int(u.get('input_tokens') or 0) + int(u.get('output_tokens') or 0)
        return tok * v4config.JEV_USD_PER_MTOK / 1e6

    def reserve(self, tokens):
        with self.lock:
            cost = tokens * v4config.JEV_USD_PER_MTOK / 1e6
            if self.cap and self.spent + cost > self.cap:
                return False
            self.spent += cost
            return True

    def settle(self, reserved, usage, stage, domain, model):
        used = int((usage or {}).get('input_tokens') or 0) + int((usage or {}).get('output_tokens') or 0)
        with self.lock:
            self.spent += (used - reserved) * v4config.JEV_USD_PER_MTOK / 1e6
            if usage:
                self.f.write(json.dumps({'stage': stage, 'domain': domain, 'model': model, 'usage': usage}) + '\n')
                self.f.flush()


def ask(state, questions, timeout=120):
    body = json.dumps({'model': v4config.JEV_MODEL, 'state': state, 'questions': questions}).encode()
    req = urllib.request.Request(v4config.JEV_URL, data=body, method='POST', headers=v4config.jev_headers())
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(2 + 3 * attempt)
                continue
            raise RuntimeError(f'Jev HTTP {e.code}')
        except (urllib.error.URLError, TimeoutError):
            if attempt < 4:
                time.sleep(2 + 3 * attempt)
                continue
            raise
