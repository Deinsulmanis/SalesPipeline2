"""Build the counts-only demand-signal report from the run folder JSON. Usage: python3 -I build_report.py <run_dir> <out.md>"""
import json, sys, os
R, OUT = sys.argv[1], sys.argv[2]
J = lambda f: json.load(open(os.path.join(R, f)))
paid, pain, comp, bd, sc, tr = J('paid_requests.json'), J('pain.json'), J('competitors.json'), J('bd_hiring.json'), J('scores.json'), J('trends_norm.json')
S = ['industrial', 'engineering', 'cdl', 'construction', 'it', 'healthcare', 'office']
NAME = {'industrial': 'Industrial (baseline)', 'engineering': 'Engineering / technical contract', 'cdl': 'CDL / driver',
        'construction': 'Construction labor', 'it': 'IT contract', 'healthcare': 'Healthcare', 'office': 'Office / admin'}
I = sc['inputs']; SC = sc['scores']

# ---- hand-judged additions (from reading the capped Firecrawl batch, 2026-08-28..2026-11-26 date filter) ----
FC_PAID = {  # Upwork posts by agencies buying lead gen / appointment setting, found via Firecrawl (dated by the 90-day search filter)
 'it': [('Upwork', 'within 90d (search date filter)', 'appointment setting / cold email to CTOs and heads of engineering for a software-engineering talent firm', 'not visible',
         'https://www.upwork.com/freelance-jobs/apply/B2B-Appointment-Setter-Technical-Engineering_~022123406506382523402/'),
        ('Upwork', 'within 90d (search date filter)', 'lead gen + appointment setting to US buyers for an engineering-talent and hiring firm (software)', 'hourly, <30 hrs/wk, 1-3 months',
         'https://www.upwork.com/freelance-jobs/apply/B2B-Lead-Generation-Appointment-Setter-for-Buyers-Automation-Engineering-Talent-Hiring_~022124885390217291912/')],
 'healthcare': [('Upwork', 'within 90d (search date filter)', 'B2B cold caller / executive appointment setter for a healthcare staffing platform', 'not visible', None),
                ('Upwork (labour hire, likely non-US)', 'within 90d (search date filter)', 'healthcare staffing coordinator with BD, lead generation, cold calling and appointment setting duties', 'not visible', None)],
}
FC_PAIN = {  # first-hand threads found via Firecrawl; paraphrased, no usernames
 'industrial': [('Agency owners comparing client-acquisition methods: pick one sector and cold call; one says about 90% of their business comes from cold calling.', 'https://www.reddit.com/r/RecruitmentAgencies/comments/1wnc08c/getting_clients/', 'within 90d', 'reddit')],
 'healthcare': [('New healthcare staffing founder: roughly $700K revenue in under 10 months; the thread digs into running cold email from about 100 mailboxes and how to keep doing BD with 20+ open roles.', 'https://www.reddit.com/r/RecruitmentAgencies/comments/1xuluhc/just_passed_700k_in_revenue_less_than_10_months/', 'within 90d', 'reddit'),
                ('Agency founder: generic cold emails to other agencies were mostly ignored.', 'https://www.reddit.com/r/RecruitmentAgencies/comments/1xrx763/built_a_recruiter_agency/', 'within 90d', 'reddit'),
                ('Founder launching a respiratory-therapy staffing agency: has interested clients and clinicians, but can\'t find a reliable employer-of-record to start.', 'https://www.reddit.com/r/smallbusiness/comments/1xav0nc/why_is_it_so_hard_to_find_a_reliable_employer_of/', 'within 90d', 'reddit')],
 'construction': [('Counter-signal: a salesperson recommends construction staffing as a career because a handful of big projects or the right customer lets you grow fast with good margins.', 'https://www.reddit.com/r/sales/comments/1w7qedn/tech_sales_isnt_what_it_used_to_be_what_other/', 'within 90d', 'reddit')],
}
FC_PAIN_UNLINKED = {  # counted, but Firecrawl returned only search-redirect links, so no stable URL is cited
 'it': 'Five more first-hand Reddit threads in the 90-day window (no stable link returned): an IT-staffing seller asking how to win B2B accounts; two bench-sales recruiters struggling to find vendors with open requirements; US IT recruiters calling the market frustrating; and an IT-staffing worker saying requirements that used to arrive in the thousands have collapsed.',
 'engineering': 'Two LinkedIn items in the 90-day window (not linked, they carry personal names): an engineering-staffing recruiter openly asking for new clients, and an IT & engineering staffing commentary saying new clients now take more effort.',
 'healthcare': 'Two more founder threads (starting a medical staffing agency and fearing failure with first clients; seeking a co-founder) and a locum-agency BD fireside chat on LinkedIn.',
}
EXTRA_PHRASES = {  # recurring phrases from the Firecrawl first-hand threads, appended after pain.json phrases (mention counts are this pass only)
 'it': [('requirements volume collapsed', 1), ('bench sales: no vendors with open reqs', 2)],
 'healthcare': [('fear of failing first clients (new agencies)', 2), ('cold email ignored', 1)],
 'industrial': [('cold calling is the main channel', 1)],
 'engineering': [('new clients take more effort', 1), ('openly asking for new clients', 1)],
}

