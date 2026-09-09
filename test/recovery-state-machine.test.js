'use strict';

// Bounded, durable, incremental mailbox recovery.
//
// THE LIVELOCK THIS ENDS
//
// The primary observer had a ~45-hour backlog. Catch-up tried to drain all of
// it in one pass; draining it needs more users.messages.get calls than Gmail's
// per-user-per-minute cost budget allows; the pass threw on 403; checkpoint
// correctness required the WHOLE catch-up to finish before advancing, so
// nothing was banked; the next scheduled pass started from the same stale point
// and repeated the identical oversized workload. Forever.
//
// THE CONTRACT NOW ASSERTED
//
// A slice may advance the high-water only across ids it actually resolved —
// fetched, or explicitly recorded as an observation gap. Reprocessing is
// acceptable; skipping is not. Progress is banked only after the canonical
// events commit, and a mailbox mid-recovery is never treated as trustworthy.
//
// Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { observeMailbox, byIdAscending, RECOVERY_READ_BUDGET } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));

const SENDER = 'sender@example.com';
const NOW = new Date('2026-09-09T08:00:00Z');
const LAST = '2026-09-07T09:09:00Z';   // the real 45-hour-stale checkpoint

const lead = {
  id: 'l1', email: 'prospect@example.com', company: 'Clinic', emailStatus: 'emailed',
  emailStep: '1', senderInboxId: 'primary', lastEmailedAt: '2026-09-01T00:00:00Z', notes: '',
};

// Gmail ids are hex and ascend with time; pad so ordering is unambiguous.
const idAt = n => `1a${String(n).padStart(6, '0')}`;
const message = (id, from, text, at = '2026-09-08T12:00:00Z') => ({
  id, threadId: 't-' + id, internalDate: String(Date.parse(at)), labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'To', value: SENDER },
    { name: 'Subject', value: 'Re: demo' }, { name: 'Message-ID', value: `<${id}@t>` }],
  body: { data: Buffer.from(text).toString('base64url') } },
});
const gone = () => Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
const quota = () => Object.assign(new Error(
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),
{ response: { status: 403 } });

// A mailbox with `count` backlog messages. `failOn` throws for a given id.
function mailbox(messages, { failOn = null, error = quota, anchor = '900' } = {}) {
  const reads = [];
  const gmail = { users: {
    getProfile: async () => ({ data: { historyId: anchor, emailAddress: SENDER } }),
    history: { list: async p => {
      if (p.startHistoryId === 'STALE') throw gone();
      return { data: { historyId: anchor, history: [] } };
    } },
    messages: {
      list: async () => ({ data: { messages: messages.map(m => ({ id: m.id, threadId: m.threadId })) } }),
      get: async p => {
        reads.push(p.id);
        if (failOn && p.id === failOn) throw error();
        const found = messages.find(m => m.id === p.id);
        if (!found) throw gone();
        return { data: found };
      },
    },
    threads: { get: async () => { throw gone(); } },
  } };
  return { gmail, reads };
}
const base = gmail => ({
  gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER,
  historyId: 'STALE', lastSuccessfulObservationAt: LAST, now: NOW,
});

// ── A. A large backlog drains across passes ─────────────────────────────────

test('A. a 1000-message backlog drains over bounded passes without duplicates', async () => {
  const backlog = Array.from({ length: 1000 }, (_, i) => message(idAt(i), lead.email, `msg ${i}`));
  const budget = 120;

  let recovery = null;
  let passes = 0;
  let totalRead = 0;
  const seenEventIds = new Set();
  let duplicates = 0;
  const activities = [];

  while (passes < 30) {
    const { gmail, reads } = mailbox(backlog);
    const observed = await observeMailbox({ ...base(gmail), recovery, readBudget: budget });
    passes++;
    totalRead += reads.length;
    assert.ok(reads.length <= budget, `pass ${passes} spent ${reads.length} reads, over budget`);

    const plan = await planMailboxEvents({ ...base(gmail), observation: observed, activities });
    for (const event of plan.events) {
      if (seenEventIds.has(event.eventId)) duplicates++;
      seenEventIds.add(event.eventId);
      activities.push(event);
    }
    if (!observed.recovery || observed.recovery.complete) break;
    // The high-water is what the next pass resumes strictly above.
    recovery = { active: true, since: observed.recovery.since, anchor: observed.recovery.anchor,
      processedThroughId: observed.recovery.processedThroughId, processed: observed.recovery.processed };
    assert.equal(observed.trustworthy, false, 'a mailbox mid-recovery is never trustworthy');
  }

  assert.ok(passes > 1, 'a 1000-message backlog must take more than one pass');
  assert.equal(duplicates, 0, 'no canonical event is written twice');
  assert.ok(totalRead >= 1000, `every backlog message was read (${totalRead})`);
  // And it finished: the last pass reported completion and became trustworthy.
  const { gmail } = mailbox(backlog);
  const final = await observeMailbox({ ...base(gmail), recovery, readBudget: budget });
  assert.equal(final.recovery ? final.recovery.complete : true, true);
  assert.equal(final.trustworthy, true);
});

