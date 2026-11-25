"""Second-buyer pool, Phase 1 (read-only, free): every company ScaleLab's staffing campaigns ever emailed, one row per
company, classified EXCLUDE / WAIT / ELIGIBLE / ICP_UNKNOWN, with the multi-site rule's inputs. ScaleLab data only.

Usage: python3 -I second_buyer_pool.py <out_run_dir> --as-of YYYY-MM-DD

Inputs (all already saved in <out_run_dir>; nothing is fetched):
  prod_leads.json            Supabase outreach_leads (client_id = scalelab, staffing campaigns) with crm_events aggregates
                             per address (sends, first/last send, bounces, unsubscribe, positive, human reply, OOO)
  sheet/ScaleLabPipeline.xlsx  the dashboard spreadsheet export: ColdEmail (authoritative rows), Suppression, Leads
                             (pipeline), ReplyDrafts
  reply_actions.json         scalelab_reply_actions / classifications: {lead_id: category}
and, read in place: docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv and every run folder listed in RUNS
(icp_decisions.json = latest V4 gate per domain, people_by_domain.json = saved free Apollo search results,
sitecache/ + pwcache/ = cached crawls for branch counts).

Rules (owner brief 2026-11-24):
  EXCLUDE   any unsubscribe / stop / negative reply; any address at the company suppressed for a reason other than a
            bounce (a bounce never excludes); any positive or neutral human reply (out-of-office is not a reply);
            latest V4 gate REJECT (DUPLICATE is a dedupe artifact, not an ICP verdict); national chain / franchise;
            non-US. A [MANUAL HOLD] with no reply is reported separately (human-owned; owner decides).
  WAIT      any contact still mid-sequence (queued, or Campaign 3 below its last step), or the last email to the
            company less than 30 days before --as-of; eligible_on = last send + 30 days.
  ICP_UNKNOWN  no V4 gate result for the company (old V1 / Campaign 2, or Campaign 2's own ICP carried over).
  ELIGIBLE  everything else: sequences finished, no reply, last touch >= 30 days, V4 gate PASS or HOLD.
Multi-site: branches = distinct US "City, ST 12345" addresses on the cached site (3+ = multi-branch: up to 2 new
contacts, each at another branch or in another buyer role; otherwise 1). A saved second candidate is a tier 1-2 or
branch/area/regional-manager person from the free Apollo search who is not anyone already emailed.
Re-engage (size only): the same contact at an ELIGIBLE company, last emailed >= 60 days before --as-of on pre-v2
(Industrial Staffing Agency, V1) copy.

Writes <out_run_dir>/phase1_companies.json (per company, private) and phase1_counts.json (counts only).
"""
import collections
import csv
import datetime
import glob
import json
import os
import re
import sys
import importlib.util

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402  (the one chain / franchise rule)
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
OUT = sys.argv[1]
AS_OF = datetime.date.fromisoformat(sys.argv[sys.argv.index('--as-of') + 1])
SP = '/tmp/claude-0/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32/scratchpad'
# V4 gate runs, oldest first (the latest decision for a domain wins)
RUNS = [f'{SP}/v4run', f'{SP}/v4run_p2', f'{SP}/w1', f'{SP}/c48', f'{SP}/c1k', f'{REPO}/runs-private/w2k',
        f'{REPO}/runs-private/shortfall-2026-11-23', f'{REPO}/runs-private/v4-3000-2026-11-23',
        f'{REPO}/runs-private/recovery-c2-import-2026-11-24', f'{REPO}/runs-private/regate-551-2026-11-24',
        f'{REPO}/runs-private/jobs-discovery-2026-11-24']
V1, C2, C3 = 'Industrial Staffing Agency', 'Staffing Outreach Campaign 2', 'Industrial Campaign 3'
FREEMAIL = {'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'comcast.net',
            'att.net', 'sbcglobal.net', 'verizon.net', 'me.com', 'ymail.com', 'protonmail.com', 'bellsouth.net', 'cox.net'}
