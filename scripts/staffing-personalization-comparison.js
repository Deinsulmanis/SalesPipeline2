'use strict';
// Fixed regression cohort only. No CRM writes, sender, scheduler or Apollo imports.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {parseCsv,csv}=require('./staffing-personalization-qa');
const {previewStaffingPersonalization,flagBatchDuplicates,OUTCOMES}=require('../integrations/staffing-personalization');
const {researchStaffingCompany}=require('../integrations/staffing-research');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const DEFAULT_BEFORE='C:/Users/deins/.codex/artifacts/staffing-personalization-qa-2026-09-10/results.json';
const DEFAULT_INPUT='C:/Users/deins/Downloads/scalelab_staffing_apollo_batch1_tier1.csv';
const DEFAULT_OUT='C:/Users/deins/.codex/artifacts/staffing-personalization-comparison-2026-09-10';
function comparisonRows(results) {
  const values=(facts,kind)=>(facts||[]).filter(f=>f.kind===kind).map(f=>f.value+(f.reason?` [${f.reason}]`:'')).join('; ');
  return results.map(r=>({'Company':r.company,'Previous opening':r.previousOpening,'New opening':r.hyperPersonalizedOpening,
    'Previous classification':r.previousClassification,'New classification':r.classification,'Changed?':r.previousClassification!==r.classification||r.previousOpening!==r.hyperPersonalizedOpening?'yes':'no',
    'Confidence':r.confidence,'First name':r.firstName,'Website':r.companyWebsite,'Lane':r.staffingLane,
    'validated roles used':values(r.facts,'role'),'rejected roles':values(r.rejectedFacts,'role'),
    'validated employer market':values(r.facts,'employer_market'),'rejected employer market':values(r.rejectedFacts,'employer_market'),
    'validated geography':values(r.facts,'geography'),'rejected geography':values(r.rejectedFacts,'geography'),
    'Sources':r.sourceURL_or_sourceDescription,'Research notes':r.researchNotes,'Primary reason':r.primaryReason,
    'Supporting reasons':(r.supportingReasons||[]).join('; '),'Website failures':(r.research?.failures||[]).join('; '),
    'ICP fit result':r.icpFit,'Safe to send?':r.safeToSend?'yes':'no','Evidence':(r.facts||[]).map(f=>`${f.kind}: ${f.value}\n${f.evidence.map(e=>`${e.sourceUrl}\n${e.quote}`).join('\n')}`).join('\n\n'),
    'Retrieval diagnostics':JSON.stringify(r.retrieval||{}),'Regeneration count':r.regenerationCount||0,'Model calls':r.modelCalls||0}));
}
async function run({beforeFile=DEFAULT_BEFORE,input=DEFAULT_INPUT,out=DEFAULT_OUT}={}) {
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  if(path.resolve(out)===path.dirname(path.resolve(beforeFile)))throw new Error('Comparison must not overwrite original QA');
  const beforeText=fs.readFileSync(beforeFile,'utf8'),before=JSON.parse(beforeText),source=fs.readFileSync(input,'utf8');
  const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(beforeFile),'sample.json'),'utf8'));
  if(hash(source)!==manifest.inputSha256)throw new Error('Original Tier 1 input changed');
  const leads=manifest.leads,rows=parseCsv(source);
  if(leads.length!==30||before.results.length!==30||rows.length!==178)throw new Error('Fixed cohort dimensions changed');
  if(new Set(leads.map(r=>r.companyDomain)).size!==30||leads.some((l,i)=>l.companyDomain!==before.results[i].companyDomain))throw new Error('Original sample identity mismatch');
  if(leads.some(l=>!rows.some(r=>r.companyDomain===l.companyDomain&&/^verified\b.*NOT catch-all/i.test(r.emailStatus))))throw new Error('Non-Tier 1 cohort');
  fs.mkdirSync(out,{recursive:true});
  const codeDigest=hash(['staffing-personalization.js','staffing-research.js'].map(f=>fs.readFileSync(path.join(__dirname,'../integrations',f),'utf8')).join('\n'));
  const beforeSha256=hash(beforeText),results=new Array(30);let next=0,modelBlocked=false;
  async function worker(){while(next<30){const i=next++,lead=leads[i],prior=before.results[i],cache=path.join(out,`lead-${String(i+1).padStart(2,'0')}.json`);
    if(fs.existsSync(cache)){const saved=JSON.parse(fs.readFileSync(cache,'utf8'));if(saved.codeDigest===codeDigest&&saved.beforeSha256===beforeSha256&&saved.companyDomain===lead.companyDomain){results[i]=saved;continue;}}
    // Freeze successful website evidence to isolate validation changes; retry only prior technical failures.
    const research=prior.research?.pages?.length?structuredClone(prior.research):await researchStaffingCompany(lead);
    const skippedForServiceFailure=modelBlocked;
    const result=await previewStaffingPersonalization(lead,{researchCompany:async()=>research,
      ...(modelBlocked?{createMessage:async()=>{const error=new Error('Model service unavailable');error.code='MODEL_CREDITS_EXHAUSTED';throw error;}}:{})});
    if(result.executionBlocked)modelBlocked=true;
    if(skippedForServiceFailure&&result.executionBlocked){result.modelCalls=0;result.executionSkipped=true;}
    results[i]={...lead,...result,previousOpening:prior.hyperPersonalizedOpening,previousClassification:prior.confidence,
      researchReused:!!prior.research?.pages?.length,codeDigest,beforeSha256};
    fs.writeFileSync(cache,JSON.stringify(results[i],null,2));
    console.log(`${i+1}/30 ${lead.company}: ${result.classification}; ${result.primaryReason}; rebuilds ${result.regenerationCount||0}`);
  }}
  await Promise.all([worker(),worker(),worker()]);await flagBatchDuplicates(results);
  const counts=results.reduce((a,r)=>(a[r.classification]++,a),Object.fromEntries(OUTCOMES.map(k=>[k,0])));
  const output={beforeCounts:before.counts,counts,beforeSha256,codeDigest,cohort:leads.map(l=>l.companyDomain),results};
  fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(output,null,2));
  const table=comparisonRows(results);fs.writeFileSync(path.join(out,'staffing-qa-comparison.csv'),csv(table,Object.keys(table[0])));
  console.log(JSON.stringify({before:before.counts,after:counts,count:30,out},null,2));return output;
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run,comparisonRows};