// ── B. Quota mid-slice keeps proven progress ────────────────────────────────

test('B. a 403 mid-slice retains earlier proven progress and skips nothing', async () => {
  const backlog = Array.from({ length: 10 }, (_, i) => message(idAt(i), lead.email, `m${i}`));
  const ordered = backlog.map(m => m.id).sort(byIdAscending);
  // Fail on the 5th id, so four are genuinely proven first.
  const { gmail, reads } = mailbox(backlog, { failOn: ordered[4] });
  const observed = await observeMailbox({ ...base(gmail), readBudget: 10, sleep: async () => {} });

  assert.ok(observed.recovery, 'recovery is active');
  assert.equal(observed.recovery.complete, false, 'a quota stop is not completion');
  assert.ok(observed.recovery.backoff, 'the backoff is recorded');
  assert.equal(observed.recovery.backoff.reason, 'gmail_quota');
  assert.equal(observed.trustworthy, false);
  // The high-water sits on the last PROVEN id, never on the failed one.
  assert.equal(observed.recovery.processedThroughId, ordered[3]);
  assert.equal(observed.messages.length, 4);
  // It stopped issuing reads rather than grinding through the rest. The failing
  // id costs four attempts (the bounded quota retry) before the pass gives up,
  // so four proven reads plus four retries — and nothing beyond that.
  assert.equal(reads.length, 8, `stopped promptly, spent ${reads.length}`);
  assert.ok(!reads.includes(ordered[5]), 'no read was issued past the quota stop');

  // Resuming re-reads the failed id — reprocessing is acceptable, skipping is not.
  const second = mailbox(backlog);
  const resumed = await observeMailbox({ ...base(second.gmail), readBudget: 10, sleep: async () => {},
    recovery: { active: true, since: observed.recovery.since, anchor: observed.recovery.anchor,
      processedThroughId: observed.recovery.processedThroughId, processed: observed.recovery.processed } });
  assert.ok(second.reads.includes(ordered[4]), 'the id that failed is retried, not skipped');
  assert.equal(resumed.recovery.complete, true);
  assert.equal(resumed.trustworthy, true);
});

// ── C/D. Crash safety on either side of the checkpoint ──────────────────────

test('C. a crash after canonical write but before the checkpoint reprocesses idempotently', async () => {
  const backlog = [message(idAt(1), lead.email, 'Interested')];
  const { gmail } = mailbox(backlog);
  const observed = await observeMailbox({ ...base(gmail), readBudget: 5 });
  const plan = await planMailboxEvents({ ...base(gmail), observation: observed });
  assert.ok(plan.events.length > 0);

  // Events landed; the checkpoint did not. The next pass starts from the OLD
  // recovery point and sees the same message again.
  const retry = mailbox(backlog);
  const again = await observeMailbox({ ...base(retry.gmail), readBudget: 5, recovery: null });
  const replanned = await planMailboxEvents({ ...base(retry.gmail), observation: again, activities: plan.events });
  assert.equal(replanned.events.length, 0, 're-observation writes nothing new');
});

