'use strict';

// Phase 2.3 runtime hardening — making manual Gmail replies visible.
//
// The failure this prevents: a person answers a prospect from their inbox, the
// CRM never learns, and automation keeps acting on a conversation it cannot see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HUMAN_OUTBOUND_EVENT, MATCH, OUTCOME,
  outboundEventId, planOutboundActivity, planHumanOutboundIngestion, latestHumanOutboundAt,
} = require('../integrations/human-outbound');
const { deriveAutomationOwnership, OWNER } = require('../integrations/automation-ownership');
const { buildReplyMetrics, buildReplyRecords } = require('../integrations/reply-analytics');
const { LEGACY_REPLY_EVENT_TYPES } = require('../integrations/canonical-reply');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const LEAD = { id: 'L', company: 'Test Clinic', email: 'lead@clinic.test', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '' };
const ctx = (over = {}) => ({
  leadsByEmail: new Map([['lead@clinic.test', LEAD]]),
  leadIdByThread: new Map([['t-known', LEAD]]),
  existingActivitiesByLead: new Map(),
  threadsWithInbound: new Set(['t-known', 't-reply']),
  ...over,
});
const msg = (over = {}) => ({
  id: 'gm-1', threadId: 't-reply', to: ['lead@clinic.test'],
  subject: 'Re: your note', sentAt: '2026-08-27T21:07:00.000Z', ...over,
});

test('a manual reply becomes canonical human_response_sent evidence', () => {
  const plan = planOutboundActivity(msg(), ctx());
  assert.equal(plan.outcome, OUTCOME.PROPOSED);
  assert.equal(plan.activity.eventType, HUMAN_OUTBOUND_EVENT);
  assert.equal(plan.activity.eventId, outboundEventId('gm-1'));
  const meta = plan.activity.metadata;
  assert.equal(meta.provider, 'gmail');
  assert.equal(meta.gmailMessageId, 'gm-1');
  assert.equal(meta.gmailThreadId, 't-reply');
  assert.equal(meta.direction, 'outbound');
  assert.equal(meta.actor, 'human');
  assert.equal(meta.isProspectReply, false);
  assert.equal(plan.activity.occurredAt, '2026-08-27T21:07:00.000Z', 'the provider timestamp, never invented');
});

test('replaying the same Gmail message writes nothing', () => {
  const recorded = new Map([['L', [{ eventId: outboundEventId('gm-1'), metadata: '{}' }]]]);
  assert.equal(planOutboundActivity(msg(), ctx({ existingActivitiesByLead: recorded })).outcome, OUTCOME.ALREADY_RECORDED);
  const viaMeta = new Map([['L', [{ eventId: 'other', metadata: JSON.stringify({ gmailMessageId: 'gm-1' }) }]]]);
  assert.equal(planOutboundActivity(msg(), ctx({ existingActivitiesByLead: viaMeta })).outcome, OUTCOME.ALREADY_RECORDED);

  const report = planHumanOutboundIngestion([msg(), msg()], ctx());
  assert.equal(report.duplicateEventIds, 0, 'one provider message can only produce one activity');
});

test('an outbound OPENER is never recorded as a human response', () => {
  // THE bug caught in the dry run: without this, every automated cold email in
  // the mailbox proposed a "human response", which would have marked the whole
  // campaign as personally answered and silently stopped outreach.
  const plan = planOutboundActivity(msg({ id: 'gm-cold', threadId: 't-cold-open' }), ctx());
  assert.equal(plan.outcome, OUTCOME.NOT_A_RESPONSE);
  assert.equal(plan.activity, null);
  assert.match(plan.reason, /outbound opener rather than a response/);
});

test('a human outbound message never becomes a prospect reply', () => {
  assert.ok(!LEGACY_REPLY_EVENT_TYPES.includes(HUMAN_OUTBOUND_EVENT));
  const plan = planOutboundActivity(msg(), ctx());
  assert.ok(!/_reply$/.test(plan.activity.eventType));
  assert.equal(plan.activity.metadata.isProspectReply, false);
});

test('reply analytics are unchanged by human outbound activity', () => {
  const leads = [{ id: 'L', email: 'lead@clinic.test', emailStatus: 'replied', notes: '[REPLY: Interested]' }];
  const inbound = { eventId: 'r1', sourceLeadId: 'L', eventType: 'positive_reply', occurredAt: '2026-08-10T00:00:00Z', content: 'yes', metadata: '{}' };
  const outbound = { eventId: outboundEventId('gm-1'), sourceLeadId: 'L', eventType: HUMAN_OUTBOUND_EVENT, occurredAt: '2026-08-11T00:00:00Z', content: '', metadata: '{}' };

  const withoutOutbound = new Map([['L', [inbound]]]);
  const withOutbound = new Map([['L', [inbound, outbound]]]);
  const before = buildReplyMetrics(leads, { activitiesByLeadId: withoutOutbound });
  const after = buildReplyMetrics(leads, { activitiesByLeadId: withOutbound });
  for (const key of ['totalReplies', 'positive', 'negative', 'needsHuman', 'unclassified', 'unknown']) {
    assert.equal(after[key], before[key], `${key} must not move`);
  }
  assert.equal(buildReplyRecords(leads, { activitiesByLeadId: withOutbound }).length, 1);
});

