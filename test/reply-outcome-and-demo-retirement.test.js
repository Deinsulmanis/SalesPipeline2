'use strict';

// Two production cleanups, pinned:
//   1. A lead's reply category is the latest DECISIVE statement in its
//      conversation (a positive/negative message, or a human classification
//      override), shared by every stat surface. On 2026-10-08 the live
//      dashboard showed 1 positive where the canonical records held 3: Compass
//      Group Recruiting asked to evaluate and then accepted a Discovery Call
//      invite (read as needs-human), and Jole Enterprise had a human override
//      to positive that analytics never read.
//   2. The abandoned voice-receptionist demo (/demo-played, the both-audios
//      intent pass and its three-minute backstop) no longer exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyReplyText, REPLY_STATE } = require('../integrations/canonical-reply');
const { deterministicReplyCategory } = require('../integrations/reply-classifier');
const {
  buildReplyMetrics, buildReplyRecords, replyOutcomeFromEvidence, filterReplyRecords,
} = require('../integrations/reply-analytics');
const { buildClientOverview } = require('../integrations/clients/reporting');
const { routedLeadReady } = require('../integrations/campaign-routing');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const server = read('server.js');
const agent = read('outreach-agent.js');
const browser = read('public/index.html');

const state = text => classifyReplyText(text, { subject: 'Re: staffing' });

// ── Classification ──────────────────────────────────────────────────────────

test('1. a pricing request is positive', () => {
  const result = state('Good morning, Please send me some pricing so I can review further. Thank you');
  assert.equal(result.state, REPLY_STATE.POSITIVE);
  // Routed to a human like any informational question; canonically positive.
  assert.equal(deterministicReplyCategory('Please send me some pricing so I can review further.'), 'QUESTION');
});

test('2. a request for more information, details or how it works is positive', () => {
  for (const text of ['Can you send more information?', 'Can you send details?', 'How does this work?',
    'What does it cost?', 'Tell me more.', 'Could you send us a proposal?', 'Interested. Send over a proposal.']) {
    assert.equal(state(text).state, REPLY_STATE.POSITIVE, text);
  }
});

test('3. a meeting request, or an accepted meeting invitation, is positive', () => {
  assert.equal(state("Sure, let's set up a call next week. What times work?").state, REPLY_STATE.POSITIVE);
  assert.equal(deterministicReplyCategory("Sure, let's set up a call next week. What times work?"), 'MEETING_REQUEST');
  const accepted = 'Hans Denton has accepted this invitation. Discovery Call Saturday Oct 3, 2026 1pm Join with Google Meet';
  assert.equal(state(accepted).state, REPLY_STATE.POSITIVE);
  // A calendar notification is not a message to answer: a human takes it.
  assert.equal(deterministicReplyCategory(accepted), 'NEEDS_HUMAN');
  assert.equal(state('Accepted: Discovery Call @ Sat Oct 3, 2026 1pm (PDT) (deins@scalelabai.ca)').state, REPLY_STATE.POSITIVE);
});

test('4. an explicit "not interested" is negative', () => {
  for (const text of ['Not interested.', 'No thanks', 'Please stop contacting me', 'I am not interested.']) {
    const result = state(text);
    assert.equal(result.state, REPLY_STATE.NEGATIVE, text);
    assert.equal(result.reason, 'explicit_rejection', text);
  }
});

test('5. an unsubscribe keeps its own category and is never positive', () => {
  for (const text of ['unsubscribe', 'Remove me from your list', "We're not interested, please remove us"]) {
    const result = state(text);
    assert.equal(result.state, REPLY_STATE.NEGATIVE, text);
    assert.equal(result.reason, 'unsubscribe_request', text);
    assert.equal(deterministicReplyCategory(text), 'UNSUBSCRIBE', text);
  }
});

test('6. a bare acknowledgement is neutral (needs human), not positive', () => {
  for (const text of ['Thanks', 'Received', 'Okay', 'Thanks, received.']) {
    assert.equal(state(text).state, REPLY_STATE.NEEDS_HUMAN, text);
  }
  // The global classifier is not loosened for a bare "Interested".
  assert.notEqual(deterministicReplyCategory('Interested'), 'INTERESTED');
});

// ── Lead outcome and stats ──────────────────────────────────────────────────

