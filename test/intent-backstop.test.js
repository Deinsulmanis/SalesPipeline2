'use strict';

// F2a — the three-minute intent backstop launches only while intent work may be
// pending, instead of launching an agent process (and a full outreach corpus
// download) every three minutes around the clock.
//
// The proof has four parts:
//   A. the backstop state machine arms and disarms exactly as designed;
//   B. the check-only hint uses the SAME predicates as the real
//      prepareDemoIntentCandidates() (run from source against the same fixtures);
//   C. the server's immediate pair check never misses a pair the agent would
//      find, so a completed pair always gets its immediate launch;
//   D. a minute-by-minute scheduler simulation of the production crons proves
//      the ten recovery scenarios and measures corpus reads per day.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BACKSTOP_REASON, INTENT_STATE_SOURCE, formatIntentStateLine, parseIntentStateLine,
  pendingIntentWork, createIntentBackstop,
} = require('../integrations/intent-backstop');
const { aggregateDemoPlays, attributeDemoPlays, demoPlayForLead, proposalTokenFor, normalizeLeadToken } = require('../integrations/demo-attribution');
const demoState = require('../integrations/demo-intent-state');
const { isDatacenterIp } = require('../open-filter');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const server = readSource('server.js');
const agent = readSource('outreach-agent.js');

