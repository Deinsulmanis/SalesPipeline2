"""Insurance pilot, agency side: Jev ICP gate for commercial / WC insurance agencies (ScaleLab's client), with the
deep-dive ICP (segments/insurance-deep-dive-2026-11-26.md, section 3). The staffing gate (qualify.py / icp_decide.py)
is not touched; this reuses the crawl cache format and the shared Jev budget (jevlib.Budget, V4_JEV_BUDGET_USD).

Usage: V4_JEV_BUDGET_USD=<cap> python3 -I agency_gate.py <agency_dir> [--only @domains.json]
Reads <dir>/companies.json + <dir>/sitecache/ (+ pwcache/ merged). A company with pre_gate "DECISION/CODE: why" (set before
the crawl by dedupe or name exclusions) is recorded as decided by code, without a Jev call. One Jev request per readable site, cached in
<dir>/jev_icp/<domain>.json. Fail closed: a Jev error stops the run (exit 2); no substitute model.
Writes <dir>/icp_decisions.json (PASS / HOLD / REJECT + reason code) and prints counts.
"""
import collections
import concurrent.futures as cf
import threading
import json
import os
import re
import sys

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevlib  # noqa: E402
import v4config  # noqa: E402
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
# State whose presence the gate checks (key stays "texas_presence" for cache compatibility). INS_STATE=Oregon for Oregon.
STATE = os.environ.get("INS_STATE") or "Texas"
ABBR = {"Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT",
        "Delaware": "DE", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
        "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
        "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
        "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
        "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
        "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"}
STATE_ABBR = ABBR[STATE]  # office-address fields keep their tx_* names for compatibility
# Cohort B (INS_COHORT=B): each company carries its own "state"; industry focus ranks instead of filtering (owner brief
# 2026-11-27), so a commercial agency with no named industry focus passes as COMMERCIAL_AGENCY; two extra questions.
COHORT = os.environ.get("INS_COHORT") or "A"


def state_of(c):
    return c.get("state") or STATE
T = {"identity": 0.7, "identity_conflict": 0.5, "type": 0.7, "commercial": 0.7, "texas": 0.7, "big": 0.5, "reject": 0.8, "focus": 0.6}
INS = re.compile(r"(?i)\b(commercial (insurance|lines|auto|property|package)|business insurance|workers'? ?comp\w*|general liability|"
                 r"surety|bonds?|contractors?|construction|manufactur\w*|trucking|transportation|fleet|warehouse|oil (and|&) gas|energy|"
                 r"independent (insurance )?(agency|agent)|we represent|carriers?|insurance companies we|personal (lines|insurance)|"
                 r"auto (and|&) home|home insurance|life insurance|health insurance|medicare|employee benefits|captive|exclusive agent|"
                 r"licensed in|serving (texas|the state)|texas|houston|dallas|fort worth|san antonio|austin|el paso|lubbock|midland|odessa|"
                 r"risk management|loss control|safety|experience mod|x-?mod|claims)\b")
ADDR = re.compile(r"([A-Z][A-Za-z .'-]{2,25}),? (A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]) (\d{5})")
COMMERCIAL = re.compile(r"(?i)commercial|business insurance|workers'? ?comp|general liability|contractor|trucking|surety")
SKIP_TXT = re.compile(r"(?i)cookie|privacy policy|all rights reserved|javascript")


def merge_pw():
    pw = os.path.join(RUN, "pwcache")
    if not os.path.isdir(pw):
        return
    for f in os.listdir(pw):
        a_path = os.path.join(RUN, "sitecache", f)
        try:
            b = json.load(open(os.path.join(pw, f)))
            a = json.load(open(a_path)) if os.path.exists(a_path) else {"pages": []}
        except ValueError:
            continue
        if sum(len(p.get("text") or "") for p in b["pages"]) > sum(len(p.get("text") or "") for p in a["pages"]):
            json.dump(b, open(a_path, "w"))


