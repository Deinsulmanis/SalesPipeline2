'use strict';

// Incident repair, Smili Dental — a demo pair written by company-name fan-out is
// RETRACTED, never deleted.
//
// One visitor opened one proposal link (/p/62506e874e, Smili Dental - Midtown)
// and played both clips. The attribution then in production matched DemoPlays
// rows to leads by cleaned company name, so that single listening session
// persisted a canonical demo pair for all FOUR Smili locations. Three of those
// four events are false.
//
// Deleting them would destroy the only record of what the fan-out did, so a
// retraction supersedes instead: it names the event id it cancels, the original
// stays on the timeline as evidence, and every consumer that asks "is there a
// demo pair" gets the corrected answer from one shared rule.
//
// The recreate-loop is the hazard this has to avoid. The agent skips creating a
// pair when one already exists; if a retraction made the pair look absent, the
// next three-minute pass would simply write it again. So "is there an ACTIVE
// pair" (delivery, next action, funnel) and "has this lead ever had a pair"
// (creation guard) are deliberately different questions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEMO_PAIR_EVENT, DEMO_PAIR_RETRACTED_EVENT,
  buildDemoPairActivity, buildDemoPairRetraction,
  demoPairEventFor, hasDemoPairHistory, hasUndeliveredDemoPair,
  activeDemoPairEvents,
} = require('../integrations/demo-intent-state');
const { scoreColdCallLead } = require('../integrations/cold-call-pipeline');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const lead = {
  id: 'mstpw5pp8boj0xk97wy', company: 'Smili Dental - Powell River',
  email: 'info@prsmili.test', senderInboxId: '', campaign: 'BC Dentists',
};
const play = {
  intro: 1, demo: 1,
  introPlayedAt: '2026-09-14T18:40:29.887Z',
  demoPlayedAt: '2026-09-14T18:40:43.453Z',
  last: '2026-09-14T18:40:43.453Z',
};
const pair = buildDemoPairActivity(lead, play);
const REASON = 'company-name fan-out: lead token 62506e874e attributes this play to Smili Dental - Midtown alone';
const retraction = buildDemoPairRetraction(lead, pair, {
  reason: REASON,
  retractedAt: '2026-09-15T20:00:00.000Z',
  evidence: { demoPlaysRows: [42, 43], proposalOpensRow: 220, provenLeadId: 'mstpu1fb8hj6s3dhrwx' },
});

test('a retraction supersedes the pair it names, everywhere that asks', () => {
  assert.equal(demoPairEventFor(lead, [pair]).eventId, pair.eventId);
  assert.equal(hasUndeliveredDemoPair(lead, [pair]), true);

  assert.equal(demoPairEventFor(lead, [pair, retraction]), null);
  assert.equal(hasUndeliveredDemoPair(lead, [pair, retraction]), false);
  assert.deepEqual(activeDemoPairEvents([pair, retraction]), []);
});

test('the original event is preserved, so the lead still has pair HISTORY', () => {
  // This is what stops the agent rewriting the event on the next pass.
  assert.equal(hasDemoPairHistory(lead, [pair, retraction]), true);
  assert.equal(hasDemoPairHistory(lead, []), false);
  assert.ok([pair, retraction].some(row => row.eventType === DEMO_PAIR_EVENT));
});

test('a retraction only cancels the exact event id it names', () => {
  const otherPair = buildDemoPairActivity({ ...lead, id: 'OTHER' }, play);
  assert.equal(activeDemoPairEvents([otherPair, retraction]).length, 1);
  const strayRetraction = { ...retraction, metadata: JSON.stringify({ retractsEventId: 'demo-pair:SOMEONE-ELSE' }) };
  assert.equal(activeDemoPairEvents([pair, strayRetraction]).length, 1);
  const unparseable = { ...retraction, metadata: '{not json' };
  assert.equal(activeDemoPairEvents([pair, unparseable]).length, 1);
});

