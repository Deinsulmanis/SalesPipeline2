'use strict';

/**
 * Client ownership — which managed client a lead, sender, campaign or template
 * belongs to, and the one consistency check routing, queueing, reservation and
 * sending all share.
 *
 * LEAD OWNERSHIP IS DERIVED from the routing fields both the canonical store
 * and its Sheets mirror already carry verbatim. Each field yields at most one
 * client signal:
 *
 *   registered managed-client lead type / template / campaign  → that client
 *   an identifier in a managed client's namespace (`jole_…`)     → that client
 *   a ScaleLab family keyword (`staffing`, `roof`, `dent`)       → scalelab
 *   anything else                                                → no signal
 *
 * No signal resolves to the default client (every historical record). One
 * client resolves to it. Two clients is `client_ownership_conflict`: the lead
 * is blocked everywhere and nothing guesses which client was meant.
 *
 * The default is ONE-DIRECTIONAL. A missing assertion resolves to ScaleLab; a
 * managed client must be asserted explicitly by the lead, the sender, the
 * campaign and the template. A Jole lead can therefore never "fall back" onto a
 * ScaleLab sender: an unregistered or ScaleLab sender resolves to ScaleLab and
 * the check fails.
 */

const { DEFAULT_CLIENT_ID, getClient, clientForNamespacedValue, resolveClientId } = require('./registry');
const { clientCampaign, clientTemplate, clientLeadType } = require('./campaigns');

const OWNERSHIP_CONFLICT = 'client_ownership_conflict';

const text = value => String(value == null ? '' : value).trim();

function legacyKeywordSignal(value) {
  const lower = text(value).toLowerCase();
  if (!lower) return '';
  const keywords = getClient(DEFAULT_CLIENT_ID).legacyFamilyKeywords;
  return keywords.some(keyword => lower.includes(keyword)) ? DEFAULT_CLIENT_ID : '';
}

// One field → at most one client. Registry first, then namespace, then the
// legacy family keywords. A field that names a managed client by namespace AND
// contains a legacy keyword yields both, which the caller treats as a conflict.
function fieldSignals(field, value) {
  const raw = text(value);
  if (!raw) return [];
  const signals = new Set();
  const registered = field === 'leadNiche' ? clientLeadType(raw)
    : field === 'emailTemplateId' ? clientTemplate(raw)
      : field === 'intendedCampaignVersion' ? clientCampaign(raw) : null;
  if (registered) signals.add(registered.clientId);
  const namespaced = clientForNamespacedValue(raw);
  if (namespaced) signals.add(namespaced);
  const legacy = legacyKeywordSignal(raw);
  if (legacy) signals.add(legacy);
  return [...signals];
}

const LEAD_OWNERSHIP_FIELDS = Object.freeze([
  'leadNiche', 'emailTemplateId', 'intendedCampaignVersion', 'campaign', 'tradeType',
]);

/**
 * The sender record for an id. Callers that already hold the configured sender
 * list pass it; otherwise the configured senders are loaded lazily (the lazy
 * require keeps this module free of a load-time cycle with sender routing).
 */
function findSender(senderOrId, senders) {
  if (senderOrId && typeof senderOrId === 'object') return senderOrId;
  const id = text(senderOrId);
  if (!id) return null;
  const list = senders || require('../gmail-sender-routing').configuredSenders();
  return list.find(sender => sender.id === id) || null;
}

/**
 * The client a sender serves. Every sender that does not declare one is a
 * ScaleLab sender (all six production inboxes). An id that is not configured at
 * all is also ScaleLab's — never a managed client's — so it can only ever fail
 * a managed-client lead, never admit one.
 */
function resolveSenderClient(senderOrId, { senders } = {}) {
  const sender = findSender(senderOrId, senders);
  const declared = text(sender?.clientId);
  if (!declared) return { ok: true, clientId: DEFAULT_CLIENT_ID, declared: false, known: Boolean(sender) };
  const resolved = resolveClientId(declared);
  if (!resolved.ok) return { ok: false, code: 'sender_client_unknown', reason: `sender ${sender.id} names ${resolved.reason}` };
  return { ok: true, clientId: resolved.clientId, declared: true, known: true };
}

function resolveCampaignClient(campaignId) {
  const id = text(campaignId);
  if (!id) return { ok: true, clientId: '', registered: false };
  const campaign = clientCampaign(id);
  if (campaign) return { ok: true, clientId: campaign.clientId, registered: true, campaign };
  const namespaced = clientForNamespacedValue(id);
  // A namespaced id that is not registered is an unknown managed campaign, not
  // a ScaleLab one.
  if (namespaced) return { ok: false, code: 'campaign_unknown', reason: `campaign ${id} is not registered for ${namespaced}` };
  return { ok: true, clientId: DEFAULT_CLIENT_ID, registered: false };
}