// Brace-matched source of one top-level declaration, skipping strings,
// template literals and comments. The body starts after the parameter list,
// which may itself contain destructuring braces.
function extract(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  let parens = 0;
  let bodyAt = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    if (src[i] === ')' && --parens === 0) { bodyAt = src.indexOf('{', i); break; }
  }
  let depth = 0;
  for (let i = bodyAt; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${header}`);
}
const lineOf = (src, prefix) => src.split('\n').find(line => line.startsWith(prefix));

// The agent's own company key: normalizeName(cleanCompanyName(company)).
const agentKeys = new Function(`${extract(agent, 'function cleanCompanyName(raw)')}
${extract(agent, 'function normalizeName(str)')}
return { cleanCompanyName, normalizeName };`)();
const demoCompanyKey = company => agentKeys.normalizeName(agentKeys.cleanCompanyName(company));
const AGENT_BOT = new Function(`${lineOf(agent, 'const BOT_UA_PATTERN = ')}
return BOT_UA_PATTERN;`)();
const AGENT_BLOCKED_IPS = new Function(`${lineOf(agent, 'const INTENT_BLOCKED_IPS')}
return INTENT_BLOCKED_IPS;`)();
const agentExcluded = ({ ip, userAgent }) => AGENT_BLOCKED_IPS.includes(ip) || AGENT_BOT.test(userAgent) || isDatacenterIp(ip);

// Deterministic PRNG so every run checks the same thousands of worlds.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// ── A. state machine ─────────────────────────────────────────────────────────

test('A1. a new process is armed for boot and launches on its first tick', () => {
  const b = createIntentBackstop();
  assert.deepEqual(b.onTick(), { run: true, reasons: ['boot'] });
});

test('A2. a clean intent pass that saw nothing pending disarms; idle ticks launch nothing', () => {
  const b = createIntentBackstop();
  const run = b.onAgentStarted({ intent: true, trigger: 'backstop' });
  b.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare' }), run);
  assert.equal(b.onAgentClosed(run, 0).cleared, true);
  for (let i = 0; i < 480; i++) assert.equal(b.onTick().run, false);
  assert.equal(b.snapshot().idleTicks, 480);
});

test('A3. a pass judged on its LAST report: found one, delivered it, ends disarmed', () => {
  const b = createIntentBackstop();
  const run = b.onAgentStarted({ intent: true, trigger: 'demo' });
  b.onAgentLine(formatIntentStateLine({ due: 1, source: 'prepare' }), run);
  b.onAgentLine(formatIntentStateLine({ due: 0, source: 'intent-pass' }), run);
  assert.equal(b.onAgentClosed(run, 0).cleared, true);
  assert.equal(b.onTick().run, false);
});

test('A4. pending work, a failed exit, a signal, or a missing report keep it armed', () => {
  const cases = [
    { lines: [formatIntentStateLine({ due: 2, source: 'prepare' })], code: 0, reason: BACKSTOP_REASON.PENDING_WORK },
    { lines: [formatIntentStateLine({ due: 1, source: 'prepare' }), formatIntentStateLine({ due: 1, source: 'intent-pass' })], code: 0, reason: BACKSTOP_REASON.PENDING_WORK },
    { lines: [formatIntentStateLine({ due: 0, source: 'prepare' })], code: 1, reason: BACKSTOP_REASON.PASS_FAILED },
    { lines: [formatIntentStateLine({ due: 0, source: 'prepare' })], code: null, reason: BACKSTOP_REASON.PASS_FAILED },
    { lines: [], code: 0, reason: BACKSTOP_REASON.PASS_FAILED },
    { lines: [formatIntentStateLine({ due: null, source: 'prepare' })], code: 0, reason: BACKSTOP_REASON.PASS_FAILED },
  ];
  for (const { lines, code, reason } of cases) {
    const b = createIntentBackstop();
    const run = b.onAgentStarted({ intent: true });
    lines.forEach(line => b.onAgentLine(line, run));
    assert.equal(b.onAgentClosed(run, code).cleared, false);
    assert.ok(b.snapshot().reasons.includes(reason), `${reason} recorded for ${JSON.stringify({ lines, code })}`);
    assert.equal(b.onTick().run, true);
  }
});

test('A5. a reason recorded DURING a clean pass survives it', () => {
  const b = createIntentBackstop();
  const run = b.onAgentStarted({ intent: true });
  b.markNeeded(BACKSTOP_REASON.DEMO_LAUNCH_SKIPPED);           // a demo arrived mid-pass
  b.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare' }), run);
  assert.equal(b.onAgentClosed(run, 0).cleared, false);
  assert.deepEqual(b.onTick().reasons, ['boot', 'demo-launch-skipped']);
});

test('A6. other modes can arm but never disarm', () => {
  const b = createIntentBackstop();
  const clean = b.onAgentStarted({ intent: false });
  b.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare' }), clean);
  b.onAgentClosed(clean, 0);
  assert.equal(b.snapshot().armed, true, 'a scheduled run reporting 0 does not disarm');

  const idle = createIntentBackstop();
  const run = idle.onAgentStarted({ intent: true });
  idle.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare' }), run);
  idle.onAgentClosed(run, 0);
  const hint = idle.onAgentStarted({ intent: false });
  idle.onAgentLine(formatIntentStateLine({ due: 1, source: 'check-only-hint' }), hint);
  idle.onAgentClosed(hint, 0);
  assert.deepEqual(idle.onTick().reasons, ['pending-hint']);
  const unknown = createIntentBackstop();
  const r2 = unknown.onAgentStarted({ intent: true });
  unknown.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare' }), r2);
  unknown.onAgentClosed(r2, 0);
  const h2 = unknown.onAgentStarted({ intent: false });
  unknown.onAgentLine(formatIntentStateLine({ due: null, source: 'check-only-hint' }), h2);
  unknown.onAgentClosed(h2, 0);
  assert.deepEqual(unknown.onTick().reasons, ['pending-hint'], 'an unavailable hint arms, conservatively');
});

test('A7. a targeted pass cannot vouch for the whole corpus', () => {
  const b = createIntentBackstop();
  const run = b.onAgentStarted({ intent: true });
  b.onAgentLine(formatIntentStateLine({ due: 0, source: 'prepare', scope: 'target' }), run);
  assert.equal(b.onAgentClosed(run, 0).cleared, false);
  assert.equal(b.snapshot().armed, true);
});

test('A8. the report line round-trips and ignores ordinary log text', () => {
  for (const due of [0, 1, 37, null]) {
    for (const source of Object.values(INTENT_STATE_SOURCE)) {
      const parsed = parseIntentStateLine(`  ${formatIntentStateLine({ due, source })}`);
      assert.deepEqual(parsed, { due, source, scope: 'all' });
    }
  }
  assert.equal(parseIntentStateLine('[Intent] no pending candidates; zero Gmail provider work required.'), null);
  assert.equal(parseIntentStateLine('[outreach-read] automation corpus from Supabase: 2203 lead(s)'), null);
});

// ── B. the hint uses the same predicates as prepareDemoIntentCandidates ──────

// The REAL function, compiled from outreach-agent.js with its dependencies
// injected. Any drift in its predicates changes what this test compares.
const prepareFactory = new Function('deps', `
  const { ensureIntentSheet, readRealDemoPlays, loadFiredIntents, readColdCallActivities,
    attributeDemoPlays, demoCompanyKey, demoPlayForLead, hasDemoPairHistory, buildDemoPairActivity,
    DRY_RUN, recordColdCallActivityStrict, hasUndeliveredDemoPair, formatIntentStateLine,
    INTENT_STATE_SOURCE, TARGET_LEAD_ID, console } = deps;
  return (${extract(agent, 'async function prepareDemoIntentCandidates(')});`);

function randomWorld(r) {
  const companies = ['Smile Dental', 'Smile Dental - Downtown', 'smile  dental!', 'Bright Teeth', 'Bright Teeth | Clinic', 'Oak Family Dentistry', 'City Centre Dentistry'];
  const leads = Array.from({ length: 2 + Math.floor(r() * 7) }, (_, i) => ({
    id: `L${i + 1}`, email: `l${i + 1}@x.test`, company: pick(r, companies),
    stage: pick(r, ['', '', 'Contacted', 'Replied', 'Promoted']),
    emailStatus: pick(r, ['', 'emailed', 'emailed', 'replied']), senderInboxId: 'primary', campaign: '',
  }));
  const header = ['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type', 'lead_token'];
  const rows = [header];
  for (let i = 0, n = Math.floor(r() * 14); i < n; i++) {
    const lead = pick(r, leads);
    const token = pick(r, ['', '', proposalTokenFor(lead.id), 'abcdef0123', 'not-a-token']);
    rows.push([`2026-09-2${Math.floor(r() * 9)}T1${Math.floor(r() * 9)}:00:00.000Z`, pick(r, [lead.company, pick(r, companies)]),
      'dental', pick(r, ['24.1.2.3', '24.1.2.3', '75.155.151.158', '34.1.2.3']),
      pick(r, ['Mozilla/5.0', 'Mozilla/5.0', 'Googlebot']), pick(r, ['intro', 'demo', '']), token]);
  }
  const activities = [];
  for (const lead of leads) {
    if (r() < 0.3) {
      const pair = demoState.buildDemoPairActivity(lead, { intro: 1, demo: 1, last: '2026-09-20T10:00:00.000Z' });
      activities.push(pair);
      if (r() < 0.3) activities.push(demoState.buildDemoPairRetraction(lead, pair, { reason: 'fan-out', retractedAt: '2026-09-21T00:00:00.000Z' }));
    }
    if (r() < 0.25) activities.push({ eventId: `bl:${lead.id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, eventType: 'booking_link_sent', occurredAt: '2026-09-22T00:00:00.000Z', metadata: '{}' });
  }
  const fired = new Set(leads.filter(() => r() < 0.15).map(lead => `${lead.id}|both-audios`));
  return { leads, rows, activities, fired };
}

