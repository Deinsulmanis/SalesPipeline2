"""Candidate-ad sweep outputs (owner brief 2026-11-26): qualified_companies.csv (PASS only) + holds_rejects.csv.

Usage: python3 -I candidate_sweep_build.py <run>

A company is PASS only when ALL hold:
  1. job-posting rule (jobs_rule.py verdict PROMOTE): 2+ hands-on industrial postings in the last 60 days that are at
     least 1/3 of the agency's postings in that window;
  2. 2+ distinct US posting locations (city, state) among the agency's sampled postings (owner brief 2026-11-26);
  3. the ICP gate (icp_decide.py --jobs): company_icp == PASS.
Companies that fail 1 or 2 never reach Jev (qualify.py --only @jobs_pass.json).

Inputs (<run>/): companies.json, jobs_discovery_raw.json, discovery_excluded.json, jobs_evidence.json,
icp_decisions.json (optional until the gate has run), branches.json (optional), sitecache/ + pwcache/.
Writes: qualified_companies.csv, holds_rejects.csv, jobs_pass.json (domains for the Jev gate), sweep_stats.json.
No network, no paid calls.
"""
import collections
import csv
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402
from branch_count import ADDR  # noqa: E402
from jobs_rule import city_state  # noqa: E402

RUN = sys.argv[1]
J = lambda f, d=None: json.load(open(os.path.join(RUN, f))) if os.path.exists(os.path.join(RUN, f)) else d

comps = {c["domain"]: c for c in J("companies.json", [])}
raw = {r["domain"]: r for r in J("jobs_discovery_raw.json", {}).get("found", []) if r.get("domain")}
jobs = J("jobs_evidence.json", {})
icp = {r["domain"]: r for r in J("icp_decisions.json", [])}
branches = J("branches.json", {})


def posting_locations(e):
    return sorted({cs for s in e.get("sample", []) if s.get("us") for cs in [city_state(s.get("location"))] if cs})


def hq(domain):
    """First US street address on the company's own contact / about / home page (sitecache, then pwcache)."""
    pages = []
    for cdir in ("sitecache", "pwcache"):
        f = os.path.join(RUN, cdir, domain + ".json")
        if os.path.exists(f):
            try:
                pages += json.load(open(f)).get("pages") or []
            except (ValueError, OSError):
                pass
    rank = lambda p: 0 if re.search(r"contact", p.get("url") or "", re.I) else 1 if re.search(r"about", p.get("url") or "", re.I) else 2
    for p in sorted(pages, key=rank):
        m = ADDR.search(p.get("text") or "")
        if m:
            return m.group(1).strip(), m.group(2)
    return "", ""


def franchise_flag(name, domain):
    cls, brand = fr.classify_company(name, domain)
    return f"{brand} ({cls.lower()})" if cls and brand else "no"


jobs_pass, holds = [], []
for d, c in comps.items():
    e = jobs.get(d)
    if c.get("pre_gate") == "REJECT":
        holds.append((d, c["company_name"], "crawl", "REJECT", c.get("pre_reason") or "duplicate redirect"))
        continue
    if not e or e.get("verdict") in (None, "NOT_SEARCHED", "NEEDS_ROUND2"):
        holds.append((d, c["company_name"], "job_rule", "HOLD", "job postings not retrieved (fail closed)"))
        continue
    if e["verdict"] != "PROMOTE":
        holds.append((d, c["company_name"], "job_rule", "HOLD", e.get("why") or "job-posting rule not met"))
        continue
    locs = posting_locations(e)
    if len(locs) < 2:
        holds.append((d, c["company_name"], "job_rule", "HOLD", f"only {len(locs)} distinct US posting location(s) in the sample (2+ required)"))
        continue
    jobs_pass.append(d)
json.dump(jobs_pass, open(os.path.join(RUN, "jobs_pass.json"), "w"))

rows = []
for d in jobs_pass:
    c, e, r = comps[d], jobs[d], icp.get(d)
    if r is None:
        holds.append((d, c["company_name"], "icp_gate", "HOLD", "not gated yet"))
        continue
    if r.get("company_icp") != "PASS":
        holds.append((d, c["company_name"], "icp_gate", r.get("company_icp") or "HOLD", f"{r.get('icp_reason_code')}: {r.get('reason')}"))
        continue
    city, st = hq(d)
    states = sorted(set(raw.get(d, {}).get("regions", [])) | {s for _, s in posting_locations(e)})
    ev = next((s["url"] for s in e.get("sample", []) if s.get("hands_on") and s.get("url")), "") or f"https://{d}"
    rows.append({
        "company": c["company_name"], "domain": d, "hq_city": city, "hq_state": st,
        "branch_count": (branches.get(d) or {}).get("branches", ""), "franchise_flag": franchise_flag(c["company_name"], d),
        "industrial_posting_count": e.get("hands_on"), "pct_hands_on": round(100 * (e.get("share") or 0)),
        "top_titles": "; ".join(e.get("sample_roles") or []), "states_posted": " ".join(states),
        "icp_reason": f"{r.get('icp_reason_code')} ({r.get('evidence_basis')}): {e.get('why')}", "evidence_url": ev})

# discovery-stage holds (never paid for): name collisions, chains, franchise shared domains, off-ICP names
for x in J("discovery_excluded.json", []):
    why = x.get("excluded") or ""
    if not why.startswith("DUPLICATE_DOMAIN"):
        holds.append((x.get("domain"), x.get("company_name"), "discovery", "HOLD", why))

cols = ["company", "domain", "hq_city", "hq_state", "branch_count", "franchise_flag", "industrial_posting_count", "pct_hands_on",
        "top_titles", "states_posted", "icp_reason", "evidence_url"]
with open(os.path.join(RUN, "qualified_companies.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(sorted(rows, key=lambda x: -(x["industrial_posting_count"] or 0)))
with open(os.path.join(RUN, "holds_rejects.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["domain", "company", "stage", "decision", "reason"])
    w.writerows(holds)

top = lambda stage: collections.Counter(re.sub(r"\d+", "N", h[4].split(":")[0])[:70] for h in holds if h[2] == stage).most_common(6)
stats = {"net_new": len(comps), "jobs_pass": len(jobs_pass), "pass": len(rows),
         "holds_by_stage": dict(collections.Counter((h[2], h[3]) for h in holds).most_common()),
         "top_reasons": {s: top(s) for s in ("discovery", "job_rule", "icp_gate", "crawl")},
         "hq_found": sum(1 for x in rows if x["hq_state"]), "franchise_pass": sum(1 for x in rows if x["franchise_flag"] != "no")}
json.dump({k: (v if not isinstance(v, dict) else {str(a): b for a, b in v.items()}) for k, v in stats.items()},
          open(os.path.join(RUN, "sweep_stats.json"), "w"), indent=1, default=str)
print(json.dumps(stats, indent=1, default=str))
