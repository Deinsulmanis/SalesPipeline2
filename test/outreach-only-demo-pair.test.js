'use strict';

// An Outreach-only lead with a verified demo pair must remain eligible for its
// booking-link follow-up.
//
// Silver 7 Dental sat deferred with `no_eligible_journey` while every real safety
// gate passed: demo pair persisted, booking link not yet sent, no reply, no
// meeting, no suppression, no MANUAL HOLD, sender pinned and proven, quota
// available. It was refused for having no Pipeline stage — a stage it was never
// supposed to have, because it has no Pipeline card.
//
// The cause was `|| {}`. An empty object is truthy, so ownership read it as a
// board lead whose stage happened to be blank, took the pipeline_stage branch,
// found no journey defined for "" and answered human / no_eligible_journey.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveAutomationOwnership, OWNER, BLOCKED_BY } = require('../integrations/automation-ownership');
const { sendSuppressionReason } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');

/** Silver 7's real shape: contacted, step 1, no tags, Outreach-only. */
function outreachOnlyLead(overrides = {}) {
  return {
    id: 'mt9ka4dnwfgdo8rlbz', company: 'Silver 7 Dental', email: 'info@silver7dental.ca',
    stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
    lastEmailedAt: '2026-09-11T16:45:17.226Z', notes: 'enrichment note, no tags',
    senderInboxId: 'tryscalelabai', leadNiche: 'dental', campaign: 'Ontario List',
    emailTemplateId: 'dental-guarantee-v1', routingRequired: 'true',
    intendedCampaignVersion: 'dental_v3_pay_per_booking', ...overrides,
  };
}

const ownershipFor = (boardLead) => deriveAutomationOwnership(outreachOnlyLead(), {
  boardLead,
  activities: [
    { eventType: 'initial_email_sent', occurredAt: '2026-09-11T16:45:17.226Z' },
    { eventType: 'demo_pair_played', occurredAt: '2026-09-11T16:58:44.399Z' },
  ],
  callState: { status: 'none' },
  suppressionReason: row => sendSuppressionReason(row, { suppressedEmails: new Set() }),
  sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
});

test('an Outreach-only lead is owned by cold automation, not refused for a stage it has no card for', () => {
  const ownership = ownershipFor(null);
  assert.equal(ownership.owner, OWNER.COLD_AUTOMATION ?? 'cold_automation');
  assert.equal(ownership.sendAllowed, true);
  assert.equal(ownership.blockedBy, null);
  assert.equal(ownership.source, 'cold_cadence',
    'with no Pipeline card, ownership comes from cold cadence — not from a blank stage');
});

test('an EMPTY board object is what produced the false refusal', () => {
  // Pinned deliberately: this documents the defect, so a future refactor that
  // reintroduces `|| {}` fails here with the reason written next to it.
  const ownership = ownershipFor({});
  assert.equal(ownership.blockedBy, BLOCKED_BY.NO_ELIGIBLE_JOURNEY);
  assert.equal(ownership.owner, OWNER.HUMAN);
  assert.equal(ownership.source, 'pipeline_stage',
    'an empty object is truthy and is read as a board lead with a blank stage');
});

test('the hardened delivery path passes null, never an empty object', () => {
  const gate = agentSrc.slice(agentSrc.indexOf('async function deliverHardenedWarmReply'),
    agentSrc.indexOf('const senderCount = activeSenderCounts'));
  assert.ok(/const board = \(await readBoardLeads\(fresh\.board\)\)[\s\S]{0,200}?\|\| null;/.test(gate),
    'no Pipeline card must be reported as null, so ownership does not invent a blank stage');
  assert.ok(!/\|\| \{\};\s*\n\s*const callState = deriveCallLifecycle/.test(gate),
    'the empty-object form must not come back');
  assert.match(gate, /deriveCallLifecycle\(board,/,
    'call lifecycle still receives it; that function defaults internally');
});

test('a real Pipeline card still governs ownership', () => {
  // The fix must not make the board irrelevant — only absent-means-absent.
  const withCard = ownershipFor({ id: 'CE-mt9ka4dnwfgdo8rlbz', email: 'info@silver7dental.ca', stage: 'call_booked' });
  assert.notEqual(withCard.source, 'cold_cadence',
    'a lead with a real Pipeline stage is still governed by that stage');
});

test('the demo pair still suppresses ordinary cold follow-up', () => {
  // The booking link owns the next touch; Email #2/#3 must not race it.
  const { hasUndeliveredDemoPair } = require('../integrations/demo-intent-state');
  const lead = outreachOnlyLead();
  const activities = [
    { sourceLeadId: lead.id, eventType: 'demo_pair_played', occurredAt: '2026-09-11T16:58:44.399Z' },
  ];
  assert.equal(hasUndeliveredDemoPair(lead, activities), true);
  assert.match(agentSrc, /if \(hasUndeliveredDemoPair\(l, activities\)\) return false;/,
    'selectFollowUps must still exclude a lead with a pending demo pair');
});

test('a delivered booking link ends the pending state, so no duplicate is possible', () => {
  const { hasUndeliveredDemoPair } = require('../integrations/demo-intent-state');
  const lead = outreachOnlyLead();
  const delivered = [
    { sourceLeadId: lead.id, eventType: 'demo_pair_played', occurredAt: '2026-09-11T16:58:44.399Z' },
    { sourceLeadId: lead.id, eventType: 'booking_link_sent', occurredAt: '2026-09-11T17:10:00.000Z' },
  ];
  assert.equal(hasUndeliveredDemoPair(lead, delivered), false);
});
