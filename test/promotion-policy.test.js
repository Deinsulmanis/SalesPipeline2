'use strict';

// Safety audit of the deployed promotion policy. Nothing here touches Google,
// a provider or the network, and no message can be sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROMOTION_TRIGGER: T, AUTO_STAGE_RANK,
  promotionSuppressionReason, resolvePromotionIdentity, promotionDecision,
} = require('../integrations/promotion-policy');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agent = readSource(path.join(root, 'outreach-agent.js'));
const server = readSource(path.join(root, 'server.js'));

const ce = (over = {}) => ({
  id: 'L1', email: 'a@example.test', company: 'A Dental', notes: '',
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', ...over,
});
const board = stage => ({ status: 'matched', matchedBy: 'ce_id', boardLead: { id: 'CE-L1', stage, email: 'a@example.test' } });
const fresh = { status: 'new', matchedBy: '', boardLead: null };
const decide = over => promotionDecision({ coldEmailLead: ce(), identity: fresh, ...over });

// ── 1–2. Positive reply ─────────────────────────────────────────────────────

test('1. a positive reply promotes an Outreach-only lead to Hot', () => {
  for (const trigger of [T.POSITIVE_REPLY, T.LATE_POSITIVE_REPLY]) {
    const d = decide({ trigger });
    assert.equal(d.shouldPromote, true);
    assert.equal(d.targetStage, 'hot');
    assert.equal(d.shouldCreate, true);
    assert.equal(d.safety, 'safe');
  }
});

test('2. a positive reply can never downgrade Call Booked or a terminal stage', () => {
  for (const existing of ['call_booked', 'closed_won', 'closed_lost', 'hot']) {
    const d = decide({ trigger: T.POSITIVE_REPLY, identity: board(existing) });
    assert.equal(d.targetStage, existing, `${existing} must be retained`);
    assert.equal(d.shouldMove, false, `${existing} must not be written`);
    assert.equal(d.shouldCreate, false);
    assert.match(d.reason, /precedence/);
  }
  // Only a genuine step up is written.
  const up = decide({ trigger: T.POSITIVE_REPLY, identity: board('follow_up') });
  assert.equal(up.targetStage, 'hot');
  assert.equal(up.shouldMove, true);
  // The rank table is the thing that guarantees it.
  assert.ok(AUTO_STAGE_RANK.call_booked > AUTO_STAGE_RANK.hot);
  assert.ok(AUTO_STAGE_RANK.closed_won >= AUTO_STAGE_RANK.call_booked);
  assert.ok(AUTO_STAGE_RANK.closed_lost >= AUTO_STAGE_RANK.call_booked);
});

// ── 3–8. Signals that must never auto-promote ───────────────────────────────

test('3/4/5/7/8. weak or negative signals never auto-promote', () => {
  for (const trigger of [
    T.NEEDS_HUMAN, T.NEGATIVE_REPLY, T.UNCLASSIFIED_REPLY,
    T.OPEN, T.WARM, T.SEQUENCE_COMPLETE, T.QUEUED,
  ]) {
    const d = decide({ trigger });
    assert.equal(d.shouldPromote, false, `${trigger} must not promote`);
    assert.equal(d.safety, 'review');
    assert.equal(d.targetStage, undefined);
  }
  // An unrecognised trigger is refused too, rather than defaulting.
  assert.equal(decide({ trigger: 'something_new' }).shouldPromote, false);
  assert.equal(decide({}).shouldPromote, false);
});

test('6. only a VERIFIED demo pair with the booking link sent promotes to Follow Up', () => {
  const ok = decide({ trigger: T.VERIFIED_DEMO_PAIR, verifiedDemoPair: true, bookingLinkSent: true });
  assert.equal(ok.targetStage, 'follow_up');
  assert.equal(ok.shouldPromote, true);
  // Every weaker combination is refused — no partial credit.
  for (const [pair, link] of [[true, false], [false, true], [false, false], [undefined, undefined], ['true', 'true']]) {
    const d = decide({ trigger: T.VERIFIED_DEMO_PAIR, verifiedDemoPair: pair, bookingLinkSent: link });
    assert.equal(d.shouldPromote, false, `pair=${pair} link=${link} must not promote`);
  }
});

// ── 9. Hard suppression ─────────────────────────────────────────────────────

