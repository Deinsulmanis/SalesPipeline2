"""Insurance niche config (ScaleLab client = commercial / WC insurance agency; meetings are booked with employers
whose WC policy renews soon). Everything insurance-specific lives here so the staffing tools are untouched.

Sources: docs/scalelab-sourcing/segments/insurance-deep-dive-2026-11-26.md (ICP, qualified meeting, renewal data).
"""
import re

# ---------------------------------------------------------------------------------------------------------------
# Employer side: Texas TDI-DWC coverage dataset (data.texas.gov c4xz-httr)
TX_DATASET = "https://data.texas.gov/resource/c4xz-httr.json"
TX_META = "https://data.texas.gov/api/views/c4xz-httr.json"
WINDOW_DAYS = (60, 120)          # renewal window, days after the run date
PREMIUM_MIN = 25000              # state standard premium floor (qualified-meeting size proxy)
PEO_NON = "1"                    # peo_employee_leasing_policy: 1 = Non PEO (dataset dictionary)

# Governing class code -> industry. Approximate NCCI convention (4-digit class codes grouped by range:
# 2xxx-4xxx manufacturing, 5xxx-6xxx contracting, 7xxx transportation / utilities, 8xxx stores / clerical /
# services, 9xxx miscellaneous). Exceptions below move field-erection codes to construction and keep oilfield
# services separate inside "other". Verify against the NCCI Scopes Manual before relying on a single code.
CONSTRUCTION_EXTRA = {3724, 3726, 8227}           # millwright NOC, boiler installation, construction permanent yard
OILFIELD = {6204, 6206, 6213, 6214, 6216, 6235, 6236, 6237}
WAREHOUSING = {8291, 8292, 8293, 8304}
WHOLESALE = {8018} | set(range(8102, 8117)) | (set(range(8203, 8266)) - {8227})


def industry(class_code):
    """(industry, sub) for a governing class code string."""
    try:
        c = int(str(class_code).strip()[:4])
    except (TypeError, ValueError):
        return "other", "unknown_code"
    if c in CONSTRUCTION_EXTRA:
        return "construction", "field_erection"
    if c in OILFIELD:
        return "other", "oilfield_services"
    if 2000 <= c <= 4999:
        return "manufacturing", "manufacturing"
    if 5000 <= c <= 6999:
        return "construction", "contracting"
    if 7000 <= c <= 7499:
        return "trucking_logistics", "transportation"
    if c in WAREHOUSING:
        return "warehousing", "warehousing"
    if c in WHOLESALE:
        return "warehousing", "wholesale_distribution"
    if 1000 <= c <= 1999:
        return "other", "mining_quarrying"
    if 7500 <= c <= 7999:
        return "other", "utilities_telecom"
    if c == 8810 or c == 8742 or c == 8820:
        return "other", "clerical_professional"
    if 8000 <= c <= 8999:
        return "other", "stores_services"
    if 9000 <= c <= 9999:
        return "other", "misc_services"
    return "other", "agriculture_misc"


INDUSTRIES = ["manufacturing", "construction", "trucking_logistics", "warehousing", "other"]

# Texas metro by ZIP3 (employer mailing ZIP on the policy). Out-of-state addresses are their own bucket.
METRO_ZIP3 = [
    ("Houston", ("770", "771", "772", "773", "774", "775")),
    ("Dallas-Fort Worth", ("750", "751", "752", "753", "754", "760", "761", "762")),
    ("San Antonio", ("780", "781", "782")),
    ("Austin", ("786", "787")),
    ("El Paso", ("798", "799")),
    ("Rio Grande Valley", ("785",)),
    ("Corpus Christi", ("783", "784")),
    ("Beaumont / Golden Triangle", ("776", "777")),
    ("East Texas", ("755", "756", "757", "758", "759")),
    ("Central Texas (Waco / Temple / Bryan)", ("765", "766", "767", "768", "778")),
    ("West Texas (Permian / Lubbock / Amarillo / Abilene)", ("790", "791", "792", "793", "794", "795", "796", "797")),
]


def metro(state, zip_code):
    if (state or "").upper() != "TX":
        return "Out-of-state address"
    z = (zip_code or "")[:3]
    for name, zips in METRO_ZIP3:
        if z in zips:
            return name
    return "Other Texas"


