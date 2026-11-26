"""Illinois Day and Temporary Labor Services Act registry -> agencies (owner brief 2026-11-25). Free.

Source: labor.illinois.gov, Fair Labor Standards Division, "2026 Registered Agencies as of November 2, 2026"
(RegisteredAgencies 11-2-26.pdf). Parsed from `pdftotext -layout` output.

Usage: python3 -I il_registry.py <run>      (reads <run>/raw/reg.txt)
Writes <run>/registry_rows.json (every row: name, address, city, state, zip, type Company/Branch, parent)
       <run>/agencies.json      (one per Company row, with its branches: [{city, state, address}])
Rows are in registry order; a Branch belongs to the Company row above it (same normalized name, or the last Company).
"""
import json
import os
import re
import sys

LEGAL = r"\b(inc|incorporated|llc|l l c|ltd|corp|corporation|co|company|pc|pllc|lp|llp|dba|d b a)\b"


def key(name):
    n = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower())
    n = re.sub(LEGAL, " ", n)
    return " ".join(n.split())


def main():
    run = sys.argv[1]
    lines = open(os.path.join(run, "raw", "reg.txt"), encoding="utf-8", errors="replace").read().splitlines()
    hdr = next(l for l in lines if l.startswith("Name") and "Postal Address" in l)
    cols = {c: hdr.index(c) for c in ("Name", "Postal Address", "City", "State", "Zip5", "Zip4", "Company/Branch")}
    rows = []
    for l in lines:
        if not l.strip() or l.startswith("Name") or "Registered Agencies for" in l:
            continue
        t = l.rstrip()
        m = re.search(r"\s(Company|Branch)\s*$", t)
        if not m:
            # a wrapped name continues the previous row's name (only text in the name column)
            if rows and len(t.strip()) < cols["Postal Address"] + 5 and not re.search(r"\d{5}", t):
                rows[-1]["name"] = (rows[-1]["name"] + " " + t.strip()).strip()
            continue

        def cut(a, b):
            return t[cols[a]:cols[b]].strip() if b else t[cols[a]:].strip()
        row = {"name": cut("Name", "Postal Address"), "address": cut("Postal Address", "City"), "city": cut("City", "State").title(),
               "state": cut("State", "Zip5"), "zip": cut("Zip5", "Zip4"), "type": m.group(1)}
        # pdftotext can shift a column by a few characters; repair state/zip from the tail when the cut looks wrong
        tail = re.search(r"\s([A-Z]{2})\s+(\d{5})\s+(\d{4})?\s*(Company|Branch)\s*$", t)
        if tail:
            row["state"], row["zip"] = tail.group(1), tail.group(2)
        rows.append(row)
    agencies, by_key, last = [], {}, None
    for r in rows:
        k = key(r["name"])
        if r["type"] == "Company":
            a = {"name": r["name"], "key": k, "address": r["address"], "city": r["city"], "state": r["state"], "zip": r["zip"],
                 "branches": []}
            agencies.append(a)
            by_key.setdefault(k, a)
            last = a
            r["parent"] = r["name"]
        else:
            parent = by_key.get(k) or last
            if parent:
                parent["branches"].append({"city": r["city"], "state": r["state"], "address": r["address"]})
                r["parent"] = parent["name"]
    json.dump(rows, open(os.path.join(run, "registry_rows.json"), "w"), indent=1)
    json.dump(agencies, open(os.path.join(run, "agencies.json"), "w"), indent=1)
    uniq = {a["key"] for a in agencies}
    print("rows", len(rows), "company rows", sum(r["type"] == "Company" for r in rows), "branch rows",
          sum(r["type"] == "Branch" for r in rows), "unique agencies", len(uniq),
          "with IL address or IL branch", sum(1 for a in agencies if a["state"] == "IL" or any(b["state"] == "IL" for b in a["branches"])))


if __name__ == "__main__":
    main()
