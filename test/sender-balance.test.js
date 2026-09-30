'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  planSenderRebalance, assignNewLeads, assignBatch, senderWorkload, nextSendDayHorizon, targetFor,
} = require('../integrations/sender-balance');
const { queueSelectedLeads, AUTO_SENDER } = require('../integrations/outreach-queue');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const NOW = Date.parse('2026-09-30T13:00:00.000Z'); // 06:00 Pacific, before the first window
const ENV = Object.freeze({ STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' });
const DAY = 24 * 60 * 60 * 1000;

// Production shape: 60/60/40/20/20, scalelabaiteam staffing-only.
const sender = (id, dailyLimit, extra = {}) => ({ id, email: `${id}@example.test`, status: 'active',
  sendEligible: true, credentialConfigured: true, dailyLimit, perRunLimit: 6, ...extra });
const SENDERS = [
  sender('primary', 60), sender('tryscalelabai', 60), sender('scalelabaiteam', 40, { staffingOnly: true }),
  sender('deniels', 20), sender('deniels_tryscalelabai', 20),
];

let seq = 0;
const staffing = (senderInboxId = 'primary', extra = {}) => {
  seq += 1;
  return { id: `S${seq}`, company: `Staffing Co ${seq}`, contactName: 'Alex', email: `s${seq}@example.com`,
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name,
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
    siteContext: 'Your warehouse staffing team serves local manufacturers.',
    senderInboxId, routingRequired: 'true', sheetRow: seq, revision: 1, ...extra };
};
const dental = (senderInboxId = 'primary', extra = {}) => staffing(senderInboxId, {
  leadNiche: 'dental', campaign: 'Ontario List', emailTemplateId: 'dental-guarantee-v1',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', ...extra });
// Non-staffing supply that can still send: an unrouted legacy row (med spa).
// It plays the part dental played before the dental offer was retired.
const legacyCold = (senderInboxId = 'primary', extra = {}) => staffing(senderInboxId, {
  leadNiche: '', campaign: 'toronto-medspa-jul', emailTemplateId: '', intendedCampaignVersion: '',
  routingRequired: '', tradeType: 'Medical spa', siteContext: '', ...extra });
const FIXTURE = { dental, staffing, legacy: legacyCold };
// A delivered step 1 owned by `owner`, due for step 2 `daysAgo` after sending.
const followUp = (owner, daysAgo = 4, niche = 'legacy') => {
  const lead = FIXTURE[niche](owner, {
    stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
    lastEmailedAt: new Date(NOW - daysAgo * DAY).toISOString() });
  return { lead, activity: { sourceLeadId: lead.id, eventType: 'initial_email_sent',
    metadata: JSON.stringify({ senderInboxId: owner }) } };
};
const input = (leads, extra = {}) => ({ leads, activities: [], boardLeads: [], suppressedEmails: new Set(),
  lockedLeadIds: new Set(), senders: SENDERS, horizon: NOW + DAY, env: ENV,
  renderOptions: STAFFING_RENDER_OPTIONS, ...extra });
const surplus = () => Array.from({ length: 150 }, () => staffing('primary'));
const movedIds = plan => new Set(plan.moves.map(move => move.leadId));
const byTo = plan => plan.moves.reduce((acc, move) => ({ ...acc, [move.to]: (acc[move.to] || 0) + 1 }), {});
const row = (plan, id, when = 'after') => plan[when].find(item => item.id === id);
const applyMoves = (leads, plan) => {
  const to = new Map(plan.moves.map(move => [move.leadId, move.to]));
  return leads.map(lead => (to.has(lead.id) ? { ...lead, senderInboxId: to.get(lead.id), revision: lead.revision + 1 } : lead));
};

// 1 ────────────────────────────────────────────────────────────────────────
test('staffing first-touch fills every eligible inbox to its own capacity target', () => {
  const leads = Array.from({ length: 300 }, () => staffing('primary'));
  const plan = planSenderRebalance(input(leads));
  for (const s of SENDERS) {
    assert.equal(row(plan, s.id).load >= targetFor(s), true, `${s.id} reaches target`);
  }
  assert.deepEqual(byTo(plan), { tryscalelabai: 69, scalelabaiteam: 46, deniels: 23, deniels_tryscalelabai: 23 });
  assert.deepEqual(plan.shortages, []);
  assert.ok(plan.moves.every(move => move.from === 'primary'), 'only the surplus inbox gives');
});

// 2 ────────────────────────────────────────────────────────────────────────
test('non-staffing leads never enter scalelabaiteam, and no unsendable supply hides a shortage', () => {
  // Retired dental and unrouted legacy rows are not supply for any inbox:
  // every inbox reports its whole cap as a shortage rather than a false fill.
  const leads = [...Array.from({ length: 200 }, () => dental('primary')), ...Array.from({ length: 50 }, () => legacyCold('primary'))];
  const plan = planSenderRebalance(input(leads));
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.shortages.map(item => item.senderInboxId).sort(),
    ['deniels', 'deniels_tryscalelabai', 'primary', 'scalelabaiteam', 'tryscalelabai']);
  const admitted = assignNewLeads({ batch: Array.from({ length: 50 }, () => dental('')), senders: SENDERS });
  assert.equal([...admitted.assignments.values()].includes('scalelabaiteam'), false);
});

test('retired dental is neither refill supply nor workload: never moved, never counted', () => {
  const queued = Array.from({ length: 200 }, () => dental('primary'));
  const owned = Array.from({ length: 30 }, () => followUp('deniels', 4, 'dental'));
  const plan = planSenderRebalance(input([...queued, ...owned.map(item => item.lead)],
    { activities: owned.map(item => item.activity) }));
  assert.equal(plan.moves.length, 0, 'no dental lead is ever reassigned');
  assert.equal(row(plan, 'primary', 'before').load, 0, 'queued dental is not supply');
  assert.equal(row(plan, 'deniels', 'before').followUps, 0, 'due dental follow-ups are not workload');
  const archived = staffing('primary', { notes: '[ARCHIVED: manual_archive]', stage: 'Archived' });
  const withArchived = planSenderRebalance(input([archived, ...Array.from({ length: 100 }, () => staffing('primary'))]));
  assert.equal(movedIds(withArchived).has(archived.id), false, 'an archived lead is never moved');
});

test('blank, roofing and lookalike niches are never routed to scalelabaiteam', () => {
  for (const leadNiche of ['', 'roofing', 'medical_staffing', 'staffing-ish']) {
    const lead = staffing('', { leadNiche });
    const { assignments } = assignNewLeads({ batch: [lead], senders: SENDERS });
    assert.notEqual(assignments.get(lead.id), 'scalelabaiteam', leadNiche || '(blank)');
  }
});

test('staffing reaches scalelabaiteam before flexible inboxes spend it', () => {
  // 140 staffing on primary, and staffing is now the only compatible supply:
  // the staffing-only inbox reaches its cap before the flexible inboxes take any.
  const leads = Array.from({ length: 140 }, () => staffing('primary'));
  const plan = planSenderRebalance(input(leads));
  assert.equal(byTo(plan).scalelabaiteam, 40);
  assert.equal(loads(plan).primary, 60, 'the donor keeps its own cap');
});

// 3 ────────────────────────────────────────────────────────────────────────
test('follow-ups are counted as their owner\'s workload and never moved', () => {
  const owned = Array.from({ length: 30 }, () => followUp('deniels'));
  const leads = [...owned.map(item => item.lead), ...Array.from({ length: 100 }, () => staffing('primary'))];
  const plan = planSenderRebalance(input(leads, { activities: owned.map(item => item.activity) }));
  const moved = movedIds(plan);
  assert.equal(owned.some(item => moved.has(item.lead.id)), false);
  assert.equal(row(plan, 'deniels', 'before').followUps, 30);
  assert.equal(byTo(plan).deniels, undefined, 'a full inbox receives no step-1 work');
});

// 4 ────────────────────────────────────────────────────────────────────────
test('any earlier outbound pins the lead where it is', () => {
  const sentOnce = staffing('primary');
  const evidenced = staffing('primary');
  const leads = [sentOnce, evidenced, ...surplus()];
  const activities = [
    { sourceLeadId: sentOnce.id, eventType: 'initial_email_sent', metadata: JSON.stringify({ senderInboxId: 'primary' }) },
    { sourceLeadId: evidenced.id, eventType: 'sender_evidence_reconciled', metadata: JSON.stringify({ senderInboxId: 'primary' }) },
  ];
  const moved = movedIds(planSenderRebalance(input(leads, { activities })));
  assert.equal(moved.has(sentOnce.id), false);
  assert.equal(moved.has(evidenced.id), false);
  assert.ok(moved.size > 0, 'the rest of the surplus still moves');
});

// 5 ────────────────────────────────────────────────────────────────────────
test('reserved and uncertain sends never move', () => {
  const locked = staffing('primary');
  const reserved = staffing('primary');
  const uncertain = staffing('primary');
  const leads = [locked, reserved, uncertain, ...surplus()];
  const activities = [
    { sourceLeadId: reserved.id, eventType: 'ordinary_send_reserved', metadata: '{}' },
    { sourceLeadId: uncertain.id, eventType: 'send_uncertain', metadata: '{}' },
  ];
  const moved = movedIds(planSenderRebalance(input(leads, { activities, lockedLeadIds: new Set([locked.id]) })));
  for (const lead of [locked, reserved, uncertain]) assert.equal(moved.has(lead.id), false, lead.id);
  assert.ok(moved.size > 0);
});

// 6 ────────────────────────────────────────────────────────────────────────
test('suppression, manual hold, human takeover and Agent v2 conversations always win', () => {
  const suppressed = staffing('primary');
  const held = staffing('primary', { notes: '[MANUAL HOLD]' });
  const human = staffing('primary');
  const agent = staffing('primary');
  const replied = staffing('primary');
  const activities = [
    { sourceLeadId: human.id, eventType: 'human_response_sent', metadata: '{}' },
    { sourceLeadId: agent.id, eventType: 'reply_decision_pending_execution', metadata: '{}' },
    { sourceLeadId: replied.id, eventType: 'positive_reply', metadata: '{}' },
  ];
  const plan = planSenderRebalance(input([suppressed, held, human, agent, replied, ...surplus()], {
    activities, suppressedEmails: new Set([suppressed.email]) }));
  const moved = movedIds(plan);
  for (const lead of [suppressed, held, human, agent, replied]) assert.equal(moved.has(lead.id), false, lead.id);
  assert.ok(moved.size > 0);
});

// 7 ────────────────────────────────────────────────────────────────────────
test('an inactive or ineligible inbox receives no new work', () => {
  const senders = SENDERS.map(s => (s.id === 'deniels' ? { ...s, status: 'warming' }
    : s.id === 'deniels_tryscalelabai' ? { ...s, sendEligible: false } : s));
  const leads = Array.from({ length: 300 }, () => staffing('primary'));
  const plan = planSenderRebalance(input(leads, { senders }));
  assert.equal(plan.moves.some(move => ['deniels', 'deniels_tryscalelabai'].includes(move.to)), false);
  const admitted = assignNewLeads({ batch: Array.from({ length: 50 }, () => staffing('')), senders });
  assert.equal([...admitted.assignments.values()].some(id => ['deniels', 'deniels_tryscalelabai'].includes(id)), false);
});

test('a lead assigned to an inactive inbox is freed and re-routed', () => {
  const senders = SENDERS.map(s => (s.id === 'deniels' ? { ...s, status: 'paused' } : s));
  const stranded = Array.from({ length: 10 }, () => staffing('deniels'));
  const plan = planSenderRebalance(input(stranded, { senders }));
  assert.equal(plan.moves.length, 10);
  assert.ok(plan.moves.every(move => move.to !== 'deniels'));
});

// 8 ────────────────────────────────────────────────────────────────────────
test('an inbox already at its projected target receives nothing', () => {
  const leads = [
    ...Array.from({ length: 69 }, () => staffing('primary')), ...Array.from({ length: 69 }, () => staffing('tryscalelabai')),
    ...Array.from({ length: 46 }, () => staffing('scalelabaiteam')), ...Array.from({ length: 23 }, () => staffing('deniels')),
    ...Array.from({ length: 23 }, () => staffing('deniels_tryscalelabai')), ...Array.from({ length: 50 }, () => staffing('primary')),
  ];
  const plan = planSenderRebalance(input(leads));
  assert.equal(plan.moves.length, 0, 'surplus stays put when nobody is short');
});

test('only the deficit moves: a donor keeps its own daily cap', () => {
  // 80 on primary, everyone else empty: hard capacity comes first, so primary
  // gives everything above its own 60 and keeps a full day for itself.
  const leads = [...Array.from({ length: 80 }, () => staffing('primary'))];
  const plan = planSenderRebalance(input(leads));
  assert.equal(row(plan, 'primary').load, 60, 'primary keeps exactly its own daily cap');
  assert.equal(plan.moves.length, 20);
});

// ── two-phase refill: hard daily capacity before the buffered target ────────
// Build an inbox's projected workload from pinned follow-ups plus movable
// first emails, so tests can state it the way the live planner reports it.
const loaded = (senderId, followUps, firstEmails, niche = 'staffing') => {
  const owned = Array.from({ length: followUps }, () => followUp(senderId, 4, niche));
  const fresh = Array.from({ length: firstEmails }, () => FIXTURE[niche](senderId));
  return { leads: [...owned.map(item => item.lead), ...fresh], activities: owned.map(item => item.activity) };
};
const combine = (...parts) => ({ leads: parts.flatMap(p => p.leads), activities: parts.flatMap(p => p.activities) });
const loads = plan => Object.fromEntries(plan.after.map(r => [r.id, r.load]));
const CAPS = { primary: 60, tryscalelabai: 60, scalelabaiteam: 40, deniels: 20, deniels_tryscalelabai: 20 };
// The live Thursday 2026-10-01 projection: 69 / 53 / 46 / 18 / 18 (204 supply).
const thursday = () => combine(
  loaded('primary', 54, 15), loaded('tryscalelabai', 0, 53), loaded('scalelabaiteam', 10, 36),
  loaded('deniels', 0, 18), loaded('deniels_tryscalelabai', 0, 18));

test('A1: with enough compatible supply, the buffer never leaves an inbox below its daily cap', () => {
  const state = thursday();
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  assert.deepEqual(plan.hardShortages, []);
  for (const [id, cap] of Object.entries(CAPS)) assert.ok(loads(plan)[id] >= cap, `${id} ${loads(plan)[id]} >= ${cap}`);
});

test('A2: the Thursday 69/53/46/18/18 state reaches 60/60/40/20/20 and 200 usable workload', () => {
  const state = thursday();
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  const after = loads(plan);
  assert.equal(after.tryscalelabai, 60);
  assert.equal(after.deniels, 20);
  assert.equal(after.deniels_tryscalelabai, 20);
  assert.ok(after.primary >= 60 && after.scalelabaiteam >= 40, 'donors stay at or above their caps');
  assert.equal(after.primary + after.scalelabaiteam, 69 + 46 - 11, 'donors give exactly the 11 needed');
  const usable = Object.entries(CAPS).reduce((n, [id, cap]) => n + Math.min(cap, after[id]), 0);
  assert.equal(usable, 200);
  assert.equal(plan.moves.length, 11, 'only the hard deficits (7 + 2 + 2), from 9 + 6 surplus above cap');
  assert.ok(plan.moves.every(m => ['primary', 'scalelabaiteam'].includes(m.from)));
  // The buffer shortfall is still reported honestly: 230 of target against 204 of supply.
  assert.equal(plan.shortages.reduce((n, s) => n + s.unfilled, 0), 26);
});

test('A3: phase A never takes a donor below its own daily cap', () => {
  // Everyone else empty; donors barely above cap.
  const state = combine(loaded('primary', 55, 10), loaded('scalelabaiteam', 30, 15));
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  assert.equal(loads(plan).primary, 60);
  assert.equal(loads(plan).scalelabaiteam, 40);
  assert.equal(plan.moves.filter(m => m.from === 'primary').length, 5);
  assert.equal(plan.moves.filter(m => m.from === 'scalelabaiteam').length, 5);
  assert.equal(plan.hardShortages.reduce((n, s) => n + s.unfilled, 0), 100 - 10);
});

test('A4: once every daily cap is met, the buffered target resumes', () => {
  // tryscalelabai at exactly its cap; primary has plenty above its target.
  const state = combine(loaded('primary', 0, 150), loaded('tryscalelabai', 0, 60),
    loaded('scalelabaiteam', 0, 40), loaded('deniels', 0, 20), loaded('deniels_tryscalelabai', 0, 20));
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  assert.deepEqual(loads(plan), { primary: 129, tryscalelabai: 69, scalelabaiteam: 46, deniels: 23, deniels_tryscalelabai: 23 });
  assert.deepEqual(plan.shortages, []);
  // And a donor at its target is not drawn below it in phase B.
  const tight = combine(loaded('primary', 0, 69), loaded('tryscalelabai', 0, 60),
    loaded('scalelabaiteam', 0, 40), loaded('deniels', 0, 20), loaded('deniels_tryscalelabai', 0, 20));
  assert.equal(planSenderRebalance(input(tight.leads, { activities: tight.activities })).moves.length, 0);
});

test('A5: insufficient aggregate supply still reports a real hard shortage', () => {
  const state = combine(loaded('primary', 40, 60), loaded('tryscalelabai', 0, 30));  // 130 < 200
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  const idle = plan.hardShortages.reduce((n, s) => n + s.unfilled, 0);
  assert.equal(idle, 200 - 130);
  assert.equal(loads(plan).primary, 60, 'donor held at its own cap even when others stay short');
});

test('A6: incompatible supply cannot hide a shortage', () => {
  // Plenty of retired dental "surplus": none of it is compatible with any
  // inbox, so it hides nothing — every inbox reports its whole cap unfilled.
  const state = combine(loaded('primary', 0, 200, 'dental'), loaded('tryscalelabai', 0, 69, 'dental'),
    loaded('deniels', 0, 23, 'dental'), loaded('deniels_tryscalelabai', 0, 23, 'dental'));
  const plan = planSenderRebalance(input(state.leads, { activities: state.activities }));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.hardShortages.reduce((n, s) => n + s.unfilled, 0), 200);
});

test('A7: protected leads stay put even when phase A needs them', () => {
  // primary's only surplus above its cap is held, reserved, owned or suppressed.
  const owned = Array.from({ length: 60 }, () => followUp('primary'));
  const held = staffing('primary', { notes: '[MANUAL HOLD]' });
  const reserved = staffing('primary');
  const locked = staffing('primary');
  const evidenced = staffing('primary');
  const suppressed = staffing('primary');
  const agent = staffing('primary');
  const leads = [...owned.map(o => o.lead), held, reserved, locked, evidenced, suppressed, agent];
  const activities = [...owned.map(o => o.activity),
    { sourceLeadId: reserved.id, eventType: 'ordinary_send_reserved', metadata: '{}' },
    { sourceLeadId: evidenced.id, eventType: 'sender_evidence_reconciled', metadata: JSON.stringify({ senderInboxId: 'primary' }) },
    { sourceLeadId: agent.id, eventType: 'reply_decision_pending_execution', metadata: '{}' }];
  const plan = planSenderRebalance(input(leads, { activities, lockedLeadIds: new Set([locked.id]),
    suppressedEmails: new Set([suppressed.email]) }));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.hardShortages.reduce((n, s) => n + s.unfilled, 0), 140);
  assert.ok(owned.every(o => !movedIds(plan).has(o.lead.id)), 'follow-ups never move');
});

test('A8: the two-phase refill is idempotent and deterministic', () => {
  for (const state of [thursday(), combine(loaded('primary', 0, 300)), combine(loaded('primary', 20, 90, 'legacy'), loaded('primary', 0, 60))]) {
    const first = planSenderRebalance(input(state.leads, { activities: state.activities }));
    assert.ok(first.moves.length > 0);
    const second = planSenderRebalance(input(applyMoves(state.leads, first), { activities: state.activities }));
    assert.equal(second.moves.length, 0, 're-running against the applied state moves nothing');
    const again = planSenderRebalance(input(state.leads, { activities: state.activities }));
    assert.deepEqual(again.moves.map(m => [m.leadId, m.to]), first.moves.map(m => [m.leadId, m.to]));
  }
});

test('A8: admission stays deterministic, and a refill after balanced admission moves nothing', () => {
  const batch = Array.from({ length: 204 }, () => staffing(''));
  const one = assignNewLeads({ batch, senders: SENDERS }).assignments;
  const two = assignNewLeads({ batch, senders: SENDERS }).assignments;
  assert.deepEqual([...one], [...two]);
  const admitted = batch.map(lead => ({ ...lead, senderInboxId: one.get(lead.id) }));
  assert.equal(planSenderRebalance(input(admitted)).moves.length, 0);
});

// 9 ────────────────────────────────────────────────────────────────────────
test('admission is capacity-weighted: 60/day inboxes get three times a 20/day inbox', () => {
  const batch = Array.from({ length: 600 }, () => staffing(''));
  const { assignments, refused } = assignNewLeads({ batch, senders: SENDERS });
  assert.deepEqual(refused, []);
  const counts = [...assignments.values()].reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});
  assert.deepEqual(counts, { primary: 180, tryscalelabai: 180, scalelabaiteam: 120, deniels: 60, deniels_tryscalelabai: 60 });
});

