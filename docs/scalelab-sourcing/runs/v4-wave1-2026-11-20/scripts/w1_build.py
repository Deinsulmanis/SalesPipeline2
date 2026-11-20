"""Wave 1 outputs + combined V4 master contact list (pilot + wave 1). No personal data is committed (CSV files are git-ignored).

Usage: python3 -I w1_build.py <w1_dir> <pilot_out_dir> <w1_out_dir> <master_csv>
"""
import csv, json, os, sys, datetime, urllib.request, urllib.parse
from collections import Counter

W, PILOT, OUT, MASTER = sys.argv[1:5]
os.makedirs(OUT, exist_ok=True)
VERSION = "initial-2026-11-18"
TODAY = "2026-11-20"


def bucket(t):
    return "HIGH_PRIORITY" if t >= 60 else "STANDARD" if t >= 20 else "LOW_SIGNAL"


def mx_gateway(dom, cache={}):
    if dom in cache:
        return cache[dom]
    r = json.loads(urllib.request.urlopen("https://dns.google/resolve?" + urllib.parse.urlencode({"name": dom, "type": "MX"}), timeout=20).read())
    v = " ".join(a["data"] for a in r.get("Answer", [])).lower()
    g = "proofpoint" if any(x in v for x in ("pphosted", "ppe-hosted", "gpphosted")) else "google" if "google" in v else "microsoft" if "outlook" in v else "mimecast" if "mimecast" in v else "barracuda" if "barracuda" in v else ("NO MX" if not v else "other")
    cache[dom] = g
    return g


def w(path, rows, cols):
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

HOLDS = {
    "flexbluestaffing.com": "Apollo resolved Brandon Smith to a different current employer (techservjobs.com) with no email - buyer may have left; no valid contact",
    "equitystaffing.com": "Buyer email is on equitysg.com: Microsoft MX exists and matches the company initials, but the domain has no website and is not used on equitystaffing.com - relation unproven",
    "resourceemployment.com": "CEO Sam Rossa is listed on resourceemployment.com, but the Apollo email is at True PEO (his current Apollo employer since 2025-01); no on-site link between the two - unrelated domain",
    "motiveworkforce.com": "Buyer email is on motivecompanies.com: motivecompanies.com redirects to motiveone.com (near-empty page); no on-site link to Motive Workforce - relation unproven",
    "opsourcestaffing.com": "Apollo returned no match for the Director of Sales and Marketing (no credit charged)",
}
CAUTION = {
    "cs-recruiting.com": "Company name reads 'a Hirewell company' - acquired by Hirewell; confirm the founder still owns buying decisions",
    "sci-staffing.com": "Apollo match LOW CONFIDENCE (title 'Executive'); person is named Founder & CEO on the company's own team page",
    "cpi-group.com": "Apollo match LOW CONFIDENCE; 'Mark Smith, President' is named on the company's own site",
    "labordepotllc.com": "President since 2025-11 (new in role; LinkedIn headline 'President & Majority Owner')",
    "simplydrivensearch.com": "Email domain simplydriven.com redirects to simplydrivensearch.com (related)",
    "ameriforce.com": "Also CEO of Kairos Group Holdings (employee-owned holding company)",
}

# ---------- wave 1 contacts ----------
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
        "wave": "wave1-2026-11-20", "company_name": x["company_name"], "company_domain": dom,
        "buyer_name": name, "buyer_title": title, "buyer_tier": t["tier"], "email": email, "email_status": f"Apollo {est}", "catch_all": catch == "True", "mail_gateway": gw,
        "demand_score": tot, "signal_priority": bucket(tot), "ad_class": ai["ad_class"],
        "employer_facing_ads": sc["employer_facing_ads"], "own_company_bd_hiring": sc["own_company_bd_hiring"], "market_expansion": sc["market_expansion"],
        "sustained_employer_ads": sc["sustained_employer_ads"], "other_commercial_growth": sc["other_commercial_growth"], "scoring_version": VERSION,
        "v4_tag": f"V4|PASS|{bucket(tot)}|{ai['ad_class']}|COPY_TIER_PENDING", "copy_tier": "PENDING_OWNER_COPY",
        "contact_status": "READY_FOR_REVIEW", "qc_flags": "; ".join(flags), "linkedin_url": r[9], "role_start": "" if r[10] == "None" else r[10], "location": r[11],
        "buyer_source": t["source"], "apollo_id": r[3], "icp_evidence_url": (x.get("icp_evidence") or [{}])[0].get("url", ""), "ad_summary": ai.get("why", ""),
        "dedupe_status": "CHECKED (domain + email vs ScaleLab Supabase leads; vs pilot run)",
        "suppression_status": "CLEAR in Supabase ScaleLab leads; global Suppression sheet NOT checked - check at import", "observed_at": TODAY})
for d in [x["domain"] for x in dec if x["company_icp"] == "PASS"]:
    if d not in targets:
        x = next(z for z in dec if z["domain"] == d)
        w1_holds.append({"level": "contact", "company_name": x["company_name"], "company_domain": d, "decision": "PASS company / HOLD contact", "reason_code": "NO_ELIGIBLE_BUYER",
                         "reason": short.get(d, "No tier 1-3 buyer with an email on file in Apollo search or on the company's team pages"),
                         "evidence_that_would_resolve": "Waterfall enrichment or manual research for a current owner/president/CEO or sales/BD leader"})

