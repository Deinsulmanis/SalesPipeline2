'use strict';

// Canonical reply classification. The property under test throughout is that a
// classification must be defensible from evidence — a CRM stage, a company
// name, or a hopeful guess is never enough.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPLY_STATE, AUTOMATED_SUBTYPE, NEEDS_HUMAN_REASON, EVIDENCE_SOURCE,
  classifyReplyText, resolveReplyState, isGenuineHumanReply,
  extractReturnDate, extractProposedEmail, malformedEmailReason, isUsableReplyIdentity,
} = require('../integrations/canonical-reply');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const { buildReplyMetrics, buildReplyRecords, ANALYTICS_CATEGORY } = require('../integrations/reply-analytics');
const { buildFunnelAnalytics } = require('../integrations/funnel-analytics');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const activity = (leadId, eventType, occurredAt, metadata = {}) => ({
  eventId: `${leadId}:${eventType}:${occurredAt}`, leadId: `CE-${leadId}`, sourceLeadId: leadId,
  email: `${leadId}@test.ca`, eventType, occurredAt, metadata: JSON.stringify(metadata),
});

// Real message shapes, paraphrased from the production cases this pass exists
// to fix. No production data is modified by any test here.
const GLAMORE = 'Honestly these AI emails are obviously robotic and I doubt the accent would convince our clients. '
  + 'That said, I would want to test it first and know your pricing before we do any video call.';
const APPLECROSS = 'This is an automated response. Our office monitors this inbox during business hours. '
  + 'For appointments call the clinic. For emergencies please use the emergency line.';
const HUSH = 'Thank you for your email. Our clinic is closed for summer break from July 4-20. We will resume on July 21.';
const SURFACE = 'Automatic reply: the clinic is closed July 1 and we will respond once we are back in office.';
const ORAH = 'We have moved! Our new email address is info@orahspa.com. We will no longer reply from this email.';
const COQUITLAM = 'Thanks for reaching out. I will forward this to our office manager when she returns next week.';

// ── 1–4. Intent versus sentiment ────────────────────────────────────────────

test('1. explicit buying intent outranks generic negative sentiment', () => {
  const result = classifyReplyText(GLAMORE);
  assert.equal(result.state, REPLY_STATE.POSITIVE);
  assert.equal(result.reason, 'explicit_evaluation_intent');
  assert.ok(result.genuineHuman);
  // The specific commercial signal is recorded, so the decision is explainable.
  assert.ok(result.signals.length, 'the matched buying signal is reported');

  // And when a message carries BOTH intent and rejection wording, intent wins
  // and the overridden signal is kept visible for a human.
  const mixed = classifyReplyText('Not interested in AI hype, but send me your pricing anyway.');
  assert.equal(mixed.state, REPLY_STATE.POSITIVE);
  assert.ok(mixed.signals.some(signal => signal.startsWith('overridden:')));
  assert.equal(mixed.confidence, 'medium', 'a mixed message is flagged as less certain');
});

test('2. criticism of AI on its own is never a rejection', () => {
  for (const text of [
    'This is clearly written by ChatGPT and I find that unreliable.',
    'The accent on these AI voices is terrible and patients would notice.',
    'I am skeptical this would work and implementation sounds like a headache.',
  ]) {
    const result = classifyReplyText(text);
    assert.notEqual(result.state, REPLY_STATE.NEGATIVE, `must not reject: ${text}`);
  }
});

test('3. explicit rejection with no intent remains negative', () => {
  for (const text of ['Not interested, thanks.', 'No thanks, not a fit for us.', 'Please stop emailing me.']) {
    assert.equal(classifyReplyText(text).state, REPLY_STATE.NEGATIVE, text);
  }
});

test('4. unsubscribe stays negative and keeps its own suppression category', () => {
  const result = classifyReplyText('Please unsubscribe me from this list.');
  assert.equal(result.state, REPLY_STATE.NEGATIVE);
  assert.equal(result.reason, 'unsubscribe_request');
  // The send path still sees UNSUBSCRIBE, which is what drives suppression.
  assert.equal(deterministicReplyCategory('Please unsubscribe me from this list.'), 'UNSUBSCRIBE');
});

// ── 5–8. Evidence and identity ──────────────────────────────────────────────

