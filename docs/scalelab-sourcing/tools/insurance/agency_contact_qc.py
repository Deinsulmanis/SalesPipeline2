"""Insurance agencies: contact QC for revealed agency decision-makers, plus GetLeads batch results (owner upload).

Usage: python3 -I agency_contact_qc.py <run_dir> [--gl-batch <getleads_batch_results.csv>]
Reads <run>/reveal/apollo.rows (tools/parse_reveal.py), <run>/icp_decisions.json, <run>/verification.json (owner
results, optional), <run>/manual_review.json (optional tighten-only {domain: reason}).
Rules (staffing skill section 9 + the owner's brief: name matches email, current role, not moved):
  - email present and not a role mailbox (info@, office@ ...);
  - email domain = agency domain (or a subdomain), or proven by a redirect / on-site reference (kept with a flag);
  - the email local part matches the person's name (first, last, or initial + last / first + initial);
  - current role: Apollo's matched organisation domain equals the agency domain (else the person moved or the record
    is another firm) and parse_reveal raised no WRONG PERSON / LOW CONFIDENCE flag;
  - the revealed title still passes ins_config.agency_tier;
  - Apollo email_status must be "verified" (Apollo emails are not re-verified; no Apollo validation is ever called);
    a catch-all domain is kept with a flag and queued last;
  - MX record present (DNS-over-HTTPS).
GetLeads batch rows (--gl-batch, the owner's download of the decision-makers batch) get the same name / domain /
title checks and are VERIFY_PENDING until the owner's verification result is ingested (to_verify.csv).
Writes <run>/contacts.json (private), <run>/to_verify.csv, <run>/verify_pending.json, <run>/contact_qc_summary.json.
Personal emails and phone numbers are never read or written.
"""
import collections, csv, json, os, re, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
GLB = sys.argv[sys.argv.index("--gl-batch") + 1] if "--gl-batch" in sys.argv else None
ROLE = re.compile(r"^(info|office|admin|contact|hello|sales|service|support|team|mail|agency|insurance|quotes?|help|reception|front|billing|accounts?)\d*$")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36"}
_mx = {}


def mx(dom):
    if dom not in _mx:
        try:
            with urllib.request.urlopen(f"https://dns.google/resolve?name={dom}&type=MX", timeout=15) as r:
                _mx[dom] = bool(json.loads(r.read()).get("Answer"))
        except Exception:
            _mx[dom] = None
    return _mx[dom]


def dom_ok(edom, d):
    return edom == d or edom.endswith("." + d)


