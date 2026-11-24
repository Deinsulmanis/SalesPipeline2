"""Name-collision triage (owner decision 2026-11-24): is a held NAME_COLLISION the same company as the production lead
it collides with, or a different company that merely shares a name?

Free, read-only. For each candidate in <run>/discovery_excluded.json with excluded NAME_COLLISION, find the production
rows whose name stem matches (discover_merge.stem), then compare:
  - domains: same registered domain, or one domain's brand label contains the other's (acme.com / acmestaffing.com)
  - redirect: the candidate homepage's final host is the production domain (or any excluded domain)
  - cross-link: either homepage links to the other's domain
  - site title: normalized title tokens of the two homepages (Jaccard)
  - city/state: the production lead's city appears on the candidate's homepage text
Verdicts:
  SAME       redirect, cross-link, shared brand domain, or (title Jaccard >= 0.6 and the production city on the candidate site)
  DIFFERENT  candidate site readable, no SAME signal, title Jaccard < 0.4, and the production city (when known) not on
             the candidate's site
  UNSURE     everything else (held for the owner)
DIFFERENT candidates go on to the normal pipeline (crawl, gate, buyers) under the same caps; SAME and UNSURE stay held.

Usage: python3 -I collision_triage.py <run> <prod_rows.txt>
  prod_rows.txt: the stage-1 style dump "client~name~website_domain~email_domain~city|..." (Supabase, read-only)
Writes <run>/collision_triage.json and, with --apply, appends DIFFERENT domains to <run>/disc/COLLISION_DIFFERENT.txt.
"""
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv, _argv = sys.argv[:2] + ["--"], sys.argv  # discover_merge reads argv at import; give it a harmless one
import discover_merge as dm  # noqa: E402
sys.argv = _argv

UA = {"User-Agent": "Mozilla/5.0 (compatible; research-crawler)"}
STOP = set("staffing staff services inc llc group solutions personnel employment agency workforce resources home the and of".split())


