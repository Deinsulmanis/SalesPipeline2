'use strict';

// The one-off Smili repair, driven entirely through its own pure planners.
//
// The ordering is the safety property under test. Phase 4 makes Midtown's pair
// re-derivable again, so if it could run before phase 1 had locked the leads,
// the next sender repair would send a booking link on top of an email the
// operator already sent by hand. Each phase therefore refuses until the earlier
// ones are visible in live state, not merely reported as done.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MANIFEST, DEMO_PLAY_ROWS, PROVEN_LEAD_ID, LEAD_TOKEN,
  resolveLeads, planIntentFired, planAttestedOutbound, planRetractions,
  planTokenBackfill, verificationReport, cleanCompanyName,
} = require('../scripts/smili-demo-pair-repair');
const { buildDemoPairActivity, demoPairEventFor } = require('../integrations/demo-intent-state');

const COMPANY = {
  mstpu1fb8hj6s3dhrwx: 'Smili Dental - Midtown',
  mstpw5pp8boj0xk97wy: 'Smili Dental - Powell River',
  mstpw6d2e1kmio8rhl: 'Smili Dental - Pine Centre Mall',
  mstpw6d2tkpq0wka76: 'Smili Dental - Southridge',
};
const PLAY = {
  intro: 1, demo: 1,
  introPlayedAt: '2026-09-14T18:40:29.887Z',
  demoPlayedAt: '2026-09-14T18:40:43.453Z',
  last: '2026-09-14T18:40:43.453Z',
};
const RETRACTED_AT = '2026-09-15T21:00:00.000Z';

const cold = () => MANIFEST.map(entry => ({
  id: entry.leadId, company: COMPANY[entry.leadId], email: entry.email,
  senderInboxId: '', campaign: 'BC Dentists — 33 Cities — Aug 2026', stage: 'Contacted', emailStatus: 'emailed',
}));
// The four false-and-true pairs exactly as the fan-out wrote them.
const pairs = () => cold().map(lead => buildDemoPairActivity(lead, PLAY));
const firedHeader = ['firedAt', 'leadId', 'company', 'email', 'trigger'];
const firedRowsFor = leadIds => [firedHeader, ...leadIds.map(id => {
  const entry = MANIFEST.find(item => item.leadId === id);
  return [entry.sentAt, id, 'Smili Dental', entry.email, 'both-audios'];
})];
const outboundFor = leadIds => leadIds.map(id => {
  const entry = MANIFEST.find(item => item.leadId === id);
  return {
    eventId: `gmail-outbound:${entry.gmailMessageId}`, leadId: `CE-${id}`, sourceLeadId: id,
    email: entry.email, company: COMPANY[id], eventType: 'human_response_sent',
    occurredAt: entry.sentAt, metadata: JSON.stringify({ gmailMessageId: entry.gmailMessageId }),
  };
});
const allIds = MANIFEST.map(entry => entry.leadId);
const falseIds = allIds.filter(id => id !== PROVEN_LEAD_ID);

function demoRows({ token = '', ip = null, timestamp = null } = {}) {
  const rows = [['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type', 'lead_token']];
  while (rows.length < DEMO_PLAY_ROWS[0].row - 1) rows.push(['2026-08-01T00:00:00.000Z', 'Other Clinic', 'Dentist', '1.2.3.4', 'ua', 'demo', '']);
  for (const expected of DEMO_PLAY_ROWS) {
    rows.push([timestamp || expected.timestamp, 'Smili Dental', 'Dental clinic', ip || expected.ip, 'Chrome', expected.audioType, token]);
  }
  return rows;
}

test('phase 1 locks all four leads with the real manual send times, once', () => {
  const plan = planIntentFired(resolveLeads(cold()), [firedHeader]);
  assert.equal(plan.writes.length, 4);
  assert.equal(plan.refusals.length, 0);
  for (const write of plan.writes) {
    const entry = MANIFEST.find(item => item.leadId === write.leadId);
    assert.deepEqual(write.row, [entry.sentAt, entry.leadId, 'Smili Dental', entry.email, 'both-audios']);
  }
  // Replay writes nothing.
  const replay = planIntentFired(resolveLeads(cold()), firedRowsFor(allIds));
  assert.equal(replay.writes.length, 0);
  assert.equal(replay.skipped.length, 4);
});

