'use strict';

// Stage 3E — Supabase-primary operational reads.
//
// What has to stay true when the corpus moves:
//
//   * exactly TWO chokepoints change. Every downstream consumer already derives
//     from one of them, so a third branch would be a per-feature read — the way
//     N+1 gets in.
//   * the corpus is ONE paged scan, never a query per lead.
//   * fallback safety depends on who owns WRITES, not on where reads are served.
//     While Sheets is canonical a fallback lands on truth; once Supabase is
//     canonical the same fallback would decide sends from a lagging mirror, so
//     automation must refuse instead.
//   * a row number never comes from the mirror. sheet_row is advisory, and a
//     stale row lands a write on the WRONG lead.
//   * the browser payload does not change shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  outreachWriteAuthority, sheetsFallbackAllowed, readOutreachCorpus, SHEET_FIELDS,
} = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const stateSrc = readSource(path.join(root, 'integrations', 'outreach-state.js'));

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';

function fakeCorpus(count, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (status !== 200) { res.writeHead(status); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') || 1000);
    const offset = Number(url.searchParams.get('offset') || 0);
    const page = [];
    for (let i = offset; i < Math.min(offset + limit, count); i++) {
      page.push({ lead_id: `ce-${i}`, stage: 'Contacted', email: `l${i}@x.test`,
        site_context: 'scraped context', sender_inbox_id: 'primary' });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  return {
    requests,
    async start() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SECRET_KEY: SECRET };
    },
    async stop() { await new Promise(r => server.close(r)); },
  };
}

// ── fallback policy ─────────────────────────────────────────────────────────

test('while Sheets owns writes, a fallback lands on truth and is allowed', () => {
  const env = {};
  assert.equal(outreachWriteAuthority(env), 'sheets');
  assert.equal(sheetsFallbackAllowed('ui', env).allowed, true);
  assert.equal(sheetsFallbackAllowed('automation', env).allowed, true,
    'Sheets receives every canonical write, so it cannot be behind');
  assert.equal(sheetsFallbackAllowed('automation', env).reason, 'sheets-is-canonical');
});

test('once Supabase owns writes, automation may NOT fall back to Sheets', () => {
  const env = { SUPABASE_OUTREACH_WRITES: 'supabase' };
  assert.equal(outreachWriteAuthority(env), 'supabase');
  const automation = sheetsFallbackAllowed('automation', env);
  assert.equal(automation.allowed, false,
    'deciding a send from a lagging mirror is exactly the split-brain this prevents');
  assert.match(automation.reason, /lagging-mirror/);
  // Reporting may still show a lagged value; it cannot send anything.
  assert.equal(sheetsFallbackAllowed('ui', env).allowed, true);
});

test('write authority defaults to sheets and ignores anything it does not recognise', () => {
  for (const value of ['', 'yes', 'SUPABASE_X', undefined]) {
    assert.equal(outreachWriteAuthority({ SUPABASE_OUTREACH_WRITES: value }), 'sheets');
  }
  assert.equal(outreachWriteAuthority({ SUPABASE_OUTREACH_WRITES: ' SUPABASE ' }), 'supabase');
});

// ── the corpus read ─────────────────────────────────────────────────────────

test('the corpus is one paged scan, not a query per lead', async () => {
  const fake = fakeCorpus(2400);
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.equal(result.leads.length, 2400);
    assert.equal(fake.requests.length, 3, '2400 leads at 1000 per page is three requests, not 2400');
    for (const url of fake.requests) assert.match(url, /limit=1000/);
  } finally { await fake.stop(); }
});

test('the corpus never carries a sheet row number', async () => {
  const fake = fakeCorpus(3);
  const env = await fake.start();
  try {
    const { leads } = await readOutreachCorpus({ env });
    for (const lead of leads) {
      assert.equal(lead._row, undefined,
        'sheet_row is advisory; a stale row would land a write on the wrong lead');
    }
    // It does carry every ColdEmail field, so downstream consumers are unchanged.
    for (const field of SHEET_FIELDS) assert.ok(field in leads[0], `${field} must be present`);
  } finally { await fake.stop(); }
});

test('an unreadable corpus reports failure rather than an empty corpus', async () => {
  const fake = fakeCorpus(10, { status: 500 });
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, false);
    assert.deepEqual(result.leads, [],
      'an empty list must never be mistaken for "there are no leads"');
    assert.ok(result.reason);
  } finally { await fake.stop(); }
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('exactly two chokepoints branch on primary', () => {
  assert.equal((serverSrc.match(/outreachStateMode\(\) === 'primary'/g) || []).length, 1);
  assert.equal((agentSrc.match(/outreachStateMode\(\) === 'primary'/g) || []).length, 2);
  assert.match(serverSrc, /const ceFromSupabase = outreachStateMode\(\) === 'primary'/);
});

