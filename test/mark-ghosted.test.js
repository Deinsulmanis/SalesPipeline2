'use strict';

// Mark Ghosted: the explicit human close for a dead Hot opportunity. The whole
// point is that it is NOT automatic — staleness surfaces the decision and a
// person makes it. Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OUTCOMES, LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS,
  stageTransitionCheck, reopenEligibility, deriveNextAction,
  ACTION_TYPE, ACTION_STATUS, MANUAL_HOLD_TAG, HUMAN_OWNED_STAGES, stageRequiresHold,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const stateSrc = readSource(path.join(root, 'integrations', 'pipeline-state.js'));

// The mark-ghosted handler body, sliced at its own closing brace.
function ghostHandler() {
  const start = server.indexOf("app.post('/api/leads/:id/mark-ghosted'");
  assert.notEqual(start, -1, 'the route exists');
  const body = server.slice(start);
  return body.slice(0, body.indexOf('\n});'));
}
const handler = ghostHandler();

const NOW = new Date('2026-08-27T19:00:00.000Z');
const twin = (notes = '[REPLY: Interested]') => ({ emailStatus: 'replied', emailStep: '2', notes });

// ── 1–4. Eligibility ────────────────────────────────────────────────────────

test('1/2. the control is reachable only from a Hot lead', () => {
  // hotDrawerRows renders the button, and it returns nothing without hotState.
  const rows = browser.slice(browser.indexOf('function hotDrawerRows(next)'), browser.indexOf('async function logHumanResponse'));
  assert.match(rows, /onclick="openGhostModal\(\)"/, 'the button lives in the Hot rows');
  assert.match(rows, /if \(!hot\) return '';/, 'and renders nothing without Hot state');
  // hotState is produced only for Hot leads.
  assert.equal(deriveNextAction({ stage: 'follow_up' }, twin(), { now: NOW, activities: [] }).hotState, null);
  assert.equal(deriveNextAction({ stage: 'hot' }, twin(), { now: NOW, activities: [] }).hotState !== null, true);
});

test('3/4. terminal leads carry no Hot state, so the control never appears', () => {
  for (const stage of ['closed_won', 'closed_lost', 'call_booked']) {
    const action = deriveNextAction({ stage, outcome: 'ghosted', meetingAt: '2026-09-02T17:00:00.000Z' },
      twin(), { now: NOW, activities: [] });
    assert.equal(action.hotState, null, `${stage} exposes no Hot state`);
  }
});

test('ghosted is the canonical loss outcome, not a browser invention', () => {
  const ghosted = OUTCOMES.find(o => o.id === 'ghosted');
  assert.ok(ghosted, 'the taxonomy defines it');
  assert.equal(ghosted.kind, 'loss');
  assert.equal(ghosted.terminal, true);
  assert.ok(LOSS_OUTCOME_IDS.includes('ghosted'));
  // The server asserts the taxonomy still defines it, so a rename fails loudly.
  assert.match(server, /const GHOSTED_OUTCOME = 'ghosted';/);
  assert.match(server, /if \(!LOSS_OUTCOME_IDS\.includes\(GHOSTED_OUTCOME\)\)/);
});

// ── 5–6. Confirmation gate ──────────────────────────────────────────────────

test('5/6. the button opens a confirmation and mutates nothing on its own', () => {
  const open = browser.slice(browser.indexOf('function openGhostModal()'), browser.indexOf('async function submitMarkGhosted'));
  assert.ok(!/fetch\(/.test(open), 'opening the modal issues no request');
  assert.ok(!/method:\s*'POST'/.test(open));
  assert.match(open, /classList\.add\('open'\)/, 'it only shows the dialog');
  // The write lives behind an explicit second press.
  assert.match(open, /onclick="submitMarkGhosted\(\)"/);
  assert.match(browser, /This will move the lead to <strong>Closed Lost<\/strong> with outcome <strong>Ghosted<\/strong>/);
  // The modal states the context the operator needs to decide.
  for (const label of ['Current stage', 'Waiting on', 'Last interaction', 'Conversation age', 'Next action']) {
    assert.ok(open.includes(label), `modal shows ${label}`);
  }
});

// ── 7–10. Server transition and race safety ─────────────────────────────────

test('7/8. confirming writes closed_lost and the ghosted outcome', () => {
  assert.match(handler, /values: \[\['closed_lost'\]\]/);
  assert.match(handler, /values: \[\[GHOSTED_OUTCOME\]\]/);
  // Targeted cells only — stage (M) and outcome (V).
  const ranges = [...handler.matchAll(/range: `\$\{SHEET_NAME\}!([A-Z])\$\{rowNum\}`/g)].map(m => m[1]);
  assert.deepEqual(ranges.sort(), ['M', 'V'], 'writes exactly the stage and outcome cells');
  // And the pair goes in ONE batch, so a half-closed lead cannot result.
  assert.match(handler, /values\.batchUpdate/);
  assert.equal((handler.match(/values\.(update|append|batchUpdate|clear)\(/g) || []).length, 1,
    'one mutating sheet call');
});

test('9. the server validates through the shared gate, not a private copy', () => {
  assert.match(handler, /stageTransitionCheck\('closed_lost', \{ meetingAt: row\[20\] \|\| '', outcome: GHOSTED_OUTCOME \}\)/);
  assert.match(handler, /res\.status\(422\)/);
  // The gate really does accept ghosted and reject a missing reason.
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'ghosted' }).ok, true);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: '' }).ok, false);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'nonsense' }).ok, false);
  assert.ok(!/function stageTransitionCheck/.test(server), 'no second copy of the rules');
});