test('admission fills the emptiest inbox first, then spreads by capacity', () => {
  const owned = Array.from({ length: 60 }, () => followUp('primary'));
  const workload = senderWorkload(input(owned.map(item => item.lead), { activities: owned.map(item => item.activity) }));
  const { assignments } = assignNewLeads({ batch: Array.from({ length: 20 }, () => staffing('')), workload, senders: SENDERS });
  assert.equal([...assignments.values()].includes('primary'), false, 'primary already has a day of follow-ups');
});

// 10 ───────────────────────────────────────────────────────────────────────
test('balancing twice is idempotent', () => {
  const leads = [...Array.from({ length: 250 }, () => staffing('primary')), ...Array.from({ length: 20 }, () => legacyCold('primary'))];
  const first = planSenderRebalance(input(leads));
  assert.ok(first.moves.length > 0);
  const second = planSenderRebalance(input(applyMoves(leads, first)));
  assert.equal(second.moves.length, 0);
  assert.deepEqual(planSenderRebalance(input(leads)).moves.map(m => [m.leadId, m.to]),
    first.moves.map(m => [m.leadId, m.to]), 'deterministic for the same state');
});

test('each lead appears in a plan at most once', () => {
  const plan = planSenderRebalance(input(Array.from({ length: 300 }, () => staffing('primary'))));
  assert.equal(movedIds(plan).size, plan.moves.length);
});

