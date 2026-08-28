'use strict';

const { deterministicReplyCategory } = require('./reply-classifier');
const { resolveReplyState, EVIDENCE_SOURCE } = require('./canonical-reply');

const ANALYTICS_CATEGORY = Object.freeze({
  POSITIVE: 'positive', NEGATIVE: 'negative', NEEDS_HUMAN: 'needs_human',
  UNCLASSIFIED: 'unclassified', EXCLUDED: 'excluded',
  // Distinct from UNCLASSIFIED. "Unclassified" means a message arrived that we
  // could not categorise; UNKNOWN means we have no trustworthy evidence a reply
  // happened at all. Collapsing the two is what allowed a CRM stage to be read
  // as sentiment.
  UNKNOWN: 'unknown',
  // Canonical non-human states, so a reconciled autoresponder or mailbox
  // migration keeps its meaning instead of collapsing into "excluded".
  AUTOMATED_REPLY: 'automated_reply',
  CONTACT_CHANGE_REVIEW: 'contact_change_review',
});

// Canonical reply state -> analytics category. One mapping, used wherever
// provider-backed evidence exists.
const CANONICAL_STATE_CATEGORY = Object.freeze({
  positive: 'positive', negative: 'negative', needs_human: 'needs_human',
  automated_reply: 'automated_reply', contact_change_review: 'contact_change_review',
  unknown: 'unknown',
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

/**
 * A lead's reply category, from EVIDENCE ONLY.
 *
 * A reply tag and a stored classification are both records of a real inbound
 * message. A CRM stage is not: it records what someone did to a spreadsheet
 * row. This function used to fall back to `stage === 'Unsubscribed'` and return
 * NEGATIVE, which is how two production leads with no tag, no stored
 * classification and no activity are labelled Negative today. That fallback is
 * gone; the honest answer when nothing is known is UNKNOWN.
 */
/**
 * The canonical hierarchy, applied for real.
 *
 * `classificationFromLead` below reads legacy tags and stored classifications.
 * That was the whole story until historical reconciliation started writing
 * provider-backed evidence — at which point reading the tag first would mean
 * the recovered Gmail evidence changed nothing anyone could see. Verified
 * inbound activity therefore outranks a legacy tag here, exactly as
 * canonical-reply documents, and the tag remains the fallback beneath it.
 */
function categoryFromEvidence(lead = {}, activities = [], storedClassifications = []) {
  const resolved = resolveReplyState(lead, { activities });
  if (resolved.source === EVIDENCE_SOURCE.CANONICAL_ACTIVITY) {
    return CANONICAL_STATE_CATEGORY[resolved.state] || ANALYTICS_CATEGORY.UNKNOWN;
  }
  return classificationFromLead(lead, storedClassifications);
}

function classificationFromLead(lead = {}, storedClassifications = []) {
  // NOTE: a malformed address is NOT filtered here. A stored tag is still a
  // record that a message was once processed, whatever the address looks like.
  // Malformed identity is enforced where it actually matters — matching new
  // inbound mail — in canonical-reply.resolveReplyState.
  for (const category of categoriesFromNotes(lead.notes)) {
    if (category !== ANALYTICS_CATEGORY.EXCLUDED && category !== ANALYTICS_CATEGORY.UNCLASSIFIED) return category;
  }
  for (const value of storedClassifications || []) {
    const category = analyticsCategoryFor(value);
    if (category !== ANALYTICS_CATEGORY.EXCLUDED && category !== ANALYTICS_CATEGORY.UNCLASSIFIED) return category;
  }
  // The distinction that matters. A tag or stored classification means a real
  // message was processed, even if we cannot categorise it -> UNCLASSIFIED.
  // Nothing at all means we have no evidence a message ever arrived -> UNKNOWN.
  // Only the second case used to be filled in from the lead's CRM stage.
  const sawSomeEvidence = String(lead.notes || '').match(/\[(?:REPLY|ROOFING_SURVEY):/i)
    || (storedClassifications || []).length > 0;
  return sawSomeEvidence ? ANALYTICS_CATEGORY.UNCLASSIFIED : ANALYTICS_CATEGORY.UNKNOWN;
}

// Canonical reply evidence. Reply bodies live in the activity sheet; many
// replies (negatives, unsubscribes) never stored text, so `hasText` is an
// explicit signal rather than an empty string the UI has to guess about.
const REPLY_EVIDENCE_TYPES = new Set([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply',
  'needs_human_reply', 'out_of_office_reply',
]);

function buildReplyEvidenceMap(activities = []) {
  const byLead = new Map();
  for (const row of activities || []) {
    const eventType = String(row.eventType || '');
    if (!REPLY_EVIDENCE_TYPES.has(eventType)) continue;
    const id = String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '').trim();
    if (!id) continue;
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch (_) { metadata = {}; }
    const rows = byLead.get(id) || [];
    rows.push({
      eventId: String(row.eventId || ''),
      eventType,
      occurredAt: String(row.occurredAt || ''),
      subject: String(row.subject || ''),
      text: String(row.content || '').trim(),
      late: eventType === 'late_reply' || metadata.detectedAfterSequence === true,
      classification: String(metadata.classification || ''),
    });
    byLead.set(id, rows);
  }
  for (const rows of byLead.values()) rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return byLead;
}

// One row per replying lead — the same unit `buildReplyMetrics` counts. The
// latest reply represents the lead; `replyCount` reports how many were seen.
// Read-only: this derives display records and mutates nothing.
function buildReplyRecords(leads = [], { classificationsByLeadId = new Map(), evidenceByLeadId = new Map(), activitiesByLeadId = new Map() } = {}) {
  const records = [];
  const seen = new Set();
  for (const lead of leads || []) {
    const id = String(lead.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!leadHasReply(lead)) continue;
    const evidence = evidenceByLeadId.get(id) || [];
    const latest = evidence[0] || null;
    const notes = String(lead.notes || '');
    records.push({
      leadId: id,
      category: categoryFromEvidence(lead, activitiesByLeadId.get(id) || [], classificationsByLeadId.get(id) || []),
      company: String(lead.company || ''),
      contactName: String(lead.contactName || ''),
      email: String(lead.email || ''),
      stage: String(lead.stage || ''),
      emailStatus: String(lead.emailStatus || ''),
      replyText: latest ? latest.text : '',
      hasText: Boolean(latest && latest.text),
      replySubject: latest ? latest.subject : '',
      // Falls back to the lead's own send timestamp so a reply without stored
      // activity still sorts sensibly instead of sinking to the bottom.
      occurredAt: (latest && latest.occurredAt) || String(lead.lastEmailedAt || ''),
      replyCount: evidence.length,
      late: evidence.some(row => row.late) || /\[LATE REPLY:/i.test(notes),
      campaign: String(lead.campaign || ''),
    });
  }
  records.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)) || a.company.localeCompare(b.company));
  return records;
}