test('B1. across 3,000 random worlds the hint counts exactly the leads a real pass would act on', async () => {
  const r = rng(20260924);
  let worldsWithWork = 0;
  for (let n = 0; n < 3000; n++) {
    const world = randomWorld(r);
    const plays = aggregateDemoPlays(world.rows, { companyKey: demoCompanyKey, isExcluded: agentExcluded });
    const persisted = [];
    const logs = [];
    const prepare = prepareFactory({
      ensureIntentSheet: async () => {}, readRealDemoPlays: async () => plays, loadFiredIntents: async () => world.fired,
      readColdCallActivities: async () => { throw new Error('snapshot activities must be used'); },
      attributeDemoPlays, demoCompanyKey, demoPlayForLead,
      hasDemoPairHistory: demoState.hasDemoPairHistory, buildDemoPairActivity: demoState.buildDemoPairActivity,
      DRY_RUN: false, recordColdCallActivityStrict: async event => { persisted.push(event); },
      hasUndeliveredDemoPair: demoState.hasUndeliveredDemoPair, formatIntentStateLine, INTENT_STATE_SOURCE,
      TARGET_LEAD_ID: '', console: { log: line => logs.push(line), warn() {} },
    });
    const hint = pendingIntentWork({
      leads: world.leads, corpus: world.leads, plays, fired: world.fired,
      activities: [...world.activities], companyKey: demoCompanyKey,
    });
    const { due } = await prepare(world.leads, { activities: [...world.activities] }, world.leads);
    const acted = new Set([...persisted.map(event => event.sourceLeadId), ...due.map(lead => lead.id)]);
    assert.equal(hint, acted.size, `world ${n}: hint ${hint} vs a real pass acting on ${[...acted]}`);
    assert.deepEqual(parseIntentStateLine(logs.find(line => String(line).startsWith('[intent-state]'))),
      { due: due.length, source: 'prepare', scope: 'all' });
    if (hint) worldsWithWork++;
  }
  assert.ok(worldsWithWork > 300, `the fixtures must exercise real work (${worldsWithWork})`);
});

test('B2. a reply-owned lead with an undelivered pair is not work, so it cannot pin the backstop armed', () => {
  const lead = { id: 'P1', email: 'peddent@x.test', company: 'Ped Dent', stage: 'Replied', emailStatus: 'replied' };
  const pair = demoState.buildDemoPairActivity(lead, { intro: 1, demo: 1, last: '2026-09-20T10:00:00.000Z' });
  const plays = aggregateDemoPlays([[], ['t', 'Ped Dent', '', '24.1.1.1', 'Mozilla', 'intro', proposalTokenFor('P1')],
    ['t2', 'Ped Dent', '', '24.1.1.1', 'Mozilla', 'demo', proposalTokenFor('P1')]], { companyKey: demoCompanyKey });
  assert.equal(pendingIntentWork({ leads: [lead], plays, activities: [pair], companyKey: demoCompanyKey }), 0);
});

// ── C. the server's immediate pair check never misses an agent pair ──────────

const serverCheck = new Function('deps', `
  const { sheets, SPREADSHEET_ID, normalizeLeadToken } = deps;
  ${lineOf(server, 'const BOT_PATTERNS = ')}
  ${extract(server, 'function normalizeAudioType(raw)')}
  ${extract(server, 'function cleanCompanyName(raw)')}
  ${extract(server, 'function openKey(company)')}
  return (${extract(server, 'async function companyHasBothAudios(')});`);