// 11 ───────────────────────────────────────────────────────────────────────
test('concurrent applies cannot reassign the same lead twice (compare-and-set)', async () => {
  const leads = Array.from({ length: 120 }, () => staffing('primary'));
  const store = new Map(leads.map(lead => [lead.id, { ...lead }]));
  const casApply = async changes => {
    await new Promise(resolve => setImmediate(resolve));
    return changes.map(({ leadId, patch, expectedState }) => {
      const current = store.get(leadId);
      if (current.revision !== expectedState.revision || current.senderInboxId !== expectedState.senderInboxId) {
        return { leadId, status: 'conflict' };
      }
      store.set(leadId, { ...current, ...patch, revision: current.revision + 1 });
      return { leadId, status: 'succeeded' };
    });
  };
  // Two runners planned from the same snapshot race to apply.
  const planA = planSenderRebalance(input(leads));
  const planB = planSenderRebalance(input(leads));
  const toChanges = plan => plan.moves.map(move => ({ leadId: move.leadId, patch: { senderInboxId: move.to }, expectedState: move.expectedState }));
  const [a, b] = await Promise.all([casApply(toChanges(planA)), casApply(toChanges(planB))]);
  const wins = [...a, ...b].filter(result => result.status === 'succeeded');
  assert.equal(wins.length, planA.moves.length, 'every lead is written exactly once');
  assert.equal(new Set(wins.map(result => result.leadId)).size, wins.length);
  for (const move of planA.moves) assert.equal(store.get(move.leadId).revision, 2);
});

