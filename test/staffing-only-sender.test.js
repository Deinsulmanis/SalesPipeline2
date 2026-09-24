'use strict';

// scalelabaiteam (deins@scalelabaiteam.com) exists only for US staffing-agency
// outreach. It may serve the staffing campaign's canonical niche and nothing
// else — whether routed dynamically, assigned by an operator, or pinned — and
// that must hold even if a registry override drops the staffingOnly flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseRegistry, withDefaultInboxes, isStaffingOnlySender } = require('../integrations/gmail-inbox-registry');
const { configuredSenders, chooseSender, allowedForLead } = require('../integrations/gmail-sender-routing');
const { validateRoute, normalizeNiche } = require('../integrations/campaign-routing');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const STAFFING = STAFFING_CAMPAIGN.niche;
const EXISTING = ['primary', 'tryscalelabai', 'deniels', 'deniels_tryscalelabai'];

// Production-shaped roster: primary + tryscalelabai (registry) active at 50/5,
// both deniels inboxes active via the runtime overlay at 10/2, and
// scalelabaiteam hypothetically active at its 40/5 code default.
function productionEnv({ registry, runtime } = {}) {
  return {
    FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50',
    GMAIL_INBOX_REGISTRY_JSON: JSON.stringify(registry || [
      { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 50 },
    ]),
    GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_DENIELS_TOKEN_JSON: '{}',
    GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
    GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(runtime || [
      { id: 'deniels', status: 'active' }, { id: 'deniels_tryscalelabai', status: 'active' },
      { id: 'scalelabaiteam', status: 'active' },
    ]),
  };
}
const roster = (options) => configuredSenders(productionEnv(options));
const byId = (senders, id) => senders.find(sender => sender.id === id);
// scalelabaiteam idle, everyone else busier: least-used would pick it if allowed.
const IDLE_TEAM = new Map([['primary', 30], ['tryscalelabai', 30], ['deniels', 5], ['deniels_tryscalelabai', 5], ['scalelabaiteam', 0]]);
const sent = (lead, senderInboxId, eventType = 'initial_email_sent') => ({
  eventType, sourceLeadId: lead.id, leadId: `CE-${lead.id}`, occurredAt: '2026-09-24T15:00:00Z',
  metadata: JSON.stringify({ senderInboxId }),
});

// Verbatim copy of allowedForLead at c4b5daf, before the staffing-only rule.
function legacyAllowedForLead(sender, lead = {}) {
  const niche = String(lead.leadNiche || lead.tradeType || '').toLowerCase();
  if (niche.includes('staffing')) return sender.sendEligible;
  if (niche.includes('dent')) return sender.sendEligible;
  return sender.id === 'primary' && sender.sendEligible;
}

test('fixture mirrors production: five senders, scalelabaiteam active at 40/5 and flagged staffing-only', () => {
  const senders = roster();
  assert.deepEqual(senders.map(sender => [sender.id, sender.sendEligible, sender.dailyLimit, sender.perRunLimit]), [
    ['primary', true, 50, 5], ['tryscalelabai', true, 50, 5], ['scalelabaiteam', true, 40, 5],
    ['deniels', true, 10, 2], ['deniels_tryscalelabai', true, 10, 2],
  ]);
  assert.equal(byId(senders, 'scalelabaiteam').staffingOnly, true);
  for (const id of EXISTING) {
    assert.equal(isStaffingOnlySender(byId(senders, id)), false, id);
    assert.equal('staffingOnly' in byId(senders, id), false, `${id} carries no new field`);
  }
});

test('dental: dynamic balancing never selects scalelabaiteam, even when it is the least-used inbox', () => {
  const senders = roster();
  const choice = chooseSender({ lead: { id: 'D1', tradeType: 'Dental' }, senders, sendsToday: IDLE_TEAM });
  assert.ok(choice.sender);
  assert.notEqual(choice.sender.id, 'scalelabaiteam');
  assert.equal(choice.sender.id, 'deniels');
  assert.equal(allowedForLead(byId(senders, 'scalelabaiteam'), { tradeType: 'Dental' }), false);
  assert.equal(allowedForLead(byId(senders, 'scalelabaiteam'), { leadNiche: 'dental' }), false);
});

test('dental: with every other inbox exhausted the lead waits instead of falling through to scalelabaiteam', () => {
  const senders = roster();
  const full = new Map([['primary', 50], ['tryscalelabai', 50], ['deniels', 10], ['deniels_tryscalelabai', 10], ['scalelabaiteam', 0]]);
  const choice = chooseSender({ lead: { id: 'D2', tradeType: 'Dental' }, senders, sendsToday: full });
  assert.equal(choice.sender, null);
  assert.equal(choice.reason, 'no eligible sender capacity');
  const windowOnly = new Map(senders.map(sender => [sender.id, sender.id === 'scalelabaiteam' ? 5 : 0]));
  assert.equal(chooseSender({ lead: { id: 'D3', tradeType: 'Dental' }, senders, windowRemainingBySender: windowOnly }).sender, null);
});