test('10. a raced stage is refused, never overwritten', () => {
  // Current STORED stage decides — not whatever the browser believed.
  assert.match(handler, /const prior = await sheets\(\)\.spreadsheets\.values\.get\(/);
  assert.match(handler, /const currentStage = displayStageFor\(rawStage\);/);
  assert.match(handler, /if \(currentStage !== 'hot'\) \{/);
  assert.match(handler, /res\.status\(409\)/);
  assert.match(handler, /code: 'stage_changed'/);
  // The read happens before any write.
  assert.ok(handler.indexOf('values.get') < handler.indexOf('values.batchUpdate'));
  assert.ok(handler.indexOf("currentStage !== 'hot'") < handler.indexOf('values.batchUpdate'),
    'the stage check gates the write');
  // The browser reloads rather than leaving a stale drawer on a race.
  assert.match(browser, /if \(data\.code === 'stage_changed'\) \{ closeGhostModal\(\); await loadLeads\(\); renderBoard\(\); \}/);
});

// ── 11–16. Automation safety ────────────────────────────────────────────────

test('11. the manual hold is preserved, and applied before the stage write', () => {
  assert.ok(HUMAN_OWNED_STAGES.includes('closed_lost'), 'closed_lost is human-owned');
  assert.equal(stageRequiresHold('closed_lost'), true);
  assert.match(handler, /if \(stageRequiresHold\('closed_lost'\)\) \{/);
  assert.match(handler, /applyManualHold\(req\.params\.id, email\)/);
  // Hold first: a later failure leaves a held lead, never a mailable one.
  assert.ok(handler.indexOf('applyManualHold') < handler.indexOf('values.batchUpdate'));
  // Nothing here removes or rewrites the tag.
  assert.ok(!/clearResume|removeHold|applyHoldToNotes\(''\)/.test(handler));
  assert.ok(!new RegExp('MANUAL_HOLD_TAG\\s*=').test(handler));
});

test('12/13/14/15/16. no send, no sequence, no timestamp, no suppression change', () => {
  assert.ok(!/sendEmail|nodemailer|gmail\(|transporter/i.test(handler), 'cannot send');
  assert.ok(!/emailStep|lastEmailedAt|emailStatus/.test(handler), 'sequence state untouched');
  assert.ok(!/addSuppression|SUPPRESSION_SHEET|suppressedEmails/.test(handler), 'suppression untouched');
  assert.ok(!/applyResumeToNotes|RESUME/.test(handler), 'never reactivates a sequence');
  // The write range proves it: only M and V, never the agent columns R:T.
  assert.ok(!/![RST]\$\{rowNum\}/.test(handler));
  // The browser side cannot send either.
  const ui = browser.slice(browser.indexOf('// ── MARK GHOSTED'), browser.indexOf('// ── REACTIVATION'));
  assert.ok(!/sendEmail/i.test(ui));
  assert.equal((ui.match(/fetch\(/g) || []).length, 1, 'exactly one request, the close itself');
});

// ── 17–18. Next Action after closure ────────────────────────────────────────

test('17/18. a ghosted lead becomes terminal and drops Hot staleness', () => {
  const activities = [{ eventType: 'positive_reply', occurredAt: '2026-01-01T10:00:00.000Z' }];
  // Before: Hot and long overdue.
  const before = deriveNextAction({ stage: 'hot', followup: '2026-01-01' }, twin(), { now: NOW, activities });
  assert.equal(before.status, ACTION_STATUS.OVERDUE);
  assert.equal(before.hotState.staleness, 'severely_stale');
  // After: terminal, no action, no staleness, and explicitly not overdue.
  const after = deriveNextAction({ stage: 'closed_lost', outcome: 'ghosted', followup: '2026-01-01' },
    twin(), { now: NOW, activities });
  assert.equal(after.type, ACTION_TYPE.NONE_LOST);
  assert.equal(after.status, ACTION_STATUS.NONE);
  assert.equal(after.dueAt, null);
  assert.equal(after.hotState, null, 'Hot staleness no longer applies');
  assert.equal(after.needsAttention, false);
  for (const bad of [ACTION_STATUS.OVERDUE, ACTION_STATUS.DUE_TODAY, ACTION_STATUS.WAITING]) {
    assert.notEqual(after.status, bad);
  }
  assert.ok(!/Follow up|Waiting for prospect/.test(after.label));
});

// ── 19–22. Timeline and idempotency ─────────────────────────────────────────

test('19/20. the close is recorded canonically and appends to history', () => {
  assert.match(handler, /eventType: 'stage_changed'/, 'reuses the canonical event');
  assert.match(handler, /content: 'Closed Lost — Ghosted'/);
  assert.match(handler, /fromStage: currentStage, toStage: 'closed_lost'/);
  assert.match(handler, /outcome: GHOSTED_OUTCOME, trigger: 'manual_mark_ghosted'/);
  // Append-only: no history is rewritten or deleted.
  assert.match(handler, /appendColdCallActivities\(\[/);
  assert.ok(!/values\.clear|values\.update\(/.test(handler), 'prior history is never overwritten');
  // A timeline failure must not undo a successful close.
  assert.match(handler, /closed, but activity write failed/);
});

test('21/22. a repeated request is idempotent and records nothing twice', () => {
  // Already ghosted: success, no write, no event.
  assert.match(handler, /if \(currentStage === 'closed_lost' && currentOutcome === GHOSTED_OUTCOME\)/);
  assert.match(handler, /return res\.json\(\{ ok: true, alreadyGhosted: true/);
  const early = handler.indexOf('alreadyGhosted: true');
  assert.ok(early < handler.indexOf('values.batchUpdate'), 'the early return precedes any write');
  assert.ok(early < handler.indexOf('appendColdCallActivities'), 'and precedes any activity');
  // Belt and braces: the event id is derived, and deduped before appending.
  assert.match(handler, /stableActivityId\('stage-changed', \[req\.params\.id, currentStage, 'closed_lost', GHOSTED_OUTCOME\]\)/);
  assert.match(handler, /if \(!existing\.some\(activity => activity\.eventId === eventId\)\)/);
});

// ── 23. Reopen compatibility ────────────────────────────────────────────────

test('23. ghosted stays recoverable, so reopen eligibility is not corrupted', () => {
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('ghosted'), 'ghosted is a pause, not a verdict');
  const held = { emailStatus: 'replied', notes: MANUAL_HOLD_TAG + ' [REPLY: Interested]' };
  const reopen = reopenEligibility({ stage: 'closed_lost', outcome: 'ghosted' }, held);
  assert.equal(reopen.reopenable, true);
  assert.match(reopen.reason, /recoverable/);
  // A hard loss still is not reopenable — closing as ghosted did not weaken that.
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'not_interested' }, held).reopenable, false);
  // And opting out still beats a recoverable outcome.
  const optedOut = { emailStatus: 'done', notes: '[REPLY: Unsubscribed]' };
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'ghosted' }, optedOut).reopenable, false);
});

// ── 24–25. Drawer refresh and mobile ────────────────────────────────────────

test('24. the drawer refreshes to the terminal state instead of going stale', () => {
  const submit = browser.slice(browser.indexOf('async function submitMarkGhosted'), browser.indexOf('// ── REACTIVATION'));
  assert.match(submit, /await loadLeads\(\)/, 'reloads the board data');
  assert.match(submit, /await loadNextActions\(\)/, 'and the derived actions');
  assert.match(submit, /renderBoard\(\)/);
  assert.match(submit, /openDetail\(leadId\)/, 'and re-renders the open drawer');
  assert.match(submit, /closeGhostModal\(\)/);
});

test('25. the control and modal stay usable on mobile', () => {
  const mobile = browser.slice(browser.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.btn-ghost-lead \{ min-height:44px/, 'meets the touch-target standard');
  assert.match(mobile, /\.ghost-fact \{ flex-direction:column/, 'facts stack rather than squeeze');
  assert.match(browser, /class="modal-close" onclick="closeGhostModal\(\)" aria-label="Close"/);
  assert.match(browser, /role="dialog" aria-modal="true" aria-labelledby="ghost-title"/);
});

// ── The core promise ────────────────────────────────────────────────────────

test('nothing automatic can ever mark a lead ghosted', () => {
  // Every use of the constant is either its guarded declaration or the single
  // human-triggered route — nothing else in the server can write the outcome.
  const declEnd = server.indexOf('}', server.indexOf('if (!LOSS_OUTCOME_IDS.includes(GHOSTED_OUTCOME))'));
  const routeStart = server.indexOf("app.post('/api/leads/:id/mark-ghosted'");
  const routeEnd = routeStart + handler.length;
  for (const match of [...server.matchAll(/GHOSTED_OUTCOME/g)]) {
    const at = match.index;
    const inDecl = at <= declEnd;
    const inRoute = at >= routeStart && at <= routeEnd;
    assert.ok(inDecl || inRoute, `GHOSTED_OUTCOME used outside the declaration and the route at index ${at}`);
  }
  assert.equal((browser.match(/mark-ghosted/g) || []).length, 1, 'one caller, behind a confirmation');
  // The staleness model decides no outcome.
  const hotBlock = stateSrc.slice(stateSrc.indexOf('// ── HOT LEAD STALENESS'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/ghosted|closed_lost/.test(hotBlock), 'staleness never names an outcome');
  // And no scheduled job, cron or agent path can call it.
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  assert.ok(!/mark-ghosted|GHOSTED/.test(agent), 'the sending agent cannot close a lead');
  assert.ok(!/cron[\s\S]{0,400}mark-ghosted/.test(server), 'no schedule triggers it');
});
