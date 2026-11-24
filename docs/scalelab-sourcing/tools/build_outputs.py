"""Stage 7: run outputs (review CSVs) and the cumulative V4 master contact list.

Usage: python3 -I build_outputs.py <run_dir> <out_dir> <master_csv>

<run_dir> holds the run's working files (icp_decisions.json, companies.json, scores.json,
ad_classification.json, targets.json, buyer_shortfalls.json, reveal/all.rows) and, optionally,
contact_qc.json with the reviewer's manual contact notes:
  {"holds":   {"<domain>": "<why this contact is held>"},
   "caution": {"<domain>": "<flag to show on the row>"}}
Keep buyer names and emails out of contact_qc.json reasons where you can; the run folder is git-ignored anyway.

The new contacts are APPENDED to <master_csv> (created if missing). A row already in the master
for the same company domain or email is kept as it is and the new one is skipped (reported).
Wave label, run date and scoring version come from v4config (V4_WAVE, V4_RUN_DATE, V4_SCORING_VERSION).
No personal data is committed: the output CSVs and the master are git-ignored.
"""
import csv, json, os, sys, datetime, urllib.request, urllib.parse
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402

W, OUT, MASTER = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
VERSION = v4config.SCORING_VERSION
TODAY = v4config.RUN_DATE
WAVE = v4config.WAVE


def bucket(t, ads=None):
    # A run that did not check ads (scores.json "not_checked") cannot call a company low-signal.
    if ads and ads.get("not_checked"):
        return "INSUFFICIENT_EVIDENCE"
    return "HIGH_PRIORITY" if t >= 60 else "STANDARD" if t >= 20 else "LOW_SIGNAL"


def src_label(source):
    s = str(source or '')
    return 'GetLeads' if s.startswith('getleads') else 'Apollo' if (not s or s.startswith('apollo')) else 'Campaign 2 record,' if s.startswith('campaign2') else s


def mx_gateway(dom, cache={}):
    if dom in cache:
        return cache[dom]
    r = json.loads(urllib.request.urlopen("https://dns.google/resolve?" + urllib.parse.urlencode({"name": dom, "type": "MX"}), timeout=20).read())
    v = " ".join(a["data"] for a in r.get("Answer", [])).lower()
    g = "proofpoint" if any(x in v for x in ("pphosted", "ppe-hosted", "gpphosted")) else "google" if "google" in v else "microsoft" if "outlook" in v else "mimecast" if "mimecast" in v else "barracuda" if "barracuda" in v else ("NO MX" if not v else "other")
    cache[dom] = g
    return g


