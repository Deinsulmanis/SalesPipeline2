'use strict';

// Leads imported without hiring inputs (profile status needs_review: "no hiring
// location") render evidence-aware v5 copy only from what the reviewed
// classification, or the thread's first send, supports:
//   - a started neutral thread keeps rendering its Touches 2 and 3 (before this
//     fix every follow-up of such a lead failed closed);
//   - a fresh hiring-mode entry renders its exact / role_only claim;
//   - a stale hiring entry, a hold or an unclassified lead still fails closed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');

const ENV = Object.freeze({ JOLE_COMMERCIAL_MAILING_ADDRESS: '2738 Dallas Ave, Ingleside, TX 78362' });
const NOW = Date.parse('2026-11-13T13:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const lead = (id, extra = {}) => ({
  id, company: 'Gulf Fabrication', contactName: 'Pat Rivera', email: `pat.${id.toLowerCase()}@gulffab.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', clientId: 'jole',
  // No hiring site or role: the importer marks the profile needs_review ("no hiring location").
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow({
    first_name: 'Pat', last_name: 'Rivera', title: 'President', company_domain: 'gulffab.com',
  }) })),
  ...extra,
});
const contacted = { stage: 'Contacted', emailStatus: 'emailed', emailStep: 1, lastEmailedAt: '2026-11-12T15:30:00Z' };
const touch1 = (id, mode, role = null, site = null) => [{
  eventId: `t1-${id}`, sourceLeadId: id, eventType: 'initial_email_sent', occurredAt: '2026-11-12T15:30:00Z',
  metadata: JSON.stringify({ copyVersion: 'jole_industrial_employer_v5', personalizationMode: mode, personalizationRole: role, personalizationSite: site }),
}];
const render = (l, step, activities = [], now = NOW) => renderClientLeadEmail(l, step, { env: ENV, now, activities });

test.afterEach(() => setJoleClassificationForTests(null));

test('import-gap profile: the fixture really is needs_review with no hiring location', () => {
  const profile = JSON.parse(lead('X').campaign_notes);
  assert.equal(profile.personalization.status, 'needs_review');
  assert.equal(profile.personalization.reason, 'no hiring location');
});

test('a neutral lead renders all three touches before and after its first send', () => {
  setJoleClassificationForTests({ N1: { mode: 'general_craft', role: null, location: null } });
  for (const step of [1, 2, 3]) assert.equal(render(lead('N1'), step).personalization.mode, 'general_craft');
  for (const step of [2, 3]) {
    const email = render(lead('N1', contacted), step, touch1('N1', 'general_craft'));
    assert.equal(email.personalization.mode, 'general_craft');
    assert.doesNotMatch(email.body, /hiring/i);
  }
});

const EVIDENCE = { evidenceUrl: 'https://www.linkedin.com/jobs/view/1', publicPageChecked: true, evidenceCheckedAt: '2026-11-12' };

test('a fresh hiring entry with its own evidence renders its claim; its started thread keeps it', () => {
  setJoleClassificationForTests({ H1: { mode: 'exact', role: 'Welders', location: 'Quincy, IL', ...EVIDENCE } });
  const t1 = render(lead('H1'), 1);
  assert.equal(t1.subject, 'Welders in Quincy, IL');
  assert.match(t1.body, /Saw you were hiring Welders in Quincy, IL\./);
  const t2 = render(lead('H1', contacted), 2, touch1('H1', 'exact', 'Welders', 'Quincy, IL'));
  assert.match(t2.body, /Welders opening in Quincy, IL/);
});

test('a role_only entry names the role and never a place', () => {
  setJoleClassificationForTests({ R1: { mode: 'role_only', role: 'Welders', location: null, ...EVIDENCE, unsupportedLocations: ['Adelanto, CA'] } });
  const t1 = render(lead('R1'), 1);
  assert.equal(t1.subject, 'Welders');
  assert.doesNotMatch(t1.body, /Adelanto/);
});

test('still fails closed: no own evidence, stale evidence, a hold, an unclassified lead, a pinned claim the entry no longer backs', () => {
  setJoleClassificationForTests({
    S1: { mode: 'exact', role: 'Welders', location: 'Quincy, IL', ...EVIDENCE },
    NE1: { mode: 'exact', role: 'Welders', location: 'Quincy, IL', evidenceCheckedAt: '2026-11-12' },
    G1: { mode: 'general_craft', role: null, location: null },
    HOLD1: { mode: 'hold', role: null, location: null, reason: 'feasibility trigger' },
  });
  assert.throws(() => render(lead('NE1'), 1), /needs review/);
  assert.throws(() => render(lead('S1'), 1, [], NOW + 31 * DAY), /needs review/);
  assert.throws(() => render(lead('G1', contacted), 2, touch1('G1', 'exact', 'Welders', 'Quincy, IL')), /needs review/);
  assert.throws(() => render(lead('HOLD1'), 1), /needs review|hold/);
  assert.throws(() => render(lead('NOPE'), 1), /needs review|hold|not classified/);
});