test('D. a crash after the checkpoint resumes strictly above the high-water', async () => {
  const backlog = Array.from({ length: 6 }, (_, i) => message(idAt(i), lead.email, `m${i}`));
  const ordered = backlog.map(m => m.id).sort(byIdAscending);
  const { gmail, reads } = mailbox(backlog);
  await observeMailbox({ ...base(gmail), readBudget: 6,
    recovery: { active: true, since: LAST, anchor: '900', processedThroughId: ordered[2], processed: 3 } });
  // The first three are below the high-water and are not re-read.
  for (const id of ordered.slice(0, 3)) assert.ok(!reads.includes(id), `${id} was re-read below the high-water`);
  for (const id of ordered.slice(3)) assert.ok(reads.includes(id), `${id} above the high-water was skipped`);
});

// ── E/F. Missing resources and true cursor expiry ───────────────────────────

test('E. a missing message becomes a gap event and recovery continues', async () => {
  const backlog = [message(idAt(1), lead.email, 'Interested'), message(idAt(2), lead.email, 'How much?')];
  const { gmail } = mailbox(backlog, { failOn: idAt(1), error: gone });
  const observed = await observeMailbox({ ...base(gmail), readBudget: 10 });
  assert.equal(observed.unavailable.length, 1);
  assert.equal(observed.unavailable[0].status, 404);
  assert.equal(observed.messages.length, 1, 'the other message still processed');
  // A resolved gap advances the high-water, which is what stops it being
  // retried forever — the original outage.
  assert.equal(observed.recovery.processedThroughId, idAt(2));
  assert.equal(observed.recovery.complete, true);
  const plan = await planMailboxEvents({ ...base(gmail), observation: observed });
  const gap = plan.events.find(event => event.eventType === 'gmail_observation_gap');
  assert.ok(gap, 'a deterministic gap event is written');
  assert.equal(JSON.parse(gap.metadata).requiresHumanAttention, true);
});

test('F. an invalid History cursor starts a bounded catch-up, never a jump to head', async () => {
  const backlog = [message(idAt(1), lead.email, 'Interested')];
  const { gmail } = mailbox(backlog);
  const observed = await observeMailbox({ ...base(gmail), readBudget: 10 });
  assert.equal(observed.mode, 'catchup');
  assert.ok(observed.recovery, 'recovery state is established');
  assert.equal(observed.recovery.anchor, '900', 'the head is anchored as a target');
  // It refuses to run at all without a persisted timestamp rather than skipping.
  const bare = mailbox(backlog);
  await assert.rejects(
    () => observeMailbox({ ...base(bare.gmail), lastSuccessfulObservationAt: null, readBudget: 10 }),
    /requires persisted lastSuccessfulObservationAt/);
});

// ── G. No gap at the recovery boundary ──────────────────────────────────────

test('G. a message arriving during catch-up is still observed', async () => {
  const original = message(idAt(1), lead.email, 'Interested');
  const arrived = message(idAt(9), lead.email, 'Send your calendar', '2026-09-09T07:59:00Z');
  // The second message lands while recovery is running; the same query finds it
  // because the catch-up window is a time range, not a fixed id list.
  const { gmail } = mailbox([original, arrived]);
  const observed = await observeMailbox({ ...base(gmail), readBudget: 10 });
  assert.equal(observed.messages.length, 2, 'both the backlog and the new arrival are seen');
  assert.equal(observed.recovery.complete, true);
  assert.equal(observed.trustworthy, true, 'only then does the mailbox become trustworthy');
});

// ── H–M. Isolation and the safety gates that must not move ──────────────────

