'use strict';

const { deterministicReplyCategory } = require('./reply-classifier');

const ANALYTICS_CATEGORY = Object.freeze({
  POSITIVE: 'positive', NEGATIVE: 'negative', NEEDS_HUMAN: 'needs_human',
  UNCLASSIFIED: 'unclassified', EXCLUDED: 'excluded',
});

function normalizedCategoryKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

// Canonical reply categories and known historical aliases converge here.
// This is analytics normalization only: it never changes suppression or routing.
function analyticsCategoryFor(value) {
  const key = normalizedCategoryKey(value);
  if (!key || ['REPLIED', 'REPLY', 'UNKNOWN', 'UNCLASSIFIED'].includes(key)) return ANALYTICS_CATEGORY.UNCLASSIFIED;
  if (/^(?:INTERESTED|MEETING_REQUEST(?:ED)?|POSITIVE|QUALIFIED|REPLIED_POSITIVE)$/.test(key)) return ANALYTICS_CATEGORY.POSITIVE;
  if (/^(?:NOT_INTERESTED|NEGATIVE|UNSUBSCRIBE(?:D)?|DECLINED?|WRONG_FIT|ALREADY_SOLVED)$/.test(key)) return ANALYTICS_CATEGORY.NEGATIVE;
  if (/^(?:QUESTION|NEEDS_HUMAN|NEUTRAL|AMBIGUOUS|WRONG_PERSON|INFORMATION_REQUEST)$/.test(key)) return ANALYTICS_CATEGORY.NEEDS_HUMAN;
  if (/^(?:OUT_OF_OFFICE|OOO|AUTOMATED|AUTO_REPLY)$/.test(key)) return ANALYTICS_CATEGORY.EXCLUDED;
  return ANALYTICS_CATEGORY.UNCLASSIFIED;
}

function categoryFromNoteLabel(label) {
  return analyticsCategoryFor(String(label || '').split(/[—|]/)[0].trim());
}

function categoriesFromNotes(notes) {
  const values = [];
  for (const match of String(notes || '').matchAll(/\[(?:REPLY|ROOFING_SURVEY):\s*([^\]]+)\]/gi)) {
    values.push(categoryFromNoteLabel(match[1]));
  }
  return values;
}

// Preserves the existing Outreach definition: one ColdEmail row counts once
// when emailStatus is replied or it carries a human-reply tag. OOO alone does
// not count as a reply.
function leadHasReply(lead = {}) {
  const labels = [...String(lead.notes || '').matchAll(/\[REPLY:\s*([^\]]+)\]/gi)];
  const hasHumanReplyTag = labels.some(match => categoryFromNoteLabel(match[1]) !== ANALYTICS_CATEGORY.EXCLUDED);
  return hasHumanReplyTag || String(lead.emailStatus || '').trim().toLowerCase() === 'replied';
}

function classificationFromLead(lead = {}, storedClassifications = []) {
  for (const category of categoriesFromNotes(lead.notes)) {
    if (category !== ANALYTICS_CATEGORY.EXCLUDED && category !== ANALYTICS_CATEGORY.UNCLASSIFIED) return category;
  }
  for (const value of storedClassifications || []) {
    const category = analyticsCategoryFor(value);
    if (category !== ANALYTICS_CATEGORY.EXCLUDED && category !== ANALYTICS_CATEGORY.UNCLASSIFIED) return category;
  }
  if (/^unsub(?:scribed)?$/i.test(String(lead.stage || '').trim())) return ANALYTICS_CATEGORY.NEGATIVE;
  return ANALYTICS_CATEGORY.UNCLASSIFIED;
}

