"""Parse an Apollo bulk_match result file into pipe rows with flags. Usage: python3 -I parse_reveal.py <batch.json> <targets.json> <start_index>"""
import json, sys, re
raw = open(sys.argv[1]).read()
d = json.loads(raw)
if isinstance(d, list):
    d = json.loads(d[0]["text"])
T = json.load(open(sys.argv[2])); s = int(sys.argv[3])
ms = d.get("matches", [])
print("credits fields:", {k: v for k, v in d.items() if k not in ("matches", "apollo_next_actions")})
for k, t in enumerate(T[s:s + len(ms)]):
    m = ms[k] if k < len(ms) else None
    flags = []
    if not m:
        print(f"{s+k}|{t['domain']}|NO MATCH"); continue
    org = m.get("organization") or {}
    od = (org.get("primary_domain") or "").lower()
    email = m.get("email") or ""
    es = m.get("email_status") or ""
    edom = email.split("@")[1].lower() if "@" in email else ""
    cur = next((e for e in (m.get("employment_history") or []) if e.get("current")), {})
    if not email: flags.append("NO EMAIL")
    if t["domain"] not in (od, edom) and not (edom and t["domain"].endswith(edom)): flags.append("DOMAIN MISMATCH")
    if t["first"].lower() not in (m.get("first_name") or "").lower(): flags.append("WRONG PERSON")
    if m.get("match_confidence") == "low": flags.append("LOW CONFIDENCE")
    print("|".join(str(x) for x in [s+k, t["domain"], f"{t['first']} {t['last']}".strip(), m.get("id"), m.get("name"), m.get("title"), email, es,
          m.get("email_domain_catchall"), m.get("linkedin_url"), cur.get("start_date"), ", ".join(x for x in [m.get("city"), m.get("state")] if x), od, ";".join(flags) or "OK"]))
