"""V4 Stages 5-6 + deliverables: scoring (code), buyer selection (playbook order), CSV/MD review artifacts.

Usage: python3 -I build_outputs.py <run_dir> <out_dir>
"""
import csv, json, os, re, sys, datetime
from collections import Counter

RUN, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
VERSION = "initial-2026-11-18"
RUN_DATE = "2026-11-19"
ACTIVE_WINDOW_DAYS = 30

_declist = json.load(open(f"{RUN}/icp_decisions.json"))
dec = {}
for i, x in enumerate(_declist):
    k = x["domain"] or f"(no-domain-{i})"
    if k in dec: k = f"{k}#dup{i}"
    dec[k] = x
comps = json.load(open(f"{RUN}/companies.json"))
adcls = json.load(open(f"{RUN}/ad_classification.json"))
contacts = json.load(open(f"{RUN}/contacts.json"))

# ---------------- Stage 5 scoring (code; Jev supplied the ad class) ----------------
AD_NOTES = {
    "lonestarstaffing.biz": {
        "ad_class": "MIXED", "employer_facing_ads": 40, "sustained_employer_ads": 10,
        "why_ads": "Google text ads naming Lone Star Staffing (Irving, TX), advertiser account 'Full Steam Staffing, LLC' = parent per first-party site ('The Full Steam Staffing Family of Companies'). Employer-facing creatives live (last_seen 2026-11-19), e.g. 'We Focus on Providing Clerical and Light Industrial Staffing Solutions to Manufacturers'.",
        "why_sustained": "At least 3 distinct employer-facing creatives ('...Staffing Solutions to Manufacturers', 'Qualified & Reliable Workers - We Develop Staffing Solutions...', 'Help Our Clients Meet Seasons Production Demands') running from 2023-06 to 2026-11; duplicates collapsed.",
        "status": "FOUND", "platforms": ["Google"], "freshness": "CURRENT"},
    "clarkpersonnel.com": {
        "ad_class": "EMPLOYER_ACQUISITION", "employer_facing_ads": 0, "sustained_employer_ads": 0,
        "why_ads": "3 LinkedIn employer-facing creatives ('Clark Personnel connects you with the right skilled professionals to cut production unit costs...'). Adyntel date_filter: present for 'year', absent for 'last30d' -> not current within the 30-day window; creatives uploaded 2026-01-15. STALE -> 0 points.",
        "why_sustained": "All 3 creatives uploaded the same day (one campaign); no timeline beyond 2026 -> 0.",
        "status": "FOUND", "platforms": ["LinkedIn"], "freshness": "STALE"},
    "prtstaffing.com": {
        "ad_class": "CANDIDATE_RECRUITMENT", "employer_facing_ads": 0, "sustained_employer_ads": 0,
        "why_ads": "4 Meta + 4 LinkedIn ads, all job ads to workers (e.g. '$65/hour + $150 per diem... hiring licensed Low Voltage Electricians', CTA 'Apply now'). Candidate-only -> 0 points.",
        "why_sustained": "Candidate-only.", "status": "FOUND", "platforms": ["Meta", "LinkedIn"], "freshness": "CURRENT"},
}


def bucket(total, coverage):
    if coverage == "INSUFFICIENT":
        return "INSUFFICIENT_EVIDENCE"
    return "HIGH_PRIORITY" if total >= 60 else "STANDARD" if total >= 20 else "LOW_SIGNAL"


ranked = []
for d, x in dec.items():
    if x["company_icp"] != "PASS":
        continue
    a = AD_NOTES.get(d, {"ad_class": "NO_ADS_OBSERVED", "employer_facing_ads": 0, "sustained_employer_ads": 0,
                         "why_ads": "Adyntel Google (US), Meta (US, active+inactive) and LinkedIn (US): no ads returned on 2026-11-19. Absence of evidence, not proof of no budget.",
                         "why_sustained": "No ads observed.", "status": "NO_ADS_OBSERVED", "platforms": [], "freshness": None})
    s = {"employer_facing_ads": a["employer_facing_ads"], "own_company_bd_hiring": 0, "market_expansion": 0,
         "sustained_employer_ads": a["sustained_employer_ads"], "other_commercial_growth": 0}
    s["total"] = sum(s.values())
    cov = "PARTIAL"  # ads checked on 3 platforms; BD hiring / expansion / leadership only checked on cached first-party pages
    ranked.append({"domain": d, "company_name": x["company_name"], "ads": a, "signals": s, "coverage": cov,
                   "priority": bucket(s["total"], cov)})
ranked.sort(key=lambda r: (-r["signals"]["total"], r["company_name"]))

