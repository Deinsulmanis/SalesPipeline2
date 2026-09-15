'use strict';

// Six of the drawer's confirmation modals — call lifecycle (Book, Reschedule,
// Cancel, Complete, No Show), Close, Mark Ghosted, Reactivate, manual promotion
// and sequence enrollment — carry class="modal-overlay", a class with no base
// CSS rule. In production they rendered as static boxes below the board, visible
// even when closed, and "opened" underneath the fixed detail drawer where no
// click could reach them. Found when the live Silver 7 Dental No Show could not
// be confirmed. Only #resume-overlay worked, because it had its own rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\r\n').join('\n');
const styles = browser.match(/<style>([\s\S]*?)<\/style>/)[1];

// Top-level rules only: a rule inside @media is not a base rule.
function baseRule(selector) {
  let depth = 0;
  let mediaDepth = null;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const found = [];
  let match;
  while ((match = re.exec(styles))) {
    const before = styles.slice(0, match.index);
    depth = 0; mediaDepth = null;
    for (let i = 0; i < before.length; i++) {
      if (before.startsWith('@media', i) && mediaDepth === null) mediaDepth = depth;
      if (before[i] === '{') depth++;
      else if (before[i] === '}') { depth--; if (mediaDepth !== null && depth === mediaDepth) mediaDepth = null; }
    }
    if (mediaDepth === null) found.push(match[2]);
  }
  return found.join(';');
}
const zOf = token => Number((styles.match(new RegExp(`--z-${token}:\\s*(\\d+)`)) || [])[1]);

test('a closed drawer modal is hidden, and an open one is a fixed overlay', () => {
  const rule = baseRule('.modal-overlay');
  assert.ok(rule, '.modal-overlay has a base rule outside any @media block');
  assert.match(rule, /display:\s*none/);
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /inset:\s*0/);
  assert.match(baseRule('.modal-overlay.open'), /display:\s*flex/);
});

test('a drawer modal stacks above the drawer it is opened from', () => {
  const drawerZ = baseRule('.detail-overlay').match(/z-index:\s*var\(--z-sticky\)/) ? zOf('sticky') : NaN;
  const modalZ = (baseRule('.modal-overlay').match(/z-index:\s*calc\(var\(--z-sticky\)\s*\+\s*(\d+)\)/) || [])[1];
  assert.ok(Number.isFinite(drawerZ), 'the detail drawer sits at --z-sticky');
  assert.ok(Number(modalZ) > 0, 'the modal sits above --z-sticky');
  assert.ok(zOf('sticky') + Number(modalZ) < zOf('toast'), 'toasts still show above a modal');
});

test('every modal-overlay element opens and closes through the .open class', () => {
  const ids = [...browser.matchAll(/<div class="modal-overlay" id="([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.sort(), ['call-overlay', 'close-overlay', 'ghost-overlay', 'promotion-overlay',
    'react-overlay', 'resume-overlay', 'seq-overlay'].sort());
  for (const id of ids) {
    assert.match(browser, new RegExp(`getElementById\\('${id}'\\)\\.classList\\.add\\('open'\\)`), `${id} opens with .open`);
    assert.match(browser, new RegExp(`getElementById\\('${id}'\\)\\.classList\\.remove\\('open'\\)`), `${id} closes with .open`);
  }
});