test('9. hard suppression blocks every automatic promotion', () => {
  const cases = [
    ['unsubscribe tag', ce({ notes: '[REPLY: Unsubscribed]' }), undefined],
    ['bounce tag', ce({ notes: '[BOUNCED 2026-01-01]' }), undefined],
    ['suppressed tag', ce({ notes: '[SUPPRESSED manual]' }), undefined],
    ['invalid recipient', ce({ notes: '[INVALID RECIPIENT]' }), undefined],
    ['unsub stage', ce({ stage: 'Unsub' }), undefined],
    ['durable list', ce(), new Set(['a@example.test'])],
  ];
  for (const [label, lead, suppressedEmails] of cases) {
    for (const trigger of [T.POSITIVE_REPLY, T.LATE_POSITIVE_REPLY, T.MEETING_BOOKED]) {
      const d = promotionDecision({ trigger, coldEmailLead: lead, identity: fresh, suppressedEmails, meetingAt: '2026-09-01T17:00:00Z' });
      assert.equal(d.shouldPromote, false, `${label} + ${trigger} must be blocked`);
      assert.equal(d.safety, 'blocked');
    }
    assert.ok(promotionSuppressionReason(lead, suppressedEmails || new Set()), `${label} is recognised`);
  }
  // A manual hold is NOT hard suppression — it is exactly the state a human
  // takes a lead into, so it must not block a human promoting the card.
  assert.equal(promotionSuppressionReason(ce({ notes: '[MANUAL HOLD] promoted' })), '');
});

test('hard suppression beats a recoverable-looking board stage', () => {
  const d = promotionDecision({
    trigger: T.POSITIVE_REPLY, coldEmailLead: ce({ notes: '[REPLY: Unsubscribed]' }),
    identity: board('follow_up'),
  });
  assert.equal(d.shouldPromote, false);
});

// ── 10–13. The policy cannot touch sender state ─────────────────────────────

