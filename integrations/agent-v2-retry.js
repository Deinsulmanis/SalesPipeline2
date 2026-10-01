'use strict';

/**
 * Agent v2 shadow retry policy.
 *
 * A shadow decision is one row per inbound message. A row that completed with
 * a TRANSIENT failure (provider credits, rate limit, overload, 5xx, timeout,
 * network, missing key, or a model call interrupted by a crash) keeps its
 * failure record but stays claimable: after a backoff the next claim may call
 * the model again and replace it. Everything else is final: a valid decision,
 * a deterministic guard, a validation failure of the model's output, a model
 * mismatch, and a provider 400. Attempts are capped, so an outage or a broken
 * key ends in a recorded failure, never a loop.
 */

const MAX_SHADOW_ATTEMPTS = 4;
const RETRY_BASE_SECONDS = 30 * 60;

const RETRYABLE_ERROR_CATEGORIES = Object.freeze(new Set([
  'credits', 'rate_limited', 'overloaded', 'server_error', 'timeout', 'network',
  'auth', 'unknown', 'key_unavailable', 'unresolved_model_attempt',
]));

/** { retryable, errorCategory } for one completed shadow evaluation. */
function shadowFailure({ modelStatus, errorCategory = null, decisionStatus = null } = {}) {
  if (modelStatus === 'ok' || modelStatus === 'guarded') return { retryable: false, errorCategory: null };
  if (decisionStatus === 'unresolved_model_attempt') return { retryable: true, errorCategory: 'unresolved_model_attempt' };
  if (modelStatus === 'key_unavailable') return { retryable: true, errorCategory: 'key_unavailable' };
  if (modelStatus === 'model_error') {
    const category = errorCategory || 'unknown';
    return { retryable: RETRYABLE_ERROR_CATEGORIES.has(category), errorCategory: category };
  }
  // invalid_response, model_mismatch: the provider answered; the answer failed
  // deterministic checks. Retrying would only buy the same failure.
  return { retryable: false, errorCategory: modelStatus || 'unknown' };
}

/** Seconds to wait after the Nth claim before claim N+1 (30m, 60m, 120m). */
function retryDelaySeconds(claimAttempts) {
  return RETRY_BASE_SECONDS * (2 ** Math.max(0, Number(claimAttempts || 1) - 1));
}

module.exports = { MAX_SHADOW_ATTEMPTS, RETRY_BASE_SECONDS, RETRYABLE_ERROR_CATEGORIES,
  shadowFailure, retryDelaySeconds };
