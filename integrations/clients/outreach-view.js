'use strict';

// Build every shared Outreach response from one server-side client projection.
// A missing client query is resolved to ScaleLab by the route, never all tenants.
const { leadsForClient, resolveSenderClient } = require('./ownership');
const { buildReplyMetrics, buildReplyEvidenceMap } = require('../reply-analytics');
const { canonicalSendRows, uniqueCanonicalBounces } = require('../canonical-sends');

const leadId = row => String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '').trim();
const key = value => String(value || '').trim().toLowerCase();
// Match the proposal-link company key: punctuation and the displayed suffix
// never make two tenants with the same employer look like separate owners.
const companyKey = value => key(value).split(/\s(?:-|•|·|–|—)\s|\|/)[0].replace(/[^a-z0-9]/g, '');
const day = (value, timezone) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', { timeZone: timezone }) : '';
};
const count = (rows, field) => rows.reduce((out, row) => {
  const value = String(row[field] || '').trim();
  if (value) out[value] = (out[value] || 0) + 1;
  return out;
}, {});

function clientOutreachView(dataset, clientId, senders = [], timezone = 'America/Vancouver') {
  const leads = leadsForClient(dataset.leads || [], clientId);
  const ids = new Set(leads.map(row => String(row.id)));
  const rows = (dataset.rows || []).filter(row => ids.has(String(row.id)));
  const activeIds = new Set(rows.map(row => String(row.id)));
  const archivedRows = (dataset.archivedRows || []).filter(row => ids.has(String(row.id)));
  const activities = (dataset.activities || []).filter(row => ids.has(leadId(row)));
  const activeActivities = activities.filter(row => activeIds.has(leadId(row)));
  const replyRecords = (dataset.replyRecords || []).filter(row => ids.has(String(row.leadId)));
  const classificationsByLeadId = new Map([...(dataset.classificationsByLeadId || new Map())]
    .filter(([id]) => ids.has(String(id))));
  const activitiesByLeadId = new Map();
  for (const row of activeActivities) {
    const id = leadId(row);
    activitiesByLeadId.set(id, [...(activitiesByLeadId.get(id) || []), row]);
  }
  const historicalActivitiesByLeadId = new Map();
  for (const row of activities) {
    const id = leadId(row);
    historicalActivitiesByLeadId.set(id, [...(historicalActivitiesByLeadId.get(id) || []), row]);
  }
  const metrics = buildReplyMetrics(leads.filter(lead => activeIds.has(String(lead.id))), {
    classificationsByLeadId, evidenceByLeadId: buildReplyEvidenceMap(activeActivities), activitiesByLeadId,
  });
  const confirmed = canonicalSendRows(activeActivities).confirmed;
  const sendDays = count(confirmed.map(row => ({ date: day(row.occurredAt, timezone) })), 'date');
  const sendActivity = Object.entries(sendDays).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, count: amount }));
  const senderRows = senders.filter(sender => {
    const owner = resolveSenderClient(sender);
    return owner.ok && owner.clientId === clientId;
  });
  const senderIds = new Set(senderRows.map(row => row.id));
  const historicalSendDays = count(canonicalSendRows(activities).confirmed
    .map(row => ({ date: day(row.occurredAt, timezone) })), 'date');
  const historicalSendActivity = Object.entries(historicalSendDays).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, count: amount }));
  const facets = {
    stages: count(rows.map(row => ({ stage: row.stage || 'Import' })), 'stage'),
    niches: count(rows.map(row => {
      const raw = key(row.leadNiche || row.tradeType);
      return { niche: raw.includes('roof') ? 'roofing' : raw.includes('staffing') ? 'industrial_staffing'
        : raw.includes('dent') ? 'dental' : raw };
    }), 'niche'),
    campaigns: count(rows.map(row => ({ campaign: row.campaign || 'Unlabeled' })), 'campaign'),
    campaignVersions: count(rows, 'campaignVersion'),
    senders: count(rows.map(row => ({ sender: ['unknown', 'conflict'].includes(row.senderState)
      ? row.senderState : row.senderInboxId })), 'sender'),
  };
  const counts = {
    queued: rows.filter(row => row.stage === 'Queued').length,
    emailed: rows.filter(row => row.emailStatus).length,
    replied: metrics.totalReplies,
    done: rows.filter(row => row.emailStatus === 'done').length,
    total: rows.length,
    archived: archivedRows.length + (clientId === 'scalelab' ? (dataset.archivedBoardLeads || [])
      .filter(card => !archivedRows.some(row => card.id === `CE-${row.id}`
        || (key(card.email) && key(card.email) === key(row.email)))).length : 0),
  };
  const outside = rows.filter(row => !row.pipelinePresence && row.mappingStatus !== 'conflict');
  const pipelineAudit = {
    total: rows.length, inPipeline: rows.filter(row => row.pipelinePresence).length,
    notInPipeline: outside.length,
    positiveNotInPipeline: outside.filter(row => row.replyCategory === 'positive').length,
    needsHumanNotInPipeline: outside.filter(row => row.replyCategory === 'needs_human').length,
    sequenceCompleteNotInPipeline: outside.filter(row => row.sequenceState === 'complete').length,
    activeSequenceNotInPipeline: outside.filter(row => ['active', 'queued'].includes(row.sequenceState)).length,
    ambiguousMappings: rows.filter(row => row.mappingStatus === 'conflict').length,
  };
  // Open events without a lead id are shown only when the company resolves to
  // exactly one client's lead. Colliding company names fail closed.
  const companyOwners = new Map();
  for (const lead of dataset.leads || []) {
    const company = companyKey(lead.company);
    if (!company) continue;
    if (!companyOwners.has(company)) companyOwners.set(company, new Set());
    if (activeIds.has(String(lead.id))) companyOwners.get(company).add(clientId);
    else companyOwners.get(company).add('other');
  }
  const opens = (dataset.annotatedOpens || []).filter(row => row.id
    ? activeIds.has(String(row.id))
    : companyOwners.get(companyKey(row.company))?.size === 1 && companyOwners.get(companyKey(row.company)).has(clientId));
  const real = opens.filter(row => row.real !== false);
  const signals = { opens: new Set(real.map(row => companyKey(row.company)).filter(Boolean)).size, hits: real.length };
  return { clientId, leads, rows, archivedRows, activities, activeActivities, replyRecords, metrics, counts, facets,
    sendActivity, pipelineAudit, senderRows, senderIds, opens, signals,
    historicalMetrics: buildReplyMetrics(leads, { classificationsByLeadId,
      evidenceByLeadId: buildReplyEvidenceMap(activities), activitiesByLeadId: historicalActivitiesByLeadId }),
    historicalSendActivity,
    bounces: uniqueCanonicalBounces({ leads, activities }),
  };
}

module.exports = { clientOutreachView };
