'use strict';

// Stage 3F — Supabase-canonical writes with optimistic concurrency.
//
// ColdEmail never had concurrency protection: writes were last-writer-wins on a
// cell range, made safe only by the accident that a single cron process wrote
// narrow ranges. Row-level writes remove that accident, so the protection has to
// arrive together with the authority.
//
// What has to stay true:
//
//   * a mutation lands only if the row has not moved (compare-and-set on revision)
//   * a conflict is never resolved by blindly re-applying the patch
//   * human, terminal and reply state outrank automation on conflict
//   * every field in one transition lands atomically
//   * a Sheets mirror failure never rolls back a committed canonical write and
//     never restores Sheets authority
//   * no call site had to change for any of this

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPostgrestDouble } = require('../test-support/postgrest-double');
const {
  applyLeadChange, applyCanonicalChange, conflictRefusal, readCanonicalLead,
  outreachWriteAuthority, MAX_CAS_ATTEMPTS,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
} = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const stateSrc = readSource(path.join(root, 'integrations', 'outreach-state.js'));

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';
const quiet = { log() {}, warn() {}, error() {} };

/**
 * The canonical row, served by a PostgREST double that evaluates filters the way
 * PostgREST does: a PATCH filtered on revision=eq.N affects the row only while
 * its revision is still N, and a GET returns only the rows its filter matches.
 *
 * The earlier stand-in answered every GET with the row whatever the filter said.
 * That is how `lead_id=eq."<id>"` — a filter that matches nothing in production —
 * passed this whole suite while every canonical write in production failed.
 */
function fakeCanonical(initial = {}) {
  const db = createPostgrestDouble({
    secret: SECRET,
    rows: [{
      lead_id: 'ce-1', revision: 1, stage: 'Contacted', email_status: 'emailed',
      notes: '', sender_inbox_id: 'primary', campaign: 'Ontario List', ...initial,
    }],
  });
  let onBeforePatch = null;
  db.hooks.beforeWrite = async ({ method, row }) => {
    if (method === 'PATCH' && onBeforePatch) await onBeforePatch(row('ce-1'));
  };
  return {
    row: db.row('ce-1'),
    get patches() {
      return db.requests.filter(r => r.method === 'PATCH').map(r => ({
        revision: Number(String(new Map(r.params).get('revision') || '').replace(/^eq\./, '')),
        body: r.json || {},
      }));
    },
    set onBeforePatch(fn) { onBeforePatch = fn; },
    start: () => db.start({ SUPABASE_OUTREACH_WRITES: 'supabase' }),
    stop: () => db.stop(),
  };
}

function sheetsStub({ fail = null } = {}) {
  const batches = [];
  return {
    batches,
    client: { spreadsheets: { values: { batchUpdate: async (args) => {
      if (fail) throw new Error(fail);
      batches.push(args.requestBody.data); return {};
    } } } },
  };
}

test.beforeEach(() => resetOutreachWriteDiagnostics());

// ── compare-and-set ─────────────────────────────────────────────────────────

test('a mutation lands and bumps the revision', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    const result = await applyCanonicalChange('ce-1', { stage: 'Done' }, { env, logger: quiet });
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    assert.equal(db.row.stage, 'Done');
    assert.equal(db.row.revision, 2);
    assert.equal(db.patches[0].revision, 1, 'the write was conditioned on the revision it read');
  } finally { await db.stop(); }
});

test('every field of a transition lands in ONE update', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    await applyCanonicalChange('ce-1',
      { stage: 'Replied', emailStatus: 'replied', notes: '[REPLY: Interested]' },
      { env, logger: quiet });
    assert.equal(db.patches.length, 1, 'no other worker may observe a half-applied transition');
    const sent = db.patches[0].body;
    assert.equal(sent.stage, 'Replied');
    assert.equal(sent.email_status, 'replied');
    assert.equal(sent.notes, '[REPLY: Interested]');
    assert.equal(sent.revision, 2, 'the revision bump is part of the same update');
  } finally { await db.stop(); }
});