test('5. a CRM stage of Unsubscribed never manufactures a negative classification', () => {
  // This is the exact production shape of Euphora MD: stage says unsubscribed,
  // emailStatus says replied, and there is no tag or activity anywhere.
  const lead = { id: 'e1', email: 'support@euphoramd.test', stage: 'Unsubscribed', emailStatus: 'replied', notes: '' };
  const resolved = resolveReplyState(lead, { activities: [] });
  assert.equal(resolved.state, REPLY_STATE.UNKNOWN);
  assert.equal(resolved.source, EVIDENCE_SOURCE.NONE);
  assert.ok(!isGenuineHumanReply(resolved));
  // ...and the analytics layer agrees.
  assert.equal(buildReplyMetrics([lead]).negative, 0);
  assert.equal(buildReplyMetrics([lead]).unknown, 1);
});

test('6. a stage never manufactures a positive classification either', () => {
  const lead = { id: 'h1', email: 'a@b.test', stage: 'Hot', emailStatus: 'replied', notes: '' };
  const resolved = resolveReplyState(lead, { activities: [] });
  assert.equal(resolved.state, REPLY_STATE.UNKNOWN);
  assert.equal(buildReplyMetrics([lead]).positive, 0);
});

test('7. a malformed identity cannot manufacture reply evidence', () => {
  // The real production value, which an import fused a phone number onto.
  const bad = '-687-1887silverspringsspa@gmail.com';
  assert.ok(!isUsableReplyIdentity(bad));
  assert.match(malformedEmailReason(bad), /punctuation/);
  const lead = { id: 's1', email: bad, stage: 'Unsubscribed', emailStatus: 'replied', notes: '[REPLY: Interested]' };
  const resolved = resolveReplyState(lead, {
    activities: [activity('s1', 'positive_reply', '2026-08-01T00:00:00Z', { canonicalState: 'positive' })],
  });
  assert.equal(resolved.state, REPLY_STATE.UNKNOWN, 'even a tag and an activity are untrustworthy here');
  assert.match(resolved.identityIssue, /punctuation/);
});

test('8. ambiguous or absent identity fails closed', () => {
  for (const email of ['', 'not-an-email', 'a@b', 'first..last@x.com', '4165551234contact@x.com']) {
    assert.ok(!isUsableReplyIdentity(email), `${email} must not be a usable identity`);
  }
  assert.ok(isUsableReplyIdentity('info@glamorebeautybar.com'));
});

// ── 9–13. Automated replies ─────────────────────────────────────────────────

