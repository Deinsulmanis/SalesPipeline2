'use strict';

// Behavioural tests for the two P0 fixes and the activity-history fix.
//
// server.js calls app.listen() at require time and outreach-agent.js calls
// run() at require time, so neither can simply be imported. Instead the REAL
// function bodies are lifted out of the source and evaluated against mocks.
// That matters: these tests exercise the shipped code, not a paraphrase of it.
// Nothing here touches Google, a provider, or the network — no credentials are
// read and no message can be sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const { MANUAL_HOLD_TAG, applyHoldToNotes, stageRequiresHold, hasManualHold,
        HUMAN_OWNED_STAGES, stageTransitionCheck } = require('../integrations/pipeline-state');

// Lift a top-level function declaration out of a source file by brace matching.
function grabFn(src, name) {
  const re = new RegExp('(?:^|\\n)((?:async\\s+)?function\\s+' + name + '\\s*\\()', 'm');
  const m = re.exec(src);
  assert.ok(m, 'could not find function ' + name);
  // Start at the `async` keyword when present. Slicing from `function` would
  // silently strip it, and the lifted body then fails to parse on its first await.
  const from = m.index + m[0].indexOf(m[1]);
  let depth = 0, i = src.indexOf('{', from);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(i < src.length && open !== -1, 'unbalanced braces reading ' + name);
  return src.slice(from, i + 1);
}

// Evaluate lifted functions inside a sandbox holding only the deps they need.
function load(src, names, context) {
  const sandbox = { module: {}, exports: {}, console, JSON, String, Number, Boolean,
    Object, Array, Date, Math, parseInt, parseFloat, isNaN, RegExp, Error, Promise, ...context };
  vm.createContext(sandbox);
  const code = names.map(n => grabFn(src, n)).join('\n\n')
    + '\n;(' + JSON.stringify(names) + ').forEach(n => { globalThis[n + "__fn"] = eval(n); });';
  vm.runInContext(code, sandbox);
  const out = {};
  for (const n of names) out[n] = sandbox[n + '__fn'];
  return out;
}

// ── 1. AGENT SIDE: a held lead is excluded from every send loop ─────────────

function agentSuppression({ suppressedEmails = [] } = {}) {
  const SUPPRESSED = new Set(suppressedEmails.map(e => e.toLowerCase().trim()));
  const { sendSuppressionReason, SEND_SUPPRESSION_TAGS } = require('../integrations/pipeline-state');
  // The agent's suppressionReason is now a one-line delegation to this shared
  // rule, so exercising the shared rule IS exercising the production guard --
  // no source-slicing sandbox needed. A separate assertion below proves the
  // agent still delegates rather than growing its own copy.
  const suppressionReason = lead => sendSuppressionReason(lead, { suppressedEmails: SUPPRESSED });
  return { suppressionReason, SUPPRESSION_TAGS: [...SEND_SUPPRESSION_TAGS] };
}

test('MANUAL HOLD is registered in the agent suppression tag list', () => {
  const { SUPPRESSION_TAGS } = agentSuppression();
  assert.ok(SUPPRESSION_TAGS.includes(MANUAL_HOLD_TAG), 'MANUAL HOLD missing from SUPPRESSION_TAGS');
  // existing protections must still be present — this fix must not weaken them
  assert.ok(SUPPRESSION_TAGS.includes('[REPLY: Unsubscribed]'), 'unsubscribe protection lost');
  assert.ok(SUPPRESSION_TAGS.includes('[BOUNCED'), 'bounce protection lost');
});

test('a held lead is refused by the real suppressionReason()', () => {
  const { suppressionReason } = agentSuppression();
  const held = { email: 'a@example.test', notes: MANUAL_HOLD_TAG + ' promoted from reply' };
  assert.equal(suppressionReason(held), MANUAL_HOLD_TAG);
  // and an ordinary lead is still sendable — the hold must not suppress everyone
  assert.equal(suppressionReason({ email: 'b@example.test', notes: 'ordinary note' }), null);
  assert.equal(suppressionReason({ email: 'c@example.test', notes: '' }), null);
});

