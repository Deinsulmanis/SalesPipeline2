'use strict';
/**
 * fresh-send-state.js — the last-moment read of the lead about to be emailed.
 *
 * guardProviderSend revalidates the ONE lead a provider send is for, against
 * durable state, immediately before the send. When Supabase serves the
 * automation corpus, that revalidation re-downloaded the whole corpus to find
 * one row: 2,203 rows, 1.23 MB on the wire (4.36 MB decoded), once per send. A
 * 21-send window read it 22 times; on 2026-09-25 the agent read it ~200 times
 * and the Supabase project was restricted for exceeding its egress quota.
 *
 * It now reads exactly that lead, from the same canonical table, at the same
 * moment. Nothing about the decision changes:
 *
 *   freshness   every send still reads the row as it is now, never a copy
 *   failure     an unreadable Supabase throws; revalidateFreshSendSafety turns
 *               that into a refusal. Nothing falls back to Sheets.
 *   identity    a lead that is not in canonical state is `current: null`, which
 *               the gate refuses as identity_changed, exactly as before
 *   Sheets      when the snapshot carries ColdEmail rows (Sheets write authority,
 *               or a non-primary read mode) those rows are used, unchanged
 */

const firstName = lead => (lead && lead.contactName ? String(lead.contactName).split(' ')[0] : '') || '';

/**
 * The current state of one lead, from the snapshot's Sheets rows when it has
 * them, otherwise from canonical Supabase by id.
 *
 * @param snapshot       loadAgentSnapshot() result; coldEmail is null when Supabase serves reads
 * @param readSheetLeads (rows) => leads   the existing Sheets projection (readLeads)
 * @param getLeadById    (id) => { ok, lead, reason }   canonical single-row read
 */
async function freshLeadFromSnapshot({ snapshot, leadId, readSheetLeads, getLeadById }) {
  const match = String(leadId || '').trim();
  if (snapshot && snapshot.coldEmail) {
    const rows = await readSheetLeads(snapshot.coldEmail);
    return rows.find(row => String(row.id) === match) || rows.find(row => `CE-${row.id}` === match) || null;
  }
  // Same precedence as the corpus lookup it replaces: the id itself, then a
  // board-style CE- id resolved to its outreach lead.
  const ids = match.startsWith('CE-') ? [match, match.slice(3)] : [match];
  for (const id of ids) {
    const result = await getLeadById(id);
    if (!result || result.ok !== true) {
      throw new Error(`[outreach-read] Supabase is canonical and unreadable (${(result && result.reason) || 'no response'}); `
        + 'refusing to decide a send from a lagging Sheets mirror');
    }
    if (result.lead) return { ...result.lead, first: firstName(result.lead) };
  }
  return null;
}

/** The loadFreshState dependency guardProviderSend expects. */
function createFreshSendStateLoader({ loadSnapshot, readSheetLeads, getLeadById, suppressedFrom }) {
  return async function loadFreshState(leadId) {
    const snapshot = await loadSnapshot();
    const current = await freshLeadFromSnapshot({ snapshot, leadId, readSheetLeads, getLeadById });
    return { current, suppressedEmails: suppressedFrom(snapshot) };
  };
}

module.exports = { freshLeadFromSnapshot, createFreshSendStateLoader };
