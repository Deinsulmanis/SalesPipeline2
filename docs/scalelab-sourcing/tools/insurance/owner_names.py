"""Insurance agencies: decision-maker names published on the agency's own site, for the owner's GetLeads Names+companies
upload (no lookup or spend here).

Usage: python3 -I owner_names.py <out_csv> <targets.json> <sitecache_dir> [<sitecache_dir> ...]
  targets.json  {domain: {"agency": name, ...}}  (agencies still without a contact)
Name + title pairs are read from the crawl cache ("Jane Smith, Owner" on one line, or a name line next to a title line).
Only titles that pass ins_config.agency_tier (Tier 1/2; producers / agents / account managers never) are kept; one per
agency, best tier first. Writes <out_csv> with first_name, last_name, company_name, company_domain (header as the owner's
upload expects) and prints counts.
"""
import csv, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

NAME = re.compile(r"^(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?)?\s*([A-Z][a-z'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]+(?:\s+(?:Jr\.?|Sr\.?|II|III))?)\s*$")
PAIR = re.compile(r"^([A-Z][a-z'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]+)\s*[,\-–|]\s*(.{3,60})$")
BAD = re.compile(r"(?i)\b(insurance|agency|contact|quote|services|solutions|group|company|business|commercial|personal|auto|home|life|health|"
                 r"our|team|about|home|policy|claims|street|suite|avenue|road|drive|texas|oregon|monday|friday|click|learn|read|view|"
                 r"privacy|terms|copyright|request|welcome|workers|liability|property)\b")


STOP = {"meet", "not", "get", "call", "see", "why", "what", "our", "your", "enterprise", "contact", "free", "best", "new", "rent",
        "car", "included", "find", "learn", "read", "more", "home", "auto", "life", "health", "business", "commercial", "personal",
        "client", "clients", "customer", "service", "services", "agent", "agents", "office", "hours", "open", "closed", "map",
        "directions", "phone", "email", "fax", "toll", "mobile", "cell", "texas", "oregon", "united", "states", "north", "south",
        "east", "west", "san", "los", "el", "fort", "worth", "dallas", "houston", "austin", "antonio", "paso", "portland", "salem",
        "eugene", "bend", "privacy", "policy", "terms", "rights", "reserved", "powered", "website", "design", "click", "here",
        "view", "all", "join", "team", "staff", "leadership", "management", "board", "about", "us", "welcome", "thank", "you",
        # insurance lines and site navigation words that look like "First Last"
        "input", "required", "builders", "risk", "comprehensive", "coverage", "ownership", "information", "quick", "links",
        "general", "umbrella", "liability", "bond", "bonds", "surety", "flood", "marine", "inland", "professional", "errors",
        "omissions", "cyber", "property", "workers", "compensation", "employment", "practices", "directors", "officers",
        "excess", "specialty", "farm", "ranch", "crop", "renters", "condo", "boat", "motorcycle", "classic", "benefits", "group",
        "dental", "vision", "medicare", "annuities", "retirement", "planning", "financial", "claims", "report", "pay", "bill",
        "payment", "online", "request", "quote", "started", "site", "careers", "blog", "news", "events", "testimonials",
        "reviews", "faq", "resources", "partners", "carriers", "companies", "locations", "commercial", "lines", "account",
        "accounts", "manager", "producer", "owner", "president", "vice", "chief", "officer", "insured", "insurer", "policies",
        "trucking", "transportation", "construction", "contractors", "manufacturing", "energy", "oil", "gas", "restaurant"}


def clean_name(name):
    toks = name.replace(".", " ").split()
    if len(toks) < 2 or any(t.lower().strip("'’-") in STOP for t in toks) or any(len(t) == 1 for t in toks[1:]) and len(toks) == 2:
        return None
    return name


def pairs(rec):
    out = []
    for p in rec.get("pages", []):
        lines = [l.strip(" \t|•·–-") for l in (p.get("text") or "").split("\n")]
        lines = [l for l in lines if l]
        for i, ln in enumerate(lines):
            m = PAIR.match(ln)
            if m and not BAD.search(m.group(1)) and clean_name(m.group(1)):
                out.append((m.group(1), m.group(2)))
            nm = NAME.match(ln)
            if nm and not BAD.search(ln) and len(ln) <= 40 and clean_name(nm.group(1)):
                for j in (i + 1, i - 1):
                    if 0 <= j < len(lines) and len(lines[j]) <= 70 and not NAME.match(lines[j]):
                        out.append((nm.group(1), lines[j]))
                        break
    return out


def main():
    out_p, targets = sys.argv[1], json.load(open(sys.argv[2]))
    caches = sys.argv[3:]
    rows, found = [], 0
    for d, t in sorted(targets.items()):
        path = next((os.path.join(c, d + ".json") for c in caches if os.path.exists(os.path.join(c, d + ".json"))), None)
        if not path:
            continue
        best = None
        for name, title in pairs(json.load(open(path))):
            tr = C.agency_tier(title)
            if tr and tr[0] in (1, 2) and (best is None or tr < best[0]):
                best = (tr, name)
        if best:
            found += 1
            first, _, last = best[1].partition(" ")
            last = last.split(" ")[-1] if last else ""
            rows.append([first, last, t.get("agency") or "", d])
    with open(out_p, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["first_name", "last_name", "company_name", "company_domain"])
        w.writerows(rows)
    print(json.dumps({"agencies": len(targets), "with_site_named_decision_maker": found}))


if __name__ == "__main__":
    main()
