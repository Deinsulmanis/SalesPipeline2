'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {simulateRouting}=require('../integrations/gmail-routing-simulation');
const senders=[{id:'primary',sendEligible:true,dailyLimit:20},{id:'b',sendEligible:true,dailyLimit:20}];
test('simulation distributes new dental while preserving existing sender ownership',()=>{
 const leads=[{id:'1',email:'one@x.test',tradeType:'Dental',stage:'Queued',emailStatus:''},{id:'2',email:'two@x.test',tradeType:'Dental',emailStatus:'emailed',emailStep:'1',senderInboxId:'b'}];
 const activities=[{eventType:'initial_email_sent',sourceLeadId:'2',metadata:JSON.stringify({senderInboxId:'b',gmailThreadId:'t',gmailMessageId:'m'})}];
 const r=simulateRouting({leads,activities,senders,sendsToday:new Map()}); assert.equal(r.eligibleDentalCandidates,2);assert.equal(r.assigned.primary,1);assert.equal(r.assigned.b,1);assert.equal(r.senderThreadConflicts,0);
});
test('global suppression and human ownership exclude candidates before sender choice',()=>{
 const leads=[{id:'1',email:'no@x.test',tradeType:'Dental',stage:'Queued'},{id:'2',email:'yes@x.test',tradeType:'Dental',emailStatus:'emailed',emailStep:'1',senderInboxId:'b'}];
 const activities=[{eventType:'human_response_sent',sourceLeadId:'2',metadata:'{}'}]; const r=simulateRouting({leads,activities,suppressedEmails:new Set(['no@x.test']),senders});assert.equal(r.suppressedCandidates,1);assert.equal(r.humanOwnedCandidates,1);assert.equal(r.eligibleDentalCandidates,0);
});
test('cross-sender evidence is reported as a collision',()=>{const lead={id:'1',email:'a@x.test',tradeType:'Dental',emailStatus:'emailed',emailStep:'1'};const activities=['primary','b'].map((senderInboxId,i)=>({eventType:i?'follow_up_sent':'initial_email_sent',sourceLeadId:'1',metadata:JSON.stringify({senderInboxId,gmailThreadId:'t',gmailMessageId:'m'+i})}));const r=simulateRouting({leads:[lead],activities,senders});assert.equal(r.senderThreadConflicts,1);assert.equal(r.ambiguousCandidates,1);});
