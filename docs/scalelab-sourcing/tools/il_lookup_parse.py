"""Registry agencies -> website domains from free Apollo organization lookups (read from helper transcripts). Free.

Usage: python3 -I il_lookup_parse.py <run> <transcript|dir> [...]
Reads <run>/lookup_part*.json (i, name, q, q_dba, loc) and every apollo_organizations_lookup call in the transcripts whose
q_organization_fuzzy_name equals a q / q_dba. A candidate is accepted when its name matches the query closely
(token overlap after removing legal / generic words >= 0.75, or one name contains the other with >= 2 tokens) and it has a
domain. Ties: the first accepted candidate in Apollo's order.
Writes <run>/domains_apollo.json {name: {domain, matched_name, via}} and <run>/unresolved.json [names] for the web fallback.
"""
import glob
import json
import os
import re
import sys

GENERIC = set("inc llc ltd corp corporation co company the of and staffing services service group solutions personnel "
              "employment agency agencies resources workforce labor temporary temp".split())


LEGAL = set("inc llc ltd corp corporation co company the dba".split())


def toks(s):
    s = re.sub(r"[\u2019']", "", (s or "").lower())
    return [t for t in re.sub(r"[^a-z0-9 ]", " ", s).split() if t]


def core(s):
    return [t for t in toks(s) if t not in GENERIC]


def close(q, name):
    """Same company name: equal after legal words go; or the distinctive words match; or a distinctive first word
    (5+ letters, not generic) is the candidate's first word ('Synerfac' -> 'Synerfac Technical Staffing')."""
    lq = [t for t in toks(q) if t not in LEGAL]
    ln = [t for t in toks(name) if t not in LEGAL]
    if lq and lq == ln[:len(lq)] and len(ln) - len(lq) <= 2:
        return True
    a, b = core(q), core(name)
    if not a or not b:
        return lq == ln
    sa, sb = set(a), set(b)
    overlap = len(sa & sb) / max(len(sa), len(sb))
    contained = (sa <= sb or sb <= sa) and len(sa & sb) >= 1
    if overlap >= 0.75 or (contained and len(toks(q)) >= 2 and len(toks(name)) >= 2):
        return True
    return len(a) == 1 and len(a[0]) >= 5 and b[0] == a[0] and lq[0] == ln[0]


def _text(c):
    return c if isinstance(c, str) else "".join(x.get("text", "") for x in c if isinstance(x, dict))


def calls(paths):
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, "*.output")) + glob.glob(os.path.join(p, "*.jsonl"))) if os.path.isdir(p) else [p]
    out = {}
    for f in files:
        pend = {}
        for line in open(f, errors="replace"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            for c in msg.get("content") or [] if isinstance(msg.get("content"), list) else []:
                if c.get("type") == "tool_use" and c.get("name", "").endswith("apollo_organizations_lookup"):
                    pend[c["id"]] = (c.get("input") or {}).get("q_organization_fuzzy_name")
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in pend:
                    q = pend.pop(c["tool_use_id"])
                    try:
                        res = json.loads(_text(c.get("content")))
                    except Exception:
                        continue
                    if isinstance(res, dict) and "organizations" in res:
                        out.setdefault(q, res["organizations"])
    return out


def main():
    run = sys.argv[1]
    got = calls(sys.argv[2:])
    todo = [t for f in sorted(glob.glob(os.path.join(run, "lookup_part*.json"))) for t in json.load(open(f))]
    found, unresolved, asked = {}, [], 0
    for t in todo:
        hit = None
        for q, via in ((t["q"], "name"), (t.get("q_dba"), "dba")):
            if not q or q not in got:
                continue
            asked += 1
            for o in got[q]:
                if o.get("domain") and close(q, o.get("name")):
                    hit = {"domain": o["domain"].lower(), "matched_name": o.get("name"), "via": via}
                    break
            if hit:
                break
        if hit:
            found[t["name"]] = hit
        else:
            unresolved.append({"name": t["name"], "q": t["q"], "q_dba": t.get("q_dba", ""), "loc": t["loc"]})
    json.dump(found, open(os.path.join(run, "domains_apollo.json"), "w"), indent=1)
    json.dump(unresolved, open(os.path.join(run, "unresolved.json"), "w"), indent=1)
    print("agencies", len(todo), "queries with results", asked, "resolved", len(found), "unresolved", len(unresolved))


if __name__ == "__main__":
    main()
