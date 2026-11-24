"""Builds the V4 copy evidence file from the sourcing runs' stored evidence. No network, no paid calls.

Usage: python3 -I build_evidence.py <master_csv> <out_json> <run_dir> [<run_dir> ...]

Each <run_dir> is a sourcing run's working folder (icp_decisions.json, ad_classification.json,
scores.json). Pass every run whose leads appear in the master; later runs win on a repeated domain.
The evidence date is V4_RUN_DATE (v4config).

Per lead it records only what the runs actually captured:
  employerAds   every classified ad (Adyntel text, Jev employer-facing probability, current flag, last seen)
  candidateAds  current job ads where the role and location are quoted in the ad text (table below)
  specialization  a category phrase supported by a quoted first-party excerpt (rules below)
  salesHiring / expansion / leadership  empty: those signals were never searched in V4 sourcing
  specialtyLine  copy v2 COPY_C primary: "<roles> for <client type>" from one first-party excerpt (copy_v2_evidence.py)
  candidateAds   also the agency's own job postings within 30 days, when <run_dir>/job_postings.json exists
                 (copy v2 COPY_B: most common hands-on title, singular, and its most common "City, ST")
The variant itself is selected by integrations/staffing-v4-copy.js, not here.
"""
import csv, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402
import copy_v2_evidence  # noqa: E402

MASTER, OUT, RUNS = sys.argv[1], sys.argv[2], sys.argv[3:]
if not RUNS:
    raise SystemExit("pass at least one run directory")
AS_OF = v4config.RUN_DATE

# Candidate ads whose text names a role and a location (read from the stored ad text; the
# selector re-checks that both appear in the quote, so nothing here can add a fact).
CANDIDATE_ADS = {
    "kpstaffing.com": dict(match="hiring assemblers for manufacturing facilities in Fort Wort", role="assembler", location="Fort Worth, TX"),
    "progroupstaffing.com": dict(match="Insert Operator", role="insert operator", location="Plano, TX"),
    "prtstaffing.com": dict(match="Low Voltage Electricians", role="low voltage electrician", location="Santa Teresa, NM"),
}

TRADES = re.compile(r"skilled[ -]trade|skilled craft|tradespeople|\bwelders?\b|\bwelding\b|electricians?|millwrights?|pipefitters?|plumbers?|carpenters?|\bhvac\b|machinists?|construction (?:trades|workers|labor|staffing|craft)", re.I)
LIGHT = re.compile(r"light industrial|warehouse|manufactur|production work|assembl|forklift", re.I)
INDUSTRIAL = re.compile(r"\bindustrial\b", re.I)


def load(path):
    try:
        return json.load(open(path))
    except FileNotFoundError:
        return {}


def day(v):
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) or str(v).isdigit():
        import datetime
        return datetime.datetime.fromtimestamp(int(v), datetime.timezone.utc).date().isoformat()
    return str(v)[:10]


def display_name(name):
    n = re.split(r"\s+\(|,\s+a\s+|,\s+formerly\s+|\s+-\s+|,\s+Personnel Response", name)[0]
    n = re.sub(r"\s*/.*$", "", n)  # "ACT Staffing /actstaffing.com" -> "ACT Staffing"
    n = re.sub(r",?\s+(?:Inc\.?|INC\.?|LLC\.?|L\.L\.C\.|Corp\.?)(?:\s+[A-Z][a-z]+)?$", "", n.strip()).strip().rstrip(",")  # also "Inc. Iowa"
    # Brand casing is kept as sourced (AMMON, FINITETEK, MAXUM); only the
    # lower-cased initialism "Hl" is restored. The preview flags every change.
    return " ".join("HL" if w == "Hl" else w for w in n.split())


