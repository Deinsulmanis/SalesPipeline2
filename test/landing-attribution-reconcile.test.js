'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { runLandingReconciliation, recordFromCandidate, resetLandingReconcileState } = require('../integrations/landing-attribution-reconcile');
const { staffingColdStepLandingPlan, staffingWarmReplyLandingPlan } = require('../integrations/landing-link-issuance');
const { landingLinkMetadata, parseLandingKeyring } = require('../integrations/landing-link-token');
const { RETENTION_DAYS } = require('../integrations/landing-attribution-config');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const KEY = crypto.createHash('sha256').update('reconcile key').digest('base64');
const ENV = {
  LANDING_RECONCILER_ENABLED: 'true', LANDING_LINK_TRACKING_ENABLED: 'true',
  LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '1',
};
const lead = {
  id: 'mtwgLead0003', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id, leadNiche: 'industrial_staffing',
};
const followUp = staffingColdStepLandingPlan({ lead, step: 2, env: ENV });
const reply = staffingWarmReplyLandingPlan({ lead, inboundMessageId: 'in-1', action: 'AUTO_STAFFING_SEND_INFO', env: ENV });
const silent = { warn() {}, error() {}, log() {} };

function fakeStore({ candidates = [], issueRow = record => ({ issuance_key: record.issuance_key, token_key_version: record.token_key_version, token_hash: record.token_hash }), fail = {} } = {}) {
  const calls = { issued: [], marked: [], resolved: 0, retention: [] };
  return {
    calls,
    landingBackfillCandidates: async () => (fail.candidates ? { ok: false, error: 'HTTP 500' } : { ok: true, data: candidates }),
    issueLandingLink: async record => { calls.issued.push(record); return fail.issue ? { ok: false, error: 'timeout' } : { ok: true, data: [issueRow(record)] }; },
    markLandingLinkSent: async update => { calls.marked.push(update); return { ok: true, data: [update] }; },
    resolvePendingLandingSessions: async () => { calls.resolved += 1; return { ok: true, data: 2 }; },
    applyLandingRetention: async days => { calls.retention.push(days); return { ok: true, data: { deleted_events: 0 } }; },
  };
}
const sendRow = {
  event_id: 'gmail:gm-9', event_type: 'follow_up_sent', source_lead_id: lead.id, occurred_at: '2026-09-25T15:00:00.000Z', recipient_domain: 'harbourstaffing.test',
  metadata: { step: 2, templateId: STAFFING_CAMPAIGN.emailTemplateId, copyVersion: 'industrial_staffing_follow_up_v1', campaignVersion: STAFFING_CAMPAIGN.id,
    senderInboxId: 'primary', gmailMessageId: 'gm-9', gmailThreadId: 'th-9', landingLink: landingLinkMetadata(followUp) },
};

test('flag off: nothing is read or written', async () => {
  const store = fakeStore({ candidates: [sendRow] });
  const result = await runLandingReconciliation({ env: { ...ENV, LANDING_RECONCILER_ENABLED: 'false' }, store, logger: silent });
  assert.equal(result.skipped, true);
  assert.deepEqual([store.calls.issued.length, store.calls.marked.length, store.calls.resolved], [0, 0, 0]);
});

test('a rebuilt issuance has exactly the token hash the send path derived', () => {
  const keyring = parseLandingKeyring(ENV);
  const built = recordFromCandidate(sendRow, keyring, ENV);
  assert.equal(built.record.token_hash, followUp.tokenHash);
  assert.deepEqual([built.record.source, built.record.template_version, built.record.sender_inbox_id, built.record.is_test],
    ['followup_2', 'industrial_staffing_follow_up_v1', 'primary', false]);
  const warm = recordFromCandidate({ ...sendRow, event_type: 'booking_link_sent', recipient_domain: 'scalelabai.ca',
    metadata: { action: 'AUTO_STAFFING_SEND_INFO', senderInboxId: 'primary', landingLink: landingLinkMetadata(reply) } }, keyring, ENV);
  assert.deepEqual([warm.record.token_hash, warm.record.source, warm.record.trigger_action, warm.record.template_version, warm.record.is_test],
    [reply.tokenHash, 'positive_reply', 'AUTO_STAFFING_SEND_INFO', 'staffing_send_info_reply_v1', true]);
  assert.equal(recordFromCandidate({ ...sendRow, metadata: {} }, keyring, ENV).skip, 'untracked');
  assert.equal(recordFromCandidate({ ...sendRow, metadata: { landingLink: { ...landingLinkMetadata(followUp), keyVersion: 7 } } }, keyring, ENV).skip, 'key version missing');
});

