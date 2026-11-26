'use strict';

// Pipeline board side-scroll (2026-11-26): the board is wider than the screen
// but its own scrollbar sat under the longest column, so it could only be
// scrolled up and down. A bar pinned above the board scrolls it sideways.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const fn = html.slice(html.indexOf('function initBoardScroller()'), html.indexOf('\n}\n', html.indexOf('function initBoardScroller()')));

test('the bar is created once, above the board, when the workspaces are built', () => {
  assert.ok(fn.length > 0, 'initBoardScroller exists');
  assert.match(html, /document\.body\.classList\.add\('workspace-ready'\);\n  initBoardScroller\(\);/);
  assert.match(fn, /board\.closest\('\.main'\)/);
  assert.match(fn, /document\.getElementById\('board-scroller'\)\) return;/, 'never added twice');
  assert.match(fn, /insertAdjacentHTML\('beforebegin'/, 'sits before the board, not inside it');
});

test('labelled Left and Right buttons, a drawn handle, and the wheel over the bar scrolls sideways', () => {
  assert.match(fn, /aria-label="Scroll the pipeline left"[^>]*>.*Left<\/button>/);
  assert.match(fn, /aria-label="Scroll the pipeline right">Right/);
  assert.match(fn, /class="board-scroll-thumb"/);
  assert.match(fn, /setPointerCapture/);
  assert.match(fn, /addEventListener\('wheel'[\s\S]*?main\.scrollLeft \+= event\.deltaY/);
  assert.match(fn, /prefers-reduced-motion: reduce/);
  assert.match(fn, /leftBtn\.disabled = main\.scrollLeft <= 1/);
});

test('it shows only while the board is wider than its box and stays pinned while scrolling down', () => {
  assert.match(fn, /scroller\.classList\.toggle\('visible', overflowing\)/);
  assert.match(fn, /new ResizeObserver\(update\)/);
  assert.match(html, /\.board-scroller\{position:sticky;top:0;[^}]*display:none/);
  assert.match(html, /\.board-scroller\.visible\{display:flex\}/);
  assert.match(html, /\.board-scroll-btn\{[^}]*min-height:44px;min-width:44px/, 'touch-size buttons');
});
