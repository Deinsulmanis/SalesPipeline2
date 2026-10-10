'use strict';

// Touch 3 timing repair (2026-10-03). Touch 3 is due at
// MAX(Touch 1 + 7 days, Touch 2 + 3 days), from ONE definition that every
// consumer reads. These tests pin the rule, the window/timezone behaviour, the
// duplicate-send protections and — most importantly — that no consumer can
// silently disagree about when Touch 2 or Touch 3 is due.

process.env.STAFFING_LAUNCH_ACTIVATED_AT = process.env.STAFFING_LAUNCH_ACTIVATED_AT || '2026-09-01T00:00:00.000Z';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const timing = require('../integrations/sequence-timing');
const {
  SEQUENCE_TIMING, FOLLOW_UP_STEP_COUNT, NOMINAL_TOUCH_DAYS, DUE_BASIS, SEND_WINDOW_CRON,
  nextFollowUp, followUpDueAt, isFollowUpDue, nextSendWindowAt, addVancouverDays, describeSequence,
} = timing;
const { oldestDueFirst } = require('../integrations/scheduler-fairness');
const { deriveNextAction } = require('../integrations/pipeline-state');
const { projectedFollowUps } = require('../integrations/sender-balance');
const { followUpDueByTime } = require('../integrations/offer-retirement');
const { ordinaryFollowUpsDue } = require('../scripts/audit-gmail-crm-sends');
const { staffingSequenceDiff } = require('../integrations/staffing-readiness');
const { STAFFING_CAMPAIGN, STAFFING_SEQUENCE_TIMING } = require('../integrations/staffing-campaign');
const { chooseSender, sentSenderEvidence } = require('../integrations/gmail-sender-routing');
const {
  createSendingWindowQuota, consumeSendingWindowSuccess, sendingWindowVerdict, sendingWindowSnapshot,
} = require('../integrations/sending-window-quota');
const { deriveAutomationOwnership, mayColdSend } = require('../integrations/automation-ownership');
const { sendSuppressionReason } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agent = read('outreach-agent.js');
const server = read('server.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Vancouver wall-clock text for an instant, e.g. "2026-10-05 Mon 07:00 PDT".
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Vancouver', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});
const pt = ms => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute} ${p.timeZoneName}`;
};

// Touch 1 on Monday 2026-09-21 at 08:00 Vancouver (15:00Z).
const T1 = Date.parse('2026-09-21T15:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

let seq = 0;
function staffingLead(extra = {}) {
  seq += 1;
  return {
    id: `T${seq}`, email: `owner${seq}@harbourstaffing${seq}.com`, company: `Harbour Staffing ${seq}`,
    contactName: 'Alex Harbour', firstName: 'Alex', stage: 'Contacted', emailStatus: 'emailed',
    emailStep: '1', lastEmailedAt: iso(T1), notes: '', leadNiche: 'industrial_staffing',
    campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    intendedCampaignVersion: STAFFING_CAMPAIGN.id, senderInboxId: 'primary', routingRequired: 'true',
    siteContext: 'Your warehouse team places CDL drivers for local manufacturers.', ...extra,
  };
}
const sendEvent = (lead, step, at, sender = 'primary') => ({
  eventId: `${lead.id}:send:${step}:${at}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
  eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: iso(at),
  metadata: JSON.stringify({ step, sequenceStep: step, senderInboxId: sender }),
});
// A lead whose Touch 2 went out `touch2Day` days after Touch 1.
function atTouch2(touch2Day, { touch1 = T1, extra = {} } = {}) {
  const touch2 = touch1 + touch2Day * DAY;
  const lead = staffingLead({ emailStep: '2', lastEmailedAt: iso(touch2), ...extra });
  return { lead, touch1, touch2, activities: [sendEvent(lead, 1, touch1), sendEvent(lead, 2, touch2)] };
}
const dayOf = (ms, touch1 = T1) => (ms - touch1) / DAY;

// ── 1. The rule ──────────────────────────────────────────────────────────────

