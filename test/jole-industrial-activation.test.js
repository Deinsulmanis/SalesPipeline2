'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuredSenders, chooseSender } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { getClient } = require('../integrations/clients/registry');
const { activationBlockers } = require('../integrations/gmail-sender-lifecycle');
const { coldSenderHolds } = require('../integrations/cold-delivery-policy');
const { scopedBalanceInput, planSenderRebalance } = require('../integrations/sender-balance');
const { buildSendRunPlan } = require('../integrations/send-run-plan');
const { runClientOverlappedSenderLanes } = require('../integrations/sender-lanes');
const { createSendQuotaCoordinator } = require('../integrations/send-quota-coordinator');
const { createMemorySendQuotaStore } = require('../test-support/send-quota-memory');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { createPgSendReservationStore } = require('../integrations/send-reservation-store');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
require('../test-support/jole-v4-fixtures').classifyFixtureLeadsExact();

const ids = ['jole_group_jorge', 'jole_group_jguerrero', 'jole_team_jorge', 'jole_team_jguerrero',
  'jole_industrial_jorge', 'jole_industrial_jguerrero'];
const caps = [15,20,20,20,15,15];
const scale = [['tryscalelabai',30,6],['scalelabaiteam',15,5],['deniels',45,5],['deniels_tryscalelabai',45,5]];
const env = {
  CLIENT_SENDING_AUTHORIZED: 'jole', FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}',
  GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_GLOBAL_DAILY_CEILING: '185', GMAIL_GLOBAL_PER_RUN_CEILING: '27',
  COLD_INBOX_DAILY_CAP: '50', COLD_SENDER_HOLDS: 'none', COLD_SENDER_POOL: 'all',
  RECIPIENT_PROVIDER_POLICY: 'off', SEND_CONCURRENT_SENDER_LANES: 'false',
  COLD_INBOX_DAILY_CAPS: ids.map((id,i)=>id+':'+caps[i]).join(',')+',scalelabaiteam:15',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify(scale.map(([id,dailyLimit,perRunLimit])=>({
    id,email:id==='scalelabaiteam'?'deins@scalelabaiteam.com':id+'@example.test',
    status:'active',tokenEnv:'GMAIL_'+id.toUpperCase()+'_TOKEN_JSON',dailyLimit,perRunLimit }))),
  ...Object.fromEntries([...ids,...scale.map(s=>s[0])].map(id=>['GMAIL_'+id.toUpperCase()+'_TOKEN_JSON','{}'])),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(ids.map(id=>({id,status:'active'}))),
  JOLE_LANDING_PAGE_URL:'https://jolebtx.netlify.app/',
  JOLE_BOOKING_LINK:'https://calendar.app.google/HfJfGYaL3gEaSg4P8',
  JOLE_COMMERCIAL_MAILING_ADDRESS:'2738 Dallas Ave, Ingleside, TX 78362',
};
const senders = configuredSenders(env);
const capacity = capacityFromEnv(senders,env);
const lead = (n,extra={}) => ({
  id:'ACT'+n,company:'Gulf Fabrication '+n,contactName:'Pat Rivera',email:'pat'+n+'@gulffab.test',
  clientId:'jole',stage:'Queued',emailStatus:'',emailStep:'',lastEmailedAt:'',notes:'',
  leadNiche:'jole_employer',emailTemplateId:'jole-industrial-employer-v1',
  intendedCampaignVersion:'jole-btx-employer-acquisition',campaign:'jole-btx-employer-acquisition',
  routingRequired:'true',senderInboxId:ids[n%4],revision:1,
  campaign_notes:serializeLeadProfile(buildLeadProfile({clientId:'jole',profile:profileFromResearchRow({
    first_name:'Pat',last_name:'Rivera',title:'Plant Manager',buyer_type:'Plant / operations / production',
    company_domain:'gulffab.test',sector:'Industrial fabrication / machinery',priority_tier:'Tier A',site_tie:'EXACT',
    hiring_site:'Mont Belvieu, TX',verified_role:'Millwright - Night Shift',posting_date:'2026-10-01',
    hiring_evidence_url:'https://example.org/jobs/'+n,verified_at:'2026-10-23',
  })})),...extra,
});