test('H. one mailbox recovering cannot alter another', () => {
  // State is keyed per senderInboxId, and readiness is a per-sender map.
  assert.match(agentSrc, /observerAutomationReadyBySender\.set\(sender\.id,/);
  assert.match(agentSrc, /failedSenderIds\.add\(sender\.id\)/);
  assert.match(agentSrc, /persistGmailObservationState\(\s*\n?\s*sender\.id,/);
  // Recovery is read per sender, never globally.
  assert.match(agentSrc, /recovery: \(gmailObservationDetailsBySender\.get\(sender\.id\) \|\| \{\}\)\.recovery \|\| null/);
});

test('I. observer recovery has no send capability', () => {
  const observerSrc = readSource(path.join(root, 'integrations', 'gmail-mailbox-observer.js'));
  const plannerSrc = readSource(path.join(root, 'integrations', 'mailbox-observation-events.js'));
  for (const source of [observerSrc, plannerSrc]) {
    for (const forbidden of ['messages.send', 'sendEmail', 'nodemailer', 'drafts.create']) {
      assert.ok(!source.includes(forbidden), `${forbidden} must not appear in observation`);
    }
  }
});

test('J/K/L/M. a recovering mailbox is observation-unavailable for every send gate', () => {
  // The single readiness flag every send path consults is false while the
  // mailbox is untrustworthy — a succeeded slice included.
  assert.match(agentSrc, /observed\.trustworthy !== false/);
  assert.match(agentSrc, /observer_not_incremental/);

  // And the ownership gates are untouched by any of this.
  const { OWNER, BLOCKED_BY, deriveAutomationOwnership, mayColdSend, maySequenceSend, executableOwners } =
    require('../integrations/automation-ownership');
  const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');
  const own = (leadRow, over) => deriveAutomationOwnership(leadRow, {
    boardLead: { stage: 'hot', email: lead.email }, activities: [],
    suppressionReason: row => sendSuppressionReason(row, { suppressedEmails: new Set() }),
    sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true, ...over });

  const held = own({ ...lead, notes: MANUAL_HOLD_TAG },
    { sequenceState: { offer: 'hot_stale_v1', offers: ['hot_stale_v1'], status: 'none' } });
  assert.equal(held.blockedBy, BLOCKED_BY.MANUAL_HOLD);
  assert.equal(executableOwners(held).length, 0);

  const booked = own(lead, { callState: { status: 'scheduled', meetingAt: '2026-10-01T17:00:00Z' } });
  assert.equal(booked.owner, OWNER.MEETING);
  assert.equal(mayColdSend(booked).allowed, false);
  assert.equal(maySequenceSend(booked).allowed, false);

  const suppressed = own({ ...lead, notes: '[REPLY: Unsubscribed]' });
  assert.equal(suppressed.blockedBy, BLOCKED_BY.SUPPRESSION);
  assert.equal(executableOwners(suppressed).length, 0);

  const badIdentity = own({ ...lead, email: 'not-an-address' });
  assert.equal(badIdentity.blockedBy, BLOCKED_BY.INVALID_IDENTITY);
});

test('the read budget is configurable and conservative by default', () => {
  assert.equal(typeof RECOVERY_READ_BUDGET, 'number');
  assert.ok(RECOVERY_READ_BUDGET > 0 && RECOVERY_READ_BUDGET <= 500,
    'a budget must leave quota headroom for the reply and outbound passes');
  const observerSrc = readSource(path.join(root, 'integrations', 'gmail-mailbox-observer.js'));
  assert.match(observerSrc, /GMAIL_RECOVERY_READ_BUDGET/);
  // Bounding applies to recovery only; a healthy incremental pass must not be
  // truncated or steady-state mail would stall behind its own budget.
  assert.match(observerSrc, /const budget = recoveryState \? Math\.max\(1, Number\(readBudget\) \|\| 1\) : queue\.length;/);
});

test('recovery state is durable across a restart', () => {
  // Six fields, persisted in the canonical state sheet.
  for (const field of ['recoveryActive', 'recoverySince', 'recoveryAnchor',
    'recoveryThroughId', 'recoveryProcessed', 'backoffUntil']) {
    assert.ok(agentSrc.includes(`'${field}'`), `${field} must be persisted`);
  }
  assert.match(agentSrc, /GMAIL_OBSERVATION_STATE_SHEET\}!A:O/);
  // A recovery in flight is never written as healthy, and never advances the
  // normal History cursor.
  assert.match(agentSrc, /const recovering = Boolean\(recovery && recovery\.active && !recovery\.complete\)/);
  assert.match(agentSrc, /recovering \? \(recovery\.backoff \? 'backoff' : 'recovering'\) : 'healthy'/);
  assert.match(agentSrc, /state\.recovery && !state\.recovery\.complete\s*\n?\s*\? \(gmailObservationHistoryBySender\.get\(sender\.id\) \|\| ''\)/);
});
