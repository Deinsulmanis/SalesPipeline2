'use strict';

/**
 * ClientRegistry — the one place that knows which managed clients exist.
 *
 * Every lookup is exact and fail-closed: an unknown or blank client id is
 * rejected, never mapped to a default. The default client exists only for
 * OWNERSHIP resolution of legacy records (ownership.js), not as a fallback for
 * a bad id.
 */

const { CLIENT_CONFIGS } = require('./client-configs');

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
const REPLY_MODES = new Set(['legacy', 'managed']);
const SUPPRESSION_SCOPES = new Set(['global', 'client']);
const BILLING_MODELS = new Set(['none', 'per_qualified_held_meeting']);

function validateClientConfig(config) {
  const id = String(config?.id || '');
  const fail = message => { throw new Error(`Client config ${id || '(blank)'}: ${message}`); };
  if (!CLIENT_ID_PATTERN.test(id)) fail('invalid id');
  if (!String(config.displayName || '').trim()) fail('displayName is required');
  if (typeof config.active !== 'boolean') fail('active must be boolean');
  if (typeof config.sending?.enabled !== 'boolean') fail('sending.enabled must be boolean');
  if (!config.isDefault) {
    if (!NAMESPACE_PATTERN.test(String(config.namespace || ''))) fail('a non-default client needs a namespace');
    if (config.platformAccess !== 'none') fail('a managed client must have platformAccess "none"');
    if (config.sending.requiresEnvAuthorization !== true) fail('a managed client must require env send authorization');
    if (config.sending.clientSuppressionRequired !== true) fail('a managed client must require the client suppression store');
  }
  if (!String(config.timezone || '').trim()) fail('timezone is required');
  if (!REPLY_MODES.has(config.replyPolicy?.mode)) fail('replyPolicy.mode is invalid');
  if (!SUPPRESSION_SCOPES.has(config.replyPolicy?.negativeReplySuppressionScope)) fail('replyPolicy.negativeReplySuppressionScope is invalid');
  if (!BILLING_MODELS.has(config.billing?.model)) fail('billing.model is invalid');
  if (config.billing.model === 'per_qualified_held_meeting') {
    if (!Number.isInteger(config.billing.performanceFeeCents) || config.billing.performanceFeeCents <= 0) fail('billing.performanceFeeCents must be a positive integer');
    if (!/^[A-Z]{3}$/.test(String(config.billing.currency || ''))) fail('billing.currency must be an ISO code');
    if (!config.qualification) fail('a billed client needs a qualification policy');
  }
  return config;
}

function buildRegistry(configs = CLIENT_CONFIGS) {
  const byId = new Map();
  const namespaces = new Map();
  let defaultId = '';
  for (const config of configs) {
    validateClientConfig(config);
    if (byId.has(config.id)) throw new Error(`Duplicate client id ${config.id}`);
    if (config.isDefault) {
      if (defaultId) throw new Error('Exactly one default client is allowed');
      defaultId = config.id;
    } else {
      if (namespaces.has(config.namespace)) throw new Error(`Duplicate client namespace ${config.namespace}`);
      namespaces.set(config.namespace, config.id);
    }
    byId.set(config.id, config);
  }
  if (!defaultId) throw new Error('A default client is required');
  return Object.freeze({ byId, namespaces, defaultId });
}

const REGISTRY = buildRegistry();
const DEFAULT_CLIENT_ID = REGISTRY.defaultId;

function normalizeClientId(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** { ok, clientId } for a registered id; { ok: false, code, reason } otherwise. */
function resolveClientId(value) {
  const id = normalizeClientId(value);
  if (!id) return { ok: false, code: 'client_required', reason: 'client id is required' };
  if (!REGISTRY.byId.has(id)) return { ok: false, code: 'client_unknown', reason: `unknown client ${id}` };
  return { ok: true, clientId: id };
}

function isKnownClient(value) {
  return resolveClientId(value).ok;
}

/** The config for a registered client. Throws for an unknown id. */
function getClient(value) {
  const resolved = resolveClientId(value);
  if (!resolved.ok) {
    const error = new Error(resolved.reason);
    error.code = resolved.code;
    throw error;
  }
  return REGISTRY.byId.get(resolved.clientId);
}

function listClients() {
  return [...REGISTRY.byId.values()];
}

/** The client whose namespace prefixes this identifier (`jole_…`, `JOLE-…`), or ''. */
function clientForNamespacedValue(value) {
  const match = String(value || '').trim().toLowerCase().match(/^([a-z][a-z0-9]{1,15})[_-]/);
  return match ? (REGISTRY.namespaces.get(match[1]) || '') : '';
}

/** Operator-facing summary. Never includes anything secret; there is nothing secret here. */
function publicClient(config) {
  return {
    clientId: config.id,
    displayName: config.displayName,
    isDefault: Boolean(config.isDefault),
    kind: config.kind,
    active: config.active,
    platformAccess: config.platformAccess,
    sendingEnabledInConfig: config.sending.enabled,
    timezone: config.timezone,
    timezoneConfirmed: config.timezoneConfirmed !== false,
    representative: config.representative ? { ...config.representative } : null,
    escalation: config.escalation ? { ...config.escalation } : null,
    conversationOwnership: config.conversationOwnership ? { ...config.conversationOwnership } : null,
    booking: config.booking ? { ...config.booking } : null,
    qualification: config.qualification ? {
      ...config.qualification,
      decisionMakerAreas: [...(config.qualification.decisionMakerAreas || [])],
      acceptedUseCases: [...(config.qualification.acceptedUseCases || [])],
    } : null,
    billing: { ...config.billing },
    replyPolicy: { mode: config.replyPolicy.mode, negativeReplySuppressionScope: config.replyPolicy.negativeReplySuppressionScope },
  };
}

module.exports = {
  DEFAULT_CLIENT_ID, validateClientConfig, buildRegistry, normalizeClientId,
  resolveClientId, isKnownClient, getClient, listClients, clientForNamespacedValue, publicClient,
};
