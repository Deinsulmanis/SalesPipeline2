"""Insurance pilot, agency side: merge free Apollo discovery lines, apply the deep-dive exclusions, draw a random
sample for the crawl + Jev gate (no reveals on the agency side).

Usage: python3 -I agency_merge.py <run_dir> [--n 50] [--seed 20261126]
Reads  <run>/agency/disc/*.txt  (domain|name|apollo_id|group|page), <run>/prod_domains.json
Writes <run>/agency/candidates.json (all net-new, with exclusion reason or null), <run>/agency/companies.json
(the sample, in the toolkit's companies.json format so fetch_sites.py / pw_fetch.js can crawl it) and prints counts.
"""
import collections, glob, json, os, random, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
N = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 50
SEED = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 20261126
NOT_AGENCY_NAME = re.compile(r"(?i)\b(bank|credit union|church|school|university|hospital|clinic|staffing|realty|real estate|mortgage|"
                             r"tax|accounting|cpa|law|attorneys?|marketing|software|consulting group llc)\b")


def excluded(name, dom):
    n = (name or "").lower()
    if any(b in n or b.replace(" ", "") in dom for b in C.CAPTIVE_BRANDS):
        return "captive_or_single_carrier_brand"
    if any(re.search(r"\b" + re.escape(b) + r"\b", n) or b.replace(" ", "").replace("&", "") == dom.split(".")[0] for b in C.MEGA_BROKERS):
        return "mega_broker_or_platform"
    if C.NOT_RETAIL.search(n):
        return "not_retail_agency"
    if NOT_AGENCY_NAME.search(n) and "insurance" not in n:
        return "not_insurance_agency_name"
    return None


def main():
    prod = set(json.load(open(os.path.join(RUN, "prod_domains.json"))))
    rows, raw = {}, 0
    for f in sorted(glob.glob(os.path.join(RUN, "agency", "disc", "*.txt"))):
        for ln in open(f, errors="replace"):
            p = ln.rstrip("\n").split("|")
            if len(p) < 5:
                continue
            raw += 1
            dom = p[0].strip().lower().removeprefix("www.").split("/")[0]
            if dom in ("", "none"):
                rows.setdefault(("NONE", p[2]), {"domain": None, "company_name": p[1], "apollo_id": p[2], "groups": {p[3]}, "why": "no_domain"})
                continue
            r = rows.setdefault(dom, {"domain": dom, "company_name": p[1], "apollo_id": p[2], "groups": set(), "why": None})
            r["groups"].add(p[3])
    cands = []
    for r in rows.values():
        if r["why"] is None:
            if r["domain"] in prod:
                r["why"] = "in_production"
            else:
                r["why"] = excluded(r["company_name"], r["domain"])
        r["groups"] = sorted(r["groups"])
        cands.append(r)
    ok = [r for r in cands if r["why"] is None]
    random.seed(SEED)
    sample = random.sample(ok, min(N, len(ok)))
    comps = [{"domain": r["domain"], "company_name": r["company_name"], "source_id": r["apollo_id"], "pre_gate": None,
              "groups": r["groups"], "hq_city": None, "hq_country": "United States", "industry": "Insurance", "employee_band": "1-50",
              "source_desc": ""} for r in sample]
    json.dump(cands, open(os.path.join(RUN, "agency", "candidates.json"), "w"), indent=1)
    json.dump(comps, open(os.path.join(RUN, "agency", "companies.json"), "w"), indent=1)
    print(json.dumps({"raw_lines": raw, "unique": len(cands), "by_reason": dict(collections.Counter(r["why"] or "eligible" for r in cands)),
                      "eligible_by_group": dict(collections.Counter(g for r in ok for g in r["groups"])), "sample": len(comps)}, indent=1))


if __name__ == "__main__":
    main()
