"""Stage 6b helper: GetLeads lookup_decision_makers results -> gl/D<part>.txt lines for contact_qc.py, from transcripts.

Helper agents only make the calls (lookup_decision_makers with {"domain": d, "limit": 2}: domain only, no name
enrichment). This reads the raw results from their transcripts, so nothing is retyped. Personal emails and phone
numbers in the response are never written anywhere (owner rule); only the work email is kept.

Line format (contact_qc.py):
  domain|first|last|title|seniority|work_email|email_status|employer|employer_site|company_domain|role_start|credits
  domain|NONE|...   when the lookup returned no contacts;  domain|ERROR|...  when the call failed

Usage: python3 -I gl_lines.py <run> <part> <domains.json> <transcript|dir> [...]
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


def clean(v):
    return str(v or "").replace("|", "/").replace("\n", " ").strip()


def main():
    run, part, doms_file = sys.argv[1], sys.argv[2], sys.argv[3]
    allowed = {d.strip().lower() for d in json.load(open(doms_file))}
    files = []
    for p in sys.argv[4:]:
        files += sorted(glob.glob(os.path.join(p, "*.jsonl")) + glob.glob(os.path.join(p, "*.output"))) if os.path.isdir(p) else [p]
    res = {}
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
                if b.get("type") == "tool_use" and b.get("name", "").endswith("lookup_decision_makers"):
                    uses[b["id"]] = (b.get("input") or {}).get("domain", "").strip().lower()
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                    d = uses[b["tool_use_id"]]
                    if d not in allowed:
                        continue
                    t = _text(b.get("content"))
                    m = re.search(r"saved to (/\S+\.txt)", t)
                    if m and os.path.exists(m.group(1)):
                        t = open(m.group(1)).read()
                    try:
                        r = json.loads(t)
                    except ValueError:
                        res.setdefault(d, None)  # failed call; a later success overwrites it
                        continue
                    if "contacts" in r:
                        res[d] = r
    lines = []
    for d in sorted(allowed):
        r = res.get(d, "missing")
        if r == "missing":
            continue
        if r is None:
            lines.append("|".join([d, "ERROR"] + [""] * 10))
            continue
        cr = r.get("query_credits_used", "")
        if not r.get("contacts"):
            lines.append("|".join([d, "NONE"] + [""] * 9 + [str(cr)]))
            continue
        for p in r["contacts"]:
            lines.append("|".join([d, clean(p.get("first_name")), clean(p.get("last_name")), clean(p.get("current_title")),
                                   clean(p.get("seniority_level")), clean(p.get("work_email")).lower(), clean(p.get("email_status")),
                                   clean(p.get("current_employer")), clean(p.get("current_employer_website")), clean(p.get("company_domain")),
                                   clean(p.get("role_start_date")), str(cr)]))
    os.makedirs(os.path.join(run, "gl"), exist_ok=True)
    open(os.path.join(run, "gl", f"D{part}.txt"), "w").write("\n".join(lines) + ("\n" if lines else ""))
    looked = len([d for d in allowed if d in res])
    print(f"D{part}: domains looked up {looked} of {len(allowed)}, contact lines {sum(1 for l in lines if l.split('|')[1] not in ('NONE', 'ERROR'))}, "
          f"none {sum(1 for l in lines if l.split('|')[1] == 'NONE')}, errors {sum(1 for l in lines if l.split('|')[1] == 'ERROR')}, "
          f"credits {sum(int(r.get('query_credits_used') or 0) for r in res.values() if r)}")


if __name__ == "__main__":
    main()
