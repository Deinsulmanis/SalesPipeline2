"""Read helper-agent transcripts and return (tool_input, result) pairs for one MCP tool, so no data is retyped.
Same approach as tools/apollo_lines.py, generalised to any tool-name substring.

    from transcripts import calls
    for inp, res in calls(["/tmp/.../tasks/<agent>.output"], "organizations_lookup"): ...
"""
import glob
import json
import os
import re


def _text(content):
    if isinstance(content, str):
        return content
    return "".join(x.get("text", "") for x in content if isinstance(x, dict))


def calls(paths, tool_substring):
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
                if b.get("type") == "tool_use" and tool_substring in b.get("name", ""):
                    uses[b["id"]] = b.get("input") or {}
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                    t = _text(b.get("content"))
                    if "saved to" in t:
                        m = re.search(r"saved to:? (/\S+\.(?:txt|json))", t)
                        t = open(m.group(1)).read() if m and os.path.exists(m.group(1)) else t
                    t = t.strip()
                    if t.startswith("["):
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