def _final(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            return r.geturl(), r.read(400000).decode("utf-8", "ignore")
    except Exception:
        return None, ""


def proven_same_org(edom, d):
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


def name_matches(local, first, last):
    l = re.sub(r"[^a-z]", "", local.lower())
    f = re.sub(r"[^a-z]", "", (first or "").lower())
    s = re.sub(r"[^a-z]", "", (last or "").lower().split(" ")[-1])
    if not l:
        return False
    if (len(f) >= 3 and f in l) or (len(s) >= 3 and s in l):
        return True
    if f and s and (l in (f[0] + s, f + s[0], s + f[0], f[0] + s[:6]) or l.startswith(f[0] + s[:4])):
        return True
    if f and len(l) <= 3 and l.startswith(f[0]):  # initials such as "jd"
        return bool(s) and s[0] in l[1:]
    return False


def check(r, manual):
    holds, flags = [], []
    email = (r["email"] or "").strip()
    local, _, edom = email.lower().partition("@")
    d = r["domain"]
    if not email:
        holds.append("no_email")
    else:
        if ROLE.match(local):
            holds.append("role_mailbox")
        if not dom_ok(edom, d):
            proof = proven_same_org(edom, d)
            (flags.append(f"email_domain_proven:{proof}") if proof else holds.append("email_domain_differs"))
        if not name_matches(local, r["first"], r["last"]):
            holds.append("email_does_not_match_name")
        if mx(edom) is False:
            holds.append("no_mx")
    if C.agency_tier(r["title"]) is None:
        holds.append("title_not_a_decision_maker")
    if r.get("org_domain") is not None and r["org_domain"] and not dom_ok(r["org_domain"], d) and not dom_ok(d, r["org_domain"]):
        holds.append("current_employer_differs_moved")
    for fl in ("WRONG PERSON", "LOW CONFIDENCE", "NO EMAIL"):
        if fl in (r.get("parser_flags") or ""):
            holds.append(fl.lower().replace(" ", "_"))
    if r["path"] == "apollo":
        if r["status"] != "verified":
            holds.append("apollo_not_verified")
        if r.get("catchall"):
            flags.append("catch_all_queue_last")
    if d in manual:
        holds.append("manual_review: " + manual[d])
    return holds, flags


def main():
    dec = {x["domain"]: x for x in json.load(open(os.path.join(RUN, "icp_decisions.json")))}
    mp = os.path.join(RUN, "manual_review.json")
    manual = json.load(open(mp)) if os.path.exists(mp) else {}
    vp = os.path.join(RUN, "verification.json")
    ver = {k.lower(): v for k, v in json.load(open(vp)).items()} if os.path.exists(vp) else {}
    rows = []
    ap = os.path.join(RUN, "reveal", "apollo.rows")
    for ln in (open(ap) if os.path.exists(ap) else []):
        f = ln.rstrip("\n").split("|")
        if len(f) < 14:
            continue
        _, d, _, pid, name, title, email, status, catchall, _, start, loc, org_dom, flags = f[:14]
        first, _, last = name.partition(" ")
        rows.append(dict(path="apollo", domain=d, person_id=pid, first=first, last=last, title=title, email=email, status=status,
                         catchall=catchall == "True", role_start=start, loc=loc, org_domain=org_dom.lower(), parser_flags=flags))
    if GLB:
        best = {}
        for r in csv.DictReader(open(GLB, newline="", encoding="utf-8-sig")):
            low = {k.strip().lower().replace(" ", "_"): (v or "").strip() for k, v in r.items()}
            d = (low.get("domain") or low.get("company_domain") or low.get("input_domain") or "").lower().removeprefix("www.")
            email = low.get("work_email") or low.get("email") or ""
            title = low.get("title") or low.get("job_title") or ""
            first, last = low.get("first_name") or "", low.get("last_name") or ""
            if not d or d not in dec:
                continue
            t = C.agency_tier(title)
            cand = dict(path="getleads_batch", domain=d, person_id=None, first=first, last=last, title=title, email=email,
                        status=low.get("email_status") or "", catchall=False, role_start="", loc="", org_domain=None, parser_flags="", tier=t)
            if t and (d not in best or best[d]["tier"] is None or t < best[d]["tier"]):
                best[d] = cand
        rows += list(best.values())
    pending, out = [], []
    for r in rows:
        holds, flags = check(r, manual)
        result = "HOLD" if holds else "KEEP"
        if r["path"] == "getleads_batch" and not holds:
            v = ver.get(r["email"].lower())
            if not v:
                result = "VERIFY_PENDING"
                pending.append({"domain": r["domain"], "path": "getleads_decision_makers_batch", "email": r["email"]})
            elif v.get("catch_all") or v.get("validity") == "catch_all":
                flags.append("catch_all_queue_last")
            elif v.get("validity") != "valid":
                result, holds = "HOLD", [f"owner_verification_{v.get('validity') or 'unknown'}"]
        r.update(result=result, holds=holds, flags=flags, tier=(C.agency_tier(r["title"]) or (None,))[0])
        out.append(r)
    json.dump(out, open(os.path.join(RUN, "contacts.json"), "w"), indent=1)
    seen = set()
    with open(os.path.join(RUN, "to_verify.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["email"])
        for p in pending:
            if p["email"].lower() not in seen:
                seen.add(p["email"].lower())
                w.writerow([p["email"]])
    json.dump(pending, open(os.path.join(RUN, "verify_pending.json"), "w"), indent=1)
    summ = {"by_path_result": {f"{a}:{b}": n for (a, b), n in collections.Counter((r["path"], r["result"]) for r in out).items()},
            "hold_reasons": dict(collections.Counter(h.split(":")[0] for r in out for h in r["holds"])),
            "keep_catch_all": sum(1 for r in out if r["result"] == "KEEP" and "catch_all_queue_last" in r["flags"]),
            "keep_verified_not_catch_all": sum(1 for r in out if r["result"] == "KEEP" and "catch_all_queue_last" not in r["flags"]),
            "to_verify": len(seen)}
    json.dump(summ, open(os.path.join(RUN, "contact_qc_summary.json"), "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