def specialization(dec):
    ev = dec.get("icp_evidence", [])
    hit = lambda rx: next((e for e in ev if rx.search(e["excerpt"])), None)
    t, l, i = hit(TRADES), hit(LIGHT), hit(INDUSTRIAL)
    if t and l:
        return {"phrase": "skilled trades and light industrial", "url": t["url"], "quote": t["excerpt"], "url2": l["url"], "quote2": l["excerpt"]}
    if t:
        return {"phrase": "skilled trades", "url": t["url"], "quote": t["excerpt"]}
    if l:
        return {"phrase": "light industrial", "url": l["url"], "quote": l["excerpt"]}
    if i:
        return {"phrase": "industrial", "url": i["url"], "quote": i["excerpt"]}
    return None


def normalize_ad(a):
    """One shape for both stored ad formats: classified (text/current/last_seen/url, from ads_score.py)
    and raw Adyntel Meta/LinkedIn records (title/text/active/end/landing)."""
    text = a.get("text") or ""
    if a.get("title") and a.get("title") not in text:
        text = f"{a['title']} | {text}"
    current = a["current"] if "current" in a else a.get("active")
    return {"platform": a.get("platform") or "", "url": a.get("url") or a.get("landing") or a.get("library_url") or "",
            "text": text, "current": bool(current), "employerFacingP": a.get("employer_p"),
            "lastSeen": day(a.get("last_seen") or a.get("end")), "start": day(a.get("start"))}


rows = list(csv.DictReader(open(MASTER)))
decisions, run_ads, run_scores, run_postings = {}, {}, {}, {}
for run in RUNS:
    for x in load(f"{run}/icp_decisions.json") or []:
        if x.get("company_icp") == "PASS":
            decisions[x["domain"]] = x
    run_ads.update(load(f"{run}/ad_classification.json") or {})
    run_scores.update(load(f"{run}/scores.json") or {})
    run_postings.update(load(f"{run}/job_postings.json") or {})

out = []
for r in rows:
    d = r["company_domain"]
    dec = decisions[d]
    emp, cand = [], []
    ads = [normalize_ad(a) for a in (run_ads.get(d) or {}).get("ads", [])]
    for a in ads:
        # Only ads Jev classified (they carry an employer-facing probability) are employer-ad evidence.
        if a["employerFacingP"] is not None:
            emp.append({k: a[k] for k in ("platform", "url", "text", "current", "employerFacingP", "lastSeen", "start")})
    attribution = ((run_scores.get(d) or {}).get("ads") or {}).get("attribution_p")
    if d in CANDIDATE_ADS:
        spec = CANDIDATE_ADS[d]
        for a in ads:
            if spec["match"].lower() in a["text"].lower():
                cand.append({"url": a["url"], "quote": a["text"][:400], "role": spec["role"], "location": spec["location"],
                             "current": a["current"], "lastSeen": a["lastSeen"]})
                break
    # Copy v2 COPY_B: the agency's own postings (after any hand-listed candidate ad, which keeps priority).
    posting = copy_v2_evidence.posting_candidate(run_postings.get(d), AS_OF)
    if posting:
        cand.append(posting)
    buyer = r["buyer_name"].split()
    out.append({
        "row": {k: r[k] for k in ("wave", "company_name", "company_domain", "buyer_title", "email", "email_status", "catch_all", "mail_gateway",
                                  "demand_score", "signal_priority", "ad_class", "v4_tag", "copy_tier", "contact_status", "qc_flags",
                                  "dedupe_status", "suppression_status")},
        "evidence": {
            "asOf": AS_OF, "firstName": buyer[0] if buyer else "", "contactName": r["buyer_name"],
            "company": display_name(r["company_name"]), "contactStatus": r["contact_status"],
            "emailResolved": bool(r["email"].strip()), "attributionP": attribution,
            "employerAds": emp, "candidateAds": cand, "salesHiring": [], "expansion": [], "leadership": [],
            "specialization": specialization(dec),
            "specialtyLine": copy_v2_evidence.specialty_line(dec),
            "signalsNotSearched": ["own_company_bd_hiring", "market_expansion", "new_commercial_leader"],
        },
    })
json.dump(out, open(OUT, "w"), indent=1)
print(len(out), "leads written")
