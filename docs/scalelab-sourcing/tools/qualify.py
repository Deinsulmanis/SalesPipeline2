"""Stage 2: merge crawl caches, extract team-page buyer candidates, ONE fan-out Jev request per company.

Usage: python3 -I qualify.py <run_dir> [--only @domains.json]
Writes evidence/, jev_icp/<d>.json (+ .supp.json so icp_decide does not re-call), buyers_site.json, jev_usage.jsonl
"""
import json, os, re, sys, time, urllib.request, urllib.error
import concurrent.futures as cf

RUN = sys.argv[1]
sys.path.insert(0, os.path.dirname(__file__))
import icp_gate  # noqa: E402  (RUN taken from argv[1])
import v4config  # noqa: E402
from icp_gate import build_evidence, state_for, QUESTIONS  # noqa: E402

MODEL = v4config.JEV_MODEL
TITLE = re.compile(r"\b(owner|co-owner|founder|co-founder|president|ceo|chief executive officer|chief revenue officer|cro|coo|managing partner|principal|vice president|vp|director of (sales|business development)|sales director|business development director|general manager)\b", re.I)
NAME = re.compile(r"^(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?)?\s*([A-Z][a-z'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]+(?:\s+(?:Jr\.?|Sr\.?|II|III))?)\s*$")
BAD = re.compile(r"(?i)\b(contact|apply|staffing|services|solutions|industries|careers|jobs|team|about|our|home|search|privacy|terms|copyright|request|employer|employee|clients?|locations?|office|street|suite|avenue|road|drive|monday|friday|click|learn|read|view|hiring|welcome)\b")


def merge_caches():
    pw = os.path.join(RUN, "pwcache")
    if not os.path.isdir(pw):
        return
    for f in os.listdir(pw):
        a_path = os.path.join(RUN, "sitecache", f)
        try:  # pw_fetch.js may still be writing this file; it is merged on the next run
            b = json.load(open(os.path.join(pw, f)))
            a = json.load(open(a_path)) if os.path.exists(a_path) else {"pages": []}
        except ValueError:
            continue
        ta = sum(len(p.get("text") or "") for p in a["pages"])
        tb = sum(len(p.get("text") or "") for p in b["pages"])
        if tb > ta:
            b["error"] = None if tb > 300 else b.get("error")
            json.dump(b, open(a_path, "w"))


def buyer_candidates(domain):
    path = os.path.join(RUN, "sitecache", domain + ".json")
    if not os.path.exists(path):
        return []
    rec = json.load(open(path))
    out, seen = [], set()
    for p in rec.get("pages", []):
        lines = [l.strip(" \t|•·–-") for l in (p.get("text") or "").split("\n")]
        lines = [l for l in lines if l]
        for i, ln in enumerate(lines):
            # "Name, Title" / "Name - Title" on one line
            m = re.match(r"^([A-Z][a-z'’.-]+\s+[A-Z][A-Za-z'’-]+)\s*[,\-–|]\s*(.{3,60})$", ln)
            pairs = []
            if m and TITLE.search(m.group(2)) and not BAD.search(m.group(1)):
                pairs.append((m.group(1), m.group(2)))
            # "Name" line followed by "Title" line (or preceded)
            nm = NAME.match(ln)
            if nm and not BAD.search(ln) and len(ln) <= 40:
                for j in (i + 1, i - 1):
                    if 0 <= j < len(lines) and len(lines[j]) <= 70 and TITLE.search(lines[j]) and not NAME.match(lines[j]):
                        pairs.append((nm.group(1), lines[j]))
                        break
            for name, title in pairs:
                key = name.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append({"name": name.strip(), "title": re.sub(r"\s+", " ", title).strip()[:80], "url": p.get("final_url") or p.get("url")})
    return out[:8]


import threading
_budget_lock = threading.Lock()


def _spent_usd():
    """Jev spend recorded in this run's jev_usage.jsonl (input + output tokens), in USD."""
    path = os.path.join(RUN, "jev_usage.jsonl")
    tokens = 0
    if os.path.exists(path):
        for line in open(path):
            try:
                u = json.loads(line).get("usage") or {}
            except ValueError:
                continue
            tokens += int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0)
    return tokens * v4config.JEV_USD_PER_MTOK / 1e6


_SPENT = [None]


def budget_allows(next_tokens=6000):
    """Hard stop at V4_JEV_BUDGET_USD: never start a request that could cross it."""
    if v4config.JEV_BUDGET_USD is None:
        return True
    with _budget_lock:
        if _SPENT[0] is None:
            _SPENT[0] = _spent_usd()
        if _SPENT[0] + next_tokens * v4config.JEV_USD_PER_MTOK / 1e6 > v4config.JEV_BUDGET_USD:
            return False
        _SPENT[0] += next_tokens * v4config.JEV_USD_PER_MTOK / 1e6  # reserve; corrected after the call
        return True


def budget_settle(reserved_tokens, usage):
    if v4config.JEV_BUDGET_USD is None:
        return
    used = int((usage or {}).get("input_tokens") or 0) + int((usage or {}).get("output_tokens") or 0)
    with _budget_lock:
        _SPENT[0] += (used - reserved_tokens) * v4config.JEV_USD_PER_MTOK / 1e6