class _P(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title, self.links, self._t, self.text = "", set(), False, []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._t = True
        if tag == "a":
            h = dict(attrs).get("href") or ""
            m = re.match(r"https?://([^/:?#]+)", h)
            if m:
                self.links.add(dm.root(m.group(1)))

    def handle_endtag(self, tag):
        if tag == "title":
            self._t = False

    def handle_data(self, data):
        if self._t:
            self.title += data
        self.text.append(data)


def fetch(domain):
    for scheme in ("https://", "http://"):
        try:
            req = urllib.request.Request(scheme + domain, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                final = dm.root(urllib.parse.urlparse(r.geturl()).hostname or domain)
                html = r.read(600000).decode("utf-8", "replace")
            p = _P()
            p.feed(html)
            return {"ok": True, "final": final, "title": " ".join(p.title.split())[:150], "links": sorted(p.links),
                    "text": " ".join(" ".join(p.text).split())[:200000]}
        except Exception as e:  # noqa: BLE001 - any fetch failure is just "not readable"
            err = str(e)[:80]
    return {"ok": False, "error": err}


def toks(t):
    return {w for w in re.sub(r"[^a-z0-9 ]", " ", (t or "").lower()).split() if w not in STOP and len(w) > 1}


def jacc(a, b):
    a, b = toks(a), toks(b)
    return len(a & b) / len(a | b) if a and b else 0.0


def label(d):
    return re.sub(r"[^a-z0-9]", "", (d or "").split(".")[0])


def main():
    import urllib.parse  # noqa: F401
    run, dump = sys.argv[1], sys.argv[2]
    apply = "--apply" in sys.argv
    exclude = json.load(open(os.path.join(run, "exclude_domains.json")))
    cands = [x for x in json.load(open(os.path.join(run, "discovery_excluded.json"))) if x["excluded"].startswith("NAME_COLLISION")]
    raw = open(dump).read()
    try:
        t = json.loads(raw)["result"]
        raw = json.loads(re.search(r"<untrusted-data-[^>]+>\s*(\[.*\])\s*</untrusted-data", t, re.S).group(1))[0]["x"]
    except (ValueError, KeyError, AttributeError):
        pass
    rows = []
    for part in raw.split("|"):
        f = part.split("~")
        if len(f) >= 5:
            rows.append({"client": f[0], "name": f[1], "web": f[2], "edom": f[3], "city": f[4].strip()})
    by_stem = {}
    for r in rows:
        s = dm.stem(r["name"])
        if len(s) >= 4:
            by_stem.setdefault(s, []).append(r)
    jobs = {}
    for c in cands:
        hits = by_stem.get(dm.stem(c["company_name"]), [])
        c["_hits"] = hits
        jobs[c["domain"]] = None
        for h in hits:
            for dd in (h["web"], h["edom"]):
                if dd and "." in dd:
                    jobs[dd] = None
    with ThreadPoolExecutor(16) as ex:
        for d, res in zip(list(jobs), ex.map(fetch, list(jobs))):
            jobs[d] = res
    out, new_lines = [], []
    for c in cands:
        d, me = c["domain"], jobs[c["domain"]]
        pdoms = sorted({x for h in c["_hits"] for x in (h["web"], h["edom"]) if x and "." in x})
        cities = sorted({h["city"] for h in c["_hits"] if h["city"]})
        sig, best_j = [], 0.0
        for pd in pdoms:
            if pd == d:
                sig.append("same domain")
            if label(pd) and label(d) and label(pd) != label(d) and (label(pd) in label(d) or label(d) in label(pd)) and min(len(label(pd)), len(label(d))) >= 5:
                sig.append(f"shared brand domain ({pd})")
            if me.get("ok") and (me["final"] == pd):
                sig.append(f"redirects to {pd}")
            if me.get("ok") and pd in me["links"]:
                sig.append(f"links to {pd}")
            them = jobs.get(pd) or {}
            if them.get("ok") and d in them["links"]:
                sig.append(f"{pd} links to it")
            if me.get("ok") and them.get("ok"):
                best_j = max(best_j, jacc(me["title"], them["title"]))
        if me.get("ok") and me["final"] in exclude and me["final"] != d:
            sig.append(f"redirects to excluded {me['final']}")
        city_hit = bool(me.get("ok") and any(ct and ct.lower() in me["text"].lower() for ct in cities))
        if sig or (best_j >= 0.6 and city_hit):
            verdict = "SAME"
        elif me.get("ok") and best_j < 0.4 and not city_hit:
            verdict = "DIFFERENT"
        else:
            verdict = "UNSURE"
        clients = sorted({h["client"] for h in c["_hits"]})
        out.append({"domain": d, "company_name": c["company_name"], "collides_with": c["excluded"], "clients": clients,
                    "prod_domains": pdoms, "prod_cities": cities, "candidate_title": (me or {}).get("title", ""),
                    "candidate_readable": bool(me and me.get("ok")), "title_jaccard": round(best_j, 2), "prod_city_on_site": city_hit,
                    "signals": sig, "verdict": verdict})
        if verdict == "DIFFERENT":
            new_lines.append("|".join([d, c["company_name"].replace("|", "/"), "collision-triage", (c.get("slice") or "triage"), "0",
                                       (c.get("groups") or ["COLLISION_DIFFERENT"])[0]]))
    json.dump(out, open(os.path.join(run, "collision_triage.json"), "w"), indent=1)
    from collections import Counter
    print("candidates", len(out), dict(Counter(x["verdict"] for x in out)))
    if apply:
        open(os.path.join(run, "disc", "COLLISION_DIFFERENT.txt"), "w").write("\n".join(new_lines) + ("\n" if new_lines else ""))
        print("appended", len(new_lines), "DIFFERENT candidates to disc/COLLISION_DIFFERENT.txt")


if __name__ == "__main__":
    main()