test('existing opt-out and bounce suppression still work unchanged', () => {
  const { suppressionReason } = agentSuppression({ suppressedEmails: ['listed@example.test'] });
  assert.equal(suppressionReason({ email: 'x@example.test', notes: '[REPLY: Unsubscribed]' }), '[REPLY: Unsubscribed]');
  assert.equal(suppressionReason({ email: 'y@example.test', notes: '[BOUNCED 2026-01-01]' }), '[BOUNCED');
  // durable email-keyed list, independent of notes
  assert.equal(suppressionReason({ email: 'listed@example.test', notes: '' }), 'suppression-list');
});

test('every send loop consults suppressionReason, so one tag covers them all', () => {
  const guards = agentSrc.match(/const suppressed = suppressionReason\(lead\);/g) || [];
  assert.ok(guards.length >= 4, 'expected >=4 send-loop guards, found ' + guards.length);
  // The tag list has exactly one definition, in pipeline-state, shared by the
  // sender and the health checker. The agent must not keep a second copy.
  assert.ok(!/const SUPPRESSION_TAGS\s*=/.test(agentSrc), 'the agent must not redeclare the tag list');
  const { SEND_SUPPRESSION_TAGS } = require('../integrations/pipeline-state');
  assert.deepEqual([...SEND_SUPPRESSION_TAGS],
    ['[REPLY: Unsubscribed]', '[BOUNCED', '[MANUAL HOLD]'],
    'the permanent opt-out tags must still come before the reversible hold');
});

// ── 2. CRM SIDE: which stages apply the hold ────────────────────────────────

test('every human-owned stage applies the hold; active stages do not', () => {
  for (const stage of ['hot', 'call_booked', 'closed_won', 'closed_lost']) {
    assert.equal(stageRequiresHold(stage), true, stage + ' must apply a hold');
  }
  assert.equal(stageRequiresHold('follow_up'), false);
  assert.equal(stageRequiresHold(''), false);
  // the list is derived from the canonical stages, not hardcoded twice
  assert.deepEqual([...HUMAN_OWNED_STAGES].sort(), ['call_booked', 'closed_lost', 'closed_won', 'hot']);
});

test('legacy raw stage values map through displayStageFor before the hold decision', () => {
  assert.equal(stageRequiresHold('lost'), true);      // legacy -> closed_lost
  assert.equal(stageRequiresHold('closed'), true);    // legacy -> closed_lost
  assert.equal(stageRequiresHold('proposal'), true);  // legacy -> call_booked
  assert.equal(stageRequiresHold('new'), false);      // legacy -> follow_up
});

test('applying a hold twice is a no-op, so re-saving cannot stack events', () => {
  const once = applyHoldToNotes('existing note');
  const twice = applyHoldToNotes(once);
  assert.equal(once, twice);
  assert.ok(hasManualHold(once));
  assert.equal(applyHoldToNotes(''), MANUAL_HOLD_TAG);
  // the prior note text is preserved, never overwritten
  assert.match(once, /existing note/);
});

// ── 3. CRM SIDE: the hold reaches the right ColdEmail rows ──────────────────

function serverHold(rows) {
  const writes = [];
  const sheetsMock = () => ({
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: [['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage', 'emailStatus', 'lastEmailedAt', 'emailStep', 'notes'], ...rows] } }),
        update: async (args) => { writes.push({ range: args.range, value: args.requestBody.values[0][0] }); return {}; },
      },
    },
  });
  const api = load(serverSrc, ['findColdEmailTwins', 'applyManualHold'], {
    sheets: sheetsMock,
    SPREADSHEET_ID: 'test-sheet',
    CE_SHEET_NAME: 'ColdEmail',
    normalizeEmail: e => String(e || '').toLowerCase().trim(),
    applyHoldToNotes,
  });
  // applyManualHold calls findColdEmailTwins by name inside the sandbox
  return { ...api, writes };
}

