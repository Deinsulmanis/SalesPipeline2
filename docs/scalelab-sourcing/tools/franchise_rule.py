"""The one franchise / national-chain rule (owner decision 2026-11-25). Every tool imports this module; none keeps a copy.

  - A FRANCHISE LOCATION (independently owned and operated) is ICP-eligible when it does industrial / light-industrial /
    skilled-trades staffing. The brand must be industrial-capable AND the location's own page or postings must show
    industrial roles (job-posting rule OK). Office-only locations -> HOLD.
  - CORPORATE-OWNED national chains stay excluded.
  - Franchisor HQ staff are never contacted.
  - Identity: a franchise contact is keyed by brand + owner, with the territory (office city/state) recorded; never by
    email domain (owners share expresspros.com and the like). One contact per owner even with several offices, and one
    owner per brand + territory (co-owners of the same office are not both mailed).

Import-safe: no side effects. Tests: test_franchise_rule.py.
"""
import re

# brand -> name pattern, shared mail/web domains, franchisor HQ (city, state), industrial-capable brand
BRANDS = {
    'express': dict(label='Express Employment Professionals', rx=r'express employment|expresspros|express personnel',
                    domains=('expresspros.com',), hq=('oklahoma city', 'oklahoma'), industrial=True),
    'pridestaff': dict(label='PrideStaff', rx=r'pride ?staff', domains=('pridestaff.com',), hq=('fresno', 'california'),
                       industrial=True),
    'spherion': dict(label='Spherion', rx=r'spherion', domains=('spherion.com',), hq=('atlanta', 'georgia'), industrial=True),
    'snelling': dict(label='Snelling', rx=r'snelling (staffing|personnel|employment)', domains=('snelling.com',),
                     hq=('dallas', 'texas'), industrial=True),
    'labor_finders': dict(label='Labor Finders', rx=r'labor finders', domains=('laborfinders.com',),
                          hq=('palm beach gardens', 'florida'), industrial=True),
    'hirequest': dict(label='HireQuest Direct', rx=r'hire ?quest', domains=('hirequestdirect.com', 'hirequestllc.com', 'hirequest.com'),
                      hq=('goose creek', 'south carolina'), industrial=True),
    'trojan': dict(label='Trojan Labor', rx=r'trojan labor', domains=('trojanlabor.com',), hq=('goose creek', 'south carolina'),
                   industrial=True),
    'link': dict(label='Link Staffing', rx=r'(?<!work)link staffing', domains=('linkstaffing.com',), hq=('houston', 'texas'),
                 industrial=True),
    'remedy': dict(label='Remedy Intelligent Staffing', rx=r'remedy intelligent|remedystaff', domains=('remedystaff.com',),
                   hq=('aliso viejo', 'california'), industrial=True),
}

# Corporate-owned national chains and platforms: excluded (unchanged from the old combined list, minus the franchise brands).
CORPORATE = re.compile(r"^manpower\b|\bmanpowergroup\b|\b(aerotek|adecco|randstad|kelly services|robert half|staffmark|peopleready|people ready|"
                       r"labor ready|trueblue|volt workforce|aston carter|employbridge|prologistix|select staffing|"
                       r"elwood staffing|insight global|actalent|kforce|nesco resource|command center|westaff|"
                       r"ultimate staffing|bluecrew|instawork|wonolo|traba|veryable|workrise|staffzone|all team staffing|"
                       r"global recruiters network|integrity staffing solutions|labor smart|labormax|tradesmen international)\b")

SHARED_DOMAINS = {d: b for b, v in BRANDS.items() for d in v['domains']}
# The franchisor itself (franchise sales / development sites): HQ, never a location, never contacted.
FRANCHISOR = re.compile(r"\bfranchising\b|\bfranchise (sales|development|opportunit\w*)\b")

OWNER = r'\b(owner|co-?owner|franchisee|franchise owner|licensee|proprietor)\b'
PRESIDENT = r'(?<!vice )(?<!vice-)\bpresident\b|\bceo\b|chief executive'
CORPORATE_ROLE = (r'\b(past|former|retired|interim|emeritus)\b|vice[- ]president|\bsvp\b|\bevp\b|franchise sales|'
                  r'director of franchis|franchise development director|service line director|international headquarters|'
                  r'corporate (office|headquarters|staff)')
HQ_WORDS = r'international|headquarters|corporate (office|headquarters|staff)'
STAFFING_WORDS = r'staffing|recruit|employment|workforce|talent|hiring|jobs?\b|franchis|personnel|career|labor'


def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9&/\- ]', ' ', (s or '').lower())).strip()


def brand_of(*texts, email=''):
    """Franchise brand key from a company name / headline / employer text, or the email's domain; else None."""
    dom = (email or '').lower().rsplit('@', 1)[-1]
    if dom in SHARED_DOMAINS:
        return SHARED_DOMAINS[dom]
    t = norm(' '.join(x or '' for x in texts))
    for b, v in BRANDS.items():
        if re.search(v['rx'], t):
            return b
    return None


def classify_company(name, domain=''):
    """('FRANCHISE', brand) | ('CORPORATE_CHAIN', None) | (None, None). A franchise brand beats the corporate list."""
    b = brand_of(name, email='x@' + (domain or ''))
    if b:
        return 'FRANCHISE', b
    if CORPORATE.search(norm(name)):
        return 'CORPORATE_CHAIN', None
    return None, None


