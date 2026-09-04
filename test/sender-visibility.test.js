'use strict';

// Sending-inbox visibility.
//
// The question every one of these protects: "which Gmail inbox owns this
// conversation?" — answered from the evidence the send path already records,
// never from an inference, and never from which inbox happens to have quota
// today. Two inboxes are live in production (deins@scalelabai.ca and
// deins@tryscalelabai.ca), so a lead pinned to one must read as that one on
// every surface, and a lead with no recorded sender must read as unknown
// rather than quietly inheriting the primary.
//
// Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SENDER_STATE, resolveSenderOwnership, activitySender,
  senderFilterOptions, matchesSenderFilter, inboxDomain,
} = require('../integrations/sender-visibility');
const {
  senderEvidence, sentSenderEvidence, pinnedSenderId, SENDER_ATTRIBUTED_EVENTS,
} = require('../integrations/gmail-sender-routing');
const { buildActivityTimeline } = require('../integrations/activity-timeline');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const routingSrc = readSource(path.join(root, 'integrations', 'gmail-sender-routing.js'));
const visibilitySrc = readSource(path.join(root, 'integrations', 'sender-visibility.js'));
// Prose explains what the module refuses to do and therefore names the very
// things it must not call. Assertions about behaviour have to read the code.
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
const visibilityCode = stripComments(visibilitySrc);

