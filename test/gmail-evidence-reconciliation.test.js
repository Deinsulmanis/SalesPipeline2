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
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()],expectedMailboxIds:['primary']});assert.equal(plan.repairable,true);assert.equal(plan.threadId,'t');
  let sender='';const events=[];
  await applyProvenEvidence({plan,approvedHash:plan.proofHash,appendEvent:async e=>events.push(e),writeSender:async s=>sender=s,readback:async()=>({senderInboxId:sender,activities:events})});
  assert.deepEqual(senderEvidence({...lead,senderInboxId:sender},events),['primary']);assert.equal(lead.notes,'[MANUAL HOLD]');
  assert.equal(successfulSendCountToday(events,'2026-08-02'),0,'evidence is not a new send');
});
test('two provider sender claimants are a conflict and write nothing',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox(),mailbox('secondary')],expectedMailboxIds:['primary','secondary']});assert.equal(plan.repairable,false);assert.match(plan.reason,/CONFLICT/);assert.equal(plan.events.length,0);
});
test('no exact recipient provider evidence remains unknown',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message('x','t','sender@example.com','other@example.com')])],expectedMailboxIds:['primary']});assert.equal(plan.repairable,false);assert.match(plan.reason,/UNKNOWN/);
});
test('multiple threads prove sender only and never select a thread',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message(),message('other','t2')])],expectedMailboxIds:['primary']});assert.equal(plan.repairable,true);assert.equal(plan.threadId,null);assert.equal(JSON.parse(plan.events[0].metadata).gmailThreadId,'');
});
test('canonical sender conflict is not overwritten',async()=>{
  const plan=await proveLegacyEvidence({...input,lead:{...lead,senderInboxId:'secondary'},mailboxes:[mailbox()],expectedMailboxIds:['primary']});assert.equal(plan.repairable,false);assert.match(plan.reason,/canonical sender/);
});
test('manual response needs an earlier exact inbound; an opener is not a manual reply',async()=>{
  const opener=await proveLegacyEvidence({...input,mailboxes:[mailbox()],expectedMailboxIds:['primary']});assert.equal(opener.events.filter(e=>e.eventType==='human_response_sent').length,0);
  const reply=await proveLegacyEvidence({...input,mailboxes:[mailbox('primary',[message()],true)],expectedMailboxIds:['primary']});assert.equal(reply.events.filter(e=>e.eventType==='human_response_sent').length,1);
});
test('changed proof manifest fails before first production write',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()],expectedMailboxIds:['primary']});let writes=0;
  await assert.rejects(()=>applyProvenEvidence({plan,approvedHash:'wrong',appendEvent:async()=>writes++,writeSender:async()=>writes++}),/proof changed/);assert.equal(writes,0);
});
test('readback mismatch fails closed',async()=>{
  const plan=await proveLegacyEvidence({...input,mailboxes:[mailbox()],expectedMailboxIds:['primary']});await assert.rejects(()=>applyProvenEvidence({plan,approvedHash:plan.proofHash,appendEvent:async()=>{},writeSender:async()=>{},readback:async()=>({senderInboxId:'wrong',activities:[]})}),/readback mismatch/);
});
test('evidence reconciliation has no send, stage, outcome, meeting, hold or enrollment writer',()=>{
  const body=applyProvenEvidence.toString();assert.doesNotMatch(body,/sendMail|messages.send|enroll|writeStage|writeOutcome|releaseHold|writeMeeting/);
});

// ── Mailbox-coverage guard ──────────────────────────────────────────────────
//
// Sender ownership is derived from which mailboxes CLAIM an outbound message,
// so the verdict is only as trustworthy as the set of mailboxes actually asked.
// True evidence spanning primary AND secondary, with only primary
// authenticated, yields claimants = ['primary'] — a genuine CONFLICT written to
// canonical state as PROVEN PRIMARY. Partial visibility manufactures a proof
// rather than degrading gracefully, so coverage is a precondition.

const {assertMailboxCoverage}=require('../integrations/gmail-evidence-reconciliation');

test('every active sending mailbox must be authenticated before any proof', () => {
  // Both present: allowed.
  assert.doesNotThrow(() => assertMailboxCoverage(
    [{id:'primary'},{id:'tryscalelabai'}], ['primary','tryscalelabai']));

  // Primary only, secondary expected: hard stop.
  assert.throws(() => assertMailboxCoverage([{id:'primary'}], ['primary','tryscalelabai']),
    /missing tryscalelabai/);
  // Secondary only: hard stop.
  assert.throws(() => assertMailboxCoverage([{id:'tryscalelabai'}], ['primary','tryscalelabai']),
    /missing primary/);
  // Registry expects three, two authenticated: hard stop.
  assert.throws(() => assertMailboxCoverage([{id:'primary'},{id:'tryscalelabai'}],
    ['primary','tryscalelabai','third']), /missing third/);
  // The refusal explains the consequence, not just the condition.
  assert.throws(() => assertMailboxCoverage([{id:'primary'}], ['primary','tryscalelabai']),
    /CONFLICT into a false PROVEN result/);

  // An unknown roster is refused rather than treated as "nothing to cover".
  assert.throws(() => assertMailboxCoverage([{id:'primary'}], []), /unknown roster/);
  assert.throws(() => assertMailboxCoverage([{id:'primary'}], undefined), /unknown roster/);
  // A mailbox outside the expected roster cannot be smuggled in.
  assert.throws(() => assertMailboxCoverage([{id:'primary'},{id:'rogue'}], ['primary']), /Unexpected mailbox/);
});

test('proveLegacyEvidence refuses partial visibility before reading Gmail', async () => {
  // The guard runs BEFORE any provider call, so an unsafe roster cannot spend
  // quota or read a mailbox at all.
  let called = 0;
  const counting = id => ({ id, email: `${id}@example.com`, gmail: { users: {
    getProfile: async () => { called++; return { data: { emailAddress: `${id}@example.com` } }; },
    messages: { list: async () => { called++; return { data: {} }; }, get: async () => ({ data: {} }) },
    threads: { get: async () => ({ data: { messages: [] } }) } } } });

  await assert.rejects(
    () => proveLegacyEvidence({ ...input, mailboxes: [counting('primary')],
      expectedMailboxIds: ['primary','tryscalelabai'] }),
    /Evidence reconciliation requires every active sending mailbox/);
  assert.equal(called, 0, 'no Gmail read is issued when coverage is incomplete');

  // Identity mismatch still fails closed, and does so per mailbox.
  const liar = { id:'primary', email:'primary@example.com', gmail: { users: {
    getProfile: async () => ({ data: { emailAddress: 'someone-else@example.com' } }),
    messages: { list: async () => ({ data: {} }), get: async () => ({ data: {} }) },
    threads: { get: async () => ({ data: { messages: [] } }) } } } };
  await assert.rejects(
    () => proveLegacyEvidence({ ...input, mailboxes: [liar], expectedMailboxIds: ['primary'] }),
    /Mailbox identity mismatch/);
});
