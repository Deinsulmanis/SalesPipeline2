'use strict';
// Combines the validated fixed-30 with the remaining 148, resolves duplicate
// openings across the whole 178 (the validated cohort claims first), reconciles
// the totals and writes the review/import artifacts. Writes files only: no CRM
// import, no campaign activation, no sending, no Apollo.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {parseCsv,csv}=require('./staffing-personalization-qa');
const {flagBatchDuplicates}=require('../integrations/staffing-personalization');
const {STAFFING_CAMPAIGN}=require('../integrations/staffing-campaign');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const QA_DIR='C:/Users/deins/.codex/artifacts/staffing-personalization-qa-2026-09-10';
const INPUT='C:/Users/deins/Downloads/scalelab_staffing_apollo_batch1_tier1.csv';
const val=(facts,kind)=>(facts||[]).filter(f=>f.kind===kind).map(f=>f.value).join('; ');

async function run({cohortFile,remainingFile,out}={}) {
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const source=fs.readFileSync(INPUT,'utf8');
  const manifest=JSON.parse(fs.readFileSync(path.join(QA_DIR,'sample.json'),'utf8'));
  if(hash(source)!==manifest.inputSha256)throw new Error('Tier 1 input changed');
  const rows=parseCsv(source);
  if(rows.length!==178)throw new Error(`Expected 178 source leads, found ${rows.length}`);
  const byDomain=new Map(rows.map(r=>[r.companyDomain,r]));

  const cohort=JSON.parse(fs.readFileSync(cohortFile,'utf8')).results;
  const remaining=JSON.parse(fs.readFileSync(remainingFile,'utf8')).results;
  if(cohort.length!==30)throw new Error(`Cohort must be 30, found ${cohort.length}`);
  if(remaining.length!==148)throw new Error(`Remaining must be 148, found ${remaining.length}`);

  // The validated cohort is ordered first so it keeps the openings a human reviewed.
  const all=[...cohort.map(r=>({...r,batch:'fixed-30'})),...remaining.map(r=>({...r,batch:'remaining-148'}))];
  if(all.length!==178)throw new Error('Combined cohort is not 178');
  const domains=new Set(all.map(r=>r.companyDomain));
  if(domains.size!==178)throw new Error(`Expected 178 distinct domains, found ${domains.size}`);
  for(const d of domains)if(!byDomain.has(d))throw new Error(`Domain ${d} is not in the source file`);

  await flagBatchDuplicates(all);

  const counts=all.reduce((a,r)=>(a[r.classification]=(a[r.classification]||0)+1,a),
    {HIGH:0,MEDIUM:0,RETRY_REQUIRED:0,REVIEW_REQUIRED:0,ICP_MISMATCH:0});
  const total=Object.values(counts).reduce((a,b)=>a+b,0);
  if(total!==178)throw new Error(`Dispositions total ${total}, not 178`);
  fs.mkdirSync(out,{recursive:true});

  // Enrich every record from the source row so both batches export identically.
  const full=all.map(r=>{const s=byDomain.get(r.companyDomain)||{};return {...r,src:s};});
  const write=(name,table)=>{
    const file=path.join(out,name);
    fs.writeFileSync(file,table.length?csv(table,Object.keys(table[0])):'');
    console.log(`  ${String(table.length).padStart(3)} rows -> ${file}`);
    return file;
  };

  // ── import-ready: the importer's own per-row field names come FIRST, then
  // reference-only columns it ignores but a human reviewer wants to see.
  const approved=full.filter(r=>['HIGH','MEDIUM'].includes(r.classification));
  write('staffing-import-ready-approved.csv',approved.map(r=>({
    email:r.src.apolloVerifiedEmail||'', company:r.company||r.src.company||'',
    contactName:r.src.fullName||[r.src.firstName,r.src.lastName].filter(Boolean).join(' '),
    city:r.src.companyCity||'', tradeType:r.src.staffingLane||'', website:r.src.companyWebsite||'',
    notes:`[STAFFING ${r.classification}] ${r.hyperPersonalizedOpening}`,
    reviewCount:'', rating:'', tier:r.src.buyerTier||'',
    siteContext:r.hyperPersonalizedOpening||'',
    // reference only — the importer does not read the columns below
    ref_hyperPersonalizedOpening:r.hyperPersonalizedOpening||'',
    ref_confidence:r.classification, ref_primaryReason:r.primaryReason||'',
    ref_firstName:r.src.firstName||'', ref_lastName:r.src.lastName||'',
    ref_buyerTitle:r.src.jobTitle||'', ref_state:r.src.companyState||'',
    ref_companySize:r.src.companySizeCategory||'', ref_staffingLane:r.src.staffingLane||'',
    ref_validatedRoles:val(r.facts,'role'), ref_employerMarket:val(r.facts,'employer_market'),
    ref_geography:val(r.facts,'geography'), ref_sources:r.sourceURL_or_sourceDescription||'',
    ref_campaignId:STAFFING_CAMPAIGN.id, ref_emailTemplateId:STAFFING_CAMPAIGN.emailTemplateId,
    ref_batch:r.batch, ref_wordCount:r.wordCount||'',
  })));

  const base=r=>({company:r.company||r.src.company||'', firstName:r.src.firstName||'',
    email:r.src.apolloVerifiedEmail||'', website:r.src.companyWebsite||''});
  write('staffing-retry-required.csv',full.filter(r=>r.classification==='RETRY_REQUIRED').map(r=>({...base(r),
    failureReason:r.primaryReason||'', attemptedUrl:(r.retrieval?.attempts||[]).map(a=>a.url).join(' | '),
    httpOrErrorReason:(r.retrieval?.attempts||[]).map(a=>[a.status,a.reason].filter(Boolean).join(' ')).join(' | ')
      ||(r.research?.failures||[]).join(' | '),
    domainIdentityVerified:r.retrieval?.domainIdentityVerified===true?'yes':'no', batch:r.batch})));

  write('staffing-review-required.csv',full.filter(r=>r.classification==='REVIEW_REQUIRED').map(r=>({...base(r),
    primaryReviewReason:r.primaryReason||'', supportingReasons:(r.supportingReasons||[]).join(' | '),
    researchNotes:r.researchNotes||'', icpFit:r.icpFit||'',
    validatedFacts:(r.validatedFacts||[]).map(f=>`${f.kind}: ${f.value}`).join(' | '),
    rejectedFacts:(r.rejectedFacts||[]).map(f=>`${f.kind}: ${f.value} [${f.reason}]`).join(' | '),
    rejectedOpening:r.rejectedOpening||'', batch:r.batch})));

  write('staffing-icp-mismatch.csv',full.filter(r=>r.classification==='ICP_MISMATCH').map(r=>({...base(r),
    mismatchReason:r.primaryReason||'', fitReason:r.fitReason||'',
    supportingEvidence:(r.validatedFacts||[]).map(f=>`${f.kind}: ${f.value}`).join(' | ')
      ||(r.research?.pages||[]).map(p=>p.url).join(' | '),
    sources:r.sourceURL_or_sourceDescription||(r.research?.pages||[]).map(p=>p.url).join(' | '), batch:r.batch})));

  write('staffing-full-178-disposition.csv',full.map(r=>({
    company:r.company||r.src.company||'', companyDomain:r.companyDomain,
    firstName:r.src.firstName||'', email:r.src.apolloVerifiedEmail||'',
    classification:r.classification, approvedForImport:['HIGH','MEDIUM'].includes(r.classification)?'yes':'no',
    hyperPersonalizedOpening:r.hyperPersonalizedOpening||'', primaryReason:r.primaryReason||'',
    supportingReasons:(r.supportingReasons||[]).join(' | '), batch:r.batch,
    validatedRoles:val(r.facts,'role'), employerMarket:val(r.facts,'employer_market'),
    geography:val(r.facts,'geography'), sources:r.sourceURL_or_sourceDescription||'',
    safeToSend:r.safeToSend?'yes':'no'})));

  fs.writeFileSync(path.join(out,'full-178.json'),JSON.stringify({counts,total,
    campaign:{id:STAFFING_CAMPAIGN.id,status:'draft',ready:false},results:full.map(({src,...r})=>r)},null,2));
  console.log('');
  console.log(JSON.stringify({total,counts,approved:counts.HIGH+counts.MEDIUM},null,2));
  return {counts,total};
}
if(require.main===module)run({cohortFile:process.argv[2],remainingFile:process.argv[3],out:process.argv[4]})
  .catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