def money(s): return s.replace('|', '/')
L = []
A = L.append
A('# Staffing segment demand signals: 2026-11-26\n')
A('Read-only research pass. Window: last 90 days (2026-08-28 to 2026-11-26) where dates were visible. No personal data: counts, company-level competitor names and paraphrases only. Working files (raw search results, parsed postings) stay in the git-ignored `runs-private/demand-2026-11-26/`.\n')
A('## Ranked result\n')
A('Weights: paid requests 30, BD hiring 25, pain 20, competitors 15, search 10. Each signal is scored 0-100 across the seven segments (method below), then weighted.\n')
A('| Rank | Segment | Total | Paid (30) | BD hiring (25) | Pain (20) | Competitors (15) | Search (10) |')
A('|---|---|---|---|---|---|---|---|')
for i, k in enumerate(sc['rank'], 1):
    s = SC[k]; A(f"| {i} | {NAME[k]} | **{s['total']}** | {s['paid']} | {s['bd']} | {s['pain']} | {s['comp']} | {s['search']} |")
A('')
A('**Read this with the caveats.** IT and healthcare are effectively tied. IT leads only because two software-engineering-talent Upwork posts counted as IT paid requests; without them, healthcare ranks first (about 71 vs 60). Industrial is a clear third and well ahead of the rest. CDL / driver shows almost no client-acquisition demand in any channel.\n')
A('### Raw inputs behind the scores\n')
A('| Segment | Paid posts (total / dated 90d) | BD postings, est. at agency-named companies | BD postings with segment in title | Pain threads (total / 90d) | Intensity 1-5 | Segment-specific competitors | Search share change vs control |')
A('|---|---|---|---|---|---|---|---|')
for k in S:
    A(f"| {NAME[k]} | {I['paid_total'][k]} / {I['paid_90'][k]} | ~{I['bd_name'][k]} | {I['bd_title'][k]} | {I['threads'][k]} / {I['threads90'][k]} | {I['intensity'][k]} | {I['comp'][k]}{' (weak only)' if k=='cdl' else ''} | {I['trend'][k]:+d}% |")
A('')
A('## Top 10 pain phrases per segment\n')
A('Ordered by mention count across the items found (small samples: these are tallies, not prevalence). A segment with fewer than 10 recurring phrases lists only what was found.\n')
for k in S:
    ph = [(x['phrase'], x['mentions']) for x in pain['segments'][k].get('pain_phrases', [])] + EXTRA_PHRASES.get(k, [])
    ph = sorted(ph, key=lambda x: -x[1])[:10]
    A(f"**{NAME[k]}** ({len(ph)} found): " + '; '.join(f"{p} ({m})" for p, m in ph) + '\n')
