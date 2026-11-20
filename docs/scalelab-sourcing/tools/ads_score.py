"""Stage 3/5: classify PASS-company ads with Jev (one request per company) and score signals in code.

Usage: python3 -I w1_ads.py <run_dir>
Writes ad_classification.json, scores.json; appends jev_usage.jsonl
Freshness: an ad is CURRENT if Google last_seen, or Meta end/active date, is within V4_AD_WINDOW_DAYS (default 30) of V4_RUN_DATE.
LinkedIn ads carry no dates in Adyntel's response -> treated as UNDATED (not current) unless re-checked.
"""
import json, os, sys, re, datetime, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402  run settings (env-driven)

RUN = sys.argv[1]
TODAY = v4config.RUN_DAY
WIN = datetime.timedelta(days=v4config.AD_WINDOW_DAYS)
MODEL = v4config.JEV_MODEL


def jev(state, qs):
    req = urllib.request.Request(v4config.JEV_URL, data=json.dumps({"model": MODEL, "state": state, "questions": qs}).encode(), method="POST",
                                 headers=v4config.jev_headers())
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def ts(v):
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
        return datetime.datetime.fromtimestamp(int(v), datetime.UTC).date()
    try:
        return datetime.date.fromisoformat(str(v)[:10])
    except Exception:
        return None


def load(path):
    if not os.path.exists(path):
        return None
    return (json.load(open(path)).get("response") or {})


def ads_for(d, intent):
    ads = []
    g = load(f"{RUN}/ads/{d}.google.text.json")
    if g and g.get("processed_ads"):
        seen = set()
        for a in g["processed_ads"]:
            t = (a.get("raw_text") or "").strip()
            if not t or t in seen:
                continue
            seen.add(t)
            last = ts(a.get("last_seen"))
            ads.append({"platform": "Google", "advertiser": a.get("advertiser_name"), "start": a.get("start"), "last_seen": a.get("last_seen"),
                        "current": bool(last and TODAY - last <= WIN), "text": t[:400], "url": a.get("original_url")})
    else:
        g = load(f"{RUN}/ads/{d}.google.json")
        for a in (g or {}).get("ads", []):
            last = ts(a.get("last_seen"))
            ads.append({"platform": "Google", "advertiser": a.get("advertiser_name"), "start": a.get("start"), "last_seen": a.get("last_seen"),
                        "current": bool(last and TODAY - last <= WIN), "text": "(text not extracted)", "url": a.get("original_url")})
    m = load(f"{RUN}/ads/{d}.meta.json")
    for a in (m or {}).get("results", []) or []:
        if isinstance(a, list):
            a = a[0]
        s = a.get("snapshot") or {}
        c = (s.get("cards") or [{}])[0]
        body = c.get("body") or ((s.get("body") or {}).get("text") if isinstance(s.get("body"), dict) else s.get("body")) or ""
        end = ts(a.get("end_date_string") or a.get("end_date"))
        cur = bool(a.get("is_active")) or bool(end and TODAY - end <= WIN)
        ads.append({"platform": "Meta", "advertiser": s.get("page_name"), "start": a.get("start_date_string") or a.get("start_date"), "last_seen": a.get("end_date_string") or a.get("end_date"),
                    "current": cur, "text": ((c.get("title") or "") + " | " + body)[:400], "url": c.get("link_url") or s.get("link_url")})
    if intent:
        for a in intent.get("ads", []):
            ads.append({"platform": "Meta (keyword search)", "advertiser": intent.get("page_name"), "start": a.get("start"), "last_seen": a.get("end"),
                        "current": bool(a.get("active")), "text": ((a.get("title") or "") + " | " + (a.get("text") or ""))[:400], "url": a.get("link")})
    li = load(f"{RUN}/ads/{d}.linkedin.json")
    for a in (li or {}).get("ads", []) or []:
        ads.append({"platform": "LinkedIn", "advertiser": (a.get("advertiser") or {}).get("name"), "start": None, "last_seen": None, "current": False,
                    "undated": True, "text": (((a.get("headline") or {}).get("title") or "") + " | " + ((a.get("commentary") or {}).get("text") or ""))[:400], "url": a.get("view_details_link")})
    # de-duplicate identical texts across platforms
    out, seen = [], set()
    for a in ads:
        k = (a["platform"].split()[0], a["text"].lower())
        if k in seen:
            continue
        seen.add(k); out.append(a)
    return out[:40]