function resolveTemplateClient(templateId) {
  const id = text(templateId);
  if (!id) return { ok: true, clientId: '', registered: false };
  const template = clientTemplate(id);
  if (template) return { ok: true, clientId: template.clientId, registered: true, template };
  const namespaced = clientForNamespacedValue(id);
  if (namespaced) return { ok: false, code: 'template_unknown', reason: `template ${id} is not registered for ${namespaced}` };
  return { ok: true, clientId: DEFAULT_CLIENT_ID, registered: false };
}

/**
 * The client a lead belongs to.
 *
 * PRIMARY: the lead's explicit `clientId` (outreach_leads.client_id, ColdEmail
 * column Y). It must name a registered client, and the lead's routing fields
 * must not name a different one — an explicit owner that contradicts its own
 * niche, template or campaign is a conflict, never silently trusted.
 *
 * FALLBACK (legacy rows only): a blank clientId is inferred from the routing
 * fields, exactly as before explicit ownership existed. That is how rows mirrored
 * before the backfill resolve; it is not how new rows are owned.
 *
 * { ok: true, clientId, source: 'explicit' | 'inferred', legacyDefault, signals }
 * { ok: false, code, reason, signals }
 */
function inferLeadClient(lead = {}) {
  const signals = {};
  const clients = new Set();
  for (const field of LEAD_OWNERSHIP_FIELDS) {
    const found = fieldSignals(field, lead[field]);
    if (found.length) signals[field] = found;
    for (const id of found) clients.add(id);
  }
  return { signals, clients };
}

function resolveLeadClient(lead = {}) {
  const { signals, clients } = inferLeadClient(lead);
  const label = text(lead.id) || '(no id)';
  const explicitRaw = text(lead.clientId);
  if (explicitRaw) {
    const explicit = resolveClientId(explicitRaw);
    if (!explicit.ok) return { ok: false, code: OWNERSHIP_CONFLICT, signals, reason: `lead ${label} names ${explicit.reason}` };
    const contradicting = [...clients].filter(id => id !== explicit.clientId);
    if (contradicting.length) {
      return {
        ok: false, code: OWNERSHIP_CONFLICT, signals,
        reason: `lead ${label} is owned by ${explicit.clientId} but its routing fields name ${contradicting.sort().join(', ')}`,
      };
    }
    return { ok: true, clientId: explicit.clientId, source: 'explicit', legacyDefault: false, signals };
  }
  if (clients.size > 1) {
    return {
      ok: false, code: OWNERSHIP_CONFLICT, signals,
      reason: `lead ${label} names more than one client (${[...clients].sort().join(', ')})`,
    };
  }
  if (!clients.size) return { ok: true, clientId: DEFAULT_CLIENT_ID, source: 'inferred', legacyDefault: true, signals };
  return { ok: true, clientId: [...clients][0], source: 'inferred', legacyDefault: false, signals };
}

/** The explicit owner a new or backfilled row should be stored with, or throws. */
function ownerForWrite(lead = {}) {
  const resolved = resolveLeadClient(lead);
  if (!resolved.ok) throw Object.assign(new Error(resolved.reason), { code: resolved.code });
  return resolved.clientId;
}

/**
 * THE consistency check. Everything present must name the same client:
 *
 *   lead (its own fields) == campaign == template == sender (== expectedClientId)
 *
 * Absent parts are skipped, never defaulted into agreement; a lead's own
 * senderInboxId is checked too, so a Jole lead carrying a ScaleLab sender id
 * is refused even when the caller did not pass a sender.
 *
 * Returns { ok: true, clientId } or { ok: false, code, reason, parts }.
 */
