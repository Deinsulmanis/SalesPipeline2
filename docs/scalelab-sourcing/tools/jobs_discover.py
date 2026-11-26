"""Part 2 discovery (2026-11-24): staffing agencies found through job boards (GetLeads search_jobs, group_by company).

Query per company-name keyword (staffing, personnel, workforce, labor, employment, temps, recruiting, resources):
  {"company_name": kw, "country": "US", "group_by": "company",
   "job_functions": ["Manufacturing", "Skilled Trades & Maintenance", "Supply Chain & Logistics"], "limit": 100, "offset": n}
Helper agents page the calls; their raw results are parsed here from the agent transcripts (jobs_rule.collect).

Writes <run>/disc/JOBS.txt lines for discover_merge.py:  domain|name|linkedin|keyword|offset|JOBS_<keyword>
and <run>/jobs_discovery_raw.json (every company row with the keywords that found it) plus per-keyword counts.

Filters before the merge (all name/domain rules, free):
  - non-US domains (country-code TLDs other than .us);
  - public bodies, unions, workforce boards, schools and hospitals;
  - a direct employer whose name merely contains a keyword: for the weak keywords (workforce, labor, employment,
    resources) a name without a staffing word that names a non-staffing industry (energy, construction, ag...) is
    dropped; other weak-keyword names go to the crawl and the gate (check 2 decides). Known direct employers are dropped.
Chains, name collisions and off-ICP names are handled by discover_merge.py (held for the owner, never paid for).

Usage: python3 -I jobs_discover.py <run> <transcript|dir> [...]
"""
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jobs_rule import collect, root  # noqa: E402

KEYWORDS = ["staffing", "personnel", "workforce", "labor", "employment", "temps", "recruiting", "resources", "manpower", "staff"]
WEAK = {"workforce", "labor", "employment", "resources"}
STAFFING_WORD = re.compile(r"\b(staffing|staff|personnel|temps?|temporary|recruit\w*|manpower|placement\w*|employment (agency|services|solutions|group|"
                           r"professionals|specialists|partners|network)|labor (solutions|services|staffing|source|force|finders|pool|express|connection|"
                           r"group|partners|management)|workforce (solutions|group|partners|services|staffing|management|inc|llc)|hiring|talent)\b", re.I)
STAFFING_DOMAIN = re.compile(r"staff|temp|recruit|labor|labour|jobs|hire|workforce|personnel|employ|talent|crew|manpower")
PUBLIC = re.compile(r"\b(department|dept|county|state of|city of|commonwealth|government|federal|union|local \d+|laborers international|"
                    r"workforce (development|investment|board|commission|alliance|connection)|development board|board of|council|"
                    r"university|college|school|academy|hospital|health system|job corps|goodwill|ymca|church|ministries)\b", re.I)
NON_STAFFING_INDUSTRY = re.compile(r"\b(energy|oil|gas|petroleum|natural resources|mining|minerals?|utilit\w*|pipeline|midstream|exploration|agri\w*|ag|farms?|lumber|timber|water|environmental|chemicals?|steel|metals|foods?|beverage|transport\w*|trucking|freight|logistics inc|construction|builders?|roofing|flooring|electric(al)? (co|company|inc)|mechanical|plumbing|landscap\w*)\b", re.I)
DIRECT_EMPLOYERS = {"amazon.com", "amazon.jobs", "hiring.amazon.com", "walmart.com", "target.com", "fedex.com", "ups.com", "costco.com",
                    "homedepot.com", "lowes.com", "kroger.com", "tesla.com", "usps.com", "dhl.com", "xpo.com", "gxo.com"}
US_TLDS = {"com", "net", "org", "us", "biz", "io", "co", "jobs", "work", "info", "pro", "llc", "inc", "careers", "group", "solutions",
           "services", "staffing", "agency", "company", "team", "global", "world", "works", "site", "online", "tech", "app", "ai", "me"}


def keyword_of(inp):
    k = (inp.get("company_name") or "").strip().lower()
    return k if k in KEYWORDS else None