test('derived columns stay consistent with the field they come from', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    await applyCanonicalChange('ce-1',
      { lastEmailedAt: '2026-09-13T10:00:00.000Z', emailStep: '3' }, { env, logger: quiet });
    const sent = db.patches[0].body;
    assert.equal(sent.last_emailed_at_ts, '2026-09-13T10:00:00.000Z');
    assert.equal(sent.email_step_int, 3);
  } finally { await db.stop(); }
});

test('a lost race is retried against the state that actually landed', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    // Another worker bumps the row between our read and our write, exactly once.
    let interfered = false;
    db.onBeforePatch = (row) => {
      if (interfered) return;
      interfered = true;
      row.revision = 2;                      // somebody else wrote first
      row.stage = 'Contacted';
    };
    const result = await applyCanonicalChange('ce-1', { notes: '[BOUNCED]' }, { env, logger: quiet });
    assert.equal(result.ok, true, 'a safe intent survives one lost race');
    assert.equal(result.conflicts, 1);
    assert.equal(db.row.notes, '[BOUNCED]');
    assert.equal(outreachWriteDiagnostics().casConflicts, 1);
  } finally { await db.stop(); }
});

test('a permanently contended row gives up rather than looping forever', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    db.onBeforePatch = (row) => { row.revision += 1; };   // always beaten
    const result = await applyCanonicalChange('ce-1', { notes: 'x' }, { env, logger: quiet });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`lost ${MAX_CAS_ATTEMPTS} compare-and-set races`));
    assert.equal(db.row.notes, '', 'nothing was written');
  } finally { await db.stop(); }
});

// ── who wins a conflict ─────────────────────────────────────────────────────

test('MANUAL HOLD applied mid-flight beats an automated stage change', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    let once = false;
    db.onBeforePatch = (row) => {
      if (once) return;
      once = true;
      row.revision = 2;
      row.notes = '[MANUAL HOLD] operator paused';   // a human took the lead
    };
    const result = await applyCanonicalChange('ce-1',
      { stage: 'Queued', emailStatus: 'queued' }, { env, logger: quiet });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.match(result.reason, /MANUAL HOLD/);
    assert.equal(db.row.stage, 'Contacted', 'the hold stands; the automated change did not land');
    assert.equal(outreachWriteDiagnostics().conflictRefusals, 1);
  } finally { await db.stop(); }
});

test('a reply arriving mid-flight beats send progression', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    let once = false;
    db.onBeforePatch = (row) => {
      if (once) return;
      once = true;
      row.revision = 2;
      row.email_status = 'replied';
    };
    const result = await applyCanonicalChange('ce-1',
      { emailStatus: 'emailed', emailStep: '2' }, { env, logger: quiet });
    assert.equal(result.refused, true);
    assert.match(result.reason, /reply arrived first/);
    assert.equal(db.row.email_status, 'replied');
  } finally { await db.stop(); }
});

test('an unsubscribe mid-flight cannot be reopened by automation', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    let once = false;
    db.onBeforePatch = (row) => {
      if (once) return;
      once = true;
      row.revision = 2;
      row.stage = 'Unsubscribed';
    };
    const result = await applyCanonicalChange('ce-1', { stage: 'Contacted' }, { env, logger: quiet });
    assert.equal(result.refused, true);
    assert.match(result.reason, /terminal/);
    assert.equal(db.row.stage, 'Unsubscribed');
  } finally { await db.stop(); }
});

test('the precedence rules, stated directly', () => {
  const R = (cur, patch) => conflictRefusal(cur, patch);
  // human ownership
  assert.match(R({ notes: '[MANUAL HOLD]', stage: 'Contacted' }, { stage: 'Queued' }), /MANUAL HOLD/);
  assert.equal(R({ notes: '[MANUAL HOLD]' }, { notes: '[MANUAL HOLD] plus a tag' }), null,
    'annotating notes under a hold is still allowed; moving the lead is not');
  // terminal state
  assert.match(R({ stage: 'Unsub' }, { stage: 'Contacted' }), /terminal/);
  assert.equal(R({ stage: 'Unsubscribed' }, { stage: 'Unsub' }), null, 'terminal -> terminal is fine');
  // reply ownership
  assert.match(R({ emailStatus: 'replied' }, { emailStatus: 'queued' }), /reply arrived first/);
  assert.equal(R({ emailStatus: 'replied' }, { emailStatus: 'done' }), null,
    'closing out a replied lead is not send progression');
  // ordinary progress is unaffected
  assert.equal(R({ stage: 'Contacted', emailStatus: 'emailed' }, { stage: 'Done' }), null);
});