test('the latest human response flips ownership away from cold automation', () => {
  const question = {
    eventId: 'r1', sourceLeadId: 'L', eventType: 'needs_human_reply', occurredAt: '2026-08-10T10:00:00.000Z',
    metadata: JSON.stringify({ canonicalState: 'needs_human', reason: 'question_or_objection', gmailMessageId: 'm1' }),
  };
  const answered = [question, {
    eventId: outboundEventId('gm-1'), sourceLeadId: 'L', eventType: HUMAN_OUTBOUND_EVENT,
    occurredAt: '2026-08-11T09:00:00.000Z', metadata: JSON.stringify({ direction: 'outbound', actor: 'human' }),
  }];
  assert.equal(latestHumanOutboundAt(answered), '2026-08-11T09:00:00.000Z');
  assert.equal(latestHumanOutboundAt([question]), null);

  const before = deriveAutomationOwnership(LEAD, {
    activities: [question], suppressionReason: () => null, sendingEnabled: true, coldCadenceDue: true,
  });
  assert.equal(before.owner, OWNER.HUMAN, 'an unanswered question is human work');

  const after = deriveAutomationOwnership(LEAD, {
    activities: answered, humanTouchAt: latestHumanOutboundAt(answered),
    suppressionReason: () => null, sendingEnabled: true, coldCadenceDue: true,
  });
  // Answering a prospect must never hand the lead back to cold cadence.
  assert.equal(after.sendAllowed, false);
  assert.notEqual(after.owner, OWNER.COLD_AUTOMATION);
});

test('a message to a supplied decision-maker address is evidence, not an identity change', () => {
  // The real Coquitlam case: the reply went to manager@ccdentist.ca and matched
  // the lead by Gmail THREAD rather than by recipient.
  const plan = planOutboundActivity(
    msg({ id: 'gm-mgr', threadId: 't-known', to: ['manager@ccdentist.ca'] }), ctx());
  assert.equal(plan.outcome, OUTCOME.PROPOSED);
  assert.equal(plan.match, MATCH.PROVIDER_THREAD);
  assert.equal(plan.activity.email, LEAD.email, 'the canonical identity is untouched');
  assert.equal(plan.activity.metadata.sentToOtherAddress, 'manager@ccdentist.ca');
  assert.equal(plan.activity.metadata.identityMutationAllowed, false);
  assert.equal(plan.activity.metadata.autoSendAllowed, false);
});

