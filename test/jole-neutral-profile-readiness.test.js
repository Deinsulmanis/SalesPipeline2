'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail, clientPersonalizationState } = require('../integrations/clients/client-email');
const { queueEligibility } = require('../integrations/outreach-queue');
const ENV = { JOLE_COMMERCIAL_MAILING_ADDRESS: '2738 Dallas Ave, Ingleside, TX 78362' };
const NOW = Date.parse('2026-11-11T15:30:00Z');
const lead = extra => ({ id: 'neutral-review', clientId: 'jole', company: 'Example Machine Works',
  contactName: 'Pat Smith', email: 'pat@examplemachine.com', stage: 'Import', emailStatus: '', emailStep: '',
  lastEmailedAt: '', notes: '', campaign: 'jole-btx-employer-acquisition', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign_notes: JSON.stringify({ schema: 'client_lead_profile_v1', clientId: 'jole', contact: { firstName: 'Pat' },
    hiring: { roles: [{ raw: 'CNC Programmer', clean: null, status: 'review' }] },
    personalization: { status: 'needs_review', roles: [], location: '', reason: 'no posting title reduces to a usable trade' } }),
  ...extra });
const reviewed = (entry, fn) => {
  setJoleClassificationForTests({ 'neutral-review': entry });
  try { fn(); } finally { setJoleClassificationForTests(null); }
};

test('explicitly reviewed neutral copy does not require a hiring role or site', () => reviewed({ mode: 'general_craft' }, () => {
  const l = lead();
  for (const step of [1, 2, 3]) {
    const email = renderClientLeadEmail(l, step, { env: ENV, now: NOW });
    assert.equal(email.personalization.mode, 'general_craft');
    assert.doesNotMatch(email.body, /CNC Programmer|Saw you were hiring/);
  }
  assert.equal(queueEligibility(l, { leads: [l], env: ENV }).ok, true);
  assert.equal(clientPersonalizationState(l, { env: ENV, now: NOW }).status, 'ready');
}));

test('unknown, held and hiring-claim classifications still require reviewed hiring inputs', () => {
  for (const entry of [undefined, { mode: 'hold' }, { mode: 'exact', role: 'Machinists', location: 'Plymouth, MN', evidenceCheckedAt: '2026-11-10' },
    { mode: 'role_only', role: 'Machinists', evidenceCheckedAt: '2026-11-10' },
    { mode: 'exact', role: 'Machinists', location: 'Plymouth, MN', evidenceCheckedAt: '2026-01-01' }]) {
    reviewed(entry, () => assert.throws(() => renderClientLeadEmail(lead(), 1, { env: ENV, now: NOW }),
      error => error.code === 'needs_review'));
  }
});

test('neutral approval preserves profile ownership, missing-data and suppression gates', () => reviewed({ mode: 'general_craft' }, () => {
  assert.throws(() => renderClientLeadEmail(lead({ campaign_notes: '' }), 1, { env: ENV }), error => error.code === 'profile_missing');
  const wrongProfile = JSON.parse(lead().campaign_notes); wrongProfile.clientId = 'scalelab';
  assert.throws(() => renderClientLeadEmail(lead({ campaign_notes: JSON.stringify(wrongProfile) }), 1, { env: ENV }),
    error => error.code === 'profile_client_mismatch');
  assert.throws(() => renderClientLeadEmail(lead(), 1, { env: {} }));
  for (const [status, reason] of [['hold', 'no hiring location'], ['needs_review', 'buyer requires manual review']]) {
    const profile = JSON.parse(lead().campaign_notes); profile.personalization = { status, reason };
    assert.throws(() => renderClientLeadEmail(lead({ campaign_notes: JSON.stringify(profile) }), 1, { env: ENV }),
      error => error.code === 'needs_review');
  }
  const owned = [{ sourceLeadId: 'neutral-review', eventType: 'initial_email_sent', occurredAt: '2026-11-10T15:00:00Z',
    metadata: JSON.stringify({ copyVersion: 'jole_industrial_employer_v5', personalizationMode: 'exact',
      personalizationRole: 'Machinists', personalizationSite: 'Plymouth, MN' }) }];
  assert.throws(() => renderClientLeadEmail(lead(), 2, { env: ENV, activities: owned }), error => error.code === 'needs_review');
  for (const notes of ['[MANUAL HOLD]', '[REPLY: Unsubscribed]', '[BOUNCED: invalid recipient]']) {
    const l = lead({ notes }); assert.equal(queueEligibility(l, { leads: [l], env: ENV }).ok, false);
  }
  const l = lead();
  assert.equal(queueEligibility(l, { leads: [l], env: ENV, suppressedEmails: new Set([l.email]) }).ok, false);
  assert.equal(queueEligibility(l, { leads: [l], env: ENV, activities: [{ sourceLeadId: l.id, eventType: 'initial_email_sent' }] }).ok, false);
}));