test('C1. the pair-check inputs are identical to the agent\'s, or strictly more permissive', () => {
  assert.equal(extract(server, 'function cleanCompanyName(raw)'), extract(agent, 'function cleanCompanyName(raw)'));
  assert.equal(lineOf(server, 'const BOT_PATTERNS = ').split('=')[1], lineOf(agent, 'const BOT_UA_PATTERN = ').split('=')[1]);
  assert.match(extract(server, 'function openKey(company)'), /cleanCompanyName\(company \|\| ''\)\.toLowerCase\(\)\.trim\(\)\.replace\(\/\[\^a-z0-9\]\/g, ''\)/);
  assert.match(extract(server, 'async function companyHasBothAudios('), /\['75\.155\.151\.158'\]\.includes\(ip\)/);
  assert.deepEqual(AGENT_BLOCKED_IPS, ['75.155.151.158']);
});

test('C2. across 2,000 random DemoPlays histories, every play that completes an agent pair passes the server check', async () => {
  const r = rng(424242);
  let completions = 0;
  const names = ['Smile Dental', 'smile dental', 'Smile  Dental!', 'Smile Dental - North', 'SMILE-DENTAL', 'Oak Dentistry', 'Oak  Dentistry.', 'Café Dental', 'Cafe Dental'];
  for (let n = 0; n < 2000; n++) {
    const corpus = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) => ({ id: `C${n}-${i}`, company: pick(r, names) }));
    const rows = [['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type', 'lead_token']];
    for (let i = 0, count = 2 + Math.floor(r() * 8); i < count; i++) {
      const owner = pick(r, corpus);
      const row = [`2026-09-24T0${i}:00:00.000Z`, pick(r, [owner.company, pick(r, names)]), 'dental',
        pick(r, ['24.1.2.3', '24.1.2.3', '34.9.9.9']), 'Mozilla/5.0', pick(r, ['intro', 'demo']),
        pick(r, ['', '', proposalTokenFor(owner.id)])];
      const before = attributeDemoPlays(corpus, aggregateDemoPlays(rows, { companyKey: demoCompanyKey, isExcluded: agentExcluded }), { companyKey: demoCompanyKey });
      rows.push(row);
      const after = attributeDemoPlays(corpus, aggregateDemoPlays(rows, { companyKey: demoCompanyKey, isExcluded: agentExcluded }), { companyKey: demoCompanyKey });
      const paired = attribution => new Set(corpus.filter(lead => {
        const play = demoPlayForLead(attribution, lead.id);
        return play && play.intro >= 1 && play.demo >= 1;
      }).map(lead => lead.id));
      const was = paired(before);
      const completed = [...paired(after)].filter(id => !was.has(id));
      if (!completed.length) continue;
      completions++;
      // /demo-played only reaches the check for a real, named company.
      const check = serverCheck({
        sheets: () => ({ spreadsheets: { values: { get: async () => ({ data: { values: rows } }) } } }),
        SPREADSHEET_ID: 'sheet', normalizeLeadToken,
      });
      assert.equal(await check(row[1], normalizeLeadToken(row[6])), true,
        `history ${n}: the play that completed ${completed} must launch the immediate pass`);
    }
  }
  assert.ok(completions > 300, `the histories must exercise real completions (${completions})`);
});

// ── wiring: the server and agent use the state machine as designed ───────────

