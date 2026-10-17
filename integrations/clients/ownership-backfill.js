'use strict';

/**
 * Plan (never perform) the ownership backfill between the canonical store and
 * its Sheets mirror, after 20260930010000 has added outreach_leads.client_id.
 *
 * Supabase already holds 'scalelab' for every pre-existing row (the column
 * default). The Sheets mirror's column Y is blank for those rows. This plans
 * writing Y so both stores state the owner literally, and proves there is no
 * split brain first:
 *
 *   ok             Y already equals the stored client_id
 *   fill           Y blank; stored client_id equals the owner the row's routing
 *                  fields infer → Y may be written with it
 *   mismatch       Y (or the inferred owner) disagrees with the stored client_id
 *   conflict       the row's own fields name more than one client
 *   not_in_store   the Sheets row has no canonical row
 *
 * Any mismatch, conflict or not_in_store makes the plan refuse: nothing is
 * written until a human resolves those rows.
 */

const { resolveLeadClient, inferLeadClient } = require('./ownership');
const { DEFAULT_CLIENT_ID } = require('./registry');

const text = value => String(value == null ? '' : value).trim();

/**
 * @param sheetLeads   ColdEmail rows as lead objects (CE_COLUMNS), with _row (1-based sheet row)
 * @param storeLeads   outreach_leads rows as lead objects (fromOutreachLeadRow), carrying clientId
 */
function planClientIdBackfill({ sheetLeads = [], storeLeads = [] } = {}) {
  const storeById = new Map(storeLeads.map(lead => [text(lead.id), lead]));
  const rows = [];
  for (const sheet of sheetLeads) {
    const id = text(sheet.id);
    if (!id) continue;
    const store = storeById.get(id);
    const entry = { id, row: sheet._row || null, sheetClientId: text(sheet.clientId), storeClientId: text(store?.clientId) };
    if (!store) { rows.push({ ...entry, status: 'not_in_store' }); continue; }
    const inferred = inferLeadClient(sheet).clients;
    if (inferred.size > 1) { rows.push({ ...entry, status: 'conflict' }); continue; }
    const inferredOwner = inferred.size ? [...inferred][0] : DEFAULT_CLIENT_ID;
    if (entry.sheetClientId) {
      const owner = resolveLeadClient(sheet);
      rows.push({ ...entry, status: owner.ok && owner.clientId === entry.storeClientId ? 'ok' : 'mismatch' });
      continue;
    }
    rows.push({ ...entry, inferredOwner, status: inferredOwner === entry.storeClientId ? 'fill' : 'mismatch' });
  }
  const count = status => rows.filter(row => row.status === status).length;
  const blocking = rows.filter(row => ['mismatch', 'conflict', 'not_in_store'].includes(row.status));
  return {
    total: rows.length,
    ok: count('ok'), fill: count('fill'), mismatch: count('mismatch'),
    conflict: count('conflict'), notInStore: count('not_in_store'),
    refuse: blocking.length > 0,
    blocking: blocking.slice(0, 50),
    writes: blocking.length ? [] : rows.filter(row => row.status === 'fill').map(row => ({ id: row.id, row: row.row, clientId: row.inferredOwner })),
  };
}

module.exports = { planClientIdBackfill };
