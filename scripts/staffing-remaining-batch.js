'use strict';
// Personalizes the Tier 1 leads OUTSIDE the fixed QA cohort, using the identical
// pipeline and identical standards. No CRM writes, no sender, no scheduler, no
// Apollo. Resumable per lead; duplicate resolution happens across the full 178
// in the combine step so the validated cohort keeps its openings.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {parseCsv}=require('./staffing-personalization-qa');
const {previewStaffingPersonalization}=require('../integrations/staffing-personalization');
const {STAFFING_CAMPAIGN}=require('../integrations/staffing-campaign');
// Exactly the projection the QA sampler used, so the 148 are shaped identically
// to the validated 30 and reach the pipeline through the same campaign gate.
const LEAD_FIELDS=['firstName','company','companyWebsite','companyDomain','companyCity','companyState',
  'companySizeCategory','jobTitle','staffingLane','staffingSpecialization','emailStatus','sourceEvidence'];
const asLead=row=>({...Object.fromEntries(LEAD_FIELDS.map(k=>[k,row[k]])),
  campaign:STAFFING_CAMPAIGN.name,campaignId:STAFFING_CAMPAIGN.id});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const QA_DIR='C:/Users/deins/.codex/artifacts/staffing-personalization-qa-2026-09-10';
const DEFAULT_INPUT='C:/Users/deins/Downloads/scalelab_staffing_apollo_batch1_tier1.csv';

async function run({input=DEFAULT_INPUT,out,concurrency=4}={}) {
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  if(!out)throw new Error('An explicit output directory is required');
  const source=fs.readFileSync(input,'utf8');
  const manifest=JSON.parse(fs.readFileSync(path.join(QA_DIR,'sample.json'),'utf8'));
  if(hash(source)!==manifest.inputSha256)throw new Error('Tier 1 input changed since the QA cohort was frozen');
  const rows=parseCsv(source);
  if(rows.length!==178)throw new Error(`Expected 178 source leads, found ${rows.length}`);
  const cohort=new Set(manifest.leads.map(l=>l.companyDomain));
  if(cohort.size!==30)throw new Error('QA cohort is not 30 distinct domains');
  const remaining=rows.filter(r=>!cohort.has(r.companyDomain));
  if(remaining.length!==148)throw new Error(`Expected 148 remaining leads, found ${remaining.length}`);
  fs.mkdirSync(out,{recursive:true});
  const codeDigest=hash(['staffing-personalization.js','staffing-research.js']
    .map(f=>fs.readFileSync(path.join(__dirname,'../integrations',f),'utf8')).join('\n'));

  const results=new Array(remaining.length);
  let next=0,done=0;
  async function worker() {
    while(next<remaining.length) {
      const i=next++,row=remaining[i],lead=asLead(row);
      const cache=path.join(out,`lead-${String(i+1).padStart(3,'0')}.json`);
      if(fs.existsSync(cache)) {
        const saved=JSON.parse(fs.readFileSync(cache,'utf8'));
        if(saved.codeDigest===codeDigest&&saved.companyDomain===row.companyDomain&&saved.campaignId===STAFFING_CAMPAIGN.id){results[i]=saved;done++;continue;}
      }
      // A campaign-assignment fault is a programming error, not a lead outcome.
      // Classifying it would silently turn a broken batch into 148 fake holds.
      const result=await previewStaffingPersonalization(lead,{});
      results[i]={...row,...lead,...result,codeDigest};
      fs.writeFileSync(cache,JSON.stringify(results[i],null,2));
      done++;
      if(done%10===0||done===remaining.length)console.log(`  ${done}/${remaining.length} processed`);
    }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  const counts=results.reduce((a,r)=>(a[r.classification]=(a[r.classification]||0)+1,a),{});
  fs.writeFileSync(path.join(out,'remaining-148.json'),JSON.stringify({counts,codeDigest,results},null,2));
  console.log(JSON.stringify({remaining:results.length,counts},null,2));
  return {results,counts};
}
if(require.main===module)run({out:process.argv[2]}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
