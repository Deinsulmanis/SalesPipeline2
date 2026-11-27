"""Cohort B: GetLeads contact exports for ranked agencies through the REST API (proxy-injected credentials), with a hard
credit guard. Saves typing hundreds of domains into tool calls; same filters as the MCP export_contacts tool.

Usage: python3 -I b_export.py <b_run_dir> <pass> <start> <end> <credit_cap>
  pass   t1  Tier 1 titles, email VALID, 1 per agency (owner / principal / president / CEO / founder / managing partner)
         t2  Tier 2 / 3 titles, email VALID, 1 per agency, only agencies with no row from earlier passes
         cu  Tier 1 / 2 titles, CATCH_ALL / UNKNOWN, 1 per agency, only agencies with no row yet (feeds to_verify)
  start / end   slice of rank.json (export order)
  credit_cap    Cohort B GetLeads cap; spend so far is read from <run>/gl/receipts.jsonl. Before exporting, the free
                count for the slice must fit under the remaining cap (count = worst-case rows), else the slice is cut.
Writes <run>/gl/<pass>_<start>_<end>.csv and appends a receipt line (rows_exported, query_credits_used).
"""
import csv, json, os, sys, time, urllib.error, urllib.request

API = "https://app.getleads.io/api/v1/contacts/search"
HDR = {"Authorization": "Bearer proxy-injected", "Content-Type": "application/json"}
T1 = ["owner", "principal", "president", "ceo", "chief executive", "founder", "managing partner", "managing director"]
T2 = ["commercial lines", "sales manager", "partner", "director of commercial", "vice president of commercial", "vp of commercial",
      "vp commercial", "senior commercial", "senior producer", "lead producer"]
EXCL = ["vice president", "assistant", "account manager", "customer service", "csr"]
PASSES = {"t1": dict(job_titles=T1, exclude_job_titles=EXCL, email_status=["VALID"]),
          "t2": dict(job_titles=T2, exclude_job_titles=["assistant", "customer service", "csr"], email_status=["VALID"]),
          "cu": dict(job_titles=T1 + T2[:3], exclude_job_titles=EXCL, email_status=["CATCH_ALL", "UNKNOWN"])}


def call(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:500].decode(errors="replace"))
        sys.exit(2)


def count(body):
    r = call("POST", API + "/count", body)
    for _ in range(60):
        if r.get("status") != "counting":
            return r.get("total_matching")
        time.sleep(max(5, r.get("retry_after_seconds") or 10))
        r = call("GET", f"{API}/count/{r['count_id']}")
    return None


def host(u):
    return (u or "").split("//")[-1].split("/")[0].lower().removeprefix("www.")


def main():
    run, ps, start, end, cap = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    gl = os.path.join(run, "gl")
    os.makedirs(gl, exist_ok=True)
    rec_p = os.path.join(gl, "receipts.jsonl")
    spent = sum(json.loads(l).get("query_credits_used") or 0 for l in open(rec_p)) if os.path.exists(rec_p) else 0
    rank = json.load(open(os.path.join(run, "rank.json")))[start:end]
    doms = [r["domain"] for r in rank]
    if ps != "t1":  # only agencies with no row from any earlier export
        have = set()
        for f in os.listdir(gl):
            if f.endswith(".csv"):
                for r in csv.DictReader(open(os.path.join(gl, f), encoding="utf-8-sig")):
                    have |= {host(r.get("company_domain")), host(r.get("current_employer_website")), (r.get("work_email") or "").split("@")[-1].lower()}
        doms = [d for d in doms if d not in have]
    body = dict(domains=doms, require_email=True, **PASSES[ps])
    n = count(body)
    if n is None:
        print("STOP: count did not finish (fail closed)")
        sys.exit(2)
    left = cap - spent
    print(json.dumps({"pass": ps, "slice": [start, end], "domains": len(doms), "count_rows_all_per_company": n, "spent_so_far": spent, "left": left}))
    if left <= 0 or not doms or n == 0:
        print("STOP: cap reached or nothing to export")
        return
    # with 1 per company the export can return at most one row per domain; keep the worst case under the cap
    if len(doms) > left and n > left:
        doms = doms[:left]
        body["domains"] = doms
        print(f"slice cut to {len(doms)} domains to stay under the cap")
    ex = call("POST", API + "/export", dict(body, max_per_company=1))
    eid = ex.get("export_id")
    for _ in range(120):
        time.sleep(5)
        st = call("GET", f"{API}/export/{eid}")
        if st.get("job_status") in ("completed", "failed", "cancelled"):
            break
    if st.get("job_status") != "completed":
        print("EXPORT NOT COMPLETED", st.get("job_status"))
        sys.exit(2)
    out = os.path.join(gl, f"{ps}_{start}_{end}.csv")
    urllib.request.urlretrieve(st["export_url"], out)
    rec = {"pass": ps, "slice": [start, end], "export_id": eid, "domains": len(doms), "rows_exported": st.get("rows_exported"),
           "query_credits_used": st.get("query_credits_used"), "creditsRemaining": st.get("creditsRemaining"), "cap_reason": st.get("cap_reason")}
    open(rec_p, "a").write(json.dumps(rec) + "\n")
    print(json.dumps(rec))


if __name__ == "__main__":
    main()
