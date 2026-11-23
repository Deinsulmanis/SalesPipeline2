"""V4 Stage 2 decision (run after qualify.py, which caches the supplemental answers): supplemental Jev check for tentative PASS + deterministic PASS/HOLD/REJECT in code.

Usage: python3 -I icp_decide.py <run_dir>
Writes icp_decisions.json. Thresholds are recorded in the run report.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v4config  # noqa: E402
import urllib.request, urllib.error, time

RUN = sys.argv[1]
MODEL = v4config.JEV_MODEL
T = {"identity": 0.7, "identity_conflict": 0.5, "type": 0.7, "industrial": 0.7, "model": 0.5, "us": 0.7, "chain": 0.5, "reject": 0.8, "hands_on": 0.7, "mgmt_only": 0.5}

SUPP_Q = {
    "hands_on_workers": {"type": "noul", "instructions": "Do the first_party_website excerpts show the company supplying or placing hands-on industrial or skilled-trades WORKERS (e.g. production/assembly workers, warehouse associates, general laborers, welders, electricians, millwrights, machinists, maintenance technicians, construction craft workers) to employer clients?"},
    "management_only": {"type": "noul", "instructions": "Is the company's industrial/construction/manufacturing offering limited to executive, management, engineering or other professional/white-collar roles (executive search), rather than hands-on industrial or trades workers?"},
}


def jev_q(state, questions):
    body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(v4config.JEV_URL, data=body, method="POST", headers=v4config.jev_headers())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(3 + 3 * attempt); continue
            raise RuntimeError(f"Jev HTTP {e.code}")


def p(ans, key, opt=None):
    a = ans[key]
    if a["type"] == "noul":
        return a["noul"]
    return a["probabilities"].get(opt, 0.0)


def main():
    from icp_gate import state_for
    comps = json.load(open(os.path.join(RUN, "companies.json")))
    out = []
    usage = open(os.path.join(RUN, "jev_usage.jsonl"), "a")
    for c in comps:
        d = c["domain"]
        r = {"domain": d, "company_name": c["company_name"], "dedupe_status": c["dedupe_status"]}
        if c["pre_gate"]:
            r.update(company_icp=c["pre_gate"], icp_reason_code="DUPLICATE" if c["pre_gate"] == "REJECT" else ("UNVERIFIED" if not d else "DUPLICATE"),
                     reason=c["pre_reason"], decided_by="dedupe (code)")
            if c["pre_gate"] == "HOLD" and d:
                r["icp_reason_code"] = "DUPLICATE"  # possible affiliate collision; needs human review
            out.append(r); continue
        evp = os.path.join(RUN, "evidence", d + ".json")
        ev = json.load(open(evp)) if os.path.exists(evp) else None
        jp = os.path.join(RUN, "jev_icp", d + ".json")
        if not ev or not ev["accessible"] or not os.path.exists(jp):
            why = (ev or {}).get("fetch_error") or f"only {(ev or {}).get('first_party_chars', 0)} characters of first-party text (JS-only, bot check, parked or empty page)"
            r.update(company_icp="HOLD", icp_reason_code="UNVERIFIED", reason=f"First-party website not accessible: {why}. Vendor 'industrial' label alone is not proof.", decided_by="code (site inaccessible)")
            out.append(r); continue
        res = json.load(open(jp)); a = res["answers"]
        r["jev_model"] = res.get("model")
        r["jev"] = {"identity_match": round(p(a, "identity_match"), 3), "business_type": a["business_type"]["choice"], "business_type_p": round(max(a["business_type"]["probabilities"].values()), 3),
                    "industrial_line": a["industrial_line"]["choice"], "industrial_line_p": round(max(a["industrial_line"]["probabilities"].values()), 3),
                    "service_model": a["service_model"]["choice"], "service_model_p": round(max(a["service_model"]["probabilities"].values()), 3),
                    "us_operations": round(p(a, "us_operations"), 3), "large_national_chain": round(p(a, "large_national_chain"), 3),
                    "confidence_min": round(min(a[k].get("confidence", 1) for k in ("business_type", "industrial_line", "service_model")), 3)}
        j = r["jev"]
        ind_ex = [z for z in ev["excerpts"] if "industrial" in z["tags"]]
        reasons = []
        identity, bt, il = j["identity_match"], j["business_type"], j["industrial_line"]
        # REJECT: positive evidence of exclusion on a confirmed identity
        if identity >= T["identity"] and bt in ("unrelated_business", "own_workforce_employer_or_contractor", "hr_tech_jobboard_training_marketing_consulting", "peo_eor_rpo_only") and j["business_type_p"] >= T["reject"]:
            r.update(company_icp="REJECT", icp_reason_code="NOT_STAFFING", reason=f"First-party site shows {bt.replace('_', ' ')} (p={j['business_type_p']}), not employer-facing staffing")
        elif identity >= T["identity"] and il == "excluded_vertical_only" and j["industrial_line_p"] >= T["reject"]:
            r.update(company_icp="REJECT", icp_reason_code="NO_INDUSTRIAL_LINE", reason=f"First-party site shows only excluded verticals (p={j['industrial_line_p']}), no industrial/skilled-trades staffing line")
        elif identity < T["identity_conflict"]:
            r.update(company_icp="HOLD", icp_reason_code="UNVERIFIED", reason=f"Identity conflict: website at {d} does not appear to belong to '{c['company_name']}' (identity p={identity}). Vendor domain likely wrong.")
        else:
            if identity < T["identity"]: reasons.append(f"identity match weak (p={identity})")
            if not (bt == "employer_facing_staffing" and j["business_type_p"] >= T["type"]): reasons.append(f"employer-facing staffing not established ({bt}, p={j['business_type_p']})")
            if not (il == "substantive_industrial_line" and j["industrial_line_p"] >= T["industrial"]): reasons.append(f"industrial line not established ({il}, p={j['industrial_line_p']})")
            if not (j["service_model"] in ("temporary_or_contract", "direct_hire_only") and j["service_model_p"] >= T["model"]): reasons.append(f"placement model unclear ({j['service_model']}, p={j['service_model_p']})")
            if j["us_operations"] < T["us"]: reasons.append(f"US operations not corroborated on first-party pages (p={j['us_operations']})")
            if j["large_national_chain"] >= T["chain"]: reasons.append(f"large national chain / franchise network (p={j['large_national_chain']}); central procurement/franchise complexity - owner decision")
            if not ind_ex: reasons.append("no first-party industrial excerpt captured")
            if not reasons:
                # supplemental check: hands-on workers vs management-only search
                sp = os.path.join(RUN, "jev_icp", d + ".supp.json")
                if os.path.exists(sp):
                    s = json.load(open(sp))
                else:
                    try:
                        s = jev_q(state_for(c, ev), SUPP_Q)
                    except Exception as e:
                        print("JEV FAILURE - fail closed:", d, e); sys.exit(2)
                    json.dump(s, open(sp, "w"), indent=1)
                    usage.write(json.dumps({"stage": "icp_supp", "domain": d, "model": s.get("model"), "usage": s.get("usage")}) + "\n")
                ho, mo = s["answers"]["hands_on_workers"]["noul"], s["answers"]["management_only"]["noul"]
                j["hands_on_workers"], j["management_only"] = round(ho, 3), round(mo, 3)
                if mo >= T["mgmt_only"] and ho < T["hands_on"]:
                    if mo >= T["reject"]:
                        r.update(company_icp="REJECT", icp_reason_code="NO_INDUSTRIAL_LINE", reason=f"Industrial offering is executive/management/professional search only (p={round(mo,2)}), not hands-on industrial or trades staffing")
                    else:
                        reasons.append(f"may be executive/management search only (p={round(mo,2)})")
                elif ho < T["hands_on"]:
                    reasons.append(f"hands-on industrial/trades worker placement not clearly shown (p={round(ho,2)})")
                if j["service_model"] == "direct_hire_only" and "company_icp" not in r:
                    reasons.append("direct-hire only: eligible as secondary segment only if industrial skilled-trades direct hire; review") if ho < 0.85 else None
            if "company_icp" not in r:
                if reasons:
                    r.update(company_icp="HOLD", icp_reason_code="UNVERIFIED" if "chain" not in " ".join(reasons) else "OTHER", reason="; ".join(reasons))
                else:
                    r.update(company_icp="PASS", icp_reason_code="VERIFIED_INDUSTRIAL_STAFFING", reason="First-party site shows US employer-facing staffing with a substantive industrial/skilled-trades line placing hands-on workers")
        r["decided_by"] = "Jev answers + code thresholds"
        r["industrial_specializations"] = ev["keyword_specializations"]
        r["staffing_models"] = ev["keyword_models"]
        r["icp_evidence"] = [{"url": z["url"], "excerpt": z["excerpt"], "observed_at": z["observed_at"], "published_at": None} for z in (ind_ex[:4] + [z for z in ev["excerpts"] if "employer_facing" in z["tags"] and z not in ind_ex][:2] + [z for z in ev["excerpts"] if "geo" in z["tags"]][:1])]
        out.append(r)
    json.dump(out, open(os.path.join(RUN, "icp_decisions.json"), "w"), indent=1)
    from collections import Counter
    print(Counter((x["company_icp"], x["icp_reason_code"]) for x in out))
    for x in out:
        if x["company_icp"] == "PASS": print("PASS", x["domain"], x.get("jev", {}).get("hands_on_workers"), x["industrial_specializations"][:5])
    for x in out:
        if x["company_icp"] != "PASS" and x.get("jev"): print(x["company_icp"], x["domain"], "|", x["reason"][:170])


if __name__ == "__main__":
    main()