FOREIGN_TLD = re.compile(r'\.(ca|uk|au|nz|in|mx|ie|de|fr|ph|za|sg|ae|br)$')
# a province only after a comma ("Ontario, California" is US), or the word Canada
CA_PROV = re.compile(r'\bcanada\b|,\s*(ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|'
                     r'prince edward island|newfoundland)\b|,\s*(ON|BC|AB|QC|MB|SK|NS|NB|PE|NL)\b(?!\s*\d{5})', re.I)

spec = importlib.util.spec_from_file_location('bp', os.path.join(TOOLS, 'buyer_pick.py'))
_argv, sys.argv = sys.argv, [sys.argv[0], 'x']
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
spec2 = importlib.util.spec_from_file_location('dm', os.path.join(TOOLS, 'discover_merge.py'))
sys.argv = [sys.argv[0], 'x', '--']
dm = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(dm)
sys.argv = _argv

ADDR = re.compile(r'\b\d{1,6}\s+[A-Za-z0-9.#\' -]{2,40}?\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Hwy|Highway|Pkwy|'
                  r'Parkway|Way|Ln|Lane|Ct|Court|Pl|Place|Cir|Circle|Pike|Trl|Trail|Suite|Ste)\b\.?[^\n]{0,60}?,?\s+'
                  r'([A-Z][A-Za-z .\'-]{2,30}),\s*(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|'
                  r'O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\.?,?\s+(\d{5})\b')


def root(d):
    d = re.sub(r'^https?://', '', (d or '').strip().lower()).split('/')[0].split(':')[0].split('?')[0]
    return d[4:] if d.startswith('www.') else d


def sheet_rows(wb, name):
    it = wb[name].iter_rows(values_only=True)
    h = [str(x) for x in next(it)]
    return [dict(zip(h, r)) for r in it if any(r)]


def tier_of(title):
    t = bp.tier(title or '')
    return t[0] if t else (3 if bp.BRANCH_ROLE.search(title or '') else None)


