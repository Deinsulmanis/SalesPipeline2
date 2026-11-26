"""Insurance pilot: ingest the owner's GetLeads verification results for the employer contacts.

Usage: python3 -I ingest_ins_verification.py <run_dir>
The owner uploads <run>/to_verify.csv to GetLeads and drops the results at <run>/verified_results.csv. This reuses
tools/ingest_verification.py's row mapping (map_row: valid / catch-all / invalid / unknown / risky) unchanged, writes
<run>/verification.json, backs up the files it replaces, and re-runs ins_contact_qc.py (the staffing QC, outputs and
master are NOT touched). Prints counts only. Claude Code never submits or polls verification jobs.
"""
import collections, csv, datetime, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from ingest_verification import map_row  # noqa: E402  (shared mapping; no copy)


def main():
    run = os.path.abspath(sys.argv[1])
    res_p = os.path.join(run, "verified_results.csv")
    if not os.path.exists(res_p):
        raise SystemExit(f"no results file at {res_p}")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bk = os.path.join(run, f"ingest_{stamp}")
    os.makedirs(bk)
    for f in ("verification.json", "verify_pending.json", "to_verify.csv", os.path.join("match", "contact_qc.json"), os.path.join("match", "contacts_private.csv")):
        if os.path.exists(os.path.join(run, f)):
            shutil.copy2(os.path.join(run, f), bk)
    pend = {p["email"].lower() for p in json.load(open(os.path.join(run, "verify_pending.json")))} if os.path.exists(os.path.join(run, "verify_pending.json")) else set()
    vj = os.path.join(run, "verification.json")
    store = json.load(open(vj)) if os.path.exists(vj) else {}
    mapped, matched = collections.Counter(), 0
    for r in csv.DictReader(open(res_p, newline="", encoding="utf-8-sig")):
        m = map_row(r)
        if not m:
            continue
        e, v = m
        store[e] = dict(v, ingested_at=stamp)
        mapped[v["validity"]] += 1
        matched += e in pend
    json.dump(store, open(vj, "w"), indent=1)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "ins_contact_qc.py"), run], check=True)
    print(json.dumps({"results_rows_mapped": dict(mapped), "matched_pending": matched, "pending_before": len(pend), "backup": os.path.basename(bk)}, indent=1))


if __name__ == "__main__":
    main()