def w(path, rows, cols=None):
    cols = cols or (list(rows[0].keys()) if rows else ["note"])
    with open(path, "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        for r in rows:
            wr.writerow(r)


dec = json.load(open(f"{W}/icp_decisions.json"))
comps = {c["domain"]: c for c in json.load(open(f"{W}/companies.json"))}
scores = json.load(open(f"{W}/scores.json"))
adcls = json.load(open(f"{W}/ad_classification.json"))
targets = {t["domain"]: t for t in json.load(open(f"{W}/targets.json"))}
short = json.load(open(f"{W}/buyer_shortfalls.json"))
rows = [l.rstrip("\n").split("|") for l in open(f"{W}/reveal/all.rows") if l.count("|") > 5]

_qc_path = os.path.join(W, "contact_qc.json")
_qc = json.load(open(_qc_path)) if os.path.exists(_qc_path) else {}
HOLDS = _qc.get("holds", {})
CAUTION = _qc.get("caution", {})

# ---------- this run's contacts ----------
w1_contacts, w1_holds = [], []
for r in rows:
    i, dom = int(r[0]), r[1]
    t = targets[dom]
    x = next(d for d in dec if d["domain"] == dom)
    sc = scores[dom]["signals"]; ai = scores[dom]["ads"]
    if dom in HOLDS:
        w1_holds.append({"level": "contact", "company_name": x["company_name"], "company_domain": dom, "decision": "PASS company / HOLD contact", "reason_code": "CONTACT_QC", "reason": HOLDS[dom],
                         "evidence_that_would_resolve": "Confirm the email domain belongs to the agency (or find the buyer's company address); re-run QC"})
        continue
    name, title, email, est, catch = r[4], r[5], r[6], r[7], r[8]
    if "@" not in email:
        w1_holds.append({"level": "contact", "company_name": x["company_name"], "company_domain": dom, "decision": "PASS company / HOLD contact", "reason_code": "NO_EMAIL",
                         "reason": "The reveal returned no email for this buyer", "evidence_that_would_resolve": "Waterfall enrichment or another verified buyer"})
        continue
    if title.strip().lower() in ("executive", "", "none"):
        title = t["title"]  # Apollo stub title; use the title from the company's own team page
    edom = email.split("@")[1].lower()
    gw = mx_gateway(edom)
    flags = []
    if catch == "True": flags.append("CATCH_ALL (queue last)")
    if gw == "proofpoint": flags.append("PROOFPOINT gateway")
    if gw == "proofpoint" and catch == "True":
        w1_holds.append({"level": "contact", "company_name": x["company_name"], "company_domain": dom, "decision": "PASS company / HOLD contact", "reason_code": "PROOFPOINT_CATCHALL", "reason": "Proofpoint + catch-all", "evidence_that_would_resolve": "Alternate verified address"}); continue
    if dom in CAUTION: flags.append(CAUTION[dom])
    tot = sc["total"]
    w1_contacts.append({
        "wave": WAVE, "company_name": x["company_name"], "company_domain": dom,
        "buyer_name": name, "buyer_title": title, "buyer_tier": t["tier"], "email": email, "email_status": f"{src_label(t.get('source'))} {est}", "catch_all": catch == "True", "mail_gateway": gw,
        "demand_score": tot, "signal_priority": bucket(tot, ai), "ad_class": ai["ad_class"],
        "employer_facing_ads": sc["employer_facing_ads"], "own_company_bd_hiring": sc["own_company_bd_hiring"], "market_expansion": sc["market_expansion"],
        "sustained_employer_ads": sc["sustained_employer_ads"], "other_commercial_growth": sc["other_commercial_growth"], "scoring_version": VERSION,
        "v4_tag": f"V4|PASS|{bucket(tot, ai)}|{ai['ad_class']}|COPY_TIER_PENDING", "copy_tier": "PENDING_OWNER_COPY",
        "contact_status": "READY_FOR_REVIEW", "qc_flags": "; ".join(flags), "linkedin_url": r[9], "role_start": "" if r[10] == "None" else r[10], "location": r[11],
        "buyer_source": t["source"], "apollo_id": r[3], "icp_evidence_url": (x.get("icp_evidence") or [{}])[0].get("url", ""), "ad_summary": ai.get("why", ""),
        "dedupe_status": "CHECKED (domain + email vs ScaleLab Supabase leads and the V4 master)",
        "suppression_status": "CLEAR in Supabase ScaleLab leads; the Campaign 3 import checks the global Suppression sheet", "observed_at": TODAY})
for d in [x["domain"] for x in dec if x["company_icp"] == "PASS"]:
    if d not in targets:
        x = next(z for z in dec if z["domain"] == d)
        w1_holds.append({"level": "contact", "company_name": x["company_name"], "company_domain": d, "decision": "PASS company / HOLD contact", "reason_code": "NO_ELIGIBLE_BUYER",
                         "reason": short.get(d, "No tier 1-3 buyer with an email on file in Apollo search or on the company's team pages"),
                         "evidence_that_would_resolve": "Waterfall enrichment or manual research for a current owner/president/CEO or sales/BD leader"})

# ---------- this run's company files ----------
qrows = []
for x in dec:
    c = comps[x["domain"]]
    j = x.get("jev", {}); ev = x.get("icp_evidence") or []
    qrows.append({"company_name": x["company_name"], "company_domain": x["domain"], "source": c.get("source_id"), "company_icp": x["company_icp"], "icp_reason_code": x["icp_reason_code"], "reason": x["reason"],
                  "dedupe_status": x.get("dedupe_status"), "industrial_service_lines": "; ".join(x.get("industrial_specializations", [])), "staffing_models": "; ".join(x.get("staffing_models", [])),
                  "evidence_url_1": ev[0]["url"] if ev else "", "evidence_excerpt_1": ev[0]["excerpt"] if ev else "", "observed_at": TODAY if ev else "",
                  "jev_model": x.get("jev_model", ""), "jev_identity_p": j.get("identity_match", ""), "jev_business_type": j.get("business_type", ""), "jev_industrial_line": j.get("industrial_line", ""),
                  "jev_service_model": j.get("service_model", ""), "jev_us_p": j.get("us_operations", ""), "jev_chain_p": j.get("large_national_chain", ""), "jev_hands_on_p": j.get("hands_on_workers", "")})
qrows.sort(key=lambda r: ({"PASS": 0, "HOLD": 1, "REJECT": 2}[r["company_icp"]], r["company_name"]))
w(f"{OUT}/company-qualification.csv", qrows)
rr = []
for d, s in sorted(scores.items(), key=lambda kv: -kv[1]["signals"]["total"]):
    x = next(z for z in dec if z["domain"] == d)
    rr.append({"company_name": x["company_name"], "company_domain": d, **s["signals"], "scoring_version": VERSION, "evidence_coverage": "PARTIAL", "signal_priority": bucket(s["signals"]["total"], s["ads"]),
               "ad_class": s["ads"]["ad_class"], "ad_freshness": s["ads"].get("freshness") or "", "attribution_p": s["ads"].get("attribution_p") or "", "score_reason": s["ads"].get("why", ""),
               "v4_tag": f"V4|PASS|{bucket(s['signals']['total'], s['ads'])}|{s['ads']['ad_class']}|COPY_TIER_PENDING", "has_review_ready_buyer": "YES" if any(c["company_domain"] == d for c in w1_contacts) else "NO"})
w(f"{OUT}/ranked-companies.csv", rr)
arows = []
for d, v in adcls.items():
    for a in v["ads"]:
        arows.append({"company_domain": d, "platform": a["platform"], "advertiser": a.get("advertiser"), "start": a.get("start"), "last_seen": a.get("last_seen"), "current": a.get("current"),
                      "employer_facing_p": a.get("employer_p"), "text": a["text"], "url": a.get("url"), "observed_at": TODAY})
w(f"{OUT}/ad-intent-and-signals.csv", arows)
holds = w1_holds + [{"level": "company", "company_name": x["company_name"], "company_domain": x["domain"], "decision": x["company_icp"], "reason_code": x["icp_reason_code"], "reason": x["reason"], "evidence_that_would_resolve": ""} for x in dec if x["company_icp"] != "PASS"]
w(f"{OUT}/review-holds.csv", holds)
cols = list(w1_contacts[0].keys())
w(f"{OUT}/approved-contacts.csv", w1_contacts, cols)

# ---------- cumulative master ----------
existing = list(csv.DictReader(open(MASTER))) if os.path.exists(MASTER) else []
seen_domains = {r["company_domain"].lower() for r in existing}
seen_emails = {r["email"].lower() for r in existing}
added, skipped = [], []
for c in w1_contacts:
    if c["company_domain"].lower() in seen_domains or c["email"].lower() in seen_emails:
        skipped.append(c["company_domain"]); continue
    added.append(c)
master_cols = list(existing[0].keys()) if existing else cols
for c in cols:
    if c not in master_cols:
        master_cols.append(c)
master = existing + added
master.sort(key=lambda r: (-int(r.get("demand_score") or 0), r.get("wave", ""), r.get("company_name", "")))
w(MASTER, master, master_cols)
print(f"{WAVE}: approved {len(w1_contacts)} | contact holds {len(w1_holds)} | added to master {len(added)} | already in master {len(skipped)} {skipped}")
print("master", len(master), Counter(r["signal_priority"] for r in master))
