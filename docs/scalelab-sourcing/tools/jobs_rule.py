"""Job-posting evidence for the ICP gate (owner decision 2026-11-24).

Rule: the agency itself has 2+ postings in the last 60 days for hands-on industrial or trades roles (warehouse,
forklift, production, assembly, machine operator, general labor, welder, CNC, machinist, maintenance tech,
electrician, construction craft/laborer) AND those are at least 1/3 of all its postings in that window.
Postings must be the agency's own: matched by company_domain, or by an exact company-name match whose posting
carries no other domain. A direct employer that merely shares words of the name never counts.

  - satisfies check 3 (industrial line) and check 8 (hands-on workers); the industrial excerpt (check 7) and the
    management-only check (9) are covered by the same evidence;
  - satisfies check 4 (placement model) when 2+ of the hands-on postings themselves say temporary, contract,
    temp-to-hire or contract-to-hire (title, description or employment_type), OR (owner 2026-11-24) hands-on roles are
    at least 2/3 of the agency's postings in the window;
  - satisfies check 5 (US) when 2+ postings are in US locations and the domain is not foreign (owner 2026-11-24);
  - checks 1, 2, 5 and 6 are unchanged and still required (icp_decide.py --jobs).

Source: GetLeads search_jobs only (free jobs quota, no plan credits). Calls are made by helper agents; their raw
results are parsed from the agents' transcripts, so nothing is transcribed by hand.

Calls per company (posted_since = run date - 60 days, status any):
  g_dom_fn   grouped, company_domain, the three industrial functions        -> F (industrial-function postings)
  g_name_fn  grouped, company_name + country US, industrial functions        (only when g_dom_fn found none)
  l_dom_fn   postings list, company_domain, industrial functions, limit 10   -> titles, types, descriptions
  l_name_fn  postings list, company_name + country US, industrial functions  (exact-name rows only)
  g_dom_all / g_name_all  grouped, all functions                              -> T (all postings in the window)

Usage:
  python3 -I jobs_rule.py collect <out.json> <transcript.jsonl|dir> [...]   raw calls -> <out.json>
  python3 -I jobs_rule.py evidence <run> <calls.json> [<calls.json> ...]     -> <run>/jobs_evidence.json (+ round-2 todo)
"""
import glob
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402

FUNCTIONS = ["Manufacturing", "Skilled Trades & Maintenance", "Supply Chain & Logistics"]
AS_OF = datetime.strptime(v4config.RUN_DATE, "%Y-%m-%d").date() if getattr(v4config, "RUN_DATE", None) else date.today()
WINDOW_START = AS_OF - timedelta(days=60)

HANDS_ON = re.compile(
    r"\b(warehouse|forklift|reach truck|order picker|picker|packer|material handler|loader|unloader|"
    r"shipping|receiving|production|assembl\w*|machine operator|line operator|manufacturing (operator|associate|technician|worker)|"
    r"general labou?r\w*|labou?rer|welder|welding|cnc|machinist|fabricator|maintenance (tech\w*|mechanic|worker|helper)|"
    r"industrial maintenance|millwright|electrician|electrical apprentice|apprentice electrician|carpenter|pipefitter|"
    r"pipe fitter|plumber|ironworker|iron worker|mason|concrete|framer|drywall|roofer|hvac tech\w*|"
    r"heavy equipment operator|equipment operator|construction (worker|labou?rer|helper)|press operator|sorter|stocker|"
    r"tool and die|sheet metal|quality inspector|qc inspector|wire harness|installer|"
    r"(electrician|electrical|construction|plumber|plumbing|hvac|welder|carpenter) helper|mechanic)\b", re.I)
NOT_HANDS_ON = re.compile(
    r"\b(manager|management|supervisor|superintendent|director|engineer|engineering|recruiter|coordinator|planner|"
    r"analyst|scheduler|buyer|estimator|administrator|assistant|clerk|accountant|executive|president|officer|"
    r"consultant|specialist|representative|sales|scientist|nurse|developer|designer|"
    r"stagehand|stage hand|live event|event crew|event staff|stage crew|captain|pilot|driver)\b", re.I)
TEMP = re.compile(r"\b(temporary|temp|temps|temp[- ]to[- ](hire|perm\w*)|contract[- ]to[- ](hire|perm\w*)|"
                  r"contract (position|role|assignment|job|work|opportunity|basis|worker)|(short|long)[- ]term (contract|assignment)|"
                  r"temp assignment|on assignment)\b", re.I)
LEGAL = set("inc llc l l c corp corporation co company ltd llp pllc pc the".split())


