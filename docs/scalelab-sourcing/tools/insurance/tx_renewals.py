"""Insurance pilot, employer side: Texas WC policies renewing in the window (free, read-only open data).

Usage: python3 -I tx_renewals.py <run_dir> [--download] [--run-date YYYY-MM-DD]

--download pulls data.texas.gov c4xz-httr (record_type I = insured, expiration inside the 60-120 day window,
state standard premium >= $25k, PEO flag 1 = Non PEO) into <run>/tx/window_raw.json. Without it, the saved file
is reused. Then:
  - drops policies with a cancellation / non-renewal date and no later reinstatement;
  - maps the governing class code to an industry and the mailing ZIP to a metro (ins_config.py);
  - dedupes the same employer name + ZIP (several policies) keeping the highest premium.
Writes <run>/tx/employers.json (private run folder) and <run>/tx/counts.json (counts only, no names).
"""
import collections
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ins_config as C  # noqa: E402

RUN = sys.argv[1]
RUN_DATE = datetime.date.fromisoformat(sys.argv[sys.argv.index("--run-date") + 1]) if "--run-date" in sys.argv else datetime.date.today()
LO = RUN_DATE + datetime.timedelta(days=C.WINDOW_DAYS[0])
HI = RUN_DATE + datetime.timedelta(days=C.WINDOW_DAYS[1])
RAW = os.path.join(RUN, "tx", "window_raw.json")


def download():
    where = (f"record_type='I' AND policy_expiration_date between '{LO}T00:00:00' and '{HI}T23:59:59' "
             f"AND state_standard_premium >= {C.PREMIUM_MIN} AND peo_employee_leasing_policy={C.PEO_NON}")
    url = C.TX_DATASET + "?" + urllib.parse.urlencode({"$where": where, "$limit": 50000})
    with urllib.request.urlopen(url, timeout=180) as r:
        data = json.loads(r.read())
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    json.dump(data, open(RAW, "w"))
    return data


def main():
    rows = download() if "--download" in sys.argv else json.load(open(RAW))
    drop = collections.Counter()
    best = {}
    for r in rows:
        canc, rein = r.get("cancellation_effective_date"), r.get("endorsement_reinstatement")
        if canc and not (rein and rein >= canc):
            drop["cancelled_or_non_renewed"] += 1
            continue
        name = (r.get("insured_employer_name") or "").strip()
        z = (r.get("insured_employer_zip") or "")[:5]
        ind, sub = C.industry(r.get("governing_class_code"))
        rec = {
            "employer_name": name,
            "city": (r.get("insured_employer_city") or "").title(),
            "state": (r.get("insured_employer_state") or "").upper(),
            "zip": z,
            "address": (r.get("insured_employer_address") or "").strip(),
            "class_code": r.get("governing_class_code"),
            "industry": ind,
            "industry_sub": sub,
            "metro": C.metro(r.get("insured_employer_state"), z),
            "carrier": (r.get("coverage_provider_name") or "").strip(),
            "carrier_ncci_id": r.get("ncci_coverage_provider_id"),
            "effective": (r.get("policy_effective_date") or "")[:10],
            "expiration": (r.get("policy_expiration_date") or "")[:10],
            "premium": float(r.get("state_standard_premium") or 0),
            "business_market": r.get("business_market"),
        }
        rec["premium_band"] = C.premium_band(rec["premium"])
        rec["renewal_month"] = rec["expiration"][:7]
        rec["business_name"] = C.is_business_name(name)
        key = (name.lower(), z)
        if key in best:
            drop["duplicate_policy_same_employer"] += 1
            if rec["premium"] <= best[key]["premium"]:
                continue
        best[key] = rec
    emps = sorted(best.values(), key=lambda x: (-x["premium"], x["employer_name"]))
    for i, e in enumerate(emps):
        e["emp_id"] = f"E{i:05d}"
    json.dump(emps, open(os.path.join(RUN, "tx", "employers.json"), "w"), indent=1)

    def by(field):
        return dict(collections.Counter(e[field] for e in emps).most_common())
    ind_metro = collections.defaultdict(collections.Counter)
    for e in emps:
        ind_metro[e["metro"]][e["industry"]] += 1
    counts = {
        "run_date": str(RUN_DATE), "window": [str(LO), str(HI)], "filters": {"record_type": "I", "premium_min": C.PREMIUM_MIN, "peo_flag": "1 (Non PEO)"},
        "raw_rows": len(rows), "dropped": dict(drop), "employers": len(emps),
        "by_industry": by("industry"), "by_industry_sub": by("industry_sub"), "by_metro": by("metro"),
        "by_premium_band": by("premium_band"), "by_renewal_month": by("renewal_month"),
        "by_business_market": by("business_market"),
        "industry_by_metro": {m: dict(c) for m, c in sorted(ind_metro.items(), key=lambda kv: -sum(kv[1].values()))},
        "top_carriers": dict(collections.Counter(e["carrier"] for e in emps).most_common(15)),
        "business_name_share": round(sum(e["business_name"] for e in emps) / max(1, len(emps)), 3),
    }
    json.dump(counts, open(os.path.join(RUN, "tx", "counts.json"), "w"), indent=1)
    print(json.dumps({k: counts[k] for k in ("raw_rows", "dropped", "employers", "by_industry", "by_metro", "by_premium_band", "by_renewal_month")}, indent=1))


if __name__ == "__main__":
    main()