function checkClientConsistency({
  lead = null, sender = null, senderInboxId = '', campaignId = '', templateId = '',
  expectedClientId = '', senders,
} = {}) {
  const parts = {};
  const refuse = (code, reason) => ({ ok: false, code, reason, parts });

  if (lead) {
    const leadClient = resolveLeadClient(lead);
    if (!leadClient.ok) return refuse(leadClient.code, leadClient.reason);
    parts.lead = leadClient.clientId;
    if (text(lead.senderInboxId)) {
      const own = resolveSenderClient(lead.senderInboxId, { senders });
      if (!own.ok) return refuse(own.code, own.reason);
      parts.leadSender = own.clientId;
    }
  }
  const senderRef = sender || text(senderInboxId);
  if (senderRef) {
    const resolved = resolveSenderClient(senderRef, { senders });
    if (!resolved.ok) return refuse(resolved.code, resolved.reason);
    parts.sender = resolved.clientId;
  }
  for (const [key, resolve, value] of [
    ['campaign', resolveCampaignClient, campaignId || lead?.intendedCampaignVersion],
    ['template', resolveTemplateClient, templateId || lead?.emailTemplateId],
  ]) {
    const resolved = resolve(value);
    if (!resolved.ok) return refuse(resolved.code, resolved.reason);
    if (resolved.clientId) parts[key] = resolved.clientId;
  }
  if (text(expectedClientId)) {
    const expected = resolveClientId(expectedClientId);
    if (!expected.ok) return refuse(expected.code, expected.reason);
    parts.expected = expected.clientId;
  }
  const distinct = [...new Set(Object.values(parts))];
  if (!distinct.length) return refuse('client_unresolved', 'no client could be resolved');
  if (distinct.length > 1) {
    const described = Object.entries(parts).map(([key, id]) => `${key}=${id}`).join(', ');
    return refuse(OWNERSHIP_CONFLICT, `client ownership mismatch (${described})`);
  }
  return { ok: true, clientId: distinct[0], parts };
}

class ClientOwnershipError extends Error {
  constructor(verdict) {
    super(verdict.reason || 'client ownership check failed');
    this.name = 'ClientOwnershipError';
    this.code = verdict.code || OWNERSHIP_CONFLICT;
    this.parts = verdict.parts || {};
  }
}

function assertClientConsistency(input) {
  const verdict = checkClientConsistency(input);
  if (!verdict.ok) throw new ClientOwnershipError(verdict);
  return verdict;
}

/**
 * The ownership a durable send reservation carries. Built by the caller that
 * holds the lead and the sender; checked by withOutboundReservation before any
 * row is written.
 */
function actionOwnership(lead, sender, { senders } = {}) {
  const verdict = checkClientConsistency({ lead, sender, senders });
  return {
    clientId: verdict.ok ? verdict.clientId : '',
    leadClientId: verdict.parts?.lead || '',
    senderClientId: verdict.parts?.sender || '',
    campaignClientId: verdict.parts?.campaign || '',
    templateClientId: verdict.parts?.template || '',
    ok: verdict.ok,
    ...(verdict.ok ? {} : { code: verdict.code, reason: verdict.reason }),
  };
}

/** Verdict for an ownership block attached to a send action (see actionOwnership). */
function checkActionOwnership(ownership) {
  if (!ownership) return { ok: true, clientId: '', skipped: true };
  if (ownership.ok === false) return { ok: false, code: ownership.code || OWNERSHIP_CONFLICT, reason: ownership.reason || 'action ownership is inconsistent' };
  const ids = ['clientId', 'leadClientId', 'senderClientId', 'campaignClientId', 'templateClientId']
    .map(key => text(ownership[key])).filter(Boolean);
  const distinct = [...new Set(ids)];
  if (!distinct.length) return { ok: false, code: 'client_unresolved', reason: 'action ownership names no client' };
  if (distinct.length > 1) return { ok: false, code: OWNERSHIP_CONFLICT, reason: `mixed-client action (${distinct.sort().join(', ')})` };
  return { ok: true, clientId: distinct[0] };
}

/** Does this lead definitively belong to a different client than `clientId`? Conflicted leads do not. */
function leadDefinitelyOtherClient(lead, clientId) {
  const resolved = resolveLeadClient(lead);
  return resolved.ok && resolved.clientId !== clientId;
}

/** Server-side scoping of a lead list to one client. Conflicted leads belong to no client view. */
function leadsForClient(leads = [], clientId) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) throw Object.assign(new Error(resolved.reason), { code: resolved.code });
  return (leads || []).filter(lead => {
    const owner = resolveLeadClient(lead);
    return owner.ok && owner.clientId === resolved.clientId;
  });
}

module.exports = {
  OWNERSHIP_CONFLICT, LEAD_OWNERSHIP_FIELDS, ClientOwnershipError,
  resolveLeadClient, inferLeadClient, ownerForWrite, resolveSenderClient, resolveCampaignClient, resolveTemplateClient,
  checkClientConsistency, assertClientConsistency, actionOwnership, checkActionOwnership,
  leadDefinitelyOtherClient, leadsForClient,
};
