"""V4 Stage 2: build evidence packets from first-party site cache and ask Jev for the ICP gate.

Usage: python3 -I icp_gate.py <run_dir> [--only dom1,dom2] [--dry]
Reads companies.json + sitecache/; writes evidence/<domain>.json and jev_icp/<domain>.json; appends jev_usage.jsonl
Jev auth: proxy-injected network secret (Authorization: Bearer proxy-injected). Fails closed on any Jev error.
"""
import json, os, re, sys, time, datetime, urllib.request, urllib.error

RUN = sys.argv[1]
ONLY = None
DRY = "--dry" in sys.argv
if "--only" in sys.argv:
    ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(","))
TODAY = datetime.date.today().isoformat()
MODEL = "jev-1.14.0"  # pinned version (jev-latest alias currently points here)
os.makedirs(os.path.join(RUN, "evidence"), exist_ok=True)
os.makedirs(os.path.join(RUN, "jev_icp"), exist_ok=True)

IND = re.compile(r"\b(industrial|light[- ]industrial|manufactur\w*|warehous\w*|distribution|weld\w*|fabricat\w*|skilled[- ]trades?|trades?people|tradesmen|craft\w*|electricians?|millwrights?|pipe ?fitters?|plumb\w*|machinists?|cnc|maintenance tech\w*|industrial maintenance|forklift|assembl\w*|production|construction|carpent\w*|heavy equipment|shipyard|marine|oil and gas|oil & gas|steel|hvac|mechanics?|general labor|laborers?)\b", re.I)
EMP = re.compile(r"\b(employers?|clients?|our clients|businesses|companies|partner with|hiring needs|workforce (solutions|needs)|staffing (solutions|services|agency|firm|partner)|temp(orary)?[- ]to[- ]hire|contract[- ]to[- ]hire|temporary|temp staffing|contract (labor|staffing|workers)|direct[- ]hire|payroll(ing)?|request (talent|workers|staff)|need (workers|staff|help)|find talent|hire talent|place[sd]? (workers|candidates|employees))\b", re.I)
EXCL = re.compile(r"\b(nurs\w*|healthcare|health care|medical|clinical|allied health|IT staffing|software|developers?|cybersecurity|executive search|accounting|finance|attorneys?|law firm|legal|PEO|employer of record|RPO|job board|training courses?|hospitality|event staff|cannabis)\b", re.I)
GEO = re.compile(r"\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|United States|USA|U\.S\.)\b|\b[A-Z]{2} \d{5}\b")
SPEC = {"welding": r"weld", "fabrication": r"fabricat", "machining/CNC": r"\bcnc\b|machinist", "electricians": r"electrician", "millwrights": r"millwright",
        "pipefitters/plumbers": r"pipe ?fitter|plumb", "industrial maintenance": r"maintenance tech|industrial maintenance|maintenance mechanic", "manufacturing/production": r"manufactur|production|assembl",
        "light industrial": r"light[- ]industrial|general labor", "warehouse/distribution": r"warehous|distribution|forklift", "construction trades": r"construction|carpent|laborer", "heavy equipment": r"heavy equipment",
        "marine/shipyard": r"shipyard|marine", "oil and gas": r"oil (and|&) gas|petrochem|refiner", "HVAC": r"\bhvac\b"}
MODELS = {"temporary": r"\btemporary\b|\btemp staffing\b|\btemps?\b", "temp-to-hire": r"temp[- ]to[- ]hire|try before", "contract": r"contract (labor|staffing|workers|placement|employees)|contract[- ]to[- ]hire|\bcontract\b", "direct hire": r"direct[- ]hire|permanent placement"}


def lines_of(rec):
    for p in rec.get("pages", []):
        t = p.get("text") or ""
        url = p.get("final_url") or p.get("url")
        for ln in re.split(r"\n|(?<=[.!?])\s+", t):
            ln = re.sub(r"\s+", " ", ln).strip()
            if 25 <= len(ln) <= 400:
                yield url, ln


