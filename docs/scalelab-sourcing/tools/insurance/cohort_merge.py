"""Cohort A: merge every send-ready insurance-agency decision-maker into approved_contacts_A.csv (private run folder).

Usage: python3 -I cohort_merge.py <cohort_run_dir> <tx_run_dir> [--gate <gate_dir> <cohort> <source>] ... [--picks <picks.json>] ...
                                  [--held <held_review.json>] [--platform-hold <domain> ...]
  tx_run_dir     the 2026-11-26 Texas run: approved_contacts.csv (current send-ready), contacts.json, icp_decisions.json
  --gate         a gate folder (icp_decisions.json) whose PASS agencies the picks belong to, with its cohort / source tags
  --picks        gl_export_pick.py output (KEEP rows are send-ready; VERIFY_PENDING rows go to to_verify.csv)
  --held         held_review.py output (APPROVE rows join, unless their agency is listed with --platform-hold)
Writes <cohort_run_dir>/approved_contacts_A.csv (the brief's columns + cohort + source; no duplicate emails or agencies;
verified first, catch-alls last), <cohort_run_dir>/to_verify.csv (single "email" column), verify_pending.json and
cohort_summary.json (counts only). Tiers are recomputed with ins_config.agency_tier (owner rule 2026-11-27).
"""
import collections, csv, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ins_config as C  # noqa: E402

SPEC = {"wc": "workers comp", "construction": "construction", "manufacturing": "manufacturing", "trucking": "trucking", "oil_gas": "oil and gas"}
COLS = ["email", "first_name", "last_name", "title", "tier", "agency", "domain", "city", "state", "office_count", "specialties", "wc_focus",
        "icp_reason", "evidence_url", "email_status", "cohort", "source"]


def args(flag, n):
    out, a = [], sys.argv
    for i, x in enumerate(a):
        if x == flag:
            out.append(a[i + 1:i + 1 + n])
    return out


def tier_of(title, fallback):
    t = C.agency_tier(title)
    return t[0] if t else fallback


def agency_fields(a, contact_city="", contact_state="", cohort="A_TX"):
    cities = a.get("tx_cities") or []  # offices in the cohort's state (agency_gate keeps the tx_* field name)
    city = cities[0].title() if cities else contact_city
    state = cohort.split("_")[-1] if cities else (contact_state or ",".join(a.get("states") or []))
    return dict(agency=a.get("company_name"), city=city, state=state, office_count=a.get("office_count", 0),
                specialties="; ".join(SPEC[s] for s in a.get("specialties", []) if s in SPEC), wc_focus="yes" if a.get("wc_focus") else "no",
                icp_reason=a.get("reason"), evidence_url=a.get("evidence_url") or "")


def main():
    out_dir, tx = sys.argv[1], sys.argv[2]
    rows, pending, stats = [], [], collections.Counter()
    # 1. the current send-ready list (Texas run)
    for r in csv.DictReader(open(os.path.join(tx, "approved_contacts.csv"))):
        r = dict(r)
        r["tier"] = tier_of(r["title"], r["tier"])
        r.update(cohort="A_TX", source="tx_run_apollo_reveal")
        rows.append(r)
        stats["existing_363"] += 1
    txdec = {x["domain"]: x for x in json.load(open(os.path.join(tx, "icp_decisions.json")))}
    # 2. held contacts approved by held_review.py
    platform = {a[0] for a in args("--platform-hold", 1)}
    for (hp,) in args("--held", 1):
        for h in json.load(open(hp)):
            if h["decision"] != "APPROVE":
                continue
            if h["domain"] in platform:
                stats["held_platform_kept_on_hold"] += 1
                continue
            a = txdec.get(h["domain"], {})
            r = dict(email=h["email"], first_name=h["first"], last_name=h["last"], title=h["title"], tier=tier_of(h["title"], ""),
                     domain=h["domain"], email_status=f"verified (email domain differs, proven: {h['proof']})", cohort="A_TX",
                     source="held_review_same_firm", **agency_fields(a))
            rows.append(r)
            stats["held_approved"] += 1
    # 3. GetLeads picks per gate folder
    gates = {}
    for g, cohort, source in args("--gate", 3):
        for x in json.load(open(os.path.join(g, "icp_decisions.json"))):
            gates[x["domain"]] = (x, cohort, source)
    for (pp,) in args("--picks", 1):
        for p in json.load(open(pp)):
            a, cohort, source = gates.get(p["domain"]) or (txdec.get(p["domain"], {}), p.get("cohort") or "A_TX", p.get("source") or "")
            cohort = p.get("cohort") or cohort
            source = p.get("source") or source
            if p["result"] == "VERIFY_PENDING":
                pending.append({"domain": p["domain"], "path": "getleads_export", "email": p["email"], "status": p["email_status"], "cohort": cohort, "source": source})
                continue
            if p["result"] != "KEEP":
                continue
            r = dict(email=p["email"], first_name=p["first"], last_name=p["last"], title=p["title"], tier=p["tier"], domain=p["domain"],
                     email_status="VALID (GetLeads, owner rule: verified)", cohort=cohort, source=source,
                     **agency_fields(a, p.get("city", ""), p.get("state", ""), cohort))
            rows.append(r)
            stats[f"new_{source}"] += 1
    # dedupe: one row per email and per agency (first source wins; existing list first)
    seen_e, seen_d, final = set(), set(), []
    for r in rows:
        e, d = r["email"].lower(), r["domain"]
        if e in seen_e or d in seen_d:
            stats["dropped_duplicate"] += 1
            continue
        seen_e.add(e)
        seen_d.add(d)
        final.append(r)
    pend_final, seen_p = [], set()
    for p in pending:
        if p["domain"] in seen_d or p["email"].lower() in seen_e or p["email"].lower() in seen_p:
            stats["pending_dropped_agency_already_has_contact"] += 1
            continue
        seen_p.add(p["email"].lower())
        pend_final.append(p)
    for r in final:  # one state format: two-letter code; blank falls back to the cohort's state
        st = {"texas": "TX", "oregon": "OR"}.get((r.get("state") or "").strip().lower(), (r.get("state") or "").strip())
        r["state"] = st or r["cohort"].split("_")[-1]
    final.sort(key=lambda r: ("catch-all" in r["email_status"], str(r["tier"]), r["cohort"], r["domain"]))
    with open(os.path.join(out_dir, "approved_contacts_A.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(final)
    with open(os.path.join(out_dir, "to_verify.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["email"])
        for p in pend_final:
            w.writerow([p["email"]])
    json.dump(pend_final, open(os.path.join(out_dir, "verify_pending.json"), "w"), indent=1)
    summ = {"send_ready_total": len(final), "by_cohort": dict(collections.Counter(r["cohort"] for r in final)),
            "by_source": dict(collections.Counter(r["source"] for r in final)),
            "catch_all": sum("catch-all" in r["email_status"] for r in final), "tier": dict(collections.Counter(str(r["tier"]) for r in final)),
            "pending_verification": len(pend_final), "pending_by_source": dict(collections.Counter(p["source"] for p in pend_final)), **dict(stats)}
    json.dump(summ, open(os.path.join(out_dir, "cohort_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
