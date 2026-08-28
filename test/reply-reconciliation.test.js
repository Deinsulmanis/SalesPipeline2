'use strict';

// Phase 2.1 — historical reply reconciliation.
//
// The module is a PLANNER. Every test below either proves it recovers real
// evidence correctly, or proves it refuses to act when evidence is missing or
// identity is unsafe. Nothing here may write, send, promote, hold or suppress.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RECONCILE_STATUS, planLeadReconciliation, planReconciliation,
  reconciledEventId, stripQuotedReply, htmlToText, classifiableText,
} = require('../integrations/reply-reconciliation');
const { REPLY_STATE, AUTOMATED_SUBTYPE, NEEDS_HUMAN_REASON } = require('../integrations/canonical-reply');
const { classify: classifyLeadEmail } = require('../check-leads');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const lead = (id, over = {}) => ({
  id, company: `${id} Clinic`, email: `${id}@clinic.test`, notes: '', ...over,
});
const msg = (over = {}) => ({
  id: 'm1', threadId: 't1', from: 'x@clinic.test', subject: 'Re: your note',
  body: 'hello', receivedAt: '2026-08-10T10:00:00.000Z', ...over,
});
const activity = (eventId, metadata = {}) => ({ eventId, metadata: JSON.stringify(metadata) });

// Real message shapes, paraphrased from the Gmail threads this pass recovered.
const GLAMORE_LATEST = "I'd rather review it over email tbh. If you don't mind. And pricing too.";
const APPLECROSS = 'This is an automated response. Our office monitors this inbox during business hours.';
const HUSH = 'Thank you for your email. Our clinic is closed for summer break from July 4-20.';
const SURFACE = 'Automatic reply: the clinic is closed July 1 and we will respond once we are back in office.';
const ORAH = 'We have moved! Our new email address is info@orahspa.com. We will no longer reply from this email.';
const COQUITLAM_FIRST = 'Good Morning, thank you for your message. We will go ahead review and forward to our office manager once she is back in the office next week.';

const planOne = (leadRow, messages, activities = []) =>
  planLeadReconciliation(leadRow, messages, activities);

// ── Text recovery ───────────────────────────────────────────────────────────

test('quoted thread is stripped so we classify THEIR words, not our own email', () => {
  // The real failure: an 8,075-character message of which only 2,150 were the
  // prospect's reply. Classifying the whole blob classified our own cold copy,
  // and three leads whose legacy tag correctly said positive came back negative.
  const body = `${GLAMORE_LATEST}\n\nOn Mon, Aug 10, 2026 at 4:00 AM ScaleLab <a@b.com> wrote:\n> Our AI receptionist never misses a call and books appointments`;
  const own = stripQuotedReply(body);
  assert.equal(own, GLAMORE_LATEST);
  assert.ok(!own.includes('AI receptionist'), 'our own copy must not be classified');

  for (const marker of ['-----Original Message-----', '________________', 'From: someone@x.com']) {
    assert.equal(stripQuotedReply(`Reply text.\n\n${marker}\nquoted junk`), 'Reply text.');
  }
});

test('an HTML-only message still yields classifiable text', () => {
  const html = '<div>This is an <b>automated</b> response.</div><p>Please call us.</p>';
  assert.match(htmlToText(html), /This is an automated response/);
  // A real autoresponder arrived with no text/plain part at all.
  const text = classifiableText({ body: '', html });
  assert.ok(text.length, 'HTML-only must not read as "no message body"');
});

// ── Required historical fixtures ────────────────────────────────────────────

test('Glamore: evaluation intent is recovered despite the legacy Not Interested tag', () => {
  const row = lead('glamore', { email: 'info@glamorebeautybar.test', notes: '[REPLY: Not Interested]' });
  const plan = planOne(row, [msg({ from: row.email, body: GLAMORE_LATEST })]);
  assert.equal(plan.status, RECONCILE_STATUS.PROPOSED);
  assert.equal(plan.canonicalState, REPLY_STATE.POSITIVE);
  assert.equal(plan.classificationReason, 'explicit_evaluation_intent');
  assert.equal(plan.genuineHuman, true);
  // The disagreement is DATA, and the legacy tag survives on the event.
  assert.deepEqual(plan.disagreement,
    { legacyState: REPLY_STATE.NEGATIVE, canonicalState: REPLY_STATE.POSITIVE, legacyTag: 'Not Interested' });
  assert.equal(plan.proposedEvent.metadata.legacyTag, 'Not Interested');
  assert.equal(plan.proposedEvent.metadata.supersedesLegacyTag, true);
});