test('the refill is serialised and never runs beside an agent pass or inside the send window', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = server.slice(server.indexOf('async function runSenderRebalance'), server.indexOf("app.get('/api/ops/sender-balance'"));
  assert.match(body, /if \(senderRebalanceInFlight\) return \{ status: 409/);
  assert.match(body, /agentState\.running \|\| automationLaunchReserved/);
  assert.match(body, /insideSendWindow\(\)/);
  assert.match(body, /patch: \{ senderInboxId: move\.to \}, row: rowsById\.get\(move\.leadId\)\[0\], expectedState: move\.expectedState/,
    'writes only senderInboxId, compare-and-set against the planned state');
  assert.match(server, /cron\.schedule\('40,50 6 \* \* 1-5'/);
});

// 12 ───────────────────────────────────────────────────────────────────────
test('the scheduled send path, caps and pacing are untouched', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(/sender-balance/.test(agent), false, 'the send path does not consult the balancer');
  assert.match(agent, /const MIN_DELAY = 30 \* 1000;/);
  assert.match(agent, /const MAX_DELAY = 90 \* 1000;/);
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5'/);
  // Assignment is still binding at send time: no fallback was introduced.
  const lead = staffing('tryscalelabai');
  assert.equal(chooseSender({ lead, senders: SENDERS, sendsToday: new Map([['tryscalelabai', 60]]) }).sender, null);
  assert.equal(chooseSender({ lead, senders: SENDERS, windowRemainingBySender: new Map([['tryscalelabai', 0], ['primary', 6]]) }).sender, null);
});

