#!/usr/bin/env python3
"""Score job postings 0-100 against Manish's master profile.

Score = keyword overlap (50) + seniority fit (20) + location/remote fit (20)
        + company quality signal (10). Discard < 55. Auto-submit >= 70.

Usage: python3 scorer.py postings.json  -> prints scored JSON to stdout
"""
import json
import re
import sys

CORE = ["abap", "s/4hana", "rap", "cds", "fiori", "btp", "odata"]
EXTRA = ["abap cloud", "clean core", "cap", "amdp", "hana", "sapui5",
         "adobe forms", "brf+", "workflow", "ricefw", "restful application",
         "side-by-side", "in-app", "extensibility", "abapgit", "atc",
         "abap unit", "gcts", "mm", "qm", "sd", "fi"]
HARD_SKIP = ["basis administrat", "sap basis admin", "security administrat",
             "payroll consultant", "successfactors consultant only"]
TIER1 = ["rolls-royce", "siemens", "zeiss", "schaeffler", "bosch", "infineon",
         "ford", "walmart", "jpmorgan", "morgan stanley", "blackrock", "bny",
         "nomura", "agilent", "lonza", "carlsberg", "airbus", "metlife",
         "best buy", "ferguson", "marriott", "renault"]
TIER2 = ["deloitte", "capgemini", "ibm", "kyndryl", "ltimindtree", "ntt data",
         "cognizant", "infosys", "wipro", "tcs", "tech mahindra", "dxc",
         "accenture"]
GOOD_LOC = ["hyderabad", "bengaluru", "bangalore", "pune", "remote"]
OK_LOC = ["chennai", "mumbai", "noida", "gurgaon", "gurugram", "kolkata",
          "kochi", "coimbatore", "india"]


def score(p):
    text = " ".join(str(p.get(k, "")) for k in
                    ("title", "jd_summary", "required_experience")).lower()
    reasons = []

    for s in HARD_SKIP:
        if s in text:
            return None, f"hard_skip:{s}"

    core_hits = [k for k in CORE if k in text]
    if len(core_hits) < 2:
        return None, f"must_have_overlap<2 (only {core_hits})"

    extra_hits = [k for k in EXTRA if re.search(r"\b" + re.escape(k) + r"\b", text)]
    kw = min(50, len(core_hits) * 5 + len(extra_hits) * 2)
    reasons.append(f"kw={kw} core:{','.join(core_hits)}")

    # Seniority: look for a years range overlapping 4-9
    sen = 12
    m = re.findall(r"(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s*(?:\+)?\s*y", text)
    m2 = re.findall(r"(\d{1,2})\s*\+\s*y", text)
    if m:
        lo, hi = int(m[0][0]), int(m[0][1])
        if lo >= 10:
            return None, f"seniority {lo}-{hi} too senior"
        if hi <= 3:
            return None, f"seniority {lo}-{hi} too junior"
        sen = 20 if lo <= 5 <= hi else 14
    elif m2:
        lo = int(m2[0])
        if lo >= 10:
            return None, f"seniority {lo}+ too senior"
        sen = 20 if lo <= 5 else 12
    if "senior" in text and "lead" in text and "architect" in text:
        sen = min(sen, 10)
    reasons.append(f"sen={sen}")

    loc = (str(p.get("location", ""))).lower()
    if any(g in loc for g in GOOD_LOC):
        locs = 20
    elif any(g in loc for g in OK_LOC):
        locs = 12
    else:
        locs = 6  # non-India: sponsorship needed
    reasons.append(f"loc={locs}")

    comp = (str(p.get("company", ""))).lower()
    if any(t in comp for t in TIER1):
        cq = 10
    elif any(t in comp for t in TIER2):
        cq = 7
    else:
        cq = 5
    reasons.append(f"cq={cq}")

    total = kw + sen + locs + cq
    return total, "; ".join(reasons)


if __name__ == "__main__":
    postings = json.load(open(sys.argv[1]))
    out = []
    for p in postings:
        s, why = score(p)
        p["match_score"] = s
        p["score_detail"] = why
        p["disposition"] = ("DISCARD" if s is None or s < 55 else
                            "NEEDS_REVIEW" if s < 70 else "AUTO_SUBMIT")
        out.append(p)
    out.sort(key=lambda x: -(x["match_score"] or 0))
    print(json.dumps(out, indent=1))