def is_hands_on(title):
    t = title or ""
    return bool(HANDS_ON.search(t)) and not NOT_HANDS_ON.search(t)


TITLE_TEMP = re.compile(r"\b(temp|temps|temporary|contract|contractor|temp[- ]to[- ]hire|contract[- ]to[- ]hire)\b", re.I)


def says_temp(p):
    """The posting itself says temporary / contract / temp-to-hire / contract-to-hire: in its employment type, anywhere
    in its (short) title, or as a placement phrase in its description (a bare "contractor" there usually names a client)."""
    if (p.get("employment_type") or "").lower() in ("contract", "temporary"):
        return True
    if TITLE_TEMP.search(p.get("title") or ""):
        return True
    return bool(TEMP.search(p.get("description") or ""))


US_STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())
STATE_NAMES = set("alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas "
                  "kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma "
                  "oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming".split()) | {"new hampshire", "new jersey",
                  "new mexico", "new york", "north carolina", "north dakota", "rhode island", "south carolina", "south dakota", "west virginia"}
US_TLDS = {"com", "net", "org", "us", "biz", "io", "co", "jobs", "work", "info", "pro", "llc", "inc", "careers", "group", "solutions",
           "services", "staffing", "agency", "company", "team", "global", "works", "site", "online", "tech", "app", "ai", "me"}


def city_state(loc):
    """'4130 N 5th St, North Las Vegas, NV 89032' -> ('North Las Vegas', 'NV'); None when no US city and state."""
    parts = [x.strip() for x in str(loc or "").split(",")]
    for i, x in enumerate(parts):
        m = re.match(r"^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$", x)
        if m and m.group(1) in US_STATES and i > 0:
            city = parts[i - 1]
            if city and not re.search(r"\d", city) and len(city) <= 30:
                return city, m.group(1)
    return None


def us_location(p):
    if (p.get("geo_country_iso") or p.get("country") or "").upper() == "US":
        return True
    loc = str(p.get("location") or "")
    if re.search(r"(?:^|,\s*)([A-Z]{2})(?:\s+\d{5})?$", loc) and re.search(r"([A-Z]{2})(?:\s+\d{5})?$", loc).group(1) in US_STATES:
        return True
    if re.match(r"^\d{5},\s*([A-Z]{2})$", loc):
        return True
    return loc.strip().lower() in STATE_NAMES or "united states" in loc.lower()


def foreign_domain(d):
    d = (d or "").lower()
    tld = d.rsplit(".", 1)[-1]
    return d.endswith((".co.uk", ".com.au", ".co.nz", ".com.mx", ".co.in")) or (len(tld) == 2 and tld not in ("us", "co", "io", "ai", "me")) or (len(tld) > 2 and tld not in US_TLDS)


def posting_url(p):
    if p.get("linkedin_job_url"):
        return p["linkedin_job_url"]
    for v in (p.get("job_urls") or {}).values():
        if v:
            return v
    for v in (p.get("apply_urls") or {}).values():
        if v:
            return v
    return ""


def root(d):
    d = (d or "").strip().lower()
    d = re.sub(r"^https?://", "", d).split("/")[0].split(":")[0]
    return d[4:] if d.startswith("www.") else d


def name_key(n):
    return " ".join(t for t in re.sub(r"[^a-z0-9 ]", " ", (n or "").lower()).split() if t not in LEGAL)


# ---------------------------------------------------------------- collect raw calls from transcripts
def _text(content):
    if isinstance(content, str):
        return content
    return "".join(x.get("text", "") for x in content if isinstance(x, dict))


def _load_result(t):
    m = re.search(r"saved to:? (/\S+\.(?:txt|json))", t)
    if m and os.path.exists(m.group(1)):
        t = open(m.group(1)).read()
        if t.lstrip().startswith("["):  # a saved list of content blocks: [{"type": "text", "text": "..."}]
            try:
                t = _text(json.loads(t))
            except ValueError:
                pass
    t = t.strip()
    if not t.startswith("{"):
        return None
    try:
        return json.loads(t)
    except ValueError:
        return None