test('primary mode stops asking Sheets for the corpus at all', () => {
  // The saving is the point: fetching 1951 rows and discarding them would make
  // the cutover cost more than it saves.
  assert.match(agentSrc, /\.\.\.\(coldEmailFromSupabase \? \[\] : \[\['coldEmail', READ_RANGE\]\]\)/,
    'the agent drops the ColdEmail range from its batch');
  assert.match(serverSrc, /\.\.\.\(ceFromSupabase \? \[\] : \[`\$\{CE_SHEET_NAME\}!A:O`, `\$\{CE_SHEET_NAME\}!Q:X`\]\)/,
    'the server drops both ColdEmail ranges from its batch');
});

test('the agent fails CLOSED when Supabase is canonical and unreadable', () => {
  const fn = agentSrc.slice(agentSrc.indexOf('async function readLeads('),
    agentSrc.indexOf('// A scheduled process used to issue one values.get per tab'));
  assert.match(fn, /const fallback = sheetsFallbackAllowed\('automation'\)/);
  assert.match(fn, /if \(!fallback\.allowed\) \{[\s\S]*?throw new Error/,
    'automation must refuse to run rather than decide from a lagging mirror');
  assert.match(fn, /refusing to run automation/);
});

test('the UI falls back, records it, and says why', () => {
  const loader = serverSrc.slice(serverSrc.indexOf('async function loadOutreachDataset'),
    serverSrc.indexOf('async function getOutreachDataset'));
  assert.match(loader, /sheetsFallbackAllowed\('ui'\)/);
  assert.match(loader, /recordFallback\('ui-directory'/,
    'a silent fallback would let a cutover look healthy while serving the old store');
  assert.match(loader, /leadSource = 'sheets-fallback'/);
});

test('the browser payload does not change shape across the cutover', () => {
  const loader = serverSrc.slice(serverSrc.indexOf('async function loadOutreachDataset'),
    serverSrc.indexOf('async function getOutreachDataset'));
  assert.match(loader, /leads = corpus\.leads\.map\(lead => \(\{ \.\.\.lead, siteContext: '' \}\)\)/,
    'the Sheets read omits column P, so the mirror path must blank it too');
});

test('the row map is never populated from the mirror', () => {
  const loader = serverSrc.slice(serverSrc.indexOf('async function loadOutreachDataset'),
    serverSrc.indexOf('async function getOutreachDataset'));
  const supabaseBranch = loader.slice(loader.indexOf('if (corpus.ok)'), loader.indexOf('} else {'));
  assert.ok(!/ceRowMap\.set/.test(supabaseBranch),
    'sheet_row is advisory; findCERow rebuilds from column A, which is authoritative');
});

test('the last-moment warm-send check reads from whoever owns writes', () => {
  // This is the gate that catches a hold, booking or suppression landing between
  // classification and send. It must not consult a mirror that could be carrying
  // a deferred write for exactly the lead being checked.
  assert.match(agentSrc, /forceColdEmail: outreachWriteAuthority\(\) === 'sheets'/);
  assert.match(agentSrc, /const coldEmailFromSupabase = outreachStateMode\(\) === 'primary' && !forceColdEmail/);
});

test('writeSiteContext resolves its own row, like every other agent writer', () => {
  const fn = agentSrc.slice(agentSrc.indexOf('async function writeSiteContext'),
    agentSrc.indexOf('// Phase 2: calls Haiku'));
  assert.match(fn, /const rowNum = await resolveRow\(lead\.id\)/);
  assert.ok(!/lead\._row/.test(fn),
    'a corpus-derived row would be advisory once the corpus can come from Supabase');
  assert.match(fn, /if \(!rowNum\)[\s\S]*?return;/, 'a vanished lead skips the write, never guesses');
});

test('the fallback policy lives in one place and is documented', () => {
  assert.match(stateSrc, /function outreachWriteAuthority\(/);
  assert.match(stateSrc, /function sheetsFallbackAllowed\(/);
  assert.ok(stateSrc.includes('falls back to') && stateSrc.includes('TRUTH'),
    'the reason a fallback is safe today must be stated where the policy lives');
});
