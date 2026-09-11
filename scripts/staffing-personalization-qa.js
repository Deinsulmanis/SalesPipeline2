'use strict';

// A fixed 30-lead local QA runner. Never imports server.js/outreach-agent.js or a CRM/provider client.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { previewStaffingPersonalization, flagBatchDuplicates } = require('../integrations/staffing-personalization');

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (c === '"') { if(quoted && text[i+1] === '"'){cell+='"'; i++;} else quoted=!quoted; }
    else if (c === ',' && !quoted) { row.push(cell);cell=''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if(c==='\r' && text[i+1]==='\n') i++; row.push(cell); if(row.some(Boolean))rows.push(row); row=[];cell=''; }
    else cell+=c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if(cell || row.length){row.push(cell);rows.push(row);}
  const header = rows.shift().map(x=>x.replace(/^\uFEFF/,''));
  return rows.map((r,i)=>{ if(r.length!==header.length) throw new Error(`CSV width mismatch at record ${i+2}`);return Object.fromEntries(header.map((k,j)=>[k,r[j]])); });
}
function csv(rows, columns) {
  const value = x => '"'+String(x??'').replace(/"/g,'""')+'"';
  return '\uFEFF'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(value).join(',')).join('\r\n')+'\r\n';
}
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function buyerGroup(row) {
  const t=row.jobTitle.toLowerCase();
  if (/sales|business development|revenue/.test(t)) return 'Sales/BD';
  if (/owner|founder|partner|principal/.test(t)) return 'Owner/founder/partner';
  if (/president/.test(t)) return 'President';
  if (/ceo|chief executive/.test(t)) return 'CEO';
  return 'Other senior buyer';
}
function selectSample(rows) {
  if(rows.length!==178) throw new Error('This QA run expects the supplied 178-record Tier 1 batch');
  if(rows.some(r=> !/^verified\b.*NOT catch-all/i.test(r.emailStatus))) throw new Error('Non Tier 1 status found');
  if(new Set(rows.map(r=>r.companyDomain.toLowerCase())).size!==rows.length) throw new Error('Duplicate company domains in Tier 1');
  const selected=[], covered=new Set();
  for (const [lane,quota] of [['B',8],['A',22]]) {
    const pool=rows.filter(r=>r.staffingLane.startsWith(lane));
    if(pool.length<quota)throw new Error('Insufficient lane coverage');
    for(let n=0;n<quota;n++) {
      const features=r=>[r.companyState, r.companySizeCategory, buyerGroup(r), r.staffingSpecialization].map((v,i)=>`${i}:${v}`);
      pool.sort((a,b)=> features(b).filter(x=>!covered.has(x)).length-features(a).filter(x=>!covered.has(x)).length
        || hash(`staffing-qa-20260910|${a.companyDomain}`).localeCompare(hash(`staffing-qa-20260910|${b.companyDomain}`)));
      const chosen=pool.shift(); selected.push(chosen);features(chosen).forEach(x=>covered.add(x));
    }
  }
  return selected;
}
async function run(input, output, { reuseResearch = false } = {}) {
  require('dotenv').config({ path:path.join(__dirname,'..','.env'), quiet:true });
  const source=fs.readFileSync(input,'utf8'); const rows=parseCsv(source); const sample=selectSample(rows);
  fs.mkdirSync(output,{recursive:true});
  const sampleFields=['firstName','company','companyWebsite','companyDomain','companyCity','companyState','companySizeCategory','jobTitle','staffingLane','staffingSpecialization','emailStatus','sourceEvidence'];
  const leads=sample.map(r=>({...Object.fromEntries(sampleFields.map(k=>[k,r[k]])), campaign:STAFFING_CAMPAIGN.name,campaignId:STAFFING_CAMPAIGN.id}));
  const codeDigest=hash(['staffing-personalization.js','staffing-research.js','staffing-campaign.js'].map(f=>fs.readFileSync(path.join(__dirname,'../integrations',f),'utf8')).join('\n'));
  fs.writeFileSync(path.join(output,'sample.json'),JSON.stringify({inputFile:path.basename(input),inputSha256:hash(source),codeDigest,method:'Fixed greedy coverage with SHA-256 tie-break; 8 Lane B + 22 Lane A; no outcome replacement',leads},null,2));
  const results=new Array(leads.length); let next=0;
  async function worker() {
    while(next<leads.length) {
      const i=next++, lead=leads[i], cache=path.join(output,`lead-${String(i+1).padStart(2,'0')}.json`);
      let prior;
      if(fs.existsSync(cache)) { prior=JSON.parse(fs.readFileSync(cache,'utf8')); if(prior.companyDomain===lead.companyDomain && prior.codeDigest===codeDigest){results[i]=prior;continue;} }
      const researchReused = reuseResearch && prior?.companyDomain === lead.companyDomain
        && prior?.companyWebsite === lead.companyWebsite && !!prior.research?.pages;
      const result=await previewStaffingPersonalization(lead, researchReused ? {researchCompany:async()=>prior.research} : {});
      results[i]={...lead,...result,codeDigest,researchReused};fs.writeFileSync(cache,JSON.stringify(results[i],null,2));
      console.log(`${i+1}/30 ${lead.company}: ${result.confidence}; ${result.research?.pages?.length||0} pages; ${result.reviewReasons.join(', ')}`);
    }
  }
  await Promise.all([worker(),worker(),worker()]);
  await flagBatchDuplicates(results);
  const counts=results.reduce((a,r)=>(a[r.confidence]=(a[r.confidence]||0)+1,a),{HIGH:0,MEDIUM:0,FALLBACK:0,REVIEW_REQUIRED:0});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({campaign:STAFFING_CAMPAIGN,counts,results},null,2));
  const qaRows=results.map(r=>({...r,existingStaffingSpecialization:r.staffingSpecialization,
    evidence:r.facts.map(f=>`${f.kind}: ${f.value}\n${f.sourceUrl}\n${f.quote}`).join('\n\n'),
    reviewReasons:r.reviewReasons.join('; '),researchFailures:(r.research?.failures||[]).join('; '),
    qaChecks:JSON.stringify(r.qaChecks||{}),reviewFlag:r.reviewFlag?'YES':'NO'}));
  fs.writeFileSync(path.join(output,'staffing-personalization-qa.csv'),csv(qaRows,['firstName','company','companyWebsite','companyCity','companyState','staffingLane','existingStaffingSpecialization','hyperPersonalizedOpening','confidence','sourceURL_or_sourceDescription','researchNotes','reviewFlag','reviewReasons','evidence','rejectedOpening','researchFailures','jobTitle','companySizeCategory','qaChecks']));
  console.log(JSON.stringify({count:results.length,counts,output},null,2));
  return {counts,results};
}
if(require.main===module) {
  const args=process.argv.slice(2),input=args[args.indexOf('--input')+1],output=args[args.indexOf('--out')+1];
  if(!args.includes('--input')||!args.includes('--out'))throw new Error('Use --input Tier1.csv --out review-directory');
  run(input,output,{reuseResearch:args.includes('--reuse-research')}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={parseCsv,csv,selectSample,buyerGroup,run};