if __name__ == "__main__":
    dec = json.load(open(f"{RUN}/icp_decisions.json"))
    comps = {c["domain"]: c for c in json.load(open(f"{RUN}/companies.json"))}
    usage = open(f"{RUN}/jev_usage.jsonl", "a")
    classified, scores = {}, {}
    for x in dec:
        if x["company_icp"] != "PASS":
            continue
        d = x["domain"]
        ads = ads_for(d, comps[d].get("intent_ads"))
        real = [a for a in ads if a["text"] != "(text not extracted)"]
        s = {"employer_facing_ads": 0, "own_company_bd_hiring": 0, "market_expansion": 0, "sustained_employer_ads": 0, "other_commercial_growth": 0}
        info = {"ad_count": len(ads), "ad_class": "NO_ADS_OBSERVED" if not ads else "UNRELATED_OR_UNCLEAR", "freshness": None, "employer_ads_current": 0, "employer_ads_total": 0, "attribution_p": None, "why": ""}
        if real:
            st = {"target_company": x["company_name"], "target_domain": d, "ads": [{"id": f"a{i}", **{k: a[k] for k in ("platform", "advertiser", "start", "last_seen", "text")}} for i, a in enumerate(real)]}
            qs = {"ad_class": {"type": "choice", "instructions": "Taking all ads together, who are they trying to win? The advertiser is a staffing agency.", "criteria": {
                    "EMPLOYER_ACQUISITION": "Ads promote staffing/labor services to BUSINESSES that need workers.",
                    "CANDIDATE_RECRUITMENT": "Ads promote jobs to WORKERS / job seekers.",
                    "MIXED": "Some ads clearly target employers, others clearly target job seekers.",
                    "UNRELATED_OR_UNCLEAR": "Audience cannot be resolved."}},
                  "attribution": {"type": "noul", "instructions": "Do these ads promote the target_company itself (its own name or brand appears, or the advertiser is clearly the same business or its stated parent/marketing agent), rather than an unrelated business?"}}
            for i, _ in enumerate(real):
                qs[f"emp_a{i}"] = {"type": "noul", "instructions": f"Is ad a{i} aimed at BUSINESSES/employers (offering them staffing or workers), rather than at job seekers?"}
            res = jev(st, qs)
            usage.write(json.dumps({"stage": "w1_ads", "domain": d, "model": res.get("model"), "usage": res.get("usage")}) + "\n")
            A = res["answers"]
            for i, a in enumerate(real):
                a["employer_p"] = round(A[f"emp_a{i}"]["noul"], 3)
            info["ad_class"] = A["ad_class"]["choice"]
            info["attribution_p"] = round(A["attribution"]["noul"], 3)
            emp = [a for a in real if a["employer_p"] >= 0.7]
            emp_cur = [a for a in emp if a["current"]]
            info["employer_ads_total"], info["employer_ads_current"] = len(emp), len(emp_cur)
            any_cur = any(a["current"] for a in ads)
            info["freshness"] = "CURRENT" if any_cur else ("UNDATED" if any(a.get("undated") for a in ads) and not any(a["platform"] != "LinkedIn" for a in ads) else "STALE")
            if info["attribution_p"] >= 0.7 and emp_cur:
                s["employer_facing_ads"] = 40
                starts = [ts(a["start"]) for a in emp if ts(a["start"])]
                if len(emp) >= 3 and starts and (TODAY - min(starts)).days >= 60:
                    s["sustained_employer_ads"] = 10
            info["why"] = f"{len(ads)} ads ({sum(a['current'] for a in ads)} current); {len(emp)} employer-facing ({len(emp_cur)} current); attribution p={info['attribution_p']}; class {info['ad_class']}"
            classified[d] = {"ads": real, "jev_model": res.get("model")}
        elif ads:
            info["freshness"] = "CURRENT" if any(a["current"] for a in ads) else "STALE"
            info["why"] = f"{len(ads)} ads, text not extracted (stale or advertiser mismatch) -> not scored"
        s["total"] = sum(s.values())
        scores[d] = {"signals": s, "ads": info}
        print(d, s["total"], info["ad_class"], info["why"][:120])
    json.dump(classified, open(f"{RUN}/ad_classification.json", "w"), indent=1)
    json.dump(scores, open(f"{RUN}/scores.json", "w"), indent=1)
