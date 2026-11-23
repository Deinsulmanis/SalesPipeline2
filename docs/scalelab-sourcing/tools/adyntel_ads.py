"""V4 Stage 3: Adyntel ad lookups for ICP PASS companies only, with a hard credit cap.

Usage: python3 -I adyntel_ads.py <run_dir> <cap_credits> [--only dom1,dom2 | --only @domains.json] [--platforms google,meta]
Credentials: ADYNTEL_EMAIL / ADYNTEL_API_KEY from env, sent in the JSON body, never printed.
Each request costs 1 credit (Adyntel bills per request). First page only, no extract-text, no all_ads.
Writes ads/<domain>.<platform>.json and adyntel_ledger.jsonl.
"""
import json, os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402  run settings (env-driven)

RUN, CAP = sys.argv[1], int(sys.argv[2])
_only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
ONLY = (set(json.load(open(_only[1:]))) if _only.startswith("@") else set(_only.split(","))) if _only else None
E, K = v4config.adyntel_credentials()
if not E or not K:
    print("Adyntel credentials missing - fail closed"); sys.exit(2)
os.makedirs(os.path.join(RUN, "ads"), exist_ok=True)
LEDGER = os.path.join(RUN, "adyntel_ledger.jsonl")


def post(path, extra, timeout=120):
    body = json.dumps({"email": E, "api_key": K, **extra}).encode()
    req = urllib.request.Request("https://api.adyntel.com/" + path, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        txt = e.read()[:500]
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"error_text": txt.decode(errors="ignore")}


def balance():
    st, b = post("credits_check", {}, timeout=30)
    if st != 200:
        raise RuntimeError(f"credits_check HTTP {st}")
    return b["current_credits"]


PLATFORMS = [
    ("google", "google", lambda d: {"company_domain": d, "country_code": "US"}),
    ("meta", "facebook", lambda d: {"company_domain": d, "country_code": "US", "active_status": "all"}),
    ("linkedin", "linkedin", lambda d: {"company_domain": d, "country": "US"}),
]
# --platforms google,meta limits the lookups (and the credits) to those platforms.
if "--platforms" in sys.argv:
    _want = set(sys.argv[sys.argv.index("--platforms") + 1].split(","))
    PLATFORMS = [p for p in PLATFORMS if p[0] in _want]
    if not PLATFORMS:
        raise SystemExit("--platforms matched nothing (use google, meta, linkedin)")

if __name__ == "__main__":
    dec = json.load(open(os.path.join(RUN, "icp_decisions.json")))
    doms = [x["domain"] for x in dec if x["company_icp"] == "PASS" and (not ONLY or x["domain"] in ONLY)]
    start = balance()
    print("balance_start", start, "companies", len(doms), "max requests", len(doms) * len(PLATFORMS), "cap", CAP)
    spent_prev = 0
    if os.path.exists(LEDGER):
        spent_prev = sum(json.loads(l).get("credits_charged_est", 0) for l in open(LEDGER))
    used = spent_prev
    for d in doms:
        for name, path, mk in PLATFORMS:
            out = os.path.join(RUN, "ads", f"{d}.{name}.json")
            if os.path.exists(out):
                continue
            if used + 1 > CAP:
                print("CAP REACHED - stopping", used); sys.exit(0)
            t0 = time.time()
            st, res = post(path, mk(d))
            charged = 0 if st in (400, 401, 402, 422) else 1
            used += charged
            json.dump({"status": st, "request": {k: v for k, v in mk(d).items()}, "observed_at": time.strftime("%Y-%m-%d"), "response": res}, open(out, "w"))
            n = None
            if isinstance(res, dict):
                for k in ("ads", "processed_ads", "results", "brand_ads"):
                    if isinstance(res.get(k), list):
                        n = len(res[k]); break
                n = res.get("total_ads", n) if n is None else n
            with open(LEDGER, "a") as f:
                f.write(json.dumps({"domain": d, "platform": name, "status": st, "credits_charged_est": charged, "ads_returned": n, "secs": round(time.time() - t0, 1)}) + "\n")
            print(d, name, st, "ads:", n, "used_est:", used, flush=True)
    end = balance()
    print("balance_end", end, "actual_spent_this_run", start - end, "ledger_total_est", used)
