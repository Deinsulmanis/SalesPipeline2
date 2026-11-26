"""Registry agencies -> domains from GetLeads lookup_company results (read from helper transcripts). Free to run.

Usage: python3 -I gl_company_parse.py <lookup.json> <transcript|dir> [...]
  <lookup.json>: the list sent to the helpers (registry, name, q, q_dba, state, cities, multi_branch).
Match rule (owner brief 2026-11-25), accepted ONLY when both hold:
  - name: the returned company_name equals q (or q_dba) after normalising (case, punctuation, Inc / LLC / Corp / Co / Ltd /
    the / dba);
  - location: the returned company_hq_city equals the registry address city or one of the agency's branch cities
    (lookup_company returns no state, so a multi-branch agency is checked against its branch cities).
Anything found but failing either test is AMBIGUOUS (left for web search); found: false is NOT_FOUND.
Writes runs-private/<registry>-registry-2026-11-25/domains_getleads.json {name: {domain, matched_name, hq_city}} and
gl_ambiguous.json / gl_not_found.json per registry; prints counts and credits (found results).
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
LEGAL = set("inc incorporated llc l l c ltd corp corporation co company the dba pc pllc lp llp".split())


def norm(s):
    s = re.sub(r"[’'.]", "", (s or "").lower())
    s = s.replace("&", " and ")
    return " ".join(t for t in re.sub(r"[^a-z0-9 ]", " ", s).split() if t not in LEGAL)


def _text(c):
    return c if isinstance(c, str) else "".join(x.get("text", "") for x in c if isinstance(x, dict))


def calls(paths):
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, "*.output"))) if os.path.isdir(p) else [p]
    out = {}
    for f in files:
        pend = {}
        for line in open(f, errors="replace"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            content = msg.get("content") if isinstance(msg.get("content"), list) else []
            for c in content:
                if c.get("type") == "tool_use" and c.get("name", "").endswith("lookup_company"):
                    pend[c["id"]] = (c.get("input") or {}).get("company_name")
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in pend:
                    q = pend.pop(c["tool_use_id"])
                    try:
                        res = json.loads(_text(c.get("content")))
                    except Exception:
                        continue
                    if isinstance(res, dict) and "found" in res:
                        out[q] = res
    return out


def main():
    todo = json.load(open(sys.argv[1]))
    got = calls(sys.argv[2:])
    per = collections.defaultdict(lambda: {"found": {}, "ambiguous": [], "not_found": [], "not_looked_up": []})
    credits = 0
    for t in todo:
        reg = t["registry"].lower()
        hits = [(q, got[q]) for q in (t["q"], t.get("q_dba")) if q and q in got]
        if not hits:
            per[reg]["not_looked_up"].append(t["name"])
            continue
        credits += sum(1 for _, r in hits if r.get("found"))
        best, why = None, "not found"
        for q, r in hits:
            co = r.get("company") if r.get("found") else None
            if not co:
                continue
            name_ok = norm(co.get("company_name")) == norm(q)
            city = (co.get("company_hq_city") or "").strip().lower()
            city_ok = bool(city) and city in [c.lower() for c in t["cities"]]
            dom = (co.get("company_domain") or co.get("company_website") or "").lower().replace("www.", "").split("/")[0]
            if name_ok and city_ok and dom:
                best = {"domain": dom, "matched_name": co.get("company_name"), "hq_city": co.get("company_hq_city")}
                break
            why = "name mismatch" if not name_ok else ("no domain" if not dom else "city mismatch")
        if best:
            per[reg]["found"][t["name"]] = best
        elif any(r.get("found") for _, r in hits):
            per[reg]["ambiguous"].append({"name": t["name"], "why": why})
        else:
            per[reg]["not_found"].append(t["name"])
    for reg, v in per.items():
        run = os.path.join(ROOT, "runs-private", f"{reg}-registry-2026-11-25")
        json.dump(v["found"], open(os.path.join(run, "domains_getleads.json"), "w"), indent=1)
        json.dump(v["ambiguous"], open(os.path.join(run, "gl_ambiguous.json"), "w"), indent=1)
        json.dump(v["not_found"] + v["not_looked_up"], open(os.path.join(run, "gl_not_found.json"), "w"), indent=1)
        amb = collections.Counter(a["why"] for a in v["ambiguous"])
        print(reg.upper(), "looked up", len(v["found"]) + len(v["ambiguous"]) + len(v["not_found"]), "matched", len(v["found"]),
              "ambiguous", len(v["ambiguous"]), dict(amb), "not found", len(v["not_found"]), "not looked up", len(v["not_looked_up"]))
    print("credits (found results)", credits)


if __name__ == "__main__":
    main()
