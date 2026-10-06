'use strict';

/**
 * Client sender policy — which mailboxes may send for a managed client, for
 * which campaigns, and how much.
 *
 * The client a sender serves is still its explicit `clientId` (ownership.js);
 * this module adds the managed client's own rules on top, from its source-
 * controlled `senderPolicy`:
 *
 *   - the mailbox's domain must be one of the client's outbound domains, and is
 *     never one of its protected domains (Jole's corporate jolebtx.com);
 *   - a domain any client claims (outbound or protected) is unusable by every
 *     other client, ScaleLab included — defense in depth, not the boundary;
 *   - the sender serves only the campaigns it lists, which must be within the
 *     client's allowedCampaignIds (an omitted list means the client's list);
 *   - its daily limit is clamped to the client's per-inbox hard ceiling;
 *   - while the client itself may not send, none of its inboxes may either.
 *
 * A violation never throws at registry load (a bad managed-client row must not
 * take ScaleLab's registry down with it). It produces policyBlockers, and a
 * sender with any blocker is not send-eligible anywhere.
 *
 * The default client has no senderPolicy: its inboxes keep exactly their
 * existing registry rules and are unrestricted across ScaleLab campaigns.
 */

const { DEFAULT_CLIENT_ID, getClient, listClients, resolveClientId } = require('./registry');
const { clientCampaign } = require('./campaigns');
const { clientSendBlock } = require('./send-policy');

const text = value => String(value == null ? '' : value).trim();
const domainOf = email => text(email).toLowerCase().split('@')[1] || '';

function senderOwner(sender = {}) {
  const raw = text(sender.clientId);
  if (!raw) return getClient(DEFAULT_CLIENT_ID);
  const resolved = resolveClientId(raw);
  return resolved.ok ? getClient(resolved.clientId) : null;
}

/** The campaigns a managed-client sender may serve: its own list, else its client's. */
function senderAllowedCampaigns(sender = {}) {
  const owner = senderOwner(sender);
  if (!owner?.senderPolicy) return [];
  const declared = Array.isArray(sender.allowedCampaignIds) ? sender.allowedCampaignIds.map(text).filter(Boolean) : null;
  return declared && declared.length ? declared : [...owner.senderPolicy.allowedCampaignIds];
}

/** Why this sender may not send under the client sender policies; [] when nothing blocks it. */
function senderPolicyBlockers(sender = {}, env = process.env) {
  const owner = senderOwner(sender);
  if (!owner) return ['sender names an unknown client'];
  const blockers = [];
  const domain = domainOf(sender.email);
  for (const other of listClients()) {
    if (other.id === owner.id || !other.senderPolicy) continue;
    const policy = other.senderPolicy;
    if (domain && (policy.outboundDomains.includes(domain) || policy.protectedDomains.includes(domain))) {
      blockers.push(`${domain} is reserved for ${other.displayName}`);
    }
  }
  const policy = owner.senderPolicy;
  if (!policy) return blockers;
  if (policy.protectedDomains.includes(domain)) {
    blockers.push(`${domain} is ${owner.displayName}'s protected domain and is never a cold sender`);
  } else if (!policy.outboundDomains.includes(domain)) {
    blockers.push(`${domain || 'a blank domain'} is not an approved ${owner.displayName} outbound domain`);
  }
  const outside = senderAllowedCampaigns(sender).filter(id => !policy.allowedCampaignIds.includes(id));
  if (outside.length) blockers.push(`campaign ${outside.join(', ')} is not allowed for ${owner.displayName} senders`);
  // A registry row saying "active" is not send authority: until the client
  // itself may send (active + sending.enabled + CLIENT_SENDING_AUTHORIZED),
  // every one of its inboxes is held non-sending, whatever its status says.
  const clientBlock = clientSendBlock(owner.id, env);
  if (clientBlock) blockers.push(`client sending is not authorized: ${clientBlock.reason}`);
  return blockers;
}

/** The daily limit after the client's per-inbox hard ceiling (unchanged for the default client). */
function cappedDailyLimit(sender = {}, dailyLimit = sender.dailyLimit) {
  const ceiling = senderOwner(sender)?.senderPolicy?.maxDailyPerInbox;
  return Number.isInteger(ceiling) ? Math.min(Number(dailyLimit) || 0, ceiling) : dailyLimit;
}

/**
 * May this sender carry this campaign? The default client's senders are not
 * campaign-scoped (true). A managed client's sender serves only its listed
 * campaigns; a blank or unregistered campaign is refused.
 */
function senderServesCampaign(sender = {}, campaignRef = '') {
  const owner = senderOwner(sender);
  if (!owner) return false;
  if (!owner.senderPolicy) return true;
  const campaign = clientCampaign(campaignRef);
  if (!campaign || campaign.clientId !== owner.id) return false;
  return senderAllowedCampaigns(sender).includes(campaign.id);
}

module.exports = { senderOwner, senderAllowedCampaigns, senderPolicyBlockers, cappedDailyLimit, senderServesCampaign, domainOf };
