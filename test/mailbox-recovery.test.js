'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeMailbox, OVERLAP_MS } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, commitObservation } = require('../integrations/mailbox-observation-events');
const { observerHealth } = require('../integrations/gmail-observer-health');
const { deriveNextAction } = require('../integrations/pipeline-state');
const NOW = new Date('2026-09-09T04:00:00Z');
const LAST = '2026-09-07T09:09:00Z';
const lead = { id:'l1', email:'prospect@example.com', company:'Clinic', emailStatus:'emailed', emailStep:'1', senderInboxId:'primary', lastEmailedAt:'2026-09-01T00:00:00Z', notes:'' };
const msg = (id, from, text, sent = false, at = '2026-09-08T18:00:00Z') => ({ id, threadId:'t1', internalDate:String(Date.parse(at)), labelIds:sent?['SENT']:['INBOX'],
  payload:{ mimeType:'text/plain', headers:[{name:'From',value:from},{name:'To',value:sent?lead.email:'sender@example.com'},{name:'Message-ID',value:`<${id}@test>`}], body:{data:Buffer.from(text).toString('base64url')} } });
const gone = () => Object.assign(new Error('Requested entity was not found.'),{response:{status:404}});
function fixture(messages = [], options = {}) {
  const calls = [];
  const gmail = { users:{
    getProfile:async p => {calls.push(['profile',p]); return {data:{historyId:'200', emailAddress: options.email || 'sender@example.com'}};},
    history:{list:async p => {calls.push(['history',p]); if(p.startHistoryId==='100' && options.expired!==false) throw gone(); return {data:{historyId:'201',history: p.startHistoryId==='100'?messages.map(m=>({messagesAdded:[{message:{id:m.id,threadId:m.threadId}}]})):[]}};}},
    messages:{list:async p => {calls.push(['list',p]); if(options.listError) throw options.listError; return {data:{messages:messages.map(m=>({id:m.id,threadId:m.threadId}))}};},
      get:async p => {calls.push(['get',p]); if(p.id===options.missing) throw gone(); return {data:messages.find(m=>m.id===p.id)};}},
    threads:{get:async p => {calls.push(['thread',p]); if(options.missing) throw gone(); return {data:{messages:[msg('in',lead.email,'hello',false,'2026-09-08T17:00:00Z'),...messages]}};}},
  }};
  const input = {gmail, leads:[lead],activities:[], senderInboxId:'primary',senderEmail:'sender@example.com',historyId:'100',lastSuccessfulObservationAt:LAST,now:NOW};
  return {gmail,calls,input};
}
test('404 catch-up uses persisted timestamp with overlap, all folders, and a pre-search History anchor', async()=>{
  const {calls,input}=fixture([msg('r',lead.email,'Yes interested')]);
  const result=await observeMailbox(input);
  assert.equal(result.mode,'catchup'); assert.equal(result.nextHistoryId,'201');
  const query=calls.find(c=>c[0]==='list')[1];
  assert.equal(query.q,`after:${Math.floor((Date.parse(LAST)-OVERLAP_MS)/1000)}`); assert.equal(query.includeSpamTrash,true);
  assert.ok(calls.findIndex(c=>c[0]==='profile')<calls.findIndex(c=>c[0]==='list'));
  assert.equal(calls.filter(c=>c[0]==='history').at(-1)[1].startHistoryId,'200');
});
for(const [name,message,expected] of [
  ['reply',msg('r',lead.email,'Yes, I am interested'),'positive_reply'],
  ['manual outbound',msg('o','sender@example.com','Can we meet?',true),'human_response_sent'],
  ['hard bounce',msg('b','mailer-daemon@example.com',`550 5.1.1 address not found ${lead.email}`),'email_bounced'],
  ['OOO',msg('a',lead.email,'I am out of office until September 15, 2026.'),'out_of_office_reply'],
  ['unsubscribe',msg('u',lead.email,'Unsubscribe. Stop emailing me.'),'unsubscribe_reply'],
]) test(`outage recovers ${name} with deterministic canonical identity and no send capability`,async()=>{
  const {gmail,input}=fixture([message]); const observation=await observeMailbox(input);
  const plan=await planMailboxEvents({...input,gmail,observation});
  const event=plan.events.find(e=>e.eventType===expected); assert.ok(event,JSON.stringify(plan));
  assert.equal(JSON.parse(event.metadata).autoSendAllowed,false);
  assert.ok(!plan.replies.some(r=>!r.historical));
});
test('safety overlap and retry do not duplicate canonical events',async()=>{
  const {input}=fixture([msg('r',lead.email,'Interested')]);const observation=await observeMailbox(input);
  const plan=await planMailboxEvents({...input,observation});
  const again=await planMailboxEvents({...input,observation,activities:plan.events});
  assert.equal(again.events.length,0);
});
test('irrelevant Gmail messages create no lead event',async()=>{
  const {input}=fixture([msg('r','stranger@example.com','Interested')]);const observation=await observeMailbox(input);
  const plan=await planMailboxEvents({...input,observation});assert.equal(plan.events.filter(e=>e.sourceLeadId).length,0);assert.equal(plan.ignored.length,1);
});
test('catch-up failure cannot return a checkpoint',async()=>{
  const {input}=fixture([],{listError:new Error('quota unavailable')});await assert.rejects(()=>observeMailbox(input),/quota unavailable/);
});
test('partial persistence never advances checkpoint and retries only missing events',async()=>{
  const {input}=fixture([msg('r',lead.email,'Interested'),msg('o','sender@example.com','Can we meet?',true)]);
  const observation=await observeMailbox(input);let plan=await planMailboxEvents({...input,observation});
  const activities=[];let checkpoints=0;let writes=0;
  await assert.rejects(()=>commitObservation({observation,plan,activities,suppress:async()=>{},appendEvent:async()=>{if(++writes===2)throw new Error('persistence failed');},checkpoint:async()=>{checkpoints++;}}),/persistence failed/);
  assert.equal(checkpoints,0);assert.equal(activities.length,1);
  plan=await planMailboxEvents({...input,observation,activities});
  await commitObservation({observation,plan,activities,suppress:async()=>{},appendEvent:async()=>{},checkpoint:async()=>{checkpoints++;}});
  assert.equal(checkpoints,1);assert.equal(new Set(activities.map(e=>e.eventId)).size,activities.length);
});
test('subsequent run returns to normal incremental History',async()=>{
  const {input,calls}=fixture();const recovery=await observeMailbox(input);calls.length=0;
  const normal=await observeMailbox({...input,historyId:recovery.nextHistoryId,lastSuccessfulObservationAt:NOW.toISOString()});
  assert.equal(normal.mode,'history');assert.equal(calls.filter(c=>c[0]==='list').length,0);
});
test('1000 leads still use one mailbox catch-up query',async()=>{
  const {input,calls}=fixture();await observeMailbox({...input,leads:Array.from({length:1000},(_,i)=>({...lead,id:String(i),email:`l${i}@example.com`}))});
  assert.equal(calls.filter(c=>c[0]==='list').length,1);
});
test('message 404 is retained as a provider evidence gap, not a cursor reset',async()=>{
  const {input,calls}=fixture([msg('missing',lead.email,'gone')],{expired:false,missing:'missing'});
  const observation=await observeMailbox({...input,lastSuccessfulObservationAt:NOW.toISOString()});
  assert.equal(observation.mode,'history');assert.equal(observation.unavailable.length,1);
  assert.equal(calls.filter(c=>c[0]==='profile').length,0);
  const plan=await planMailboxEvents({...input,observation});assert.equal(plan.events[0].eventType,'gmail_observation_gap');
  assert.equal(plan.events[0].sourceLeadId,'');
});
test('wrong mailbox binding fails catch-up closed',async()=>{
  const {input}=fixture([],{email:'wrong@example.com'});await assert.rejects(()=>observeMailbox(input),/identity mismatch/);
});
test('one mailbox failure cannot alter another checkpoint',async()=>{
  const checkpoints=new Map([['primary','100'],['secondary','300']]);
  const bad=fixture([],{listError:new Error('failure')});await assert.rejects(()=>observeMailbox(bad.input));
  const good=fixture([],{expired:false});const observation=await observeMailbox({...good.input,historyId:'300',lastSuccessfulObservationAt:NOW.toISOString()});
  await commitObservation({observation,plan:{events:[],suppressions:[]},activities:[],appendEvent:async()=>{},suppress:async()=>{},checkpoint:async o=>checkpoints.set('secondary',o.nextHistoryId)});
  assert.equal(checkpoints.get('primary'),'100');assert.equal(checkpoints.get('secondary'),'201');
});
test('normal fresh inbound remains eligible for later policy evaluation',async()=>{
  const {input}=fixture([msg('fresh',lead.email,'Interested',false,NOW.toISOString())],{expired:false});
  const observation=await observeMailbox({...input,lastSuccessfulObservationAt:NOW.toISOString()});
  const plan=await planMailboxEvents({...input,observation});assert.equal(plan.replies[0].historical,false);
  assert.equal(JSON.parse(plan.events[0].metadata).responsePending,true);
});
test('observer health becomes warning at 45 minutes and critical at 90',()=>{
  const rows=[[],['primary','123',new Date(NOW-50*60000).toISOString(),'','','healthy','history']];
  assert.equal(observerHealth(rows,{now:NOW})[0].severity,'warning');
  rows[1][2]=new Date(NOW-91*60000).toISOString();assert.equal(observerHealth(rows,{now:NOW})[0].severity,'critical');
});
test('CHECK_ONLY excludes response handlers and recovery commit has no send capability',()=>{
  const fs=require('node:fs');const source=fs.readFileSync(require.resolve('../outreach-agent.js'),'utf8');
  assert.match(source,/!item.historical && !CHECK_ONLY/);
  assert.match(source,/if \(!CHECK_ONLY\) for \(const row of activitiesForCycle\)/);
  assert.doesNotMatch(commitObservation.toString(),/sendMail|messages.send|deliver|enroll/);
});
const seq={status:'active',sequenceId:'demo_follow_up_v1',label:'Demo follow-up',step:0,eligible:true,featureEnabled:true,nextDueAt:'2026-09-08T16:00:00Z',dueNow:true};
for(const [name,board,twin,ctx,owner,pattern] of [
  ['overdue',{stage:'follow_up'},lead,{},'automation',/automated follow-up due/],
  ['scheduled',{stage:'follow_up'},lead,{sequenceState:{...seq,dueNow:false,nextDueAt:'2026-09-10T16:00:00Z'}},'automation',/scheduled/],
  ['observer blocked',{stage:'follow_up'},lead,{observer:{health:'unavailable'}},'automation',/Gmail observer unavailable/],
  ['hold',{stage:'follow_up'},{...lead,notes:'[MANUAL HOLD]'}, {},'human',/manual hold/],
  ['meeting',{stage:'call_booked',meetingAt:'2026-09-10T16:00:00Z'},lead,{},'meeting',/Sales call/],
  ['terminal',{stage:'closed_won'},lead,{},'none',/won/],
  ['human review',{stage:'follow_up'},lead,{activities:[{eventType:'needs_human_reply',occurredAt:'2026-09-08T16:00:00Z',content:'We will reach out when ready',metadata:JSON.stringify({provider:'gmail',gmailMessageId:'h',canonicalState:'needs_human',reason:'deferred_timing',genuineHuman:true})}]},'human',/Revisit|Respond|Investigate|Review/],
])test(`Next Action respects canonical ${name} precedence`,()=>{
  const action=deriveNextAction(board,twin,{now:NOW,activities:[],sequenceState:seq,sequencesEnabled:true,...ctx});
  assert.equal(action.owner,owner);assert.match(action.label,pattern);
});
