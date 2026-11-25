"""Stage 1-2: merge discovery lines into <run>/companies.json, with free dedupe and pre-screen.

Usage:  python3 -I discover_merge.py <run> [--limit N] [--defer GROUP[,GROUP]]

--defer: candidates found ONLY by these groups go after every other candidate in the cut
(e.g. --defer NAICS_56132 so a broad industry-code group never displaces the tag groups).

Inputs (all in <run>/):
  disc/*.txt             one line per candidate: domain|name|source_id|slice|page[|group]
                         (group = the query group that found it, e.g. G1_INDUSTRIAL or NAICS_56132;
                         a domain found by several groups keeps all of them in `groups`)
  exclude_domains.json   {domain: why}: production leads (all clients), the V4 master, earlier run
                         research (pilot, wave 1, Codex re-check). Build it before discovery.
  prod_names.json        [{client, suppressed, name}] normalized production company names.

Outputs:
  companies.json         net-new candidates for crawl and ICP (pre_gate None), at most --limit,
                         in round-robin order across slices so every region is represented.
  discovery_excluded.json  every candidate left out, with the reason (duplicate domain, name
                         collision, national/franchise brand, out-of-ICP name, no domain).
  discovery_stats.json   counts per reason and per slice.

Nothing here calls a paid tool. A name collision or franchise brand is not proof of a duplicate:
those rows go to the owner-review list, never to paid steps.
"""
import collections
import glob
import json
import os
import re
import sys

RUN = sys.argv[1]
LIMIT = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
DEFER = set(sys.argv[sys.argv.index("--defer") + 1].split(",")) if "--defer" in sys.argv else set()

GENERIC = set("""staffing staff services service inc llc l l c corp corporation co company group the of and
solutions solution personnel employment agency agencies workforce resources resource recruiting recruitment
search partners associates international usa us america american national industrial labor labour temps temp
temporary professionals professional management consulting consultants enterprises holdings llp ltd pllc pc
""".split())

# Chains and franchise brands: the one rule in franchise_rule.py (owner decision 2026-11-25).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402

# Clearly outside industrial / skilled-trades staffing (IT, healthcare, legal, executive search).
OFF_ICP = re.compile(r"\b(software|infotech|info tech|technologies|technology|it solutions|it services|it staffing|"
                     r"cyber|cloud|data|digital|analytics|sap|oracle|erp|salesforce|nurs\w*|medical|health\w*|"
                     r"dental|pharma\w*|physician\w*|clinical|therap\w*|home care|homecare|caregiv\w*|senior care|"
                     r"legal|law|attorney\w*|paralegal|executive search|accounting|finance|financial|cpa|"
                     r"education|teachers?|school|locum\w*|travel nurse)\b")


def root(d):
    d = (d or "").strip().lower()
    d = re.sub(r"^https?://", "", d).split("/")[0].split(":")[0]
    return d[4:] if d.startswith("www.") else d


def norm(name):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (name or "").lower()).split())


def stem(name):
    return " ".join(t for t in norm(name).split() if t not in GENERIC)


def main():
    exclude = json.load(open(os.path.join(RUN, "exclude_domains.json")))
    prod = json.load(open(os.path.join(RUN, "prod_names.json")))
    prod_stems = {}
    for p in prod:
        s = stem(p["name"])
        if len(s) >= 4:  # very short stems ("a", "jd") match too much to be evidence
            prod_stems.setdefault(s, []).append(p)

    rows, seen = [], {}
    for path in sorted(glob.glob(os.path.join(RUN, "disc", "*.txt"))):
        for line in open(path, encoding="utf-8", errors="replace"):
            parts = line.rstrip("\n").split("|")
            if len(parts) < 5 or not parts[1].strip():
                continue
            dom, name, sid, sl, page = (p.strip() for p in parts[:5])
            grp = parts[5].strip() if len(parts) > 5 and parts[5].strip() else "default"
            dom = root(dom)
            key = dom or ("noid:" + sid)
            if key in seen:
                if grp not in seen[key]["groups"]:
                    seen[key]["groups"].append(grp)
                continue
            r = dict(domain=dom, company_name=name, source_id="apollo_lookup:" + sid,
                     slice=sl, batch=f"{os.path.basename(path)[:-4]}:{sl}:{page}", groups=[grp])
            seen[key] = r
            rows.append(r)

    keep, excluded = [], []
    for r in rows:
        why = None
        st = stem(r["company_name"])
        if not r["domain"]:
            why = "NO_DOMAIN"
        elif r["domain"] in exclude:
            why = "DUPLICATE_DOMAIN: " + exclude[r["domain"]]
        elif fr.chain_block(r["company_name"], r["domain"]):
            why = fr.chain_block(r["company_name"], r["domain"]).upper()
        elif st in prod_stems:
            hits = prod_stems[st]
            sup = any(h["suppressed"] for h in hits)
            why = "NAME_COLLISION: " + ("suppressed " if sup else "") + ",".join(sorted({h["client"] for h in hits}))
        elif OFF_ICP.search(norm(r["company_name"])):
            why = "OFF_ICP_NAME"
        if why:
            excluded.append(dict(r, excluded=why))
        else:
            keep.append(r)

    # Round-robin across slices so a --limit cut keeps every region represented.
    def round_robin(rs):
        by_slice = collections.OrderedDict()
        for r in rs:
            by_slice.setdefault(r["slice"], []).append(r)
        out = []
        while any(by_slice.values()):
            for s in list(by_slice):
                if by_slice[s]:
                    out.append(by_slice[s].pop(0))
        return out
    deferred = [r for r in keep if DEFER and set(r["groups"]) <= DEFER]
    ordered = round_robin([r for r in keep if r not in deferred]) + round_robin(deferred)
    chosen = ordered[:LIMIT] if LIMIT else ordered
    overflow = ordered[len(chosen):]

    comps = [dict(domain=r["domain"], company_name=r["company_name"], hq_city="", hq_state=r["slice"],
                  hq_country="United States", employee_band="11-500 (Apollo filter)", industry="Staffing (Apollo tag)",
                  source_desc="", source_id=r["source_id"], batch=r["batch"], intent_ads=None,
                  pre_gate=None, pre_reason="", dedupe_status="NEW", groups=r["groups"]) for r in chosen]
    json.dump(comps, open(os.path.join(RUN, "companies.json"), "w"), indent=1)
    json.dump(excluded, open(os.path.join(RUN, "discovery_excluded.json"), "w"), indent=1)
    json.dump(overflow, open(os.path.join(RUN, "discovery_overflow.json"), "w"), indent=1)

    reasons = collections.Counter(e["excluded"].split(":")[0] for e in excluded)
    def per_group(rs):
        return dict(collections.Counter(g for r in rs for g in r["groups"]))
    stats = dict(raw_unique=len(rows), net_new=len(keep), chosen=len(chosen), overflow=len(overflow),
                 excluded=dict(reasons), chosen_per_slice=dict(collections.Counter(c["hq_state"] for c in comps)),
                 per_group=dict(raw_unique=per_group(rows), net_new=per_group(keep), chosen=per_group(chosen),
                                only_this_group_net_new=dict(collections.Counter(r["groups"][0] for r in keep if len(r["groups"]) == 1))))
    json.dump(stats, open(os.path.join(RUN, "discovery_stats.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in stats.items() if k != "chosen_per_slice"}, indent=1))


if __name__ == "__main__":
    main()
