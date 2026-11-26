"""Insurance pilot, agency side: Jev ICP gate for commercial / WC insurance agencies (ScaleLab's client), with the
deep-dive ICP (segments/insurance-deep-dive-2026-11-26.md, section 3). The staffing gate (qualify.py / icp_decide.py)
is not touched; this reuses the crawl cache format and the shared Jev budget (jevlib.Budget, V4_JEV_BUDGET_USD).

Usage: V4_JEV_BUDGET_USD=<cap> python3 -I agency_gate.py <agency_dir>
Reads <dir>/companies.json + <dir>/sitecache/ (+ pwcache/ merged). One Jev request per readable site, cached in
<dir>/jev_icp/<domain>.json. Fail closed: a Jev error stops the run (exit 2); no substitute model.
Writes <dir>/icp_decisions.json (PASS / HOLD / REJECT + reason code) and prints counts.
"""
import collections
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
T = {"identity": 0.7, "identity_conflict": 0.5, "type": 0.7, "commercial": 0.7, "texas": 0.7, "big": 0.5, "reject": 0.8, "focus": 0.6}
INS = re.compile(r"(?i)\b(commercial (insurance|lines|auto|property|package)|business insurance|workers'? ?comp\w*|general liability|"
                 r"surety|bonds?|contractors?|construction|manufactur\w*|trucking|transportation|fleet|warehouse|oil (and|&) gas|energy|"
                 r"independent (insurance )?(agency|agent)|we represent|carriers?|insurance companies we|personal (lines|insurance)|"
                 r"auto (and|&) home|home insurance|life insurance|health insurance|medicare|employee benefits|captive|exclusive agent|"
                 r"licensed in|serving (texas|the state)|texas|houston|dallas|fort worth|san antonio|austin|el paso|lubbock|midland|odessa|"
                 r"risk management|loss control|safety|experience mod|x-?mod|claims)\b")
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
    return {"chars": total, "accessible": total >= 800, "error": rec.get("error"), "pages": titles, "excerpts": ex[:45]}


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
    "texas_presence": {"type": "noul", "instructions": "Do the excerpts show the agency has an office in Texas or serves Texas clients (Texas city or address, 'licensed in Texas', or similar)?"},
    "large_national_broker": {"type": "noul", "instructions": "Is this a very large national or international brokerage, or a local office of one (or of a private-equity agency platform with many acquired agencies), rather than an independent locally owned agency?"},
}


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
         "manufacturing": round(p(a, "focus_manufacturing"), 3), "trucking": round(p(a, "focus_trucking"), 3),
         "texas": round(p(a, "texas_presence"), 3), "big": round(p(a, "large_national_broker"), 3)}
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
        why.append(f"Texas presence not shown (p={j['texas']})")
    if j["big"] >= T["big"]:
        why.append(f"possible platform / large broker office (p={j['big']})")
    if not why:
        focus = max(j["wc"], j["construction"], j["manufacturing"], j["trucking"])
        if focus >= T["focus"]:
            return "PASS", "VERIFIED_COMMERCIAL_AGENCY", "independent Texas agency with core commercial lines and WC / industry focus", j
        return "HOLD", "NO_INDUSTRY_FOCUS", f"commercial agency but no WC or construction / manufacturing / trucking focus shown (max p={focus})", j
    return "HOLD", "UNVERIFIED", "; ".join(why), j


def main():
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    os.makedirs(os.path.join(RUN, "jev_icp"), exist_ok=True)
    merge_pw()
    budget = jevlib.Budget(RUN)
    out, stats = [], collections.Counter()
    for c in comps:
        ev = evidence(c)
        res = None
        cache = os.path.join(RUN, "jev_icp", c["domain"] + ".json")
        if ev["accessible"]:
            if os.path.exists(cache):
                res = json.load(open(cache))
            else:
                if not budget.reserve(6000):
                    print("BUDGET STOP before", c["domain"]); break
                try:
                    res = jevlib.ask(state_for(c, ev), QUESTIONS)
                except Exception as e:
                    print("JEV FAILURE - fail closed:", c["domain"], e); sys.exit(2)
                budget.settle(6000, res.get("usage"), "insurance_agency_gate", c["domain"], res.get("model"))
                json.dump(res, open(cache, "w"), indent=1)
        dec, code, reason, j = decide(c, ev, res)
        stats[(dec, code)] += 1
        out.append({"domain": c["domain"], "company_name": c["company_name"], "decision": dec, "reason_code": code, "reason": reason,
                    "jev": j, "jev_model": (res or {}).get("model"), "site_chars": ev["chars"]})
    json.dump(out, open(os.path.join(RUN, "icp_decisions.json"), "w"), indent=1)
    print(json.dumps({f"{k[0]}:{k[1]}": v for k, v in stats.most_common()}, indent=1))
    print("jev_spent_usd", round(budget.ledger_usd(), 5), "cap", v4config.JEV_BUDGET_USD)


if __name__ == "__main__":
    main()