def evidence(c):
    abbr = ABBR[state_of(c)]
    path = os.path.join(RUN, "sitecache", c["domain"] + ".json")
    rec = json.load(open(path)) if os.path.exists(path) else {"pages": [], "error": "not fetched"}
    pages = [p for p in rec.get("pages", []) if p.get("text")]
    total = sum(len(p["text"]) for p in pages)
    seen, ex = set(), []
    for p in pages:
        url = p.get("final_url") or p.get("url")
        for ln in re.split(r"\n|(?<=[.!?])\s+", p["text"]):
            ln = re.sub(r"\s+", " ", ln).strip()
            if 20 <= len(ln) <= 350 and INS.search(ln) and not SKIP_TXT.search(ln) and ln.lower() not in seen:
                seen.add(ln.lower())
                ex.append({"url": url, "text": ln})
    titles = [{"url": p.get("final_url") or p.get("url"), "title": (p.get("title") or "")[:140]} for p in pages][:9]
    offices = {}
    for p in pages:
        for m in ADDR.finditer(p["text"]):
            offices.setdefault((m.group(1).strip().lower(), m.group(2)), (m.group(1).strip(), m.group(2), m.group(3)))
    tx = [o for o in offices.values() if o[1] == abbr]
    best = next((z["url"] for z in ex if COMMERCIAL.search(z["text"])), ex[0]["url"] if ex else (titles[0]["url"] if titles else None))
    return {"chars": total, "accessible": total >= 800, "error": rec.get("error"), "pages": titles, "excerpts": ex[:45],
            "office_count": len(offices), "tx_office_count": len(tx), "tx_cities": sorted({o[0] for o in tx})[:6],
            "states": sorted({o[1] for o in offices.values()}), "evidence_url": best}


QUESTIONS = {
    "identity_match": {"type": "noul", "instructions": "Do the first_party_website pages belong to the business named in company_record (same name or an obvious trading name), rather than an unrelated business, a parked domain or an empty page?"},
    "business_type": {"type": "choice", "instructions": "Based only on the first_party_website excerpts, what kind of business is this?", "criteria": {
        "independent_retail_agency": "An independent insurance agency or retail broker that represents several insurance companies (carriers) and sells policies to its own clients.",
        "captive_or_exclusive_agent": "An agent who sells for one insurance company only (e.g. a State Farm, Allstate, Farmers, Farm Bureau or similar office), or a franchise of a single-brand agency network.",
        "carrier_mga_wholesale_tpa": "An insurance company (carrier), MGA, wholesaler, program administrator, TPA, premium finance or claims adjusting firm, not a retail agency.",
        "benefits_life_health_only": "Only employee benefits, life, health or Medicare insurance; no property and casualty lines.",
        "not_insurance": "Not an insurance business.",
        "insufficient_evidence": "Too thin or ambiguous to tell."}},
    "commercial_lines": {"type": "choice", "instructions": "How central are commercial (business) property and casualty lines - business insurance, workers' compensation, general liability, commercial auto, commercial property, surety or bonds - to this agency's offering?", "criteria": {
        "core": "Commercial / business insurance is a core, clearly offered line (its own pages or a prominent service), whether or not the agency also sells personal lines.",
        "minor": "Commercial lines are mentioned but the site is clearly built around personal lines (auto, home, life).",
        "personal_only": "Only personal lines (auto, home, renters, life, health); no business insurance offered.",
        "insufficient": "Cannot tell."}},
    "writes_workers_comp": {"type": "noul", "instructions": "Does the agency offer workers' compensation insurance to businesses?"},
    "focus_construction": {"type": "noul", "instructions": "Does the agency show a focus on or programme for construction companies / contractors?"},
    "focus_manufacturing": {"type": "noul", "instructions": "Does the agency show a focus on or programme for manufacturers or industrial businesses?"},
    "focus_trucking": {"type": "noul", "instructions": "Does the agency show a focus on or programme for trucking, transportation, fleets or logistics businesses?"},
    "focus_oil_gas": {"type": "noul", "instructions": "Does the agency show a focus on or programme for oil and gas / oilfield / energy businesses?"},
    "texas_presence": {"type": "noul", "instructions": f"Do the excerpts show the agency has an office in {STATE} or serves {STATE} clients ({STATE} city or address, 'licensed in {STATE}', or similar)?"},
    "large_national_broker": {"type": "noul", "instructions": "Is this a very large national or international brokerage, or a local office of one (or of a private-equity agency platform with many acquired agencies), rather than an independent locally owned agency?"},
}
B_QUESTIONS = {
    "focus_warehousing": {"type": "noul", "instructions": "Does the agency show a focus on or programme for warehousing, distribution or logistics facilities?"},
    "wc_expertise": {"type": "noul", "instructions": "Does the agency show workers' compensation expertise beyond simply offering it, such as experience mods, class codes, safety programs, loss control or return-to-work help?"},
}


def questions_for(c):
    st = state_of(c)
    q = dict(QUESTIONS)
    q["texas_presence"] = {"type": "noul", "instructions": f"Do the excerpts show the agency has an office in {st} or serves {st} clients ({st} city or address, 'licensed in {st}', or similar)?"}
    if COHORT == "B":
        q.update(B_QUESTIONS)
    return q


