'use strict';

// The both-audios intent BACKSTOP, made conditional.
//
// The normal path is event-driven: /demo-played appends the play, checks whether
// it completed a pair, and launches an intent-only pass at once. The backstop
// exists for the cases that path can miss. It used to launch a whole agent
// process every three minutes, around the clock, whether or not anything could
// be pending — and every launch downloads the full outreach corpus from
// Supabase (the Calendar pre-check used to download it a second time). Almost
// every one of those passes logged "no pending candidates".
//
// The tick is unchanged ('1-59/3'); a tick now launches only while the backstop
// is ARMED, i.e. the application has a recorded reason to believe intent work
// may exist:
//
//   boot                   a new server process knows nothing yet
//   demo-launch-skipped    a demo play completed a pair but its immediate
//                          launch did not start (agent busy, Calendar blocked,
//                          the pair check itself failed)
//   previous-pass-failed   an intent pass exited non-zero, or without reporting
//                          its intent state
//   pending-work           a pass (intent-only or a scheduled run) ended with
//                          intent candidates still undelivered
//   pending-hint           the 30-minute check-only pass, which already holds
//                          the full snapshot, found intent work by the same
//                          predicates — the only observer of work created
//                          OUTSIDE the demo-play flow (a corpus edit that makes
//                          a legacy company key unique, a repair script, a
//                          hand-edited sheet)
//
// It is disarmed ONLY when an intent-only pass exits 0, its last report says
// `due=0` over the whole corpus, and no new reason was recorded after it
// started. A crash, a kill, a missing report or a reason arriving mid-pass
// leaves it armed, so the failure mode is the old three-minute polling, never
// silence.
//
// PURE: no Sheets, no Supabase, no agent import, no timers.

const { attributeDemoPlays, demoPlayForLead } = require('./demo-attribution');
const { hasDemoPairHistory, hasUndeliveredDemoPair } = require('./demo-intent-state');

const INTENT_STATE_TAG = '[intent-state]';
const INTENT_STATE_SOURCE = Object.freeze({
  PREPARE: 'prepare',               // candidates found, before any delivery
  INTENT_PASS: 'intent-pass',       // candidates still undelivered after the pass
  CHECK_ONLY_HINT: 'check-only-hint',
});
const BACKSTOP_REASON = Object.freeze({
  BOOT: 'boot',
  DEMO_LAUNCH_SKIPPED: 'demo-launch-skipped',
  PASS_FAILED: 'previous-pass-failed',
  PENDING_WORK: 'pending-work',
  PENDING_HINT: 'pending-hint',
});

/** One stdout line the server can parse back out of the agent process. */
function formatIntentStateLine({ due, source, scope = 'all' } = {}) {
  const count = Number.isInteger(due) && due >= 0 ? String(due) : 'unknown';
  return `${INTENT_STATE_TAG} due=${count} source=${source} scope=${scope === 'target' ? 'target' : 'all'}`;
}

/** { due: number|null, source, scope } or null when the line is not a report. */
function parseIntentStateLine(line) {
  const match = /\[intent-state\] due=(\d+|unknown) source=([a-z-]+) scope=(all|target)/.exec(String(line || ''));
  if (!match) return null;
  return { due: match[1] === 'unknown' ? null : Number(match[1]), source: match[2], scope: match[3] };
}

// Exactly the exclusion prepareDemoIntentCandidates() applies before a lead
// becomes due. test/intent-backstop.test.js runs both against the same fixtures.
const repliedLead = lead => lead.emailStatus === 'replied' || lead.stage === 'Replied' || lead.stage === 'Promoted';

/**
 * How many leads an intent pass would have work for, WITHOUT doing any of it.
 *
 * Mirrors prepareDemoIntentCandidates(): a lead is work if its attributed plays
 * form a pair it has never recorded (the pass would persist the pair), or if it
 * holds an undelivered pair and is neither fired nor in a human conversation
 * (the pass would try to deliver). An over-count costs one extra pass — what
 * the old backstop spent every three minutes — but it must never under-count.
 */