test('six eligible inboxes allocate 105/day and 12/window with unchanged client ceilings and ScaleLab',()=>{
  assert.deepEqual(capacity.clientLimits,{scalelab:{daily:170,perRun:27},jole:{daily:105,perRun:12}});
  assert.equal(getClient('jole').capacity.dailyCap,120);
  assert.equal(getClient('jole').capacity.windowCap,12);
  assert.deepEqual(senders.filter(s=>s.clientId==='jole'&&s.sendEligible).map(s=>s.id),ids);
  assert.deepEqual(senders.filter(s=>s.clientId==='jole').map(s=>s.dailyLimit),caps);
  assert.equal(coldSenderHolds(env).size,0);
  const before={...env,COLD_INBOX_DAILY_CAPS:env.COLD_INBOX_DAILY_CAPS.replace(/jole_industrial_(jorge|jguerrero):15/g,'jole_industrial_$1:0'),
    COLD_SENDER_HOLDS:ids.slice(4).map(id=>id+':warmup_incomplete').join(',')};
  assert.deepEqual(configuredSenders(before).filter(s=>s.clientId!=='jole'),senders.filter(s=>s.clientId!=='jole'));
  assert.equal(capacityFromEnv(configuredSenders(before),before).clientLimits.jole.daily,75);
});

test('persisted active overlay survives reconstruction; credential, observer, identity and hold gates remain',()=>{
  assert.deepEqual(configuredSenders(JSON.parse(JSON.stringify(env))),senders);
  for(const id of ids.slice(4)){
    const s=senders.find(x=>x.id===id);
    const ctx={env,senders,auth:{authenticated:true,identityVerified:true},observer:{health:'healthy',cursorState:'present'}};
    assert.deepEqual(activationBlockers(s,ctx),[]);
    assert.ok(activationBlockers(s,{...ctx,auth:{authenticated:false}}).length);
    assert.ok(activationBlockers(s,{...ctx,auth:{identityVerified:false}}).length);
    assert.ok(activationBlockers(s,{...ctx,observer:{health:'backoff'}}).length);
    assert.ok(activationBlockers(s,{...ctx,env:{...env,COLD_SENDER_HOLDS:id+':provider_suspended'}}).length);
    assert.equal(configuredSenders({...env,[s.tokenEnv]:''}).find(x=>x.id===id).sendEligible,false);
    assert.equal(chooseSender({lead:lead(1,{senderInboxId:id}),senders,sendsToday:new Map([[id,15]])}).sender,null);
  }
});

test('ten windows with six sequential Jole lanes overlapping ScaleLab consume exactly 105 and 170',async()=>{
  const counts=new Map(),clients=new Map();let global=0;
  const store=createMemorySendQuotaStore();
  for(let window=0;window<10;window++){
    const plan=buildSendRunPlan({senders,capacity,sentTodayBySender:counts,sentTodayByClient:clients,sentTodayGlobal:global,perInboxRunCap:6});
    const coordinator=createSendQuotaCoordinator({store,runId:'activation-'+window,dayKey:'2026-10-26',plan,
      baselines:{global,clients:new Map(clients),senders:new Map(counts)},log:()=>{}});
    await coordinator.start();
    const running=new Set();let peak=0;const seen=[];
    const outcomes=await runClientOverlappedSenderLanes(senders.filter(s=>plan.lanes.some(l=>l.senderId===s.id&&l.budget)),async s=>{
      const clientId=s.clientId||'scalelab';assert.equal(running.has(clientId),false);
      running.add(clientId);peak=Math.max(peak,running.size);seen.push(s.id);
      try{
        for(let i=0;i<plan.lanes.find(l=>l.senderId===s.id).budget;i++){
          await coordinator.execute({actionId:window+':'+s.id+':'+i,senderId:s.id,clientId,
            run:async({markProviderStart})=>{await markProviderStart();await new Promise(r=>setImmediate(r));return {id:'simulated'};}});
          counts.set(s.id,(counts.get(s.id)||0)+1);clients.set(clientId,(clients.get(clientId)||0)+1);global++;
        }
      }finally{running.delete(clientId)}
    },{parallel:false});
    assert.ok(outcomes.every(x=>x.status==='fulfilled'));
    if(window===0){assert.equal(peak,2);assert.ok(ids.every(id=>seen.includes(id)));assert.equal(plan.lanes.filter(l=>l.clientId==='jole').reduce((n,l)=>n+l.budget,0),12)}
    await coordinator.finish();
  }
  assert.equal(clients.get('jole'),105);assert.equal(clients.get('scalelab'),170);
  for(let i=0;i<ids.length;i++)assert.equal(counts.get(ids[i]),caps[i]);
});

