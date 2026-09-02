'use strict';
const { chooseSender, pinnedSenderId } = require('./gmail-sender-routing');

const HUMAN_TYPES = new Set(['positive_reply','negative_reply','unsubscribe_reply','needs_human_reply','human_response_sent','meeting_requested']);
function simulateRouting({ leads = [], activities = [], suppressedEmails = new Set(), senders = [], sendsToday = new Map() } = {}) {
  const report = { eligibleDentalCandidates:0, assigned:{}, existingPinned:{}, senderThreadConflicts:0,
    suppressedCandidates:0, humanOwnedCandidates:0, ambiguousCandidates:0, unsafeSenderCandidates:0 };
  for (const sender of senders) { report.assigned[sender.id]=0; report.existingPinned[sender.id]=0; }
  const ordered=[...leads].sort((a,b)=>Number(b.emailStep||0)-Number(a.emailStep||0)||String(a.id||'').localeCompare(String(b.id||'')));
  for (const lead of ordered) {
    const niche=String(lead.leadNiche||lead.tradeType||'').toLowerCase(); if(!niche.includes('dent')) continue;
    const email=String(lead.email||'').trim().toLowerCase();
    if(suppressedEmails.has(email)||/\[(?:UNSUBSCRIBED|SUPPRESSED|BOUNCED)/i.test(String(lead.notes||''))){report.suppressedCandidates++;continue;}
    const mine=activities.filter(r=>String(r.sourceLeadId||'')===String(lead.id)||String(r.leadId||'')===`CE-${lead.id}`);
    if(mine.some(r=>HUMAN_TYPES.has(String(r.eventType||'')))){report.humanOwnedCandidates++;continue;}
    let pinned=''; try{pinned=pinnedSenderId(lead,mine);}catch(_){report.senderThreadConflicts++;report.ambiguousCandidates++;continue;}
    if(pinned) report.existingPinned[pinned]=(report.existingPinned[pinned]||0)+1;
    const step=Number(lead.emailStep||0)>0?Number(lead.emailStep)+1:1;
    if(step===1 && !(String(lead.stage||'')==='Queued' && !String(lead.emailStatus || ''))) continue;
    if(step>1 && String(lead.emailStatus||'')!=='emailed') continue;
    report.eligibleDentalCandidates++;
    try{
      const choice=chooseSender({lead,activities:mine,senders,sendsToday,step});
      if(!choice.sender){report.unsafeSenderCandidates++;continue;}
      report.assigned[choice.sender.id]=(report.assigned[choice.sender.id]||0)+1;
      sendsToday.set(choice.sender.id,(sendsToday.get(choice.sender.id)||0)+1);
    }catch(_){report.unsafeSenderCandidates++;}
  }
  return report;
}
module.exports={simulateRouting};