function pendingIntentWork({ leads = [], corpus = leads, plays, fired = new Set(), activities = [], companyKey } = {}) {
  const attribution = attributeDemoPlays(corpus, plays, { companyKey });
  let due = 0;
  for (const lead of leads) {
    if (fired.has(`${lead.id}|both-audios`)) continue;
    const play = demoPlayForLead(attribution, lead.id);
    if (play && play.intro >= 1 && play.demo >= 1 && !hasDemoPairHistory(lead, activities)) { due++; continue; }
    if (hasUndeliveredDemoPair(lead, activities) && !repliedLead(lead)) due++;
  }
  return due;
}

function createIntentBackstop() {
  const reasons = new Set([BACKSTOP_REASON.BOOT]);
  let generation = 1;              // bumps on every recorded reason
  const counters = { ticks: 0, idleTicks: 0, cleared: 0 };

  function markNeeded(reason) {
    reasons.add(reason);
    generation += 1;
  }

  /** Called on every backstop tick. Launch only while armed. */
  function onTick() {
    counters.ticks += 1;
    if (!reasons.size) { counters.idleTicks += 1; return { run: false, reasons: [] }; }
    return { run: true, reasons: [...reasons].sort() };
  }

  /** Any agent process is starting. `intent` is an intent-only pass. */
  function onAgentStarted({ intent = false, trigger = '' } = {}) {
    return { intent, trigger, generation, report: null };
  }

  /** Every stdout line of that process. Remembers its latest intent report. */
  function onAgentLine(line, run) {
    const report = parseIntentStateLine(line);
    if (report && run) run.report = report;
    return report;
  }

  /**
   * The process has exited and its stdout is drained. Judged on its LAST
   * report: a pass that found one lead and delivered it ends on `due=0`.
   * Only an intent-only pass may disarm; every other mode can only arm.
   */
  function onAgentClosed(run, exitCode) {
    if (!run) return { cleared: false, reason: 'no run' };
    const report = run.report;
    const pendingReason = report && report.source === INTENT_STATE_SOURCE.CHECK_ONLY_HINT
      ? BACKSTOP_REASON.PENDING_HINT : BACKSTOP_REASON.PENDING_WORK;
    if (!run.intent) {
      if (report && (report.due === null || report.due > 0)) {
        markNeeded(pendingReason);
        return { cleared: false, reason: `reported ${report.due === null ? 'unknown' : report.due} pending` };
      }
      return { cleared: false, reason: 'not an intent pass' };
    }
    if (exitCode !== 0) { markNeeded(BACKSTOP_REASON.PASS_FAILED); return { cleared: false, reason: `exit ${exitCode}` }; }
    if (!report || report.due === null) {
      markNeeded(BACKSTOP_REASON.PASS_FAILED);
      return { cleared: false, reason: 'pass did not report its intent state' };
    }
    if (report.due > 0) { markNeeded(BACKSTOP_REASON.PENDING_WORK); return { cleared: false, reason: `${report.due} lead(s) still pending` }; }
    if (report.scope !== 'all') return { cleared: false, reason: 'a targeted pass cannot vouch for the whole corpus' };
    if (generation !== run.generation) return { cleared: false, reason: 'a new reason arrived during the pass' };
    const had = [...reasons].sort();
    reasons.clear();
    counters.cleared += 1;
    return { cleared: true, reason: had.length ? `nothing pending (was: ${had.join(',')})` : 'nothing pending' };
  }

  function snapshot() {
    return { armed: reasons.size > 0, reasons: [...reasons].sort(), generation, ...counters };
  }

  return { markNeeded, onTick, onAgentStarted, onAgentLine, onAgentClosed, snapshot };
}

module.exports = {
  INTENT_STATE_TAG, INTENT_STATE_SOURCE, BACKSTOP_REASON,
  formatIntentStateLine, parseIntentStateLine, pendingIntentWork, createIntentBackstop,
};
