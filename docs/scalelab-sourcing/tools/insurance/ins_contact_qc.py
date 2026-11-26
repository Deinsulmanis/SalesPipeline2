"""Insurance pilot, employer side: contact QC over the Apollo reveal path and the GetLeads decision-maker path.

Usage: python3 -I ins_contact_qc.py <run_dir>
Reads  <run>/reveal/apollo.rows (tools/parse_reveal.py), <run>/reveal/targets_ordered.json, <run>/gl/DD1.txt
       (tools/gl_lines.py), <run>/match/{sample,resolved,employer_picks}.json, <run>/verification.json (owner results,
       optional; written by ingest_ins_verification.py)
Rules (staffing skill section 9, adapted):
  - email domain must equal the employer's resolved domain (or a subdomain of it); otherwise HOLD;
  - the revealed / returned title must pass the insurance employer buyer rule (ins_config.employer_tier);
  - the person must be US-based (Apollo state is a US state); otherwise HOLD;
  - the email domain must have an MX record (DNS-over-HTTPS); otherwise HOLD;
  - Apollo: email_status must be "verified"; Apollo catch-all is kept with a caution flag (queue last);
  - GetLeads: VERIFY_PENDING until the owner's GetLeads result comes back (to_verify.csv). Owner results map:
    valid keep; catch-all / accept-all keep + flag; invalid / unknown / risky HOLD.
Writes <run>/match/contact_qc.json, <run>/match/contacts_private.csv (git-ignored run folder: names and emails),
<run>/to_verify.csv (one column "email"), <run>/verify_pending.json and prints counts only.
Personal emails and phone numbers are never read or written.
"""
import collections
import csv
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
US_STATES = {"alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
             "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
             "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
             "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
             "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
             "wisconsin", "wyoming", "district of columbia"}
_mx = {}


def mx(dom):
    if dom not in _mx:
        try:
            with urllib.request.urlopen(f"https://dns.google/resolve?name={dom}&type=MX", timeout=15) as r:
                _mx[dom] = bool(json.loads(r.read()).get("Answer"))
        except Exception:
            _mx[dom] = None
    return _mx[dom]


UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36"}


def _final(url):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.geturl(), r.read(400000).decode("utf-8", "ignore")
    except Exception:
        return None, ""


def proven_same_org(edom, d):
    """Staffing-skill rule: a differing email domain is kept (with caution) only when proven by a redirect either way
    or by the company site referencing the email domain."""
    host = lambda u: (u or "").split("//")[-1].split("/")[0].lower().removeprefix("www.")
    fe, _ = _final(f"https://{edom}")
    if fe and dom_ok(host(fe), d):
        return "redirect_email_domain_to_site"
    fd, body = _final(f"https://{d}")
    if fd and dom_ok(host(fd), edom):
        return "redirect_site_to_email_domain"
    if body and ("@" + edom) in body.lower():
        return "site_references_email_domain"
    return None


def dom_ok(edom, d):
    return edom == d or edom.endswith("." + d)


def load_verification():
    p = os.path.join(RUN, "verification.json")
    return {k.lower(): v for k, v in json.load(open(p)).items()} if os.path.exists(p) else {}


