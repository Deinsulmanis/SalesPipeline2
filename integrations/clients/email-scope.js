'use strict';

/**
 * Email identity is tenant-scoped: one lead per (client_id, normalized email).
 * The same address may be a prospect of two clients; inside one client it is
 * still exactly one lead, so no client can mail a person twice through two rows.
 *
 * Every email → lead lookup therefore happens inside ONE client's scope, and an
 * ambiguous match inside a scope fails safe (no match / refusal), never a
 * cross-client match.
 *
 * UNIQUENESS MODE (the interlock with the database)
 *
 *   global  (default) the database still carries the global unique index on
 *           email_normalized. A second client's lead for an address that already
 *           exists would land in Sheets and then fail the Supabase mirror, so
 *           imports refuse it exactly as before.
 *   client  set OUTREACH_EMAIL_UNIQUENESS=client only AFTER
 *           20260930020000_outreach_leads_tenant_scoped_email.sql has dropped
 *           the global index. Imports then dedupe inside the importing client.
 */

const { DEFAULT_CLIENT_ID, listClients, resolveClientId } = require('./registry');
const { resolveLeadClient } = require('./ownership');

const UNIQUENESS_VAR = 'OUTREACH_EMAIL_UNIQUENESS';
const norm = value => String(value || '').trim().toLowerCase();

function emailUniquenessMode(env = process.env) {
  return String(env[UNIQUENESS_VAR] || '').trim().toLowerCase() === 'client' ? 'client' : 'global';
}

/**
 * The leads one client's inbox, calendar or board may match by email.
 *
 * In scope: leads whose owner is `clientId`. A lead whose ownership conflicts
 * belongs to no client, but protective handling (an opt-out, a bounce) must
 * still reach it — so it stays visible, unless its address is already taken by
 * an in-scope lead, where it would only make that address ambiguous.
 */
function leadsInEmailScope(leads = [], clientId) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) throw Object.assign(new Error(resolved.reason), { code: resolved.code });
  const inScope = [];
  const conflicted = [];
  for (const lead of leads || []) {
    const owner = resolveLeadClient(lead);
    if (owner.ok) { if (owner.clientId === resolved.clientId) inScope.push(lead); }
    else conflicted.push(lead);
  }
  const taken = new Set(inScope.map(lead => norm(lead.email)).filter(Boolean));
  return [...inScope, ...conflicted.filter(lead => !taken.has(norm(lead.email)))];
}

/** Clients whose meetings arrive through ScaleLab's Google Calendar sync. */
function calendarSyncClientIds() {
  return listClients().filter(client => client.booking?.mode === 'google_calendar_sync').map(client => client.id);
}

/** Leads a Google Calendar booking may be matched to, by attendee email. */
function leadsForCalendarMatching(leads = []) {
  const ids = calendarSyncClientIds();
  const seen = new Set();
  const out = [];
  for (const id of ids) for (const lead of leadsInEmailScope(leads, id)) {
    if (!seen.has(lead)) { seen.add(lead); out.push(lead); }
  }
  return out;
}

/**
 * Is this address already a lead for the importing client?
 * { taken: boolean, reason, existing }
 */
function emailTakenFor({ email, clientId, leads = [], env = process.env }) {
  const address = norm(email);
  const matches = (leads || []).filter(lead => norm(lead.email) === address);
  if (!matches.length) return { taken: false };
  if (emailUniquenessMode(env) === 'global') {
    return { taken: true, reason: 'address already exists (global email uniqueness is in force)', existing: matches[0] };
  }
  for (const lead of matches) {
    const owner = resolveLeadClient(lead);
    // A conflicted row is a duplicate for every client: nobody may add a
    // second row for an address whose current owner is unknown.
    if (!owner.ok) return { taken: true, reason: 'address belongs to a lead with conflicting ownership', existing: lead };
    if (owner.clientId === clientId) return { taken: true, reason: 'address is already this client\'s lead', existing: lead };
  }
  return { taken: false, otherClients: matches.map(lead => resolveLeadClient(lead).clientId) };
}

/** The client that owns this lead, or '' when its ownership conflicts. */
function tenantOf(lead) {
  const owner = resolveLeadClient(lead || {});
  return owner.ok ? owner.clientId : '';
}

/**
 * Split leads sharing an address into per-client groups. Conflicted leads ('')
 * join every group, since nobody knows whose they are.
 */
function groupByTenant(leads = []) {
  const conflicted = leads.filter(lead => !tenantOf(lead));
  const groups = new Map();
  for (const lead of leads) {
    const tenant = tenantOf(lead);
    if (!tenant) continue;
    if (!groups.has(tenant)) groups.set(tenant, []);
    groups.get(tenant).push(lead);
  }
  if (!groups.size) return conflicted.length ? [conflicted] : [];
  return [...groups.values()].map(group => [...group, ...conflicted]);
}

module.exports = {
  tenantOf, groupByTenant,
  UNIQUENESS_VAR, DEFAULT_CLIENT_ID, emailUniquenessMode, leadsInEmailScope,
  calendarSyncClientIds, leadsForCalendarMatching, emailTakenFor,
};
