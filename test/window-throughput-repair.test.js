'use strict';

/**
 * The three throughput defects observed in production on 2026-09-22, when ten
 * windows that could physically deliver 100 sends delivered 63.
 *
 * Every gate these tests exercise is the production one. Nothing here relaxes
 * a safety rule: the point is that capacity is reached WITH the gates, not by
 * stepping around them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { observerFollowUpVerdict, observerIsFresh } = require('../integrations/gmail-followup-safety');
const { observerHealth } = require('../integrations/gmail-observer-health');
const { configuredSenders, chooseSender } = require('../integrations/gmail-sender-routing');
const {
  createSendingWindowQuota, consumeSendingWindowSuccess, sendingWindowRemainingBySender,
} = require('../integrations/sending-window-quota');
const { sendSuppressionReason } = require('../integrations/pipeline-state');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');

const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');

const env = {
  FROM_EMAIL: 'primary@example.com', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([{
    id: 'second', email: 'second@example.com', status: 'active',
    tokenEnv: 'GMAIL_SECOND_TOKEN_JSON', dailyLimit: 50, perRunLimit: 5,
  }]),
  GMAIL_SECOND_TOKEN_JSON: '{}',
};
const SENDERS = configuredSenders(env);
const followUpLead = { id: 'F1', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed', lastEmailedAt: '2026-09-01T10:00:00Z' };

// ── 1. Gmail freshness: one source of truth for the owning mailbox ─────────

test('genuinely fresh observer state lets an automated follow-up through', () => {
  const verdict = observerFollowUpVerdict({
    lead: followUpLead, senderResolved: true,
    observer: { health: 'healthy', checkpointAgeMinutes: 14 },
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, 'observer_healthy');
});

test('genuinely stale observer state blocks the follow-up', () => {
  const verdict = observerFollowUpVerdict({
    lead: followUpLead, senderResolved: true,
    observer: { health: 'healthy', checkpointAgeMinutes: 46 },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'observer_stale_followup');
  assert.equal(verdict.blockedFollowUp, true);
});

test('unhealthy observer state blocks the follow-up', () => {
  for (const health of ['unavailable', 'backoff', 'recovering']) {
    const verdict = observerFollowUpVerdict({
      lead: followUpLead, senderResolved: true,
      observer: { health, checkpointAgeMinutes: 1 },
    });
    assert.equal(verdict.allowed, false, `${health} must not send`);
  }
});

test('an untrustworthy mailbox row reads as unhealthy through the endpoint\'s own function and blocks', () => {
  // Exactly the row shape the read-only endpoint parses: a mailbox that has
  // not reached a trustworthy observation point reports status !== 'healthy'.
  const rows = [['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'status'],
    ['primary', '900', new Date().toISOString(), new Date().toISOString(), 'incomplete slice', 'unhealthy_incomplete']];
  const [observer] = observerHealth(rows, { senderIds: ['primary'] });
  assert.notEqual(observer.health, 'healthy');
  assert.equal(observerIsFresh(observer), false);
  assert.equal(observerFollowUpVerdict({ lead: followUpLead, observer, senderResolved: true }).allowed, false);
});

test('an unresolved owning mailbox fails closed, and does not blame Gmail freshness', () => {
  const verdict = observerFollowUpVerdict({
    lead: followUpLead, senderResolved: false,
    observer: { health: 'unavailable', checkpointAgeMinutes: null },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'owning_sender_unresolved');
  // The production log said "older than 45 minutes" while both observers were
  // healthy and 14 minutes old. That sentence must not appear for this cause.
  assert.doesNotMatch(verdict.reason, /older than \d+ minutes/);
  assert.match(verdict.reason, /owning mailbox/);
});

test('a first touch is still allowed when no mailbox is resolved yet', () => {
  // A queued lead has no sender until the router picks one; first-touch safety
  // never depended on reply detection. This is unchanged behaviour.
  const verdict = observerFollowUpVerdict({
    lead: { id: 'Q1', emailStep: '', emailStatus: '', lastEmailedAt: '' },
    senderResolved: false, observer: { health: 'unavailable', checkpointAgeMinutes: null },
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.kind, 'first_touch');
});

test('the send gate resolves the owning mailbox from delivered evidence, not the lead column alone', () => {
  const gate = agentSrc.slice(agentSrc.indexOf('function coldSendGate'), agentSrc.indexOf('const leadId = String(lead.id'));
  assert.match(gate, /pinnedSenderId\(lead,/);
  assert.match(gate, /senderResolved: Boolean\(senderId\)/);
  // The lead column remains the fallback, never the only source.
  assert.match(gate, /\|\|\s*String\(lead\.senderInboxId \|\| ''\)\.trim\(\)/);
});

test('the scheduled pass evaluates observer state after this cycle observed the mailboxes', () => {
  // Freshness must come from the observation this run just committed, never a
  // snapshot taken before it. Ordering in the source is the guarantee.
  const commit = agentSrc.indexOf('await commitMailboxObservationCheckpoints(replyObservation)');
  const context = agentSrc.indexOf('const ownershipContext = buildOwnershipContext(');
  assert.ok(commit > 0 && context > commit, 'ownership context must be built after the observation checkpoint');
});

// ── 2. Permanently invalid candidates must not be re-decided every window ──

test('a validation-failed step-1 lead is parked out of queued selection after its draft exists', () => {
  const loop = agentSrc.slice(agentSrc.indexOf('// ── New sends (step 1)'), agentSrc.indexOf('\nDone.'));
  const invalidBlock = loop.slice(loop.indexOf('if (invalid) {'));
  // It still must not send, and it must still produce a reviewable draft.
  assert.match(invalidBlock, /queueDraft\(lead, \{/);
  assert.match(invalidBlock, /markColdStepDrafted\(lead, invalid\)/);
  // …and it still falls through to the next candidate rather than ending the run.
  assert.match(invalidBlock.slice(0, invalidBlock.indexOf('}\n')), /continue;|markColdStepDrafted/);
});

test('parking writes a non-empty emailStatus, which is exactly what queued selection refuses', () => {
  const marker = agentSrc.slice(agentSrc.indexOf('const COLD_DRAFT_STATUS'), agentSrc.indexOf('async function markColdStepDrafted') + 1200);
  assert.match(marker, /COLD_DRAFT_STATUS = 'draft'/);
  assert.match(marker, /applyLeadChange\(lead\.id, \{ emailStatus: COLD_DRAFT_STATUS \}/);
  // Same-cycle: later selectors in this pass must not pick it up again.
  assert.match(marker, /lead\.emailStatus = COLD_DRAFT_STATUS/);
  const selector = agentSrc.slice(agentSrc.indexOf('function selectQueued'), agentSrc.indexOf('function selectFollowUps'));
  assert.match(selector, /if \(l\.emailStatus !== ''\) return false;/);
});

test('parking never deletes, suppresses or terminally closes the lead', () => {
  const fn = agentSrc.slice(agentSrc.indexOf('async function markColdStepDrafted'), agentSrc.indexOf('async function markColdStepDrafted') + 1200);
  assert.doesNotMatch(fn, /stage:/);
  assert.doesNotMatch(fn, /Suppression|suppress/i);
  assert.doesNotMatch(fn, /deleteRow|clearLead/);
});

test('a failed park never converts into a send', () => {
  const fn = agentSrc.slice(agentSrc.indexOf('async function markColdStepDrafted'), agentSrc.indexOf('async function markColdStepDrafted') + 1200);
  assert.match(fn, /catch \(error\)/);
  assert.doesNotMatch(fn, /sendEmail|deliverOrdinaryColdStep/);
});

// ── 3. Sender pinning vs. safe spillover ──────────────────────────────────

const staffingQueued = {
  id: 'S1', leadNiche: 'industrial_staffing', senderInboxId: 'primary',
  emailStep: '', emailStatus: '', lastEmailedAt: '', emailTemplateId: 'staffing-v1',
};
const fullPrimaryWindow = new Map([['primary', 0], ['second', 5]]);

test('an operator-assigned inbox is binding even when the other inbox is idle', () => {
  // The routing contract, asserted here so this repair cannot erode it: an
  // explicit assignment does NOT fall back to a mailbox with spare capacity,
  // for staffing or dental, contacted or not. Rebalancing belongs in the queue
  // assignment, not in the send-time allocator.
  const result = chooseSender({
    lead: staffingQueued, senders: SENDERS, sendsToday: new Map([['primary', 5], ['second', 0]]),
    windowRemainingBySender: fullPrimaryWindow, step: 1,
  });
  assert.equal(result.sender, null);
  assert.match(result.reason, /scheduled-window limit reached/);
});

test('an exhausted daily cap on the assigned inbox also refuses to fall back', () => {
  const result = chooseSender({
    lead: staffingQueued, senders: SENDERS, sendsToday: new Map([['primary', 50], ['second', 0]]),
    windowRemainingBySender: new Map([['primary', 5], ['second', 5]]), step: 1,
  });
  assert.equal(result.sender, null);
  assert.match(result.reason, /daily limit reached/);
});

test('proven sender evidence still pins follow-ups to their original mailbox', () => {
  const activities = [{
    eventType: 'initial_email_sent', sourceLeadId: 'F9', occurredAt: '2026-09-01T10:00:00Z',
    metadata: JSON.stringify({ senderInboxId: 'primary' }),
  }];
  const lead = { id: 'F9', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed', senderInboxId: 'primary' };
  const result = chooseSender({
    lead, activities, senders: SENDERS, sendsToday: new Map([['primary', 5], ['second', 0]]),
    windowRemainingBySender: fullPrimaryWindow, step: 2,
  });
  assert.equal(result.sender, null, 'a full owning mailbox defers; it never hands the thread to another inbox');
  assert.equal(result.pinned, true);
});

test('an UNASSIGNED lead still routes dynamically to the inbox with capacity', () => {
  // This is the only supply that can reach an idle mailbox at send time, which
  // is why the queue's assignment mix decides whether 100/day is reachable.
  const result = chooseSender({
    lead: { id: 'U1', tradeType: 'Dental', senderInboxId: '', emailStep: '', emailStatus: '', lastEmailedAt: '' },
    senders: SENDERS, sendsToday: new Map([['primary', 5], ['second', 0]]),
    windowRemainingBySender: fullPrimaryWindow, step: 1,
  });
  assert.equal(result.sender.id, 'second');
});

// ── Capacity / fairness acceptance ────────────────────────────────────────

test('a full window reaches 5 + 5 = 10 with every production gate live', () => {
  const quota = createSendingWindowQuota({ senderIds: ['primary', 'second'], perSenderLimit: 5, globalLimit: 10 });
  const sendsToday = new Map([['primary', 0], ['second', 0]]);
  const observers = new Map([
    ['primary', { health: 'healthy', checkpointAgeMinutes: 14 }],
    ['second', { health: 'healthy', checkpointAgeMinutes: 14 }],
  ]);
  const activities = [];
  const reserved = new Set();      // stands in for the durable reservation store
  const sent = [];
  const refused = [];

  // A queue whose ASSIGNMENT MIX matches the capacity on offer: staffing for
  // primary, dental for the second mailbox, four permanently invalid dental
  // leads in the middle, one suppressed lead and one on manual hold.
  // Production on 2026-09-22 had 684 of 702 queued leads assigned to primary
  // and 5 to the second inbox, which is why its second mailbox idled.
  const queue = [
    { id: 'SUP', email: 'sup@x.com', tradeType: 'Dental', notes: '[REPLY: Unsubscribed]', emailStep: '', emailStatus: '', lastEmailedAt: '', valid: true },
    { id: 'HOLD', email: 'hold@x.com', tradeType: 'Dental', notes: '[MANUAL HOLD]', emailStep: '', emailStatus: '', lastEmailedAt: '', valid: true },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `ST${i}`, email: `st${i}@x.com`, leadNiche: 'industrial_staffing', senderInboxId: 'primary',
      emailStep: '', emailStatus: '', lastEmailedAt: '', valid: true,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `BAD${i}`, email: `bad${i}@x.com`, tradeType: 'Dental', senderInboxId: 'second',
      emailStep: '', emailStatus: '', lastEmailedAt: '', valid: false,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `DN${i}`, email: `dn${i}@x.com`, tradeType: 'Dental', senderInboxId: 'second',
      emailStep: '', emailStatus: '', lastEmailedAt: '', valid: true,
    })),
  ];
  // One follow-up whose thread belongs to a mailbox that is already full.
  const followUps = [{
    lead: { id: 'FU1', email: 'fu1@x.com', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed', senderInboxId: 'primary' },
    activities: [{ eventType: 'initial_email_sent', sourceLeadId: 'FU1', occurredAt: '2026-09-01T10:00:00Z', metadata: JSON.stringify({ senderInboxId: 'primary' }) }],
  }];

  const attempt = (lead, leadActivities, step) => {
    const suppressed = sendSuppressionReason(lead);
    if (suppressed) { refused.push([lead.id, 'suppressed']); return; }
    const resolved = String(lead.senderInboxId || '').trim();
    const gate = observerFollowUpVerdict({
      lead, senderResolved: Boolean(resolved) || step === 1,
      observer: observers.get(resolved) || { health: 'unavailable', checkpointAgeMinutes: null },
    });
    if (!gate.allowed) { refused.push([lead.id, gate.code]); return; }
    let choice;
    try {
      choice = chooseSender({
        lead, activities: leadActivities, senders: SENDERS, sendsToday,
        windowRemainingBySender: sendingWindowRemainingBySender(quota), step,
      });
    } catch (error) { refused.push([lead.id, error.message]); return; }
    if (!choice.sender) { refused.push([lead.id, choice.reason]); return; }
    if (!lead.valid && step === 1) { refused.push([lead.id, 'failed_validation']); return; }
    const actionId = ordinaryColdActionId(lead.id, step);
    if (reserved.has(actionId)) { refused.push([lead.id, 'duplicate']); return; }
    reserved.add(actionId);
    consumeSendingWindowSuccess(quota, choice.sender.id);
    sendsToday.set(choice.sender.id, (sendsToday.get(choice.sender.id) || 0) + 1);
    sent.push([lead.id, choice.sender.id]);
  };

  for (const item of followUps) attempt(item.lead, item.activities, 2);
  for (const lead of queue) {
    if (quota.globalSuccesses >= quota.globalLimit) break;
    attempt(lead, activities, 1);
  }

  // 1 + 2. Neither bucket may be exceeded, and the window fills.
  assert.equal(quota.successesBySender.get('primary'), 5);
  assert.equal(quota.successesBySender.get('second'), 5);
  assert.equal(quota.globalSuccesses, 10);
  // 3. Nothing invalid was sent.
  assert.equal(sent.some(([id]) => id.startsWith('BAD')), false);
  // 4. The allocator kept going past the invalid leads to later valid ones.
  assert.ok(sent.some(([id]) => id.startsWith('DN')), 'valid dental leads after the invalid block must still send');
  // 5. The second mailbox filled its own five from supply assigned to it.
  assert.equal(sent.filter(([, s]) => s === 'second').length, 5);
  // No lead crossed mailboxes: every send came from the inbox it was routed to.
  assert.equal(sent.some(([id, s]) => id.startsWith('ST') && s !== 'primary'), false);
  assert.equal(sent.some(([id, s]) => id.startsWith('DN') && s !== 'second'), false);
  // 6. Thread affinity: the follow-up went out from the mailbox that owns its
  // thread, and could never have been served by the other one.
  assert.deepEqual(sent.find(([id]) => id === 'FU1'), ['FU1', 'primary']);
  assert.equal(sent.some(([id, s]) => id === 'FU1' && s === 'second'), false);
  // 9. Suppression and manual hold still win.
  assert.ok(refused.some(([id, reason]) => id === 'SUP' && reason === 'suppressed'));
  assert.ok(refused.some(([id, reason]) => id === 'HOLD' && reason === 'suppressed'));
  // 10. One reservation per action id; no duplicates.
  assert.equal(reserved.size, sent.length);
  assert.equal(new Set(sent.map(([id]) => id)).size, sent.length);
});

test('a stale mailbox still blocks its follow-ups while fresh mailboxes keep sending', () => {
  const quota = createSendingWindowQuota({ senderIds: ['primary', 'second'], perSenderLimit: 5, globalLimit: 10 });
  const observers = new Map([
    ['primary', { health: 'healthy', checkpointAgeMinutes: 200 }],   // genuinely stale
    ['second', { health: 'healthy', checkpointAgeMinutes: 3 }],
  ]);
  const staleFollowUp = { id: 'P1', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed', senderInboxId: 'primary' };
  const freshFollowUp = { id: 'P2', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed', senderInboxId: 'second' };
  assert.equal(observerFollowUpVerdict({ lead: staleFollowUp, observer: observers.get('primary'), senderResolved: true }).allowed, false);
  assert.equal(observerFollowUpVerdict({ lead: freshFollowUp, observer: observers.get('second'), senderResolved: true }).allowed, true);
  assert.equal(quota.globalSuccesses, 0);
});

test('daily ceilings still bound the day at 50 + 50 and 100 combined', () => {
  const [primary, second] = SENDERS;
  assert.equal(primary.dailyLimit, 50);
  assert.equal(second.dailyLimit, 50);
  // Ten windows of five per mailbox is exactly the daily limit, and the daily
  // counter refuses the eleventh regardless of any window bucket.
  assert.equal(10 * 5, primary.dailyLimit);
  const exhausted = chooseSender({
    lead: { id: 'X', tradeType: 'Dental', senderInboxId: '', emailStep: '', emailStatus: '', lastEmailedAt: '' },
    senders: SENDERS, sendsToday: new Map([['primary', 50], ['second', 50]]),
    windowRemainingBySender: new Map([['primary', 5], ['second', 5]]), step: 1,
  });
  assert.equal(exhausted.sender, null);
});
