"""Insurance pilot: resolve each sampled employer to a website domain from free Apollo organization lookups.

Usage: python3 -I domain_resolve.py <run_dir> <transcript> [<transcript> ...]
Reads <run>/match/sample.json and the helper agents' transcripts (apollo_organizations_lookup calls made with
q_organization_fuzzy_name = the sample's query_name). A candidate is accepted only when its Apollo name matches
the policy name closely (normalised tokens, legal suffixes dropped):
  exact    normalised names equal
  strong   token-set similarity >= 0.85 and the first distinctive token equal
Location-filtered results win over the unfiltered retry; an unfiltered result on a foreign country domain is dropped. Ambiguous ties (two different domains equally good)
are left unresolved. Writes <run>/match/resolved.json {emp_id: {...}} and prints counts.
"""
import collections
import difflib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from transcripts import calls  # noqa: E402

LEGAL = {"inc", "incorporated", "llc", "l", "ltd", "limited", "corp", "corporation", "co", "company", "lp", "llp", "pllc", "pc",
         "the", "of", "and", "dba", "group", "holdings", "usa", "us", "texas", "tx", "america", "services", "enterprises"}


def toks(name):
    n = re.sub(r"&", " and ", (name or "").lower())
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    return [t for t in n.split() if t]


def core(name):
    return [t for t in toks(name) if t not in LEGAL]


FOREIGN_OK = {"us", "co", "io", "ai"}


def foreign(dom):
    """A two-letter country TLD (other than .us and common generic-use ones) or a second-level ccTLD such as .co.uk."""
    parts = dom.split(".")
    return (len(parts[-1]) == 2 and parts[-1] not in FOREIGN_OK) or (len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net") and len(parts[-1]) == 2)


def score(policy, apollo):
    a, b = core(policy), core(apollo)
    if not a or not b:
        return 0.0, "none"
    if a == b:
        return 1.0, "exact"
    sa, sb = " ".join(sorted(set(a))), " ".join(sorted(set(b)))
    r = difflib.SequenceMatcher(None, sa, sb).ratio()
    if a[0] == b[0] and r >= 0.85:
        return r, "strong"
    return r, "weak"


def main():
    run = sys.argv[1]
    sample = json.load(open(os.path.join(run, "match", "sample.json")))
    by_q = collections.defaultdict(list)  # query_name -> [(located, org)]
    for inp, res in calls(sys.argv[2:], "organizations_lookup"):
        q = inp.get("q_organization_fuzzy_name")
        located = bool(inp.get("organization_locations"))
        for org in res.get("organizations") or res.get("accounts") or []:
            by_q[q].append((located, org))
    resolved, stats = {}, collections.Counter()
    for s in sample:
        cands = by_q.get(s["query_name"], [])
        if not cands:
            stats["no_candidates"] += 1
            resolved[s["emp_id"]] = {"status": "no_candidates"}
            continue
        best = []
        for located, org in cands:
            dom = (org.get("primary_domain") or org.get("domain") or "").lower().removeprefix("www.")
            if not dom:
                continue
            if not located and foreign(dom):
                continue  # an unlocated retry that lands on a foreign site is a different company
            sc, kind = score(s["employer_name"], org.get("name"))
            if kind in ("exact", "strong"):
                best.append(((1 if kind == "exact" else 0, 1 if located else 0, sc), dom, org))
        if not best:
            stats["no_close_name"] += 1
            resolved[s["emp_id"]] = {"status": "no_close_name", "candidates": len(cands)}
            continue
        best.sort(key=lambda x: x[0], reverse=True)
        top = best[0]
        rivals = {d for k, d, _ in best if k == top[0] and d != top[1]}
        if rivals:
            stats["ambiguous"] += 1
            resolved[s["emp_id"]] = {"status": "ambiguous", "domains": sorted({top[1]} | rivals)}
            continue
        kind = "exact" if top[0][0] else "strong"
        stats[f"resolved_{kind}"] += 1
        resolved[s["emp_id"]] = {"status": "resolved", "domain": top[1], "apollo_name": top[2].get("name"),
                                 "apollo_id": top[2].get("id"), "match": kind, "located": bool(top[0][1]), "similarity": round(top[0][2], 3)}
    json.dump(resolved, open(os.path.join(run, "match", "resolved.json"), "w"), indent=1)
    print(json.dumps(dict(sample=len(sample), queries_with_results=sum(1 for s in sample if by_q.get(s["query_name"])), **stats), indent=1))


if __name__ == "__main__":
    main()