test('the canonical cadence is Day 0 / Day 3 / Day 7 with a 3-day Touch 2 floor', () => {
  assert.equal(SEQUENCE_TIMING.touch2.afterTouch1Days, 3);
  assert.equal(SEQUENCE_TIMING.touch3.afterTouch1Days, 7);
  assert.equal(SEQUENCE_TIMING.touch3.minAfterTouch2Days, 3);
  assert.equal(FOLLOW_UP_STEP_COUNT, 2);
  assert.deepEqual(NOMINAL_TOUCH_DAYS, [0, 3, 7]);
  assert.ok(Object.isFrozen(SEQUENCE_TIMING) && Object.isFrozen(SEQUENCE_TIMING.touch3));
});

test('Touch 2 is due 3 days after Touch 1', () => {
  const lead = staffingLead();
  const next = nextFollowUp(lead, { activities: [sendEvent(lead, 1, T1)] });
  assert.equal(next.nextStep, 2);
  assert.equal(next.basis, DUE_BASIS.TOUCH1_PLUS_3D);
  assert.equal(dayOf(next.dueAt), 3);
  assert.equal(isFollowUpDue(lead, T1 + 3 * DAY - 1, { activities: [] }), false);
  assert.equal(isFollowUpDue(lead, T1 + 3 * DAY, { activities: [] }), true);
});

for (const [touch2Day, touch3Day, basis] of [
  [3, 7, DUE_BASIS.TOUCH1_PLUS_7D],
  [4, 7, DUE_BASIS.TOUCH1_PLUS_7D],
  [5, 8, DUE_BASIS.TOUCH2_PLUS_3D],
  [7, 10, DUE_BASIS.TOUCH2_PLUS_3D],
]) {
  test(`Touch 1 Day 0 + Touch 2 Day ${touch2Day} -> Touch 3 Day ${touch3Day}`, () => {
    const { lead, activities } = atTouch2(touch2Day);
    const next = nextFollowUp(lead, { activities });
    assert.equal(next.nextStep, 3);
    assert.equal(dayOf(next.dueAt), touch3Day);
    assert.equal(next.basis, basis);
    assert.equal(isFollowUpDue(lead, next.dueAt - 1, { activities }), false, 'not a millisecond early');
    assert.equal(isFollowUpDue(lead, next.dueAt, { activities }), true);
  });
}

test('an old Touch 1 never makes Touch 3 due the moment a late Touch 2 lands', () => {
  // Touch 1 twenty days ago; Touch 2 only just went out.
  const { lead, activities, touch2 } = atTouch2(20);
  assert.equal(isFollowUpDue(lead, touch2 + HOUR, { activities }), false);
  assert.equal(nextFollowUp(lead, { activities }).dueAt, addVancouverDays(touch2, 3));
});

test('Touch 1 missing from the ledger: Touch 3 waits Touch 2 + 4 days — never earlier than the rule', () => {
  const { lead, touch2 } = atTouch2(3);
  const next = nextFollowUp(lead, { activities: [] });
  assert.equal(next.basis, DUE_BASIS.TOUCH2_PLUS_4D_UNPROVEN_TOUCH1);
  assert.equal(next.dueAt, addVancouverDays(touch2, 4));
  // Whatever Touch 1 really was (>= 3 days before Touch 2), the rule is no later.
  for (const gap of [3, 4, 6, 10]) {
    const proven = nextFollowUp(lead, { activities: [sendEvent(lead, 1, touch2 - gap * DAY)] });
    assert.ok(proven.dueAt <= next.dueAt, `gap ${gap}: proven due is never later than the fallback`);
  }
});

test('Touch 1 is the latest Touch 1 at or before Touch 2 (a re-sequenced lead uses its current start)', () => {
  const { lead, activities, touch2 } = atTouch2(3);
  const older = sendEvent(lead, 1, T1 - 40 * DAY);
  const after = sendEvent(lead, 1, touch2 + DAY); // impossible ordering; ignored
  const next = nextFollowUp(lead, { activities: [older, ...activities, after] });
  assert.equal(next.touch1At, T1);
  assert.equal(dayOf(next.dueAt), 7);
});