test('Applecross: an autoresponder is not genuine human engagement', () => {
  const row = lead('applecross', { notes: '[REPLY: Needs human]' });
  const plan = planOne(row, [msg({ from: row.email, body: APPLECROSS })]);
  assert.equal(plan.canonicalState, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(plan.subtype, AUTOMATED_SUBTYPE.AUTORESPONDER);
  assert.equal(plan.genuineHuman, false);
});

test('Hush and Surface Skin: temporary closures, with a date only if stated', () => {
  for (const body of [HUSH, SURFACE]) {
    const row = lead('closed');
    const plan = planOne(row, [msg({ from: row.email, body })]);
    assert.equal(plan.canonicalState, REPLY_STATE.AUTOMATED_REPLY, body);
    assert.equal(plan.subtype, AUTOMATED_SUBTYPE.TEMPORARY_CLOSURE);
    assert.equal(plan.genuineHuman, false);
  }
  // A stated return date is captured...
  const withDate = planOne(lead('hush'), [msg({
    from: 'hush@clinic.test', body: `${HUSH} We will resume on July 21.`,
    receivedAt: '2026-07-03T00:00:00.000Z',
  })]);
  assert.equal(withDate.proposedEvent.metadata.returnDate, '2026-07-21');
  // ...and never invented when the message does not state one.
  const noDate = planOne(lead('surface'), [msg({ from: 'surface@clinic.test', body: SURFACE })]);
  assert.equal(noDate.proposedEvent.metadata.returnDate, null);
});

test('Orah: a mailbox migration proposes an address but never mutates identity', () => {
  const row = lead('orah', { email: 'info@orahspasalon.test', notes: '[REPLY: Wrong Person — needs re-enrichment]' });
  const plan = planOne(row, [msg({ from: row.email, body: ORAH })]);
  assert.equal(plan.canonicalState, REPLY_STATE.CONTACT_CHANGE_REVIEW);
  assert.equal(plan.subtype, AUTOMATED_SUBTYPE.MAILBOX_MIGRATION);
  assert.equal(plan.proposedEvent.metadata.proposedEmail, 'info@orahspa.com');
  assert.equal(plan.proposedEvent.metadata.identityMutationAllowed, false);
  // The plan carries no instruction to change the lead's address.
  assert.equal(plan.proposedEvent.email, row.email, 'the canonical address is untouched');
});

test('Coquitlam: the ORIGINAL forward is preserved, not overwritten by later replies', () => {
  const row = lead('coq', { notes: '[REPLY: Needs human]' });
  const plan = planOne(row, [
    msg({ id: 'c1', from: row.email, body: COQUITLAM_FIRST, receivedAt: '2026-08-04T18:03:29.000Z' }),
    msg({ id: 'c2', from: row.email, body: 'Will do, thanks!', receivedAt: '2026-08-04T18:42:20.000Z' }),
    msg({ id: 'c3', from: row.email, body: 'I can give you her email to double check.', receivedAt: '2026-08-27T22:57:40.000Z' }),
  ]);
  assert.equal(plan.status, RECONCILE_STATUS.PROPOSED);
  assert.equal(plan.messageCount, 3);
  assert.equal(plan.proposedEvents.length, 3, 'every message becomes its own evidence');
  // The original forward keeps its specific reason.
  const first = plan.messageStates[0];
  assert.equal(first.canonicalState, REPLY_STATE.NEEDS_HUMAN);
  assert.equal(first.reason, NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER);
  assert.equal(first.genuineHuman, true);
  // ...and the later message supplying the manager contact is preserved too.
  assert.equal(plan.messageStates.length, 3);
  assert.equal(plan.canonicalState, REPLY_STATE.NEEDS_HUMAN);
});

test('a human saying a colleague is "back in the office" is NOT a closure', () => {
  // This misfire classified a genuine conversation as a machine, which would
  // have removed a live opportunity from the genuine-reply count.
  const plan = planOne(lead('coq2'), [msg({ from: 'coq2@clinic.test', body: COQUITLAM_FIRST })]);
  assert.equal(plan.canonicalState, REPLY_STATE.NEEDS_HUMAN);
  assert.notEqual(plan.canonicalState, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(plan.genuineHuman, true);
});

// ── Identity: fail closed ───────────────────────────────────────────────────

test('Silver Springs: a malformed identity is never reconciled', () => {
  const row = lead('silver', { email: '-687-1887silverspringsspa@gmail.com', notes: '[REPLY: Interested]' });
  const plan = planOne(row, [msg({ from: row.email, body: 'Yes please send pricing' })]);
  assert.equal(plan.status, RECONCILE_STATUS.IDENTITY_UNUSABLE);
  assert.equal(plan.proposedEvent, null);
  assert.match(plan.identityIssue, /punctuation/);
});

test('an inexact sender never satisfies identity — no fuzzy or domain matching', () => {
  const row = lead('acme', { email: 'info@acme.test' });
  // Same domain, different mailbox. Plausible, and still refused.
  const plan = planOne(row, [msg({ from: 'reception@acme.test', body: 'Sure, send pricing' })]);
  assert.equal(plan.status, RECONCILE_STATUS.IDENTITY_MISMATCH);
  assert.equal(plan.proposedEvent, null);
  // The module contains no name/company/domain matching at all.
  const src = readSource(path.join(root, 'integrations', 'reply-reconciliation.js'));
  assert.ok(!/company.*match|levenshtein|fuzzy|similar/i.test(src.replace(/^\s*\*.*$/gm, '')));
});

test('missing Gmail evidence is reported, never guessed', () => {
  const plan = planOne(lead('ghost', { notes: '[REPLY: Not Interested]' }), []);
  assert.equal(plan.status, RECONCILE_STATUS.NO_GMAIL_EVIDENCE);
  assert.equal(plan.proposedEvent, null);
  // The legacy tag is still reported, so the record does not vanish.
  assert.equal(plan.legacyState, REPLY_STATE.NEGATIVE);
});

test('a message with no readable text proposes nothing', () => {
  const row = lead('empty');
  const plan = planOne(row, [msg({ from: row.email, body: '   ', html: '' })]);
  assert.equal(plan.status, RECONCILE_STATUS.NO_MESSAGE_BODY);
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test('reconciliation is idempotent by Gmail message id', () => {
  const row = lead('idem');
  const messages = [msg({ id: 'gm-1', from: row.email, body: GLAMORE_LATEST })];
  const first = planOne(row, messages, []);
  assert.equal(first.status, RECONCILE_STATUS.PROPOSED);
  assert.equal(first.proposedEvent.eventId, reconciledEventId('gm-1'));

  // Simulate the event having been applied, then re-plan.
  const applied = [activity(reconciledEventId('gm-1'), { gmailMessageId: 'gm-1' })];
  const second = planOne(row, messages, applied);
  assert.equal(second.status, RECONCILE_STATUS.ALREADY_RECONCILED);
  assert.deepEqual(second.proposedEvents, []);

  // Also recognised when the id is only present in metadata.
  const viaMetadata = planOne(row, messages, [activity('some-other-id', { gmailMessageId: 'gm-1' })]);
  assert.equal(viaMetadata.status, RECONCILE_STATUS.ALREADY_RECONCILED);
});

test('a duplicate provider event never yields a second proposal', () => {
  const row = lead('dup');
  const messages = [
    msg({ id: 'd1', from: row.email, body: 'Send pricing please', receivedAt: '2026-08-01T00:00:00.000Z' }),
    msg({ id: 'd2', from: row.email, body: 'Thanks', receivedAt: '2026-08-02T00:00:00.000Z' }),
  ];
  const partly = planOne(row, messages, [activity(reconciledEventId('d1'))]);
  assert.equal(partly.proposedEvents.length, 1, 'only the unrecorded message is proposed');
  assert.equal(partly.proposedEvents[0].metadata.gmailMessageId, 'd2');
  const ids = partly.proposedEvents.map(event => event.eventId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate event ids');
});

// ── Run-level reporting ─────────────────────────────────────────────────────

test('a run reports disagreements and states plainly that it mutates nothing', () => {
  const report = planReconciliation([
    { lead: lead('a', { notes: '[REPLY: Not Interested]' }), messages: [msg({ from: 'a@clinic.test', body: GLAMORE_LATEST })] },
    { lead: lead('b', { notes: '[REPLY: Needs human]' }), messages: [msg({ id: 'm2', from: 'b@clinic.test', body: APPLECROSS })] },
    { lead: lead('c', { notes: '[REPLY: Not Interested]' }), messages: [] },
  ]);
  assert.equal(report.applied, false);
  assert.equal(report.mutatesProduction, false);
  assert.equal(report.proposedCount, 2);
  assert.equal(report.disagreementCount, 2);
  assert.equal(report.byStatus[RECONCILE_STATUS.NO_GMAIL_EVIDENCE], 1);
  assert.equal(report.projected.unknown, 1, 'the unreconciled lead stays unknown, not assumed');
});

// ── Safety ──────────────────────────────────────────────────────────────────

test('reconciliation cannot send, promote, hold, suppress or write anything', () => {
  const src = readSource(path.join(root, 'integrations', 'reply-reconciliation.js'));
  for (const forbidden of [
    'sendEmail', 'sendMail', 'values.update', 'values.append', 'batchUpdate',
    'googleapis', 'applyHoldToNotes', 'addSuppression', 'promotionDecision',
    'recordColdCallActivity', 'fetch(',
  ]) {
    assert.ok(!src.includes(forbidden), `reconciliation must never reference ${forbidden}`);
  }
  // Planning is pure: the inputs come back untouched.
  const row = lead('pure', { notes: '[REPLY: Not Interested]' });
  const messages = [msg({ from: row.email, body: GLAMORE_LATEST })];
  const before = JSON.stringify({ row, messages });
  planLeadReconciliation(row, messages, []);
  assert.equal(JSON.stringify({ row, messages }), before, 'inputs are not mutated');
});

// ── Malformed import boundary ───────────────────────────────────────────────

test('the scrape-time sanitizer now rejects phone-bleed addresses', () => {
  const src = readSource(path.join(root, 'enrich-leads.js'));
  assert.match(src, /const \{ classify: classifyLeadEmail \} = require\('\.\/check-leads'\)/,
    'enrichment must use the canonical rule, not a private copy');
  assert.match(src, /if \(classifyLeadEmail\(e\) !== 'CLEAN'\) return false;/);

  // The seven real production values that slipped through the old check.
  for (const email of [
    '780-278-0669info@merakimedicalaesthetics.com',
    '0939information@refinemedispa.ca',
    '1k2info@gumdocs.com',
    '2828info@f1skinlab.ca',
    '7321info.van@ertclinic.ca',
    '800-7297info@clearcomplexionsco.ca',
    '-687-1887silverspringsspa@gmail.com',
  ]) {
    assert.notEqual(classifyLeadEmail(email), 'CLEAN', `${email} must be rejected`);
    // The OLD rule only rejected a non-alphanumeric first character, which is
    // exactly why the digit-leading ones got through.
    const oldRuleWouldAccept = /^[a-zA-Z0-9]/.test(email);
    if (oldRuleWouldAccept) assert.ok(true, 'the canonical rule now catches it');
  }
  assert.equal(classifyLeadEmail('info@realclinic.ca'), 'CLEAN', 'real addresses still pass');
});

test('reclassifying an Unsubscribed lead can never un-suppress it', () => {
  // Three production leads tagged [REPLY: Unsubscribed] would be reclassified
  // by reconciliation. That must be purely an analytics change: suppression is
  // driven by the notes tag and the Suppression sheet, never by reply state.
  const { sendSuppressionReason } = require('../integrations/pipeline-state');
  const row = lead('unsub', { email: 'x@unsub.test', notes: '[REPLY: Unsubscribed]', stage: 'Unsubscribed' });

  // The reconciliation plan proposes a NON-negative canonical state...
  const plan = planOne(row, [msg({ from: row.email, body: COQUITLAM_FIRST })]);
  assert.equal(plan.canonicalState, REPLY_STATE.NEEDS_HUMAN);
  assert.ok(plan.disagreement, 'and it disagrees with the legacy Unsubscribed tag');

  // ...and the lead stays suppressed regardless, because the tag is untouched.
  assert.equal(sendSuppressionReason(row, { suppressedEmails: new Set() }), '[REPLY: Unsubscribed]');
  assert.equal(plan.proposedEvent.metadata.legacyTag, 'Unsubscribed');
  // The plan contains no instruction that could remove a tag or a list entry.
  const serialized = JSON.stringify(plan);
  for (const forbidden of ['removeTag', 'clearNotes', 'unsuppress', 'notes:']) {
    assert.ok(!serialized.includes(forbidden), `a plan must not carry ${forbidden}`);
  }

  // And the global list still wins on its own.
  assert.equal(
    sendSuppressionReason({ ...row, notes: '' }, { suppressedEmails: new Set(['x@unsub.test']) }),
    'suppression-list');
});
