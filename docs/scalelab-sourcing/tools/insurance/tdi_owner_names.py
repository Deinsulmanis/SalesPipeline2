"""TDI licence relationships -> decision-maker names for agencies without a contact (for the owner's Names+companies
upload). Free, read-only open data (data.texas.gov kvqi-vsrr), no lookup or spend.
Desig-Resp-Lic-Person names are the licence's responsible person (usually the principal at a small agency); whatever
the owner's upload returns still has to pass the Tier 1/2 title rule before it can be approved.

Usage: python3 -I tdi_owner_names.py <out_csv> <targets.json> <relationships.json> [--existing <owner_names.csv>]
  targets.json  {domain: {"agency": name, "tdi_npn": optional}}
An agency is matched to its licence by NPN when known, else by its normalised name (legal suffixes dropped). People
are taken in this order: Owner, Partner, Officer/Director, Qualifying Active Officer, Member, Resp. Person,
Desig-Resp-Lic-Person; businesses (holding companies) are skipped. One person per agency. Rows already present in
--existing (site-named owners) win. Writes <out_csv> (first_name, last_name, company_name, company_domain) and prints counts.
"""
import collections, csv, json, os, re, sys

ORDER = ["Owner", "Partner", "Officer/Director", "Qualifying Active Officer", "Member", "Resp. Person", "Desig-Resp-Lic-Person"]
BIZ = re.compile(r"(?i)\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|lp|llp|ltd|group|holdings|agency|insurance|partners|trust|enterprises|services|associates|financial)\b")
SUF = re.compile(r"(?i)\b(llc|l l c|inc|incorporated|corp|corporation|co|company|lp|llp|ltd|pllc|pc|dba|the)\b")


def norm(n):
    n = re.sub(r"[^a-z0-9 ]", " ", (n or "").lower().replace("&", " and "))
    return " ".join(SUF.sub(" ", n).split())


def person(name):
    if not name or BIZ.search(name):
        return None
    if "," in name:
        last, _, rest = name.partition(",")
        first = rest.strip().split(" ")[0] if rest.strip() else ""
    else:
        parts = name.split()
        if len(parts) < 2:
            return None
        first, last = parts[0], parts[-1]
        if last.rstrip(".").upper() in ("JR", "SR", "II", "III", "IV") and len(parts) >= 3:
            last = parts[-2]
    first, last = first.strip().title(), last.strip().title()
    return (first, last) if len(first) > 1 and len(last) > 1 else None


def main():
    out_p, targets, rel_p = sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3]
    existing = {}
    if "--existing" in sys.argv:
        for r in csv.DictReader(open(sys.argv[sys.argv.index("--existing") + 1])):
            existing[r["company_domain"]] = r
    by_npn, by_name = collections.defaultdict(list), collections.defaultdict(list)
    for r in json.load(open(rel_p)):
        # kvqi-vsrr: for "Owner" rows the licensee is the owned agency and the associated licensee its owner; for every
        # other role the associated licensee is the agency and the licensee the person holding the role there
        typ = r.get("association_type")
        if typ not in ORDER:
            continue
        if typ == "Owner":
            who, ag_npn, ag_name = r.get("associated_licensee_name"), r.get("licensee_npn"), r.get("licensee_name")
        else:
            who, ag_npn, ag_name = r.get("licensee_name"), r.get("associated_licensee_npn"), r.get("associated_licensee_name")
        p = person(who)
        if not p or norm(who) == norm(ag_name):  # sole proprietor licence: the agency is the person
            continue
        rank = ORDER.index(typ)
        if ag_npn:
            by_npn[ag_npn].append((rank, p))
        if norm(ag_name):
            by_name[norm(ag_name)].append((rank, p))
    rows, stats = [], collections.Counter()
    for d, t in sorted(targets.items()):
        if d in existing:
            rows.append([existing[d]["first_name"], existing[d]["last_name"], existing[d]["company_name"], d])
            stats["site_named"] += 1
            continue
        if (t.get("cohort") or "A_TX") != "A_TX":  # TDI is Texas licence data: never name-match agencies in other states
            stats["no_name_non_texas"] += 1
            continue
        cands = (by_npn.get(t["tdi_npn"]) if t.get("tdi_npn") else None) or (by_name.get(norm(t.get("agency"))) if norm(t.get("agency")) else None)
        if cands:
            rank, (first, last) = sorted(cands)[0]
            rows.append([first, last, t.get("agency") or "", d])
            stats["tdi_" + ORDER[rank].lower().replace("/", "_").replace(" ", "_").replace(".", "")] += 1
        else:
            stats["no_name"] += 1
    with open(out_p, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["first_name", "last_name", "company_name", "company_domain"])
        w.writerows(rows)
    print(json.dumps({"agencies": len(targets), "rows": len(rows), **dict(stats)}))


if __name__ == "__main__":
    main()
