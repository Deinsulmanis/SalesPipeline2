'use strict';

// The buyers-102 classification wave (2026-11-13): 86 imported leads, each with
// a mode its evidence supports. Hiring and signal entries carry their own
// re-opened evidence; everything else is neutral.

const test = require('node:test');
const assert = require('node:assert/strict');

const WAVE = require('../integrations/clients/data/jole-personalization-buyers102-20261113.json');
const { joleClassificationFor, jolePersonalizationFor } = require('../integrations/clients/jole-personalization');

const entries = Object.entries(WAVE.leads);
const NOW = Date.parse('2026-11-14T13:00:00Z');

test('wave shape and counts', () => {
  assert.equal(WAVE.schema, 'jole_personalization_wave');
  assert.equal(entries.length, 86);
  const counts = {};
  for (const [, e] of entries) counts[e.mode] = (counts[e.mode] || 0) + 1;
  assert.deepEqual(counts, WAVE.counts);
  assert.deepEqual(counts, { general_craft: 62, exact: 17, role_only: 4, award: 1, expansion: 2 });
});

test('every claim entry carries its own re-opened evidence', () => {
  for (const [id, e] of entries) {
    if (e.mode === 'general_craft') { assert.equal(e.evidenceUrl, null, id); continue; }
    assert.match(e.evidenceUrl, /^https:\/\//, id);
    assert.equal(e.publicPageChecked, true, id);
    assert.equal(e.evidenceCheckedAt, '2026-11-13', id);
    if (e.mode === 'exact') assert.match(e.location, /^[A-Z][A-Za-z.' ]+, [A-Z]{2}$/, id);
    if (e.mode === 'role_only') assert.equal(e.location, null, id);
    if (['award', 'expansion'].includes(e.mode)) { assert.ok(e.event && e.eventShort, id); assert.equal(e.role, null, id); }
  }
});

test('the live classification resolves these leads to their wave modes', () => {
  for (const [id, e] of entries) {
    assert.equal(joleClassificationFor({ id }).mode, e.mode, id);
    const resolved = jolePersonalizationFor({ id }, [], { now: NOW });
    assert.equal(resolved.mode, e.mode, id);
    if (['award', 'expansion'].includes(e.mode)) { assert.equal(resolved.role, e.event); assert.equal(resolved.location, e.eventShort); }
  }
});

test('claims fall to general_craft after 30 days', () => {
  const later = Date.parse('2026-12-15T13:00:00Z');
  for (const [id, e] of entries.filter(([, x]) => x.mode !== 'general_craft')) {
    assert.equal(jolePersonalizationFor({ id }, [], { now: later }).mode, 'general_craft', id);
  }
});
