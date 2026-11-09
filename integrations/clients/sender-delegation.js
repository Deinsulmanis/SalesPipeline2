'use strict';

// Exclusive outbound assignment. These remain the SAME physical sender IDs,
// OAuth clients, credentials, quota buckets and observer cursors in both directions.
const ENABLED_VAR = 'JOLE_SCALELAB_SENDERS_ENABLED';
const CAMPAIGN_ID = 'jole-btx-employer-acquisition';
const MAILBOXES = Object.freeze([
  ['primary', 'deins@scalelabai.ca', 'GMAIL_TOKEN_JSON', 45, 'Deins Ulmanis', 5],
  ['tryscalelabai', 'deins@tryscalelabai.ca', 'GMAIL_TRYSCALELABAI_TOKEN_JSON', 20, 'Deins Ulmanis'],
  ['scalelabaiteam', 'deins@scalelabaiteam.com', 'GMAIL_SCALELABAITEAM_TOKEN_JSON', 15, 'Deins Ulmanis'],
  ['deniels', 'deniels@scalelabai.ca', 'GMAIL_DENIELS_TOKEN_JSON', 30, 'Deniels', 3],
  ['deniels_tryscalelabai', 'deniels@tryscalelabai.ca', 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', 20, 'Deniels'],
].map(([id, email, tokenEnv, dailyLimit, name, perRunLimit = 2]) => Object.freeze({ id, email, tokenEnv, dailyLimit, name, perRunLimit })));

const norm = value => String(value || '').trim().toLowerCase();
const delegationEnabled = (env = process.env) => env[ENABLED_VAR] === 'true';
function effectiveClientCapacity(client, env = process.env) {
  return client.id === 'jole' && delegationEnabled(env)
    ? { ...client.capacity, dailyCap: 235, windowCap: 26 } : client.capacity;
}
function delegatedMailbox(sender = {}) {
  return MAILBOXES.find(row => row.id === sender.id && row.email === norm(sender.email)) || null;
}

function applyExclusiveAssignment(senders, env = process.env) {
  if (!delegationEnabled(env)) return senders;
  for (const expected of MAILBOXES) {
    const matches = senders.filter(sender => sender.id === expected.id || norm(sender.email) === expected.email);
    if (matches.length !== 1 || !delegatedMailbox(matches[0]) || matches[0].tokenEnv !== expected.tokenEnv) {
      throw new Error(`Exclusive Jole assignment requires the original unique mailbox ${expected.id}`);
    }
  }
  return senders.map(sender => {
    const mailbox = delegatedMailbox(sender);
    if (!mailbox) return sender;
    return { ...sender, clientId: 'jole', allowedCampaignIds: [CAMPAIGN_ID], staffingOnly: false,
      dailyLimit: Math.min(Number(sender.dailyLimit) || 0, mailbox.dailyLimit),
      perRunLimit: Math.min(Number(sender.perRunLimit) || 0, mailbox.perRunLimit),
      delegatedFromClientId: 'scalelab',
      hardDailyCap: mailbox.dailyLimit,
      fromName: `${mailbox.name}, on behalf of Jole BTX LLC` };
  });
}

module.exports = { ENABLED_VAR, CAMPAIGN_ID, MAILBOXES, delegationEnabled, delegatedMailbox, applyExclusiveAssignment, effectiveClientCapacity };