A('## Per-segment detail\n')
for k in sc['rank']:
    A(f"### {NAME[k]}: {SC[k]['total']}\n")
    p = paid['segments'][k]; ex = p.get('examples', [])[:3]
    fc = FC_PAID.get(k, [])
    A(f"**1. Paid requests.** {I['paid_total'][k]} posts found ({I['paid_90'][k]} dated inside 90 days). Budgets seen: {money('; '.join(p.get('budgets', [])) or 'none')}.")
    shown = 0
    for e in ex:
        A(f"- {e.get('platform')}, {e.get('date')}: {(e.get('summary') or '').rstrip('.')}. Budget: {money(str(e.get('budget')))}. {e.get('url')}"); shown += 1
    for plat, date, what, bud, url in fc:
        if shown >= 3 and url is None: continue
        A(f"- {plat}, {date}: {what}. Budget: {bud}." + (f" {url}" if url else ' (link omitted: the URL names the posting company)')); shown += 1
    if not ex and not fc: A('- None found.')
    b = bd['segments'][k]
    st = ', '.join(f"{s} ({n})" for s, n in b['top_states']) or 'n/a'
    A(f"\n**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About {I['bd_name'][k]} own-BD postings estimated at companies with an agency word in their name (sample of {b['own_bd_postings_in_sample']} in this segment); {I['bd_title'][k]} postings whose title names the segment and 'staffing'. Top states in the sample: {st}.\n")
    ps = pain['segments'][k]
    A(f"**3. Pain conversations.** {I['threads'][k]} items ({I['threads90'][k]} in 90 days). Intensity **{I['intensity'][k]}/5**: {ps.get('intensity_reason')}")
    quotes = [(q['paraphrase'], q['url'], q.get('date'), q.get('source')) for q in ps['quotes'] if 'supabase.co' not in q['url'] and 'ukbusinessforums' not in q['url']]
    quotes = FC_PAIN.get(k, []) and [(a, b2, c, d) for a, b2, c, d in FC_PAIN[k]] + quotes or quotes
    for a, u, d, s in quotes[:5]: A(f"- ({s}, {d}) {a} {u}")
    if k in FC_PAIN_UNLINKED: A(f"- Also counted: {FC_PAIN_UNLINKED[k]}")
    tried = ps.get('tried', [])
    A('\nAlready tried: ' + ('; '.join(f"{t['what']} ({t['mentions']})" for t in tried if t['mentions']) or 'no first-hand accounts found') + '.\n')
    cp = comp['segments'][k]['providers']
    A(f"**4. Competitors** ({len(cp)} selling to this segment):")
    for pr in cp:
        rv = '; '.join(f"{r.get('platform')} {r.get('count')} reviews" + (f" @ {r.get('rating')}" if r.get('rating') else '') for r in pr.get('reviews') or [] if r.get('count'))
        A(f"- {pr['name']} ({pr.get('domain')}): {pr.get('offer')}. Pricing: {pr.get('pricing') or 'not public'}." + (f" Reviews: {rv}." if rv else ''))
    A('')
    kw = {'industrial': 'industrial staffing', 'engineering': 'engineering staffing', 'cdl': 'driver staffing', 'construction': 'construction staffing', 'it': 'it staffing', 'healthcare': 'healthcare staffing', 'office': 'office staffing'}[k]
    A(f"**5. Search interest.** \"{kw}\" share of the control term \"staffing agency\" moved {I['trend'][k]:+d}% (last 13 weeks vs the 13 before). \"{kw.split()[0]} staffing clients / marketing\" had too little volume to trend.\n")
