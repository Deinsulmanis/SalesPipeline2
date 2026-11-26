"""Insurance pilot: batch resolved employer domains for the free Apollo people search (10 per call).

Usage: python3 -I buyer_batches.py <run_dir>
Excludes domains already in production (any client; read-only exclusion, never paid for twice) and staffing /
labor agencies (the staffing campaign's prospects). Domains resolved by name lookup outside Apollo get a batch of
their own, so people map back without an Apollo organisation name.
Writes <run>/match/buyer_domains.json, <run>/buyers/E1_batches.json (the batches to send) and
<run>/match/buyer_exclusions.json.
"""
import json, os, re, sys

RUN = sys.argv[1]
STAFFING = re.compile(r"(?i)\b(staffing|recruit\w*|personnel|temporary|temps?|workforce|manpower|labor (services|solutions|force)|employment (services|agency))\b")


def main():
    sample = {s["emp_id"]: s for s in json.load(open(os.path.join(RUN, "match", "sample.json")))}
    res = json.load(open(os.path.join(RUN, "match", "resolved.json")))
    prod = set(json.load(open(os.path.join(RUN, "prod_domains.json"))))
    keep, excl = [], {}
    for eid, r in res.items():
        if r["status"] != "resolved":
            continue
        d = r["domain"]
        if d in prod:
            excl[eid] = "in_production"
        elif STAFFING.search(sample[eid]["employer_name"]) or STAFFING.search(r.get("apollo_name") or ""):
            excl[eid] = "staffing_agency"
        else:
            keep.append((eid, d, r.get("path")))
    seen, apollo, solo = set(), [], []
    for eid, d, path in keep:
        if d in seen:
            excl[eid] = "duplicate_domain"
            continue
        seen.add(d)
        (solo if path != "apollo_free_lookup" else apollo).append(d)
    batches = [apollo[i:i + 10] for i in range(0, len(apollo), 10)] + [[d] for d in solo]
    os.makedirs(os.path.join(RUN, "buyers"), exist_ok=True)
    json.dump(sorted(seen), open(os.path.join(RUN, "match", "buyer_domains.json"), "w"))
    json.dump(batches, open(os.path.join(RUN, "buyers", "E1_batches.json"), "w"), indent=0)
    json.dump(excl, open(os.path.join(RUN, "match", "buyer_exclusions.json"), "w"), indent=1)
    from collections import Counter
    print("domains", len(seen), "batches", len(batches), "excluded", dict(Counter(excl.values())))


if __name__ == "__main__":
    main()