const reply = (leadId, at, canonicalState, extra = {}) => ({
  eventId: `r-${leadId}-${at}`, sourceLeadId: leadId, leadId: `CE-${leadId}`,
  eventType: { positive: 'positive_reply', negative: 'negative_reply', needs_human: 'needs_human_reply' }[canonicalState] || 'needs_human_reply',
  occurredAt: at, metadata: JSON.stringify({ canonicalState, gmailMessageId: `m-${leadId}-${at}`, ...extra }),
});
const send = (leadId, at) => ({
  eventId: `s-${leadId}-${at}`, sourceLeadId: leadId, leadId: `CE-${leadId}`, eventType: 'initial_email_sent',
  occurredAt: at, metadata: JSON.stringify({ gmailMessageId: `sent-${leadId}`, provider: 'gmail', providerStatus: 'sent' }),
});
const override = (leadId, at, nextState) => ({
  eventId: `o-${leadId}`, sourceLeadId: '', leadId: `CE-${leadId}`, eventType: 'reply_classification_override',
  occurredAt: at, metadata: JSON.stringify({ kind: 'reply_classification_override', status: 'active', leadId,
    previous: { state: 'negative', reason: 'unsubscribe_request' }, next: { state: nextState, reason: 'operator review' }, at }),
});
const lead = (id, extra = {}) => ({ id, company: id, email: `${id}@example.com`, emailStatus: 'replied', notes: '', ...extra });

// The two live cases, modelled on their canonical history.
const compass = lead('compass');
const compassEvents = [
  send('compass', '2026-10-01T15:00:00Z'),
  reply('compass', '2026-10-02T16:35:00Z', 'needs_human'),
  reply('compass', '2026-10-02T18:26:00Z', 'positive'),
  reply('compass', '2026-10-03T17:25:00Z', 'needs_human'),   // the accepted invite, read as needs-human
];
const joleEnterprise = lead('jole_ent');
const joleEvents = [
  send('jole_ent', '2026-09-24T15:00:00Z'),
  reply('jole_ent', '2026-09-25T17:47:00Z', 'negative', { reason: 'unsubscribe_request' }),
  override('jole_ent', '2026-09-25T20:54:00Z', 'positive'),
  reply('jole_ent', '2026-10-01T19:21:00Z', 'needs_human'),
];

test('11. repaired history: interest followed by logistics stays positive; a human override counts', () => {
  assert.equal(replyOutcomeFromEvidence(compass, compassEvents).category, 'positive');
  assert.equal(replyOutcomeFromEvidence(joleEnterprise, joleEvents).category, 'positive');
  // A later decisive negative still wins over earlier interest.
  const changedMind = [...compassEvents, reply('compass', '2026-10-05T10:00:00Z', 'negative', { reason: 'unsubscribe_request' })];
  const outcome = replyOutcomeFromEvidence(compass, changedMind);
  assert.equal(outcome.category, 'negative');
  assert.equal(outcome.unsubscribe, true);
  // Nothing decisive: the latest genuine reading still applies.
  assert.equal(replyOutcomeFromEvidence(lead('q'), [reply('q', '2026-10-02T10:00:00Z', 'needs_human')]).category, 'needs_human');
});

function metricsFor(leads, activities) {
  const activitiesByLeadId = new Map();
  for (const row of activities) {
    const key = row.sourceLeadId || row.leadId.replace(/^CE-/, '');
    activitiesByLeadId.set(key, [...(activitiesByLeadId.get(key) || []), row]);
  }
  return {
    metrics: buildReplyMetrics(leads, { activitiesByLeadId }),
    records: buildReplyRecords(leads, { activitiesByLeadId }),
  };
}

const talon = lead('talon');
const unsub = lead('unsub', { notes: '[REPLY: Unsubscribed]' });
const rejecter = lead('rejecter');
const ooo = lead('ooo', { emailStatus: 'emailed' });
const ALL_LEADS = [compass, joleEnterprise, talon, unsub, rejecter, ooo];
const ALL_EVENTS = [
  ...compassEvents, ...joleEvents,
  send('talon', '2026-10-01T15:00:00Z'), reply('talon', '2026-10-08T14:34:00Z', 'positive'),
  send('unsub', '2026-10-01T15:00:00Z'), reply('unsub', '2026-10-07T15:44:00Z', 'negative', { reason: 'unsubscribe_request' }),
  send('rejecter', '2026-10-01T15:00:00Z'), reply('rejecter', '2026-10-06T15:44:00Z', 'negative', { reason: 'explicit_rejection' }),
  send('ooo', '2026-10-01T15:00:00Z'),
  { eventId: 'ooo-1', sourceLeadId: 'ooo', leadId: 'CE-ooo', eventType: 'out_of_office_reply', occurredAt: '2026-10-02T10:00:00Z',
    metadata: JSON.stringify({ canonicalState: 'automated_reply', gmailMessageId: 'ooo-m' }) },
];

test('7. positive records count once per lead in the shared metrics', () => {
  const { metrics, records } = metricsFor(ALL_LEADS, ALL_EVENTS);
  assert.equal(metrics.positive, 3, 'Compass, Jole Enterprise and Talon');
  assert.deepEqual(filterReplyRecords(records, 'positive').map(row => row.leadId).sort(), ['compass', 'jole_ent', 'talon']);
});