function buildReplyMetrics(leads = [], { classificationsByLeadId = new Map() } = {}) {
  const metrics = {
    totalReplies: 0, positive: 0, negative: 0, needsHuman: 0, unclassified: 0,
    contacted: 0, delivered: 0, positiveReplyRate: 0,
  };
  const seen = new Set();
  for (const lead of leads || []) {
    const id = String(lead.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contacted = Boolean(String(lead.emailStatus || '').trim());
    if (contacted) metrics.contacted++;
    if (contacted && !/\[BOUNCED/i.test(String(lead.notes || ''))) metrics.delivered++;
    if (!leadHasReply(lead)) continue;
    metrics.totalReplies++;
    const category = classificationFromLead(lead, classificationsByLeadId.get(id) || []);
    if (category === ANALYTICS_CATEGORY.POSITIVE) metrics.positive++;
    else if (category === ANALYTICS_CATEGORY.NEGATIVE) metrics.negative++;
    else if (category === ANALYTICS_CATEGORY.NEEDS_HUMAN) metrics.needsHuman++;
    else metrics.unclassified++;
  }
  metrics.positiveReplyRate = metrics.delivered ? metrics.positive / metrics.delivered * 100 : 0;
  metrics.reconciles = metrics.totalReplies === metrics.positive + metrics.negative + metrics.needsHuman + metrics.unclassified;
  return metrics;
}

function addStoredClassification(map, leadId, classification, occurredAt = '') {
  const id = String(leadId || '').replace(/^CE-/, '').trim();
  if (!id || !classification) return;
  const rows = map.get(id) || [];
  rows.push({ classification, occurredAt: String(occurredAt || '') });
  rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  map.set(id, rows);
}

function buildStoredClassificationMap({ drafts = [], activities = [], providerMappings = [] } = {}) {
  const withTimes = new Map();
  for (const row of drafts) addStoredClassification(withTimes, row.leadId, row.classification, row.createdAt);
  for (const row of activities) {
    let classification = '';
    if (row.eventType === 'positive_reply') classification = 'INTERESTED';
    else if (row.eventType === 'meeting_requested') classification = 'MEETING_REQUEST';
    else {
      try { classification = JSON.parse(row.metadata || '{}').classification || ''; } catch (_) { classification = ''; }
    }
    addStoredClassification(withTimes, row.sourceLeadId || row.leadId, classification, row.occurredAt);
  }
  for (const row of providerMappings) addStoredClassification(withTimes, row.internalLeadId, row.normalizedStatus, row.lastProviderEventAt);
  return new Map([...withTimes].map(([id, rows]) => [id, rows.map(row => row.classification)]));
}

// Safe historical planner: deterministic rules only, no model/API call and no
// writes. applyBackfillPlan requires an explicit metadata-only writer.
function planReplyBackfill(records = []) {
  const seen = new Set();
  const plan = { ready: [], alreadyClassified: 0, noText: 0, requiresExternalClassification: 0, duplicates: 0 };
  for (const record of records || []) {
    const key = String(record.replyId || record.id || `${record.leadId || ''}|${record.occurredAt || ''}`).trim();
    if (!key || seen.has(key)) { plan.duplicates++; continue; }
    seen.add(key);
    if (analyticsCategoryFor(record.classification) !== ANALYTICS_CATEGORY.UNCLASSIFIED) { plan.alreadyClassified++; continue; }
    const text = String(record.replyText || '').trim();
    if (!text) { plan.noText++; continue; }
    const classification = deterministicReplyCategory(text);
    if (!classification) { plan.requiresExternalClassification++; continue; }
    plan.ready.push({ key, leadId: String(record.leadId || ''), classification, occurredAt: String(record.occurredAt || '') });
  }
  return plan;
}

async function applyBackfillPlan(plan, { existingKeys = new Set(), writeClassification } = {}) {
  if (typeof writeClassification !== 'function') throw new Error('classification metadata writer is required');
  let written = 0;
  for (const item of plan?.ready || []) {
    if (existingKeys.has(item.key)) continue;
    await writeClassification(item);
    existingKeys.add(item.key);
    written++;
  }
  return { written, skipped: (plan?.ready || []).length - written };
}

module.exports = {
  ANALYTICS_CATEGORY, analyticsCategoryFor, categoriesFromNotes, leadHasReply,
  classificationFromLead, buildReplyMetrics, buildStoredClassificationMap,
  planReplyBackfill, applyBackfillPlan,
};
