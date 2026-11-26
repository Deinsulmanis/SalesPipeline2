"""Insurance agencies: pick one decision-maker per PASS agency from the free Apollo people search.

Usage: python3 -I agency_pick.py <run_dir> <part> [<part> ...]
Input lines come from tools/apollo_lines.py (<run>/buyers/<part>.txt + <part>_batches.json). Organisation names map
to a domain inside their own batch by the discovery name in <run>/companies.json (same Apollo source; prefix
fallback; one-domain batches map directly; optional <run>/buyers/org_alias.json). Buyer order: ins_config.agency_tier
(Tier 1 principal / owner / president / CEO / founder / managing partner / partner first; Tier 2 commercial-lines or
sales leader). Producers, agents, account managers and CSRs are never picked. Free; reveals nothing.
Writes <run>/people_by_domain.json, <run>/buyer_picks.json, <run>/reveal/targets_ordered.json (Tier 1 first) and
<run>/no_buyer_domains.json.
"""
import collections, json, os, sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.dirname(TOOLS))
import ins_config as C  # noqa: E402
from buyer_pick import norm  # noqa: E402  (shared name normaliser only)

RUN = sys.argv[1]
PARTS = sys.argv[2:]


def main():
    names = {c["domain"]: c["company_name"] for c in json.load(open(os.path.join(RUN, "companies.json")))}
    ap = os.path.join(RUN, "buyers", "org_alias.json")
    alias = {norm(k): v for k, v in json.load(open(ap)).items()} if os.path.exists(ap) else {}
    people, searched, unmapped = collections.defaultdict(list), set(), 0
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
            n = norm(org)
            if len(batch) == 1:
                dom = batch[0]
            else:
                dom = alias.get(n) if alias.get(n) in batch else None
                dom = dom or next((d for d in batch if norm(names.get(d)) == n), None) or next(
                    (d for d in batch if norm(names.get(d)) and (norm(names[d]).startswith(n) or n.startswith(norm(names[d])))), None)
            if not dom:
                unmapped += 1
                continue
            t = C.agency_tier(title)
            if any(p["id"] == pid for p in people[dom]):
                continue
            people[dom].append(dict(id=pid, first=first.strip(), last_obf=last.strip(), title=title.strip(),
                                    has_email=has.strip().lower() == "true", tier=t[0] if t else None, rank=t[1] if t else None))
    picks, targets, stats = {}, [], collections.Counter()
    for d in sorted(searched):
        ps = people.get(d, [])
        cands = sorted([p for p in ps if p["tier"] and p["has_email"]], key=lambda p: (p["tier"], p["rank"]))
        pick = cands[0] if cands else None
        picks[d] = dict(pick=pick, people=len(ps), eligible_without_email=sum(1 for p in ps if p["tier"] and not p["has_email"]))
        if pick:
            stats[f"picked_tier{pick['tier']}"] += 1
            targets.append(dict(domain=d, id=pick["id"], first=pick["first"], last="", title=pick["title"], tier=pick["tier"], source="apollo_free_search"))
        elif any(p["tier"] for p in ps):
            stats["eligible_title_no_email"] += 1
        elif ps:
            stats["people_but_no_eligible_title"] += 1
        else:
            stats["no_people"] += 1
    targets.sort(key=lambda t: (t["tier"], t["domain"]))
    os.makedirs(os.path.join(RUN, "reveal"), exist_ok=True)
    json.dump(people, open(os.path.join(RUN, "people_by_domain.json"), "w"), indent=1)
    json.dump(picks, open(os.path.join(RUN, "buyer_picks.json"), "w"), indent=1)
    json.dump(targets, open(os.path.join(RUN, "reveal", "targets_ordered.json"), "w"), indent=1)
    json.dump(sorted(d for d, v in picks.items() if not v["pick"]), open(os.path.join(RUN, "no_buyer_domains.json"), "w"), indent=1)
    print(json.dumps(dict(searched=len(searched), with_people=sum(1 for d in searched if people.get(d)), picked=len(targets),
                          unmapped_lines=unmapped, **stats), indent=1))


if __name__ == "__main__":
    main()