test('9. a generic autoresponder is not a human reply', () => {
  const result = classifyReplyText(APPLECROSS);
  assert.equal(result.state, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(result.subtype, AUTOMATED_SUBTYPE.AUTORESPONDER);
  assert.equal(result.genuineHuman, false);
  for (const wrong of [REPLY_STATE.POSITIVE, REPLY_STATE.NEGATIVE, REPLY_STATE.NEEDS_HUMAN]) {
    assert.notEqual(result.state, wrong);
  }
});

test('10. an out-of-office reply is automated', () => {
  const result = classifyReplyText('I am out of the office until further notice.');
  assert.equal(result.state, REPLY_STATE.AUTOMATED_REPLY);
  assert.equal(result.subtype, AUTOMATED_SUBTYPE.OUT_OF_OFFICE);
});

test('11. a temporary closure is automated', () => {
  for (const text of [HUSH, SURFACE]) {
    const result = classifyReplyText(text);
    assert.equal(result.state, REPLY_STATE.AUTOMATED_REPLY, text);
    assert.equal(result.subtype, AUTOMATED_SUBTYPE.TEMPORARY_CLOSURE);
    assert.equal(result.genuineHuman, false);
  }
});

test('12. a confident return date is extracted', () => {
  assert.equal(extractReturnDate('We will resume on July 21.', { year: 2026 }), '2026-07-21');
  assert.equal(extractReturnDate('Closed until 3 August.', { year: 2026 }), '2026-08-03');
  assert.equal(classifyReplyText(HUSH, { year: 2026 }).returnDate, '2026-07-21');
});

test('13. an ambiguous date is never invented', () => {
  for (const text of ['We will be back next week.', 'Back shortly.', 'Returning on the 21st.', 'Closed for a while.']) {
    assert.equal(extractReturnDate(text, { year: 2026 }), '', text);
  }
  // Without a year from the caller we refuse rather than guess one.
  assert.equal(extractReturnDate('We will resume on July 21.'), '');
  assert.equal(classifyReplyText(SURFACE, { year: 2026 }).returnDate, null, 'no explicit return date in this message');
});

// ── 14–15. Contact change ───────────────────────────────────────────────────

test('14. a mailbox migration becomes contact-change review, not Needs Human', () => {
  const result = classifyReplyText(ORAH, { currentEmail: 'info@orahspasalon.com' });
  assert.equal(result.state, REPLY_STATE.CONTACT_CHANGE_REVIEW);
  assert.equal(result.subtype, AUTOMATED_SUBTYPE.MAILBOX_MIGRATION);
  assert.equal(result.proposedEmail, 'info@orahspa.com');
  assert.notEqual(result.state, REPLY_STATE.NEEDS_HUMAN);
});

test('15. a proposed replacement address is evidence only and never mutates identity', () => {
  const result = classifyReplyText(ORAH, { currentEmail: 'info@orahspasalon.com' });
  assert.equal(result.identityMutationAllowed, false);
  // The module exposes no way to write an address anywhere.
  const src = readSource(path.join(root, 'integrations', 'canonical-reply.js'));
  for (const token of ['lead.email =', 'values.update', 'batchUpdate', 'googleapis']) {
    assert.ok(!src.includes(token), `must not contain ${token}`);
  }
});

// ── 16–17. Human replies ────────────────────────────────────────────────────

test('16. a forwarded-to-manager reply is Needs Human with a specific reason', () => {
  const result = classifyReplyText(COQUITLAM);
  assert.equal(result.state, REPLY_STATE.NEEDS_HUMAN);
  assert.equal(result.reason, NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER);
  assert.ok(result.genuineHuman, 'a person wrote this');
});

test('17. a genuine human reply after an autoresponder still classifies normally', () => {
  const lead = { id: 'a1', email: 'a1@test.ca', notes: '' };
  const resolved = resolveReplyState(lead, {
    activities: [
      activity('a1', 'out_of_office_reply', '2026-08-01T10:00:00Z', { canonicalState: 'automated_reply' }),
      activity('a1', 'positive_reply', '2026-08-09T10:00:00Z', { canonicalState: 'positive', gmailMessageId: 'm2' }),
    ],
  });
  assert.equal(resolved.state, REPLY_STATE.POSITIVE);
  assert.ok(resolved.genuineHuman);
  assert.equal(resolved.providerMessageId, 'm2');
});

// ── 18–19. Canonical activity and idempotency ───────────────────────────────

test('18. reprocessing the same Gmail message creates no second reply activity', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const block = agent.slice(
    agent.indexOf('async function recordActiveReplyActivity'),
    agent.indexOf('async function handleNotInterested'));

  // The underlying writer APPENDS unconditionally, so a stable event id alone
  // guarantees nothing — the duplicate must be rejected before the append.
  assert.match(block, /gmail-reply:\$\{message\.messageId\}/, 'identity comes from the provider message id');
  assert.match(block, /activities\.some\(row => String\(row\.eventId \|\| ''\) === eventId\)/,
    'the replay guard must compare against activities already recorded');
  // The guard must return BEFORE the append.
  assert.ok(block.indexOf('=== eventId') < block.indexOf('recordColdCallActivity('),
    'the duplicate check has to run before the write');

  // And the writer really is append-only, which is why the guard is required.
  const writer = agent.slice(agent.indexOf('async function recordColdCallActivity'));
  assert.match(writer.slice(0, 600), /values\.append/);
});

test('19. a canonical reply activity carries stable provider identity and evidence', () => {
  const agent = readSource(path.join(root, 'outreach-agent.js'));
  const block = agent.slice(agent.indexOf('async function recordActiveReplyActivity'));
  for (const field of [
    'provider:', 'gmailMessageId', 'gmailThreadId', 'receivedAt', 'matchedColdEmailId',
    'canonicalState', 'classifierVersion', 'confidence', 'evidenceSignals', 'replyTouch',
  ]) {
    assert.ok(block.includes(field), `reply evidence must record ${field}`);
  }
  // Identity mutation is explicitly disallowed on the stored record.
  assert.match(block, /identityMutationAllowed: false/);
});

// ── 20–21. Evidence hierarchy ───────────────────────────────────────────────

test('20. a legacy tag stays distinguishable from a canonical classification', () => {
  const lead = { id: 'l1', email: 'l1@test.ca', notes: '[REPLY: Not Interested]' };
  const legacy = resolveReplyState(lead, { activities: [] });
  assert.equal(legacy.source, EVIDENCE_SOURCE.LEGACY_TAG);
  assert.equal(legacy.legacyTag, 'Not Interested');

  // Verified inbound evidence outranks the tag, and says so.
  const verified = resolveReplyState(lead, {
    activities: [activity('l1', 'positive_reply', '2026-08-10T00:00:00Z', { canonicalState: 'positive', gmailMessageId: 'm9' })],
  });
  assert.equal(verified.source, EVIDENCE_SOURCE.CANONICAL_ACTIVITY);
  assert.equal(verified.state, REPLY_STATE.POSITIVE);
});