const CATEGORY_METRIC_KEY = Object.freeze({
  [ANALYTICS_CATEGORY.POSITIVE]: 'positive',
  [ANALYTICS_CATEGORY.NEGATIVE]: 'negative',
  [ANALYTICS_CATEGORY.NEEDS_HUMAN]: 'needsHuman',
  [ANALYTICS_CATEGORY.UNCLASSIFIED]: 'unclassified',
  [ANALYTICS_CATEGORY.UNKNOWN]: 'unknown',
  [ANALYTICS_CATEGORY.AUTOMATED_REPLY]: 'automatedReply',
  [ANALYTICS_CATEGORY.CONTACT_CHANGE_REVIEW]: 'contactChangeReview',
});

function filterReplyRecords(records = [], category = '') {
  const key = String(category || '').trim().toLowerCase();
  if (!key || key === 'all') return records.slice();
  return records.filter(record => record.category === key);
}

// Counts are derived from the same records the drill-down lists, so a card and
// its detail view cannot drift apart.
function buildReplyMetrics(leads = [], { classificationsByLeadId = new Map(), evidenceByLeadId = new Map() } = {}) {
  const metrics = {
    totalReplies: 0, positive: 0, negative: 0, needsHuman: 0, unclassified: 0, unknown: 0,
    automatedReply: 0, contactChangeReview: 0,
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
  }
  const records = buildReplyRecords(leads, { classificationsByLeadId, evidenceByLeadId });
  metrics.totalReplies = records.length;
  for (const record of records) metrics[CATEGORY_METRIC_KEY[record.category] || 'unclassified']++;
  metrics.positiveReplyRate = metrics.delivered ? metrics.positive / metrics.delivered * 100 : 0;
  metrics.reconciles = metrics.totalReplies
    === metrics.positive + metrics.negative + metrics.needsHuman + metrics.unclassified
      + metrics.unknown + metrics.automatedReply + metrics.contactChangeReview;
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
  buildReplyEvidenceMap, buildReplyRecords, filterReplyRecords, categoryFromEvidence,
  CANONICAL_STATE_CATEGORY,
  planReplyBackfill, applyBackfillPlan,
};