A('## Method\n')
A('- **Paid requests:** WebSearch over Upwork, Freelancer, PeoplePerHour, Guru, Contra, OnlineJobs.ph, Workana and job boards, plus a capped Firecrawl search of Upwork limited to the 90-day window. Counted only posts where a staffing or recruiting agency of that segment buys lead generation, appointment setting, cold calling or cold email. Upwork and Fiverr block direct fetches, so details come from search snippets; Fiverr buyer requests are not indexed. Score = 50 x total / max + 50 x dated-90d / max.')
A('- **BD hiring:** GetLeads `search_jobs` (free jobs quota), Sales & Business Development function, US, posted since 2026-08-28. Two indices, averaged: (a) postings at companies whose name contains staffing, personnel, workforce, labor, recruiting, temps or employment (2,355 postings; 1,632 sampled), kept only when the title is a BD/sales role and the text describes selling staffing services (job orders, temporary labor, staffing services), segment-tagged from the posting text and scaled by each word\'s total; (b) postings whose title names the segment plus "staffing". Index (a) favours industrial-style agency names; (b) offsets that, because large IT and healthcare firms rarely use those words in their names. Each index is scored against its max, then averaged.')
A('- **Pain:** WebSearch over forums, Q&A, podcasts and trade press, plus a capped Firecrawl search of Reddit and public LinkedIn posts limited to the 90-day window. Reddit was not reachable directly (blocked) and the public Reddit archive refuses automated agents, so only search-indexed threads are included. Score = 60 x intensity / 5 + 40 x threads in 90d / max.')
A('- **Competitors:** providers whose offer names the segment (appointment setting, cold email, lead data). Generalist "for staffing agencies" providers are listed below. Score = 100 x count / max. More competitors are read as validated demand, not as a deterrent.')
A('- **Search:** Google Trends public API, US, 12 months, weekly. The "clients/marketing" phrases are near zero, so the broad "<segment> staffing" term is used, as a share of "staffing agency" to remove a market-wide drop (the control itself fell 20%). Score = min-max of the share change across segments.')
A('\n**Generalist providers selling to all staffing agencies** (' + str(comp['generic']['count']) + '): ' + '; '.join(f"{p['name']}" + (f" ({p['pricing']})" if p.get('pricing') else '') for p in comp['generic']['providers']) + '.\n')
A('## Caveats\n')
for c in ['Most counts are small samples. Paid-request totals are posts actually found, not market size; only 1 paid post had a visible date inside 90 days before the Firecrawl pass.',
          'Pain evidence is mostly trade press. First-hand owner threads came only through search snippets; candid Reddit discussion is under-represented for every segment, and LinkedIn posts with personal names are counted but not linked.',
          'BD hiring index (a) misses agencies without an agency word in the name; index (b) misses BD roles whose title omits the segment. Neither is a census.',
          'Segments overlap: one agency can be industrial, construction and CDL at once, so a posting can count in more than one segment.',
          'Industry data cuts against pain for industrial, engineering, construction and CDL in 2026 (industrial forecast raised to +7%; driver and construction labor tight). Low pain there may be real.',
          'SIA benchmark worth noting for outreach: IT staffing sales yields about 4 orders per 1,000 calls, healthcare about 9 and industrial about 16 (2025-11).',
          'Google Trends values for niche terms are low-volume and noisy.']:
    A(f"- {c}")
A('\n## Spend\n')
A('| Tool | Before | After | Used | Notes |')
A('|---|---|---|---|---|')
A('| Firecrawl | n/a | n/a | **50 credits** | 25 charged searches at 2 credits each (4 empty searches were free), from `creditsUsed` on each call |')
A('| GetLeads plan credits | 5,164 | 5,164 | 0 | `search_jobs` uses the separate free jobs quota (about 2,760 of 200,000 daily job records) |')
A('| Adyntel | not touched | | 0 | per-request billing, so not used |')
A('| Apify | not used | | $0 | |')
A('| WebSearch / Google Trends | free | | 0 | |')
A('\n**Total: 50 of the 100-credit cap.**\n')
open(OUT, 'w').write('\n'.join(L) + '\n')
print('wrote', OUT, len(L), 'lines')