const ROW = (id, email, notes = '', status = 'emailed') =>
  [id, 'Co ' + id, '', email, '', 'Dental', '', 'Contacted', status, '2026-08-01T00:00:00Z', '1', notes];

test('the hold targets the ColdEmail row by its CE- foreign key first', async () => {
  const { applyManualHold, writes } = serverHold([
    ROW('abc', 'target@example.test'),
    ROW('zzz', 'other@example.test'),
  ]);
  const held = await applyManualHold('CE-abc', 'target@example.test');
  assert.equal(held.length, 1);
  assert.equal(held[0].id, 'abc');
  assert.equal(held[0].matchedBy, 'id');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].range, 'ColdEmail!L2');
  assert.ok(writes[0].value.includes(MANUAL_HOLD_TAG));
});

test('a board lead with no CE- key falls back to the exact normalized email', async () => {
  const { applyManualHold, writes } = serverHold([
    ROW('abc', 'other@example.test'),
    ROW('def', '  Target@Example.TEST '),
  ]);
  const held = await applyManualHold('hand-added-id', 'target@example.test');
  assert.equal(held.length, 1);
  assert.equal(held[0].id, 'def');
  assert.equal(held[0].matchedBy, 'email');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].range, 'ColdEmail!L3');
});

test('duplicate ColdEmail rows for one address are ALL held', async () => {
  // holding only one of a duplicated pair would still leak a send
  const { applyManualHold, writes } = serverHold([
    ROW('dup1', 'dupe@example.test'),
    ROW('unrelated', 'someone@example.test'),
    ROW('dup2', 'dupe@example.test'),
  ]);
  const held = await applyManualHold('CE-dup1', 'dupe@example.test');
  assert.equal(held.length, 2);
  // Array.from rebuilds in this realm: values crossing the vm boundary carry the
  // sandbox's Array prototype, which deepStrictEqual rejects.
  assert.deepEqual(Array.from(held, h => h.id).sort(), ['dup1', 'dup2']);
  assert.equal(writes.length, 2);
});

test('a similarly named but different contact is never touched', async () => {
  const { applyManualHold, writes } = serverHold([
    ROW('real', 'real@example.test'),
    ROW('lookalike', 'lookalike@example.test'),   // same company prefix, different address
  ]);
  const held = await applyManualHold('CE-real', 'real@example.test');
  assert.equal(held.length, 1);
  assert.equal(held[0].id, 'real');
  assert.equal(writes.length, 1);
  assert.ok(!writes.some(w => w.range === 'ColdEmail!L3'), 'unrelated contact was written to');
});

test('re-saving a lead already on hold writes nothing and reports nothing', async () => {
  const { applyManualHold, writes } = serverHold([
    ROW('abc', 'target@example.test', MANUAL_HOLD_TAG + ' already held'),
  ]);
  const held = await applyManualHold('CE-abc', 'target@example.test');
  assert.equal(held.length, 0, 'no rows should be reported changed');
  assert.equal(writes.length, 0, 'no sheet write should occur');
});

test('a board lead with no ColdEmail record holds nothing and does not throw', async () => {
  const { applyManualHold, writes } = serverHold([ROW('abc', 'someone@example.test')]);
  const held = await applyManualHold('board-only', 'nobody@example.test');
  assert.equal(held.length, 0);
  assert.equal(writes.length, 0);
});

test('no ColdEmail row is ever created — the hold only updates the notes column', async () => {
  const appends = [];
  const api = load(serverSrc, ['findColdEmailTwins', 'applyManualHold'], {
    sheets: () => ({ spreadsheets: { values: {
      get: async () => ({ data: { values: [[], ROW('abc', 'a@example.test')] } }),
      update: async () => ({}),
      append: async (a) => { appends.push(a); return {}; },
    } } }),
    SPREADSHEET_ID: 'test-sheet', CE_SHEET_NAME: 'ColdEmail',
    normalizeEmail: e => String(e || '').toLowerCase().trim(), applyHoldToNotes,
  });
  await api.applyManualHold('CE-abc', 'a@example.test');
  assert.equal(appends.length, 0, 'applyManualHold must never append a row');
});

