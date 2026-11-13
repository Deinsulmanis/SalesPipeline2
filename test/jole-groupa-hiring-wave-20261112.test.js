'use strict';

// Group A hiring update (2026-11-12): 11 unsent group A leads whose company had
// a live craft posting re-opened that day move from general_craft to the V5
// hiring modes. Each entry names only what its cited posting supports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'integrations', 'clients', 'data', 'jole-personalization-groupa-hiring-20261112.json');
const WAVE = require(FILE);
const GROUPA = require('../integrations/clients/data/jole-personalization-groupa-20261112.json');
const AUDIT = require('../integrations/clients/data/jole-personalization-v4.json');
const { jolePersonalizationFor } = require('../integrations/clients/jole-personalization');
const { renderJoleEmployerStepV5 } = require('../integrations/clients/jole-copy');

const CHECKED = Date.parse('2026-11-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('hiring update: 11 group A leads, hiring modes only, each with a re-opened posting and no contact details', () => {
  const entries = Object.entries(WAVE.leads);
  assert.equal(entries.length, 11);
  assert.deepEqual(WAVE.counts, { exact: 9, role_only: 2 });
  for (const [id, entry] of entries) {
    assert.equal(GROUPA.leads[id]?.mode, 'general_craft', `${id} must be a queued group A lead it supersedes`);
    assert.equal(AUDIT.leads[id], undefined, id);
    assert.ok(['exact', 'role_only'].includes(entry.mode), id);
    assert.ok(entry.role && /^[A-Z]/.test(entry.role), id);
    assert.equal(Boolean(entry.location), entry.mode === 'exact', `${id}: only exact names a site`);
    assert.equal(entry.evidenceCheckedAt, '2026-11-12', id);
    assert.match(entry.evidenceUrl, /^https:\/\//, id);
    assert.ok(entry.unsupportedRoles.includes(entry.role), id);
  }
  assert.doesNotMatch(fs.readFileSync(FILE, 'utf8'), /@[a-z0-9-]+\.[a-z]/i);
});

test('hiring update: the loader prefers the hiring entry and every touch renders valid V5 copy', () => {
  for (const [id, entry] of Object.entries(WAVE.leads)) {
    const p = jolePersonalizationFor({ id }, [], { now: CHECKED });
    assert.equal(p.mode, entry.mode, id);
    assert.equal(p.role, entry.role, id);
    assert.equal(p.location, entry.mode === 'exact' ? entry.location : null, id);
    for (const step of [1, 2, 3]) {
      const email = renderJoleEmployerStepV5({ step, firstName: 'Pat', company: entry.company, mailingAddress: '1 Main St, Houston, TX 77002', personalization: p });
      if (step === 1) assert.match(email.coreBody, new RegExp(`Saw you were hiring ${entry.role}`), id);
      if (step === 3) assert.doesNotMatch(email.coreBody, new RegExp(entry.role), id);
      if (entry.mode === 'role_only') for (const place of entry.unsupportedLocations) assert.ok(!email.body.includes(place), `${id} names ${place}`);
    }
  }
});

test('hiring update: after 30 days without a re-check the hiring claim falls back to general_craft', () => {
  const [id] = Object.keys(WAVE.leads);
  assert.equal(jolePersonalizationFor({ id }, [], { now: CHECKED + 31 * DAY }).mode, 'general_craft');
});

test('hiring update: a lead whose thread already started keeps its recorded mode', () => {
  const [id] = Object.keys(WAVE.leads);
  const sent = [{ sourceLeadId: id, eventType: 'initial_email_sent', occurredAt: '2026-11-12T15:00:00Z',
    metadata: { copyVersion: 'jole_industrial_employer_v5', personalizationMode: 'general_craft' } }];
  assert.equal(jolePersonalizationFor({ id }, sent, { now: CHECKED }).mode, 'general_craft');
});