# ---------------- Stage 6 buyer selection (playbook order, no randomisation) ----------------
T1 = re.compile(r"\b(owner|founder|co-founder|(?<!vice )president|ceo|chief executive|managing partner)\b", re.I)
T2 = re.compile(r"\b(chief revenue|cro|vp (of )?sales|vice president (of )?sales|vp business development|vp (of )?business development|vice president,? (of )?business development|sr\.? vice president of sales)\b", re.I)
T3 = re.compile(r"\b(director of sales|director of business development)\b", re.I)
ROLE_BOX = re.compile(r"^(info|sales|action|contact|admin|office|hr|jobs|careers|hello|team)@", re.I)


def tier(c):
    t = c["title"]
    if re.search(r"\bcoo\b", t, re.I) and T1.search(t):
        return 1
    if T1.search(t): return 1
    if T2.search(t): return 2
    if T3.search(t): return 3
    return 4


def disq(c, company_domain):
    issues = []
    if ROLE_BOX.search(c["email"]) or c["name"].lower().replace(" ", "") in company_domain.replace("-", "").replace(".com", ""):
        issues.append("role/generic mailbox, not a named person")
    note = (c.get("note") or "").lower()
    if "different person" in note or "different business" in note or "not at prt" in note or "consultant to" in note:
        issues.append("employment/identity conflict: " + c.get("note"))
    return issues


contact_rows, holds_contact = {}, {}
by_dom = {}
for c in contacts:
    by_dom.setdefault(c["domain"], []).append(c)
for r in ranked:
    d = r["domain"]
    cands = []
    for c in by_dom.get(d, []):
        iss = disq(c, d)
        cands.append((tier(c), 0 if c["email_status"] == "VALID" else 1, iss, c))
    elig = sorted([z for z in cands if not z[2] and z[0] <= 3], key=lambda z: (z[0], z[1]))
    if not elig:
        why = "No eligible senior commercial buyer in GetLeads data"
        if cands:
            why += " (found: " + "; ".join(f"{z[3]['name']} - {z[3]['title']}" + (f" [{', '.join(z[2])}]" if z[2] else " [tier 4 title: HOLD]") for z in cands) + ")"
        if d == "lonestarstaffing.biz":
            why += ". First-party leadership page names a 'Vice President of Sales' and CEO/COO, CEO/CFO, but no email was revealed (Apollo not authorized in this run)."
        holds_contact[d] = why
        continue
    t, _, _, c = elig[0]
    status, missing = "READY_FOR_REVIEW", []
    edom = c["email"].split("@")[1].lower()
    if c["email_status"] != "VALID":
        status = "NEEDS_EVIDENCE"; missing.append(f"email status {c['email_status']} in GetLeads (not verified deliverable); no paid verification authorized")
    if edom != d and not d.endswith(edom):
        status = "NEEDS_EVIDENCE"; missing.append(f"email domain {edom} differs from company website domain {d}")
    if d == "imperialdesign.com":
        missing.append("GetLeads lists 4 'Owner' records at Imperial Design; one (Brian Dowdy) belongs to another firm. Confirm which owner is current decision-maker")
    if not c.get("linkedin"):
        missing.append("no LinkedIn profile to corroborate current employment (GetLeads record only)")
    alts = [f"{z[3]['name']} ({z[3]['title']}, {z[3]['email_status']})" for z in elig[1:3]]
    contact_rows[d] = {"buyer": c, "tier": t, "contact_status": status, "missing": missing, "alternates": alts}

