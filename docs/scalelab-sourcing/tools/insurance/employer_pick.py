"""Insurance pilot: pick one employer-side decision-maker per resolved employer from the free Apollo people search.

Usage: python3 -I employer_pick.py <run_dir> [<part> ...]   (default part E1)
Input lines come from tools/apollo_lines.py (<run>/buyers/<part>.txt + <part>_batches.json). Organisation names are
mapped to a domain inside their own batch via the Apollo name saved by domain_resolve.py; a one-domain batch maps
directly. Buyer order: ins_config.employer_tier (owner / president / CEO first; then CFO, controller, VP finance or
operations, COO, general manager; HR / safety only when nobody above has an email on file). Free; reveals nothing.
Writes <run>/match/people_by_domain.json, <run>/match/employer_picks.json and <run>/reveal/targets_ordered.json.
"""
import collections, json, os, sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.dirname(TOOLS))
import ins_config as C  # noqa: E402
from buyer_pick import norm  # noqa: E402  (shared name normaliser; staffing buyer rule is not used)

RUN = sys.argv[1]
PARTS = sys.argv[2:] or ["E1"]


def main():
    res = json.load(open(os.path.join(RUN, "match", "resolved.json")))
    dom2emp = {}
    apname = {}
    for eid, r in res.items():
        if r["status"] == "resolved":
            dom2emp.setdefault(r["domain"], eid)
            apname[r["domain"]] = r.get("apollo_name") or ""
    people, unmapped, searched = collections.defaultdict(list), [], set()
    for part in PARTS:
        batches = json.load(open(os.path.join(RUN, "buyers", f"{part}_batches.json")))
        for b in batches:
            searched.update(b)
        path = os.path.join(RUN, "buyers", f"{part}.txt")
        for line in (open(path, encoding="utf-8", errors="replace") if os.path.exists(path) else []):
            f = line.rstrip("\n").split("|")
            if len(f) < 7:
                continue
            bi, org, pid, first, last, title, has = f[:7]
            batch = batches[int(bi)]
            if len(batch) == 1:
                dom = batch[0]
            else:
                n = norm(org)
                dom = next((d for d in batch if norm(apname.get(d)) == n), None) or next(
                    (d for d in batch if norm(apname.get(d)) and (norm(apname[d]).startswith(n) or n.startswith(norm(apname[d])))), None)
            if not dom:
                unmapped.append(bi)
                continue
            t = C.employer_tier(title)
            people[dom].append(dict(id=pid, first=first.strip(), last_obf=last.strip(), title=title.strip(),
                                    has_email=has.strip().lower() == "true", tier=t[0] if t else None, rank=t[1] if t else None))
    picks, targets, stats = {}, [], collections.Counter()
    for d in sorted(searched):
        ps = people.get(d, [])
        has12 = any(p["tier"] in (1, 2) and p["has_email"] for p in ps)
        cands = [p for p in ps if p["tier"] and p["has_email"] and (p["tier"] in (1, 2) or not has12)]
        cands.sort(key=lambda p: (p["tier"], p["rank"]))
        pick = cands[0] if cands else None
        picks[d] = dict(emp_id=dom2emp.get(d), pick=pick, people=len(ps),
                        eligible_without_email=sum(1 for p in ps if p["tier"] and not p["has_email"]))
        stats["searched"] += 1
        stats["with_people"] += bool(ps)
        if pick:
            stats[f"picked_tier{pick['tier']}"] += 1
            targets.append(dict(domain=d, emp_id=dom2emp.get(d), id=pick["id"], first=pick["first"], last="", title=pick["title"],
                                tier=pick["tier"], source="apollo_free_search"))
        elif any(p["tier"] for p in ps):
            stats["eligible_title_no_email"] += 1
        elif ps:
            stats["people_but_no_eligible_title"] += 1
        else:
            stats["no_people"] += 1
    targets.sort(key=lambda t: (t["tier"], t["domain"]))
    os.makedirs(os.path.join(RUN, "reveal"), exist_ok=True)
    json.dump(people, open(os.path.join(RUN, "match", "people_by_domain.json"), "w"), indent=1)
    json.dump(picks, open(os.path.join(RUN, "match", "employer_picks.json"), "w"), indent=1)
    json.dump(targets, open(os.path.join(RUN, "reveal", "targets_ordered.json"), "w"), indent=1)
    stats["picked"] = len(targets)
    stats["unmapped_lines"] = len(unmapped)
    print(json.dumps(dict(stats), indent=1))


if __name__ == "__main__":
    main()
