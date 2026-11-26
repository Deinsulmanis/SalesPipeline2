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
rank after the commercial titles; a bare "Partner" ranks there too, while "Talent Partner" or
"Business Partner" style recruiter titles are never picked). Directors are tier 3 and not searched here. Managing directors,
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

RUN = sys.argv[1] if len(sys.argv) > 1 else ""
PARTS = sys.argv[2:]

# ---- Buyer rule (owner decisions 2026-11-23 / 2026-11-24). Every tool imports this module; no copies.
# 1. TOP TITLE WINS: owner, co-owner, founder, co-founder, proprietor, president (not vice president), CEO, chief
#    executive -> Tier 1, even combined with an excluded word ("President and Managing Director", "Owner/CFO",
#    "President & CEO, Executive Recruiter"). Not for non-current, governance or support titles (former, retired, past,
#    emeritus, board, assistant / secretary / associate, "... to the CEO").
# 2. Otherwise the exclusion list (NEVER) removes the title, except the two Tier 3 titles it names.
# 3. Tier 1: managing partner / principal. Tier 2: CRO / VP sales or BD, then COO ("Chief Operations Officer" counts),
#    CMO, a bare VP, a bare Partner.
# 4. Tier 3 (picked only when the company has no Tier 1/2 candidate AND the agency has <= 200 employees; see
#    can_pick): general manager, director of operations, director of sales / business development, sales director,
#    head of sales / growth / business development, operations manager, branch manager.
# 5. Multi-site branch exception (unchanged, any size): a branch / area / regional manager at an agency with 3+
#    branches may be an additional contact at a different branch (branch_exception).
TOP = [(0, r"(?<!product )(?<!process )\b(owner|co-?owner|founder|co-?founder|proprietor)\b"),
       (1, r"(?<!vice )(?<!vice-)\bpresident\b|\bceo\b|chief executive")]
TOP_GUARD = r"\b(former|retired|past|emeritus|board|assistant|secretary|associate)\b|\bto (the )?(president|ceo|owner|founder|chief)"
T1 = TOP + [(2, r"managing partner|managing principal|^principal$|principal (and|&|/) ?(owner|founder)")]
T2 = [(0, r"chief revenue|\bcro\b|chief sales|chief commercial|chief growth|chief business development"),
      (1, r"(vp|vice[- ]president|svp|evp)\b.*\b(sales|business development|growth|revenue|commercial|client|account)"),
      (2, r"\bcoo\b|chief operating|chief operations officer|\bcmo\b|chief marketing|^(vp|(executive |senior |corporate )?vice[- ]president|svp|evp)$|^(senior |founding |equity )?partner$")]
T3 = [(0, r"\bgeneral manager\b"),
      (1, r"director of operations|operations director|director,? operations"),
      (2, r"director of (sales|business development)|(sales|business development) director|head of (sales|growth|business development)"),
      (3, r"\boperations manager\b"),
      (4, r"\bbranch manager\b")]
NEVER = r"managing director|\bcfo\b|financ|account(ing|ant)|controller|\bcto\b|\bcio\b|technolog|information|\bhr\b|human|people|talent acq|recruit|payroll|compliance|legal|counsel|\bit\b|engineer|operations manager|branch|office manager|assistant|board member|advisor|investor|retired|former"
# The only exclusion-list words a Tier 3 title may carry.
NEVER_CORE = NEVER.replace("|operations manager", "").replace("|branch", "")
TIER3_MAX_EMPLOYEES = 200
MULTI_BRANCH_MIN = 3
BRANCH_ROLE = re.compile(r"(?i)\b(branch|area|regional|district|market)\s+(sales\s+)?(manager|director|vice president|vp|leader)\b|"
                         r"\bregional\s+(vice president|vp|director)\b|\bregional director of sales\b")
BRANCH_NOT = re.compile(r"(?i)\bassistant\b|\bassociate\b|payroll|recruit|talent|\bhr\b|human resources|branch lead\b")


def tier(title):
    """(tier, rank) for a title, or None. Lower is better."""
    t = (title or "").lower().strip()
    if not t:
        return None
    if not re.search(TOP_GUARD, t):
        for rank, pat in TOP:
            if re.search(pat, t):
                return (1, rank)
    if re.search(NEVER_CORE, t):
        return None
    for rank, pat in T1[len(TOP):]:
        if re.search(pat, t):
            return (1, rank)
    for rank, pat in T2:
        if re.search(pat, t):
            return (2, rank)
    for rank, pat in T3:
        if re.search(pat, t):
            return (3, rank)
    return None  # includes "branch" / "operations manager" outside a Tier 3 title


def employees_of(value):
    """Upper bound of an employee count or range ("51-200", "11 to 50", "1,001+", 37), else None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    nums = [int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", str(value))]
    return max(nums) if nums else None


def can_pick(tier_value, company_has_tier12, employees):
    """Tier 1/2 always; Tier 3 only when the company has no Tier 1/2 candidate and the agency has <= 200 employees
    (unknown size: no)."""
    if tier_value in (1, 2):
        return True
    if tier_value == 3:
        n = employees_of(employees)
        return not company_has_tier12 and n is not None and n <= TIER3_MAX_EMPLOYEES
    return False


def branch_exception(title, branches):
    """Multi-site rule: a branch / area / regional manager at a 3+ branch agency (any size)."""
    return bool(BRANCH_ROLE.search(title or "")) and not BRANCH_NOT.search(title or "") and (branches or 0) >= MULTI_BRANCH_MIN


def norm(name):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (name or "").lower()).split())


def main():
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    names = {c["domain"]: c["company_name"] for c in comps}
    size = {c["domain"]: employees_of(c.get("employees") or c.get("estimated_num_employees")) for c in comps}
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
        has12 = any(p["tier"] in (1, 2) and p["has_email"] for p in people.get(d, []))
        cands = [p for p in people.get(d, []) if p["tier"] and p["has_email"] and can_pick(p["tier"], has12, size.get(d))]
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
    t3 = sum(1 for t in targets if t["tier"] == 3)
    print(json.dumps(dict(searched=len(searched), with_people=len(people), unmapped_lines=len(unmapped),
                          picked=len(targets), tier1=t1, tier2=len(targets) - t1 - t3, tier3=t3,
                          no_buyer_email=sum(1 for v in picks.values() if not v["pick"])), indent=1))
    if unmapped:
        print("unmapped sample:", unmapped[:5])


if __name__ == "__main__":
    main()