test('phase 1 refuses a lead whose identity has moved', () => {
  const moved = cold().map(lead => (lead.id === PROVEN_LEAD_ID ? { ...lead, email: 'someone-else@example.test' } : lead));
  const plan = planIntentFired(resolveLeads(moved), [firedHeader]);
  assert.equal(plan.writes.length, 3);
  assert.match(plan.refusals[0].refusal, /now holds/);
});

test('phase 2 records the four manual sends as attested human outbound, never as automation', () => {
  const plan = planAttestedOutbound(resolveLeads(cold()), pairs());
  assert.equal(plan.writes.length, 4);
  for (const { leadId, activity } of plan.writes) {
    const entry = MANIFEST.find(item => item.leadId === leadId);
    assert.equal(activity.eventType, 'human_response_sent');
    assert.equal(activity.eventId, `gmail-outbound:${entry.gmailMessageId}`);
    assert.equal(activity.metadata.gmailThreadId, entry.gmailThreadId);
    assert.equal(activity.metadata.attested, true);
    assert.equal(activity.metadata.isProspectReply, false);
    assert.notEqual(activity.eventType, 'booking_link_sent');
  }
});

test('phase 2 is idempotent against an already recorded message', () => {
  const plan = planAttestedOutbound(resolveLeads(cold()), [...pairs(), ...outboundFor(allIds)]);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 4);
});

test('phase 3 refuses every retraction until the lock and the manual send exist', () => {
  const unlocked = planRetractions(resolveLeads(cold()), pairs(), [firedHeader], { retractedAt: RETRACTED_AT });
  assert.equal(unlocked.writes.length, 0);
  assert.ok(unlocked.refusals.every(item => /phase 1/.test(item.refusal)));

  const lockedOnly = planRetractions(resolveLeads(cold()), pairs(), firedRowsFor(allIds), { retractedAt: RETRACTED_AT });
  assert.equal(lockedOnly.writes.length, 0);
  assert.ok(lockedOnly.refusals.every(item => /phase 2/.test(item.refusal)));
});

test('phase 3 retracts the three false pairs and never the proven one', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  const plan = planRetractions(resolveLeads(cold()), activities, firedRowsFor(allIds), { retractedAt: RETRACTED_AT });
  assert.equal(plan.writes.length, 3);
  assert.deepEqual(plan.writes.map(item => item.leadId).sort(), [...falseIds].sort());
  assert.ok(plan.skipped.some(item => item.leadId === PROVEN_LEAD_ID && /token proves/.test(item.reason)));
  for (const { leadId, activity } of plan.writes) {
    assert.equal(activity.eventType, 'demo_pair_retracted');
    const metadata = JSON.parse(activity.metadata);
    assert.equal(metadata.retractsEventId, `demo-pair:${leadId}`);
    assert.equal(metadata.provenLeadId, PROVEN_LEAD_ID);
    assert.equal(metadata.leadToken, LEAD_TOKEN);
    assert.match(metadata.reason, /62506e874e/);
  }
});

test('phase 3 requires an explicit retraction instant and replays cleanly', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  assert.throws(() => planRetractions(resolveLeads(cold()), activities, firedRowsFor(allIds), {}), /retracted at/i);
  const first = planRetractions(resolveLeads(cold()), activities, firedRowsFor(allIds), { retractedAt: RETRACTED_AT });
  const applied = [...activities, ...first.writes.map(item => item.activity)];
  const replay = planRetractions(resolveLeads(cold()), applied, firedRowsFor(allIds), { retractedAt: RETRACTED_AT });
  assert.equal(replay.writes.length, 0);
  assert.equal(replay.skipped.filter(item => /already retracted/.test(item.reason)).length, 3);
});

