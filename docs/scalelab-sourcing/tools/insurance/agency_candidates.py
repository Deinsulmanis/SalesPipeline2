"""Insurance agencies (full state run): merge discovery into one companies.json for the crawl + agency_gate.py.

Usage: python3 -I agency_candidates.py <run_dir> [--pilot <pilot_agency_dir>]
Reads:
  <run>/disc/*.txt            free Apollo organization lookups: domain|name|apollo_id|group|page
  <run>/disc_jobs/*.txt       (optional) GetLeads job-posting companies in the state: domain|name|slug|JOBS|city
  <run>/exclude_domains.json  {domain: why}: production (every client) and any earlier exclusion set
  --pilot <dir>               earlier gate (icp_decisions.json + sitecache/): REJECTs are carried as decided; PASS and
                              HOLD agencies are re-gated, and their crawl cache is copied in so they are not refetched
Writes <run>/companies.json (pre_gate "DECISION/CODE: why" for code decisions, else null) and
<run>/candidates_summary.json (counts only). Exclusions follow ins_config (deep-dive ICP section 3).
"""
import collections, glob, json, os, re, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
PILOT = sys.argv[sys.argv.index("--pilot") + 1] if "--pilot" in sys.argv else None
INSURANCE_WORD = re.compile(r"(?i)insur|agency|assurance|risk|underwrit|brokers?|benefits|indemnity|surety|bonding")
LIFE_HEALTH = re.compile(r"(?i)\b(medicare|final expense|health insurance|life insurance|senior (benefits|insurance)|annuit\w*|dental|vision)\b")
PC_WORD = re.compile(r"(?i)\b(casualty|property|commercial|business|auto|home|general|p ?& ?c|risk|agency group)\b")
NOT_AGENCY_NAME = re.compile(r"(?i)\b(bank|credit union|church|school|university|hospital|clinic|staffing|realty|real estate|mortgage|"
                             r"tax service|cpa|law firm|attorneys?|marketing agency|software|title (company|insurance)|warranty)\b")


def clean_domain(d):
    d = re.sub(r"^https?:/*", "", (d or "").strip().lower()).removeprefix("www.").split("/")[0]
    return None if d in ("", "none") or "." not in d or not re.fullmatch(r"[a-z0-9.-]+", d) else d


def name_exclusion(name, dom):
    n = (name or "").lower()
    if any(b in n or b in dom for b in ("goosehead", "brightway")):
        return "HOLD/FRANCHISE", "franchise agency network (owner rule: HOLD)"
    if any(b in n or b.replace(" ", "").replace("-", "") in dom for b in C.CAPTIVE_BRANDS):
        return "REJECT/CAPTIVE", "captive or single-carrier brand in the name or domain"
    if any(re.search(r"\b" + re.escape(b) + r"\b", n) or b.replace(" ", "").replace("&", "") == dom.split(".")[0] for b in C.MEGA_BROKERS):
        return "REJECT/MEGA_BROKER", "mega broker or agency platform by name"
    if C.NOT_RETAIL.search(n):
        return "REJECT/NOT_RETAIL_AGENCY", "wholesale / MGA / carrier / TPA / adjuster by name"
    if NOT_AGENCY_NAME.search(n):
        return "REJECT/NOT_INSURANCE", "not a retail insurance agency by name"
    if LIFE_HEALTH.search(n) and not PC_WORD.search(n):
        return "REJECT/NO_PC_LINES", "life / health / Medicare name with no property-casualty word"
    return None, None


def main():
    excl = json.load(open(os.path.join(RUN, "exclude_domains.json")))
    rows, raw, no_dom, by_group_raw = {}, 0, set(), collections.Counter()
    for f in sorted(glob.glob(os.path.join(RUN, "disc", "*.txt")) + glob.glob(os.path.join(RUN, "disc_jobs", "*.txt"))):
        for ln in open(f, errors="replace"):
            p = ln.rstrip("\n").split("|")
            if len(p) < 4:
                continue
            raw += 1
            by_group_raw[p[3]] += 1
            dom = clean_domain(p[0])
            if p[3] == "JOBS" and not INSURANCE_WORD.search(p[1]):
                continue  # a job-posting company that is not an insurance business by name
            if not dom:
                no_dom.add(p[2] or p[1])
                continue
            r = rows.setdefault(dom, {"domain": dom, "company_name": p[1], "source_id": p[2], "groups": set(), "state": None})
            r["groups"].add(p[3])
            if len(p) >= 6 and p[-1] and not r["state"]:  # Cohort B lines carry the HQ state (last field)
                r["state"] = p[-1]
    pilot_dec = {}
    if PILOT:
        for d in json.load(open(os.path.join(PILOT, "icp_decisions.json"))):
            pilot_dec[d["domain"]] = d
            r = rows.setdefault(d["domain"], {"domain": d["domain"], "company_name": d["company_name"], "source_id": None, "groups": set()})
            r["groups"].add("PILOT")
        os.makedirs(os.path.join(RUN, "sitecache"), exist_ok=True)
        for sub in ("sitecache", "pwcache"):
            for f in glob.glob(os.path.join(PILOT, sub, "*.json")):
                dst = os.path.join(RUN, sub, os.path.basename(f))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if not os.path.exists(dst):
                    shutil.copy2(f, dst)
    comps, stats = [], collections.Counter()
    for dom, r in sorted(rows.items()):
        pre, why = None, None
        if dom in excl:
            pre, why = "REJECT/DUPLICATE", f"already known: {excl[dom]}"
        elif dom in pilot_dec and pilot_dec[dom]["decision"] == "REJECT":
            pre, why = f"REJECT/{pilot_dec[dom]['reason_code']}", "pilot gate (2026-11-26): " + pilot_dec[dom]["reason"]
        else:
            pre, why = name_exclusion(r["company_name"], dom)
        stats[pre or "to_gate"] += 1
        comps.append({"domain": dom, "company_name": r["company_name"], "source_id": r["source_id"], "groups": sorted(r["groups"]),
                      "pre_gate": f"{pre}: {why}" if pre else None, "pre_reason": why, "hq_city": None, "hq_country": "United States",
                      "industry": "Insurance", "employee_band": "1-50", "source_desc": "",
                      "pilot_decision": (pilot_dec.get(dom) or {}).get("decision"), "state": r.get("state")})
    json.dump(comps, open(os.path.join(RUN, "companies.json"), "w"), indent=1)
    summ = {"raw_lines": raw, "raw_by_group": dict(by_group_raw), "unique_domains": len(rows), "no_domain_records": len(no_dom),
            "by_pre_gate": dict(stats), "unique_by_group": dict(collections.Counter(g for r in rows.values() for g in r["groups"])),
            "pilot_regate": sum(1 for d in pilot_dec.values() if d["decision"] != "REJECT")}
    json.dump(summ, open(os.path.join(RUN, "candidates_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