PREMIUM_BANDS = [(25000, 50000, "$25k-50k"), (50000, 100000, "$50k-100k"), (100000, 250000, "$100k-250k"),
                 (250000, 500000, "$250k-500k"), (500000, 10 ** 12, "$500k+")]


def premium_band(p):
    p = float(p or 0)
    for lo, hi, label in PREMIUM_BANDS:
        if lo <= p < hi:
            return label
    return "<$25k"


# A policy name that is clearly a business (sample lists must never show a person's name).
BUSINESS = re.compile(r"(?i)\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|companies|lp|llp|pllc|pc|"
                      r"group|holdings|industries|enterprises|services|systems|solutions|manufacturing|mfg|construction|"
                      r"contractors?|builders|transport|transportation|trucking|logistics|freight|express|lines|carriers?|"
                      r"warehouse|warehousing|distribution|distributors?|supply|steel|metals?|fabrication|fab|electric|"
                      r"electrical|mechanical|plumbing|roofing|concrete|paving|materials|products|foods?|energy|oilfield|"
                      r"partners|association|of texas|usa|america|international|technologies|tech)\b\.?")
DBA = re.compile(r"(?i)\b(dba|d/b/a|t/a)\b")


def is_business_name(name):
    """True for an obvious business name. A 'Person DBA Business' style name is not shown (it carries a person)."""
    n = (name or "").strip()
    if not n or DBA.search(n):
        return False
    return bool(BUSINESS.search(n))


# ---------------------------------------------------------------------------------------------------------------
# Employer buyer rule (insurance meetings: who decides on WC / commercial insurance at a 20-500 employee employer).
# Tier 1: owner / founder / president / CEO (top title wins, as in the staffing rule).
# Tier 2: CFO / controller / VP finance / VP operations / COO / director of finance / general manager.
# Tier 3 (only when no tier 1/2 person has an email): HR director / HR manager / safety or risk manager.
# Never: assistants, former, board, sales reps, recruiters, IT, engineers, marketing.
E_TOP = [(0, r"(?<!product )(?<!process )\b(owner|co-?owner|founder|co-?founder|proprietor)\b"),
         (1, r"(?<!vice )(?<!vice-)\bpresident\b|\bceo\b|chief executive")]
E_GUARD = r"\b(former|retired|past|emeritus|board|assistant|secretary|associate)\b|\bto (the )?(president|ceo|owner|founder|chief)"
E_T2 = [(0, r"\bcfo\b|chief financial|chief finance"),
        (1, r"\bcontroller\b|comptroller"),
        (2, r"(vp|vice[- ]president|svp|evp)\b.*\b(finance|financial|operations|administration)|director of finance|finance director|\btreasurer\b"),
        (3, r"\bcoo\b|chief operating|chief operations officer"),
        (4, r"\bgeneral manager\b|managing partner|^principal$")]
E_T3 = [(0, r"(director|vp|vice president|head) of (human resources|hr|people)|\bhr director\b|human resources director|chief people|chief human"),
        (1, r"\b(hr|human resources) manager\b"),
        (2, r"(safety|risk|ehs|hse) (manager|director)|(director|manager) of (safety|risk|ehs)")]
E_NEVER = r"assistant|recruit|talent|\bsales\b|account (executive|manager)|marketing|\bit\b|technolog|engineer|estimator|dispatcher|driver|intern|board member|advisor|investor|retired|former"


def employer_tier(title):
    """(tier, rank) for an employer-side title, or None. Lower is better."""
    t = (title or "").lower().strip()
    if not t:
        return None
    if not re.search(E_GUARD, t):
        for rank, pat in E_TOP:
            if re.search(pat, t):
                return (1, rank)
    if re.search(E_NEVER, t):
        return None
    for rank, pat in E_T2:
        if re.search(pat, t):
            return (2, rank)
    for rank, pat in E_T3:
        if re.search(pat, t):
            return (3, rank)
    return None