def build_evidence(c):
    path = os.path.join(RUN, "sitecache", c["domain"] + ".json")
    rec = json.load(open(path)) if os.path.exists(path) else {"pages": [], "error": "not fetched"}
    pages = [p for p in rec.get("pages", []) if p.get("text")]
    total = sum(len(p["text"]) for p in pages)
    seen, ex = set(), []
    for url, ln in lines_of(rec):
        key = ln.lower()
        if key in seen:
            continue
        i, e, x, g = bool(IND.search(ln)), bool(EMP.search(ln)), bool(EXCL.search(ln)), bool(GEO.search(ln))
        if i or e or x or g:
            seen.add(key)
            ex.append({"url": url, "excerpt": ln, "tags": [t for t, b in (("industrial", i), ("employer_facing", e), ("excluded_vertical", x), ("geo", g)) if b], "observed_at": TODAY})
    # rank: industrial+employer first, then industrial, employer, excluded, geo; cap
    def rk(z):
        t = z["tags"]
        return (0 if "industrial" in t and "employer_facing" in t else 1 if "industrial" in t else 2 if "employer_facing" in t else 3 if "excluded_vertical" in t else 4)
    ex.sort(key=rk)
    geo_only = [z for z in ex if z["tags"] == ["geo"]][:6]
    ex = [z for z in ex if z["tags"] != ["geo"]][:40] + geo_only
    # footer/contact addresses: also scan raw page text for "City, ST 12345" patterns
    for p in pages:
        for m in re.finditer(r"[A-Z][A-Za-z .'-]{2,30},? (?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]) \d{5}", p["text"]):
            ln = m.group(0).strip()
            if ln.lower() not in seen and len([z for z in ex if "address" in z["tags"]]) < 4:
                seen.add(ln.lower()); ex.append({"url": p.get("final_url") or p.get("url"), "excerpt": ln, "tags": ["geo", "address"], "observed_at": TODAY})
    alltext = " ".join(p["text"] for p in pages)
    specs = [k for k, v in SPEC.items() if re.search(v, alltext, re.I)]
    models = [k for k, v in MODELS.items() if re.search(v, alltext, re.I)]
    ev = {"domain": c["domain"], "company_name": c["company_name"], "fetch_error": rec.get("error"), "renderer": rec.get("renderer", "urllib"),
          "pages": [{"url": p.get("final_url") or p.get("url"), "title": p.get("title", "")[:150], "chars": len(p["text"])} for p in pages],
          "first_party_chars": total, "excerpts": ex, "keyword_specializations": specs, "keyword_models": models,
          "accessible": total >= 800}
    json.dump(ev, open(os.path.join(RUN, "evidence", c["domain"] + ".json"), "w"), indent=1)
    return ev


def state_for(c, ev):
    return {
        "company_record_from_vendor_database": {"name": c["company_name"], "domain": c["domain"], "hq_city": c["hq_city"], "hq_country": c["hq_country"], "industry_label": c["industry"], "employee_band": c["employee_band"],
                                                "description_vendor_text_UNVERIFIED": (c["source_desc"] or "")[:1200]},
        "first_party_website": {"pages_fetched": [{"url": p["url"], "title": p["title"]} for p in ev["pages"]][:8],
                                "excerpts": [{"url": z["url"], "text": z["excerpt"]} for z in ev["excerpts"]]},
        "note": "Only the first_party_website excerpts are first-party evidence. The vendor description is unverified database text."}