test('dental: an explicit assignment to scalelabaiteam fails closed', () => {
  assert.throws(() => chooseSender({
    lead: { id: 'D4', leadNiche: 'dental', senderInboxId: 'scalelabaiteam', routingRequired: 'true' },
    senders: roster(), sendsToday: IDLE_TEAM,
  }), /assigned sender scalelabaiteam is not delivery eligible/);
});

test('dental: pinned scalelabaiteam ownership evidence fails closed for a follow-up', () => {
  const lead = { id: 'D5', tradeType: 'Dental' };
  assert.throws(() => chooseSender({ lead, activities: [sent(lead, 'scalelabaiteam')], senders: roster(), step: 2 }),
    /pinned sender scalelabaiteam is not delivery eligible/);
});

test('roofing, blank, unknown and lookalike staffing niches are refused', () => {
  const team = byId(roster(), 'scalelabaiteam');
  for (const lead of [
    { tradeType: 'Roofing' }, { leadNiche: 'roofing' }, {}, { leadNiche: '' }, { leadNiche: 'plumbing' },
    { leadNiche: 'medical_staffing' }, { leadNiche: 'healthcare staffing' }, { tradeType: 'Staffing Dental Clinic' },
    { leadNiche: 'dental', tradeType: STAFFING },
  ]) {
    assert.equal(allowedForLead(team, lead), false, JSON.stringify(lead));
  }
  assert.equal(chooseSender({ lead: { id: 'R1', tradeType: 'Roofing' }, senders: roster(), sendsToday: IDLE_TEAM }).sender.id, 'primary');
});

test('industrial_staffing: an assigned lead routes to scalelabaiteam', () => {
  const choice = chooseSender({
    lead: { id: 'S1', leadNiche: STAFFING, senderInboxId: 'scalelabaiteam', routingRequired: 'true' },
    senders: roster(), sendsToday: IDLE_TEAM,
  });
  assert.equal(choice.sender.id, 'scalelabaiteam');
  assert.equal(choice.assigned, true);
  const team = byId(roster(), 'scalelabaiteam');
  // Only the LEAD_TYPES aliases that already normalise onto the canonical niche.
  for (const niche of [STAFFING, 'Industrial Staffing', 'staffing', 'Staffing Agency', 'staffing_agency']) {
    assert.equal(normalizeNiche(niche), STAFFING);
    assert.equal(allowedForLead(team, { leadNiche: niche }), true, niche);
  }
  assert.equal(allowedForLead(team, { tradeType: STAFFING }), true);
});

test('industrial_staffing: follow-ups stay pinned to scalelabaiteam', () => {
  const lead = { id: 'S2', leadNiche: STAFFING, senderInboxId: 'scalelabaiteam' };
  const choice = chooseSender({ lead, activities: [sent(lead, 'scalelabaiteam')], senders: roster(), sendsToday: IDLE_TEAM, step: 2 });
  assert.equal(choice.sender.id, 'scalelabaiteam');
  assert.equal(choice.pinned, true);
});

test('industrial_staffing: unassigned staffing is still refused rather than auto-balanced', () => {
  assert.throws(() => chooseSender({ lead: { id: 'S3', leadNiche: STAFFING }, senders: roster(), sendsToday: IDLE_TEAM }),
    /required sender assignment is missing/);
});

test('staffing-only does not bypass status: warming or paused scalelabaiteam still cannot send staffing', () => {
  for (const status of ['warming', 'ready', 'paused']) {
    const senders = roster({ runtime: [{ id: 'deniels', status: 'active' }, { id: 'deniels_tryscalelabai', status: 'active' }, { id: 'scalelabaiteam', status }] });
    assert.equal(byId(senders, 'scalelabaiteam').sendEligible, false, status);
    assert.throws(() => chooseSender({ lead: { id: 'S4', leadNiche: STAFFING, senderInboxId: 'scalelabaiteam' }, senders }),
      /not delivery eligible/, status);
  }
});

test('registry override for scalelabaiteam WITHOUT staffingOnly still refuses dental (fail-closed by identity)', () => {
  const override = [
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 50 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'active', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5 },
  ];
  const parsed = withDefaultInboxes(parseRegistry(JSON.stringify(override)));
  assert.equal(parsed.filter(entry => entry.id === 'scalelabaiteam').length, 1, 'override replaced the default');
  assert.equal('staffingOnly' in parsed.find(entry => entry.id === 'scalelabaiteam'), false, 'flag really is absent');
  const senders = roster({ registry: override, runtime: [] });
  const team = byId(senders, 'scalelabaiteam');
  assert.equal(team.sendEligible, true);
  assert.equal(isStaffingOnlySender(team), true);
  assert.notEqual(chooseSender({ lead: { id: 'D6', tradeType: 'Dental' }, senders, sendsToday: IDLE_TEAM }).sender?.id, 'scalelabaiteam');
  assert.throws(() => chooseSender({ lead: { id: 'D7', leadNiche: 'dental', senderInboxId: 'scalelabaiteam' }, senders }), /not delivery eligible/);
  assert.equal(chooseSender({ lead: { id: 'S5', leadNiche: STAFFING, senderInboxId: 'scalelabaiteam' }, senders }).sender.id, 'scalelabaiteam');
  // A renamed override that keeps the mailbox address is still staffing-only.
  const renamed = [{ id: 'team', email: 'deins@scalelabaiteam.com', status: 'active', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 40 }];
  const renamedRoster = roster({ registry: renamed, runtime: [] });
  assert.equal(byId(renamedRoster, 'team').sendEligible, true);
  assert.equal(allowedForLead(byId(renamedRoster, 'team'), { tradeType: 'Dental' }), false);
});