def collect(paths):
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, "*.jsonl")) + glob.glob(os.path.join(p, "*.output"))) if os.path.isdir(p) else [p]
    calls = []
    for f in files:
        uses = {}
        for ln in open(f, errors="replace"):
            try:
                o = json.loads(ln)
            except ValueError:
                continue
            c = (o.get("message") or {}).get("content") if isinstance(o, dict) else None
            if not isinstance(c, list):
                continue
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and (b.get("name", "").endswith("search_jobs") or b.get("name", "").endswith("enrich_company_jobs")):
                    uses[b["id"]] = (b.get("name", ""), b.get("input") or {})
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                    name, raw = uses[b["tool_use_id"]]
                    res = _load_result(_text(b.get("content")))
                    inp = {k: v for k, v in raw.items() if k not in ("context", "conversation_id")}
                    if name.endswith("enrich_company_jobs"):
                        calls += _from_enrich(inp, res, os.path.basename(f))
                    else:
                        calls.append({"input": inp, "ok": res is not None and "data" in res, "result": res, "file": os.path.basename(f)})
    return calls


def _from_enrich(inp, res, src):
    """enrich_company_jobs (owner-approved fast path, 2026-11-24): up to 50 domains per call, same free jobs quota and
    postings data. Converted per company into the search_jobs call shapes the evidence step reads:
    include_postings=false, no functions -> g_dom_all (T); functions + postings -> g_dom_fn (F) and l_dom_fn (titles)."""
    if not res or "companies" not in res:
        return []
    out = []
    base = {"posted_since": inp.get("posted_since"), "status": inp.get("status", "any")}
    for c in res["companies"]:
        d = root(c.get("query"))
        n = (c.get("total_roles") or 0) if c.get("matched") else 0
        row = [{"company_name": c.get("company_name"), "company_domain": c.get("company_domain") or d, "role_count": n}] if n else []
        if inp.get("job_functions"):
            out.append({"input": dict(base, company_domain=d, job_functions=inp["job_functions"], group_by="company"), "ok": True,
                        "result": {"data": row}, "file": src + " (enrich)"})
            if inp.get("include_postings", True):
                posts = [dict(p, company_domain=p.get("company_domain") or d) for p in c.get("postings") or []]
                out.append({"input": dict(base, company_domain=d, job_functions=inp["job_functions"]), "ok": True,
                            "result": {"data": posts, "total_results": n}, "file": src + " (enrich)"})
        else:
            out.append({"input": dict(base, company_domain=d, group_by="company"), "ok": True, "result": {"data": row}, "file": src + " (enrich)"})
    return out


def kind(inp):
    g = inp.get("group_by") == "company"
    fn = bool(inp.get("job_functions"))
    who = "dom" if inp.get("company_domain") else ("name" if inp.get("company_name") else "other")
    return ("g_" if g else "l_") + who + ("_fn" if fn else "_all")