def state_for(c, ev):
    return {"company_record": {"name": c["company_name"], "domain": c["domain"], "vendor_employee_band_UNVERIFIED": c.get("employee_band"),
                               "discovery_tags": c.get("groups")},
            "first_party_website": {"pages_fetched": ev["pages"], "excerpts": ev["excerpts"]},
            "note": "Only the first_party_website excerpts are first-party evidence."}


def p(a, k, opt=None):
    x = a[k]
    return x["noul"] if x["type"] == "noul" else x["probabilities"].get(opt, 0.0)


def decide(c, ev, res):
    if not ev["accessible"] or res is None:
        return "HOLD", "UNVERIFIED", f"first-party site not readable ({ev['error'] or str(ev['chars']) + ' chars'})", {}
    a = res["answers"]
    j = {"identity": round(p(a, "identity_match"), 3), "type": a["business_type"]["choice"], "type_p": round(max(a["business_type"]["probabilities"].values()), 3),
         "commercial": a["commercial_lines"]["choice"], "commercial_p": round(max(a["commercial_lines"]["probabilities"].values()), 3),
         "wc": round(p(a, "writes_workers_comp"), 3), "construction": round(p(a, "focus_construction"), 3),
         "manufacturing": round(p(a, "focus_manufacturing"), 3), "trucking": round(p(a, "focus_trucking"), 3), "oil_gas": round(p(a, "focus_oil_gas"), 3) if "focus_oil_gas" in a else None,
         "texas": round(p(a, "texas_presence"), 3), "big": round(p(a, "large_national_broker"), 3),
         "warehousing": round(p(a, "focus_warehousing"), 3) if "focus_warehousing" in a else None,
         "wc_expertise": round(p(a, "wc_expertise"), 3) if "wc_expertise" in a else None}
    STATE = state_of(c)
    if j["identity"] < T["identity_conflict"]:
        return "HOLD", "UNVERIFIED", f"identity conflict (p={j['identity']})", j
    if j["identity"] >= T["identity"] and j["type_p"] >= T["reject"]:
        code = {"captive_or_exclusive_agent": "CAPTIVE", "carrier_mga_wholesale_tpa": "NOT_RETAIL_AGENCY",
                "benefits_life_health_only": "NO_PC_LINES", "not_insurance": "NOT_INSURANCE"}.get(j["type"])
        if code:
            return "REJECT", code, f"site shows {j['type'].replace('_', ' ')} (p={j['type_p']})", j
    if j["identity"] >= T["identity"] and j["commercial"] == "personal_only" and j["commercial_p"] >= T["reject"]:
        return "REJECT", "PERSONAL_LINES_ONLY", f"personal lines only (p={j['commercial_p']})", j
    if j["big"] >= T["reject"]:
        return "REJECT", "MEGA_BROKER", f"large national broker / platform office (p={j['big']})", j
    why = []
    if j["identity"] < T["identity"]:
        why.append(f"identity weak (p={j['identity']})")
    if not (j["type"] == "independent_retail_agency" and j["type_p"] >= T["type"]):
        why.append(f"independent agency not established ({j['type']}, p={j['type_p']})")
    if not (j["commercial"] == "core" and j["commercial_p"] >= T["commercial"]):
        why.append(f"commercial lines not core ({j['commercial']}, p={j['commercial_p']})")
    if j["texas"] < T["texas"]:
        why.append(f"{STATE} presence not shown (p={j['texas']})")
    if j["big"] >= T["big"]:
        why.append(f"possible platform / large broker office (p={j['big']})")
    if not why:
        focus = max(j["wc"], j["construction"], j["manufacturing"], j["trucking"], j.get("oil_gas") or 0, j.get("warehousing") or 0)
        if focus >= T["focus"]:
            return "PASS", "VERIFIED_COMMERCIAL_AGENCY", f"independent {STATE} agency with core commercial lines and WC / industry focus", j
        if COHORT == "B":
            return "PASS", "COMMERCIAL_AGENCY", f"independent {STATE} agency with core commercial lines (no industry focus named; ranks lower)", j
        return "HOLD", "NO_INDUSTRY_FOCUS", f"commercial agency but no WC or construction / manufacturing / trucking / oil and gas focus shown (max p={focus})", j
    return "HOLD", "UNVERIFIED", "; ".join(why), j