test('21. an explicit human override outranks everything and is attributed', () => {
  const lead = { id: 'o1', email: 'o1@test.ca', notes: '[REPLY: Not Interested]' };
  const resolved = resolveReplyState(lead, {
    activities: [activity('o1', 'negative_reply', '2026-08-10T00:00:00Z', { canonicalState: 'negative' })],
    manualOverride: { state: REPLY_STATE.POSITIVE, reason: 'reviewed the thread', by: 'deins', at: '2026-08-27T00:00:00Z' },
  });
  assert.equal(resolved.state, REPLY_STATE.POSITIVE);
  assert.equal(resolved.source, EVIDENCE_SOURCE.MANUAL_OVERRIDE);
  assert.equal(resolved.overriddenBy, 'deins');
});

// ── 22–25. Step 13 integration ──────────────────────────────────────────────

const funnelInput = (categories) => ({
  leads: Object.keys(categories).map(id => ({
    id, email: `${id}@test.ca`, emailStatus: 'replied', lastEmailedAt: '2026-07-01T00:00:00Z',
  })),
  replyRecords: Object.entries(categories).map(([leadId, category]) => ({ leadId, category })),
  activities: [], boardLeads: [], currentVersion: 'dental_v1_measured',
});

test('22. autoresponders never inflate genuine reply analytics', () => {
  const result = buildFunnelAnalytics(
    funnelInput({ p: 'positive', n: 'negative', auto: 'automated_reply', moved: 'contact_change_review', none: 'unknown' }),
    { version: 'lifetime' });
  assert.equal(result.counts.replied, 2, 'only the two genuine human replies');
  assert.equal(result.counts.automatedReply, 1);
  assert.equal(result.counts.contactChangeReview, 1);
  assert.equal(result.counts.unknown, 1);
  // Reported separately rather than discarded.
  assert.equal(result.reconciliation.inboundMessageLeads, 5);
  // The denominator for reply rate excludes them.
  assert.equal(result.conversions.sentToReply, 2 / 5 * 100);
});

test('23. the measured cohort still requires explicit campaign attribution', () => {
  const result = buildFunnelAnalytics(
    funnelInput({ p: 'positive', n: 'negative' }), { version: 'dental_v1_measured' });
  assert.equal(result.counts.sent, 0, 'no stamped sends means an empty measured cohort');
  assert.equal(result.counts.replied, 0);
  assert.equal(result.conversions.sentToReply, null, 'and a zero denominator stays unavailable');
});

test('24. legacy_unknown remains separate from any measured cohort', () => {
  const legacy = buildFunnelAnalytics(funnelInput({ p: 'positive' }), { version: 'legacy_unknown' });
  assert.equal(legacy.counts.sent, 1, 'historical send state belongs to legacy');
  const measured = buildFunnelAnalytics(funnelInput({ p: 'positive' }), { version: 'dental_v1_measured' });
  assert.equal(measured.counts.sent, 0);
});

test('25. every funnel stage still reconciles exactly with its lead set', () => {
  const result = buildFunnelAnalytics(
    funnelInput({ p: 'positive', n: 'negative', h: 'needs_human', auto: 'automated_reply', none: 'unknown' }),
    { version: 'lifetime' });
  assert.ok(result.reconciliation.stagesMatchLeadIds);
  for (const [key, ids] of Object.entries(result.stageLeadIds)) {
    assert.equal(ids.length, result.counts[key], `${key} must be auditable`);
    assert.equal(new Set(ids).size, ids.length, `${key} must not double-count`);
  }
});

test('the reply layer contains no production write path', () => {
  for (const file of ['canonical-reply.js', 'reply-analytics.js']) {
    const src = readSource(path.join(root, 'integrations', file));
    for (const forbidden of ['values.update', 'values.append', 'batchUpdate', 'sendEmail', 'googleapis']) {
      assert.ok(!src.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
});

test('a reply record with no evidence is reported as unknown, not unclassified', () => {
  const records = buildReplyRecords([
    { id: 'x', email: 'x@test.ca', emailStatus: 'replied', stage: 'Unsubscribed', notes: '' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].category, ANALYTICS_CATEGORY.UNKNOWN);
});
