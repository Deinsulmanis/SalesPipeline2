'use strict';

/**
 * client-offboarding.js — plan the archive of every lead of an OFFBOARDED
 * managed client. PURE: the server loads canonical state, this decides, the
 * server writes (the same batched compare-and-set path as an offer retirement).
 *
 * Scope is strict: a lead is planned only when its own fields resolve, without
 * conflict, to the offboarded client (clients/ownership resolveLeadClient). The
 * default client (ScaleLab) can never be offboarded, so none of its leads can
 * ever be planned. Pipeline cards are not touched: managed clients have none.
 * Archived leads are restorable one by one (Archive → Restore).
 */

const { getClient } = require('./clients/registry');
const { resolveLeadClient } = require('./clients/ownership');
const { ARCHIVE_REASONS, isArchivedLead, planLeadArchive } = require('./lead-archive');

const text = value => (value === null || value === undefined ? '' : String(value));

function planClientOffboarding({
  clientId, leads = [], activities = [], unresolvedByLead = new Map(),
  archivedBy, source = 'client_offboarding', now = new Date(), stableId,
} = {}) {
  const client = getClient(clientId);
  if (client.isDefault) throw new Error(`${client.displayName} is the default client and is never offboarded`);
  if (client.lifecycleStatus !== 'offboarded' || client.active) {
    throw new Error(`${client.displayName} is not offboarded (lifecycle: ${client.lifecycleStatus}); refusing to archive its leads`);
  }
  const mine = leads.filter(lead => {
    const resolved = resolveLeadClient(lead);
    return resolved.ok && resolved.clientId === client.id;
  });
  const ids = new Set(mine.map(lead => text(lead.id)));
  const byLead = new Map();
  for (const row of activities) {
    const key = text(row.sourceLeadId).trim() || text(row.leadId).replace(/^CE-/, '').trim();
    if (!ids.has(key)) continue;
    const bucket = byLead.get(key) || [];
    bucket.push(row);
    byLead.set(key, bucket);
  }
  const summary = { clientId: client.id, total: mine.length, alreadyArchived: 0, toArchive: 0, byStage: {}, unresolvedSendState: 0 };
  const leadPlans = [];
  for (const lead of mine) {
    const stage = text(lead.stage) || '(blank)';
    summary.byStage[stage] = (summary.byStage[stage] || 0) + 1;
    if (isArchivedLead(lead)) { summary.alreadyArchived++; continue; }
    const unresolved = unresolvedByLead.get(text(lead.id)) || [];
    if (unresolved.length) summary.unresolvedSendState++;
    const plan = planLeadArchive(lead, {
      reason: ARCHIVE_REASONS.CLIENT_OFFBOARDED, archivedBy, source, now,
      activities: byLead.get(text(lead.id)) || [], stableId, boardLead: null, unresolved,
    });
    if (plan) leadPlans.push(plan);
  }
  summary.toArchive = leadPlans.length;
  return { client: { clientId: client.id, displayName: client.displayName, lifecycleStatus: client.lifecycleStatus }, summary, leadPlans };
}

module.exports = { planClientOffboarding };
