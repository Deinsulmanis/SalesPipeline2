"""Stage 6 helper: turn free Apollo people-search results into buyer_pick.py input, straight from transcripts.

Helper agents only make the calls (apollo_mixed_people_api_search with q_organization_domains_list = one batch of
up to 10 domains, person_seniorities owner/founder/c_suite/partner/vp, per_page 100). This script reads the raw
results from their transcripts, so no names are retyped:

  <run>/buyers/<part>_batches.json   the domain batches, in call order (repeated pages of a batch share its index)
  <run>/buyers/<part>.txt            batch_index|organization_name|person_id|first_name|last_name_obfuscated|title|has_email

Only batches whose domains are all in <run>/<domains.json> are kept, so one transcript can serve several runs.
Output stays in the git-ignored run folder (it holds names).

Usage: python3 -I apollo_lines.py <run> <part> <domains.json> <transcript|dir> [...]
"""
import glob
import json
import os
import sys


def _text(content):
    if isinstance(content, str):
        return content
    return "".join(x.get("text", "") for x in content if isinstance(x, dict))


def calls(paths):
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, "*.jsonl")) + glob.glob(os.path.join(p, "*.output"))) if os.path.isdir(p) else [p]
    out = []
    for f in files:
        uses = {}
        for ln in open(f, errors="replace"):
            try:
                o = json.loads(ln)
            except ValueError:
                continue
            c = (o.get("message") or {}).get("content") if isinstance(o, dict) else None
            if not isinstance(c, list):
                continue
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and "people_api_search" in b.get("name", ""):
                    uses[b["id"]] = b.get("input") or {}
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                    t = _text(b.get("content"))
                    if "saved to" in t:
                        import re
                        m = re.search(r"saved to:? (/\S+\.(?:txt|json))", t)
                        t = open(m.group(1)).read() if m and os.path.exists(m.group(1)) else t
                    t = t.strip()
                    if t.startswith("["):  # a saved .json holds the result's content blocks
                        try:
                            t = _text(json.loads(t)).strip()
                        except ValueError:
                            pass
                    if t.startswith("{"):
                        try:
                            out.append((uses[b["tool_use_id"]], json.loads(t)))
                        except ValueError:
                            pass
    return out


def main():
    run, part, doms_file = sys.argv[1], sys.argv[2], sys.argv[3]
    allowed = set(json.load(open(doms_file)))
    batches, lines, seen = [], [], set()
    for inp, res in calls(sys.argv[4:]):
        batch = [d.strip().lower() for d in inp.get("q_organization_domains_list") or []]
        if not batch or not set(batch) <= allowed:
            continue
        key = tuple(batch)
        if key not in [tuple(b) for b in batches]:
            batches.append(batch)
        bi = [tuple(b) for b in batches].index(key)
        for p in res.get("people") or []:
            if (bi, p.get("id")) in seen:
                continue
            seen.add((bi, p.get("id")))
            org = ((p.get("organization") or {}).get("name") or "").replace("|", "/")
            lines.append("|".join([str(bi), org or "NONE", p.get("id") or "", (p.get("first_name") or "").replace("|", "/"),
                                   (p.get("last_name_obfuscated") or "").replace("|", "/"), (p.get("title") or "").replace("|", "/").replace("\n", " "),
                                   str(bool(p.get("has_email")))]))
    os.makedirs(os.path.join(run, "buyers"), exist_ok=True)
    json.dump(batches, open(os.path.join(run, "buyers", f"{part}_batches.json"), "w"), indent=0)
    open(os.path.join(run, "buyers", f"{part}.txt"), "w").write("\n".join(lines) + ("\n" if lines else ""))
    print(f"{part}: batches {len(batches)}, people {len(lines)}, domains covered {len({d for b in batches for d in b})} of {len(allowed)}")


if __name__ == "__main__":
    main()