// The two inboxes actually live in production.
const SENDERS = [
  { id: 'primary', email: 'deins@scalelabai.ca' },
  { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca' },
];

const lead = (over = {}) => ({
  id: 'L1', email: 'a@clinic.test', emailStatus: 'emailed', emailStep: '1', ...over,
});
const sendEvent = (senderInboxId, over = {}) => ({
  eventType: 'initial_email_sent', sourceLeadId: 'L1', occurredAt: '2026-09-01T10:00:00.000Z',
  metadata: JSON.stringify(senderInboxId ? { senderInboxId, step: 1 } : { step: 1 }), ...over,
});
const resolve = (leadRow, activities) =>
  resolveSenderOwnership({ lead: leadRow, activities, senders: SENDERS });

// ── 1–3. The two inboxes render as themselves ───────────────────────────────

test('1. a primary-sender lead renders the primary inbox', () => {
  const out = resolve(lead({ senderInboxId: 'primary' }), [sendEvent('primary')]);
  assert.equal(out.state, SENDER_STATE.CONFIRMED);
  assert.equal(out.senderId, 'primary');
  assert.equal(out.email, 'deins@scalelabai.ca');
  assert.equal(out.shortLabel, 'Primary · scalelabai.ca');
});

test('2. a secondary-sender lead renders the secondary inbox', () => {
  const out = resolve(lead({ senderInboxId: 'tryscalelabai' }), [sendEvent('tryscalelabai')]);
  assert.equal(out.state, SENDER_STATE.CONFIRMED);
  assert.equal(out.email, 'deins@tryscalelabai.ca');
  assert.equal(out.shortLabel, 'Secondary · tryscalelabai.ca');
  // The two must never collapse into one label.
  assert.notEqual(out.shortLabel, resolve(lead({ senderInboxId: 'primary' }), [sendEvent('primary')]).shortLabel);
});

test('3. the sender stays the same across Email 1, 2 and 3', () => {
  const activities = [
    sendEvent('tryscalelabai'),
    { eventType: 'follow_up_sent', sourceLeadId: 'L1', occurredAt: '2026-09-04T10:00:00.000Z',
      metadata: JSON.stringify({ senderInboxId: 'tryscalelabai', step: 2 }) },
    { eventType: 'follow_up_sent', sourceLeadId: 'L1', occurredAt: '2026-09-09T10:00:00.000Z',
      metadata: JSON.stringify({ senderInboxId: 'tryscalelabai', step: 3 }) },
  ];
  const row = lead({ senderInboxId: 'tryscalelabai', emailStep: '3' });
  assert.equal(resolve(row, activities).email, 'deins@tryscalelabai.ca');
  // Every step resolves to one inbox, so pinning holds and nothing conflicts.
  assert.equal(senderEvidence(row, activities).length, 1);
  assert.equal(pinnedSenderId(row, activities), 'tryscalelabai');
  // …and each step individually reports the same mailbox in the timeline.
  for (const event of activities) {
    assert.equal(activitySender(event, SENDERS).email, 'deins@tryscalelabai.ca');
  }
});

// ── 4–6. Missing and contradictory evidence ─────────────────────────────────

test('4. a legacy lead with no recorded sender renders Unknown, never the primary', () => {
  const out = resolve(lead(), [sendEvent(null)]);   // sent, but no attribution stored
  assert.equal(out.state, SENDER_STATE.UNKNOWN);
  assert.equal(out.label, 'Unknown');
  // The whole point: an absent fact must not be rendered as a proven one.
  assert.equal(out.senderId, null);
  assert.equal(out.email, '');
  assert.ok(!/scalelabai/.test(JSON.stringify(out)), 'no inbox address is invented');
});

test('5. conflicting sender evidence renders Conflict and fails closed', () => {
  // The row says primary; a delivered message says the other mailbox.
  const row = lead({ senderInboxId: 'primary' });
  const activities = [sendEvent('tryscalelabai')];
  const out = resolve(row, activities);
  assert.equal(out.state, SENDER_STATE.CONFLICT);
  assert.equal(out.label, 'Conflict');
  assert.equal(out.senderId, null, 'a conflict picks no winner');
  assert.equal(out.candidates.length, 2);
  assert.match(out.detail, /Two mailboxes claim this conversation/);
  // The send path fails closed on the same evidence — one rule, not two.
  assert.throws(() => pinnedSenderId(row, activities), /sender ownership conflict/);
});

test('6. an assignment without a send reads as assigned, not confirmed', () => {
  const contacted = resolve(lead({ senderInboxId: 'primary' }), []);
  assert.equal(contacted.state, SENDER_STATE.ASSIGNED);
  assert.equal(contacted.email, 'deins@scalelabai.ca');
  assert.match(contacted.stateLabel, /not yet sent/i);

  // Queued but never contacted: senderEvidence() deliberately does not treat
  // this as ownership, and the reader is told it is an intention.
  const queued = resolve(lead({ senderInboxId: 'tryscalelabai', emailStatus: '', emailStep: '0' }), []);
  assert.equal(queued.state, SENDER_STATE.ASSIGNED);
  assert.match(queued.detail, /Nothing has been sent yet/);
  assert.equal(senderEvidence(lead({ senderInboxId: 'tryscalelabai', emailStatus: '', emailStep: '0' }), []).length, 0);
});

// ── 7. The timeline ─────────────────────────────────────────────────────────

test('7. the timeline names the sender only where canonical evidence exists', () => {
  const timeline = buildActivityTimeline({
    lead: { id: 'L1', stage: 'follow_up' },
    senders: SENDERS,
    activities: [
      { eventId: 'a', leadId: 'L1', eventType: 'initial_email_sent', occurredAt: '2026-09-01T10:00:00.000Z',
        metadata: JSON.stringify({ senderInboxId: 'tryscalelabai', step: 1 }) },
      { eventId: 'b', leadId: 'L1', eventType: 'booking_link_sent', occurredAt: '2026-09-02T10:00:00.000Z',
        metadata: JSON.stringify({ senderInboxId: 'primary' }) },
      // Legacy: delivered before sender attribution existed.
      { eventId: 'c', leadId: 'L1', eventType: 'follow_up_sent', occurredAt: '2026-08-01T10:00:00.000Z',
        metadata: JSON.stringify({ step: 2 }) },
      // Not an outbound email at all — no sender line belongs on it.
      { eventId: 'd', leadId: 'L1', eventType: 'stage_changed', occurredAt: '2026-09-03T10:00:00.000Z',
        metadata: JSON.stringify({ fromStage: 'follow_up', toStage: 'hot' }) },
    ],
  });
  const byId = Object.fromEntries(timeline.map(event => [event.id, event]));
  assert.equal(byId.a.senderNote, 'Sent from deins@tryscalelabai.ca');
  assert.equal(byId.b.senderNote, 'Sent from deins@scalelabai.ca');
  assert.equal(byId.c.senderNote, 'Sender unavailable for legacy event');
  assert.equal(byId.c.sender, null, 'no sender is invented for a legacy send');
  assert.equal(byId.d.senderNote, '', 'a stage change has no sending inbox');
  // Rendered as a subline, and marked when it is a legacy gap.
  assert.match(browser, /event\.senderNote \? `<div class="activity-sender"/);
  assert.match(browser, /data-legacy="true"/);
});

// ── 8. Nothing sensitive is exposed ─────────────────────────────────────────

test('8. no credential, token or provider secret reaches the browser', () => {
  const out = JSON.stringify([
    resolve(lead({ senderInboxId: 'primary' }), [sendEvent('primary')]),
    resolve(lead(), []),
    activitySender(sendEvent('tryscalelabai'), SENDERS),
    senderFilterOptions(SENDERS),
  ]);
  for (const forbidden of ['tokenEnv', 'TOKEN_JSON', 'oauthClient', 'credentialConfigured',
    'GMAIL_TOKEN', 'client_secret', 'refresh_token', 'GMAIL_INBOX_REGISTRY_JSON']) {
    assert.ok(!out.includes(forbidden), `${forbidden} must never appear in the sender projection`);
  }
  // The module never reads a credential in the first place.
  assert.ok(!/tokenEnv|TOKEN_JSON|credentialConfigured/.test(visibilitySrc));
  // The server hands down identity only — id and email, nothing else.
  assert.match(serverSrc, /function visibleSenderIdentities\(\) \{\s*\n\s*return gmailInboxOptions\(\)\.map\(\(\{ id, email \}\) => \(\{ id, email \}\)\);/);
});

// ── 9–12. Visibility changes nothing about sending ──────────────────────────

test('9. sender visibility does not alter routing or sender assignment', () => {
  // chooseSender/allowedForLead decide routing. The visibility module never
  // calls them, and never imports the registry or the environment.
  assert.ok(!/chooseSender|allowedForLead|configuredSenders/.test(visibilityCode),
    'the read-only layer must not reach into routing decisions');
  assert.ok(!/process\.env/.test(visibilityCode), 'and must not read the environment');
  // It consumes exactly the canonical resolver, nothing else.
  assert.match(visibilitySrc, /require\('\.\/gmail-sender-routing'\)/);
  assert.match(visibilitySrc, /senderEvidence, sentSenderEvidence/);
});

test('10. sender visibility does not alter quotas or read availability', () => {
  // Ownership is historical. Reading a daily limit here would turn the column
  // into "the inbox that would be chosen today", which is a different fact.
  for (const forbidden of ['dailyLimit', 'sendsToday', 'senderCountsToday', 'sendEligible', 'status']) {
    assert.ok(!visibilityCode.includes(forbidden),
      `${forbidden} must not influence which inbox is shown as the owner`);
  }
  assert.match(visibilitySrc, /It is not "which inbox would be chosen for this lead right now"/);
});

test('11. sender visibility does not alter thread ownership or the pinning rule', () => {
  // senderEvidence is the pinning input. Its membership is unchanged: the event
  // list was named, not edited.
  assert.deepEqual([...SENDER_ATTRIBUTED_EVENTS], [
    'initial_email_sent', 'follow_up_sent', 'sequence_step_sent',
    'booking_link_sent', 'human_response_sent',
  ]);
  assert.match(routingSrc, /if \(ids\.length > 1\) throw new Error\(`sender ownership conflict/);
  assert.match(routingSrc, /throw new Error\(`follow-up has no proven sender ownership/);
  // sentSenderEvidence is additive and read-only — chooseSender never calls it.
  const chooser = routingSrc.slice(routingSrc.indexOf('function chooseSender'));
  assert.ok(!/sentSenderEvidence/.test(chooser.slice(0, chooser.indexOf('\n}\n'))));
});

test('12. sender visibility does not alter campaign attribution', () => {
  // The projection carries no campaign fields, and toLightRow's sender block
  // only ever assigns sender* keys.
  const block = serverSrc.slice(serverSrc.indexOf('function toLightRow'), serverSrc.indexOf('// Join the two deliberately separate lead stores'));
  const assigned = [...block.matchAll(/row\.(\w+) = sender\./g)].map(match => match[1]);
  assert.ok(assigned.length > 0);
  for (const key of assigned) assert.match(key, /^sender/, `${key} is not a sender field`);
  // Scope to the sender block itself: campaign attribution is assigned further
  // down the same function and is deliberately left exactly as it was.
  // Just the sender block: campaign attribution is assigned after it closes.
  const senderBlock = block.slice(block.indexOf('if (sender) {'), block.indexOf('row.replyCategory'));
  assert.ok(!/campaignVersion|campaignFamily|attribution/.test(senderBlock),
    'the sender block must not touch campaign attribution');
  assert.match(block, /row\.campaignVersion = attribution\.campaignVersion \|\| LEGACY_UNKNOWN;/,
    'campaign attribution is unchanged');
});

// ── 13–15. It is visible everywhere, and consistently ───────────────────────

test('13. the Outreach table has a Sending Inbox column that survives narrow screens', () => {
  assert.match(browser, /<th class="ce-th-sender"[^>]*>Sending Inbox<\/th>/);
  assert.match(browser, /<td class="ce-td-sender">\$\{senderChip\(l\)\}<\/td>/);
  // Columns shifted by one, so the mobile hide-list had to move with them, and
  // the loading row's colspan had to grow.
  assert.match(browser, /\.ce-table th:nth-child\(11\),\.ce-table td:nth-child\(11\) \{ display:none; \}/);
  assert.match(browser, /colspan="11" class="ce-loading-row"/);
  // Unknown and Conflict are shown, never hidden.
  const chip = browser.slice(browser.indexOf('function senderChip'), browser.indexOf('function renderCeTable'));
  assert.match(chip, /state === 'unknown' \? 'Unknown'/);
  assert.match(chip, /state === 'conflict' \? 'Conflict'/);
  // No fallback to the primary inbox anywhere in the chip.
  assert.ok(!/primary/i.test(chip.replace(/\/\/.*/g, '')), 'the chip must not name a default inbox');
});

test('14. the lead drawer and the Pipeline drawer both show the owning inbox', () => {
  // Outreach drawer, beside the sequence it belongs to.
  assert.match(browser, /<span class="sender-field-k">Sending inbox<\/span>/);
  assert.match(browser, /senderHtml/);
  // Pipeline drawer, resolved through the linked ColdEmail identity server-side.
  assert.match(browser, /<span class="pipeline-row-label">Sending inbox<\/span>/);
  const activity = serverSrc.slice(serverSrc.indexOf("app.get('/api/leads/:id/activity'"), serverSrc.indexOf('// ── NEXT ACTION QUEUE'));
  assert.match(activity, /sender: twin\s*\n\s*\? resolveSenderOwnership\(\{ lead: twin, activities, senders: visibleSenderIdentities\(\) \}\)/);
  // A Pipeline lead with no Outreach mapping gets an honest absence.
  assert.match(activity, /state: 'not_outreach'/);
  assert.match(activity, /Not an Outreach-acquired lead/);
  // Scoped to the SENDER block. The ownership block that now follows it is
  // stage-aware by design, so slicing as far as `reopen:` would sweep in a
  // legitimate `lead.stage` read and stop testing the sender at all.
  const senderBlock = activity.slice(activity.indexOf('sender: twin'), activity.indexOf('ownership:'));
  assert.ok(senderBlock.length > 0 && senderBlock.length < activity.length);
  assert.ok(!/lead\.stage/.test(senderBlock),
    'the Pipeline sender must not be inferred from the Pipeline stage');
});

test('15. a promoted lead keeps the same inbox on every surface', () => {
  // One resolver feeds the table row, the Outreach drawer and the Pipeline
  // drawer, so the three cannot disagree for the same lead.
  const row = lead({ senderInboxId: 'tryscalelabai' });
  const activities = [sendEvent('tryscalelabai')];
  const owner = resolve(row, activities);
  assert.equal(owner.email, 'deins@tryscalelabai.ca');

  // Promotion changes the Pipeline stage, not the conversation's owner.
  for (const stage of ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost']) {
    const promoted = resolveSenderOwnership({
      lead: { ...row, stage }, activities, senders: SENDERS,
    });
    assert.equal(promoted.email, owner.email, `${stage} must not change the owning inbox`);
    assert.equal(promoted.state, owner.state);
  }

  // And a pinned lead keeps its inbox regardless of what the OTHER inbox has
  // left today: quota is not part of the resolution at all.
  const withQuotaNoise = resolveSenderOwnership({
    lead: row, activities,
    senders: [
      { id: 'primary', email: 'deins@scalelabai.ca', dailyLimit: 999, sendEligible: true },
      { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', dailyLimit: 0, sendEligible: false },
    ],
  });
  assert.equal(withQuotaNoise.email, 'deins@tryscalelabai.ca',
    'historical ownership, not current availability');
});

// ── 16. Filtering ───────────────────────────────────────────────────────────

test('16. the inbox filter offers every state and matches what is displayed', () => {
  const options = senderFilterOptions(SENDERS).map(option => option.value);
  assert.deepEqual(options, ['all', 'primary', 'tryscalelabai', 'unknown', 'conflict']);

  const confirmed = resolve(lead({ senderInboxId: 'primary' }), [sendEvent('primary')]);
  const unknown = resolve(lead(), []);
  const conflict = resolve(lead({ senderInboxId: 'primary' }), [sendEvent('tryscalelabai')]);
  assert.equal(matchesSenderFilter(confirmed, 'primary'), true);
  assert.equal(matchesSenderFilter(confirmed, 'tryscalelabai'), false);
  assert.equal(matchesSenderFilter(unknown, 'unknown'), true);
  assert.equal(matchesSenderFilter(unknown, 'primary'), false, 'unknown never matches a real inbox');
  assert.equal(matchesSenderFilter(conflict, 'conflict'), true);
  for (const state of [confirmed, unknown, conflict]) assert.equal(matchesSenderFilter(state, 'all'), true);

  // The server filters on the ownership already resolved onto the row, so the
  // filter and the visible chip are answering with the same value.
  assert.match(serverSrc, /matchesSenderFilter\(\{ state: row\.senderState, senderId: row\.senderInboxId \}, senderInbox\)/);
  assert.match(browser, /params\.set\('senderInbox', ceSenderFilter\)/);
});

test('inboxDomain shortens an address without losing which mailbox it is', () => {
  assert.equal(inboxDomain('deins@tryscalelabai.ca'), 'tryscalelabai.ca');
  assert.equal(inboxDomain('deins@scalelabai.ca'), 'scalelabai.ca');
  assert.equal(inboxDomain(''), '');
  // The two production domains stay distinguishable when shortened, which is
  // the only reason the compact label is safe to use in the table.
  assert.notEqual(inboxDomain('deins@tryscalelabai.ca'), inboxDomain('deins@scalelabai.ca'));
});

test('an unconfigured pinned id is reported rather than silently blanked', () => {
  // The registry changed under a lead that is already pinned. The address is
  // unknown, but the ownership is not — say so instead of showing nothing.
  const out = resolve(lead({ senderInboxId: 'retired_inbox' }), [sendEvent('retired_inbox')]);
  assert.equal(out.state, SENDER_STATE.CONFIRMED);
  assert.equal(out.senderId, 'retired_inbox');
  assert.equal(out.configured, false);
  assert.equal(out.label, 'retired_inbox');
});