def jev(state, questions):
    body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(v4config.JEV_URL, data=body, method="POST", headers=v4config.jev_headers())
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                time.sleep(3 + 4 * attempt); continue
            raise RuntimeError(f"Jev HTTP {e.code}: {e.read()[:200]!r}")


SUPP = {
    "hands_on_workers": {"type": "noul", "instructions": "Do the first_party_website excerpts show the company supplying or placing hands-on industrial or skilled-trades WORKERS (e.g. production/assembly workers, warehouse associates, general laborers, welders, electricians, millwrights, machinists, maintenance technicians, construction craft workers) to employer clients?"},
    "management_only": {"type": "noul", "instructions": "Is the company's industrial/construction/manufacturing offering limited to executive, management, engineering or other professional/white-collar roles (executive search), rather than hands-on industrial or trades workers?"},
}
ADQ = {"ad_class": {"type": "choice", "instructions": "Taking all the ad creatives in `meta_ads` together, who are they trying to win? The advertiser is a staffing agency.", "criteria": {
    "EMPLOYER_ACQUISITION": "The ads promote the agency's staffing/labor services to BUSINESSES that need workers.",
    "CANDIDATE_RECRUITMENT": "The ads promote jobs to WORKERS / job seekers.",
    "MIXED": "Some ads clearly target employers, others clearly target job seekers.",
    "UNRELATED_OR_UNCLEAR": "Audience cannot be resolved."}}}


def one(c):
    d = c["domain"]
    out = os.path.join(RUN, "jev_icp", d + ".json")
    ev = build_evidence(c)
    cands = buyer_candidates(d)
    if not ev["accessible"]:
        return d, "inaccessible", cands, None
    if os.path.exists(out):
        return d, "cached", cands, None
    st = state_for(c, ev)
    qs = dict(QUESTIONS); qs.update(SUPP)
    if cands:
        st["team_page_people"] = [{"id": f"p{i}", "name": x["name"], "title": x["title"], "url": x["url"]} for i, x in enumerate(cands)]
        crit = {f"p{i}": f"{x['name']} - {x['title']}" for i, x in enumerate(cands)}
        crit["none"] = "None of the listed people is clearly a current owner, executive, or sales/business-development leader of THIS company (or the list is page fragments, testimonials, or people from other companies)."
        qs["best_buyer"] = {"type": "choice", "instructions": "Using team_page_people and the first-party excerpts, which listed person is the most senior current decision-maker at THIS company: owner/founder/president/CEO first, then CRO/VP of sales/VP of business development, then director of sales/business development? Ignore testimonials, candidates, and people at client companies.", "criteria": crit}
    if c.get("intent_ads"):
        st["meta_ads"] = [{"title": a.get("title"), "text": a.get("text"), "cta": a.get("cta"), "active": a.get("active")} for a in c["intent_ads"]["ads"]][:8]
        qs.update(ADQ)
    if not budget_allows():
        return d, "budget_stop", cands, None
    res = jev(st, qs)
    budget_settle(6000, res.get("usage"))
    json.dump(res, open(out, "w"), indent=1)
    supp = {"model": res.get("model"), "answers": {k: res["answers"][k] for k in SUPP}, "usage": {"note": "same request as main ICP call"}}
    json.dump(supp, open(os.path.join(RUN, "jev_icp", d + ".supp.json"), "w"))
    return d, "ok", cands, res


if __name__ == "__main__":
    os.makedirs(os.path.join(RUN, "jev_icp"), exist_ok=True)
    os.makedirs(os.path.join(RUN, "evidence"), exist_ok=True)
    merge_caches()
    comps = [c for c in json.load(open(os.path.join(RUN, "companies.json"))) if c["pre_gate"] is None]
    if "--only" in sys.argv:  # --only @domains.json: e.g. readable sites first, thin ones after the headless retry
        arg = sys.argv[sys.argv.index("--only") + 1]
        only = set(json.load(open(arg[1:])) if arg.startswith("@") else arg.split(","))
        comps = [c for c in comps if c["domain"] in only]
    bpath = os.path.join(RUN, "buyers_site.json")
    buyers = json.load(open(bpath)) if os.path.exists(bpath) else {}  # merged across --only passes
    usage = open(os.path.join(RUN, "jev_usage.jsonl"), "a")
    fails = 0
    stopped = False

    def run(c):
        try:
            return one(c)
        except Exception as e:
            return c["domain"], f"FAIL {e}", [], None
    with cf.ThreadPoolExecutor(6) as ex:
        for d, status, cands, res in ex.map(run, comps):
            buyers[d] = cands
            if res:
                usage.write(json.dumps({"stage": "w1_fanout", "domain": d, "model": res.get("model"), "usage": res.get("usage")}) + "\n")
            if status.startswith("FAIL"):
                fails += 1
            if status == "budget_stop":
                stopped = True
            print(d, status, len(cands), flush=True)
    json.dump(buyers, open(os.path.join(RUN, "buyers_site.json"), "w"), indent=1)
    print("fails", fails, "| budget_stop", stopped, "| spent_usd", round(_spent_usd(), 4), "| cap", v4config.JEV_BUDGET_USD)
    if fails:
        sys.exit(2)
