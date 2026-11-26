"""Fast-path import prep for an owner-enriched buyer file (2026-11-24): dedupe against production, the V4 master and
pending batches; one contact per company unless the multi-site rule allows a second; buyer tiers from buyer_pick.py
(the one rule: top title wins, exclusions, Tier 3 only via can_pick); routes import / second_buyer / convert.
Writes <dir>/fastpath_final.json and fastpath_drops.json. Usage: python3 -I fastpath_prep.py (paths below).
"""
import csv,json,re,collections,importlib.util,sys,os
D='runs-private/enrich-lists'
def load(name,path,argv):
    spec=importlib.util.spec_from_file_location(name,path); old=sys.argv; sys.argv=argv; m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); sys.argv=old; return m
T='docs/scalelab-sourcing/tools'
bp=load('bp',f'{T}/buyer_pick.py',['x','x']); sbp=load('sbp',f'{T}/second_buyer_pick.py',['x','x']); el=load('el',f'{T}/enrich_lists.py',['x',D])
rows=list(csv.DictReader(open(f'{D}/buyer_ready_combined.csv')))
prod=json.load(open(f'{D}/prod_snapshot.json'))
by_email={p['email']:p for p in prod}
prod_dom=collections.defaultdict(list)
for p in prod: prod_dom[el.root(p['domain']) or p['email'].split('@')[-1]].append(p)
master=list(csv.DictReader(open('docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')))
m_email={r['email'].lower():r for r in master}; m_dom=collections.defaultdict(list)
for r in master: m_dom[r['company_domain']].append(r)
pending=list(csv.DictReader(open('docs/scalelab-sourcing/runs/jobs-discovery-2026-11-24/approved-contacts-both-parts.csv')))
pend_email={r['email'].lower() for r in pending}
cm={c['domain']:c for c in json.load(open('runs-private/second-buyer-2026-11-24/company_master.json'))}
br=collections.Counter()
for label,run in el.RUNS:
    p=f'{run}/branches.json'
    for d,v in (json.load(open(p)) if os.path.exists(p) else {}).items(): br[d]=max(br[d],v.get('branches',0))
SIZE=json.load(open(f'{D}/company_size.json'))
STOPW={'inc','llc','the','and','group','services','solutions','staffing','company','companies','corp','of','dba'}
def ownname_ok(company,domain):
    lab=re.sub(r'[^a-z0-9]','',domain.split('.')[0].lower())
    words=re.findall(r"[A-Za-z0-9]+",company)
    toks=[w.lower() for w in words if w.lower() not in STOPW]
    if not toks: return True
    if re.search(r'(?i)staff|labor|workforce|personnel|talent|recruit|employ|temp|hire|placement', company): return True
    for w in toks:
        if w in lab or lab in w or (len(w)>=4 and w[:4] in lab) or (len(w)==3 and w in lab): return True
    ini=''.join(w[0].lower() for w in words if w.lower() not in {'the','of','and','dba'})
    caps=''.join(re.findall(r'[A-Z]',company.replace('LLC','').replace('Inc','')))
    for a in (ini, caps.lower()):
        if len(a)>=3 and (a in lab or a[:3]==lab[:3]): return True
    return False
out=[];drops=[]
for r in rows:
    e=r['email'].strip().lower(); d=r['domain'].strip().lower(); t=r['job_title']
    rec={**r,'email':e,'domain':d}
    tr=bp.tier(t)  # the one buyer rule; no second exclusion pass
    rec['tier']=tr[0] if tr else (3 if bp.branch_exception(t, br[d]) else None)
    rec['branch_exc']=rec['tier']==3 and bp.branch_exception(t, br[d])  # multi-site rule, any size
    rec['fam']=sorted(sbp.families(t))
    p=by_email.get(e)
    if p:
        if not p['emailed'] and p['stage'] in ('Import','Review') and p['campaign']!='Industrial Campaign 3':
            rec['route']='convert'; rec['lead_id']=p['lead_id']
        else:
            drops.append((rec,'already_in_production')); continue
    elif e in m_email or e in pend_email:
        drops.append((rec,'already_approved_or_pending')); continue
    if rec['tier'] is None:
        drops.append((rec,'not_a_buyer_title')); continue
    if not ownname_ok(r['company'],d):
        drops.append((rec,'employer_on_record_differs')); continue
    c=cm.get(d)
    if c and c.get('status')=='EXCLUDE' and not str(c['exclude_reasons'][0]).startswith('manual_hold'):
        drops.append((rec,'company_excluded:'+c['exclude_reasons'][0].split(':')[0])); continue
    out.append(rec)
