"""TDI licence list: resolve agency domains from free Apollo organization lookups (city-filtered) and/or domain guesses.

Usage: python3 -I tdi_resolve.py <run_dir> apollo <transcript> [...]      (parse helper transcripts)
       python3 -I tdi_resolve.py <run_dir> guess  [--workers 24]          (free domain guesses, verified on the site)
Reads <run>/tdi/lookup_set.json (npn, name, query, city, loc ...). Writes/merges <run>/tdi/resolved.json
{npn: {domain, how, ...}}.
  apollo: a lookup made with organization_locations = ["<City>, TX"] is accepted only when the Apollo name matches the
          licence name (exact or strong, as in domain_resolve.py): name + city.
  guess:  candidate domains from the licence name (joined tokens, with / without agency / insurance / group words,
          .com / .net); a candidate is accepted only when its own homepage or contact page shows the agency name AND the
          licence city (name + city), and is not a parked page. DNS-over-HTTPS first, then one page fetch.
"""
import concurrent.futures as cf, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from transcripts import calls  # noqa: E402
from domain_resolve import score, core  # noqa: E402

RUN, MODE = sys.argv[1], sys.argv[2]
OUT = os.path.join(RUN, "tdi", "resolved.json")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36"}
PARKED = re.compile(r"(?i)domain (is )?for sale|buy this domain|parked free|godaddy|this domain may be for sale|sedo|hugedomains|dan\.com")
GENERIC = {"insurance", "agency", "agencies", "group", "services", "service", "ins", "and", "the", "of", "associates", "company", "inc", "llc"}


def load():
    return json.load(open(OUT)) if os.path.exists(OUT) else {}


def apollo():
    firms = {x["query"]: x for x in json.load(open(os.path.join(RUN, "tdi", "lookup_set.json")))}
    res, n_calls, hits = load(), 0, 0
    for inp, out in calls(sys.argv[3:], "organizations_lookup"):
        x = firms.get(inp.get("q_organization_fuzzy_name"))
        if not x or not inp.get("organization_locations"):
            continue
        n_calls += 1
        x.setdefault("_apollo_done", True)
        best = None
        for org in out.get("organizations") or []:
            dom = (org.get("primary_domain") or org.get("domain") or "").lower().removeprefix("www.")
            sc, kind = score(x["name"], org.get("name"))
            if dom and kind in ("exact", "strong") and (best is None or sc > best[0]):
                best = (sc, dom, org.get("name"), kind)
        if best and x["npn"] not in res:
            hits += 1
            res[x["npn"]] = {"domain": best[1], "how": f"apollo_{best[3]}_city_filtered", "apollo_name": best[2]}
    json.dump(res, open(OUT, "w"), indent=1)
    done = sorted({inp.get("q_organization_fuzzy_name") for inp, _ in calls(sys.argv[3:], "organizations_lookup") if inp.get("organization_locations")})
    json.dump(done, open(os.path.join(RUN, "tdi", "apollo_done_queries.json"), "w"))
    print(json.dumps({"apollo_calls_parsed": n_calls, "queries_done": len(done), "accepted": hits, "resolved_total": len(res)}))


def candidates(name):
    toks = [t for t in core(name) if t not in ("dba",)]
    words = [t for t in re.sub(r"[^a-z0-9 ]", " ", name.lower().replace("&", " and ")).split() if t not in ("llc", "inc", "co", "corp", "ltd", "lp", "pllc", "dba")]
    base = [t for t in words if t not in ("the",)]
    if not base:
        return []
    joined = "".join(base)
    stem = "".join(t for t in base if t not in ("insurance", "agency", "group", "services", "inc"))
    c = [joined, stem + "insurance", stem + "ins", stem + "insuranceagency", stem + "agency", stem + "insurancegroup", "-".join(base), stem]
    out = []
    for s in c:
        if 4 <= len(s) <= 40 and s not in out:
            out.append(s)
    return [s + tld for s in out[:6] for tld in (".com", ".net")][:10]


def doh(dom):
    try:
        with urllib.request.urlopen(f"https://dns.google/resolve?name={dom}&type=A", timeout=10) as r:
            return bool(json.loads(r.read()).get("Answer"))
    except Exception:
        return False


def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=12) as r:
            return r.geturl(), r.read(600000).decode("utf-8", "ignore")
    except Exception:
        return None, ""


def text_of(h):
    h = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", h)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)).lower()


def verify(dom, x):
    final, h = fetch(f"https://{dom}")
    if not h:
        final, h = fetch(f"http://{dom}")
    if not h or PARKED.search(h[:20000]):
        return None
    t = text_of(h)
    if (x.get("city") or "").lower() not in t:
        m = re.search(r'href=["\']([^"\']*contact[^"\']*)', h, re.I)
        if m:
            u = m.group(1) if m.group(1).startswith("http") else f"https://{dom}/" + m.group(1).lstrip("/")
            _, h2 = fetch(u)
            t += " " + text_of(h2)
    distinct = [w for w in core(x["name"]) if w not in GENERIC and len(w) >= 3]
    name_ok = distinct and all(w in t for w in distinct[:3])
    city_ok = (x.get("city") or "").lower() in t
    if name_ok and city_ok:
        host = (final or "").split("//")[-1].split("/")[0].lower().removeprefix("www.")
        return host or dom
    return None


def guess():
    firms = json.load(open(os.path.join(RUN, "tdi", "lookup_set.json")))
    res = load()
    todo = [x for x in firms if x["npn"] not in res]
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 24

    def one(x):
        for d in candidates(x["name"]):
            if doh(d):
                v = verify(d, x)
                if v:
                    return x["npn"], v
        return x["npn"], None
    hits = 0
    with cf.ThreadPoolExecutor(workers) as ex:
        for npn, dom in ex.map(one, todo):
            if dom:
                hits += 1
                res[npn] = {"domain": dom, "how": "guess_verified_name_city"}
    json.dump(res, open(OUT, "w"), indent=1)
    print(json.dumps({"guessed_firms": len(todo), "accepted": hits, "resolved_total": len(res)}))


if __name__ == "__main__":
    apollo() if MODE == "apollo" else guess()
