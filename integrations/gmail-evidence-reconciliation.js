'use strict';
const crypto = require('node:crypto');
const { headerValue, parseAddr, firstPlainText, providerRead } = require('./gmail-mailbox-observer');
const { senderEvidence } = require('./gmail-sender-routing');
const { resolveSequenceThread } = require('./stage-sequences');
const { planOutboundActivity } = require('./human-outbound');
const norm = v => String(v || '').trim().toLowerCase();
const addresses = v => String(v || '').split(',').map(parseAddr);

/**
 * Sender ownership is derived from which mailboxes CLAIM an outbound message,
 * so the answer is only as trustworthy as the set of mailboxes actually asked.
 *
 * The failure this prevents: true evidence is primary AND secondary, but only
 * primary is authenticated, so claimants = ['primary'] and a genuine CONFLICT
 * is written to canonical state as PROVEN PRIMARY. Partial provider visibility
 * does not degrade this gracefully — it manufactures a false proof.
 *
 * So coverage is a precondition, not a caller's good intention: every active
 * sending inbox the registry expects must be present and authenticated, and no
 * unexpected mailbox may be smuggled in.
 */
function assertMailboxCoverage(mailboxes, expectedMailboxIds) {
  const expected = [...new Set((expectedMailboxIds || []).map(id => String(id).trim()).filter(Boolean))];
  if (!expected.length) throw new Error('Evidence reconciliation requires the expected sending-mailbox set; refusing to prove from an unknown roster');
  const supplied = new Set((mailboxes || []).map(mailbox => String(mailbox && mailbox.id || '').trim()).filter(Boolean));
  const missing = expected.filter(id => !supplied.has(id));
  if (missing.length) {
    throw new Error(`Evidence reconciliation requires every active sending mailbox; missing ${missing.join(', ')}. Proving sender ownership from partial provider visibility can turn a CONFLICT into a false PROVEN result`);
  }
  const unexpected = [...supplied].filter(id => !expected.includes(id));
  if (unexpected.length) throw new Error(`Unexpected mailbox supplied to evidence reconciliation: ${unexpected.join(', ')}`);
}