// ── queue admission ('auto') ────────────────────────────────────────────────
const REQUEST = { senderInboxId: AUTO_SENDER, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN.id };

test('queueing with auto assigns each lead its own capacity-weighted inbox', async () => {
  const leads = Array.from({ length: 30 }, () => staffing('', { stage: 'Import', senderInboxId: '' }));
  const changes = [];
  const validated = [];
  const result = await queueSelectedLeads({ ...REQUEST, ids: leads.map(lead => lead.id) }, {
    loadState: async () => ({ leads, ...STAFFING_RENDER_OPTIONS, lockedLeadIds: new Set() }),
    assignSenders: (batch, state) => assignBatch({ batch, input: input(state.leads, { lockedLeadIds: state.lockedLeadIds }) }),
    validateSelection: (lead, leadSender) => { validated.push(leadSender); return { ok: true }; },
    applyChanges: async list => list.map(({ lead, patch }) => { changes.push(patch.senderInboxId); return { leadId: lead.id, status: 'succeeded' }; }),
    appendActivities: async () => {},
  });
  assert.equal(result.status, undefined);
  assert.equal(result.succeeded, 30);
  assert.deepEqual(validated, changes, 'each lead is validated against the inbox it will receive');
  const counts = changes.reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});
  assert.equal(new Set(changes).size, 5, 'spread across every eligible inbox');
  assert.ok(counts.primary >= counts.deniels && counts.tryscalelabai >= counts.deniels_tryscalelabai);
  assert.equal(Object.keys(result.assignedSenders).length, 30);
});