test('client-scoped multi-day refill preserves metadata, unsafe leads, follow-ups and other clients',()=>{
  const good=Array.from({length:800},(_,i)=>lead(i));
  const unsafe=[lead(900,{emailStatus:'emailed',emailStep:'1'}),lead(901),lead(902),lead(903),
    lead(904,{stage:'Completed'}),lead(905),lead(906)];
  const activities=[
    {sourceLeadId:'ACT902',eventType:'send_uncertain'},
    {sourceLeadId:'ACT905',eventType:'initial_email_sent',metadata:JSON.stringify({senderInboxId:ids[0],gmailThreadId:'thread-1'})},
    {sourceLeadId:'ACT906',eventType:'ordinary_send_reserved'},
  ];
  const other=lead(1000,{clientId:'scalelab',campaign:'industrial-staffing-v2',senderInboxId:'primary'});
  const input={leads:[...good,...unsafe,other],activities,senders,env,renderOptions:{env},lockedLeadIds:new Set(['ACT901']),
    suppressedEmails:new Set([unsafe[3].email]),boardLeads:[],horizon:Date.parse('2026-10-26T17:00:00Z')};
  const scoped=scopedBalanceInput(input,{client:'jole',bufferRatio:6});
  assert.equal(scoped.leads,input.leads);
  const plan=planSenderRebalance(scoped);
  for(const id of ids.slice(4))assert.equal(plan.after.find(s=>s.id===id).firstTouch,105,JSON.stringify(plan.excluded));
  const moved=new Set(plan.moves.map(m=>m.leadId));
  assert.equal(moved.size,plan.moves.length);
  assert.ok(unsafe.every(l=>!moved.has(l.id)));assert.equal(moved.has(other.id),false);
  for(const m of plan.moves){assert.ok(ids.includes(m.from)&&ids.includes(m.to));assert.equal(m.expectedState,good.find(l=>l.id===m.leadId))}
  const next=input.leads.map(l=>{const m=plan.moves.find(m=>m.leadId===l.id);return m?{...l,senderInboxId:m.to}:l});
  assert.equal(planSenderRebalance(scopedBalanceInput({...input,leads:next},{client:'jole',bufferRatio:6})).moves.length,0);
  assert.throws(()=>scopedBalanceInput(input,{client:'unknown'}));
  for(const bufferRatio of [-1,9,'bad'])assert.throws(()=>scopedBalanceInput(input,{client:'jole',bufferRatio}));
  assert.throws(()=>scopedBalanceInput(input,{bufferRatio:7}));
});

test('balance reservation inventory includes fresh reserved and sending actions without diagnostic truncation',async()=>{
  const store=createMemorySendReservationStore();
  await store.reserveOutboundAction({actionId:'fresh',leadId:'ACT1',actionType:'gmail_cold_step',provider:'gmail'},{leaseOwner:'worker',leaseSeconds:60});
  assert.equal((await store.listUnresolved()).staleReserved.length,0);
  assert.equal((await store.listUnresolved({includeActive:true})).staleReserved.length,1);
  let query;
  const pg=createPgSendReservationStore({pool:{query:async(sql,params)=>{query={sql,params};return {rows:[]}}}});
  await pg.listUnresolved({includeActive:true});
  assert.equal(query.params[4],true);assert.doesNotMatch(query.sql,/LIMIT/);
  await pg.listUnresolved();assert.equal(query.params[4],false);assert.match(query.sql,/LIMIT 500/);
});