def main():
    sample = {s["emp_id"]: s for s in json.load(open(os.path.join(RUN, "match", "sample.json")))}
    picks = json.load(open(os.path.join(RUN, "match", "employer_picks.json")))
    dom2emp = {d: v["emp_id"] for d, v in picks.items()}
    ver = load_verification()
    mr_path = os.path.join(RUN, "match", "manual_review.json")  # tighten-only reviewer holds {domain: reason}
    manual = json.load(open(mr_path)) if os.path.exists(mr_path) else {}
    rows, qc = [], {}

    # Apollo path
    for ln in open(os.path.join(RUN, "reveal", "apollo.rows")):
        f = ln.rstrip("\n").split("|")
        if len(f) < 14 or f[2] == "NO MATCH":
            continue
        _, d, _, pid, name, title, email, status, catchall, _, _, loc, org_dom, flags = f[:14]
        first, _, last = name.partition(" ")
        rows.append(dict(path="apollo", domain=d, first=first, last=last, title=title, email=email, status=status,
                         catchall=catchall == "True", loc=loc, parser_flags=flags))
    # GetLeads path: best title per domain under the insurance buyer rule
    gl_best = {}
    gp = os.path.join(RUN, "gl", "DD1.txt")
    for ln in (open(gp) if os.path.exists(gp) else []):
        f = ln.rstrip("\n").split("|")
        if len(f) < 10 or f[1] in ("NONE", "ERROR"):
            continue
        d, first, last, title, _, email, status = f[:7]
        t = C.employer_tier(title)
        cand = dict(path="getleads", domain=d, first=first, last=last, title=title, email=email, status=status, catchall=False,
                    loc="", parser_flags="", tier=t)
        cur = gl_best.get(d)
        if t and (cur is None or cur["tier"] is None or t < cur["tier"]):
            gl_best[d] = cand
        elif cur is None:
            gl_best[d] = cand
    gl_no_eligible = sum(1 for v in gl_best.values() if v["tier"] is None)
    rows += [v for v in gl_best.values() if v["tier"]]

    pending = []
    for r in rows:
        d, email = r["domain"], (r["email"] or "").strip()
        edom = email.split("@")[-1].lower() if "@" in email else ""
        holds, flags = [], []
        if not email:
            holds.append("no_email")
        elif not dom_ok(edom, d):
            proof = proven_same_org(edom, d)
            if proof:
                flags.append(f"email_domain_differs_proven:{proof}")
            else:
                holds.append("email_domain_differs")
        if C.employer_tier(r["title"]) is None:
            holds.append("title_not_a_buyer")
        if r["path"] == "apollo":
            st = (r["loc"].split(", ")[-1] if r["loc"] else "").lower()
            if st and st not in US_STATES:
                holds.append("person_outside_us")
            if r["status"] != "verified":
                holds.append("apollo_not_verified")
            if r["catchall"]:
                flags.append("catch_all_queue_last")
        if d in manual:
            holds.append("manual_review: " + manual[d])
        if edom and mx(edom) is False:
            holds.append("no_mx")
        result = "HOLD" if holds else "KEEP"
        if r["path"] == "getleads" and not holds:
            v = ver.get(email.lower())
            if not v:
                result = "VERIFY_PENDING"
                pending.append({"domain": d, "path": "getleads_decision_makers", "email": email})
            else:
                val = (v.get("validity") or "").lower()
                if v.get("catch_all") or val in ("catch-all", "catch_all", "accept-all", "accept_all"):
                    flags.append("catch_all_queue_last")
                elif val != "valid":
                    result, holds = "HOLD", holds + [f"owner_verification_{val or 'unknown'}"]
        r.update(result=result, holds=holds, flags=flags, emp_id=dom2emp.get(d))
        qc[d] = {"path": r["path"], "result": result, "holds": holds, "flags": flags}

    with open(os.path.join(RUN, "match", "contacts_private.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["emp_id", "employer_name", "domain", "path", "first", "last", "title", "email", "email_status", "qc", "holds", "flags",
                    "industry", "metro", "carrier", "renewal_month", "premium_band"])
        for r in rows:
            s = sample.get(r["emp_id"]) or {}
            w.writerow([r["emp_id"], s.get("employer_name"), r["domain"], r["path"], r["first"], r["last"], r["title"], r["email"], r["status"],
                        r["result"], ";".join(r["holds"]), ";".join(r["flags"]), s.get("industry"), s.get("metro"), s.get("carrier"),
                        s.get("renewal_month"), s.get("premium_band")])
    seen = set()
    with open(os.path.join(RUN, "to_verify.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["email"])
        for p in pending:
            if p["email"].lower() not in seen:
                seen.add(p["email"].lower())
                w.writerow([p["email"]])
    json.dump(pending, open(os.path.join(RUN, "verify_pending.json"), "w"), indent=1)
    json.dump(qc, open(os.path.join(RUN, "match", "contact_qc.json"), "w"), indent=1)
    summ = collections.Counter((r["path"], r["result"]) for r in rows)
    holds = collections.Counter(h for r in rows for h in r["holds"])
    out = {"by_path_result": {f"{k[0]}:{k[1]}": v for k, v in summ.items()}, "hold_reasons": dict(holds),
           "caution_catch_all": sum(1 for r in rows if "catch_all_queue_last" in r["flags"]),
           "caution_domain_proven": sum(1 for r in rows if any(f.startswith("email_domain_differs_proven") for f in r["flags"])), "getleads_domains_no_eligible_title": gl_no_eligible,
           "to_verify": len(seen)}
    json.dump(out, open(os.path.join(RUN, "match", "qc_summary.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