test('backfill: sends are issued and marked sent; reservations are issued only', async () => {
  resetLandingReconcileState();
  const reservation = { ...sendRow, event_id: 'cold-reserve:x', event_type: 'ordinary_send_reserved', metadata: { leadId: lead.id, step: 2, senderInboxId: 'primary', landingLink: landingLinkMetadata(followUp) } };
  const store = fakeStore({ candidates: [sendRow, reservation] });
  const summary = await runLandingReconciliation({ env: ENV, store, now: () => Date.parse('2026-09-25T16:00:00Z'), logger: silent });
  assert.deepEqual([summary.issued, summary.markedSent, summary.conflicts, summary.failures], [2, 1, 0, 0]);
  assert.deepEqual(store.calls.marked, [{ issuance_key: followUp.issuanceKey, sent_at: '2026-09-25T15:00:00.000Z', provider_message_id: 'gm-9', provider_thread_id: 'th-9' }]);
  assert.equal(store.calls.resolved, 1);
  assert.deepEqual(store.calls.retention, [{
    events_and_sessions_days: RETENTION_DAYS.eventsAndSessions, issuances_days: RETENTION_DAYS.issuances,
    unresolved_sessions_days: RETENTION_DAYS.unresolvedSessions, internal_and_debug_days: RETENTION_DAYS.internalAndDebug,
  }]);
  // Retention runs at most once a day.
  await runLandingReconciliation({ env: ENV, store, now: () => Date.parse('2026-09-25T20:00:00Z'), logger: silent });
  assert.equal(store.calls.retention.length, 1);
  await runLandingReconciliation({ env: ENV, store, now: () => Date.parse('2026-09-26T17:00:00Z'), logger: silent });
  assert.equal(store.calls.retention.length, 2);
});

test('a stored row that contradicts the pin is reported and never marked sent', async () => {
  resetLandingReconcileState();
  const store = fakeStore({ candidates: [sendRow], issueRow: record => ({ issuance_key: record.issuance_key, token_key_version: 2, token_hash: record.token_hash }) });
  const errors = [];
  const summary = await runLandingReconciliation({ env: ENV, store, logger: { ...silent, error: line => errors.push(line) } });
  assert.deepEqual([summary.conflicts, store.calls.marked.length], [1, 0]);
  assert.match(errors[0], /LANDING_LINK_ISSUANCE_CONFLICT/);
  assert.equal(errors[0].includes(followUp.tokenHash), false);
});

test('store failures are counted, never thrown', async () => {
  resetLandingReconcileState();
  const down = await runLandingReconciliation({ env: ENV, store: fakeStore({ fail: { candidates: true } }), logger: silent });
  assert.deepEqual([down.ok, down.failures >= 1], [false, true]);
  const flaky = await runLandingReconciliation({ env: ENV, store: fakeStore({ candidates: [sendRow], fail: { issue: true } }), logger: silent });
  assert.equal(flaky.issued, 0);
  const broken = await runLandingReconciliation({ env: ENV, store: { landingBackfillCandidates: async () => { throw new Error('boom'); } }, logger: silent });
  assert.equal(broken.ok, false);
});

test('server.js schedules the reconciler feature-gated with an in-flight guard', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(server, /cron\.schedule\('4,19,34,49 \* \* \* \*', \(\) => \{\s+if \(landingReconcileInFlight\) return;/);
  assert.match(server, /\.finally\(\(\) => \{ landingReconcileInFlight = false; \}\)/);
});