test('staffingOnly flag: only literal true enables it for another sender, and it restricts that sender', () => {
  const registry = (flag) => JSON.stringify([{ id: 'future', email: 'future@example.com', status: 'active', tokenEnv: 'GMAIL_FUTURE_TOKEN_JSON', dailyLimit: 10, ...(flag === undefined ? {} : { staffingOnly: flag }) }]);
  for (const flag of [undefined, false, 'true', 1, null]) {
    const [entry] = parseRegistry(registry(flag));
    assert.equal(isStaffingOnlySender(entry), false, String(flag));
  }
  const [flagged] = parseRegistry(registry(true));
  assert.equal(flagged.staffingOnly, true);
  const future = { ...flagged, sendEligible: true };
  assert.equal(allowedForLead(future, { tradeType: 'Dental' }), false);
  assert.equal(allowedForLead(future, { leadNiche: STAFFING }), true);
});

test('operator queue (validateRoute): dental to scalelabaiteam is refused, staffing is accepted, other inboxes unchanged', () => {
  // No staffingOnly key here on purpose: the gate must hold by identity alone.
  const inboxes = [
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', sendEligible: true, deliveryImplemented: true },
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', sendEligible: true, deliveryImplemented: true },
  ];
  const dentalToTeam = validateRoute({ niche: 'dental', senderInboxId: 'scalelabaiteam', emailTemplateId: 'dental-guarantee-v1', inboxes });
  assert.equal(dentalToTeam.ok, false);
  assert.match(dentalToTeam.reason, /reserved for staffing agency leads/);
  const roofingToTeam = validateRoute({ niche: 'roofing', senderInboxId: 'scalelabaiteam', emailTemplateId: 'roofing-survey-v1', inboxes, requireReady: false });
  assert.equal(roofingToTeam.ok, false);
  assert.equal(validateRoute({ niche: STAFFING, senderInboxId: 'scalelabaiteam', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, inboxes, requireReady: false }).ok, true);
  assert.equal(validateRoute({ niche: 'dental', senderInboxId: 'tryscalelabai', emailTemplateId: 'dental-guarantee-v1', inboxes }).ok, true);
  assert.equal(validateRoute({ niche: STAFFING, senderInboxId: 'tryscalelabai', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, inboxes, requireReady: false }).ok, true);
});

test('the four existing senders are behaviourally identical to c4b5daf', () => {
  const niches = [{ tradeType: 'Dental' }, { leadNiche: 'dental' }, { leadNiche: STAFFING }, { leadNiche: 'staffing agency' },
    { leadNiche: 'medical_staffing' }, { tradeType: 'Roofing' }, {}, { leadNiche: 'plumbing' }];
  for (const runtime of [undefined, []]) {
    for (const sender of roster({ runtime }).filter(item => EXISTING.includes(item.id))) {
      for (const eligible of [true, false]) {
        const probe = { ...sender, sendEligible: eligible };
        for (const lead of niches) {
          assert.equal(allowedForLead(probe, lead), legacyAllowedForLead(probe, lead), `${sender.id} ${eligible} ${JSON.stringify(lead)}`);
        }
      }
    }
  }
  // Dental balancing among the four is the same whether or not scalelabaiteam exists.
  const withTeam = roster();
  const withoutTeam = withTeam.filter(sender => sender.id !== 'scalelabaiteam');
  let seed = 7;
  const rand = max => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  for (let i = 0; i < 2000; i++) {
    const sendsToday = new Map([['primary', rand(52)], ['tryscalelabai', rand(52)], ['deniels', rand(12)], ['deniels_tryscalelabai', rand(12)], ['scalelabaiteam', rand(3)]]);
    const windowRemainingBySender = i % 2 ? new Map(withTeam.map(sender => [sender.id, rand(3)])) : null;
    const lead = { id: `E${i}`, tradeType: 'Dental' };
    const a = chooseSender({ lead, senders: withTeam, sendsToday, windowRemainingBySender });
    const b = chooseSender({ lead, senders: withoutTeam, sendsToday, windowRemainingBySender });
    assert.equal(a.sender?.id || null, b.sender?.id || null, `iteration ${i}`);
  }
  // Their follow-ups remain pinned to the original sender.
  for (const id of EXISTING) {
    const lead = { id: `F-${id}`, tradeType: 'Dental' };
    assert.equal(chooseSender({ lead, activities: [sent(lead, id)], senders: withTeam, step: 2 }).sender.id, id);
  }
});

test('operator inbox options expose the staffing-only identity', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('function gmailInboxOptions()');
  assert.ok(start > 0);
  assert.match(server.slice(start, start + 1200), /staffingOnly: isStaffingOnlySender\(sender\)/);
});
