"""Campaign 3 copy v2 evidence (owner copy change 2026-11-24). No network, no paid calls.

Two pieces of evidence for the v2 Email 1, both re-checked by integrations/staffing-v4-copy.js:

  specialty_line   COPY_C primary: "<2 or 3 plural hands-on roles> for <client type>", built only from the
                   words of ONE first-party excerpt (the ICP gate's icp_evidence), so it can never name a role or
                   client type the site does not. The selector re-checks that every word is in the quote.
  job postings     COPY_B: the agency's own postings within 30 days (GetLeads search_jobs, free jobs quota).
                   verified_role is the single most common hands-on title, singular ("forklift operator");
                   location is that role's most common posting "City, ST". Written as a candidateAds entry, so
                   the selector's existing check (role and city in the quote) applies.

Collect postings from saved search_jobs results (tool-result files or agent transcripts' JSON):
  python3 -I copy_v2_evidence.py collect <run>/job_postings.json <result.json|txt> [...]
  -> {domain: [{title, city, state, postedAt, url}]}
build_evidence.py reads <run>/job_postings.json when present.
"""
import datetime
import json
import re
import sys

MAX_LINE = 90
POSTING_DAYS = 30
MIN_ROLE_POSTINGS = 2

# Site text: role phrases as the site writes them (plural kept, singular pluralized). Specific first.
SITE_ROLES = [
    r"cnc machinists?", r"cnc operators?", r"pipe ?fitters?", r"millwrights?", r"electricians?", r"welders?",
    r"machinists?", r"fabricators?", r"ironworkers?", r"boilermakers?", r"plumbers?", r"carpenters?",
    r"hvac technicians?", r"maintenance technicians?", r"maintenance mechanics?", r"forklift (?:operators?|drivers?)",
    r"machine operators?", r"production workers?", r"production associates?", r"assemblers?",
    r"warehouse workers?", r"warehouse associates?", r"material handlers?", r"general laborers?",
    r"construction laborers?", r"construction workers?", r"equipment operators?", r"skilled tradespeople", r"tradesmen",
]
# Client types as the site writes them; a bare "contractors" is skipped (it often means contract workers).
SITE_CLIENTS = [
    r"(?:industrial|commercial|general|electrical|mechanical) (?:construction )?contractors", r"construction (?:companies|firms|contractors)",
    r"manufacturing (?:companies|plants|facilities|clients|firms)", r"manufacturers", r"distribution centers", r"warehouses",
    r"logistics (?:companies|providers|firms)", r"(?:industrial|production|processing|chemical|power) (?:plants|facilities)",
    r"food (?:processors|processing plants)", r"shipyards", r"refineries", r"fabrication shops", r"machine shops",
]
SITE_ROLE_RX = re.compile(r"\b(" + "|".join(SITE_ROLES) + r")\b", re.I)
SITE_CLIENT_RX = re.compile(r"\b(" + "|".join(SITE_CLIENTS) + r")\b", re.I)

# Posting titles -> one singular role. Specific first; the first match wins.
TITLE_ROLES = [
    ("CNC machinist", r"\bcnc (?:machinist|programmer)"), ("CNC operator", r"\bcnc operator"),
    ("forklift operator", r"\bfork ?lift\b|\breach truck\b"), ("machinist", r"\bmachinist"), ("welder", r"\bweld(?:er|ing)\b"),
    ("fabricator", r"\bfabricator"), ("electrician", r"\belectrician"), ("pipefitter", r"\bpipe ?fitter"),
    ("millwright", r"\bmillwright"), ("plumber", r"\bplumber"), ("carpenter", r"\bcarpenter"), ("HVAC technician", r"\bhvac\b"),
    ("maintenance technician", r"\bmaintenance (?:tech|mechanic)|\bindustrial maintenance\b"), ("material handler", r"\bmaterial handler"),
    ("machine operator", r"\b(?:machine|press|line|production) operator"), ("assembler", r"\bassembler|\bassembly (?:worker|associate|technician)"),
    ("production worker", r"\bproduction (?:worker|associate|team member|helper)"),
    ("warehouse associate", r"\bwarehouse (?:worker|associate|team member|helper|clerk)"), ("picker", r"\bpicker\b"), ("packer", r"\bpacker\b"),
    ("construction laborer", r"\bconstruction (?:worker|labou?rer|helper)"), ("equipment operator", r"\b(?:heavy )?equipment operator"),
    ("general laborer", r"\bgeneral labou?r|\blabou?rer"),
]
TITLE_ROLE_RX = [(label, re.compile(rx, re.I)) for label, rx in TITLE_ROLES]
# Same exclusions as jobs_rule.py (supervisors, managers, drivers...), except a forklift driver.
NOT_HANDS_ON = re.compile(
    r"\b(manager|management|supervisor|superintendent|director|engineer|engineering|recruiter|coordinator|planner|"
    r"analyst|scheduler|buyer|estimator|administrator|assistant|clerk|accountant|executive|president|officer|"
    r"consultant|specialist|representative|sales|scientist|nurse|developer|designer|stagehand|stage hand|live event|"
    r"event crew|event staff|stage crew|captain|pilot|instructor|trainer)\b|(?<!forklift )\bdriver\b", re.I)