test('W1. the tick launches only while armed; the schedule and send window are unchanged', () => {
  const block = server.slice(server.indexOf("cron.schedule('1-59/3 * * * *'"), server.indexOf('// Calendar incremental sync is independently gated'));
  assert.match(block, /const tick = intentBackstop\.onTick\(\);\s*if \(!tick\.run\) return;\s*spawnAgentIntentOnly\(`cron backstop: \$\{tick\.reasons\.join\(','\)\}`, \{ trigger: 'backstop' \}\);/);
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5'/);
  assert.match(server, /cron\.schedule\('15,45 \* \* \* \*'/);
  assert.match(server, /^const intentBackstop = createIntentBackstop\(\);$/m, 'module scope: armed for boot in every new process');
});

test('W2. a demo launch that does not start arms the backstop, on every route out', () => {
  const fn = extract(server, 'function spawnAgentIntentOnly(');
  assert.match(fn, /const skipped = \(\) => \{ if \(trigger === 'demo'\) intentBackstop\.markNeeded\(BACKSTOP_REASON\.DEMO_LAUNCH_SKIPPED\); \};/);
  assert.match(fn, /if \(agentState\.running \|\| automationLaunchReserved\) \{\s*skipped\(\);/);
  assert.match(fn, /\.then\(result => \{ if \(!result \|\| !result\.launched\) skipped\(\); \}\)/);
  assert.match(fn, /\.catch\(error => \{\s*skipped\(\);/);
  assert.ok(fn.indexOf('launchAutomationAfterCalendar') < fn.indexOf('startAgentProcess'), 'Calendar is still observed first');
  const fire = extract(server, 'async function maybeFireIntent(');
  assert.match(fire, /spawnAgentIntentOnly\(`both audios played — \$\{company\}`, \{ trigger: 'demo' \}\)/);
  assert.match(fire, /catch \(e\) \{[\s\S]*intentBackstop\.markNeeded\(BACKSTOP_REASON\.DEMO_LAUNCH_SKIPPED\)/);
  const pixel = server.slice(server.indexOf("app.get('/demo-played'"), server.indexOf('// ── HOT-LEAD ENGAGEMENT TRACKING'));
  assert.match(pixel, /\.then\(\(\) => maybeFireIntent\(company, leadToken\)\)/, 'the immediate path is unchanged');
});

test('W3. every agent process reports into the backstop and is judged after stdout drains', () => {
  const fn = extract(server, 'function startAgentProcess(');
  assert.match(fn, /intent: extraEnv\.INTENT_ONLY === 'true' && extraEnv\.CHECK_ONLY !== 'true'/);
  assert.match(fn, /intentBackstop\.onAgentLine\(l, intentRun\)/);
  assert.match(fn, /child\.on\('close', code => \{[\s\S]*intentBackstop\.onAgentClosed\(intentRun, code\)/);
  assert.doesNotMatch(fn.slice(fn.indexOf("child.on('close'")), /startAgentProcess|spawnAgent|launchAutomation/,
    'a finished run never launches anything itself');
});

test('W4. the agent reports before delivery, after delivery, and from check-only before any Gmail work', () => {
  const prepare = extract(agent, 'async function prepareDemoIntentCandidates(');
  assert.match(prepare, /formatIntentStateLine\(\{\s*due: due\.length, source: INTENT_STATE_SOURCE\.PREPARE/);
  const pass = extract(agent, 'async function runIntentTriggerPass(');
  assert.match(pass, /formatIntentStateLine\(\{\s*due: due\.length - sent, source: INTENT_STATE_SOURCE\.INTENT_PASS/);
  assert.ok(pass.lastIndexOf('sent++') < pass.indexOf('INTENT_STATE_SOURCE.INTENT_PASS'));
  const run = agent.slice(agent.indexOf('async function run()'));
  const hint = run.indexOf('if (CHECK_ONLY) await reportIntentWorkHint(all, snapshot, allLeadsForDailyCap);');
  assert.ok(hint > run.indexOf('const all = await readLeads(snapshot.coldEmail)'));
  assert.ok(hint < run.indexOf('if (INTENT_ONLY && !CHECK_ONLY)'));
  assert.ok(hint < run.indexOf('runHumanOutboundPass('));
  const fn = extract(agent, 'async function reportIntentWorkHint(');
  assert.doesNotMatch(fn, /recordColdCallActivity|append\(|applyLeadChange|send/i, 'the hint writes and sends nothing');
});

test('W5. no send gate, limit or sequence path was touched', () => {
  // The intent pass's gates are byte-identical apart from the trailing report.
  const pass = extract(agent, 'async function runIntentTriggerPass(');
  for (const gate of ['suppressionReason(lead)', 'coldSendGate(lead, ownershipContext)', 'todaySent >= DAILY_SEND_LIMIT',
    'sender.dailyLimit', 'sendingWindowVerdict(intentWindowQuota, sender.id)', 'deliverHardenedWarmReply({',
    "currentFired.has(`${current.id}|both-audios`)"]) {
    assert.ok(pass.includes(gate), `${gate} still gates intent delivery`);
  }
});

// ── D. scheduler simulation ──────────────────────────────────────────────────
//
// A minute-by-minute model of the production crons and launch mutex:
//   :00/:30 7-11 Mon-Fri   scheduled send run (Calendar check first)
//   :15/:45                check-only pass (no Calendar check)
//   1-59/3                 intent backstop (Calendar check first)
//   1,6,11,…,56            Calendar reconciliation (skips while a launch holds the slot)
// plus /demo-played requests at chosen minutes. The backstop is the REAL state
// machine and reads the REAL report lines. Corpus reads are counted where
// production pays them: one per agent process, one per per-send fresh check,
// and one per Calendar check that loads booking context.

const MODES = { production: { f1: false, f2a: false }, f1: { f1: true, f2a: false }, f1f2a: { f1: true, f2a: true } };

class Sim {
  // Durations from production: an intent-only or check-only pass finishes
  // inside its minute (the :16 intent tick after the :15 check-only still ran
  // in the measured flows); a send run holds the mutex for most of a window.
  constructor({ mode = 'f1f2a', pending = [], sendsPerRun = 6, sendRunMinutes = 14, checkOnlyMinutes = 1 } = {}) {
    Object.assign(this, MODES[mode], { sendsPerRun, sendRunMinutes, checkOnlyMinutes });
    this.backstop = createIntentBackstop();
    this.pending = new Map(pending.map(item => [item.id, { deliverable: true, ...item }]));
    this.busyUntil = -1;
    this.closing = null;
    this.reads = { agent: 0, server: 0 };
    this.launches = [];
    this.delivered = new Map();
    this.calendarEvents = 0;
    this.calendarFailAt = new Set();
    this.intentFailAt = new Set();
    this.demoAt = new Map();
    this.appearAt = new Map();
    this.concurrent = 0;
    this.maxConcurrent = 0;
  }
  static clock(t) {
    const day = Math.floor(t / 1440) % 7;       // 0 = Monday
    return { day, hour: Math.floor(t / 60) % 24, minute: t % 60 };
  }
  restart() {
    // A new server process: a new, armed backstop. A pass in flight dies with
    // the old process and never reports.
    this.backstop = createIntentBackstop();
    this.busyUntil = -1;
    this.closing = null;
    this.concurrent = 0;
  }
  calendarCheck(t) {
    if (this.calendarFailAt.has(t)) return false;
    if (!this.f1 || this.calendarEvents > 0) this.reads.server++;
    this.calendarEvents = 0;
    return true;
  }
  start(t, kind, trigger, minutes) {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.launches.push({ t, kind, trigger });
    this.reads.agent++;                                   // readLeads(): one full corpus
    const run = this.backstop.onAgentStarted({ intent: kind === 'intent', trigger });
    const say = report => this.backstop.onAgentLine(`  ${formatIntentStateLine(report)}`, run);
    let code = 0;
    if (kind === 'check-only') {
      say({ due: this.pending.size, source: 'check-only-hint' });
    } else {
      if (kind === 'send') this.reads.agent += this.sendsPerRun;   // per-send fresh re-check (F3, unchanged)
      const due = [...this.pending.values()];
      say({ due: due.length, source: 'prepare' });
      if (kind === 'intent' && this.intentFailAt.has(t)) code = 1;
      else if (due.length) {
        let sent = 0;
        for (const lead of due) {
          if (!lead.deliverable) continue;
          this.pending.delete(lead.id);
          this.delivered.set(lead.id, [...(this.delivered.get(lead.id) || []), { t, via: `${kind}:${trigger}` }]);
          sent++;
        }
        say({ due: due.length - sent, source: 'intent-pass' });
      }
    }
    this.busyUntil = t + minutes;
    this.closing = { run, code, at: t + minutes };
  }
  spawnIntent(t, trigger) {
    const skipped = () => { if (this.f2a && trigger === 'demo') this.backstop.markNeeded(BACKSTOP_REASON.DEMO_LAUNCH_SKIPPED); };
    if (this.busyUntil > t || this.reserved === t) { skipped(); return; }
    this.reserved = t;
    if (!this.calendarCheck(t)) { skipped(); return; }
    this.start(t, 'intent', trigger, 1);
  }
  step(t) {
    if (this.closing && this.closing.at <= t) {
      this.backstop.onAgentClosed(this.closing.run, this.closing.code);
      this.closing = null;
      this.concurrent--;
    }
    for (const [id, item] of this.appearAt) if (item.t === t) this.pending.set(id, { id, deliverable: true, ...item });
    const { day, hour, minute } = Sim.clock(t);
    if (day < 5 && hour >= 7 && hour <= 11 && (minute === 0 || minute === 30) && this.busyUntil <= t) {
      this.reserved = t;
      if (this.calendarCheck(t)) this.start(t, 'send', 'scheduled', this.sendRunMinutes);
    }
    if ((minute === 15 || minute === 45) && this.busyUntil <= t) this.start(t, 'check-only', 'cron', this.checkOnlyMinutes);
    if (minute % 3 === 1) {
      if (!this.f2a) this.spawnIntent(t, 'backstop');
      else if (this.backstop.onTick().run) this.spawnIntent(t, 'backstop');
    }
    if (minute % 5 === 1 && this.busyUntil <= t && this.reserved !== t) this.calendarCheck(t);
    for (const demo of this.demoAt.get(t) || []) {
      this.pending.set(demo.id, { id: demo.id, deliverable: demo.deliverable !== false });
      this.spawnIntent(t, 'demo');
    }
  }
  run(from, to) { for (let t = from; t < to; t++) this.step(t); return this; }
  launchesOf(kind, trigger) { return this.launches.filter(l => l.kind === kind && (!trigger || l.trigger === trigger)); }
  get corpusReads() { return this.reads.agent + this.reads.server; }
}

const SAT = 5 * 1440;                  // Saturday 00:00 Pacific
const MON = 0;                         // Monday 00:00 Pacific
const hours = n => n * 60;

test('D0. the model reproduces the measured production baseline: 50 full-corpus reads an hour off-window', () => {
  // Measured 2026-09-24 02:00-03:00 UTC on the Supabase host: 50 x 1.31 MB.
  const sim = new Sim({ mode: 'production' }).run(SAT, SAT + hours(3));
  const before = sim.corpusReads;
  sim.run(SAT + hours(3), SAT + hours(4));
  assert.equal(sim.corpusReads - before, 50);
});

test('D-budget. full-corpus reads per day: production vs F1 vs F1 + F2a', () => {
  const day = (mode, start) => new Sim({ mode }).run(start, start + 1440);
  const budget = {};
  for (const mode of ['production', 'f1', 'f1f2a']) {
    budget[mode] = { weekday: day(mode, MON).corpusReads, weekend: day(mode, SAT).corpusReads };
  }
  // Written out so a change in any path shows up here as a number.
  // Weekend production = 24 x 50, the measured hourly rate. Weekdays add ten
  // send runs, each paying one corpus read plus one per send (F3, unchanged),
  // while holding the mutex against the ticks that would otherwise fire.
  assert.deepEqual(budget, {
    production: { weekday: 1160, weekend: 1200 },
    f1: { weekday: 548, weekend: 528 },
    f1f2a: { weekday: 119, weekend: 49 },
  });
  assert.ok(budget.f1.weekday < budget.production.weekday * 0.5);
  assert.ok(budget.f1f2a.weekday < budget.production.weekday * 0.12);
  console.log(`[budget] full-corpus reads/day ${JSON.stringify(budget)}`);
});

test('D1. demo played normally: the immediate pass delivers and no backstop pass follows', () => {
  const sim = new Sim().run(SAT, SAT + 60);                         // boot pass disarms
  assert.equal(sim.backstop.snapshot().armed, false);
  sim.demoAt.set(SAT + 200, [{ id: 'D1' }]);
  sim.run(SAT + 60, SAT + 1440);
  assert.deepEqual(sim.delivered.get('D1'), [{ t: SAT + 200, via: 'intent:demo' }]);
  assert.equal(sim.launchesOf('intent', 'backstop').length, 1, 'only the boot pass');
});

test('D2. a demo launch skipped while the agent is busy is picked up by the backstop', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 75, [{ id: 'D2' }]);                          // :15 check-only holds the mutex
  sim.run(SAT + 60, SAT + 120);
  const [delivery] = sim.delivered.get('D2');
  assert.equal(delivery.via, 'intent:backstop');
  assert.ok(delivery.t - (SAT + 75) <= 6, `recovered within two ticks (${delivery.t - SAT - 75} min)`);
  assert.equal(sim.backstop.snapshot().armed, false, 'and disarms once delivered');
});

test('D2b. a demo launch blocked by a failed Calendar observation is retried by the backstop', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 200, [{ id: 'D2b' }]);
  sim.calendarFailAt.add(SAT + 200);
  sim.run(SAT + 60, SAT + 300);
  assert.equal(sim.delivered.get('D2b')[0].via, 'intent:backstop');
  assert.ok(sim.delivered.get('D2b')[0].t <= SAT + 203);
});

test('D3. a failed pass is retried on the next tick', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 200, [{ id: 'D3' }]);
  sim.intentFailAt.add(SAT + 200);
  sim.run(SAT + 60, SAT + 300);
  assert.equal(sim.delivered.get('D3').length, 1);
  assert.equal(sim.delivered.get('D3')[0].t, SAT + 202, 'the next tick (:22) after the failed :20 pass');
});

test('D4. pending work keeps the backstop polling until it is delivered, then it stops', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 200, [{ id: 'D4', deliverable: false }]);   // e.g. sender proof missing
  sim.run(SAT + 60, SAT + 260);
  const polls = sim.launchesOf('intent', 'backstop').filter(l => l.t > SAT + 200).length;
  assert.ok(polls >= 18, `still polling every tick while pending (${polls})`);
  sim.pending.get('D4').deliverable = true;
  sim.run(SAT + 260, SAT + 1440);
  assert.equal(sim.delivered.get('D4').length, 1);
  const after = sim.launchesOf('intent', 'backstop').filter(l => l.t > sim.delivered.get('D4')[0].t);
  assert.equal(after.length, 0, 'no pass after the delivering one');
});

test('D5. boot with pending work: the boot pass finds and delivers it', () => {
  const sim = new Sim({ pending: [{ id: 'D5' }] }).run(SAT, SAT + 10);
  assert.deepEqual(sim.delivered.get('D5'), [{ t: SAT + 1, via: 'intent:backstop' }]);
});

test('D6. nothing pending: no agent process launches because three minutes elapsed', () => {
  const sim = new Sim().run(SAT, SAT + 2 * 1440);
  assert.equal(sim.launchesOf('intent').length, 1, 'the single boot pass in 48 hours');
  assert.equal(sim.backstop.snapshot().idleTicks, 959);
  assert.deepEqual(new Set(sim.launches.map(l => l.kind)), new Set(['intent', 'check-only']));
});

test('D7. demo plays close together never overlap processes and deliver each lead once', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 200, [{ id: 'A' }, { id: 'B' }]);
  sim.demoAt.set(SAT + 201, [{ id: 'C' }]);
  sim.demoAt.set(SAT + 225, [{ id: 'D' }]);                          // lands during the :45 check-only
  sim.run(SAT + 60, SAT + 400);
  assert.equal(sim.maxConcurrent, 1, 'the single agent mutex holds');
  for (const id of ['A', 'B', 'C', 'D']) assert.equal(sim.delivered.get(id).length, 1, `${id} delivered once`);
  assert.equal(sim.backstop.snapshot().armed, false);
});

test('D8. a restart mid-pass re-arms for boot and recovers the lost pass', () => {
  const sim = new Sim().run(SAT, SAT + 60);
  sim.demoAt.set(SAT + 200, [{ id: 'R', deliverable: false }]);
  sim.run(SAT + 60, SAT + 201);                                      // pass in flight, cannot deliver yet
  sim.pending.get('R').deliverable = true;
  sim.restart();
  sim.run(SAT + 201, SAT + 300);
  assert.equal(sim.delivered.get('R').length, 1);
  assert.ok(sim.delivered.get('R')[0].t <= SAT + 205, 'the first tick after restart');
});

test('D9. send windows: every scheduled send run still launches, with or without pending intent work', () => {
  for (const pending of [[], [{ id: 'W', deliverable: false }]]) {
    const sim = new Sim({ pending }).run(MON, MON + 1440);
    const sends = sim.launchesOf('send').map(l => Sim.clock(l.t));
    assert.equal(sends.length, 10, `10 windows (pending=${pending.length})`);
    assert.ok(sends.every(c => c.minute === 0 || c.minute === 30));
  }
  // Intent work arriving in a window is still delivered by the send run's own
  // intent pass or the next tick, exactly as before.
  const sim = new Sim().run(MON, MON + 60 * 8);
  sim.demoAt.set(MON + 60 * 8 + 5, [{ id: 'S' }]);                    // during the 8:00 send run
  sim.run(MON + 60 * 8, MON + 1440);
  assert.equal(sim.delivered.get('S').length, 1);
});

test('D10. outside send windows nothing new sends: only check-only and needed intent passes run', () => {
  const quiet = new Sim().run(SAT, SAT + 1440);
  assert.equal(quiet.launchesOf('send').length, 0);
  assert.equal(quiet.delivered.size, 0);
  // With the same demo traffic, production and F1 + F2a deliver the same leads
  // at the same minutes — the change removes idle passes, not deliveries.
  const demos = new Map([[SAT + 200, [{ id: 'X' }]], [SAT + 75, [{ id: 'Y' }]], [SAT + 900, [{ id: 'Z' }]]]);
  const outcome = mode => {
    const sim = new Sim({ mode });
    sim.demoAt = new Map(demos);
    sim.run(SAT, SAT + 1440);
    return [...sim.delivered.entries()].map(([id, list]) => [id, list.map(d => d.t)]).sort();
  };
  assert.deepEqual(outcome('f1f2a'), outcome('production'));
});

test('D11. work created outside the demo flow is found by the check-only hint', () => {
  // A corpus change can make a legacy company key unique; no play arrives.
  const sim = new Sim().run(SAT, SAT + 60);
  sim.appearAt.set('OOB', { t: SAT + 100 });
  sim.run(SAT + 60, SAT + 300);
  const [delivery] = sim.delivered.get('OOB');
  assert.equal(delivery.via, 'intent:backstop');
  assert.ok(delivery.t - (SAT + 100) <= 33, `found within one check-only interval (${delivery.t - SAT - 100} min)`);
});

// ── M. measurement ───────────────────────────────────────────────────────────

test('M1. every whole-corpus read is counted by the process that pays for it', async () => {
  const { readOutreachCorpus, outreachCorpusReadStats } = require('../integrations/outreach-state');
  const before = outreachCorpusReadStats();
  const result = await readOutreachCorpus({ env: {} });                 // unconfigured: fails fast, no network
  assert.equal(result.ok, false);
  const after = outreachCorpusReadStats();
  assert.equal(after.reads - before.reads, 1);
  assert.equal(after.failures - before.failures, 1);
});

test('M2. the hourly meter separates Calendar checks, context loads, launches and corpus reads', () => {
  const meter = extract(server, 'function reportEgressMeter(');
  for (const field of ['corpusReads server=', ' agent=', 'calendar checks=', 'zeroEvent=', 'contextLoads=',
    'intent launches demo=', 'backstop=', 'backstop ticks=', 'idle=', 'armed=']) {
    assert.ok(meter.includes(field), `meter reports ${field}`);
  }
  assert.match(server, /cron\.schedule\('59 \* \* \* \*', reportEgressMeter/);
  const sync = extract(server, 'async function runGoogleCalendarSync(');
  assert.match(sync, /if \(result\.contextLoaded\) egressMeter\.calendarContextLoads \+= 1;\s*else egressMeter\.calendarZeroEvent \+= 1;/);
  const spawnFn = extract(server, 'function spawnAgentIntentOnly(');
  assert.match(spawnFn, /if \(trigger === 'demo'\) egressMeter\.intentDemoLaunches \+= 1; else egressMeter\.intentBackstopLaunches \+= 1;/);
});
