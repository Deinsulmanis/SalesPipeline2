"""Fetch first-party website pages for V4 candidates (free, read-only).

Usage: python3 -I fetch_sites.py <run_dir>
Writes <run_dir>/sitecache/<domain>.json with {pages:[{url,status,final_url,title,text}], error}
"""
import json, re, sys, html, ssl, os, concurrent.futures as cf
import urllib.request, urllib.parse, urllib.error

RUN = sys.argv[1]
OUT = os.path.join(RUN, "sitecache")
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
KEY = re.compile(r"(employer|client|business|compan|service|industr|staffing|solution|about|team|leadership|our-people|staff|contact|trade|skilled|light-industrial|manufactur|construction|hire|workforce|labor|who-we|what-we|location|branch|news|blog|career|join|job)", re.I)
SKIP = re.compile(r"\.(pdf|jpg|jpeg|png|gif|svg|zip|docx?|xlsx?|mp4)$|mailto:|tel:|javascript:|#", re.I)


def get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        ct = r.headers.get("Content-Type", "")
        body = r.read(1_500_000)
        if "html" not in ct and "text" not in ct:
            return r.status, r.geturl(), ""
        enc = r.headers.get_content_charset() or "utf-8"
        return r.status, r.geturl(), body.decode(enc, errors="ignore")


def to_text(h):
    t = re.search(r"<title[^>]*>(.*?)</title>", h, re.S | re.I)
    title = html.unescape(t.group(1)).strip() if t else ""
    h = re.sub(r"<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>", "\n", h, flags=re.I)
    txt = html.unescape(re.sub(r"<[^>]+>", " ", h))
    txt = re.sub(r"[ \t\r\f\v]+", " ", txt)
    txt = re.sub(r"\n\s*\n+", "\n", txt)
    return title, txt.strip()


def links(h, base):
    host = urllib.parse.urlparse(base).netloc.lower().removeprefix("www.")
    out = []
    for m in re.finditer(r"<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", h, re.S | re.I):
        href, label = m.group(1).strip(), re.sub(r"<[^>]+>", " ", m.group(2))
        if SKIP.search(href):
            continue
        u = urllib.parse.urljoin(base, href)
        p = urllib.parse.urlparse(u)
        if p.scheme not in ("http", "https") or p.netloc.lower().removeprefix("www.") != host:
            continue
        u = u.split("#")[0].rstrip("/")
        if KEY.search(p.path + " " + label):
            out.append(u)
    seen, res = set(), []
    for u in out:
        if u not in seen:
            seen.add(u); res.append(u)
    return res


def crawl(domain):
    path = os.path.join(OUT, domain + ".json")
    if os.path.exists(path):
        return domain, "cached"
    rec = {"domain": domain, "pages": [], "error": None}
    home_html, home_url = None, None
    for start in (f"https://{domain}", f"https://www.{domain}", f"http://{domain}"):
        try:
            st, fu, h = get(start)
            home_html, home_url = h, fu
            title, txt = to_text(h)
            rec["pages"].append({"url": start, "final_url": fu, "status": st, "title": title, "text": txt[:20000]})
            break
        except urllib.error.HTTPError as e:
            rec["error"] = f"HTTP {e.code} at {start}"
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {str(e)[:120]} at {start}"
    if home_html:
        rec["error"] = None
        try:
            cand = links(home_html, home_url)
        except ValueError:  # a malformed href (e.g. "http://[button_link]") breaks urllib parsing
            cand = []
        # prioritise employer/service/industry/about pages
        pri = sorted(cand, key=lambda u: (0 if re.search(r"employer|client|business|service|industr|solution|trade|skilled|manufactur|construction|light", u, re.I) else 1 if re.search(r"about|who-we|what-we|location|branch|team|leadership|our-people|contact", u, re.I) else 2 if re.search(r"news|blog", u, re.I) else 3))
        for u in pri[:8]:
            try:
                st, fu, h = get(u)
                title, txt = to_text(h)
                rec["pages"].append({"url": u, "final_url": fu, "status": st, "title": title, "text": txt[:12000]})
            except urllib.error.HTTPError as e:
                rec["pages"].append({"url": u, "status": e.code, "error": "HTTP"})
            except Exception as e:
                rec["pages"].append({"url": u, "status": None, "error": type(e).__name__})
    json.dump(rec, open(path, "w"))
    return domain, rec["error"] or f"{len(rec['pages'])} pages"


def safe_crawl(domain):
    """One malformed site (e.g. a link urllib cannot parse) must not stop the whole crawl."""
    try:
        return crawl(domain)
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:120]}"
        path = os.path.join(OUT, domain + ".json")
        if not os.path.exists(path):
            json.dump({"domain": domain, "pages": [], "error": err}, open(path, "w"))
        return domain, err


if __name__ == "__main__":
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    doms = [c["domain"] for c in comps if c["pre_gate"] is None]
    with cf.ThreadPoolExecutor(24) as ex:
        for d, s in ex.map(safe_crawl, doms):
            print(d, "->", s, flush=True)
