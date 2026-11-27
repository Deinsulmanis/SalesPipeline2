"""Insurance agencies, Cohort B (owner brief 2026-11-27): rank gated agencies for export, then build the B / A+B lists.

Usage:
  python3 -I b_cohort.py rank  <b_run_dir>                      -> <b_run_dir>/rank.json (PASS agencies in export order)
  python3 -I b_cohort.py merge <b_run_dir> <cohort_a_csv> <picks.json> [<picks.json> ...]
                                                                 -> approved_contacts_B.csv, approved_contacts_AB.csv,
                                                                    to_verify_B.csv, b_summary.json (counts only)
Ranking (the brief): states in priority order (CA and FL first), spread across states by round-robin; inside each state
agencies that write trucking come first, then named industry focus (contractors, manufacturing, trucking, oil and gas,
warehousing), workers' comp expertise and hiring producers (Apollo HIRING discovery group); a commercial agency with no
named industry focus ranks last but still passes.
hook_segment: B_trucking (writes_trucking=Y), else B_CA_contractors (CA and writes_contractors=Y), else B_FL (Florida),
else B_hiring.
"""
import collections, csv, json, os, sys

PRIORITY = ["California", "Florida", "Georgia", "North Carolina", "Pennsylvania", "Illinois", "Tennessee", "Arizona", "Indiana",
            "Michigan", "Oklahoma", "Louisiana", "South Carolina", "Alabama", "Missouri", "Wisconsin", "Kentucky", "Arkansas",
            "Nevada", "Colorado", "Virginia", "New Jersey", "New York"]
EXCLUDED = {"North Dakota", "Ohio", "Washington", "Wyoming", "Texas", "Oregon"}
WEIGHT = {s: (3 if i < 2 else 2 if i < 12 else 1) for i, s in enumerate(PRIORITY)}  # agencies taken per state per round
ABBR = {"California": "CA", "Florida": "FL", "Georgia": "GA", "North Carolina": "NC", "Pennsylvania": "PA", "Illinois": "IL",
        "Tennessee": "TN", "Arizona": "AZ", "Indiana": "IN", "Michigan": "MI", "Oklahoma": "OK", "Louisiana": "LA",
        "South Carolina": "SC", "Alabama": "AL", "Missouri": "MO", "Wisconsin": "WI", "Kentucky": "KY", "Arkansas": "AR",
        "Nevada": "NV", "Colorado": "CO", "Virginia": "VA", "New Jersey": "NJ", "New York": "NY"}
SPEC = {"wc": "workers comp", "construction": "construction", "manufacturing": "manufacturing", "trucking": "trucking", "oil_gas": "oil and gas"}
A_COLS = ["email", "first_name", "last_name", "title", "tier", "agency", "domain", "city", "state", "office_count", "specialties", "wc_focus",
          "icp_reason", "evidence_url", "email_status", "cohort", "source"]
B_EXTRA = ["writes_trucking", "writes_contractors", "writes_manufacturing", "hook_segment"]


def hook(x):
    if x.get("writes_trucking") == "Y":
        return "B_trucking"
    if x.get("state") == "California" and x.get("writes_contractors") == "Y":
        return "B_CA_contractors"
    if x.get("state") == "Florida":
        return "B_FL"
    return "B_hiring"


def score(x):
    focus = sum(x.get(k) == "Y" for k in ("writes_contractors", "writes_manufacturing", "writes_warehousing")) + ("oil_gas" in (x.get("specialties") or []))
    return (x.get("writes_trucking") != "Y", -(focus + (x.get("wc_expertise") == "Y") + ("HIRING" in (x.get("sources") or []))),
            x.get("reason_code") != "VERIFIED_COMMERCIAL_AGENCY", x["domain"])


def rank(run):
    dec = [x for x in json.load(open(os.path.join(run, "icp_decisions.json"))) if x["decision"] == "PASS" and x.get("state") not in EXCLUDED]
    by_state = collections.defaultdict(list)
    for x in dec:
        by_state[x.get("state")].append(x)
    for s in by_state:
        by_state[s].sort(key=score)
    order, i = [], collections.Counter()
    while any(i[s] < len(by_state[s]) for s in PRIORITY):
        for s in PRIORITY:
            take = by_state[s][i[s]:i[s] + WEIGHT[s]]
            i[s] += len(take)
            order += take
    out = [{"domain": x["domain"], "agency": x["company_name"], "state": x["state"], "hook_segment": hook(x)} for x in order]
    json.dump(out, open(os.path.join(run, "rank.json"), "w"), indent=0)
    print(json.dumps({"pass": len(dec), "ranked": len(out), "by_state": {s: len(by_state[s]) for s in PRIORITY},
                      "hook_segment": dict(collections.Counter(o["hook_segment"] for o in out)),
                      "trucking_first": sum(o["hook_segment"] == "B_trucking" for o in out)}, indent=1))