test('phase 4 refuses while any lead is unlocked', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  const plan = planTokenBackfill(resolveLeads(cold()), demoRows(), activities, firedRowsFor(falseIds));
  assert.ok(plan.refusals.some(item => item.leadId === PROVEN_LEAD_ID));
});

test('phase 4 refuses when the play rows no longer carry the evidence', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  const resolved = resolveLeads(cold());
  const movedIp = planTokenBackfill(resolved, demoRows({ ip: '9.9.9.9' }), activities, firedRowsFor(allIds));
  assert.ok(movedIp.refusals.some(item => /evidence no longer matches/.test(item.refusal)));
  const movedTime = planTokenBackfill(resolved, demoRows({ timestamp: '2026-01-01T00:00:00.000Z' }), activities, firedRowsFor(allIds));
  assert.ok(movedTime.refusals.some(item => /evidence no longer matches/.test(item.refusal)));
});

test('phase 4 stamps exactly the two play rows, and never twice', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  const resolved = resolveLeads(cold());
  const plan = planTokenBackfill(resolved, demoRows(), activities, firedRowsFor(allIds));
  assert.equal(plan.refusals.length, 0);
  assert.deepEqual(plan.writes, [
    { range: 'DemoPlays!G42', value: LEAD_TOKEN },
    { range: 'DemoPlays!G43', value: LEAD_TOKEN },
  ]);
  const replay = planTokenBackfill(resolved, demoRows({ token: LEAD_TOKEN }), activities, firedRowsFor(allIds));
  assert.equal(replay.writes.length, 0);
  assert.equal(replay.skipped.length, 2);
});

test('the finished state answers the operator checklist', () => {
  const activities = [...pairs(), ...outboundFor(allIds)];
  const retractions = planRetractions(resolveLeads(cold()), activities, firedRowsFor(allIds), { retractedAt: RETRACTED_AT })
    .writes.map(item => item.activity);
  const done = [...activities, ...retractions];
  const report = verificationReport(resolveLeads(cold()), done, firedRowsFor(allIds), demoRows({ token: LEAD_TOKEN }));

  assert.equal(report.onlyProvenLeadIsDemoEngaged, true);
  assert.equal(report.allManualSendsRecorded, true);
  assert.equal(report.allLockedAgainstResend, true);
  assert.equal(report.nonePending, true);
  assert.equal(report.noSyntheticBookingLink, true);
  assert.equal(report.playRowsCarryToken, true);

  const midtown = report.leads.find(item => item.leadId === PROVEN_LEAD_ID);
  assert.equal(midtown.demoEngaged, true);
  for (const other of report.leads.filter(item => item.leadId !== PROVEN_LEAD_ID)) {
    assert.equal(other.demoEngaged, false);
  }
  // The retraction did not invent a delivery: Midtown's own pair still stands.
  assert.ok(demoPairEventFor(cold()[0], done));
});

test('the repair has no send path and cannot write without explicit confirmation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smili-demo-pair-repair.js'), 'utf8');
  for (const forbidden of ['messages.send', 'deliverHardenedWarmReply', 'deliverProspectReply', 'sendMail', 'gmail(']) {
    assert.ok(!src.includes(forbidden), `the repair must not reach a provider: ${forbidden}`);
  }
  assert.ok(src.includes("if (apply && !confirmed) throw new Error('--apply requires --confirm-no-send')"));
  assert.ok(src.includes("scopes: [apply ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly']"),
    'a dry run must hold a read-only Sheets scope');
  assert.ok(!/values\.(clear|batchClear)|deleteDimension/.test(src), 'the repair must never delete a row');
});

test('the company written into IntentFired matches what the agent writes', () => {
  assert.equal(cleanCompanyName('Smili Dental - Midtown'), 'Smili Dental');
  assert.equal(cleanCompanyName('Smili Dental'), 'Smili Dental');
});
