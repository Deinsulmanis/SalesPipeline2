'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {proveLegacyEvidence,applyProvenEvidence}=require('../integrations/gmail-evidence-reconciliation');
const {senderEvidence,successfulSendCountToday}=require('../integrations/gmail-sender-routing');
const lead={id:'l',email:'p@example.com',company:'Clinic',senderInboxId:'',emailStatus:'replied',notes:'[MANUAL HOLD]'};
const message=(id='out',threadId='t',from='sender@example.com',to=lead.email)=>({id,threadId,labelIds:['SENT'],internalDate:String(Date.parse('2026-08-02T10:00:00Z')),
  payload:{headers:[{name:'From',value:from},{name:'To',value:to},{name:'Message-ID',value:`<${id}@example.com>`}],body:{data:''}}});
function mailbox(id='primary',messages=[message()],inbound=false){return {id,email:'sender@example.com',gmail:{users:{
  getProfile:async()=>({data:{emailAddress:'sender@example.com'}}),messages:{list:async()=>({data:{messages}}),get:async p=>({data:messages.find(m=>m.id===p.id)})},
  threads:{get:async()=>({data:{messages:inbound?[{...message('in'),internalDate:String(Date.parse('2026-08-01T10:00:00Z')),payload:{headers:[{name:'From',value:lead.email}]}}]:[]}})},
}}};}
const input={lead,board:{id:'b',stage:'hot'},activities:[],now:new Date('2026-09-09T00:00:00Z')};
test('unique exact provider proof repairs only evidence and keeps the manual hold',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()]});assert.equal(plan.repairable,true);assert.equal(plan.threadId,'t');
  let sender='';const events=[];
  await applyProvenEvidence({plan,approvedHash:plan.proofHash,appendEvent:async e=>events.push(e),writeSender:async s=>sender=s,readback:async()=>({senderInboxId:sender,activities:events})});
  assert.deepEqual(senderEvidence({...lead,senderInboxId:sender},events),['primary']);assert.equal(lead.notes,'[MANUAL HOLD]');
  assert.equal(successfulSendCountToday(events,'2026-08-02'),0,'evidence is not a new send');
});
test('two provider sender claimants are a conflict and write nothing',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox(),mailbox('secondary')]});assert.equal(plan.repairable,false);assert.match(plan.reason,/CONFLICT/);assert.equal(plan.events.length,0);
});
test('no exact recipient provider evidence remains unknown',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message('x','t','sender@example.com','other@example.com')])]});assert.equal(plan.repairable,false);assert.match(plan.reason,/UNKNOWN/);
});
test('multiple threads prove sender only and never select a thread',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message(),message('other','t2')])]});assert.equal(plan.repairable,true);assert.equal(plan.threadId,null);assert.equal(JSON.parse(plan.events[0].metadata).gmailThreadId,'');
});
test('canonical sender conflict is not overwritten',async()=>{
  const plan=await proveLegacyEvidence({...input,lead:{...lead,senderInboxId:'secondary'},mailboxes:[mailbox()]});assert.equal(plan.repairable,false);assert.match(plan.reason,/canonical sender/);
});
test('manual response needs an earlier exact inbound; an opener is not a manual reply',async()=>{
  const opener=await proveLegacyEvidence({...input,mailboxes:[mailbox()]});assert.equal(opener.events.filter(e=>e.eventType==='human_response_sent').length,0);
  const reply=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message()],true)]});assert.equal(reply.events.filter(e=>e.eventType==='human_response_sent').length,1);
});
test('changed proof manifest fails before first production write',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()]});let writes=0;
  await assert.rejects(()=>applyProvenEvidence({plan,approvedHash:'wrong',appendEvent:async()=>writes++,writeSender:async()=>writes++}),/proof changed/);assert.equal(writes,0);
});
test('readback mismatch fails closed',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()]});await assert.rejects(()=>applyProvenEvidence({plan,approvedHash:plan.proofHash,appendEvent:async()=>{},writeSender:async()=>{},readback:async()=>({senderInboxId:'wrong',activities:[]})}),/readback mismatch/);
});
test('evidence reconciliation has no send, stage, outcome, meeting, hold or enrollment writer',()=>{
  const body=applyProvenEvidence.toString();assert.doesNotMatch(body,/sendMail|messages.send|enroll|writeStage|writeOutcome|releaseHold|writeMeeting/);
});