test('no follow-up exists outside steps 1..2 or without a parseable lastEmailedAt', () => {
  for (const emailStep of ['', '0', '3', '4', 'x']) {
    assert.equal(nextFollowUp(staffingLead({ emailStep }), { activities: [] }), null, `step ${emailStep}`);
    assert.equal(followUpDueAt(staffingLead({ emailStep }), { activities: [] }), Infinity);
  }
  assert.equal(nextFollowUp(staffingLead({ lastEmailedAt: 'garbage' }), { activities: [] }), null);
  assert.equal(nextFollowUp(staffingLead({ lastEmailedAt: '' }), { activities: [] }), null);
});

// ── 2. Weekend rollover and Vancouver time ───────────────────────────────────

test('send windows: SEND_WINDOW_CRON is the cron server.js schedules the agent with', () => {
  assert.equal(SEND_WINDOW_CRON, '0,30 7-11 * * 1-5');
  assert.ok(server.includes(`cron.schedule('${SEND_WINDOW_CRON}', async () => {`),
    'server.js schedules the agent on exactly the windows sequence-timing projects');
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5'[\s\S]{0,4000}timezone: 'America\/Vancouver'/);
});

test('weekend rollover: a Touch 3 due on Saturday goes out in Monday 07:00', () => {
  // Touch 1 Sat 09-26 is impossible (no windows), so: Touch 1 Mon 09-21 08:00,
  // Touch 2 Thu 09-24 (Day 3) → Touch 3 Mon 09-28 08:00 (Day 7, a weekday).
  // A Touch 2 on Mon 09-28 07:00 for a Touch 1 of Tue 09-22 → due Thu; and a
  // Touch 2 on Wed 09-30 07:00 (Touch 1 Wed 09-23) → due Sat 10-03 07:00.
  const touch1 = Date.parse('2026-09-23T14:00:00.000Z'); // Wed 07:00 PDT
  const { lead, activities } = atTouch2(7, { touch1 });   // Touch 2 Wed 09-30 07:00
  const due = nextFollowUp(lead, { activities }).dueAt;
  assert.equal(pt(due), '2026-10-03 Sat 07:00 PDT');
  assert.equal(pt(nextSendWindowAt(due)), '2026-10-05 Mon 07:00 PDT');
  // Sunday dues also roll to Monday; Friday after 11:30 rolls to Monday.
  assert.equal(pt(nextSendWindowAt(Date.parse('2026-10-04T20:00:00Z'))), '2026-10-05 Mon 07:00 PDT');
  assert.equal(pt(nextSendWindowAt(Date.parse('2026-10-02T18:45:00Z'))), '2026-10-05 Mon 07:00 PDT');
  // A weekday due inside the windows goes out in the next half-hour slot.
  assert.equal(pt(nextSendWindowAt(Date.parse('2026-10-01T15:10:00Z'))), '2026-10-01 Thu 08:30 PDT');
  // Weekday after 11:30 → next morning.
  assert.equal(pt(nextSendWindowAt(Date.parse('2026-09-29T19:00:00Z'))), '2026-09-30 Wed 07:00 PDT');
});

test('Vancouver calendar days keep the wall-clock time across DST and midnight', () => {
  // DST ends Sun 2026-11-01: Touch 1 Thu 10-29 10:00 PDT → Day 7 Thu 11-05 10:00 PST.
  const fall = Date.parse('2026-10-29T17:00:00.000Z');
  assert.equal(pt(addVancouverDays(fall, 7)), '2026-11-05 Thu 10:00 PST');
  assert.equal(addVancouverDays(fall, 7) - fall, 7 * DAY + HOUR, 'one hour longer in UTC');
  // DST starts Sun 2027-03-14: Touch 2 Thu 03-11 11:20 PST + 3 → Sun 03-14 11:20 PDT,
  // not 12:20 — a ms-based day would have slid out of the 11:30 window.
  const spring = Date.parse('2027-03-11T19:20:00.000Z');
  assert.equal(pt(addVancouverDays(spring, 3)), '2027-03-14 Sun 11:20 PDT');
  // A send at 23:30 Vancouver (next day in UTC) keeps its Vancouver date.
  const late = Date.parse('2026-09-22T06:30:00.000Z'); // Mon 09-21 23:30 PDT
  assert.equal(pt(addVancouverDays(late, 7)), '2026-09-28 Mon 23:30 PDT');
  assert.equal(pt(nextSendWindowAt(addVancouverDays(late, 7))), '2026-09-29 Tue 07:00 PDT');
});

