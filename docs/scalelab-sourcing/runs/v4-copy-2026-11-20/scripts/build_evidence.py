"""Builds the V4 copy evidence file from the sourcing runs' stored evidence. No network, no paid calls.

Usage: python3 -I build_evidence.py <scratchpad_root> <master_csv> <out_json>

Per lead it records only what the runs actually captured:
  employerAds   every classified ad (Adyntel text, Jev employer-facing probability, current flag, last seen)
  candidateAds  current job ads where the role and location are quoted in the ad text (table below)
  specialization  a category phrase supported by a quoted first-party excerpt (rules below)
  salesHiring / expansion / leadership  empty: those signals were never searched in V4 sourcing
The variant itself is selected by integrations/staffing-v4-copy.js, not here.
"""
import csv, json, re, sys

ROOT, MASTER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
AS_OF = "2026-11-20"

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
    n = re.sub(r",?\s+(?:Inc\.?|INC\.?|LLC\.?|L\.L\.C\.|Corp\.?)$", "", n.strip()).strip().rstrip(",")
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


rows = list(csv.DictReader(open(MASTER)))
decisions, ads, scores, pilot_ads = {}, {}, {}, {}
for run in ("w1", "v4run", "v4run_p2"):
    for x in load(f"{ROOT}/{run}/icp_decisions.json") or []:
        if x.get("company_icp") == "PASS":
            decisions[x["domain"]] = x
w1_ads = load(f"{ROOT}/w1/ad_classification.json")
w1_scores = load(f"{ROOT}/w1/scores.json")
for run in ("v4run", "v4run_p2"):
    pilot_ads.update(load(f"{ROOT}/{run}/ad_classification.json"))

out = []
for r in rows:
    d = r["company_domain"]
    dec = decisions[d]
    emp, cand = [], []
    for a in (w1_ads.get(d) or {}).get("ads", []):
        emp.append({"platform": a["platform"], "url": a.get("url") or "", "text": a["text"], "current": bool(a["current"]),
                    "employerFacingP": a.get("employer_p"), "lastSeen": day(a.get("last_seen")), "start": day(a.get("start"))})
    attribution = ((w1_scores.get(d) or {}).get("ads") or {}).get("attribution_p")
    if d in CANDIDATE_ADS:
        spec = CANDIDATE_ADS[d]
        pool = [(a.get("text") or "", a) for a in (w1_ads.get(d) or {}).get("ads", [])]
        pool += [(((a.get("title") or "") + " | " + (a.get("text") or "")), a) for a in (pilot_ads.get(d) or {}).get("ads", [])]
        for text, a in pool:
            if spec["match"].lower() in text.lower():
                last = day(a.get("last_seen") or a.get("end"))
                current = bool(a.get("current") if "current" in a else a.get("active"))
                cand.append({"url": a.get("url") or a.get("landing") or a.get("library_url") or "", "quote": text[:400], "role": spec["role"],
                             "location": spec["location"], "current": current, "lastSeen": last})
                break
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
            "signalsNotSearched": ["own_company_bd_hiring", "market_expansion", "new_commercial_leader"],
        },
    })
json.dump(out, open(OUT, "w"), indent=1)
print(len(out), "leads written")
