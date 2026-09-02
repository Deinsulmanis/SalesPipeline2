'use strict';
/**
 * supabase-mirror.js — Stage 1 shadow mirror of canonical CRM activity.
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Sheets stays the authoritative database. This module copies an event
 * to Supabase AFTER the Sheets write has already succeeded, and its failure is
 * never allowed to change what the application did.
 *
 * That is the whole design constraint, and it drives every decision below:
 *
 *   * Optional. With no environment variables the module reports itself
 *     disabled and every call is a cheap no-op. The app boots, sends, and runs
 *     Pipeline and automation exactly as it does today.
 *   * Non-blocking. mirrorEvents() never throws and never rejects. Callers do
 *     not await a result they would have to handle, because there is no
 *     handling to do: the authoritative write already happened.
 *   * Bounded. One short timeout, at most two attempts, no queue, no unbounded
 *     backoff. A Supabase outage must not turn into retry traffic that outlives
 *     the incident.
 *   * Idempotent. event_id is the primary key and every write is an upsert, so
 *     replaying an event — a retry, a backfill, a re-run — converges instead of
 *     duplicating.
 *
 * WHY POSTGREST OVER HTTP RATHER THAN A POSTGRES CONNECTION OR THE SUPABASE SDK
 *
 * The Supabase JS client is ergonomics over exactly this HTTP API; for one
 * upsert and two aggregate reads it earns little, and adding a dependency to a
 * repo under concurrent edit invites a package.json/lockfile conflict for no
 * functional gain. A direct Postgres connection through the pooler would be the
 * right call for transactional or high-volume work, but it means a socket pool
 * living inside a container that also runs cron jobs — more state to leak and
 * more ways to fail in a component whose entire promise is that it cannot
 * disturb anything. Stateless HTTPS with a hard timeout is the smaller risk:
 * a failed mirror is just a failed request.
 *
 * SECRETS
 *
 * The key is read from the environment at call time and used only as a request
 * header. It is never returned, logged, embedded in an error, or included in
 * any object this module hands back. Nothing here is reachable from the
 * browser: the module is required by server-side code only.
 */

const TABLE = 'crm_events';

// Two attempts, ~4s ceiling each. Deliberately small: this is a shadow write.
const REQUEST_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/**
 * Configuration, or a plain statement that mirroring is off.
 *
 * SUPABASE_SECRET_KEY is the current server-side key name (the `sb_secret_...`
 * key that replaced the legacy service_role JWT). SUPABASE_SERVICE_ROLE_KEY is
 * accepted as a fallback so an older project does not silently mirror nothing.
 */
function mirrorConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    return {
      enabled: false,
      reason: !url && !key ? 'SUPABASE_URL and SUPABASE_SECRET_KEY are not set'
        : !url ? 'SUPABASE_URL is not set' : 'SUPABASE_SECRET_KEY is not set',
    };
  }
  // https everywhere, with one exception: a loopback address, so the mirror can
  // be exercised against a local stand-in without a certificate. The exception
  // is pinned to 127.0.0.1/localhost, so it can never quietly permit plaintext
  // to a real project — a hosted Supabase URL that arrives as http is refused.
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
  if (!isLoopback && !/^https:\/\/[^\s]+$/i.test(url)) {
    return { enabled: false, reason: 'SUPABASE_URL must be an https URL' };
  }
  return { enabled: true, url, key, endpoint: `${url}/rest/v1/${TABLE}` };
}

/** True when mirroring is switched on. Safe to call anywhere. */
function mirrorEnabled(env = process.env) {
  return mirrorConfig(env).enabled;
}

const parseMetadata = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
};