# ---------------------------------------------------------------------------------------------------------------
# Agency side ICP (ScaleLab's client). Deep-dive section 3.
CAPTIVE_BRANDS = ["state farm", "allstate", "farmers insurance", "american family", "farm bureau", "country financial",
                  "shelter insurance", "geico", "liberty mutual", "nationwide insurance", "erie insurance", "auto-owners",
                  "goosehead", "brightway", "texas farm bureau", "txfb", "progressive", "usaa", "primerica", "new york life",
                  "northwestern mutual", "mass mutual", "massmutual", "aflac", "colonial life", "horace mann", "kemper",
                  "mercury insurance", "texas mutual"]
MEGA_BROKERS = ["marsh", "aon", "gallagher", "brown & brown", "brown and brown", "hub international", "acrisure", "alliant",
                "usi insurance", "lockton", "willis", "wtw", "assuredpartners", "assured partners", "nfp", "risk strategies",
                "truist insurance", "mcgriff", "imacorp", "baldwin", "the baldwin group", "higginbotham", "heffernan",
                "world insurance", "patriot growth", "keystone agency partners", "smart choice", "ttr", "epic insurance",
                "edgewood partners", "bolton", "cbiz", "relation insurance", "newfront", "foundation risk partners",
                "inszone", "hilb", "leavitt", "propel insurance", "ima financial", "holmes murphy", "cottingham"]
NOT_RETAIL = re.compile(r"(?i)\b(wholesale|wholesaler|mga|managing general|program administrator|carrier|underwrit\w* company|"
                        r"premium finance|claims adjust\w*|adjusters?|tpa|third party administrator|reinsurance)\b")

# Trucking proper inside trucking_logistics (excludes marine, rail, aviation): NCCI trucking / freight-handling /
# drivers codes. Used for the statewide trucking sample list.
TRUCKING_CODES = {"7219", "7228", "7229", "7230", "7231", "7232", "7360", "7380"}

# ---------------------------------------------------------------------------------------------------------------
# Agency decision-maker rule (ScaleLab's buyer at the agency). Deep-dive section 3:
# Tier 1: agency principal / owner / president / CEO / founder / managing partner / partner (producer-owners).
# Tier 2: VP or director of commercial lines, commercial lines manager, sales manager / director of business
#         development / VP sales.
# Never picked (HOLD): producers or agents without ownership, account managers / executives, CSRs, marketing,
#         assistants, former / board titles, and anyone at a different company.
A_TOP = [(0, r"(?<!product )\b(owner|co-?owner|founder|co-?founder|proprietor|agency principal|principal agent)\b"),
         (1, r"(?<!vice )(?<!vice-)\bpresident\b|\bceo\b|chief executive"),
         (2, r"managing (partner|principal|member|director)|^principal\b|\bprincipal$|^(senior |founding |equity )?partner\b|\bpartner$")]
A_GUARD = r"\b(former|retired|past|emeritus|board|assistant|secretary|associate|intern)\b|\bto (the )?(president|ceo|owner|founder|principal)"
A_T2 = [(0, r"(vp|vice[- ]president|svp|evp|director|head|manager)\b.*\bcommercial (lines|insurance|p ?& ?c|accounts|division)\b|commercial lines (manager|director|leader)"),
        (1, r"(vp|vice[- ]president|director|head)\b.*\b(sales|business development|growth|new business)\b|\bsales manager\b|\bcro\b|chief (revenue|sales|growth) officer"),
        (2, r"\bcoo\b|chief operating|agency manager|general manager")]
A_NEVER = r"assistant|\bcsr\b|customer service|service (rep|representative|specialist)|account (manager|executive|representative|specialist)|marketing|\bproducer\b|\bagent\b|underwriter|claims|accountant|bookkeeper|receptionist|intern|recruit|\bhr\b|human resources|compliance|it manager"


def agency_tier(title):
    """(tier, rank) for an agency-side title, or None (never picked). Top titles win even with a NEVER word
    ("Owner / Agent", "President & Producer"); a bare producer / agent / account manager is never picked."""
    t = (title or "").lower().strip()
    if not t:
        return None
    if not re.search(A_GUARD, t):
        for rank, pat in A_TOP:
            if re.search(pat, t):
                return (1, rank)
    if re.search(A_NEVER, t) and not re.search(A_T2[0][1], t):
        return None
    for rank, pat in A_T2:
        if re.search(pat, t):
            return (2, rank)
    return None
