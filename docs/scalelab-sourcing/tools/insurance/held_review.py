"""Re-review held agency contacts: is an email on a different domain the same firm?

Usage: python3 -I held_review.py <agency_run_dir> <out_dir>
Reads <run>/contacts.json (agency_contact_qc.py), <run>/icp_decisions.json, <run>/sitecache/, <run>/reveal/*_batch*.json
(Apollo organisation names). For every HOLD whose only blocking reasons are "email_domain_differs" (plus nothing else),
proof that the email domain is the same firm is any of:
  redirect          one domain redirects to the other (either way)
  same_phone        a phone number appears on both sites
  same_address      a street address (number + ZIP) appears on both sites
  names_each_other  one site names or links the other domain, or the email-domain site shows the agency's distinctive name
  apollo_org_name   Apollo's current organisation for the person matches the agency name
Approved rows get flag email_domain_proven:<proof>. Everything else stays held, grouped by reason.
Writes <out>/held_review.json (private) and prints counts.
"""
import collections, glob, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from domain_resolve import core  # noqa: E402

RUN, OUT = sys.argv[1], sys.argv[2]
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36"}
PHONE = re.compile(r"\(?\b([2-9]\d{2})\)?[-. ]?(\d{3})[-. ]?(\d{4})\b")
ADDR = re.compile(r"\b(\d{2,6})\s+[A-Za-z0-9 .]{3,40}?\b(\d{5})\b")
GENERIC = {"insurance", "agency", "agencies", "group", "services", "service", "ins", "and", "the", "of", "associates", "company", "partners", "financial"}


def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            return r.geturl(), r.read(600000).decode("utf-8", "ignore")
    except Exception:
        return None, ""


def text(h):
    h = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", h)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h))


def site_text(dom, cache_dir=None):
    if cache_dir and os.path.exists(os.path.join(cache_dir, dom + ".json")):
        rec = json.load(open(os.path.join(cache_dir, dom + ".json")))
        return " ".join(p.get("text") or "" for p in rec.get("pages", [])), [p.get("final_url") or "" for p in rec.get("pages", [])], ""
    final, h = fetch(f"https://{dom}")
    t = text(h)
    m = re.search(r'href=["\']([^"\']*(contact|about)[^"\']*)', h, re.I)
    if m:
        u = m.group(1) if m.group(1).startswith("http") else f"https://{dom}/" + m.group(1).lstrip("/")
        t += " " + text(fetch(u)[1])
    return t, [final or ""], h


def host(u):
    return (u or "").split("//")[-1].split("/")[0].lower().removeprefix("www.")


def main():
    contacts = json.load(open(os.path.join(RUN, "contacts.json")))
    dec = {x["domain"]: x for x in json.load(open(os.path.join(RUN, "icp_decisions.json")))}
    orgname = {}
    for f in glob.glob(os.path.join(RUN, "reveal", "*_batch*.json")):
        d = json.load(open(f))
        if isinstance(d, dict):
            for m in d.get("matches") or []:
                orgname[m.get("id")] = (m.get("organization") or {}).get("name") or ""
    out, stats = [], collections.Counter()
    for c in contacts:
        if c["result"] != "HOLD":
            continue
        reasons = [h.split(":")[0] for h in c["holds"]]
        rec = {"domain": c["domain"], "path": c["path"], "email": c["email"], "first": c["first"], "last": c["last"], "title": c["title"],
               "holds": c["holds"], "decision": "HOLD", "proof": None}
        if set(reasons) == {"email_domain_differs"}:
            d, edom = c["domain"], c["email"].split("@")[-1].lower()
            at, af, _ = site_text(d, os.path.join(RUN, "sitecache"))
            et, ef, eh = site_text(edom)
            agency = dec.get(d, {}).get("company_name", "")
            distinct = [w for w in core(agency) if w not in GENERIC and len(w) >= 3]
            proof = None
            if any(host(u) == d or host(u).endswith("." + d) for u in ef) or any(host(u) == edom for u in af):
                proof = "redirect"
            if not proof:
                pa = {"".join(m) for m in PHONE.findall(at)}
                pe = {"".join(m) for m in PHONE.findall(et)}
                if pa & pe:
                    proof = "same_phone"
            if not proof:
                aa = {(n, z) for n, z in ADDR.findall(at)}
                ae = {(n, z) for n, z in ADDR.findall(et)}
                if aa & ae:
                    proof = "same_address"
            if not proof:
                lt, le = at.lower(), et.lower()
                if edom in lt or d in le or (distinct and all(w in le for w in distinct[:3])):
                    proof = "names_each_other"
            if not proof and c.get("person_id") and distinct:
                on = orgname.get(c["person_id"], "").lower()
                if all(w in on for w in distinct[:3]):
                    proof = "apollo_org_name"
            if proof:
                rec.update(decision="APPROVE", proof=proof)
                stats["approve:" + proof] += 1
            else:
                stats["hold:email_domain_differs_unproven"] += 1
        else:
            stats["hold:" + "+".join(sorted(set(reasons)))] += 1
        out.append(rec)
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, "held_review.json"), "w"), indent=1)
    print(json.dumps({"held": len(out), **dict(stats)}, indent=1))


if __name__ == "__main__":
    main()
