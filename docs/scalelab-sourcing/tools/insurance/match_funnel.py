"""Insurance pilot: counts-only funnel for the employer contact match test, cost per matched decision-maker and the
projection to the full filtered Texas list. Usage: python3 -I match_funnel.py <run_dir> <apollo_credits> <getleads_dm_credits> <getleads_company_credits>
Writes <run>/match/funnel.json (no names or emails)."""
import collections, csv, json, os, sys

RUN = sys.argv[1]
AP, GLDM, GLCO = (float(x) for x in sys.argv[2:5])


def main():
    sample = json.load(open(os.path.join(RUN, "match", "sample.json")))
    res = json.load(open(os.path.join(RUN, "match", "resolved.json")))
    excl = json.load(open(os.path.join(RUN, "match", "buyer_exclusions.json")))
    picks = json.load(open(os.path.join(RUN, "match", "employer_picks.json")))
    rows = list(csv.DictReader(open(os.path.join(RUN, "match", "contacts_private.csv"))))
    full = len(json.load(open(os.path.join(RUN, "tx", "employers.json"))))
    n = len(sample)
    by_emp = {r["emp_id"]: r for r in rows}
    res_status = collections.Counter(v["status"] for v in res.values())
    resolved = [k for k, v in res.items() if v["status"] == "resolved"]
    paths = collections.Counter(res[k].get("path") for k in resolved)
    searched = len(picks)
    ap_keep = sum(1 for r in rows if r["path"] == "apollo" and r["qc"] == "KEEP")
    ap_hold = sum(1 for r in rows if r["path"] == "apollo" and r["qc"] == "HOLD")
    gl_pend = sum(1 for r in rows if r["path"] == "getleads" and r["qc"] == "VERIFY_PENDING")
    gl_keep = sum(1 for r in rows if r["path"] == "getleads" and r["qc"] == "KEEP")
    ind = collections.defaultdict(lambda: collections.Counter())
    for s in sample:
        c = ind[s["industry"]]
        c["sample"] += 1
        c["domain"] += res[s["emp_id"]]["status"] == "resolved"
        r = by_emp.get(s["emp_id"])
        c["apollo_keep"] += bool(r and r["path"] == "apollo" and r["qc"] == "KEEP")
        c["getleads_pending"] += bool(r and r["path"] == "getleads" and r["qc"] == "VERIFY_PENDING")
    f = {
        "sample": n,
        "domain_lookup": dict(res_status),
        "domain_resolved_by_path": dict(paths),
        "excluded_before_people_search": dict(collections.Counter(excl.values())),
        "people_searched_domains": searched,
        "domains_with_any_person": sum(1 for v in picks.values() if v["people"]),
        "apollo_picked_with_email": sum(1 for v in picks.values() if v["pick"]),
        "apollo_revealed": ap_keep + ap_hold, "apollo_qc_keep": ap_keep, "apollo_qc_hold": ap_hold,
        "getleads_dm_domains": sum(1 for v in picks.values() if not v["pick"]), "getleads_verify_pending": gl_pend, "getleads_keep": gl_keep,
        "match_rate": {"apollo_ready": round(ap_keep / n, 3), "getleads_pending": round(gl_pend / n, 3),
                       "combined": round((ap_keep + gl_pend + gl_keep) / n, 3), "domain_resolved": round(len(resolved) / n, 3)},
        "credits": {"apollo_reveals": AP, "getleads_decision_makers": GLDM, "getleads_company_lookup_test": GLCO},
        "cost_per_matched_dm": {"apollo_credits_per_ready_contact": round(AP / max(1, ap_keep), 2),
                                "getleads_credits_per_pending_contact": round(GLDM / max(1, gl_pend + gl_keep), 2)},
        "by_industry": {k: dict(v) for k, v in ind.items()},
        "projection_full_list": {
            "employers": full,
            "apollo_ready_contacts": round(full * ap_keep / n), "apollo_credits": round(full * AP / n),
            "getleads_pending_contacts": round(full * (gl_pend + gl_keep) / n), "getleads_credits": round(full * GLDM / n),
            "combined_contacts_before_verification": round(full * (ap_keep + gl_pend + gl_keep) / n),
            "free_apollo_lookup_calls": round(full * 313 / n),
        },
    }
    json.dump(f, open(os.path.join(RUN, "match", "funnel.json"), "w"), indent=1)
    print(json.dumps(f, indent=1))


if __name__ == "__main__":
    main()