# ---------------------------------------------------------------- evidence
def pdate(s):
    try:
        return datetime.strptime((s or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def evidence(run, call_files):
    comps = {c["domain"]: c.get("company_name") or "" for c in json.load(open(os.path.join(run, "jobs_companies.json")))}
    calls = []
    for f in call_files:
        calls += json.load(open(f))
    idx = {}
    for c in calls:
        if not c["ok"] or c["input"].get("posted_since") != WINDOW_START.isoformat():
            continue
        inp = c["input"]
        tgt = root(inp["company_domain"]) if inp.get("company_domain") else name_key(inp.get("company_name"))
        idx[(kind(inp), tgt)] = c["result"]  # a later call for the same key wins (retries)

    def exact_groups(d, name, rows):
        k = name_key(name)
        return [r for r in rows or [] if name_key(r.get("company_name")) == k and (not r.get("company_domain") or root(r["company_domain"]) == d)]

    out, todo = {}, []
    for d, name in comps.items():
        e = {"domain": d, "name": name, "match": None, "F": None, "T": None, "sample": [], "searched": []}
        gd = idx.get(("g_dom_fn", d))
        if gd is None and ("l_dom_fn", d) in idx:
            # one-round mode: the listing's total_results is the industrial-function count for the domain
            ld = idx[("l_dom_fn", d)]
            gd = {"data": [{"role_count": ld.get("total_results") or 0}] if (ld.get("total_results") or 0) else []}
        if gd is None and ("g_dom_all", d) in idx:
            # only the all-function total is known: when it is under 2, the industrial count (<= total) is too
            ta = sum(r.get("role_count") or 0 for r in idx[("g_dom_all", d)].get("data") or [])
            if ta < 2:
                gd = {"data": [{"role_count": ta}] if ta else []}
        if gd is not None:
            e["searched"].append("domain")
            F = sum(r.get("role_count") or 0 for r in gd.get("data") or [])
            if F:
                e.update(match="domain", F=F)
        if e["match"] is None:
            gn = idx.get(("g_name_fn", name_key(name)))
            if gn is not None:
                e["searched"].append("name")
                ex = exact_groups(d, name, gn.get("data"))
                if ex:
                    e.update(match="name", F=sum(r.get("role_count") or 0 for r in ex))
        if gd is None and ("g_name_fn", name_key(name)) not in idx:
            e.update(verdict="NOT_SEARCHED", why="no job search result (fail closed)")
            out[d] = e
            continue
        F = e["F"] or 0
        if F < 2:
            e.update(verdict="HOLD", why="no postings by the agency in the last 60 days" if F == 0 else "only 1 industrial-function posting in the last 60 days",
                     hands_on=0, share=0.0, check4_by_postings=False)
            out[d] = e
            continue
        # round 2: titles and the all-function total
        lk = ("l_dom_fn", d) if e["match"] == "domain" else ("l_name_fn", name_key(name))
        gk = ("g_dom_all", d) if e["match"] == "domain" else ("g_name_all", name_key(name))
        lst, tot = idx.get(lk), idx.get(gk)
        if lst is None or tot is None:
            e.update(verdict="NEEDS_ROUND2", why="titles or total not fetched yet")
            todo.append({"domain": d, "name": name, "match": e["match"], "need": [k for k, v in ((lk[0], lst), (gk[0], tot)) if v is None]})
            out[d] = e
            continue
        rows = lst.get("data") or []
        if e["match"] == "name":
            k = name_key(name)
            rows = [p for p in rows if name_key(p.get("company_name")) == k and (not p.get("company_domain") or root(p["company_domain"]) == d)]
            T = sum(r.get("role_count") or 0 for r in exact_groups(d, name, tot.get("data")))
        else:
            rows = [p for p in rows if root(p.get("company_domain")) == d]
            T = sum(r.get("role_count") or 0 for r in tot.get("data") or [])
        sample = [{"title": p.get("title") or "", "employment_type": p.get("employment_type") or "", "posted_at": (p.get("posted_at") or "")[:10],
                   "hands_on": is_hands_on(p.get("title")), "temp": says_temp(p), "url": posting_url(p),
                   "location": p.get("location") or "", "us": us_location(p)} for p in rows]
        n, h = len(sample), sum(1 for s in sample if s["hands_on"])
        H = round(F * h / n) if n and F > n else h
        T = max(T, F)
        share = H / T if T else 0.0
        temp_ho = sum(1 for s in sample if s["hands_on"] and s["temp"])
        e.update(T=T, sample=sample, hands_on=H, hands_on_observed=h, estimated=bool(n and F > n), share=round(share, 3),
                 temp_hands_on=temp_ho,
                 # check 4 (owner 2026-11-24 #2): temp/contract wording on 2+ hands-on postings, OR hands-on >= 2/3 of postings
                 check4_by_postings=temp_ho >= 2 or share >= 2 / 3,
                 # check 5 (owner 2026-11-24 #3): 2+ postings in US locations and a domain that is not foreign
                 us_postings=sum(1 for s in sample if s["us"]), check5_by_postings=sum(1 for s in sample if s["us"]) >= 2 and not foreign_domain(d),
                 sample_roles=list(dict.fromkeys(s["title"] for s in sample if s["hands_on"]))[:5],
                 other_roles=list(dict.fromkeys(s["title"] for s in sample if not s["hands_on"]))[:5])
        if h >= 2 and H >= 2 and share >= 1 / 3:
            e.update(verdict="PROMOTE", why=f"{H} hands-on industrial postings of {T} in the last 60 days ({share:.0%})" + (" (estimated from a sample)" if e["estimated"] else ""))
        elif h == 0:
            e.update(verdict="HOLD", why=f"0 hands-on of {T} recent postings")
        elif h == 1:
            e.update(verdict="HOLD", why=f"only 1 hands-on posting observed of {T} recent postings")
        else:
            e.update(verdict="HOLD", why=f"{H} hands-on of {T} recent postings ({share:.0%}, under 1/3)")
        out[d] = e
    json.dump(out, open(os.path.join(run, "jobs_evidence.json"), "w"), indent=1)
    json.dump(todo, open(os.path.join(run, "jobs_round2_todo.json"), "w"), indent=1)
    from collections import Counter
    print("companies", len(out), dict(Counter(v["verdict"] for v in out.values())), "round-2 todo", len(todo))
    return out


if __name__ == "__main__":
    if sys.argv[1] == "collect":
        calls = collect(sys.argv[3:])
        json.dump(calls, open(sys.argv[2], "w"))
        from collections import Counter
        print("calls", len(calls), "ok", sum(c["ok"] for c in calls), dict(Counter(kind(c["input"]) for c in calls if c["ok"])))
    elif sys.argv[1] == "evidence":
        evidence(sys.argv[2], sys.argv[3:])