test('the retraction is replay-safe and carries why it was written', () => {
  const again = buildDemoPairRetraction(lead, pair, { reason: REASON, retractedAt: '2026-09-15T20:00:00.000Z' });
  assert.equal(retraction.eventId, `retract:${pair.eventId}`);
  assert.equal(again.eventId, retraction.eventId);
  assert.equal(retraction.eventType, DEMO_PAIR_RETRACTED_EVENT);
  assert.equal(retraction.sourceLeadId, lead.id);
  assert.equal(retraction.leadId, `CE-${lead.id}`);
  assert.equal(retraction.occurredAt, '2026-09-15T20:00:00.000Z');
  assert.equal(retraction.content, '');
  const metadata = JSON.parse(retraction.metadata);
  assert.equal(metadata.retractsEventId, pair.eventId);
  assert.equal(metadata.reason, REASON);
  assert.equal(metadata.trigger, 'attribution_retraction');
  assert.equal(metadata.provenLeadId, 'mstpu1fb8hj6s3dhrwx');
  assert.deepEqual(metadata.demoPlaysRows, [42, 43]);
});

test('a retraction cannot be written without a target event or a stated reason', () => {
  assert.throws(() => buildDemoPairRetraction(lead, { eventId: '' }, { reason: REASON, retractedAt: 'x' }), /event id/i);
  assert.throws(() => buildDemoPairRetraction(lead, pair, { reason: '  ', retractedAt: 'x' }), /reason/i);
  assert.throws(() => buildDemoPairRetraction(lead, pair, { reason: REASON, retractedAt: '' }), /retracted/i);
});

test('a retracted pair scores no demo engagement on the pipeline card', () => {
  const sent = { eventType: 'initial_email_sent' };
  assert.equal(scoreColdCallLead({}, [sent, pair]), 45);          // 10 base + 10 sent + 25 demo
  assert.equal(scoreColdCallLead({}, [sent, pair, retraction]), 20); // demo no longer counts
});

test('the agent guards CREATION on pair history, not on the active pair', () => {
  // Otherwise a retraction is an instruction to write the same event again.
  const agent = source('outreach-agent.js');
  const creation = agent.slice(agent.indexOf('Persist the prospect fact before evaluating any delivery gate'),
    agent.indexOf('const due = []'));
  assert.ok(creation.includes('hasDemoPairHistory(lead, activities)'),
    'the creation guard must treat a retracted pair as already handled');
  assert.ok(!creation.includes('demoPairEventFor(lead, activities)'),
    'the creation guard must not ask for the ACTIVE pair, which a retraction empties');
  assert.ok(agent.includes('hasDemoPairHistory'), 'the agent must import the history check');
});

test('the last-moment send check refuses a retracted pair', () => {
  const agent = source('outreach-agent.js');
  const validate = agent.slice(agent.indexOf('validateFresh: async ({ fresh, current, mine, currentRows })'),
    agent.indexOf('canonical_demo_pair_missing') + 200);
  assert.ok(validate.includes('demoPairEventFor(current, mine)'),
    'revalidation must use the retraction-aware reader');
  assert.ok(!validate.includes("mine.some(row => row.eventType === DEMO_PAIR_EVENT)"),
    'a raw event-type scan cannot see a retraction and would send on false evidence');
});

test('funnel analytics counts only active pairs', () => {
  const funnel = source('integrations/funnel-analytics.js');
  assert.ok(funnel.includes('activeDemoPairEvents('),
    'the demo funnel stage must exclude retracted pairs');
  assert.ok(!funnel.includes("rows.filter(row => row.eventType === 'demo_pair_played')"),
    'a raw event-type filter would keep counting a retracted pair as demo engagement');
});

test('the retraction is a first-class timeline event, not an unlabelled row', () => {
  const timeline = source('integrations/activity-timeline.js');
  assert.ok(timeline.includes("case 'demo_pair_retracted'"), 'the timeline must label the retraction');
  assert.ok(/demo_pair_retracted: '(Demo|CRM)'/.test(timeline), 'the retraction needs a source attribution');
  assert.ok(source('public/index.html').includes('demo_pair_retracted:'), 'the browser needs the label too');
});