test('matching is provider-backed only — no fuzzy, company or domain guessing', () => {
  const plan = planOutboundActivity(
    msg({ id: 'gm-x', threadId: 't-unknown', to: ['someoneelse@clinic.test'] }), ctx());
  assert.equal(plan.outcome, OUTCOME.NO_MATCH);
  assert.equal(plan.activity, null);
  const src = readSource(path.join(root, 'integrations', 'human-outbound.js'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['levenshtein', 'fuzzy', 'similar']) assert.ok(!code.includes(bad), `no ${bad} matching`);
});

test('a malformed lead identity cannot receive outbound evidence', () => {
  const bad = { ...LEAD, id: 'S', email: '-687-1887x@gmail.com' };
  const plan = planOutboundActivity(msg({ to: ['-687-1887x@gmail.com'] }), ctx({
    leadsByEmail: new Map([['-687-1887x@gmail.com', bad]]),
  }));
  assert.equal(plan.outcome, OUTCOME.UNUSABLE_IDENTITY);
  assert.equal(plan.activity, null);
});

test('ingestion writes nothing and touches no campaign attribution', () => {
  const report = planHumanOutboundIngestion([msg()], ctx());
  assert.equal(report.applied, false);
  assert.equal(report.mutatesProduction, false);
  const src = readSource(path.join(root, 'integrations', 'human-outbound.js'));
  for (const forbidden of ['values.update', 'values.append', 'batchUpdate', 'sendEmail', 'googleapis',
    'campaignVersion', 'acquisitionCampaignVersion']) {
    assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
  }
});

test('the runtime sender loads ownership context once, not per candidate', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  assert.match(agent, /async function readBoardLeads\(\)/);
  assert.match(agent, /function buildOwnershipContext\(\{/);
  assert.match(agent, /const \[ownershipBoard, ownershipActivities\] = await Promise\.all\(/);
  assert.match(agent, /context\.boardByLead\.get\(leadId\)/);
  assert.match(agent, /context\.activitiesByLead\.get\(leadId\)/);
  // A failed board read fails CLOSED rather than silently weakening the gate.
  assert.match(agent, /if \(context && !context\.boardAvailable\)/);
});

test('a queued lead already mailed by hand is refused by the provider-backed probe', () => {
  // ScaleLabAi: stage Queued, blank emailStatus, so ownership legitimately says
  // cold automation. The protection for an OPENER is the step-1 Gmail probe,
  // which asks the provider whether we already wrote to this address — and
  // fails closed when it cannot tell.
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  assert.match(agent, /q: `in:sent to:"\$\{safeEmail\}" newer_than:7d`/);
  assert.match(agent, /if \(probe !== 'clear'\) \{/);
  assert.match(agent, /cannot verify prior sends to \$\{lead\.email\} — failing closed/);
  // And the ownership gate runs BEFORE the probe, so both apply.
  assert.ok(agent.indexOf('const gate = coldSendGate(lead, ownershipContext);')
    < agent.indexOf('const probe = await withAuth(() => stepOneAlreadySent(lead));'));
});

// ── Agent-loop wiring ───────────────────────────────────────────────────────

test('outbound observation runs BEFORE send selection, and its writes are visible', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const at = needle => agent.indexOf(needle);
  // observe -> persist -> derive ownership -> select -> gate
  const observe = at('await withAuth(() => runHumanOutboundPass(all, ownershipActivities))');
  const derive = at('const ownershipContext = buildOwnershipContext({');
  const select = at('const queued = selectQueued(all)');
  const gate = agent.indexOf('const gate = coldSendGate(lead, ownershipContext)', select);
  for (const [name, index] of [['observe', observe], ['derive', derive], ['select', select], ['gate', gate]]) {
    assert.ok(index > 0, `${name} step is missing from the send pass`);
  }
  assert.ok(observe < derive, 'ownership must be derived AFTER the mailbox is observed');
  assert.ok(derive < select, 'context must exist before candidates are selected');
  assert.ok(select < gate, 'the gate runs on selected candidates');
  // A response recorded this cycle is pushed into the same activity list the
  // context is built from, so it counts without a re-read.
  assert.match(agent, /\(activitiesForCycle \|\| \[\]\)\.push\(/);
});

test('outbound observation runs before stage sequences and protects both send systems in the same cycle', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const observe = agent.indexOf('await withAuth(() => runHumanOutboundPass(all, ownershipActivities))');
  const sequences = agent.indexOf('await runStageSequencePass(all, { outboundObservationOk: outbound.ok })');
  const coldSelection = agent.indexOf('const queued = selectQueued(all)');

  assert.ok(observe >= 0 && sequences >= 0 && coldSelection >= 0);
  assert.ok(observe < sequences, 'manual Gmail outbound is persisted before sequence evaluation');
  assert.ok(sequences < coldSelection, 'sequence evaluation remains before ordinary cold selection');
  assert.match(agent, /async function runStageSequencePass\(allLeads, \{ outboundObservationOk = true \} = \{\}\)/);
  assert.match(agent, /if \(!outboundObservationOk\) \{[\s\S]{0,250}return 0;/,
    'a stale mailbox context fails sequence execution closed');
});

test('the demo-intent booking-link path also requires fresh canonical ownership', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const pass = agent.slice(agent.indexOf('async function runIntentTriggerPass'), agent.indexOf('// ── SELECTION'));
  assert.match(pass, /const gate = coldSendGate\(lead, ownershipContext\)/);
  assert.ok(pass.indexOf('coldSendGate(lead, ownershipContext)') < pass.indexOf('await sendEmail('));

  const intentOnly = agent.slice(agent.indexOf('if (INTENT_ONLY)'));
  assert.ok(intentOnly.indexOf('runHumanOutboundPass(all, intentActivities)')
    < intentOnly.indexOf('runIntentTriggerPass(all, intentOwnershipContext)'),
  'intent-only observes Gmail before evaluating its send trigger');
});

test('a failed Gmail observation fails closed for sends only', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  assert.match(agent, /return \{ ok: false, written: 0, error: error\.message \}/);
  assert.match(agent, /outboundObservationOk: outbound\.ok/);
  assert.match(agent, /manual outbound observation failed this pass — mailbox may be stale, failing closed/);
  // Reply/bounce passes run BEFORE observation, so they are unaffected by it.
  assert.ok(agent.indexOf('await runReplyCheckPass(all, todaySent)')
    < agent.indexOf('runHumanOutboundPass(all, ownershipActivities)'),
    'inbound handling must not depend on the outbound pass');
});

test('the observation is bounded: one list, no per-lead Gmail call', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const pass = agent.slice(agent.indexOf('async function runHumanOutboundPass'), agent.indexOf('function coldSendGate'));
  assert.match(pass, /q: `in:sent newer_than:\$\{HUMAN_OUTBOUND_LOOKBACK_DAYS\}d`/);
  assert.equal((pass.match(/users\.messages\.list/g) || []).length, 1, 'exactly one list call per cycle');
  // Threads are resolved only for messages that matched a lead, never per lead.
  assert.match(pass, /for \(const threadId of candidateThreads\)/);
  assert.ok(!/for \(const lead of leads\)[\s\S]{0,400}gmail\(\)/.test(pass), 'no per-lead Gmail call');
});

test('the cycle-fresh human touch reaches the send gate', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const gate = agent.slice(agent.indexOf('function coldSendGate'), agent.indexOf('function selectQueued'));
  assert.match(gate, /humanTouchAt: latestHumanOutboundAt\(activities\)/);
});