# ---------------- write CSVs ----------------
def w(name, rows, cols):
    with open(os.path.join(OUT, name), "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        for r in rows: wr.writerow(r)

src = {}
for i, c in enumerate(comps):
    k = c["domain"] or f"(no-domain-{i})"
    if k in src: k = f"{k}#dup{i}"
    src[k] = c
qrows = []
for d, x in dec.items():
    c = src.get(d, {})
    ev = x.get("icp_evidence", [])
    j = x.get("jev", {})
    qrows.append({"company_name": x["company_name"], "company_domain": "" if d.startswith("(no-domain") else d.split("#")[0], "hq_city": c.get("hq_city"), "employee_band": c.get("employee_band"),
                  "company_source": "GetLeads", "company_source_id": c.get("source_id"), "discovery_query": c.get("batch"),
                  "company_icp": x["company_icp"], "icp_reason_code": x["icp_reason_code"], "reason": x["reason"], "dedupe_status": x["dedupe_status"],
                  "industrial_service_lines": "; ".join(x.get("industrial_specializations", [])), "staffing_models": "; ".join(x.get("staffing_models", [])),
                  "evidence_url_1": ev[0]["url"] if ev else "", "evidence_excerpt_1": ev[0]["excerpt"] if ev else "",
                  "evidence_url_2": ev[1]["url"] if len(ev) > 1 else "", "evidence_excerpt_2": ev[1]["excerpt"] if len(ev) > 1 else "",
                  "observed_at": RUN_DATE if ev else "", "jev_model": x.get("jev_model", ""),
                  "jev_identity_p": j.get("identity_match", ""), "jev_business_type": j.get("business_type", ""), "jev_business_type_p": j.get("business_type_p", ""),
                  "jev_industrial_line": j.get("industrial_line", ""), "jev_industrial_line_p": j.get("industrial_line_p", ""), "jev_service_model": j.get("service_model", ""),
                  "jev_us_p": j.get("us_operations", ""), "jev_national_chain_p": j.get("large_national_chain", ""), "jev_hands_on_p": j.get("hands_on_workers", ""), "jev_mgmt_only_p": j.get("management_only", ""),
                  "decided_by": x.get("decided_by")})
order = {"PASS": 0, "HOLD": 1, "REJECT": 2}
qrows.sort(key=lambda r: (order[r["company_icp"]], r["company_name"] or ""))
w("company-qualification.csv", qrows, list(qrows[0].keys()))

arows = []
for r in ranked:
    a = r["ads"]; d = r["domain"]
    base = {"company_name": r["company_name"], "company_domain": d, "adyntel_lookup_status": a["status"], "platforms_checked": "Google(US); Meta(US, active+inactive); LinkedIn(US)",
            "ad_class": a["ad_class"], "ad_freshness": a["freshness"] or "", "verified_ad_spend_usd": "", "ad_summary": a["why_ads"],
            "own_company_bd_hiring": "UNKNOWN (no dated internal sales posting on cached first-party pages; job boards not searched)",
            "market_expansion": "UNKNOWN (no dated expansion announcement on cached first-party pages; news not searched)",
            "other_commercial_growth": "UNKNOWN", "observed_at": RUN_DATE}
    if d in adcls:
        for ad in adcls[d]["ads"]:
            arows.append({**base, "ad_platform": ad["platform"], "ad_id": ad.get("ad_id") or ad.get("creative_id"),
                          "ad_text": (ad.get("title") or ad.get("headline") or "") + " | " + (ad.get("text") or ""),
                          "landing_or_library_url": ad.get("landing") or ad.get("library_url") or "",
                          "ad_dates": " -> ".join(z for z in [ad.get("start") or ad.get("creative_uploaded") or "", ad.get("end") or ad.get("last_seen") or ""] if z),
                          "advertiser_name": ad.get("advertiser", r["company_name"])})
    else:
        arows.append({**base, "ad_platform": "", "ad_id": "", "ad_text": "", "landing_or_library_url": "", "ad_dates": "", "advertiser_name": ""})
w("ad-intent-and-signals.csv", arows, ["company_name", "company_domain", "adyntel_lookup_status", "platforms_checked", "ad_class", "ad_freshness", "ad_platform", "ad_id", "advertiser_name", "ad_dates", "ad_text", "landing_or_library_url", "ad_summary", "verified_ad_spend_usd", "own_company_bd_hiring", "market_expansion", "other_commercial_growth", "observed_at"])


def tag(r):
    return f"V4|PASS|{r['priority']}|{r['ads']['ad_class']}|COPY_TIER_PENDING"


rrows = []
for i, r in enumerate(ranked, 1):
    s = r["signals"]; cr = contact_rows.get(r["domain"])
    rrows.append({"rank": i, "company_name": r["company_name"], "company_domain": r["domain"], "v4_tag": tag(r),
                  "employer_facing_ads": s["employer_facing_ads"], "own_company_bd_hiring": s["own_company_bd_hiring"], "market_expansion": s["market_expansion"],
                  "sustained_employer_ads": s["sustained_employer_ads"], "other_commercial_growth": s["other_commercial_growth"], "total": s["total"],
                  "scoring_version": VERSION, "evidence_coverage": r["coverage"], "signal_priority": r["priority"], "ad_class": r["ads"]["ad_class"],
                  "score_reason": r["ads"]["why_ads"] + (" Sustained: " + r["ads"]["why_sustained"] if s["sustained_employer_ads"] else ""),
                  "no_ad_control_group": "YES" if r["ads"]["ad_class"] == "NO_ADS_OBSERVED" else "NO",
                  "contact_status": cr["contact_status"] if cr else "NEEDS_EVIDENCE", "personalization_tier": "", "employee_band": src[r["domain"]]["employee_band"]})
w("ranked-companies.csv", rrows, list(rrows[0].keys()))

crows = []
for r in ranked:
    cr = contact_rows.get(r["domain"])
    if not cr or cr["contact_status"] != "READY_FOR_REVIEW":
        continue
    b = cr["buyer"]
    crows.append({"company_name": r["company_name"], "company_domain": r["domain"], "v4_tag": tag(r), "signal_priority": r["priority"], "total_score": r["signals"]["total"],
                  "buyer_name": b["name"], "buyer_title": b["title"], "buyer_tier": cr["tier"], "email": b["email"], "email_status_source": f"GetLeads {b['email_status']}",
                  "linkedin_url": b.get("linkedin", ""), "role_start": b.get("role_start") or "", "contact_source": "GetLeads search_contacts", "contact_observed_at": RUN_DATE,
                  "employment_check": "GetLeads current_employer matches company" + ("; LinkedIn headline present" if b.get("linkedin") else "; no LinkedIn"),
                  "dedupe_status": "CHECKED (company domain + email vs ScaleLab Supabase leads)",
                  "suppression_status": "CLEAR in Supabase ScaleLab leads; global Suppression sheet NOT checked (not readable from this session) - must be checked at import",
                  "contact_status": cr["contact_status"], "review_notes": "; ".join(cr["missing"]), "alternates": "; ".join(cr["alternates"])})
w("approved-contacts.csv", crows, list(crows[0].keys()) if crows else ["company_name"])

hrows = []
for d, x in dec.items():
    if x["company_icp"] in ("HOLD", "REJECT"):
        fix = {"DUPLICATE": "Owner confirms whether this is the same organization as the historical ScaleLab record" if x["company_icp"] == "HOLD" else "None - already in ScaleLab history",
               "UNVERIFIED": "Correct company domain / accessible first-party page showing US employer-facing industrial staffing",
               "OTHER": "Owner decision on national chains/franchise locations",
               "NOT_STAFFING": "None (positive evidence of excluded business)", "NO_INDUSTRIAL_LINE": "None (positive evidence of excluded vertical)"}.get(x["icp_reason_code"], "Manual review")
        hrows.append({"level": "company", "company_name": x["company_name"], "company_domain": "" if d.startswith("(no-domain") else d.split("#")[0], "decision": x["company_icp"],
                      "reason_code": x["icp_reason_code"], "reason": x["reason"], "evidence_that_would_resolve": fix})
for r in ranked:
    d = r["domain"]; cr = contact_rows.get(d)
    if d in holds_contact:
        hrows.append({"level": "contact", "company_name": r["company_name"], "company_domain": d, "decision": "PASS company / HOLD contact", "reason_code": "NO_ELIGIBLE_BUYER",
                      "reason": holds_contact[d], "evidence_that_would_resolve": "Authorized Apollo reveal (or manual research) of a current Owner/President/CEO or VP/Director of Sales/BD with a verified business email"})
    elif cr and cr["contact_status"] != "READY_FOR_REVIEW":
        b = cr["buyer"]
        hrows.append({"level": "contact", "company_name": r["company_name"], "company_domain": d, "decision": "PASS company / HOLD contact", "reason_code": "NEEDS_EVIDENCE",
                      "reason": f"Best buyer {b['name']} ({b['title']}, {b['email']}): " + "; ".join(cr["missing"]),
                      "evidence_that_would_resolve": "Paid email verification (GetLeads verify_emails / validation) or Apollo verified email; confirm email domain belongs to the agency"})
hrows.sort(key=lambda r: (r["level"] != "contact", r["decision"], r["company_name"] or ""))
w("review-holds.csv", hrows, list(hrows[0].keys()))

json.dump({"ranked": ranked, "contacts": contact_rows, "holds_contact": holds_contact}, open(os.path.join(RUN, "stage56.json"), "w"), indent=1, default=str)
print("ICP:", Counter(x["company_icp"] for x in dec.values()))
print("reason:", Counter((x["company_icp"], x["icp_reason_code"]) for x in dec.values()))
print("priority:", Counter(r["priority"] for r in ranked), "adclass:", Counter(r["ads"]["ad_class"] for r in ranked))
print("contacts:", Counter(v["contact_status"] for v in contact_rows.values()), "no buyer:", len(holds_contact))
for r in crows: print("  READY", r["company_name"], "|", r["buyer_name"], "|", r["buyer_title"], "|", r["review_notes"][:90])
for d, v in contact_rows.items():
    if v["contact_status"] != "READY_FOR_REVIEW": print("  NEEDS", d, v["buyer"]["name"], v["missing"][:1])
for d, v in holds_contact.items(): print("  NOBUYER", d, v[:140])