async function proveLegacyEvidence({ lead, board, activities, mailboxes, expectedMailboxIds, now = new Date() }) {
  if (!lead?.id || !/^\S+@\S+\.\S+$/.test(lead.email || '')) throw new Error('Exact canonical lead identity required');
  assertMailboxCoverage(mailboxes, expectedMailboxIds);
  const proof = [];
  for (const mailbox of mailboxes) {
    const profile = await providerRead('users.getProfile', {userId:'me'}, p => mailbox.gmail.users.getProfile(p));
    if (norm(profile.data.emailAddress) !== norm(mailbox.email)) throw new Error(`Mailbox identity mismatch for ${mailbox.id}`);
    let pageToken; let pages=0;
    do {
      const response = await providerRead('users.messages.list', {userId:'me',q:`in:sent to:${lead.email}`,
        includeSpamTrash:true,maxResults:500,pageToken}, p => mailbox.gmail.users.messages.list(p));
      for (const stub of response.data.messages || []) {
        const response = await providerRead('users.messages.get',{userId:'me',id:stub.id,format:'full'},p=>mailbox.gmail.users.messages.get(p));
        const m=response.data;
        if (!(m.labelIds || []).includes('SENT') || parseAddr(headerValue(m.payload,'From')) !== norm(mailbox.email)
          || !addresses(headerValue(m.payload,'To')).includes(norm(lead.email))) continue;
        const at=Number(m.internalDate);const rfcMessageId=headerValue(m.payload,'Message-ID');
        if (!Number.isFinite(at) || !rfcMessageId || !m.threadId) throw new Error('Incomplete provider proof');
        proof.push({senderInboxId:mailbox.id,senderEmail:mailbox.email,email:lead.email,id:m.id,threadId:m.threadId,
          rfcMessageId,occurredAt:new Date(at).toISOString(),subject:headerValue(m.payload,'Subject'),body:firstPlainText(m.payload).slice(0,1500)});
      }
      pageToken=response.data.nextPageToken;pages++;
    }while(pageToken && pages<10);
    if(pageToken)throw new Error('Legacy proof listing truncated; no repair permitted');
  }
  proof.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const claimants=[...new Set(proof.map(p=>p.senderInboxId))];
  const before={leadId:lead.id,boardId:board?.id || null,company:lead.company,email:lead.email,
    sender:senderEvidence(lead,activities),persistedSender:lead.senderInboxId || '',
    thread:resolveSequenceThread(activities)?.threadId || '',stage:board?.stage,notes:lead.notes || '',
    outcome:board?.outcome,meetingAt:board?.meetingAt};
  const base={before,proof,claimants,events:[],writes:[],repairable:false};
  if(claimants.length!==1)return {...base,reason:claimants.length?'CONFLICT — multiple sender claimants':'UNKNOWN — no exact outbound provider evidence'};
  const senderInboxId=claimants[0];
  if(before.sender.some(id=>id!==senderInboxId))return {...base,reason:'CONFLICT — canonical sender disagrees with provider'};
  const threads=[...new Set(proof.map(p=>p.threadId))];
  // Sender proof can be unique even when thread proof is ambiguous.
  const threadId=threads.length===1?threads[0]:null;
  const exact=proof.at(-1);
  const eventId=`gmail-sender-evidence:${senderInboxId}:${lead.id}:${exact.id}`;
  const events=[];
  if(!activities.some(row=>row.eventId===eventId))events.push({eventId,leadId:board?.id || `CE-${lead.id}`,
    sourceLeadId:lead.id,email:lead.email,company:lead.company,eventType:'sender_evidence_reconciled',
    occurredAt:exact.occurredAt,subject:exact.subject,content:'',metadata:JSON.stringify({provider:'gmail',senderInboxId,
      gmailMessageId:exact.id,providerMessageId:exact.id,gmailThreadId:threadId || '',rfcMessageId:exact.rfcMessageId,
      reconciledAt:new Date(now).toISOString(),reconciliationOnly:true,autoSendAllowed:false,
      exactRecipient:lead.email,verifiedSenderEmail:exact.senderEmail,uniqueSenderClaimants:claimants,
      candidateThreadIds:threads,threadProof:threadId?'unique_exact_outreach_conversation':'ambiguous'})});
  const manualProof=[];
  if(threadId){
    const mailbox=mailboxes.find(m=>m.id===senderInboxId);
    const thread=(await providerRead('users.threads.get',{userId:'me',id:threadId,format:'full'},p=>mailbox.gmail.users.threads.get(p))).data;
    for(const outbound of proof){
      const priorInbound=(thread.messages||[]).some(m=>parseAddr(headerValue(m.payload,'From'))===norm(lead.email)
        && Number(m.internalDate)<Date.parse(outbound.occurredAt));
      if(!priorInbound)continue;
      const planned=planOutboundActivity({id:outbound.id,threadId,to:[lead.email],subject:outbound.subject,sentAt:outbound.occurredAt},{
        leadsByEmail:new Map([[norm(lead.email),lead]]),existingActivitiesByLead:new Map([[lead.id,activities]]),threadsWithInbound:new Set([threadId])});
      manualProof.push({...outbound,outcome:planned.outcome});
      if(planned.activity)events.push({...planned.activity,metadata:JSON.stringify({...planned.activity.metadata,senderInboxId,
        rfcMessageId:outbound.rfcMessageId,reconciledAt:new Date(now).toISOString(),reconciliationOnly:true})});
    }
  }
  const manifest={before,provider:proof.map(({body,...p})=>p),threadId,activities:activities.map(r=>r.eventId).sort()};
  const proofHash=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return {...base,repairable:true,senderInboxId,threadId,threadReason:threadId?'unique exact thread':`${threads.length} competing threads; none selected`,
    manualProof,events,proofHash,writes:[...(!lead.senderInboxId?[{field:'senderInboxId',value:senderInboxId}]:[]),
      ...events.map(event=>({eventId:event.eventId,eventType:event.eventType,metadata:JSON.parse(event.metadata)}))]};
}

async function applyProvenEvidence({plan,approvedHash,appendEvent,writeSender,readback}){
  if(!plan.repairable || plan.proofHash!==approvedHash)throw new Error('Evidence proof changed or is not deterministic; no repair permitted');
  for(const event of plan.events)await appendEvent(event);
  if(!plan.before.persistedSender)await writeSender(plan.senderInboxId);
  const saved=await readback();
  if(saved.senderInboxId!==plan.senderInboxId || plan.events.some(event=>!saved.activities.some(row=>row.eventId===event.eventId && row.metadata===event.metadata)))throw new Error('Evidence reconciliation readback mismatch; fail closed');
  return {ok:true,senderInboxId:saved.senderInboxId,threadId:plan.threadId,eventsWritten:plan.events.map(e=>e.eventId)};
}
module.exports={proveLegacyEvidence,applyProvenEvidence,assertMailboxCoverage};