test('Touch 3 for the 2026-09-22..25 cohort: before vs after', () => {
  // Flex-Staff shape: Touch 1 Tue 09-22 11:38, Touch 2 Mon 09-28 07:00 (Day 5.8).
  const touch1 = Date.parse('2026-09-22T18:38:17.000Z');
  const lead = staffingLead({ emailStep: '2', lastEmailedAt: '2026-09-28T14:00:22.000Z' });
  const activities = [sendEvent(lead, 1, touch1), sendEvent(lead, 2, Date.parse(lead.lastEmailedAt))];
  const next = nextFollowUp(lead, { activities });
  assert.equal(pt(next.dueAt), '2026-10-01 Thu 07:00 PDT', 'was Sat 10-03 under Touch 2 + 5 days');
  assert.equal(next.basis, DUE_BASIS.TOUCH2_PLUS_3D);
});

// ── 3. Duplicate safety ──────────────────────────────────────────────────────

test('already-sent Touch 3: a lead at step 3 has no next step under any due date', () => {
  const lead = staffingLead({ emailStep: '3', emailStatus: 'done', stage: 'Done' });
  assert.equal(nextFollowUp(lead, { activities: [] }), null);
  assert.equal(isFollowUpDue(lead, T1 + 365 * DAY, { activities: [] }), false);
});

test('already-sent Touch 3 with a stale step-2 row: the ledger still blocks a resend', () => {
  const { lead, activities, touch2 } = atTouch2(3);
  const sent3 = sendEvent(lead, 3, touch2 + 4 * DAY);
  const next = nextFollowUp(lead, { activities: [...activities, sent3] });
  assert.equal(next.alreadySent, true);
  assert.equal(isFollowUpDue(lead, touch2 + 30 * DAY, { activities: [...activities, sent3] }), false);
  // A step-3 send from a PREVIOUS sequence (before the current Touch 1) does not block.
  const stale = sendEvent(lead, 3, T1 - 30 * DAY);
  assert.equal(isFollowUpDue(lead, touch2 + 30 * DAY, { activities: [stale, ...activities] }), true);
});

test('Touch 3 requires a delivered Touch 2: a step-1 lead is only ever offered step 2', () => {
  const lead = staffingLead({ emailStep: '1' });
  assert.equal(nextFollowUp(lead, { activities: [] }).nextStep, 2);
  // emailStep only advances after a provider-confirmed send (markSent), which
  // is also where step 3 marks the lead done so nothing follows it.
  const markSent = agent.slice(agent.indexOf('async function markSent('), agent.indexOf('async function markSent(') + 600);
  assert.match(markSent, /const isLastStep = step > FOLLOW_UP_SEQUENCE\.length;/);
  assert.match(markSent, /const status = isLastStep \? 'done' : 'emailed';/);
});

test('the reservation and provider-recovery protections are unchanged', () => {
  const deliver = agent.slice(agent.indexOf('async function deliverOrdinaryColdStep('), agent.indexOf('async function deliverOrdinaryColdStep(') + 6000);
  assert.match(deliver, /recovered = await findSuccessfulSequenceSend\(\{ gmail: mailbox, rfcMessageId \}\);/,
    'a step Gmail already delivered is recorded, never resent');
  assert.match(deliver, /an unresolved delivery reservation exists and Gmail has not confirmed it/,
    'an unresolved reservation for the same lead+step refuses');
  assert.match(deliver, /const rfcMessageId = coldStepRfcMessageId\(lead\.id, step, sender\.email\);/);
  assert.match(deliver, /ordinaryColdActionId\(lead\.id, step\)/, 'the action id is per lead and step, independent of timing');
});

