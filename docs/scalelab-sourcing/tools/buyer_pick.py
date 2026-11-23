"""Stage 7a: map free Apollo people-search lines to company domains and pick one buyer per company
in the playbook's buyer order (no randomization). Free; reveals nothing.

Usage:  python3 -I buyer_pick.py <run> <part> [<part> ...]

For each part P (e.g. P1), reads <run>/buyers/P_batches.json (array of domain batches sent to
apollo_mixed_people_api_search) and <run>/buyers/P.txt, one line per person:
    batch_index|organization_name|person_id|first_name|last_name_obfuscated|title|has_email
The person's organization name is matched to a domain in its own batch (Apollo names, same source
as companies.json). Optional <run>/buyers/org_alias.json maps a reviewed parent/brand name to its
domain ({"JCS Family": "jobconnectionservices.com"}); contact QC still checks the email domain.

Buyer order (playbook): tier 1 owner / founder / president / CEO / managing partner; tier 2 CRO /
VP sales or business development / senior commercial executive (COO, CMO and an unqualified VP
rank after the commercial titles). Directors are tier 3 and not searched here. Managing directors,
finance, technology, HR, operations-only and recruiting titles are never picked.

Writes:
  <run>/people_by_domain.json   every mapped person, with tier, per domain
  <run>/buyer_picks.json        {domain: picked person (has_email true) or null, plus counts}
  <run>/targets.json            reveal targets in the toolkit format (domain, id, first, last, title, tier, source)
"""
import json
import os
import re
import sys

RUN = sys.argv[1]
PARTS = sys.argv[2:]

T1 = [(0, r"\b(owner|co-?owner|founder|co-?founder|proprietor)\b"),
      (1, r"(?<!vice )\bpresident\b|\bceo\b|chief executive"),
      (2, r"managing partner|\bprincipal\b")]
T2 = [(0, r"chief revenue|\bcro\b|chief sales|chief commercial|chief growth|chief business development"),
      (1, r"(vp|vice president|svp|evp)\b.*\b(sales|business development|growth|revenue|commercial|client|account)"),
      (2, r"\bcoo\b|chief operating|\bcmo\b|chief marketing|^(vp|vice president|svp|evp)$|\bpartner\b")]
NEVER = r"managing director|\bcfo\b|financ|account(ing|ant)|controller|\bcto\b|\bcio\b|technolog|information|\bhr\b|human|people|talent acq|recruit|payroll|compliance|legal|counsel|\bit\b|engineer|operations manager|branch|office manager|assistant|board member|advisor|investor|retired|former"


def tier(title):
    t = (title or "").lower().strip()
    if not t or re.search(NEVER, t):
        return None
    for rank, pat in T1:
        if re.search(pat, t):
            return (1, rank)
    for rank, pat in T2:
        if re.search(pat, t):
            return (2, rank)
    return None


def norm(name):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (name or "").lower()).split())


def main():
    names = {c["domain"]: c["company_name"] for c in json.load(open(os.path.join(RUN, "companies.json")))}
    alias_path = os.path.join(RUN, "buyers", "org_alias.json")
    alias = {norm(k): v for k, v in json.load(open(alias_path)).items()} if os.path.exists(alias_path) else {}
    people, unmapped = {}, []
    searched = set()
    for part in PARTS:
        batches = json.load(open(os.path.join(RUN, "buyers", part + "_batches.json")))
        for b in batches:
            searched.update(b)
        path = os.path.join(RUN, "buyers", part + ".txt")
        if not os.path.exists(path):
            print("missing", path); continue
        for line in open(path, encoding="utf-8", errors="replace"):
            f = line.rstrip("\n").split("|")
            if len(f) < 7 or f[1] == "NONE":
                continue
            bi, org, pid, first, last, title, has = f[:7]
            try:
                batch = batches[int(bi)]
            except (ValueError, IndexError):
                unmapped.append(line.strip()); continue
            n = norm(org)
            dom = alias.get(n) if alias.get(n) in batch else None
            dom = dom or next((d for d in batch if norm(names.get(d)) == n), None)
            if not dom:  # Apollo sometimes trims suffixes: fall back to a prefix match within the batch
                dom = next((d for d in batch if norm(names.get(d)) and (norm(names.get(d)).startswith(n) or n.startswith(norm(names.get(d))))), None)
            if not dom:
                unmapped.append(line.strip()); continue
            tr = tier(title)
            people.setdefault(dom, []).append(dict(id=pid, first=first.strip(), last_obf=last.strip(), title=title.strip(),
                                                   has_email=has.strip().lower() == "true",
                                                   tier=tr[0] if tr else None, rank=tr[1] if tr else None))
    picks, targets = {}, []
    for d in sorted(searched):
        cands = [p for p in people.get(d, []) if p["tier"] and p["has_email"]]
        cands.sort(key=lambda p: (p["tier"], p["rank"]))
        pick = cands[0] if cands else None
        picks[d] = dict(pick=pick, people=len(people.get(d, [])),
                        eligible_without_email=sum(1 for p in people.get(d, []) if p["tier"] and not p["has_email"]))
        if pick:
            targets.append(dict(domain=d, id=pick["id"], first=pick["first"], last="", title=pick["title"],
                                tier=pick["tier"], source="apollo_free_search"))
    json.dump(people, open(os.path.join(RUN, "people_by_domain.json"), "w"), indent=1)
    json.dump(picks, open(os.path.join(RUN, "buyer_picks.json"), "w"), indent=1)
    json.dump(targets, open(os.path.join(RUN, "targets.json"), "w"), indent=1)
    t1 = sum(1 for t in targets if t["tier"] == 1)
    print(json.dumps(dict(searched=len(searched), with_people=len(people), unmapped_lines=len(unmapped),
                          picked=len(targets), tier1=t1, tier2=len(targets) - t1,
                          no_buyer_email=sum(1 for v in picks.values() if not v["pick"])), indent=1))
    if unmapped:
        print("unmapped sample:", unmapped[:5])


if __name__ == "__main__":
    main()
