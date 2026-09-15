'use strict';

// server.js called hasManualHold() in three places — the read-back inside
// ensureManualHoldDurable and the Resume rollback — without ever importing it.
// Every human-owned stage change with a ColdEmail twin therefore applied the
// hold, threw a ReferenceError while confirming it, and refused as
// "hold_unconfirmed". No test noticed: route tests match source text, and the
// sandboxes that execute these helpers supply the name themselves.
//
// This checks the real module scope instead: every pipeline-state export that
// server.js calls must be imported or declared in server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('\r\n').join('\n');
const pipelineState = require('../integrations/pipeline-state');

function importedFrom(modulePath) {
  const marker = `} = require('${modulePath}');`;
  const end = server.indexOf(marker);
  assert.notEqual(end, -1, `server.js imports ${modulePath}`);
  const start = server.lastIndexOf('const {', end);
  return new Set(server.slice(start + 'const {'.length, end)
    .split(',').map(part => part.trim().split(':').pop().trim()).filter(Boolean));
}

test('every pipeline-state function server.js calls is in scope', () => {
  const imported = importedFrom('./integrations/pipeline-state');
  const missing = Object.keys(pipelineState)
    .filter(name => typeof pipelineState[name] === 'function')
    .filter(name => new RegExp(`(^|[^.\\w])${name}\\(`, 'm').test(server))
    .filter(name => !imported.has(name))
    .filter(name => !new RegExp(`(function|const|let|var)\\s+${name}\\b`).test(server));
  assert.deepEqual(missing, [], `called in server.js but never imported: ${missing.join(', ')}`);
});

test('the hold read-back uses an imported hasManualHold', () => {
  assert.ok(importedFrom('./integrations/pipeline-state').has('hasManualHold'));
  const helper = server.slice(server.indexOf('async function ensureManualHoldDurable'),
    server.indexOf('function activityMatchesLead'));
  assert.match(helper, /twins\.filter\(twin => !hasManualHold\(twin\.notes \|\| ''\)\)/);
});