// ── 4. Capacity: sender cap, campaign (daily) cap, window cap ────────────────

const SENDERS = [
  { id: 'primary', email: 'primary@example.test', status: 'active', sendEligible: true, credentialConfigured: true, dailyLimit: 60, perRunLimit: 6 },
  { id: 'tryscalelabai', email: 'try@example.test', status: 'active', sendEligible: true, credentialConfigured: true, dailyLimit: 60, perRunLimit: 6 },
];

test('sender daily cap reached: a due Touch 3 is deferred, never moved to another inbox', () => {
  const { lead, activities } = atTouch2(3);
  const ok = chooseSender({ lead, activities, senders: SENDERS, sendsToday: new Map(), step: 3 });
  assert.equal(ok.sender.id, 'primary');
  assert.equal(ok.pinned, true);
  const full = chooseSender({ lead, activities, senders: SENDERS, sendsToday: new Map([['primary', 60]]), step: 3 });
  assert.equal(full.sender, null);
  assert.equal(full.reason, 'pinned sender daily limit reached');
  const window = chooseSender({ lead, activities, senders: SENDERS, sendsToday: new Map(),
    windowRemainingBySender: new Map([['primary', 0], ['tryscalelabai', 6]]), step: 3 });
  assert.equal(window.sender, null);
  assert.equal(window.reason, 'pinned sender scheduled-window limit reached');
});