# ---------- wave 1 company files ----------
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
w(f"{OUT}/company-qualification.csv", qrows, list(qrows[0].keys()))
rr = []
for d, s in sorted(scores.items(), key=lambda kv: -kv[1]["signals"]["total"]):
    x = next(z for z in dec if z["domain"] == d)
    rr.append({"company_name": x["company_name"], "company_domain": d, **s["signals"], "scoring_version": VERSION, "evidence_coverage": "PARTIAL", "signal_priority": bucket(s["signals"]["total"]),
               "ad_class": s["ads"]["ad_class"], "ad_freshness": s["ads"].get("freshness") or "", "attribution_p": s["ads"].get("attribution_p") or "", "score_reason": s["ads"].get("why", ""),
               "v4_tag": f"V4|PASS|{bucket(s['signals']['total'])}|{s['ads']['ad_class']}|COPY_TIER_PENDING", "has_review_ready_buyer": "YES" if any(c["company_domain"] == d for c in w1_contacts) else "NO"})
w(f"{OUT}/ranked-companies.csv", rr, list(rr[0].keys()))
arows = []
for d, v in adcls.items():
    for a in v["ads"]:
        arows.append({"company_domain": d, "platform": a["platform"], "advertiser": a.get("advertiser"), "start": a.get("start"), "last_seen": a.get("last_seen"), "current": a.get("current"),
                      "employer_facing_p": a.get("employer_p"), "text": a["text"], "url": a.get("url"), "observed_at": TODAY})
w(f"{OUT}/ad-intent-and-signals.csv", arows, list(arows[0].keys()))
holds = w1_holds + [{"level": "company", "company_name": x["company_name"], "company_domain": x["domain"], "decision": x["company_icp"], "reason_code": x["icp_reason_code"], "reason": x["reason"], "evidence_that_would_resolve": ""} for x in dec if x["company_icp"] != "PASS"]
w(f"{OUT}/review-holds.csv", holds, list(holds[0].keys()))
cols = list(w1_contacts[0].keys())
w(f"{OUT}/approved-contacts.csv", w1_contacts, cols)

# ---------- master (pilot + wave 1) ----------
pilot_ranked = {r["company_domain"]: r for r in csv.DictReader(open(f"{PILOT}/ranked-companies.csv"))}
master = []
for p in csv.DictReader(open(f"{PILOT}/approved-contacts.csv")):
    d = p["company_domain"]; pr = pilot_ranked.get(d, {})
    edom = p["email"].split("@")[1].lower(); gw = mx_gateway(edom)
    tot = int(p["total_score"] or 0)
    master.append({c: "" for c in cols} | {
        "wave": "pilot-2026-11-19", "company_name": p["company_name"], "company_domain": d, "buyer_name": p["buyer_name"], "buyer_title": p["buyer_title"], "buyer_tier": p["buyer_tier"],
        "email": p["email"], "email_status": p["email_status_source"], "catch_all": "", "mail_gateway": gw, "demand_score": tot, "signal_priority": bucket(tot), "ad_class": pr.get("ad_class", ""),
        "employer_facing_ads": pr.get("employer_facing_ads", 0), "own_company_bd_hiring": pr.get("own_company_bd_hiring", 0), "market_expansion": pr.get("market_expansion", 0),
        "sustained_employer_ads": pr.get("sustained_employer_ads", 0), "other_commercial_growth": pr.get("other_commercial_growth", 0), "scoring_version": VERSION,
        "v4_tag": f"V4|PASS|{bucket(tot)}|{pr.get('ad_class', '')}|COPY_TIER_PENDING", "copy_tier": "PENDING_OWNER_COPY", "contact_status": p["contact_status"],
        "qc_flags": "; ".join(z for z in [p.get("review_notes", ""), "catch-all not checked (pilot used GetLeads/Apollo status)" if "Apollo" not in p["email_status_source"] else ""] if z) + ("; PROOFPOINT gateway" if gw == "proofpoint" else ""),
        "linkedin_url": p["linkedin_url"], "role_start": p["role_start"], "buyer_source": p["contact_source"], "dedupe_status": p["dedupe_status"], "suppression_status": p["suppression_status"], "observed_at": p["contact_observed_at"]})
master += w1_contacts
master.sort(key=lambda r: (-int(r["demand_score"]), r["wave"], r["company_name"]))
w(MASTER, master, cols)
print("wave1 approved", len(w1_contacts), "| wave1 contact holds", len(w1_holds))
print("master", len(master), Counter(r["signal_priority"] for r in master), Counter(r["v4_tag"] for r in master))
for r in master:
    print(f"  {r['demand_score']:>3} {r['signal_priority']:13} {r['ad_class']:22} {r['company_name'][:34]:34} {r['buyer_name']:22} {r['buyer_title'][:30]:30} {r['qc_flags'][:50]}")