// ── 4. SERVER-SIDE STAGE VALIDATION ─────────────────────────────────────────

test('Call Booked without a meeting time is rejected by the shared gate', () => {
  const gate = stageTransitionCheck('call_booked', { meetingAt: '', outcome: '' });
  assert.equal(gate.ok, false);
  assert.equal(gate.field, 'meetingAt');
});

test('Call Booked with a meeting time is accepted', () => {
  assert.equal(stageTransitionCheck('call_booked', { meetingAt: '2026-09-01T17:00:00Z' }).ok, true);
});

test('Closed / Lost without a loss reason is rejected; with one it is accepted', () => {
  assert.equal(stageTransitionCheck('closed_lost', { outcome: '' }).ok, false);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'closed_won' }).ok, false);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'ghosted' }).ok, true);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'timing' }).ok, true);
});

test('Closed Won and Follow Up carry no extra gate, per the shared model', () => {
  assert.equal(stageTransitionCheck('closed_won', {}).ok, true);
  assert.equal(stageTransitionCheck('follow_up', {}).ok, true);
});

test('PUT /api/leads/:id enforces the gate server-side, before the write', () => {
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/leads/:id'"));
  const handler = put.slice(0, put.indexOf('\napp.'));
  const gateAt = handler.indexOf('stageTransitionCheck');
  const writeAt = handler.indexOf('spreadsheets.values.update');
  assert.notEqual(gateAt, -1, 'route does not call stageTransitionCheck');
  assert.ok(gateAt < writeAt, 'validation must run BEFORE the sheet write');
  assert.match(handler, /res\.status\(422\)/, 'invalid transition must be rejected with 422');
  // rules must not be duplicated in the route
  assert.ok(!/meetingAt.*required|LOSS_OUTCOME_IDS\.includes/.test(handler), 'route re-implements gate rules');
  // and it must read U:W, since meetingAt/outcome are not in the request body
  assert.match(handler, /A\$\{rowNum\}:W\$\{rowNum\}/);
});