def merge(run, a_csv, picks_files):
    dec = {x["domain"]: x for x in json.load(open(os.path.join(run, "icp_decisions.json")))}
    a_rows = list(csv.DictReader(open(a_csv)))
    seen_e = {r["email"].lower() for r in a_rows}
    seen_d = {r["domain"] for r in a_rows}
    b_rows, pending, stats = [], [], collections.Counter()
    for pf in picks_files:
        for p in json.load(open(pf)):
            x = dec.get(p["domain"], {})
            if p["result"] == "VERIFY_PENDING":
                pending.append(p)
                continue
            if p["result"] != "KEEP":
                stats[f"pick_{p['result'].lower()}"] += 1
                continue
            e = p["email"].lower()
            if e in seen_e or p["domain"] in seen_d:
                stats["dropped_duplicate"] += 1
                continue
            seen_e.add(e)
            seen_d.add(p["domain"])
            cities = x.get("tx_cities") or []  # offices in the agency's own state (agency_gate keeps the tx_* name)
            b_rows.append(dict(email=p["email"], first_name=p["first"], last_name=p["last"], title=p["title"], tier=p["tier"],
                               agency=x.get("company_name") or p.get("agency"), domain=p["domain"],
                               city=cities[0].title() if cities else (p.get("city") or ""), state=ABBR.get(x.get("state"), x.get("state") or ""),
                               office_count=x.get("office_count", 0),
                               specialties="; ".join(SPEC[s] for s in x.get("specialties", []) if s in SPEC),
                               wc_focus="yes" if x.get("wc_focus") else "no", icp_reason=x.get("reason"), evidence_url=x.get("evidence_url") or "",
                               email_status="VALID (GetLeads, owner rule: verified)", cohort="B", source="B_" + ABBR.get(x.get("state"), "XX"),
                               writes_trucking=x.get("writes_trucking", "N"), writes_contractors=x.get("writes_contractors", "N"),
                               writes_manufacturing=x.get("writes_manufacturing", "N"), hook_segment=hook(x)))
    pend, seen_p = [], set()
    for p in pending:
        e = p["email"].lower()
        if e in seen_e or p["domain"] in seen_d or e in seen_p:
            stats["pending_dropped_agency_already_has_contact"] += 1
            continue
        seen_p.add(e)
        pend.append(p)
    key = lambda r: ("catch-all" in r["email_status"], str(r["tier"]), r["cohort"], r["state"], r["domain"])
    b_rows.sort(key=lambda r: (PRIORITY.index(next((s for s, a in ABBR.items() if a == r["state"]), "New York")), r["hook_segment"] != "B_trucking", str(r["tier"]), r["domain"]))
    with open(os.path.join(run, "approved_contacts_B.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=A_COLS + B_EXTRA, extrasaction="ignore")
        w.writeheader()
        w.writerows(b_rows)
    ab = sorted(a_rows + b_rows, key=key)
    with open(os.path.join(run, "approved_contacts_AB.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=A_COLS + B_EXTRA, extrasaction="ignore", restval="")
        w.writeheader()
        w.writerows(ab)
    with open(os.path.join(run, "to_verify_B.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["email"])
        for p in pend:
            w.writerow([p["email"]])
    json.dump(pend, open(os.path.join(run, "verify_pending_B.json"), "w"), indent=1)
    assert len({r["email"].lower() for r in ab}) == len(ab) and len({r["domain"] for r in ab}) == len(ab)
    summ = {"cohort_a": len(a_rows), "cohort_b_send_ready": len(b_rows), "total_ab": len(ab), "b_pending_verification": len(pend),
            "b_by_state": dict(collections.Counter(r["state"] for r in b_rows)), "b_hook_segment": dict(collections.Counter(r["hook_segment"] for r in b_rows)),
            "b_tier": dict(collections.Counter(str(r["tier"]) for r in b_rows)),
            "b_writes": {k: sum(r[k] == "Y" for r in b_rows) for k in ("writes_trucking", "writes_contractors", "writes_manufacturing")}, **dict(stats)}
    json.dump(summ, open(os.path.join(run, "b_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    if sys.argv[1] == "rank":
        rank(sys.argv[2])
    else:
        merge(sys.argv[2], sys.argv[3], sys.argv[4:])