test('auto refuses the whole batch when any lead has no compatible inbox', async () => {
  const leads = [staffing('', { stage: 'Import' }), staffing('', { stage: 'Import' })];
  let wrote = false;
  const result = await queueSelectedLeads({ ...REQUEST, ids: leads.map(lead => lead.id) }, {
    loadState: async () => ({ leads, ...STAFFING_RENDER_OPTIONS }),
    assignSenders: () => ({ assignments: new Map(), refused: [{ leadId: leads[1].id, reason: 'no active compatible sending inbox' }] }),
    validateSelection: () => ({ ok: true }),
    applyChanges: async () => { wrote = true; return []; },
  });
  assert.equal(result.status, 422);
  assert.equal(wrote, false);
});

test('auto without an assigner fails closed', async () => {
  const leads = [staffing('', { stage: 'Import' })];
  const result = await queueSelectedLeads({ ...REQUEST, ids: [leads[0].id] }, {
    loadState: async () => ({ leads, ...STAFFING_RENDER_OPTIONS }), validateSelection: () => ({ ok: true }),
    applyChanges: async () => { throw new Error('must not write'); },
  });
  assert.equal(result.status, 422);
});

test('a named inbox still applies to every selected lead', async () => {
  const leads = Array.from({ length: 3 }, () => staffing('', { stage: 'Import' }));
  const senders = [];
  await queueSelectedLeads({ ...REQUEST, senderInboxId: 'scalelabaiteam', ids: leads.map(lead => lead.id) }, {
    loadState: async () => ({ leads, ...STAFFING_RENDER_OPTIONS }), validateSelection: () => ({ ok: true }),
    applyChanges: async list => list.map(({ lead, patch }) => { senders.push(patch.senderInboxId); return { leadId: lead.id, status: 'succeeded' }; }),
    appendActivities: async () => {},
  });
  assert.deepEqual(senders, ['scalelabaiteam', 'scalelabaiteam', 'scalelabaiteam']);
});

test('the follow-up horizon is the end of the next Pacific send day', () => {
  assert.equal(new Date(nextSendDayHorizon(new Date('2026-09-29T18:59:00.000Z'))).toISOString(), '2026-09-30T18:59:59.000Z', 'after 11:30 PT → tomorrow');
  assert.equal(new Date(nextSendDayHorizon(new Date('2026-09-29T13:40:00.000Z'))).toISOString(), '2026-09-29T18:59:59.000Z', '06:40 PT → today');
  assert.equal(new Date(nextSendDayHorizon(new Date('2026-10-02T20:00:00.000Z'))).toISOString(), '2026-10-05T18:59:59.000Z', 'Friday afternoon → Monday');
});