def _plural(phrase):
    p = phrase.lower()
    p = re.sub(r"\bcnc\b", "CNC", p)
    p = re.sub(r"\bhvac\b", "HVAC", p)
    return p if p.endswith("s") or p.endswith("people") or p.endswith("men") else p + "s"


def _join(items):
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def specialty_line(dec):
    """{line, url, quote} from one first-party excerpt naming 2-3 roles and a client type, else None."""
    for e in dec.get("icp_evidence", []) or []:
        quote, url = e.get("excerpt") or "", e.get("url") or ""
        if not quote or not url.startswith("http"):
            continue
        roles = []
        for m in SITE_ROLE_RX.finditer(quote):
            r = _plural(m.group(1))
            if r not in roles:
                roles.append(r)
        client = SITE_CLIENT_RX.search(quote)
        if len(roles) < 2 or not client:
            continue
        roles = roles[:3]
        client_text = client.group(1).lower()
        line = f"{_join(roles)} for {client_text}"
        if len(line) > MAX_LINE and len(roles) == 3:
            line = f"{_join(roles[:2])} for {client_text}"
        if len(line) <= MAX_LINE:
            return {"line": line, "url": url, "quote": quote}
    return None


def title_role(title):
    t = title or ""
    if not t.strip() or NOT_HANDS_ON.search(t):
        return ""
    return next((label for label, rx in TITLE_ROLE_RX if rx.search(t)), "")


def posting_candidate(postings, as_of):
    """A candidateAds entry from the agency's own postings within 30 days of as_of, or None."""
    as_of_d = datetime.date.fromisoformat(as_of)
    keep = []
    for p in postings or []:
        try:
            d = datetime.date.fromisoformat(str(p.get("postedAt") or "")[:10])
        except ValueError:
            continue
        if not (0 <= (as_of_d - d).days <= POSTING_DAYS) or not str(p.get("url") or "").startswith("http"):
            continue
        role = title_role(p.get("title"))
        if role and p.get("city") and p.get("state"):
            keep.append({**p, "role": role, "day": d.isoformat()})
    if not keep:
        return None
    count = {}
    for p in keep:
        c = count.setdefault(p["role"], [0, ""])
        c[0] += 1
        c[1] = max(c[1], p["day"])
    # Most postings first; ties go to the most recently posted role, then alphabetical.
    role = sorted(count, key=lambda r: (-count[r][0], -datetime.date.fromisoformat(count[r][1]).toordinal(), r))[0]
    mine = [p for p in keep if p["role"] == role]
    # "recruiting for <role> roles ... right now" needs at least two current postings of that role.
    if len(mine) < MIN_ROLE_POSTINGS:
        return None
    places = {}
    for p in mine:
        k = f"{str(p['city']).strip().title()}, {str(p['state']).strip().upper()}"
        places[k] = places.get(k, 0) + 1
    location = sorted(places, key=lambda k: (-places[k], k))[0]
    at_place = [p for p in mine if f"{str(p['city']).strip().title()}, {str(p['state']).strip().upper()}" == location]
    quote = "; ".join(f"{p['title']} ({location}, posted {p['day']})" for p in at_place[:6])
    return {"url": at_place[0]["url"], "quote": quote[:400], "role": role, "location": location, "current": True,
            "lastSeen": max(p["day"] for p in mine), "source": "job_postings", "postings": len(mine)}


def _records(path):
    text = open(path, encoding="utf-8").read()
    for blob in re.findall(r'\{\s*"mode"\s*:\s*"postings".*?\n\}', text, re.S) or [text]:
        try:
            data = json.loads(blob)
        except ValueError:
            continue
        for row in data.get("data", []) if isinstance(data, dict) else []:
            yield row


def collect(out, paths):
    found = {}
    for path in paths:
        for row in _records(path):
            dom = str(row.get("company_domain") or "").lower().removeprefix("www.")
            urls = row.get("job_urls") or {}
            url = row.get("linkedin_job_url") or next(iter(urls.values()), "")
            if not dom or not url:
                continue
            found.setdefault(dom, []).append({"title": row.get("title") or "", "city": row.get("geo_locality") or "",
                                              "state": row.get("geo_admin_district") or "",
                                              "postedAt": str(row.get("posted_at") or "")[:10], "url": url})
    json.dump(found, open(out, "w"), indent=1)
    print(f"{sum(len(v) for v in found.values())} postings for {len(found)} domains -> {out}")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "collect":
        collect(sys.argv[2], sys.argv[3:])
    else:
        raise SystemExit(__doc__)