// ── Sheets becomes the secondary mirror ─────────────────────────────────────

test('Sheets mirror failure does not roll back the canonical write', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  const lines = [];
  try {
    const sheets = sheetsStub({ fail: 'sheets 503' });
    const result = await applyLeadChange('ce-1', { stage: 'Done' }, {
      row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env,
      logger: { log() {}, warn: l => lines.push(l), error() {} },
    });
    assert.equal(result.ok, true, 'the canonical write stands');
    assert.equal(result.authority, 'supabase');
    assert.equal(result.mirrored, false, 'and Sheets is honestly reported as behind');
    assert.equal(db.row.stage, 'Done', 'Supabase was NOT rolled back');
    const text = lines.join(' ');
    assert.match(text, /Supabase write COMMITTED, Sheets mirror deferred/);
    assert.match(text, /Supabase remains authoritative/);
    assert.match(text, /reconciliation/);
    assert.equal(outreachWriteDiagnostics().mirrorFailures, 1);
  } finally { await db.stop(); }
});

test('a canonical failure throws, so no caller proceeds on a false premise', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    db.onBeforePatch = (row) => { row.revision += 1; };
    const sheets = sheetsStub();
    await assert.rejects(() => applyLeadChange('ce-1', { stage: 'Done' }, {
      row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet,
    }), /canonical outreach write failed/);
    assert.equal(sheets.batches.length, 0,
      'Sheets must never hold state Supabase refused to accept');
  } finally { await db.stop(); }
});

test('a refusal is distinguishable from a transport failure', async () => {
  const db = fakeCanonical();
  const env = await db.start();
  try {
    let once = false;
    db.onBeforePatch = (row) => {
      if (once) return;
      once = true; row.revision = 2; row.notes = '[MANUAL HOLD]';
    };
    const sheets = sheetsStub();
    await assert.rejects(
      () => applyLeadChange('ce-1', { stage: 'Queued' }, {
        row: 5, sheetsClient: sheets.client, spreadsheetId: 'sheet', env, logger: quiet }),
      (error) => {
        assert.equal(error.refused, true, 'callers can tell "not safe" from "could not reach"');
        assert.match(error.message, /refused/);
        return true;
      });
  } finally { await db.stop(); }
});

// ── the flip is internal ────────────────────────────────────────────────────

test('the authority flip lives only in the two mutation entry points', () => {
  // Restated during the Stage 3 incident repair. applyLeadChanges gained its own
  // canonical path: a batch that wrote Sheets first and then upserted Supabase
  // was a last-write-wins route around compare-and-set. The decision still
  // lives inside the abstraction, in its two entry points, and nowhere else.
  const branches = [...stateSrc.matchAll(/outreachWriteAuthority\(env\) === 'supabase'/g)].map(match => match.index);
  assert.equal(branches.length, 2, 'no third place may decide who is canonical');
  const single = stateSrc.indexOf('async function applyLeadChange(');
  const batch = stateSrc.indexOf('async function applyLeadChanges(');
  assert.ok(branches[0] > single && branches[0] < batch, 'one branch is inside applyLeadChange');
  assert.ok(branches[1] > batch, 'the other is inside applyLeadChanges');
  const serverSrc = readSource(path.join(root, 'server.js'));
  const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
  for (const [name, src] of [['server.js', serverSrc], ['outreach-agent.js', agentSrc]]) {
    assert.ok(!/applyCanonicalChange/.test(src),
      `${name} must not call the canonical writer directly — that is the abstraction's job`);
  }
});

test('write authority is off by default, so deploying 3F changes nothing', () => {
  assert.equal(outreachWriteAuthority({}), 'sheets');
  assert.equal(outreachWriteAuthority({ SUPABASE_OUTREACH_MODE: 'primary' }), 'sheets',
    'the read cutover must not drag write authority with it');
});
