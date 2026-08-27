'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = read(path.join(root, 'server.js'));
const browser = read(path.join(root, 'public', 'index.html'));

function sourceFunction(name) {
  const start = server.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < server.length; i++) {
    if (server[i] === '{') { depth++; opened = true; }
    if (server[i] === '}') depth--;
    if (opened && depth === 0) return server.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

const filterOutreachRows = new Function(`
  ${sourceFunction('normalizedRouteNicheFor')}
  ${sourceFunction('campaignLabelFor')}
  ${sourceFunction('filterOutreachRows')}
  return filterOutreachRows;
`)();

const buildOutreachPipelineIndex = new Function(`
  const normalizeEmail = value => String(value || '').trim().toLowerCase();
  const displayStageFor = value => String(value || '').trim().toLowerCase();
  ${sourceFunction('buildOutreachPipelineIndex')}
  return buildOutreachPipelineIndex;
`)();

const row = (id, extra = {}) => ({
  id, company: `${id} Dental`, contactName: `Dr ${id}`, email: `${id}@example.com`, website: `${id}.example.com`,
  city: 'Vancouver', tradeType: 'dentist', stage: 'Contacted', campaign: 'Dental V2', leadNiche: 'dental',
  replyCategory: '', pipelinePresence: false, pipelineStage: '', mappingStatus: 'not_in_pipeline',
  demoEngaged: false, warm: false, sequenceState: 'not_started', automationState: 'never', ...extra,
});

test('all Outreach records remain discoverable through bounded pages and search beyond page one', () => {
  const rows = Array.from({ length: 205 }, (_, index) => row(String(index), index === 180 ? { company: 'Far Page Practice' } : {}));
  assert.deepEqual([...rows.slice(0, 100), ...rows.slice(100, 200), ...rows.slice(200)].map(item => item.id), rows.map(item => item.id));
  assert.deepEqual(filterOutreachRows(rows, { search: 'Far Page' }).map(item => item.id), ['180']);
  assert.match(server, /const DEFAULT_CE_PAGE = 100;/);
  assert.match(server, /filtered\.slice\(offset, offset \+ limit\)/);
});

test('master search covers company, contact, email, and website without company matching for identity', () => {
  const rows = [row('one', { company: 'North Shore Dental', contactName: 'Alex Rivera', email: 'care@north.ca', website: 'north.ca' })];
  for (const term of ['shore', 'rivera', 'care@north', 'north.ca']) assert.equal(filterOutreachRows(rows, { search: term }).length, 1);
  const join = sourceFunction('buildOutreachPipelineIndex');
  assert.doesNotMatch(join, /company|fuzzy/i);
});

test('pipeline mapping prefers CE id, falls back to unique exact email, and never guesses ambiguity', () => {
  const ce = [row('a', { email: 'same@example.com' }), row('b', { email: 'unique@example.com' })];
  const board = [
    { id: 'CE-a', email: 'wrong@example.com', stage: 'hot' },
    { id: 'manual', email: 'unique@example.com', stage: 'call_booked' },
  ];
  const index = buildOutreachPipelineIndex(ce, board);
  assert.equal(index.byColdEmailId.get('a').matchedBy, 'ce_id');
  assert.equal(index.byColdEmailId.get('a').pipelineStage, 'hot');
  assert.equal(index.byColdEmailId.get('b').matchedBy, 'email');
  assert.equal(index.byColdEmailId.get('b').pipelineStage, 'call_booked');

  const conflict = buildOutreachPipelineIndex([row('x', { email: 'dupe@example.com' })], [
    { id: 'one', email: 'dupe@example.com', stage: 'hot' }, { id: 'two', email: 'dupe@example.com', stage: 'closed_won' },
  ]).byColdEmailId.get('x');
  assert.equal(conflict.mappingStatus, 'conflict');
  assert.equal(conflict.pipelinePresence, false);
  assert.equal(conflict.boardLeadId, '');
});

test('pipeline, reply, engagement, and sequence filters compose before pagination', () => {
  const rows = [
    row('positive-out', { replyCategory: 'positive' }),
    row('human-out', { replyCategory: 'needs_human' }),
    row('demo-out', { demoEngaged: true }),
    row('hot', { pipelinePresence: true, pipelineStage: 'hot', mappingStatus: 'matched', replyCategory: 'positive' }),
    row('complete', { sequenceState: 'complete' }),
    row('active', { sequenceState: 'active', automationState: 'active' }),
  ];
  assert.deepEqual(filterOutreachRows(rows, { pipelinePresence: 'out' }).map(x => x.id), ['positive-out','human-out','demo-out','complete','active']);
  assert.deepEqual(filterOutreachRows(rows, { pipelinePresence: 'in', pipelineStage: 'hot' }).map(x => x.id), ['hot']);
  assert.deepEqual(filterOutreachRows(rows, { replyCategory: 'positive', pipelinePresence: 'out' }).map(x => x.id), ['positive-out']);
  assert.deepEqual(filterOutreachRows(rows, { replyCategory: 'needs_human', pipelinePresence: 'out' }).map(x => x.id), ['human-out']);
  assert.deepEqual(filterOutreachRows(rows, { engagement: 'demo', pipelinePresence: 'out' }).map(x => x.id), ['demo-out']);
  assert.deepEqual(filterOutreachRows(rows, { sequenceState: 'complete' }).map(x => x.id), ['complete']);
  assert.deepEqual(filterOutreachRows(rows, { sequenceState: 'active' }).map(x => x.id), ['active']);
  assert.deepEqual(filterOutreachRows(rows, { replyCategory: 'none' }).map(x => x.id), ['demo-out','complete','active']);
});

test('the row and lazy drawer expose canonical pipeline state for non-board leads', () => {
  assert.match(browser, /<th>Pipeline<\/th>/);
  assert.match(browser, /Not in Pipeline/);
  assert.match(browser, /Not in Sales Pipeline/);
  assert.match(browser, /openCeDetail\('\$\{l\.id\}'\)/);
  assert.match(browser, /fetch\(`\/api\/coldemail\/\$\{encodeURIComponent\(id\)\}\/activity`\)/);
  assert.match(server, /mappingStatus: row\.mappingStatus/);
  assert.match(server, /timelineForLead\(lead, dataset, activities\)/);
});

test('master filters are server-side, debounced, responsive, and keep the initial DOM bounded', () => {
  for (const name of ['pipelinePresence','pipelineStage','engagement','sequenceState','automationState']) {
    assert.match(browser, new RegExp(`params\\.set\\('${name}'`));
  }
  assert.match(browser, /setTimeout\(\(\) => reloadCePage\(\), 250\)/);
  assert.match(browser, /const CE_PAGE_SIZE = 100;/);
  assert.match(browser, /@media \(max-width: 700px\)[\s\S]*?\.ce-master-filters/);
  assert.match(browser, /min-height:44px/);
});

test('summary and reply drill-down reuse the same snapshot and canonical pipeline join', () => {
  assert.match(server, /pipelineAudit: dataset\.pipelineAudit/);
  assert.match(server, /const rowById = new Map\(dataset\.rows\.map/);
  assert.match(browser, /record\.mappingStatus === 'conflict'/);
  const start = browser.indexOf('function rdStageLabel');
  const end = browser.indexOf('\n}', start) + 2;
  assert.doesNotMatch(browser.slice(start, end), /company|ceCompanyKey|leads\.find/);
});