test('campaign daily cap reached: no send of any step, and the window ceiling is global', () => {
  // The agent refuses the whole pass at the daily ceiling, and sizes the run
  // to the smaller of the window and daily remainders.
  assert.match(agent, /if \(dailyRemaining === 0\) \{\n\s*console\.log\('\[cap\] Daily send limit reached — skipping sends this run'\);\n\s*return;/);
  assert.match(agent, /const effectiveCap = Math\.min\(sendingWindowSnapshot\(windowQuota\)\.globalRemaining, dailyRemaining\);/);
  const quota = createSendingWindowQuota({ senderIds: ['primary', 'tryscalelabai'], perSenderLimit: 6, globalLimit: 2 });
  consumeSendingWindowSuccess(quota, 'primary');
  consumeSendingWindowSuccess(quota, 'tryscalelabai');
  assert.equal(sendingWindowSnapshot(quota).globalRemaining, 0);
  assert.deepEqual(sendingWindowVerdict(quota, 'primary'), { allowed: false, reason: 'scheduled-window global limit reached' });
});

// ── 5. States that stop Touch 3 ──────────────────────────────────────────────

function ownershipFor(lead, activities, extra = {}) {
  const verdict = deriveAutomationOwnership(lead, {
    activities, sendingEnabled: true, coldCadenceDue: true, now: new Date(T1 + 20 * DAY),
    suppressionReason: row => sendSuppressionReason(row, { suppressedEmails: extra.suppressedEmails || new Set() }),
    ...extra,
  });
  return { verdict, allowed: mayColdSend(verdict).allowed };
}

test('a due Touch 3 with nothing else going on is cold-owned and sendable', () => {
  const { lead, activities } = atTouch2(3);
  assert.equal(isFollowUpDue(lead, T1 + 20 * DAY, { activities }), true);
  const { verdict, allowed } = ownershipFor(lead, activities);
  assert.equal(verdict.owner, 'cold_automation');
  assert.equal(allowed, true);
});

test('reply before Touch 3: a person owns the next move', () => {
  const { lead, activities } = atTouch2(3);
  const reply = { eventType: 'question_reply', sourceLeadId: lead.id, occurredAt: iso(T1 + 5 * DAY),
    metadata: JSON.stringify({ canonicalState: 'needs_human', reason: 'question_or_objection', gmailMessageId: 'm1' }) };
  const { verdict, allowed } = ownershipFor(lead, [...activities, reply]);
  assert.equal(verdict.owner, 'human');
  assert.equal(allowed, false);
  // And a replied row never reaches timing at all.
  assert.match(agent.slice(agent.indexOf('function selectFollowUps'), agent.indexOf('function countTodaySends')),
    /if \(l\.emailStatus !== 'emailed'\) return false;/);
});

test('unsubscribe before Touch 3: suppressed, by tag and by the durable list', () => {
  const { lead, activities } = atTouch2(3, { extra: { notes: '[REPLY: Unsubscribed]' } });
  assert.equal(ownershipFor(lead, activities).allowed, false);
  assert.equal(ownershipFor(lead, activities).verdict.blockedBy, 'suppression');
  const clean = atTouch2(3);
  const listed = ownershipFor(clean.lead, clean.activities, { suppressedEmails: new Set([clean.lead.email]) });
  assert.equal(listed.allowed, false);
  assert.match(listed.verdict.reason, /suppression-list/);
});

test('booking before Touch 3: the meeting owns the lead', () => {
  const { lead, activities } = atTouch2(3);
  const { verdict, allowed } = ownershipFor(lead, activities, {
    boardLead: { id: 'B1', stage: 'demo_booked', email: lead.email }, callState: { status: 'scheduled' },
  });
  assert.equal(verdict.owner, 'meeting');
  assert.equal(allowed, false);
});

test('manual hold before Touch 3: absolute, whatever the due date says', () => {
  const { lead, activities } = atTouch2(3, { extra: { notes: '[MANUAL HOLD]' } });
  assert.equal(isFollowUpDue(lead, T1 + 20 * DAY, { activities }), true, 'timing alone would say due');
  const { verdict, allowed } = ownershipFor(lead, activities);
  assert.equal(verdict.blockedBy, 'manual_hold');
  assert.equal(allowed, false);
  // A [RESUME:] beside a manual hold still does not release cold automation.
  const resumed = atTouch2(3, { extra: { notes: '[MANUAL HOLD] [RESUME: 2026-01-01T00:00:00.000Z]' } });
  assert.equal(ownershipFor(resumed.lead, resumed.activities).allowed, false);
});

// ── 6. Consumers cannot disagree ─────────────────────────────────────────────

function matrix() {
  const cases = [];
  for (const touch2Day of [3, 4, 5, 7, 12]) cases.push(atTouch2(touch2Day));
  const step1 = staffingLead({ emailStep: '1' });
  cases.push({ lead: step1, activities: [sendEvent(step1, 1, T1)] });
  const unproven = staffingLead({ emailStep: '2', lastEmailedAt: iso(T1 + 3 * DAY) });
  cases.push({ lead: unproven, activities: [] });
  const sent = atTouch2(3);
  sent.activities.push(sendEvent(sent.lead, 3, T1 + 7 * DAY));
  cases.push(sent);
  return cases;
}
const probes = () => Array.from({ length: 30 }, (_, i) => T1 + i * 12 * HOUR);

test('selector, refill projection, offer retirement and the audit agree with the canonical gate at every instant', () => {
  for (const { lead, activities } of matrix()) {
    for (const now of probes()) {
      const canonical = isFollowUpDue(lead, now, { activities });
      const label = `${lead.id} step ${lead.emailStep} at ${iso(now)}`;
      assert.equal(followUpDueByTime(lead, new Date(now), activities), canonical, `offer-retirement ${label}`);
      assert.equal(ordinaryFollowUpsDue([lead], now, activities).length === 1, canonical, `audit ${label}`);
      const projected = projectedFollowUps({
        leads: [lead], activitiesByLead: new Map([[lead.id, activities]]),
        senders: SENDERS, suppressedEmails: new Set(), horizon: now,
      });
      // The refill also counts only follow-ups with ONE proven sender (an
      // unproven owner is refused at send time), so timing is necessary, and
      // with proof, sufficient.
      const proven = sentSenderEvidence(lead, activities).length === 1;
      assert.equal(projected.get('primary') === 1, canonical && proven, `06:40 refill projection ${label}`);
    }
  }
});

test('the agent selector calls the canonical gate and orders by the canonical due date', () => {
  const selector = agent.slice(agent.indexOf('function selectFollowUps'), agent.indexOf('function countTodaySends'));
  assert.match(selector, /return isFollowUpDue\(l, now, \{ activities \}\);/);
  assert.match(selector, /return oldestDueFirst\(due, activities\);/);
  assert.doesNotMatch(selector, /delayDays|86400000|1000 \* 60 \* 60 \* 24/);
  // Ordering is by the same due instant.
  const cases = matrix().filter(item => Number(item.lead.emailStep) <= 2);
  const activities = cases.flatMap(item => item.activities);
  const ordered = oldestDueFirst(cases.map(item => item.lead), activities);
  const dues = ordered.map(lead => followUpDueAt(lead, { activities }));
  assert.deepEqual(dues, [...dues].sort((a, b) => a - b));
});

test('the Outreach drawer next action shows the canonical due date', () => {
  for (const { lead, activities } of matrix()) {
    const next = nextFollowUp(lead, { activities });
    const action = deriveNextAction(null, lead, { now: new Date(T1), activities, outreachOnly: true });
    if (next && !next.alreadySent) {
      assert.equal(action.type, 'automated_follow_up', lead.id);
      assert.equal(action.dueAt, next.dueAtIso, lead.id);
      assert.equal(action.label, `Automated follow-up #${next.nextStep}`);
    } else {
      assert.notEqual(action.type, 'automated_follow_up', `${lead.id} has nothing automated to advertise`);
    }
  }
});

test('readiness, the staffing preview and the dashboard show the canonical days', () => {
  const diff = staffingSequenceDiff();
  assert.deepEqual(diff.days, [...NOMINAL_TOUCH_DAYS]);
  assert.deepEqual(diff.approved.map(item => item.day), [...NOMINAL_TOUCH_DAYS]);
  assert.equal(diff.maxSteps, FOLLOW_UP_STEP_COUNT + 1);
  assert.deepEqual(describeSequence().map(item => item.day), [...NOMINAL_TOUCH_DAYS]);
  assert.match(server, /day: describeSequence\(\)\[i\]\.day, timing: describeSequence\(\)\[i\]\.rule/);
  const html = read('public/index.html');
  assert.ok(html.includes(`'Follow-up (Day ${NOMINAL_TOUCH_DAYS[1]})', 'Final (Day ${NOMINAL_TOUCH_DAYS[2]})'`),
    'the Outreach drawer step labels match the canonical days');
  assert.doesNotMatch(html, /step\.delayDays|Final \(5 days\)/);
  assert.equal(STAFFING_SEQUENCE_TIMING, SEQUENCE_TIMING, 'staffing re-exports the one definition by reference');
});

test('no second copy of the cadence exists anywhere in the codebase', () => {
  const files = [
    'outreach-agent.js', 'server.js',
    ...fs.readdirSync(path.join(root, 'integrations')).filter(f => f.endsWith('.js')).map(f => `integrations/${f}`),
    ...fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => `scripts/${f}`),
  ];
  const forbidden = [
    /FOLLOW_UP_DELAY_DAYS/, /STAFFING_FOLLOW_UP_DELAY_DAYS/,
    /\bdelayDays\s*:\s*\d/,                    // { delayDays: 3 }
    /\{\s*1\s*:\s*3\s*,\s*2\s*:\s*5\s*\}/,     // { 1: 3, 2: 5 }
    /\[\s*\[\s*1\s*,\s*3\s*\]\s*,\s*\[\s*2\s*,\s*5\s*\]\s*\]/, // [[1, 3], [2, 5]]
    /\[\s*0\s*,\s*3\s*,\s*5\s*\]/,             // [0, 3, 5]
  ];
  const offenders = [];
  for (const file of files) {
    if (file === 'integrations/sequence-timing.js') continue;
    const src = read(file);
    for (const pattern of forbidden) if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(offenders, [], 'cadence must live only in integrations/sequence-timing.js');
});