QUESTIONS = {
    "identity_match": {"type": "noul", "instructions": "Do the first_party_website pages belong to the same business as the company named in company_record_from_vendor_database (same company name or an obvious trading name of it), rather than a different, unrelated business, a parked/for-sale domain, or an empty page?"},
    "business_type": {"type": "choice", "instructions": "Based only on the first_party_website excerpts, what kind of business is this?",
        "criteria": {
            "employer_facing_staffing": "A staffing, recruiting, temporary labor or workforce-supply company that places or supplies workers to OTHER businesses (third-party employer clients).",
            "own_workforce_employer_or_contractor": "A contractor, manufacturer, industrial service provider, maintenance vendor, defense contractor or other employer that hires tradespeople for its OWN projects/teams and does not supply staff to other businesses.",
            "hr_tech_jobboard_training_marketing_consulting": "HR software, ATS, job board, training school, recruitment marketing, or HR/management consulting without actually filling positions for employer clients.",
            "peo_eor_rpo_only": "Only a PEO, employer-of-record or RPO provider.",
            "unrelated_business": "Some other kind of business entirely (e.g. law firm, car dealer, ambulance service).",
            "insufficient_evidence": "The excerpts are too thin or ambiguous to tell."}},
    "industrial_line": {"type": "choice", "instructions": "Based only on the first_party_website excerpts, does this company offer a staffing/placement service line for industrial, manufacturing, light-industrial, warehouse/distribution, construction-craft or skilled-trades workers to employer clients?",
        "criteria": {
            "substantive_industrial_line": "Yes: the website itself clearly offers industrial / manufacturing / light-industrial / warehouse / construction-trades / skilled-trades workers to employer clients as an established service line (it may also offer other verticals).",
            "mentioned_but_unclear": "Industrial or trades work is mentioned (e.g. only in job postings for candidates, or in passing) but it is unclear that it is a real service line offered to employers.",
            "excluded_vertical_only": "The website shows only excluded verticals (IT, healthcare, executive/white-collar, finance/accounting, office/admin, hospitality, legal, agriculture, cannabis) with no industrial or trades staffing line.",
            "not_applicable_or_insufficient": "The excerpts are too thin to tell, or the business is not a staffing company."}},
    "service_model": {"type": "choice", "instructions": "Based only on the first_party_website excerpts, which placement models does the company offer to employer clients?",
        "criteria": {
            "temporary_or_contract": "Temporary, contract, temp-to-hire or contract-to-hire staffing (possibly also direct hire).",
            "direct_hire_only": "Only direct-hire / permanent placement.",
            "none_or_unclear": "No placement model to employers is described, or it is unclear."}},
    "us_operations": {"type": "noul", "instructions": "Do the first_party_website excerpts show that this company operates in the United States and serves US employers (e.g. US office locations, US states or cities served)?"},
    "large_national_chain": {"type": "noul", "instructions": "Is this company a very large national staffing chain or a location of a large national franchise network (hundreds of offices nationwide), rather than an independent or regional agency?"},
}


def jev(state):
    body = json.dumps({"model": MODEL, "state": state, "questions": QUESTIONS}).encode()
    req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body, method="POST",
                                 headers={"Authorization": "Bearer proxy-injected", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 + 3 * attempt); continue
            raise RuntimeError(f"Jev HTTP {e.code}: {e.read()[:300]!r}")


if __name__ == "__main__":
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    usage_path = os.path.join(RUN, "jev_usage.jsonl")
    for c in comps:
        if c["pre_gate"] is not None:
            continue
        if ONLY and c["domain"] not in ONLY:
            continue
        ev = build_evidence(c)
        out = os.path.join(RUN, "jev_icp", c["domain"] + ".json")
        if not ev["accessible"]:
            print(c["domain"], "inaccessible", ev["first_party_chars"], ev["fetch_error"]); continue
        if os.path.exists(out):
            print(c["domain"], "cached"); continue
        st = state_for(c, ev)
        if DRY:
            print(c["domain"], "chars", len(json.dumps(st))); continue
        try:
            res = jev(st)
        except Exception as e:
            print("JEV FAILURE - stopping (fail closed):", c["domain"], e); sys.exit(2)
        json.dump(res, open(out, "w"), indent=1)
        with open(usage_path, "a") as f:
            f.write(json.dumps({"stage": "icp", "domain": c["domain"], "model": res.get("model"), "usage": res.get("usage")}) + "\n")
        a = res["answers"]
        print(c["domain"], res.get("model"), res.get("usage"), {k: (v.get("choice") or round(v.get("noul", 0), 2)) for k, v in a.items()})
