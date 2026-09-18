'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {staffingLaunchState,staffingSendBlockReason,assertStaffingSendAllowed,ACTIVATION_VARIABLE}=require('../integrations/staffing-launch-gate');
const {TEST_STAFFING_MAILING_ADDRESS}=require('../test-support/staffing-mail');
const lead={id:'staff',campaign:'Industrial Staffing Agency',leadNiche:'industrial_staffing',emailTemplateId:'industrial-staffing-employer-v1',senderInboxId:'primary',routingRequired:'true'};
const approvedAt='2026-09-01T00:00:00.000Z';
for(const value of [undefined,'','true','false','2026-02-30T00:00:00.000Z','2099-01-01T00:00:00.000Z'])test(`approval ${value} cannot enable delivery`,()=>{
 const env={[ACTIVATION_VARIABLE]:value};assert.equal(staffingLaunchState(env).sendable,false);assert.throws(()=>assertStaffingSendAllowed(lead,env),/paused/);
});
test('exact activation time enables this campaign without changing global caps',()=>{
 const env={[ACTIVATION_VARIABLE]:approvedAt};assert.equal(staffingLaunchState(env).sendable,true);assert.equal(staffingLaunchState(env).activatedAt,approvedAt);assert.doesNotThrow(()=>assertStaffingSendAllowed(lead,env));assert.deepEqual(Object.keys(env),[ACTIVATION_VARIABLE]);
});
test('every staffing identity field blocks an unrouted or conflicting row',()=>{
 for(const field of ['leadNiche','tradeType','emailTemplateId','intendedCampaignVersion','campaign','campaignId','campaignFamily'])assert.match(staffingSendBlockReason({[field]:'industrial_staffing'},{}),/paused/);
 assert.equal(staffingSendBlockReason({leadNiche:'dental'},{}),'');
});
test('missing lead context cannot reach the provider',()=>assert.throws(()=>assertStaffingSendAllowed(),/lead context/));
test('approval survives a fresh process and clearing it closes a fresh process',()=>{
 for(const value of ['',approvedAt,'']){
  const env={...process.env,[ACTIVATION_VARIABLE]:value};
  const out=JSON.parse(execFileSync(process.execPath,['-e',`console.log(JSON.stringify(require('./integrations/staffing-launch-gate').staffingLaunchState()))`],{cwd:require('node:path').join(__dirname,'..'),env,encoding:'utf8'}));
  assert.equal(out.sendable,Boolean(value));
 }
});
test('approved queue route stays selectable while actual routing/attribution remain closed',()=>{
 const saved=process.env[ACTIVATION_VARIABLE];delete process.env[ACTIVATION_VARIABLE];
 try{
  const routing=require('../integrations/campaign-routing'),versions=require('../integrations/campaign-versions');
  assert.equal(routing.campaignVersionsForRoute({niche:lead.leadNiche}).length,1);
  assert.equal(routing.routedLeadReady(lead).ok,false);
  assert.throws(()=>versions.activeVersionForLead(lead),/not active/);
  process.env[ACTIVATION_VARIABLE]=approvedAt;
  assert.equal(routing.routedLeadReady(lead).ok,true);
  assert.equal(versions.activeVersionForLead(lead).status,'active');
 }finally{if(saved===undefined)delete process.env[ACTIVATION_VARIABLE];else process.env[ACTIVATION_VARIABLE]=saved;}
});
test('the actual provider function refuses staffing before constructing or calling Gmail',async()=>{
 const source=fs.readFileSync(require.resolve('../outreach-agent'),'utf8');
 const code=source.slice(source.indexOf('async function sendEmail('),source.indexOf('async function loadOutreachProviderState('));
 let calls=0;const send=new Function('assertStaffingSendAllowed','assertSendAuthorized','PRIMARY_GMAIL_SENDER','GmailOutreachProvider','gmailForSender','toRawMessage','withGmailProviderSend',`${code};return sendEmail;`)(l=>assertStaffingSendAllowed(l,{}),()=>{},{},class{constructor(){calls++;}},()=>assert.fail('Gmail must not be constructed'),()=>assert.fail('MIME must not be built'),()=>assert.fail('lock must not run'));
 await assert.rejects(send({lead,to:'test@example.com'}),/paused/);assert.equal(calls,0);
});
test('warm, stage, intent, ordinary and Smartlead boundaries retain the gate',()=>{
 const s=fs.readFileSync(require.resolve('../outreach-agent'),'utf8').replace(/\r\n/g,'\n');
 assert.match(s,/function suppressionReason\(lead\) \{\n  const staffingBlocked = staffingSendBlockReason\(lead\);\n  if \(staffingBlocked\) return staffingBlocked;/);
 assert.match(s,/finalRevalidate: async \(\) => \{\n      if \(staffingSendBlockReason\(lead\)\)/);
 assert.match(s,/if \(staffingSendBlockReason\(twin \|\| boardLead\)\) continue;/);
 assert.match(s,/sendProvider: payload => \{/);
 assert.match(s,/assertGmailProviderAllowed\(\{/);
 assert.match(s,/return sendEmail\(\{/);
 assert.match(s,/sendAction: \{/);
 assert.match(s,/lead: twin \|\| boardLead, to: boardLead.email/);
 assert.match(s,/async function enqueueSmartleadLead\(lead, mapping\) \{\n  assertSendAuthorized\(\);\n  assertStaffingSendAllowed\(lead\);/);
});

test('102 queue commits produce one audit batch and replay produces none',async()=>{
 const {queueSelectedLeads}=require('../integrations/outreach-queue');
 let leads=Array.from({length:102},(_,i)=>({...lead,id:'staff-'+i,email:`owner${i}@example.com`,company:'Example '+i,contactName:'Alex',stage:'Import',emailStatus:'',siteContext:'Saw you place welders for manufacturers.'}));
 let commits=0,audits=[];
 const request={ids:leads.map(l=>l.id),senderInboxId:'primary',emailTemplateId:lead.emailTemplateId,campaignVersionId:'industrial_staffing_employer_acquisition_v1'};
 const deps={loadState:async()=>({leads,mailingAddress:TEST_STAFFING_MAILING_ADDRESS}),validateSelection:()=>({ok:true}),
  applyChanges:async changes=>{commits+=changes.length;leads=changes.map(({lead,patch})=>({...lead,...patch}));return leads.map(l=>({leadId:l.id,status:'succeeded'}));},
  appendActivities:async rows=>{assert.equal(commits,102);audits.push(rows);}};
 const result=await queueSelectedLeads(request,deps);assert.equal(result.succeeded,102);assert.equal(audits.length,1);assert.equal(audits[0].length,102);
 const repeat=await queueSelectedLeads(request,deps);assert.equal(repeat.unchanged,102);assert.equal(commits,102);assert.equal(audits.length,1);
});
test('audit failure exposes every affected committed lead without pretending enrollment failed',async()=>{
 const {queueSelectedLeads}=require('../integrations/outreach-queue');
 const row={...lead,email:'owner@example.com',company:'Example',contactName:'Alex',stage:'Import',emailStatus:'',siteContext:'Saw you place welders for manufacturers.'};
 const out=await queueSelectedLeads({ids:[row.id]}, {loadState:async()=>({leads:[row],mailingAddress:TEST_STAFFING_MAILING_ADDRESS}),validateSelection:()=>({ok:true}),applyChanges:async()=>[{leadId:row.id,status:'succeeded'}],appendActivities:async()=>{throw Error('audit unavailable');}});
 assert.equal(out.status,409);assert.equal(out.succeeded,1);assert.equal(out.activityFailures,1);assert.equal(out.results[0].activityRecorded,false);assert.match(out.error,/keep sending paused/);
});
