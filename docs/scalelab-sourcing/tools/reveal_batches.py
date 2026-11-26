"""Reveal helper: Apollo people_bulk_match results -> reveal/batchNN.json, straight from transcripts.

Helper agents only make the calls (one bulk_match per batch, ids only). This finds each call whose input ids equal a batch
in <id_batches.json> (same order) and writes the raw result to <out_dir>/batchNN.json for parse_reveal.py. Results too
large for the transcript are read from their saved tool-result file. Nothing is retyped.

Usage: python3 -I reveal_batches.py <out_dir> <id_batches.json> <transcript|dir> [...]
"""
import glob
import json
import os
import re
import sys


def _text(content):
    if isinstance(content, str):
        return content
    return "".join(x.get("text", "") for x in content if isinstance(x, dict))


def main():
    out, bfile = sys.argv[1], sys.argv[2]
    batches = [tuple(b) for b in json.load(open(bfile))]
    files = []
    for p in sys.argv[3:]:
        files += sorted(glob.glob(os.path.join(p, "*.jsonl")) + glob.glob(os.path.join(p, "*.output"))) if os.path.isdir(p) else [p]
    found = {}
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
                if b.get("type") == "tool_use" and b.get("name", "").endswith("apollo_people_bulk_match"):
                    uses[b["id"]] = tuple(d.get("id") for d in (b.get("input") or {}).get("details") or [])
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                    t = _text(b.get("content"))
                    m = re.search(r"saved to:? (/\S+\.(?:txt|json))", t)
                    if m and os.path.exists(m.group(1)):
                        t = open(m.group(1)).read()
                        if t.lstrip().startswith("["):
                            t = _text(json.loads(t))
                    t = t.strip()
                    if not t.startswith("{"):
                        continue
                    try:
                        res = json.loads(t)
                    except ValueError:
                        continue
                    key = uses[b["tool_use_id"]]
                    if key in batches:
                        found[batches.index(key)] = res
    os.makedirs(out, exist_ok=True)
    credits = 0
    for i, res in sorted(found.items()):
        json.dump(res, open(os.path.join(out, f"batch{i:02d}.json"), "w"))
        credits += int(res.get("credits_consumed") or 0)
        ids = [m.get("id") for m in res.get("matches") or []]
        if ids and ids != list(batches[i])[:len(ids)]:
            print(f"WARNING batch {i}: match ids not in request order")
    missing = [i for i in range(len(batches)) if i not in found]
    print(f"batches written {len(found)} of {len(batches)}, credits_consumed {credits}, missing {missing}")


if __name__ == "__main__":
    main()