test('11/12/13. the policy is pure: no send, no sequence write, no timestamp write', () => {
  const source = readSource(path.join(root, 'integrations', 'promotion-policy.js'));
  assert.ok(!/sendEmail|nodemailer|gmail\(|sheets\(|fetch\(|axios/i.test(source), 'no I/O of any kind');
  assert.ok(!/emailStatus\s*=|emailStep\s*=|lastEmailedAt\s*=/.test(source), 'writes no sequence state');
  // And the agent's promotion writer only ever touches the board sheet.
  const fn = agent.slice(agent.indexOf('async function upsertColdCallLeadFromEvent'), agent.indexOf('\n}\n', agent.indexOf('async function upsertColdCallLeadFromEvent')));
  assert.ok(!/sendEmail/.test(fn), 'promotion never sends');
  const ranges = fn.match(/range: `\$\{[A-Z_]+\}![^`]*`/g) || [];
  assert.ok(ranges.every(r => r.includes('LEADS_SHEET') || r.includes('LEADS_RANGE')), `promotion writes only the board: ${ranges}`);
  assert.ok(!/CE_SHEET|ColdEmail/.test(fn), 'promotion never writes ColdEmail');
});

test('10. every auto-promotion to a human-owned stage also stops automation', () => {
  // Positive reply: status + stage + MANUAL HOLD, all in one batch write.
  const interested = agent.slice(agent.indexOf('async function handleInterested'), agent.indexOf('async function handleNotInterested'));
  assert.match(interested, /applyHoldToNotes\(/, 'positive reply applies the hold');
  assert.match(interested, /values: \[\['replied'\]\]/, 'and marks the sequence replied');
  // Late positive reply holds too, and only once the promotion succeeded.
  const late = agent.slice(agent.indexOf('LATE_POSITIVE_REPLY'));
  assert.match(late.slice(0, 700), /if \(coldCallLeadId\)[\s\S]{0,200}applyHoldToNotes/);
  // Manual promotion holds BEFORE the board write, so a failure leaves it held.
  const promote = server.slice(server.indexOf("app.post('/api/coldemail/:id/promote'"));
  const body = promote.slice(0, promote.indexOf('\n});'));
  const holdAt = body.indexOf('applyManualHold');
  const writeAt = body.indexOf('values.update');
  assert.ok(holdAt !== -1 && holdAt < writeAt, 'hold is applied before the board write');
});

// ── 14–17. Identity ─────────────────────────────────────────────────────────

test('14/15/16. identity prefers the CE key, falls back to exact email, never guesses', () => {
  const rows = [
    { id: 'CE-L1', email: 'a@example.test', company: 'A Dental' },
    { id: 'B2', email: 'b@example.test', company: 'A Dental' },     // same company!
  ];
  assert.deepEqual(
    (({ status, matchedBy }) => ({ status, matchedBy }))(resolvePromotionIdentity(ce(), rows)),
    { status: 'matched', matchedBy: 'ce_id' });
  // Email fallback when no CE key matches.
  const byEmail = resolvePromotionIdentity(ce({ id: 'OTHER' }), [{ id: 'X', email: 'A@Example.TEST' }]);
  assert.equal(byEmail.matchedBy, 'email', 'normalized exact email matches');
  // A shared company name is never enough.
  const companyOnly = resolvePromotionIdentity(ce({ id: 'OTHER', email: 'zzz@example.test' }), rows);
  assert.equal(companyOnly.status, 'new', 'company name must never resolve identity');
  const policySrc = readSource(path.join(root, 'integrations', 'promotion-policy.js'));
  assert.ok(!/company/i.test(policySrc.slice(policySrc.indexOf('function resolvePromotionIdentity'), policySrc.indexOf('function promotionDecision'))),
    'identity resolution never reads company');
});

test('17. ambiguous identity fails closed', () => {
  const dupeId = resolvePromotionIdentity(ce(), [{ id: 'CE-L1', email: 'a@example.test' }, { id: 'CE-L1', email: 'c@example.test' }]);
  assert.equal(dupeId.status, 'conflict');
  const dupeEmail = resolvePromotionIdentity(ce({ id: 'OTHER' }), [{ id: 'X', email: 'a@example.test' }, { id: 'Y', email: 'a@example.test' }]);
  assert.equal(dupeEmail.status, 'conflict');
  const split = resolvePromotionIdentity(ce(), [{ id: 'CE-L1', email: 'a@example.test' }, { id: 'Z', email: 'a@example.test' }]);
  assert.equal(split.status, 'conflict', 'CE key and email disagreeing is a conflict');
  // Duplicate ColdEmail twins for one address also fail closed.
  const twins = resolvePromotionIdentity(ce({ id: 'OTHER' }), [{ id: 'X', email: 'a@example.test' }], { coldEmailTwinCount: 2 });
  assert.equal(twins.status, 'conflict');
  // And a conflict stops the decision regardless of trigger.
  assert.equal(promotionDecision({ trigger: T.POSITIVE_REPLY, identity: dupeId, coldEmailLead: ce() }).shouldPromote, false);
});

test('the twin-count guard is supplied on EVERY promotion path, not just the server', () => {
  // Regression: the agent used to leave coldEmailTwinCount defaulting to 1, so
  // this fail-closed guard was inert on all three automatic promotion paths.
  const calls = agent.match(/trigger: PROMOTION_TRIGGER\.[A-Z_]+[^}]*\}/g) || [];
  assert.ok(calls.length >= 3, `expected the three agent promotion call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /coldEmailTwinCount:/, `promotion call site omits the twin guard: ${call.slice(0, 90)}`);
  }
  assert.match(agent, /function coldEmailTwinCount\(allLeads, email\)/);
  // The server paths already supplied it and must keep doing so.
  assert.equal((server.match(/coldEmailTwinCount:/g) || []).length, 2);
});

// ── 18–24. Idempotency, manual promotion, validation ────────────────────────

test('18/24. a repeated promotion records its activity once', () => {
  const promote = server.slice(server.indexOf("app.post('/api/coldemail/:id/promote'"));
  const body = promote.slice(0, promote.indexOf('\n});'));
  assert.match(body, /const eventId = stableActivityId\('pipeline-promotion'/, 'the id is derived, not random');
  assert.match(body, /if \(!dataset\.activities\.some\(row => row\.eventId === eventId\)\)/, 'and deduped before append');
  // The agent's late-reply promotion likewise derives its id from the reply.
  assert.match(agent, /eventId: `promotion:\$\{result\.activity\.eventId\}:hot`/);
});

test('19. an existing board card is reused, never duplicated', () => {
  const d = decide({ trigger: T.POSITIVE_REPLY, identity: board('follow_up') });
  assert.equal(d.shouldCreate, false);
  const fn = agent.slice(agent.indexOf('async function upsertColdCallLeadFromEvent'));
  assert.match(fn.slice(0, 2200), /if \(existingIndex >= 1\)[\s\S]{0,400}return existingId;/);
});

test('20/21. manual promotion requires an explicit stage and never defaults', () => {
  assert.equal(promotionDecision({ trigger: T.MANUAL, coldEmailLead: ce(), identity: fresh }).shouldPromote, false);
  for (const bad of ['', '   ', undefined, null]) {
    const d = promotionDecision({ trigger: T.MANUAL, targetStage: bad, coldEmailLead: ce(), identity: fresh });
    assert.equal(d.shouldPromote, false, `stage ${JSON.stringify(bad)} must be refused`);
  }
  // No silent follow_up default anywhere in the manual path.
  const promote = server.slice(server.indexOf("app.post('/api/coldemail/:id/promote'"));
  const body = promote.slice(0, promote.indexOf('\n});'));
  assert.match(body, /if \(!targetStage\) return res\.status\(422\)/);
  assert.ok(!/targetStage \|\| 'follow_up'/.test(body));
  // An invalid stage is refused rather than coerced.
  assert.equal(promotionDecision({ trigger: T.MANUAL, targetStage: 'nonsense', coldEmailLead: ce(), identity: fresh }).shouldPromote, false);
});

test('22. manual promotion cannot alter send eligibility', () => {
  const promote = server.slice(server.indexOf("app.post('/api/coldemail/:id/promote'"));
  const body = promote.slice(0, promote.indexOf('\n});'));
  // It writes the board sheet only; ColdEmail is touched solely to ADD a hold.
  const ranges = [...body.matchAll(/range: `\$\{(\w+)\}!/g)].map(m => m[1]);
  assert.ok(ranges.every(r => r === 'SHEET_NAME'), `manual promotion writes only the board: ${ranges}`);
  assert.ok(!/emailStatus|emailStep|lastEmailedAt/.test(body), 'never rewrites sequence state');
  assert.match(body, /automationResumed: false/);
});

test('23. stage validation stays server-side and shared', () => {
  const policySrc = readSource(path.join(root, 'integrations', 'promotion-policy.js'));
  assert.match(policySrc, /stageTransitionCheck\(targetStage/, 'reuses the one shared gate');
  assert.ok(!/function stageTransitionCheck/.test(policySrc), 'no second copy of the rules');
  // Call Booked without a meeting time is refused on both trigger paths.
  assert.equal(decide({ trigger: T.MEETING_BOOKED }).shouldPromote, false);
  assert.equal(promotionDecision({ trigger: T.MANUAL, targetStage: 'call_booked', coldEmailLead: ce(), identity: fresh }).shouldPromote, false);
  assert.equal(decide({ trigger: T.MEETING_BOOKED, meetingAt: '2026-09-01T17:00:00Z' }).targetStage, 'call_booked');
  // Closed / Lost needs a loss reason.
  assert.equal(promotionDecision({ trigger: T.MANUAL, targetStage: 'closed_lost', coldEmailLead: ce(), identity: fresh }).shouldPromote, false);
  assert.equal(promotionDecision({ trigger: T.MANUAL, targetStage: 'closed_lost', outcome: 'no_show', coldEmailLead: ce(), identity: fresh }).shouldPromote, true);
});

// ── The legacy `Promoted` ColdEmail stage ───────────────────────────────────

test('the legacy Promoted stage is read-only and gates nothing that sends', () => {
  // Nothing writes it: it is a human-set label in the Outreach dropdown.
  assert.ok(!/values: \[\['Promoted'\]\]/.test(agent) && !/values: \[\['Promoted'\]\]/.test(server),
    'automation must not start writing the legacy stage');
  // It is still honoured where it exists, as an extra intent-suppression read.
  assert.match(agent, /lead\.stage === 'Replied' \|\| lead\.stage === 'Promoted'/);
  // Crucially it is NOT what stops the sequence — emailStatus is.
  assert.match(agent, /if \(l\.emailStatus !== 'emailed'\) return false;/);
  assert.ok(!/selectFollowUps[\s\S]{0,600}Promoted/.test(agent), 'the follow-up selector does not consult it');
  const suppression = agent.slice(agent.indexOf('function suppressionReason'), agent.indexOf('function selectQueued'));
  assert.ok(!/Promoted/.test(suppression), 'suppression does not consult it either');
});
