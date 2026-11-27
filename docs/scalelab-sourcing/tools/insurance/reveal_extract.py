"""Pull Apollo people_bulk_match results out of a helper agent's transcript into batch files for parse_reveal.py.

Usage: python3 -I reveal_extract.py <run_dir> <targets.json> <prefix> <transcript> [...]
Each call is matched to its batch by the request ids (the batch whose ids equal the call's details ids, in order), so
results never depend on call order and nothing is retyped. Writes <run>/reveal/<prefix>_batchNN.json, <run>/reveal/<prefix>.rows (parse_reveal.py columns, keyed by person id)
and prints, per
batch, the start index into <targets.json> and whether the match ids came back in request order.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from transcripts import calls  # noqa: E402


def main():
    run, targets_p, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    t = json.load(open(targets_p))
    starts = {tuple(x["id"] for x in t[i:i + 10]): i for i in range(0, len(t), 10)}
    seen, credits = set(), 0
    for inp, res in calls(sys.argv[4:], "people_bulk_match"):
        req = tuple(d.get("id") for d in inp.get("details") or [])
        if req not in starts or req in seen:
            continue
        seen.add(req)
        s = starts[req]
        ids = [m.get("id") for m in res.get("matches") or []]
        credits += int(res.get("credits_consumed") or 0)
        out = os.path.join(run, "reveal", f"{prefix}_batch{s // 10:02d}.json")
        json.dump(res, open(out, "w"))
        print(f"{os.path.basename(out)} start={s} matches={len(ids)} order_ok={ids == list(req[:len(ids)])} credits={res.get('credits_consumed')}")
    print("batches found", len(seen), "of", len(starts), "| credits_consumed sum", credits)
    # Rows keyed by person id (same columns as tools/parse_reveal.py, which maps by position): an unmatched person in
    # the middle of a batch can never shift the rows after it.
    by_id = {}
    for f in sorted(os.listdir(os.path.join(run, "reveal"))):
        if re.fullmatch(re.escape(prefix) + r"_batch\d+\.json", f):
            for m in json.load(open(os.path.join(run, "reveal", f))).get("matches") or []:
                by_id[m.get("id")] = m
    lines = []
    for i, x in enumerate(t):
        m = by_id.get(x["id"])
        if not m:
            if tuple(y["id"] for y in t[i - i % 10:i - i % 10 + 10]) in seen:
                lines.append(f"{i}|{x['domain']}|NO MATCH")
            continue
        org = m.get("organization") or {}
        od = (org.get("primary_domain") or "").lower()
        email = m.get("email") or ""
        edom = email.split("@")[1].lower() if "@" in email else ""
        cur = next((e for e in (m.get("employment_history") or []) if e.get("current")), {})
        flags = []
        if not email: flags.append("NO EMAIL")
        if x["domain"] not in (od, edom) and not (edom and x["domain"].endswith(edom)): flags.append("DOMAIN MISMATCH")
        if x["first"].lower() not in (m.get("first_name") or "").lower(): flags.append("WRONG PERSON")
        if m.get("match_confidence") == "low": flags.append("LOW CONFIDENCE")
        lines.append("|".join(str(v).replace("|", "/") for v in [i, x["domain"], x["first"], m.get("id"), m.get("name"), m.get("title"), email,
                     m.get("email_status"), m.get("email_domain_catchall"), m.get("linkedin_url"), cur.get("start_date"),
                     ", ".join(v for v in [m.get("city"), m.get("state")] if v), od, ";".join(flags) or "OK"]))
    open(os.path.join(run, "reveal", f"{prefix}.rows"), "w").write("\n".join(lines) + ("\n" if lines else ""))
    print("rows written", len(lines), "->", f"reveal/{prefix}.rows")


if __name__ == "__main__":
    main()
