'use strict';

// Jole v5 demand-signal modes (2026-11-13): award and expansion.
//   - render their approved three touches, naming only the verified event;
//   - pin the event through the ledger like a hiring claim (role = event,
//     site = short form), so a started thread keeps its wording;
//   - fall to general_craft when the evidence is older than 30 days, and that
//     fallback never names the event;
//   - v4 (rollback only) refuses them rather than rendering nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setJoleClassificationForTests, jolePersonalizationFor } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail } = require('../integrations/clients/client-email');
const { renderJoleEmployerStepV4, renderJoleEmployerStepV5, validateJoleEmployerEmailV5, SENDABLE_MODES } = require('../integrations/clients/jole-copy');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');

const ENV = Object.freeze({ JOLE_COMMERCIAL_MAILING_ADDRESS: '2738 Dallas Ave, Ingleside, TX 78362' });
const NOW = Date.parse('2026-11-13T13:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const lead = (id, extra = {}) => ({
  id, company: 'Sealevel Construction', contactName: 'Pat Rivera', email: `pat.${id.toLowerCase()}@sealevelinc.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', clientId: 'jole',
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow({
    first_name: 'Pat', last_name: 'Rivera', title: 'President', company_domain: 'sealevelinc.com',
  }) })),
  ...extra,
});
const contacted = { stage: 'Contacted', emailStatus: 'emailed', emailStep: 1, lastEmailedAt: '2026-11-13T15:30:00Z' };
const touch1 = (id, mode, role, site) => [{
  eventId: `t1-${id}`, sourceLeadId: id, eventType: 'initial_email_sent', occurredAt: '2026-11-13T15:30:00Z',
  metadata: JSON.stringify({ copyVersion: 'jole_industrial_employer_v5', personalizationMode: mode, personalizationRole: role, personalizationSite: site }),
}];
const render = (l, step, activities = [], now = NOW) => renderClientLeadEmail(l, step, { env: ENV, now, activities });
const EVIDENCE = { evidenceUrl: 'https://www.usaspending.gov/award/CONT_AWD_W912EK25C0018', publicPageChecked: true, evidenceCheckedAt: '2026-11-13' };
const AWARD = { mode: 'award', event: 'the Lock and Dam 21 tainter gate fabrication for the Corps', eventShort: 'the Lock and Dam 21 gate work', ...EVIDENCE };
const EXPANSION = { mode: 'expansion', event: "Sargent Metal's Anderson plant expansion", eventShort: 'the Anderson expansion', ...EVIDENCE,
  evidenceUrl: 'https://www.independentmail.com/story/news/2025/11/19/sargent-metal' };

test.afterEach(() => setJoleClassificationForTests(null));

test('both signal modes are sendable', () => {
  assert.ok(SENDABLE_MODES.includes('award'));
  assert.ok(SENDABLE_MODES.includes('expansion'));
});

test('award: three approved touches, naming only the verified event', () => {
  setJoleClassificationForTests({ A1: AWARD });
  const t1 = render(lead('A1'), 1);
  assert.equal(t1.subject, 'the Lock and Dam 21 gate work');
  assert.match(t1.body, /Saw Sealevel Construction picked up the Lock and Dam 21 tainter gate fabrication for the Corps\./);
  assert.match(t1.body, /Will your own crew cover that work, or would contract tradespeople help during the peak\?/);
  assert.doesNotMatch(t1.body, /hiring|opening|posting/i);
  const t2 = render(lead('A1', contacted), 2, touch1('A1', 'award', AWARD.event, AWARD.eventShort));
  assert.match(t2.body, /As the Lock and Dam 21 gate work ramps up, are you planning to add to your crew/);
  const t3 = render(lead('A1', { ...contacted, emailStep: 2 }), 3, touch1('A1', 'award', AWARD.event, AWARD.eventShort));
  assert.doesNotMatch(t3.body, /Lock and Dam/);
  assert.match(t3.body, /are you the one who handles bringing in outside tradespeople/);
});

test('expansion: three approved touches, naming only the verified event', () => {
  setJoleClassificationForTests({ E1: EXPANSION });
  const t1 = render(lead('E1', { company: 'Sargent Metal Fabricators' }), 1);
  assert.equal(t1.subject, 'the Anderson expansion');
  assert.match(t1.body, /Saw the news on Sargent Metal's Anderson plant expansion\./);
  assert.match(t1.body, /check which trades we could cover/);
  const t2 = render(lead('E1', { ...contacted, company: 'Sargent Metal Fabricators' }), 2, touch1('E1', 'expansion', EXPANSION.event, EXPANSION.eventShort));
  assert.match(t2.body, /With the Anderson expansion, are you adding skilled trades for a specific phase/);
});

test('a started signal thread keeps the event its first send recorded, even after the entry changes', () => {
  setJoleClassificationForTests({ A2: { ...AWARD, event: 'a different project', eventShort: 'the other job' } });
  const t2 = render(lead('A2', contacted), 2, touch1('A2', 'award', AWARD.event, AWARD.eventShort));
  assert.match(t2.body, /the Lock and Dam 21 gate work/);
  assert.doesNotMatch(t2.body, /other job/);
});

test('evidence older than 30 days falls to general_craft, which never names the event', () => {
  setJoleClassificationForTests({ A3: { ...AWARD, evidenceCheckedAt: '2026-10-01' }, E3: { ...EXPANSION, evidenceCheckedAt: '2026-10-01' } });
  for (const id of ['A3', 'E3']) {
    const resolved = jolePersonalizationFor(lead(id), [], { now: NOW });
    assert.equal(resolved.mode, 'general_craft');
    assert.match(resolved.reason, /older than 30 days/);
    assert.throws(() => render(lead(id), 1), /needs review/);
  }
  const later = jolePersonalizationFor(lead('A3'), [], { now: Date.parse('2026-11-13T00:00:00Z') + 31 * DAY });
  assert.ok(later.forbiddenRoles.includes(AWARD.event));
});

test('a signal entry without its own evidence fails closed', () => {
  setJoleClassificationForTests({ A4: { mode: 'award', event: AWARD.event, eventShort: AWARD.eventShort, evidenceCheckedAt: '2026-11-13' } });
  assert.throws(() => render(lead('A4'), 1), /needs review/);
});

test('validator: signal copy may not claim an opening or name a place outside its event', () => {
  const p = { mode: 'award', role: AWARD.event, location: AWARD.eventShort, company: 'Sealevel Construction' };
  const ok = renderJoleEmployerStepV5({ step: 1, firstName: 'Pat', company: 'Sealevel Construction', mailingAddress: ENV.JOLE_COMMERCIAL_MAILING_ADDRESS, personalization: p });
  assert.equal(validateJoleEmployerEmailV5(ok, 1, p), '');
  const hiring = { ...ok, coreBody: `${ok.coreBody}\nAlso saw you were hiring welders.` };
  assert.match(validateJoleEmployerEmailV5(hiring, 1, p), /must not claim a current opening/);
  const place = { ...ok, coreBody: `${ok.coreBody}\nNear Houma, LA.` };
  assert.match(validateJoleEmployerEmailV5(place, 1, p), /must not name a location outside its event/);
  const missing = { ...ok, subject: 'hello', coreBody: 'Hi Pat,\n\nQuick note.\n\nJorge' };
  assert.match(validateJoleEmployerEmailV5(missing, 1, p), /must name its verified event/);
});

test('v4 (rollback only) refuses the signal modes instead of rendering', () => {
  assert.throws(() => renderJoleEmployerStepV4({ step: 1, firstName: 'Pat', company: 'Sealevel', mailingAddress: ENV.JOLE_COMMERCIAL_MAILING_ADDRESS,
    personalization: { mode: 'award', role: AWARD.event, location: AWARD.eventShort } }), /v4 has no copy for mode award/);
});
