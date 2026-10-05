'use strict';

// Which ColdCallActivity rows belong to a ColdEmail lead. Rows written with a
// sourceLeadId are matched on it; older rows carry only the CE-<id> key. One
// definition, shared by sender ownership and sequence timing, so "this lead's
// history" cannot mean two different row sets.
function activityBelongsToLead(row, lead) {
  if (!String(lead.id || '').trim()) return false;
  if (row.sourceLeadId) return String(row.sourceLeadId) === String(lead.id);
  return String(row.leadId || '') === `CE-${lead.id}`;
}

/** The ColdEmail lead id a row belongs to, or '' when it names none. */
function activityLeadKey(row) {
  if (row.sourceLeadId) return String(row.sourceLeadId);
  const leadId = String(row.leadId || '');
  return leadId.startsWith('CE-') ? leadId.slice(3) : '';
}

module.exports = { activityBelongsToLead, activityLeadKey };