final=[]
bycompany=collections.defaultdict(list)
for r in out: bycompany[r['domain']].append(r)
for d,rs in bycompany.items():
    rs.sort(key=lambda r:(r['tier'],0 if r.get('route')=='convert' else 1))
    emails={x['email'] for x in rs}
    prods=[p for p in prod_dom.get(d,[]) if p['email'] not in emails]
    active=[p for p in prods if p['stage']=='Queued' or (p['campaign']=='Industrial Campaign 3' and p['stage']=='Contacted')]
    active+= [m for m in m_dom.get(d,[]) if not m['contact_status'].startswith('HOLD') and m['email'].lower() not in by_email]
    active+= [x for x in pending if x['company_domain']==d]
    unsent=[p for p in prods if not p['emailed'] and p['stage'] in ('Import','Review') and p['campaign']!='Industrial Campaign 3']
    finished=[p for p in prods if p['emailed'] and p not in active]
    multi=br[d]>=3
    taken=set()
    for m in m_dom.get(d,[]): taken|=sbp.families(m.get('buyer_title',''))
    keep=[]
    for r in rs:
        if r.get('route')=='convert':
            if active or keep: drops.append((r,'company_has_active_or_kept_contact')); continue
            keep.append(r); continue
        if active and not multi: drops.append((r,'company_has_active_contact')); continue
        if unsent: drops.append((r,'company_has_unsent_production_row')); continue
        if r['tier']==3 and not r['branch_exc']:
            has12=any(x['tier'] in (1,2) for x in rs) or any(bp.tier(m.get('buyer_title','')) and bp.tier(m.get('buyer_title',''))[0] in (1,2) for m in m_dom.get(d,[]))
            if not bp.can_pick(3, has12, SIZE.get(d)): drops.append((r,'tier3_not_allowed')); continue
        if keep and not multi: drops.append((r,'same_company_lower_tier')); continue
        if keep and not r['branch_exc'] and set(r['fam'])&{f for x in keep for f in x['fam']}: drops.append((r,'same_company_same_role')); continue
        if active and taken and not r['branch_exc'] and set(r['fam'])&taken: drops.append((r,'same_role_as_active_contact')); continue
        if len(keep)>=(2 if multi else 1): drops.append((r,'company_contact_limit')); continue
        r['route']='second_buyer' if finished else 'import'
        r['prior_lead_ids']=[p['lead_id'] for p in prods] if finished else []
        keep.append(r)
    for r in keep: r['multi_branch']=multi; r['branches']=br[d]; r['second_at_company']=len(keep)>1 or bool(active)
    final+=keep
json.dump(final,open(f'{D}/fastpath_final.json','w'),indent=1)
json.dump([{'email':r['email'],'domain':r['domain'],'title':r['job_title'],'company':r['company'],'reason':why} for r,why in drops],open(f'{D}/fastpath_drops.json','w'),indent=1)
print('input',len(rows),'final',len(final),'companies',len({r['domain'] for r in final}))
print('routes',dict(collections.Counter(r['route'] for r in final)))
print('drops',dict(collections.Counter(w for _,w in drops)))
print('tiers',dict(collections.Counter(r['tier'] for r in final)),'companies with 2',sum(1 for v in collections.Counter(r['domain'] for r in final).values() if v>1), 'second at active co', sum(1 for r in final if r['second_at_company']))
print('employer drops',[ (r['company'],r['domain']) for r,w in drops if w=='employer_on_record_differs'])