test('8. negative records count, with unsubscribes reported as a subset', () => {
  const { metrics } = metricsFor(ALL_LEADS, ALL_EVENTS);
  assert.equal(metrics.negative, 2);
  assert.equal(metrics.unsubscribed, 1, 'only the opt-out, not the plain rejection');
  assert.equal(metrics.automatedReply, 1);
});

test('9. no lead is counted in two categories and the partition closes', () => {
  const { metrics, records } = metricsFor(ALL_LEADS, ALL_EVENTS);
  assert.equal(new Set(records.map(row => row.leadId)).size, records.length);
  assert.equal(metrics.totalReplies, records.length);
  assert.equal(metrics.reconciles, true);
  assert.equal(metrics.genuineReplies, metrics.positive + metrics.negative + metrics.needsHuman + metrics.unclassified);
});

test('10. client-scoped overviews never mix ScaleLab and Jole replies', () => {
  const scalelabLeads = ALL_LEADS.map(item => ({ ...item, clientId: 'scalelab', campaign: 'Industrial Staffing Agency' }));
  const joleLead = {
    id: 'j1', clientId: 'jole', company: 'Employer', email: 'hr@employer.example', emailStatus: 'replied', notes: '',
    leadNiche: 'jole_employer', campaign: 'jole-btx-employer-acquisition', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  };
  const activities = [...ALL_EVENTS, {
    eventId: 'j-r', sourceLeadId: 'j1', leadId: 'CE-j1', eventType: 'client_reply_classified', occurredAt: '2026-10-08T10:00:00Z',
    metadata: JSON.stringify({ sentiment: 'negative', gmailMessageId: 'jm' }),
  }];
  const leads = [...scalelabLeads, joleLead];
  const build = clientId => buildClientOverview({ clientId, leads, activities, env: {}, routedLeadReady }).replies;
  const scalelab = build('scalelab');
  const jole = build('jole');
  assert.deepEqual(jole, { total: 1, positive: 0, neutral: 0, negative: 1, unsubscribe: 0, automated: 0 });
  assert.equal(scalelab.positive, 3);
  assert.equal(scalelab.unsubscribe, 1);
  assert.equal(scalelab.negative, 1);
  assert.equal(scalelab.automated, 1);
  assert.equal(scalelab.total, 5, 'the Jole reply is not a ScaleLab reply');
});

// ── Demo retirement ─────────────────────────────────────────────────────────

test('12. the abandoned demo processing is neither routed, scheduled nor spawned', () => {
  assert.doesNotMatch(server, /app\.get\('\/demo-played'/, 'no demo-play pixel route');
  assert.doesNotMatch(server, /app\.get\('\/api\/demoPlays'/, 'no demo-plays API');
  assert.doesNotMatch(server, /spawnAgentIntentOnly|intentBackstop|INTENT_ONLY|maybeFireIntent/);
  assert.doesNotMatch(server, /DemoPlays!A|IntentFired!A/, 'the server no longer reads the demo tabs');
  assert.doesNotMatch(agent, /INTENT_ONLY|runIntentTriggerPass|prepareDemoIntentCandidates|reportIntentWorkHint/);
  assert.doesNotMatch(agent, /DemoPlays!A|INTENT_SHEET/, 'the agent snapshot no longer reads the demo tabs');
  for (const file of ['integrations/intent-backstop.js', 'integrations/demo-attribution.js']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} is removed`);
  }
});

test('13. boot and runs no longer emit demo-intent processing logs', () => {
  for (const [name, src] of [['server.js', server], ['outreach-agent.js', agent]]) {
    assert.doesNotMatch(src, /\[Intent\]|\[intent\]|\[intent-backstop\]|\[intent-state\]|Intent backstop scheduled|demo plays for/, name);
  }
  assert.doesNotMatch(browser, /ce-demos-panel|\/api\/demoPlays|ce-stat-demo-plays/);
});

test('14. current reply, booking-link and cadence behaviour is unchanged', () => {
  // Reply-driven booking links (question replies) still use the warm asset.
  assert.match(agent, /require\('\.\/booking'\)/);
  // Out-of-office stays automated, never a reply sentiment.
  assert.equal(state('I am out of the office until Monday').state, REPLY_STATE.AUTOMATED_REPLY);
  // A historical undelivered demo pair still keeps a lead out of cold cadence.
  assert.match(agent, /if \(hasUndeliveredDemoPair\(l, activities\)\) return false;/);
  // The check-only and send-window crons are still scheduled.
  assert.match(server, /cron\.schedule\('15,45/);
  assert.match(server, /cron\.schedule\('0,30 7-11/);
});
