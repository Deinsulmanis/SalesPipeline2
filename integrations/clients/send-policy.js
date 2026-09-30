'use strict';

/**
 * Client-level send control. Sits alongside, never instead of, the process
 * authorization in send-authorization.js: a send needs BOTH.
 *
 * A managed client sends only when:
 *   1. the client is active,
 *   2. its source-controlled config says sending.enabled === true, and
 *   3. CLIENT_SENDING_AUTHORIZED (comma-separated client ids) names it.
 *
 * Two independent keys on purpose: a deploy alone cannot activate a client,
 * and neither can an env edit alone. The default client keeps its existing
 * authority (SENDING_ENABLED + SEND_AUTHORIZED_*) and needs neither key.
 */

const { getClient, resolveClientId } = require('./registry');

const AUTHORIZED_CLIENTS_VAR = 'CLIENT_SENDING_AUTHORIZED';

function authorizedClientIds(env = process.env) {
  return new Set(String(env[AUTHORIZED_CLIENTS_VAR] || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

/** '' when the client may send, otherwise a refusal { code, reason }. */
function clientSendBlock(clientId, env = process.env) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) return { code: resolved.code, reason: resolved.reason };
  const client = getClient(resolved.clientId);
  if (!client.active) {
    return { code: 'client_inactive', reason: `${client.displayName} is not an active client (lifecycle: ${client.lifecycleStatus})` };
  }
  if (!client.sending.enabled) {
    return { code: 'client_sending_disabled', reason: `${client.displayName} sending is disabled` };
  }
  if (client.sending.requiresEnvAuthorization && !authorizedClientIds(env).has(client.id)) {
    return { code: 'client_sending_disabled', reason: `${client.displayName} is not named in ${AUTHORIZED_CLIENTS_VAR}` };
  }
  return null;
}

function clientSendingEnabled(clientId, env = process.env) {
  return clientSendBlock(clientId, env) === null;
}

/** Operator-facing state for the dashboard; no secret is involved. */
function clientSendState(clientId, env = process.env) {
  const block = clientSendBlock(clientId, env);
  const client = getClient(clientId);
  return {
    clientId: client.id,
    active: client.active,
    lifecycleStatus: client.lifecycleStatus,
    configEnabled: client.sending.enabled,
    envAuthorized: client.sending.requiresEnvAuthorization ? authorizedClientIds(env).has(client.id) : null,
    sendingEnabled: !block,
    ...(block ? { blockCode: block.code, blockReason: block.reason } : {}),
  };
}

module.exports = { AUTHORIZED_CLIENTS_VAR, authorizedClientIds, clientSendBlock, clientSendingEnabled, clientSendState };