test('validation and hold run only on a real transition, not on every save', () => {
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/leads/:id'"));
  const handler = put.slice(0, put.indexOf('\napp.'));
  assert.match(handler, /const isTransition = displayStageFor\(nextStage\) !== displayStageFor\(previousStage\)/);
  assert.match(handler, /if \(isTransition\) \{[\s\S]*?stageTransitionCheck/);
  assert.match(handler, /if \(isTransition\) \{[\s\S]*?stageRequiresHold\(nextStage\)/);
});

// ── 5. ACTIVITY HISTORY ─────────────────────────────────────────────────────

function sendActivity() {
  const logged = [];
  const { recordSendActivity } = load(agentSrc, ['recordSendActivity'], {
    recordColdCallActivity: async (r) => { logged.push(r); },
    cleanCompanyName: c => String(c || '').trim(),
  });
  return { recordSendActivity, logged };
}
const ATTRIBUTION = Object.freeze({ campaignVersion: 'dental_v1_measured', campaignFamily: 'dental_ai_receptionist', sequenceId: 'cold_outreach', sequenceStep: 1, copyVersion: 'dental_risk_reversal_hp_v1', subjectStrategy: 'service_curiosity_v1' });

test('a successful step-1 send records initial_email_sent with safe metadata', async () => {
  const { recordSendActivity, logged } = sendActivity();
  await recordSendActivity(
    { id: 'lead1', email: 'a@example.test', company: 'Galaxy Dental', campaign: 'Surrey Dentists', emailTemplateId: 'dental-guarantee-v1' },
    1, {
      result: { data: { id: 'msg-123', threadId: 'thr-9' } },
      subject: 'A guarantee for Galaxy Dental', body: 'Hi there,\n\nExact final body.',
      personalizationMetadata: {
        selectedAngle: 'invisalign', personalizationLevel: 2,
        evidence: { field: 'siteContext', snippet: 'Offers Invisalign' },
        demoCapabilityId: 'generic_listen', demoCapabilityConfirmed: true,
        validationStatus: 'valid',
      },
      attribution: ATTRIBUTION,
    },
    '2026-08-25T10:00:00Z',
  );
  assert.equal(logged.length, 1);
  const e = logged[0];
  assert.equal(e.eventType, 'initial_email_sent');
  assert.equal(e.leadId, 'CE-lead1');
  assert.equal(e.sourceLeadId, 'lead1');
  assert.equal(e.occurredAt, '2026-08-25T10:00:00Z');
  assert.equal(e.subject, 'A guarantee for Galaxy Dental');
  assert.equal(e.content, 'Hi there,\n\nExact final body.');
  const meta = JSON.parse(e.metadata);
  assert.equal(meta.step, 1);
  assert.equal(meta.gmailMessageId, 'msg-123');
  assert.equal(meta.gmailThreadId, 'thr-9');
  assert.equal(meta.trigger, 'cold_sequence_step_1');
  assert.equal(meta.personalization.selectedAngle, 'invisalign');
  assert.equal(meta.personalization.personalizationLevel, 2);
  assert.equal(meta.personalization.validationStatus, 'valid');
  // no secrets or provider internals
  const blob = JSON.stringify(e).toLowerCase();
  for (const banned of ['token', 'apikey', 'api_key', 'secret', 'refresh', 'credential', 'authorization']) {
    assert.ok(!blob.includes(banned), 'activity row leaked "' + banned + '"');
  }
});

test('later steps are typed as follow_up_sent so initial_email_sent keeps one meaning', async () => {
  const { recordSendActivity, logged } = sendActivity();
  await recordSendActivity({ id: 'l', email: 'a@e.test', company: 'C' }, 2,
    { result: { data: { id: 'm2' } }, subject: 's', attribution: { ...ATTRIBUTION, sequenceStep: 2 } }, '2026-08-25T10:00:00Z');
  await recordSendActivity({ id: 'l', email: 'a@e.test', company: 'C' }, 3,
    { result: { data: { id: 'm3' } }, subject: 's', attribution: { ...ATTRIBUTION, sequenceStep: 3 } }, '2026-08-25T11:00:00Z');
  assert.deepEqual(logged.map(e => e.eventType), ['follow_up_sent', 'follow_up_sent']);
  assert.deepEqual(logged.map(e => JSON.parse(e.metadata).step), [2, 3]);
});

test('the event id is derived from the Gmail message id, so retries are detectable', async () => {
  const { recordSendActivity, logged } = sendActivity();
  const lead = { id: 'l1', email: 'a@e.test', company: 'C' };
  const meta = { result: { data: { id: 'msg-abc' } }, subject: 's', attribution: ATTRIBUTION };
  await recordSendActivity(lead, 1, meta, '2026-08-25T10:00:00Z');
  await recordSendActivity(lead, 1, meta, '2026-08-25T10:05:00Z'); // simulated double-callback
  assert.equal(logged[0].eventId, 'gmail:msg-abc');
  assert.equal(logged[0].eventId, logged[1].eventId, 'same send must yield the same stable event id');
});

test('a send with no provider id still records, using a deterministic fallback id', async () => {
  const { recordSendActivity, logged } = sendActivity();
  await recordSendActivity({ id: 'l1', email: 'a@e.test', company: 'C' }, 1, { attribution: ATTRIBUTION }, '2026-08-25T10:00:00Z');
  assert.equal(logged[0].eventId, 'l1:step1:2026-08-25T10:00:00Z');
  assert.equal(JSON.parse(logged[0].metadata).gmailMessageId, '');
});

test('a future send without a registered attribution is rejected', async () => {
  const { recordSendActivity } = sendActivity();
  await assert.rejects(() => recordSendActivity({ id: 'l1' }, 1, null, '2026-08-25T10:00:00Z'), /missing campaign attribution/);
});

test('activity is recorded only after a real send and a successful write', () => {
  // markSent is reached only after an awaited sendEmail in both cold loops.
  const sends = agentSrc.match(/const sendResult = await sendEmail\(\{[^}]*\}\);\s*\n\s*await withAuth\(\(\) => markSent\(/g) || [];
  assert.equal(sends.length, 2, 'expected 2 send->markSent pairs, found ' + sends.length);
  // ...and the record happens after the batchUpdate, inside the try, before return
  const markSentBody = grabFn(agentSrc, 'markSent');
  const writeAt = markSentBody.indexOf('batchUpdate');
  const recordAt = markSentBody.indexOf('recordSendActivity');
  const returnAt = markSentBody.indexOf('return;', writeAt);
  assert.ok(writeAt !== -1 && recordAt > writeAt, 'record must follow the bookkeeping write');
  assert.ok(recordAt < returnAt, 'record must run before markSent returns');
  // a failed send throws before markSent, so nothing is logged
  assert.match(agentSrc, /catch \(e\) \{\s*\n\s*console\.error\(`❌ Failed/);
});

test('a failed provider send records no activity', async () => {
  // Simulates the loop: sendEmail rejects, so markSent/recordSendActivity are
  // never reached and the timeline stays clean.
  const { recordSendActivity, logged } = sendActivity();
  const sendEmail = async () => { throw new Error('provider 500'); };
  let markSentCalls = 0;
  const markSent = async () => { markSentCalls++; await recordSendActivity({ id: 'x' }, 1, null, 'now'); };
  try {
    await sendEmail();
    await markSent();
  } catch (_) { /* the real loop catches and logs */ }
  assert.equal(markSentCalls, 0);
  assert.equal(logged.length, 0);
});

// ── 6. REGRESSION: nothing about sending changed ────────────────────────────

test('sending cadence, caps and delays are untouched', () => {
  assert.match(agentSrc, /const MIN_DELAY = 45 \* 1000;/);
  assert.match(agentSrc, /const MAX_DELAY = 120 \* 1000;/);
  assert.match(agentSrc, /DAILY_SEND_LIMIT \|\| '40'/);
  assert.match(agentSrc, /delayDays: 3,/);
  assert.match(agentSrc, /delayDays: 5,/);
});

test('every send path is accounted for and gated', () => {
  // Step 10 added exactly one new call site: the stage-sequence pass. Counting
  // alone would be a weak guard, so this also proves the new one is behind BOTH
  // the stage feature flag and the existing kill switch. The former
  // open-triggered cold path was deliberately removed because opens are passive.
  const calls = agentSrc.match(/await sendEmail\(/g) || [];
  assert.equal(calls.length, 6, 'sendEmail call count changed: ' + calls.length);

  const pass = agentSrc.slice(agentSrc.indexOf('async function runStageSequencePass'), agentSrc.indexOf('async function run()'));
  assert.equal((pass.match(/await sendEmail\(/g) || []).length, 1, 'the stage pass sends from one place');
  assert.match(pass, /if \(!STAGE_SEQUENCES_ENABLED\) \{/, 'gated by the stage flag');
  assert.match(pass, /if \(!SENDING_ENABLED\) \{/, 'and by the global kill switch');
  assert.ok(pass.indexOf('STAGE_SEQUENCES_ENABLED') < pass.indexOf('sendEmail'), 'the flag is checked first');
  // The stage pass must never touch cold-sequence state.
  assert.ok(!/emailStep|lastEmailedAt|markSent/.test(pass), 'cold sequence state is untouched');
});

test('recipient selection is unchanged apart from suppression', () => {
  assert.match(agentSrc, /function selectQueued[\s\S]{0,400}l\.stage !== QUEUE_STAGE/);
  assert.match(agentSrc, /function selectFollowUps[\s\S]{0,200}emailStatus !== 'emailed'/);
});

test('demo-play dedupe and reply handling still stop the sequence', () => {
  assert.match(agentSrc, /if \(fired\.has\(`\$\{lead\.id\}\|both-audios`\)\) continue;/);
  assert.match(agentSrc, /lead\.emailStatus = 'replied';/);
  assert.match(agentSrc, /addSuppression\(lead\.email, 'unsubscribe'/);
});
