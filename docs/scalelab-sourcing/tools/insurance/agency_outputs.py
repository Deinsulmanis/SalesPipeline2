"""Insurance agencies: build the owner's review files from the gate and contact QC (private run folder only).

Usage: python3 -I agency_outputs.py <run_dir>
Reads <run>/icp_decisions.json, <run>/contacts.json, <run>/buyer_picks.json (optional), <run>/no_buyer_domains.json
(optional), <run>/batch_upload_domains.txt (optional).
Writes (git-ignored run folder):
  approved_contacts.csv   email, first_name, last_name, title, tier, agency, domain, city, state, office_count,
                          specialties, wc_focus, icp_reason, evidence_url, email_status  (contact-ready KEEP rows;
                          catch-all rows last, email_status "verified (catch-all, queue last)")
  qualified_agencies.csv  every PASS agency, with contact status
  holds.csv               agency HOLDs and contact HOLDs with reasons (not sent to the owner)
  outputs_summary.json    counts only
"""
import collections, csv, json, os, sys

RUN = sys.argv[1]
SPEC = {"wc": "workers comp", "construction": "construction", "manufacturing": "manufacturing", "trucking": "trucking", "oil_gas": "oil and gas"}


def load(name, default):
    p = os.path.join(RUN, name)
    return json.load(open(p)) if os.path.exists(p) else default


def where(a):
    cities = a.get("tx_cities") or []
    return (cities[0].title() if cities else ""), ("TX" if a.get("tx_office_count") else ",".join(a.get("states") or []) or "TX")


def main():
    dec = load("icp_decisions.json", [])
    by_dom = {a["domain"]: a for a in dec}
    contacts = load("contacts.json", [])
    picks = load("buyer_picks.json", {})
    batch = set(open(os.path.join(RUN, "batch_upload_domains.txt")).read().split()) if os.path.exists(os.path.join(RUN, "batch_upload_domains.txt")) else set()
    keep = [c for c in contacts if c["result"] == "KEEP" and by_dom.get(c["domain"], {}).get("decision") == "PASS"]
    keep.sort(key=lambda c: ("catch_all_queue_last" in c["flags"], c["tier"] or 9, c["domain"]))
    cols = ["email", "first_name", "last_name", "title", "tier", "agency", "domain", "city", "state", "office_count", "specialties",
            "wc_focus", "icp_reason", "evidence_url", "email_status"]
    with open(os.path.join(RUN, "approved_contacts.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for c in keep:
            a = by_dom[c["domain"]]
            city, state = where(a)
            st = c["status"] + (" (catch-all, queue last)" if "catch_all_queue_last" in c["flags"] else "") + \
                (" (email domain differs, proven)" if any(f.startswith("email_domain_proven") for f in c["flags"]) else "")
            w.writerow([c["email"], c["first"], c["last"], c["title"], c["tier"], a["company_name"], c["domain"], city, state,
                        a.get("office_count", 0), "; ".join(SPEC[s] for s in a.get("specialties", [])), "yes" if a.get("wc_focus") else "no",
                        a["reason"], a.get("evidence_url") or "", st])
    contact_by_dom = collections.defaultdict(list)
    for c in contacts:
        contact_by_dom[c["domain"]].append(c)
    with open(os.path.join(RUN, "qualified_agencies.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["agency", "domain", "city", "state", "office_count", "tx_offices", "specialties", "wc_focus", "icp_reason", "evidence_url",
                    "contact_status"])
        for a in sorted((x for x in dec if x["decision"] == "PASS"), key=lambda x: x["domain"]):
            city, state = where(a)
            cs = [c for c in contact_by_dom.get(a["domain"], [])]
            if any(c["result"] == "KEEP" for c in cs):
                status = "contact_ready"
            elif any(c["result"] == "VERIFY_PENDING" for c in cs):
                status = "pending_owner_verification"
            elif cs:
                status = "contact_held"
            elif a["domain"] in batch:
                status = "no_buyer_in_getleads_batch"
            elif picks.get(a["domain"], {}).get("pick"):
                status = "picked_not_revealed"
            else:
                status = "no_buyer_found"
            w.writerow([a["company_name"], a["domain"], city, state, a.get("office_count", 0), a.get("tx_office_count", 0),
                        "; ".join(SPEC[s] for s in a.get("specialties", [])), "yes" if a.get("wc_focus") else "no", a["reason"],
                        a.get("evidence_url") or "", status])
    with open(os.path.join(RUN, "holds.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["level", "domain", "agency", "decision", "reason_code", "reason"])
        for a in dec:
            if a["decision"] == "HOLD":
                w.writerow(["agency", a["domain"], a["company_name"], a["decision"], a["reason_code"], a["reason"]])
        for c in contacts:
            if c["result"] == "HOLD":
                w.writerow(["contact", c["domain"], by_dom.get(c["domain"], {}).get("company_name", ""), "HOLD", c["path"], "; ".join(c["holds"])])
    summ = {"approved_contacts": len(keep), "approved_catch_all": sum(1 for c in keep if "catch_all_queue_last" in c["flags"]),
            "approved_tier": dict(collections.Counter(c["tier"] for c in keep)),
            "qualified_agencies": sum(1 for a in dec if a["decision"] == "PASS"),
            "agency_holds": sum(1 for a in dec if a["decision"] == "HOLD"), "contact_holds": sum(1 for c in contacts if c["result"] == "HOLD")}
    json.dump(summ, open(os.path.join(RUN, "outputs_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
