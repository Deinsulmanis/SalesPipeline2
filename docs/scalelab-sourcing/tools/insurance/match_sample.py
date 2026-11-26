"""Insurance pilot, contact match test: draw the random employer sample and write the domain-lookup query lists.

Usage: python3 -I match_sample.py <run_dir> [--n 200] [--seed 20261126] [--parts 4]
Reads <run>/tx/employers.json. Writes <run>/match/sample.json and <run>/match/lookup_<k>.txt, one query per line:
    emp_id|query_name|location        (location = "Texas, US" or "<State>, US" from the policy mailing address)
The query name drops legal suffixes and a trailing word cut off by the dataset's ~35-character name field.
"""
import json, os, random, re, sys

RUN = sys.argv[1]
N = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 200
SEED = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 20261126
PARTS = int(sys.argv[sys.argv.index("--parts") + 1]) if "--parts" in sys.argv else 4
SUFFIX = re.compile(r"(?i)[,.]?\s+\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|lp|llp|pllc|pc|dba.*)\.?$")
STATES = {"TX": "Texas", "CA": "California", "LA": "Louisiana", "FL": "Florida", "CO": "Colorado", "GA": "Georgia", "OK": "Oklahoma",
          "IL": "Illinois", "NY": "New York", "OH": "Ohio", "PA": "Pennsylvania", "AZ": "Arizona", "TN": "Tennessee", "NC": "North Carolina",
          "MO": "Missouri", "MI": "Michigan", "NJ": "New Jersey", "MN": "Minnesota", "WI": "Wisconsin", "IN": "Indiana", "VA": "Virginia",
          "UT": "Utah", "WA": "Washington", "AL": "Alabama", "AR": "Arkansas", "KS": "Kansas", "NE": "Nebraska", "MA": "Massachusetts",
          "CT": "Connecticut", "SC": "South Carolina", "KY": "Kentucky", "MD": "Maryland", "NV": "Nevada", "OR": "Oregon", "IA": "Iowa",
          "MS": "Mississippi", "NM": "New Mexico", "ID": "Idaho", "DE": "Delaware", "WV": "West Virginia", "NH": "New Hampshire"}


def query_name(name):
    n = re.sub(r"\s+", " ", name or "").strip()
    if len(n) >= 34 and " " in n:  # dataset truncates around 35 chars: drop the cut-off last word
        n = n.rsplit(" ", 1)[0]
    for _ in range(2):
        n = SUFFIX.sub("", n).strip(" ,.")
    return n.replace("|", "/")


def main():
    emps = json.load(open(os.path.join(RUN, "tx", "employers.json")))
    random.seed(SEED)
    sample = random.sample(emps, min(N, len(emps)))
    os.makedirs(os.path.join(RUN, "match"), exist_ok=True)
    for s in sample:
        s["query_name"] = query_name(s["employer_name"])
        s["query_location"] = f"{STATES.get(s['state'], s['state'])}, US"
    json.dump(sample, open(os.path.join(RUN, "match", "sample.json"), "w"), indent=1)
    for k in range(PARTS):
        part = sample[k::PARTS]
        open(os.path.join(RUN, "match", f"lookup_{k}.txt"), "w").write(
            "\n".join(f"{s['emp_id']}|{s['query_name']}|{s['query_location']}" for s in part) + "\n")
    from collections import Counter
    print("sample", len(sample), dict(Counter(s["industry"] for s in sample)), "TX address", sum(s["state"] == "TX" for s in sample),
          "business names", sum(s["business_name"] for s in sample))


if __name__ == "__main__":
    main()