def main():
    import openpyxl
    leads = json.load(open(os.path.join(OUT, 'prod_leads.json')))
    wb = openpyxl.load_workbook(os.path.join(OUT, 'sheet', 'ScaleLabPipeline.xlsx'), read_only=True)
    ce = {str(r['id']): r for r in sheet_rows(wb, 'ColdEmail') if str(r.get('clientId')) == 'scalelab' and r.get('campaign') in (V1, C2, C3, 'Staffing ICP Review')}
    supp = collections.defaultdict(set)
    for r in sheet_rows(wb, 'Suppression'):
        if r.get('email'):
            supp[str(r['email']).strip().lower()].add(str(r.get('reason') or '').lower())
    pipe_emails = {str(r['email']).strip().lower() for r in sheet_rows(wb, 'Leads') if r.get('email')}
    # pipeline (Leads tab) matched by the address's company domain, never by name (names collide across niches)
    pipe_doms = {str(r['email']).strip().lower().split('@')[-1] for r in sheet_rows(wb, 'Leads') if r.get('email') and '@' in str(r['email'])} - FREEMAIL
    acts = json.load(open(os.path.join(OUT, 'reply_actions.json')))
    master = list(csv.DictReader(open(f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')))
    apollo_by_email = {(r.get('email') or '').lower(): r.get('apollo_id') for r in master}
    sheet_vs_db = {'sheet_rows': len(ce), 'db_rows': len(leads), 'ids_only_in_db': len({l['lead_id'] for l in leads} - set(ce)),
                   'ids_only_in_sheet': len(set(ce) - {l['lead_id'] for l in leads}),
                   'stage_differs': sum(1 for l in leads if l['lead_id'] in ce and str(ce[l['lead_id']].get('stage')) != str(l['stage']))}

    # latest V4 gate, redirects, branches, saved Apollo people (per domain)
    gate, redirect, sites, people = {}, {}, {}, collections.defaultdict(list)
    for run in RUNS:
        p = os.path.join(run, 'icp_decisions.json')
        if os.path.exists(p):
            for x in json.load(open(p)):
                if x.get('icp_reason_code') == 'DUPLICATE':
                    continue
                gate[x['domain']] = {'icp': x['company_icp'], 'code': x.get('icp_reason_code'), 'run': os.path.basename(run),
                                     'chain_p': (x.get('jev') or {}).get('large_national_chain'), 'us_p': (x.get('jev') or {}).get('us_operations'),
                                     'reason': (x.get('reason') or '')[:200]}
        for cdir in ('sitecache', 'pwcache'):
            for f in glob.glob(os.path.join(run, cdir, '*.json')):
                d = os.path.basename(f)[:-5]
                sites.setdefault(d, []).append(f)
        pb = os.path.join(run, 'people_by_domain.json')
        if os.path.exists(pb):
            for d, ps in json.load(open(pb)).items():
                people[d] += ps
    for d, fs in sites.items():
        for f in fs:
            try:
                pg = json.load(open(f)).get('pages') or []
            except (ValueError, OSError):
                continue
            for x in pg:
                fin = root(x.get('final_url') or '')
                if fin and fin != d and '.' in fin and x is pg[0]:
                    redirect[d] = fin

    def branches(d):
        found, ev = set(), []
        for f in sites.get(d, []):
            try:
                pg = json.load(open(f)).get('pages') or []
            except (ValueError, OSError):
                continue
            for x in pg:
                for m in ADDR.finditer(x.get('text') or ''):
                    k = (m.group(1).strip().lower(), m.group(2))
                    if k not in found:
                        found.add(k)
                        ev.append(x.get('final_url') or x.get('url'))
        return len(found), sorted(set(ev))[:3]

    # ---- per contact
    co = {}
    name_key = {}
    for l in leads:
        if l['campaign'] == 'Staffing ICP Review':
            continue
        e = (l['email'] or '').strip().lower()
        edom = e.split('@')[1] if '@' in e else ''
        d = root(l.get('cj_domain') or '') or root(l.get('website') or '') or ('' if edom in FREEMAIL else edom)
        d = redirect.get(d, d)
        nm = dm.stem(l.get('company') or '')
        key = d or (name_key.get(nm) if nm else None) or f'name:{nm}'
        if d and nm and len(nm) >= 4:
            name_key.setdefault(nm, d)
        c = co.setdefault(key, {'domain': key, 'names': set(), 'campaigns': set(), 'contacts': [], 'cities': set()})
        c['names'].add(l.get('company') or '')
        if l.get('city'):
            c['cities'].add(l['city'])
        sent = (l.get('sends') or 0) > 0 or l.get('last_emailed') or l.get('email_status') in ('emailed', 'done', 'replied')
        mk = l.get('markers') or ''
        rt = l.get('reply_types') or ''
        act = acts.get(l['lead_id'], '')
        neg = bool(l.get('unsub') or 'Unsubscribed' in mk or 'Not Interested' in mk or l['stage'] == 'Unsub' or act == 'opt_out'
                   or any(r in ('unsubscribe', 'not_interested') for r in supp.get(e, ())))
        pos = bool(l.get('pos') or 'pipeline_promoted' in rt or 'Interested' in mk.replace('Not Interested', '') or e in pipe_emails or 'closed_lost' in rt)
        human_types = {'needs_human_reply', 'human_response_sent', 'reply_classification_override'}
        neu = bool(not neg and not pos and (set(rt.split(',')) & human_types or 'Needs human' in mk or 'Question' in mk
                                            or 'Wrong Person' in mk or act == 'unclear' or l.get('email_status') == 'replied'))
        step, last_step = l.get('step') or 0, 3
        mid = l['stage'] == 'Queued' or (l['campaign'] == C3 and l['stage'] == 'Contacted' and step < last_step)
        stalled = bool(sent and not mid and l['campaign'] in (V1, C2) and step < last_step and l.get('email_status') != 'done')
        c['contacts'].append({
            'lead_id': l['lead_id'], 'campaign': l['campaign'], 'stage': l['stage'], 'email': e, 'name': l.get('contact_name') or '',
            'title': l.get('title') or '', 'tier': tier_of(l.get('title')), 'sent': bool(sent), 'first_sent': l.get('first_sent'),
            'last_sent': l.get('last_sent') or l.get('last_emailed'), 'step': step, 'mid_sequence': mid, 'stalled': stalled,
            'negative': neg, 'positive': pos, 'neutral': neu, 'ooo': bool(l.get('ooo')),
            'bounced': bool((l.get('bounces') or 0) > 0 or '[BOUNCED' in mk or 'bounce' in supp.get(e, ())),
            'suppressed_non_bounce': bool(supp.get(e, set()) - {'bounce'}), 'suppressed_bounce': 'bounce' in supp.get(e, ()),
            'manual_hold': '[MANUAL HOLD]' in mk})
        if sent:
            c['campaigns'].add(l['campaign'])

    # ---- per company
    out = []
    for key, c in co.items():
        cs = [x for x in c['contacts'] if x['sent']]
        if not cs:
            c['status'] = 'NEVER_EMAILED'
            out.append(c)
            continue
        d = c['domain']
        g = gate.get(d) if not d.startswith('name:') else None
        lasts = [datetime.date.fromisoformat(str(x['last_sent'])[:10]) for x in cs if x['last_sent']]
        firsts = [datetime.date.fromisoformat(str(x['first_sent'])[:10]) for x in cs if x['first_sent']]
        last = max(lasts) if lasts else None
        reasons = []
        if any(x['negative'] for x in c['contacts']):
            reasons.append('unsubscribe_or_negative_reply')
        if any(x['suppressed_non_bounce'] for x in c['contacts']):
            reasons.append('suppressed')
        if any(x['positive'] for x in c['contacts']) or d in pipe_doms or any(x['email'].split('@')[-1] in pipe_doms for x in c['contacts']):
            reasons.append('positive_reply_or_pipeline')
        if any(x['neutral'] for x in c['contacts']):
            reasons.append('neutral_reply')
        if g and g['icp'] == 'REJECT':
            reasons.append(f"icp_reject:{g['code']}")
        names = ' '.join(c['names'])
        chain = fr.chain_block(names, d, g.get('chain_p') if g else None)
        if not chain and g and 'chain' in g['reason'].lower() and g['icp'] != 'PASS' and fr.classify_company(names, d)[0] != 'FRANCHISE':
            chain = 'chain_signal'
        if chain:
            reasons.append(chain)
        if FOREIGN_TLD.search(d) or any(CA_PROV.search(ct or '') for ct in c['cities']):
            reasons.append('non_us')
        held = any(x['manual_hold'] for x in cs) and not reasons
        mid = any(x['mid_sequence'] for x in c['contacts'])
        c.update(first_sent=str(min(firsts)) if firsts else None, last_sent=str(last) if last else None,
                 gate=g, exclude_reasons=reasons)
        if reasons:
            c['status'] = 'EXCLUDE'
        elif held:
            c['status'] = 'EXCLUDE'
            c['exclude_reasons'] = ['manual_hold_no_reply (human-owned; owner decides)']
        elif mid or (last and (AS_OF - last).days < 30):
            c['status'] = 'WAIT'
            c['eligible_on'] = str((last or AS_OF) + datetime.timedelta(days=30)) if not mid else 'after sequence ends'
        elif not g or g.get('code') == 'CAMPAIGN2_ICP_CONFIRMED':
            c['status'] = 'ICP_UNKNOWN'
        else:
            c['status'] = 'ELIGIBLE'
        if c['status'] in ('ELIGIBLE', 'ICP_UNKNOWN'):
            n, ev = branches(d) if not d.startswith('name:') else (0, [])
            c['branches'], c['branch_evidence'] = n, ev
            c['crawl_cached'] = d in sites
            c['multi_branch'] = n >= 3
            emailed_first = {(x['name'].split()[0].lower() if x['name'] else '') for x in c['contacts']}
            emailed_ids = {apollo_by_email.get(x['email']) for x in c['contacts']} - {None, ''}
            cands = []
            for p in people.get(d, []):
                if p.get('id') in emailed_ids or not p.get('has_email'):
                    continue
                t = tier_of(p.get('title'))
                if t is None:
                    continue
                if (p.get('first') or '').lower() in emailed_first:
                    continue  # possibly the same person (last names are obfuscated in free search)
                cands.append({'id': p.get('id'), 'title': p.get('title'), 'tier': t})
            c['saved_candidates'] = cands
            c['re_engage'] = sum(1 for x in cs if x['campaign'] == V1 and x['last_sent'] and not x['bounced']
                                 and (AS_OF - datetime.date.fromisoformat(str(x['last_sent'])[:10])).days >= 60)
        out.append(c)

    # ---- counts
    contacted = [c for c in out if c['status'] != 'NEVER_EMAILED']
    cnt = collections.Counter(c['status'] for c in contacted)
    by_campaign = collections.Counter(cp for c in contacted for cp in c['campaigns'])
    multi_campaign = sum(1 for c in contacted if len(c['campaigns']) > 1)
    exr = collections.Counter(r.split(':')[0] if not r.startswith('icp_reject') else r for c in contacted if c['status'] == 'EXCLUDE' for r in c['exclude_reasons'])
    primary = collections.Counter(c['exclude_reasons'][0].split(' ')[0] for c in contacted if c['status'] == 'EXCLUDE')
    el = [c for c in contacted if c['status'] == 'ELIGIBLE']
    unk = [c for c in contacted if c['status'] == 'ICP_UNKNOWN']
    wait = [c for c in contacted if c['status'] == 'WAIT']

    def split(group):
        return {'companies': len(group),
                'gate_pass': sum(1 for c in group if (c.get('gate') or {}).get('icp') == 'PASS'),
                'gate_hold': sum(1 for c in group if (c.get('gate') or {}).get('icp') == 'HOLD'),
                'crawl_cached': sum(1 for c in group if c.get('crawl_cached')),
                'multi_branch_3plus': sum(1 for c in group if c.get('multi_branch')),
                'single_site_or_unknown': sum(1 for c in group if not c.get('multi_branch')),
                'new_contact_slots': sum(2 if c.get('multi_branch') else 1 for c in group),
                'have_saved_2nd_candidate': sum(1 for c in group if c.get('saved_candidates')),
                'need_new_search': sum(1 for c in group if not c.get('saved_candidates')),
                'emailed_buyer_tier': dict(collections.Counter(str(min([x['tier'] for x in c['contacts'] if x['sent'] and x['tier']] or [0])) for c in group)),
                'stalled_sequences': sum(1 for c in group if any(x['stalled'] for x in c['contacts'])),
                're_engage_contacts': sum(c.get('re_engage', 0) for c in group)}

    counts = {
        'as_of': str(AS_OF), 'sheet_vs_supabase': sheet_vs_db,
        'companies_ever_contacted': len(contacted), 'imported_never_emailed_companies': cnt.get('NEVER_EMAILED', 0) or sum(1 for c in out if c['status'] == 'NEVER_EMAILED'),
        'contacts_emailed': sum(1 for c in contacted for x in c['contacts'] if x['sent']),
        'by_campaign': dict(by_campaign), 'companies_in_2plus_campaigns': multi_campaign,
        'status': dict(cnt), 'exclude_reasons_any': dict(exr), 'exclude_reasons_primary': dict(primary),
        'eligible': split(el), 'icp_unknown': split(unk),
        'wait_by_eligible_on': dict(sorted(collections.Counter(c.get('eligible_on') for c in wait).items(), key=lambda kv: str(kv[0]))),
        'bounced_contacts_at_non_excluded_companies': sum(1 for c in contacted if c['status'] != 'EXCLUDE' for x in c['contacts'] if x['bounced']),
        'merged_by_name_only': sum(1 for c in contacted if c['domain'].startswith('name:')),
    }
    for c in out:
        c['names'], c['campaigns'], c['cities'] = sorted(c['names']), sorted(c['campaigns']), sorted(c['cities'])
    json.dump(out, open(os.path.join(OUT, 'phase1_companies.json'), 'w'), indent=1, default=str)
    json.dump(counts, open(os.path.join(OUT, 'phase1_counts.json'), 'w'), indent=1, default=str)
    print(json.dumps(counts, indent=1, default=str))


if __name__ == '__main__':
    main()