def main():
    run = sys.argv[1]
    calls = [c for c in collect(sys.argv[2:]) if c["ok"] and keyword_of(c["input"]) and c["input"].get("group_by") == "company"
             and not c["input"].get("company_domain") and c["input"].get("country") == "US"]
    pages = collections.defaultdict(dict)
    for c in calls:
        # state-by-state sweeps (2026-11-26): a page is keyed by (region, offset), so pages of different states never collide
        pages[keyword_of(c["input"])][(c["input"].get("region") or "", c["input"].get("offset", 0) or 0, c["input"].get("limit") or 100)] = c["result"]
    found, per_kw = {}, {}
    for kw in KEYWORDS:
        rows, totals = [], {}
        for key in sorted(pages.get(kw, {})):
            region, off, _lim = key
            res = pages[kw][key]
            totals[region] = res.get("total_results", totals.get(region))
            for r in res.get("data") or []:
                rows.append((off, region, r))
        total = sum(v or 0 for v in totals.values()) if totals else None
        per_kw[kw] = {"pages": len(pages.get(kw, {})), "rows": len(rows), "total_results": total, "regions": len(totals),
                      "complete": total is not None and len(rows) >= total}
        for off, region, r in rows:
            d = root(r.get("company_domain"))
            key = d or "noid:" + (r.get("company_linkedin_slug") or r.get("company_name") or "")
            e = found.setdefault(key, {"domain": d, "company_name": r.get("company_name") or "", "linkedin": r.get("company_linkedin_slug") or "",
                                       "keywords": [], "offset": off, "industrial_open_roles": r.get("role_count") or 0,
                                       "job_functions": r.get("job_functions") or [], "regions": []})
            if region and region not in e["regions"]:
                e["regions"].append(region)
            if kw not in e["keywords"]:
                e["keywords"].append(kw)
    drop = collections.Counter()
    lines = []
    for key, e in found.items():
        d, name = e["domain"], e["company_name"]
        tld = d.rsplit(".", 1)[-1] if d else ""
        why = None
        if not d:
            why = "NO_DOMAIN"
        elif d.endswith((".co.uk", ".com.au", ".co.nz", ".com.mx", ".co.in")) or (len(tld) == 2 and tld not in ("us", "co", "io", "ai", "me")) or (len(tld) > 2 and tld not in US_TLDS):
            why = "NON_US_DOMAIN"
        elif d in DIRECT_EMPLOYERS or any(d.endswith("." + x) for x in DIRECT_EMPLOYERS):
            why = "DIRECT_EMPLOYER"
        elif PUBLIC.search(name):
            why = "PUBLIC_BODY_UNION_OR_SCHOOL"
        elif set(e["keywords"]) <= WEAK and not (STAFFING_WORD.search(name) or STAFFING_DOMAIN.search(d)) and NON_STAFFING_INDUSTRY.search(name):
            # a weak keyword in a clearly non-staffing industry name (energy, construction, ag...) is a direct employer;
            # other weak-keyword names go on to the crawl and the gate, where check 2 decides on first-party evidence
            why = "KEYWORD_ONLY_DIRECT_EMPLOYER"
        e["prefilter"] = why
        if why:
            drop[why] += 1
            continue
        kw = e["keywords"][0]
        lines.append("|".join([d, name.replace("|", "/"), e["linkedin"] or "-", kw, str(e["offset"]), "JOBS_" + kw.upper()]))
        for extra in e["keywords"][1:]:
            lines.append("|".join([d, name.replace("|", "/"), e["linkedin"] or "-", extra, str(e["offset"]), "JOBS_" + extra.upper()]))
    os.makedirs(os.path.join(run, "disc"), exist_ok=True)
    open(os.path.join(run, "disc", "JOBS.txt"), "w").write("\n".join(lines) + "\n")
    json.dump({"per_keyword": per_kw, "found": list(found.values()), "prefilter_dropped": dict(drop)},
              open(os.path.join(run, "jobs_discovery_raw.json"), "w"), indent=1)
    print(json.dumps(per_kw, indent=1))
    print("unique companies", len(found), "kept for merge", len({l.split('|')[0] for l in lines}), "dropped", dict(drop))


if __name__ == "__main__":
    main()