def main():
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    only = None
    if "--only" in sys.argv:  # --only @domains.json: judge readable sites first, thin ones after the headless retry
        arg = sys.argv[sys.argv.index("--only") + 1]
        only = set(json.load(open(arg[1:])) if arg.startswith("@") else arg.split(","))
    os.makedirs(os.path.join(RUN, "jev_icp"), exist_ok=True)
    merge_pw()
    budget = jevlib.Budget(RUN)
    # Phase 1: Jev calls for readable, uncached sites, 6 at a time (shared, locked run budget; fail closed).
    todo = []
    for c in comps:
        if c.get("pre_gate") or (only is not None and c["domain"] not in only):
            continue
        cache = os.path.join(RUN, "jev_icp", c["domain"] + ".json")
        if not os.path.exists(cache):
            ev = evidence(c)
            if ev["accessible"]:
                todo.append((c, ev, cache))
    stop = threading.Event()
    failures = []

    def ask_one(item):
        c, ev, cache = item
        if stop.is_set():
            return
        if not budget.reserve(6000):
            stop.set()
            print("BUDGET STOP before", c["domain"], flush=True)
            return
        try:
            res = jevlib.ask(state_for(c, ev), questions_for(c))
        except Exception as e:
            failures.append((c["domain"], str(e)))
            stop.set()
            return
        budget.settle(6000, res.get("usage"), "insurance_agency_gate", c["domain"], res.get("model"))
        json.dump(res, open(cache, "w"), indent=1)

    with cf.ThreadPoolExecutor(6) as ex:
        list(ex.map(ask_one, todo))
    if failures:
        print("JEV FAILURE - fail closed:", failures[:3])
        sys.exit(2)
    out, stats = [], collections.Counter()
    for c in comps:
        if c.get("pre_gate"):
            dec, code = c["pre_gate"].split(":", 1)[0].split("/")
            stats[(dec, code)] += 1
            out.append({"domain": c["domain"], "company_name": c["company_name"], "decision": dec, "reason_code": code,
                        "reason": c.get("pre_reason") or code, "jev": {}, "jev_model": None, "site_chars": 0, "decided_by": "code (before crawl)"})
            continue
        if only is not None and c["domain"] not in only:
            continue
        ev = evidence(c)
        res = None
        cache = os.path.join(RUN, "jev_icp", c["domain"] + ".json")
        if ev["accessible"] and os.path.exists(cache):
            res = json.load(open(cache))
        dec, code, reason, j = decide(c, ev, res)
        if ev["accessible"] and res is None:
            dec, code, reason = "HOLD", "NOT_JUDGED", "readable site not judged (Jev budget stop)"
        stats[(dec, code)] += 1
        spec = [k for k in ("wc", "construction", "manufacturing", "trucking", "oil_gas") if (j.get(k) or 0) >= T["focus"]]
        out.append({"domain": c["domain"], "company_name": c["company_name"], "decision": dec, "reason_code": code, "reason": reason,
                    "jev": j, "jev_model": (res or {}).get("model"), "site_chars": ev["chars"], "decided_by": "Jev answers + code thresholds",
                    "specialties": spec, "wc_focus": (j.get("wc") or 0) >= T["focus"], "office_count": ev.get("office_count", 0),
                    "tx_office_count": ev.get("tx_office_count", 0), "tx_cities": ev.get("tx_cities", []), "states": ev.get("states", []),
                    "evidence_url": ev.get("evidence_url"), "sources": c.get("groups"), "state": state_of(c),
                    "writes_trucking": "Y" if (j.get("trucking") or 0) >= T["focus"] else "N",
                    "writes_contractors": "Y" if (j.get("construction") or 0) >= T["focus"] else "N",
                    "writes_manufacturing": "Y" if (j.get("manufacturing") or 0) >= T["focus"] else "N",
                    "writes_warehousing": "Y" if (j.get("warehousing") or 0) >= T["focus"] else "N",
                    "wc_expertise": "Y" if (j.get("wc_expertise") or 0) >= T["focus"] else "N"})
    if only is not None:  # a partial pass never overwrites the full decision file
        json.dump(out, open(os.path.join(RUN, "icp_decisions_partial.json"), "w"), indent=1)
    else:
        json.dump(out, open(os.path.join(RUN, "icp_decisions.json"), "w"), indent=1)
    print(json.dumps({f"{k[0]}:{k[1]}": v for k, v in stats.most_common()}, indent=1))
    print("jev_spent_usd", round(budget.ledger_usd(), 5), "cap", v4config.JEV_BUDGET_USD)


if __name__ == "__main__":
    main()
