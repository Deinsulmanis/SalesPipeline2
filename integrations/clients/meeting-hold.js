'use strict';

/**
 * meeting-hold.js — a managed-client lead with a meeting in the client ledger
 * leaves the cold sequence.
 * ─────────────────────────────────────────────────────────────────────────────
 * Once a lead has booked (whether the calendar sync recorded it or an operator
 * did), the conversation is personal. A cold "just following up" touch after
 * that is wrong whatever the meeting's later status: booked, moved, held,
 * cancelled or a no-show is for a person to follow up, not the sequence.
 *
 * The agent loads every ledger client's meetings ONCE per run. When that read
 * fails, the client's cold sends are held for the run (fail closed): a ledger we
 * cannot read is not evidence that nobody booked.
 */

const { listClients, getClient } = require('./registry');
const { resolveLeadClient } = require('./ownership');

/** Clients whose meetings live in the client ledger. */
function ledgerClientIds() {
  return listClients().filter(client => client.reporting?.ledger).map(client => client.id);
}

/**
 * { loaded, byClient: Map<clientId, { ok, leadIds:Set, error }> }
 * Never throws: a failed client is recorded and holds its own leads only.
 */
async function loadClientMeetingHolds({ store, clientIds = ledgerClientIds() } = {}) {
  const byClient = new Map();
  for (const clientId of clientIds) {
    try {
      if (!store?.enabled) throw new Error(`client ledger is not enabled${store?.reason ? `: ${store.reason}` : ''}`);
      const meetings = await store.listMeetings(clientId);
      const leadIds = new Set((meetings || [])
        .filter(row => row && row.client_id === clientId && String(row.lead_id || '').trim())
        .map(row => String(row.lead_id).trim()));
      byClient.set(clientId, { ok: true, leadIds, error: '' });
    } catch (error) {
      byClient.set(clientId, { ok: false, leadIds: new Set(), error: error.message || String(error) });
    }
  }
  return { loaded: true, byClient };
}

/**
 * Why this lead may not receive a cold touch, or '' when nothing holds it.
 * A lead of a client the holds were not loaded for (ScaleLab, or a run that
 * never loaded them) is never held here.
 */
function clientMeetingHoldReason(lead = {}, holds = null) {
  if (!holds?.loaded) return '';
  const owner = resolveLeadClient(lead);
  if (!owner.ok) return '';
  const entry = holds.byClient.get(owner.clientId);
  if (!entry) return '';
  const name = getClient(owner.clientId).displayName;
  if (!entry.ok) return `${name} meeting ledger unreadable, so a booking cannot be ruled out (${entry.error})`;
  if (entry.leadIds.has(String(lead.id || '').trim())) return `a meeting with this lead is in the ${name} meeting ledger`;
  return '';
}

/** One log line per client per run, never one per lead. */
function describeClientMeetingHolds(holds) {
  if (!holds?.loaded) return [];
  return [...holds.byClient.entries()].map(([clientId, entry]) => (entry.ok
    ? { event: 'client_meeting_holds_loaded', client_id: clientId, leads_with_meetings: entry.leadIds.size }
    : { event: 'client_meeting_holds_unavailable', client_id: clientId, error: entry.error, effect: 'cold sends for this client held this run' }));
}

module.exports = { ledgerClientIds, loadClientMeetingHolds, clientMeetingHoldReason, describeClientMeetingHolds };