def is_excluded_chain(name, domain=''):
    """The company-level exclusion every tool uses: corporate-owned chains only (franchise locations are eligible)."""
    return classify_company(name, domain)[0] == 'CORPORATE_CHAIN'


GENERIC = set("""of in at the and inc llc co professionals professional international staffing recruiting employment services
service personnel express healthcare president ceo owner franchise franchisee group solutions""".split())


def _place_after_brand(brand, text):
    """True when the text ties the brand to a place: '<brand> of Joliet', '<brand> - Bozeman, MT', '<brand> Kankakee'."""
    t = (text or '').lower()
    m = re.search(BRANDS[brand]['rx'], t)
    if not m:
        return False
    rest = re.split(r'[|;.(]', t[m.end():], maxsplit=1)[0]
    words = [w for w in re.findall(r'[a-z]+', rest) if w not in GENERIC]
    return any(len(w) >= 3 for w in words) or bool(re.search(r',\s*[a-z]{2}\b', rest))


def classify_contact(row, brand):
    """A franchise contact row (title, headline, employer, city, state, email) -> (status, reason).

    status: OWNER | DROP_HQ | DROP_CORPORATE_ROLE | DROP_NOT_BRAND | HOLD_PRESIDENT_UNVERIFIED | HOLD_OTHER_BUSINESS
    """
    title, head = norm(row.get('title')), norm(row.get('headline'))
    employer = norm(row.get('employer'))
    city, state = norm(row.get('city')), norm(row.get('state'))
    if not brand or brand_of(row.get('employer'), row.get('headline'), row.get('title'), email=row.get('email')) != brand:
        return 'DROP_NOT_BRAND', 'employer / email is not the franchise brand'
    if re.search(CORPORATE_ROLE, title) or re.search(CORPORATE_ROLE, head) and not re.search(OWNER, title):
        return 'DROP_CORPORATE_ROLE', 'title or headline shows a corporate / non-owner role'
    owner = bool(re.search(OWNER, title) or re.search(OWNER, head))
    hq_city, hq_state = BRANDS[brand]['hq']
    at_hq = city == hq_city and state == hq_state
    if re.search(HQ_WORDS, title) or re.search(r'international headquarters|corporate (office|headquarters|staff)', head) \
            or (at_hq and (not owner or re.search(HQ_WORDS, head + ' ' + employer))) \
            or (re.search(PRESIDENT, title) and not owner and re.search(r'\binternational\b', head)):
        return 'DROP_HQ', 'franchisor headquarters'
    if head and not re.search(BRANDS[brand]['rx'], head) and not re.search(STAFFING_WORDS, head) \
            and re.search(r'\b(at|@)\b|\b(professor|ceo|president|director|developer|consultant) ', head) and not re.search(OWNER, head):
        return 'HOLD_OTHER_BUSINESS', 'headline shows another business, not this franchise'
    if owner:
        return 'OWNER', 'owner title'
    if re.search(PRESIDENT, title) and (_place_after_brand(brand, row.get('title', '')) or _place_after_brand(brand, row.get('headline', ''))
                                        or re.search(r'\bpresident\s*[-–,]\s*[a-z]', title)):
        return 'OWNER', 'president of a named franchise office'
    return 'HOLD_PRESIDENT_UNVERIFIED', 'president / CEO title without owner or office evidence (could be franchisor staff)'


TITLE_RANK = [(0, r'\bfranchise owner\b|\bfranchisee\b|^owner\b|\bowner$|\bowner/'), (1, OWNER), (2, PRESIDENT)]


def title_rank(title):
    t = norm(title)
    for rank, rx in TITLE_RANK:
        if re.search(rx, t):
            return rank
    return 9


def owner_key(brand, first, last):
    return '|'.join([brand, re.sub(r'[^a-z]', '', (first or '').lower()), re.sub(r'[^a-z]', '', (last or '').lower())])


def territory_key(brand, city, state):
    return '|'.join([brand, norm(city), norm(state)])


def chain_block(name, domain='', chain_p=None):
    """The company-level chain check for domain-keyed tools. None = not blocked; otherwise a reason:
      'corporate_chain'          a corporate-owned national chain (excluded);
      'franchisor_hq'            the franchisor's own site (franchise sales / development): never contacted;
      'franchise_shared_domain'  a franchise brand's shared domain: sourced per owner by the franchise flow, never by domain;
      'chain_signal'             Jev says national chain (p >= 0.5) and the name is not a recognised franchise brand.
    A franchise location on its own domain is not blocked (it goes through the normal location ICP check)."""
    kind, brand = classify_company(name, domain)
    if kind == 'FRANCHISE' and (FRANCHISOR.search(norm(name)) or 'franchising' in (domain or '').lower()):
        return 'franchisor_hq'
    if kind == 'CORPORATE_CHAIN':
        return 'corporate_chain'
    if kind == 'FRANCHISE':
        return 'franchise_shared_domain' if (domain or '').lower().replace('www.', '') in SHARED_DOMAINS else None
    if chain_p is not None and chain_p >= 0.5:
        return 'chain_signal'
    return None


def industrial_capable(brand):
    return bool(BRANDS.get(brand, {}).get('industrial'))
