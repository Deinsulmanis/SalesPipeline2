'use strict';

// The reviewed group A wave (2026-11-12): 117 imported Jole leads, classified
// for the neutral v5 copy only (115 general_craft) or held (2 union shops
// awaiting the site-labor feasibility check). No hiring claim, no contact data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'integrations', 'clients', 'data', 'jole-personalization-groupa-20261112.json');
const WAVE = require(FILE);
const AUDIT = require('../integrations/clients/data/jole-personalization-v4.json');
const { joleClassificationFor, jolePersonalizationFor } = require('../integrations/clients/jole-personalization');

test('group A wave: 117 entries, neutral or held only, no claims and no contact details', () => {
  const entries = Object.entries(WAVE.leads);
  assert.equal(entries.length, 117);
  const count = mode => entries.filter(([, entry]) => entry.mode === mode).length;
  assert.deepEqual({ general_craft: count('general_craft'), hold: count('hold') }, { general_craft: 115, hold: 2 });
  assert.deepEqual(WAVE.counts, { general_craft: 115, hold: 2 });
  for (const [id, entry] of entries) {
    assert.ok(['general_craft', 'hold'].includes(entry.mode), id);
    assert.equal(entry.role, null, id);
    assert.equal(entry.location, null, id);
    assert.equal(entry.secondaryRole, null, id);
    assert.equal(entry.evidenceCheckedAt, null, `${id}: no current-hiring evidence is claimed`);
    assert.ok(Array.isArray(entry.unsupportedRoles) && Array.isArray(entry.unsupportedLocations), id);
    assert.ok(entry.evidenceStatus && entry.reason, id);
    assert.equal(AUDIT.leads[id], undefined, `${id} must not collide with the audit classification`);
    assert.equal(AUDIT.followUpHolds[id], undefined, `${id} must not be a contacted thread`);
  }
  assert.doesNotMatch(fs.readFileSync(FILE, 'utf8'), /@[a-z0-9-]+\.[a-z]/i);
});

test('group A wave: the loader resolves wave leads to their reviewed mode and leaves audit leads unchanged', () => {
  const [neutralId] = Object.entries(WAVE.leads).find(([, entry]) => entry.mode === 'general_craft');
  const [heldId] = Object.entries(WAVE.leads).find(([, entry]) => entry.mode === 'hold');
  assert.equal(joleClassificationFor({ id: neutralId }).mode, 'general_craft');
  const neutral = jolePersonalizationFor({ id: neutralId }, [], { now: Date.parse('2026-11-12T13:00:00Z') });
  assert.equal(neutral.mode, 'general_craft');
  assert.equal(neutral.role, null);
  assert.equal(neutral.location, null);
  assert.equal(jolePersonalizationFor({ id: heldId }, []).mode, 'hold');
  const [auditId, auditEntry] = Object.entries(AUDIT.leads)[0];
  assert.equal(joleClassificationFor({ id: auditId }).mode, auditEntry.mode);
  assert.equal(jolePersonalizationFor({ id: 'not-classified-anywhere' }, []).mode, 'hold');
});
