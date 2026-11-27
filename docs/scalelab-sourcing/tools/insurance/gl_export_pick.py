"""Insurance agencies: pick + QC decision-makers from GetLeads contact exports (owner decision 2026-11-27).

Usage: python3 -I gl_export_pick.py <out_json> <targets.json> <export.csv> [<export.csv> ...]
  targets.json  {domain: {"agency": name, "cohort": "A_TX"|"A_OR", "source": "...", "employees": int|None}}
One contact per agency, picked by ins_config.agency_tier / agency_can_pick (Tier 3 senior commercial producer only
with no Tier 1/2 and <= 50 staff). QC (same rules as agency_contact_qc.py, whose helpers are imported, no copies):
  - work email present, not a role mailbox; personal_emails is never read;
  - email domain = agency domain (or subdomain), else proven same firm (redirect / on-site reference);
  - the email matches the person's name;
  - current employer website / company domain is the agency (not moved);
  - email_status VALID -> verified (owner decision: GetLeads VALID counts as verified, no re-verification);
    CATCH_ALL / UNKNOWN -> VERIFY_PENDING (to_verify.csv for the owner); anything else -> HOLD.
Writes <out_json>: [{domain, agency, cohort, source, first, last, title, tier, email, email_status, result, holds,
flags, city, state}] and prints counts only.
"""
import collections, csv, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ins_config as C  # noqa: E402
_argv, sys.argv = sys.argv, [sys.argv[0], "."]
import agency_contact_qc as Q  # noqa: E402  (helpers only: name_matches, proven_same_org, mx, dom_ok, ROLE)
sys.argv = _argv


def host(u):
    return (u or "").split("//")[-1].split("/")[0].lower().removeprefix("www.")


def emp_upper(v):
    nums = [int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", v or "")]
    return max(nums) if nums else None


def main():
    out_p, targets = sys.argv[1], json.load(open(sys.argv[2]))
    rows = []
    for f in sys.argv[3:]:
        rows += list(csv.DictReader(open(f, newline="", encoding="utf-8-sig")))
    by_dom = collections.defaultdict(list)
    for r in rows:
        d = host(r.get("company_domain") or r.get("current_employer_website") or "")
        edom = (r.get("work_email") or "").split("@")[-1].lower()
        if d not in targets:  # match by email domain when the company domain is missing or a variant
            d = next((t for t in (d, edom) if t in targets), d)
        if d in targets:
            by_dom[d].append(r)
    out, stats = [], collections.Counter()
    for d, rs in by_dom.items():
        t = targets[d]
        cands = []
        for r in rs:
            tr = C.agency_tier(r.get("current_title"))
            if tr:
                cands.append((tr, r))
        has12 = any(tr[0] in (1, 2) for tr, _ in cands)
        emp = t.get("employees") or emp_upper(rs[0].get("employee_count_range"))
        cands = sorted([(tr, r) for tr, r in cands if C.agency_can_pick(tr[0], has12, emp)], key=lambda x: x[0])
        if not cands:
            stats["no_eligible_title"] += 1
            continue
        tr, r = cands[0]
        email = (r.get("work_email") or "").strip()
        local, _, edom = email.lower().partition("@")
        holds, flags = [], []
        if not email:
            holds.append("no_email")
        else:
            if Q.ROLE.match(local):
                holds.append("role_mailbox")
            if not Q.dom_ok(edom, d):
                proof = Q.proven_same_org(edom, d)
                (flags.append(f"email_domain_proven:{proof}") if proof else holds.append("email_domain_differs"))
            if not Q.name_matches(local, r.get("first_name"), r.get("last_name")):
                holds.append("email_does_not_match_name")
            if Q.mx(edom) is False:
                holds.append("no_mx")
        cur = host(r.get("current_employer_website") or r.get("company_domain"))
        if cur and not (Q.dom_ok(cur, d) or Q.dom_ok(d, cur) or cur == edom):
            holds.append("current_employer_differs_moved")
        st = (r.get("email_status") or "").upper()
        if holds:
            result = "HOLD"
        elif st == "VALID":
            result = "KEEP"
        elif st in ("CATCH_ALL", "UNKNOWN"):
            result = "VERIFY_PENDING"
        else:
            result, holds = "HOLD", [f"email_status_{st.lower() or 'missing'}"]
        stats[f"{result}"] += 1
        out.append(dict(domain=d, agency=t.get("agency"), cohort=t.get("cohort"), source=t.get("source"), first=r.get("first_name"),
                        last=r.get("last_name"), title=r.get("current_title"), tier=tr[0], email=email, email_status=st, result=result,
                        holds=holds, flags=flags, city=r.get("contact_city") or "", state=r.get("contact_state") or ""))
    json.dump(out, open(out_p, "w"), indent=1)
    print(json.dumps({"export_rows": len(rows), "agencies_with_rows": len(by_dom), **dict(stats),
                      "hold_reasons": dict(collections.Counter(h for o in out for h in o["holds"])),
                      "tier": dict(collections.Counter(o["tier"] for o in out if o["result"] != "HOLD"))}, indent=1))


if __name__ == "__main__":
    main()