/** A timestamp Postgres will accept, or null. Never a substituted "now". */
function isoOrNull(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const textOrNull = value => {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
};

/**
 * One canonical activity row → one crm_events row.
 *
 * Attribution is lifted out of metadata where the application already put it,
 * and left null where it is absent. Nothing is defaulted or inferred: an event
 * written before campaign versioning existed has no campaign version, and
 * saying so is the point.
 *
 * `content` is dropped. It carries email bodies and reply text, and Stage 1
 * mirrors identifiers and metadata only.
 */
function toCrmEvent(activity = {}) {
  const metadata = parseMetadata(activity.metadata);
  const step = Number(metadata.sequenceStep ?? metadata.step);
  return {
    event_id: String(activity.eventId || '').trim(),
    lead_id: textOrNull(activity.leadId),
    source_lead_id: textOrNull(activity.sourceLeadId),
    email: textOrNull(activity.email),
    company: textOrNull(activity.company),
    event_type: String(activity.eventType || '').trim(),
    occurred_at: isoOrNull(activity.occurredAt),
    subject: textOrNull(activity.subject),
    campaign_version: textOrNull(metadata.campaignVersion),
    campaign_family: textOrNull(metadata.campaignFamily),
    copy_version: textOrNull(metadata.copyVersion),
    sender_inbox_id: textOrNull(metadata.senderInboxId),
    // providerMessageId and gmailMessageId are the same identifier written by
    // different call sites; either is the provider's id for the message.
    provider_message_id: textOrNull(metadata.providerMessageId ?? metadata.gmailMessageId),
    provider_thread_id: textOrNull(metadata.gmailThreadId ?? metadata.threadId),
    sequence_id: textOrNull(metadata.sequenceId),
    sequence_step: Number.isFinite(step) ? step : null,
    metadata,
  };
}

/**
 * Is this row safe to mirror? An event with no id has no identity to upsert on,
 * and one with no type is not a canonical activity. Both are reported rather
 * than silently dropped.
 */
function describeUnmirrorable(activity = {}) {
  if (!String(activity.eventId || '').trim()) return 'missing eventId';
  if (!String(activity.eventType || '').trim()) return 'missing eventType';
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** fetch with a hard timeout, so a hung socket cannot outlive the request. */
async function requestWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function headersFor(config, extra = {}) {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Mirror canonical activities. NEVER throws and NEVER rejects.
 *
 * @returns { enabled, attempted, mirrored, skipped, failed, reason }
 *          — a report, never an error to handle.
 */
async function mirrorEvents(activities, { env = process.env, logger = console } = {}) {
  const rows = Array.isArray(activities) ? activities : [activities];
  const config = mirrorConfig(env);
  if (!config.enabled) {
    return { enabled: false, attempted: 0, mirrored: 0, skipped: 0, failed: 0, reason: config.reason };
  }
  if (!rows.length) {
    return { enabled: true, attempted: 0, mirrored: 0, skipped: 0, failed: 0, reason: 'nothing to mirror' };
  }

  const usable = [];
  const skipped = [];
  for (const activity of rows) {
    const problem = describeUnmirrorable(activity);
    if (problem) skipped.push({ eventId: activity && activity.eventId, problem });
    else usable.push(toCrmEvent(activity));
  }
  if (skipped.length) {
    logger.warn(`[supabase-mirror] skipped ${skipped.length} unmirrorable event(s): `
      + skipped.map(item => `${item.eventId || '(no id)'} — ${item.problem}`).join('; '));
  }
  if (!usable.length) {
    return { enabled: true, attempted: 0, mirrored: 0, skipped: skipped.length, failed: 0, reason: 'no mirrorable events' };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await requestWithTimeout(config.endpoint, {
        method: 'POST',
        // merge-duplicates is the upsert: a replayed event_id updates its own
        // row instead of creating a second one.
        headers: headersFor(config, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(usable),
      });
      if (response.ok) {
        logger.log(`[supabase-mirror] mirrored ${usable.length} event(s)`
          + (skipped.length ? ` (${skipped.length} skipped)` : ''));
        return { enabled: true, attempted: usable.length, mirrored: usable.length, skipped: skipped.length, failed: 0, reason: 'ok' };
      }
      // The response body can echo submitted values, so only the status is
      // recorded. Nothing here may leak a key or a message body into a log.
      lastError = `HTTP ${response.status}`;
      // 4xx other than 409 is a bad request; retrying sends the same bad
      // request again. Only transient failures are worth a second attempt.
      if (response.status < 500 && response.status !== 409) break;
    } catch (error) {
      lastError = error && error.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : (error && error.message) || 'request failed';
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  // Deferred, not lost: the authoritative row is in Sheets, and the backfill
  // tool re-derives this event from it by the same deterministic id.
  logger.warn(`[supabase-mirror] deferred ${usable.length} event(s) — ${lastError}. `
    + 'Google Sheets is unaffected; re-run the backfill to reconcile.');
  return { enabled: true, attempted: usable.length, mirrored: 0, skipped: skipped.length, failed: usable.length, reason: lastError };
}

/**
 * Fire-and-forget wrapper for the authoritative write paths.
 *
 * Returns nothing and awaits nothing, so a slow or unreachable Supabase cannot
 * add latency to a send or a CRM mutation. The promise is fully handled inside,
 * so it can never surface as an unhandled rejection.
 */
function mirrorEventsInBackground(activities, options = {}) {
  try {
    const result = mirrorEvents(activities, options);
    if (result && typeof result.catch === 'function') {
      result.catch(error => {
        const logger = options.logger || console;
        logger.warn(`[supabase-mirror] background mirror failed: ${(error && error.message) || 'unknown error'}`);
      });
    }
  } catch (error) {
    const logger = options.logger || console;
    logger.warn(`[supabase-mirror] background mirror could not start: ${(error && error.message) || 'unknown error'}`);
  }
}

/**
 * Read-only health. Reports configuration and counts and nothing else — no key,
 * no URL credentials, no row contents.
 *
 * Stage 1 is observational: nothing in CRM Health or any production decision
 * may branch on this.
 */
async function mirrorHealth({ env = process.env, sheetCount = null } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) {
    return {
      configured: false, healthy: null, reason: config.reason,
      mirroredCount: null, latestMirroredAt: null,
      sheetCount, difference: null,
    };
  }
  try {
    // HEAD + count=exact returns the row count in Content-Range without
    // transferring any rows.
    const countResponse = await requestWithTimeout(`${config.endpoint}?select=event_id`, {
      method: 'HEAD', headers: headersFor(config, { Prefer: 'count=exact' }),
    });
    if (!countResponse.ok) {
      return { configured: true, healthy: false, reason: `HTTP ${countResponse.status}`,
        mirroredCount: null, latestMirroredAt: null, sheetCount, difference: null };
    }
    const range = countResponse.headers.get('content-range') || '';
    const mirroredCount = Number(range.split('/')[1]);
    const latestResponse = await requestWithTimeout(
      `${config.endpoint}?select=occurred_at&order=occurred_at.desc.nullslast&limit=1`,
      { method: 'GET', headers: headersFor(config) },
    );
    const latest = latestResponse.ok ? await latestResponse.json().catch(() => []) : [];
    const count = Number.isFinite(mirroredCount) ? mirroredCount : null;
    return {
      configured: true, healthy: true, reason: 'ok',
      mirroredCount: count,
      latestMirroredAt: (latest[0] && latest[0].occurred_at) || null,
      sheetCount,
      difference: Number.isFinite(sheetCount) && count !== null ? sheetCount - count : null,
    };
  } catch (error) {
    return {
      configured: true, healthy: false,
      reason: error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || 'unreachable',
      mirroredCount: null, latestMirroredAt: null, sheetCount, difference: null,
    };
  }
}

module.exports = {
  TABLE, REQUEST_TIMEOUT_MS, MAX_ATTEMPTS,
  mirrorConfig, mirrorEnabled, toCrmEvent, describeUnmirrorable,
  mirrorEvents, mirrorEventsInBackground, mirrorHealth,
};
