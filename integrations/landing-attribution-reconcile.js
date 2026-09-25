'use strict';

/**
 * Landing attribution reconciler. Off unless LANDING_RECONCILER_ENABLED is
 * exactly "true". Reads and writes only the landing attribution functions in
 * Supabase: no Sheets, no Gmail, no send path.
 *
 * 1. Backfill. The canonical activity ledger (mirrored to crm_events) records
 *    every tracked landing link's pin — issuance key and key version — on the
 *    reservation and on the send. Any pinned send whose issuance row is
 *    missing or not yet marked sent is rebuilt here by re-deriving the token
 *    hash from the pin. The raw token is never read from anywhere.
 * 2. Resolution. Sessions that arrived before their issuance existed are
 *    linked to it.
 * 3. Retention, at most once a day, with the periods in landing-attribution-config.
 */

const { STAFFING_CAMPAIGN } = require('./staffing-campaign');
const { RETENTION_DAYS, RECONCILE_LOOKBACK_DAYS, reconcilerEnabled, testEmailDomains } = require('./landing-attribution-config');
const { LINK_SLOT, landingTrackingState, deriveLandingToken, landingTokenHash, issuanceConflict } = require('./landing-link-token');
const { buildIssuanceRecord, warmReplyTemplate } = require('./landing-link-issuance');
const defaultStore = require('./landing-attribution-store');

const SEND_EVENT_TYPES = Object.freeze(['follow_up_sent', 'booking_link_sent']);
const DAY_MS = 86400000;
const CANDIDATE_LIMIT = 200;

let lastRun = null;
let lastRetentionAt = 0;

const parseMetadata = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
};

/** The issuance record for one canonical row, or a reason it can't be rebuilt. */
function recordFromCandidate(row, keyring, env = process.env) {
  const metadata = parseMetadata(row.metadata);
  const pin = metadata.landingLink;
  if (!pin || pin.tracked !== true) return { skip: 'untracked' };
  const issuanceKey = String(pin.issuanceKey || '');
  const suffix = `|${LINK_SLOT}`;
  if (!issuanceKey.endsWith(suffix)) return { skip: 'malformed pin' };
  const keyVersion = Number(pin.keyVersion);
  if (!keyring?.keys?.has(keyVersion)) return { skip: 'key version missing', keyVersion };
  const token = deriveLandingToken({ issuanceKey, keyVersion, keyring });
  const plan = { tracked: true, issuanceKey, keyVersion, source: pin.source, tokenHash: landingTokenHash(token) };
  const isWarm = pin.source === 'positive_reply';
  const template = isWarm
    ? warmReplyTemplate(metadata.action)
    : { templateId: metadata.templateId || STAFFING_CAMPAIGN.emailTemplateId, templateVersion: metadata.copyVersion || '' };
  const record = buildIssuanceRecord({
    plan, actionId: issuanceKey.slice(0, -suffix.length), lead: { id: row.source_lead_id },
    triggerAction: isWarm ? (metadata.action || null) : null, campaignVersion: metadata.campaignVersion || null,
    ...template, senderInboxId: metadata.senderInboxId || '',
    isTest: testEmailDomains(env).includes(String(row.recipient_domain || '').toLowerCase()), env,
  });
  return { plan, record, metadata };
}

async function runLandingReconciliation({ env = process.env, store = defaultStore, now = () => Date.now(), logger = console } = {}) {
  if (!reconcilerEnabled(env)) return { ok: true, skipped: true, reason: 'LANDING_RECONCILER_ENABLED is not true' };
  const summary = {
    ok: true, at: new Date(now()).toISOString(), candidates: 0, issued: 0, markedSent: 0,
    skipped: {}, conflicts: 0, failures: 0, resolvedSessions: null, retention: null,
  };
  const note = reason => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };
  try {
    const { keyring } = landingTrackingState(env);
    const since = new Date(now() - RECONCILE_LOOKBACK_DAYS * DAY_MS).toISOString();
    const candidates = await store.landingBackfillCandidates({ since, limit: CANDIDATE_LIMIT });
    if (!candidates.ok) {
      summary.ok = false;
      summary.failures += 1;
      logger.warn(`[landing-reconcile] candidate query failed (${candidates.error})`);
    }
    for (const row of (candidates.ok && Array.isArray(candidates.data) ? candidates.data : [])) {
      summary.candidates += 1;
      const built = recordFromCandidate(row, keyring, env);
      if (built.skip) { note(built.skip); continue; }
      const issued = await store.issueLandingLink(built.record);
      if (!issued.ok) { summary.failures += 1; continue; }
      const stored = Array.isArray(issued.data) ? issued.data[0] : issued.data;
      const conflict = issuanceConflict(built.plan, stored);
      if (conflict) {
        summary.conflicts += 1;
        logger.error(JSON.stringify({ event: 'LANDING_LINK_ISSUANCE_CONFLICT', issuance_key: built.record.issuance_key, reason: conflict, source: 'reconciler' }));
        continue;
      }
      summary.issued += 1;
      if (!SEND_EVENT_TYPES.includes(row.event_type)) continue;
      const marked = await store.markLandingLinkSent({
        issuance_key: built.record.issuance_key, sent_at: row.occurred_at || null,
        provider_message_id: built.metadata.gmailMessageId || built.metadata.providerMessageId || null,
        provider_thread_id: built.metadata.gmailThreadId || null,
      });
      if (marked.ok) summary.markedSent += 1; else summary.failures += 1;
    }

    const resolved = await store.resolvePendingLandingSessions();
    if (resolved.ok) summary.resolvedSessions = resolved.data; else summary.failures += 1;

    if (now() - lastRetentionAt >= DAY_MS) {
      const retention = await store.applyLandingRetention({
        events_and_sessions_days: RETENTION_DAYS.eventsAndSessions,
        issuances_days: RETENTION_DAYS.issuances,
        unresolved_sessions_days: RETENTION_DAYS.unresolvedSessions,
        internal_and_debug_days: RETENTION_DAYS.internalAndDebug,
      });
      if (retention.ok) { summary.retention = retention.data; lastRetentionAt = now(); } else summary.failures += 1;
    }
  } catch (error) {
    summary.ok = false;
    summary.failures += 1;
    logger.warn(`[landing-reconcile] run failed (${error?.message || 'error'})`);
  }
  lastRun = summary;
  return summary;
}

function landingReconcileStatus() {
  return { lastRun, lastRetentionAt: lastRetentionAt ? new Date(lastRetentionAt).toISOString() : null };
}

/** Test hook: forget the once-a-day retention clock. */
function resetLandingReconcileState() {
  lastRun = null;
  lastRetentionAt = 0;
}

module.exports = { recordFromCandidate, runLandingReconciliation, landingReconcileStatus, resetLandingReconcileState, SEND_EVENT_TYPES };
