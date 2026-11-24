'use strict';
// ScaleLab sample employer list: the effectful steps, all dependency-injected.
//  - draftSampleListForAction: after the routing step committed the cold hold
//    and the human task, build the list (fresh), create a Gmail DRAFT in the
//    same thread, log it, add a dashboard task and push the owner.
//  - autoSendReadyDrafts: OFF unless SCALELAB_SAMPLE_LIST_AUTOSEND=true; even
//    then it only hands the draft to the hardened warm-reply delivery (final
//    gate, reservation). It never sends on its own.
//  - recordSentAndOutcomes: drafted -> sent -> call_booked / declined / no_reply.
//  - restockSampleEmployers: weekly, one GetLeads call at a time.
const { randomUUID } = require('node:crypto');
const {
  INTENT, buildSampleList, renderSampleListBody, summarizePostings, autoSendDecision, sampleListOutcome,
  STATE_NAMES, AUTOSEND_DELAY_MS, MIN_OPEN_ROLES,
} = require('./scalelab-sample-list');

const TASK_EVENT = 'scalelab_sample_list_drafted';
const CLAIM_STALE_MS = 15 * 60 * 1000;
const REQUEST_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const PERMANENT_TAGS = ['[REPLY: Unsubscribed]', '[REPLY: Not Interested]', '[BOUNCED', '[ARCHIVED'];
const NEGATIVE_SIGNAL = /\b(?:not interested|unsubscribe|remove (?:me|us)|stop (?:emailing|sending)|no thanks)\b/i;

function sampleListConfig(env = process.env) {
  return {
    enabled: env.SCALELAB_SAMPLE_LIST_ENABLED === 'true',
    autosend: env.SCALELAB_SAMPLE_LIST_AUTOSEND === 'true',
    restock: env.SCALELAB_SAMPLE_LIST_RESTOCK_ENABLED === 'true',
  };
}

const eventIds = actionId => ({
  draft: `sample-list:draft:${actionId}`, review: `sample-list:review:${actionId}`,
  sent: `sample-list:sent:${actionId}`, autosend: `sample-list:autosend:${actionId}`,
  outcome: `sample-list:outcome:${actionId}`,
});

function parseNotes(lead) {
  try { return String(lead.campaign_notes || '').trim().startsWith('{') ? JSON.parse(lead.campaign_notes) : {}; }
  catch (_) { return {}; }
}

function greetingFor(lead) {
  const notes = parseNotes(lead);
  const first = notes.var_first_name || notes.first_name || String(lead.contactName || lead.contact_name || '').trim().split(/\s+/)[0] || '';
  const company = notes.var_company || lead.company || '';
  return { firstName: first, company };
}

// The routing hold is expected. Opt-out, bounce, archive or the global
// Suppression list stop the draft and go to the owner.
function draftBlockReason(lead, suppressedEmails = new Set()) {
  const notes = String(lead?.notes || '');
  const tag = PERMANENT_TAGS.find(item => notes.includes(item));
  if (tag) return `lead_suppressed:${tag}`;
  if (suppressedEmails.has(String(lead?.email || '').trim().toLowerCase())) return 'lead_suppressed:list';
  return null;
}

function agencyDomain(lead) {
  const notes = parseNotes(lead);
  const fromNotes = String(notes.company_domain || '').trim().toLowerCase();
  if (fromNotes) return fromNotes;
  const email = String(lead.email || '').trim().toLowerCase();
  return email.includes('@') ? email.split('@')[1] : '';
}

// Backfilled HQ/branch states by agency domain. A failed read keeps the lead
// record's own fields; it never blocks the draft.
async function withAgencyStates(store, lead, log = () => {}) {
  if (typeof store.getAgencyStates !== 'function') return lead;
  try {
    const states = await store.getAgencyStates(agencyDomain(lead));
    return states.length ? { ...lead, agency_states: states } : lead;
  } catch (error) {
    log(`agency state lookup failed: ${error.message}`);
    return lead;
  }
}

const reSubject = subject => (/^re:/i.test(String(subject || '').trim()) ? String(subject).trim() : `Re: ${String(subject || '').trim()}`);

function makeRecheck(jobsClient, now) {
  return async employer => {
    const result = await jobsClient.searchCompanyJobs(employer.domain, { now });
    return summarizePostings(result.data, { now, state: employer.state });
  };
}

async function persistChecks(store, updates, log) {
  for (const update of updates) {
    try { await store.recordCheck(update); } catch (error) { log(`check not saved for ${update.domain}: ${error.message}`); }
  }
}

async function toReview({ store, ids, action, reason, detail = {}, notify, lead, now }) {
  const row = await store.logEvent({ kind: 'review', eventId: ids.review, actionId: action.id, leadId: action.leadId,
    messageId: action.messageId, mailboxId: action.mailboxId, detail: { reason, ...detail }, occurredAt: now.toISOString() });
  await notify({ title: 'Sample list needs you',
    message: `${lead?.company || 'A prospect'} asked for the sample employer list. Not drafted: ${reason}.` });
  return { status: 'review', reason, row };
}

/**
 * action: { id, leadId, messageId, mailboxId, step, verdict }   (routing record)
 * inbound: { threadId, subject, rfcMessageId, text }            (the prospect's message)
 * deps: { store, recheck, createDraft, publishTask, notify, appendFooter, log }
 */
async function draftSampleListForAction({ action, inbound, lead, suppressedEmails, now = new Date(), deps }) {
  const { store, recheck, createDraft, publishTask, notify, appendFooter, log = () => {} } = deps;
  if (action?.verdict?.intent !== INTENT || action.step !== 'complete') return { status: 'skipped', reason: 'not_routed' };
  if (!lead || lead.id !== action.leadId || !inbound?.threadId) return { status: 'skipped', reason: 'identity_unavailable' };
  const ids = eventIds(action.id);
  const prior = await store.getEvent(ids.draft);
  if (prior) {
    const claimedAt = Date.parse(prior.occurred_at);
    if (!prior.gmail_draft_id && prior.detail?.status === 'claimed' && now.getTime() - claimedAt > CLAIM_STALE_MS
        && !(await store.getEvent(ids.review))) {
      // A worker may have created the draft and crashed before saving its id.
      // Never draft twice on uncertainty: the owner checks the thread.
      return toReview({ store, ids, action, reason: 'draft_outcome_unconfirmed', notify, lead, now });
    }
    return { status: 'existing', row: prior };
  }
  if (await store.getEvent(ids.review)) return { status: 'existing', reason: 'already_in_review' };
  // A request routed before the feature was switched on, or long ago, is the
  // owner's call: a list drafted days later would read as stale.
  const receivedAt = Date.parse(action.receivedAt || '');
  if (!Number.isFinite(receivedAt) || now.getTime() - receivedAt > REQUEST_MAX_AGE_MS) {
    return toReview({ store, ids, action, reason: 'request_too_old', notify, lead, now });
  }
  const blocked = draftBlockReason(lead, suppressedEmails);
  if (blocked) return toReview({ store, ids, action, reason: blocked, notify, lead, now });

  const list = await buildSampleList({ employers: await store.listHiring(), lead: await withAgencyStates(store, lead, log), now, recheck });
  await persistChecks(store, list.updates, log);
  if (list.status !== 'ready') return toReview({ store, ids, action, reason: list.reason, detail: { getleads: list.detail || null }, notify, lead, now });

  const { firstName, company } = greetingFor(lead);
  const body = appendFooter(renderSampleListBody({ firstName, company, market: list.market, employers: list.employers }));
  const claimId = randomUUID();
  const summary = { count: list.employers.length, scope: list.scope, state: list.state, market: list.market,
    usedStoredFallback: list.usedStoredFallback, agencyStateKnown: Boolean(list.state) };
  const claim = await store.logEvent({ kind: 'drafted', eventId: ids.draft, actionId: action.id, leadId: action.leadId,
    messageId: action.messageId, threadId: inbound.threadId, mailboxId: action.mailboxId, market: list.market,
    scope: list.scope, state: list.state, employerDomains: list.employers.map(item => item.domain),
    detail: { status: 'claimed', claimId, ...summary, verdict: { intent: action.verdict.intent,
      confidence: action.verdict.confidence, reason: action.verdict.reason },
    negativeSignal: NEGATIVE_SIGNAL.test(String(inbound.text || '')) }, occurredAt: now.toISOString() });
  if (claim?.detail?.claimId !== claimId) return { status: 'existing', row: claim };

  const draft = await createDraft({ lead, inbound, mailboxId: action.mailboxId, subject: reSubject(inbound.subject), body });
  if (!draft?.id) throw new Error('Gmail draft id missing');
  const row = await store.updateEvent(ids.draft, { gmail_draft_id: draft.id,
    detail: { ...claim.detail, status: 'ready', draftedAt: now.toISOString() } });
  await publishTask({ eventId: `scalelab-sample-list-task:${action.id}`, eventType: TASK_EVENT,
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company, occurredAt: now.toISOString(),
    subject: 'Sample employer list drafted', content: '', metadata: JSON.stringify({ clientId: 'scalelab', owner: 'human',
      autoSendAllowed: false, routingActionId: action.id, inboundMessageId: action.messageId, gmailThreadId: inbound.threadId,
      gmailDraftId: draft.id, senderInboxId: action.mailboxId, ...summary }) });
  const where = list.state ? STATE_NAMES[list.state] : 'state unknown, national list';
  await notify({ title: 'Sample list drafted',
    message: `${company || 'Prospect'}: ${list.employers.length} employers (${where}) drafted in the Gmail thread. Review and send.` });
  return { status: 'drafted', list, body, draftId: draft.id, row };
}

/** Auto-send of ready drafts. OFF by default; when on, every gate still applies. */
async function autoSendReadyDrafts({ events, env = process.env, now = new Date(), deps }) {
  if (env.SCALELAB_SAMPLE_LIST_AUTOSEND !== 'true') return [];
  const done = new Set(events.filter(row => ['sent', 'autosend_refused'].includes(row.kind)).map(row => row.action_id));
  const results = [];
  for (const row of events.filter(item => item.kind === 'drafted' && item.detail?.status === 'ready' && !done.has(item.action_id))) {
    const decision = autoSendDecision({ env, now, draftedAt: row.detail.draftedAt,
      verdict: { intent: row.detail.verdict?.intent, confidence: row.detail.verdict?.confidence },
      list: { status: 'ready', usedStoredFallback: row.detail.usedStoredFallback, state: row.state, scope: row.scope },
      replyText: row.detail.negativeSignal ? 'not interested' : '' });
    if (decision.reason === 'delay_pending') continue;
    const ids = eventIds(row.action_id);
    if (!decision.send) {
      results.push(await deps.store.logEvent({ kind: 'autosend_refused', eventId: ids.autosend, actionId: row.action_id,
        leadId: row.lead_id, detail: { reason: decision.reason }, occurredAt: now.toISOString() }));
      continue;
    }
    // The hardened warm-reply delivery applies the final fresh gate (hold,
    // suppression, booking, ownership), the reservation and thread checks.
    const delivered = await deps.deliver(row);
    if (delivered?.delivered) {
      results.push(await deps.store.logEvent({ kind: 'sent', eventId: ids.sent, actionId: row.action_id, leadId: row.lead_id,
        threadId: row.thread_id, detail: { source: 'autosend', sentAt: now.toISOString() }, occurredAt: now.toISOString() }));
      // Production code never deletes Gmail drafts; the owner discards it.
      await deps.notify?.({ title: 'Sample list auto-sent',
        message: 'A sample list was sent automatically. Discard the leftover draft in that Gmail thread.' });
    } else {
      results.push(await deps.store.logEvent({ kind: 'autosend_refused', eventId: ids.autosend, actionId: row.action_id,
        leadId: row.lead_id, detail: { reason: delivered?.code || delivered?.reason || 'delivery_refused' }, occurredAt: now.toISOString() }));
    }
  }
  return results;
}

const metaOf = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };

/** Owner sends are observed as human_response_sent in the same thread. */
async function recordSentAndOutcomes({ events, activities, store, now = new Date() }) {
  const byKind = kind => new Map(events.filter(row => row.kind === kind).map(row => [row.action_id, row]));
  const sent = byKind('sent');
  const outcomes = byKind('outcome');
  const written = [];
  for (const draft of events.filter(row => row.kind === 'drafted' && row.detail?.status === 'ready')) {
    const ids = eventIds(draft.action_id);
    let sentRow = sent.get(draft.action_id);
    if (!sentRow) {
      const draftedAt = Date.parse(draft.detail.draftedAt || draft.occurred_at);
      const ours = activities.filter(row => row.sourceLeadId === draft.lead_id
        && ['human_response_sent', 'booking_link_sent'].includes(row.eventType)
        && Date.parse(row.occurredAt) >= draftedAt
        && (!draft.thread_id || metaOf(row).gmailThreadId === draft.thread_id))
        .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))[0];
      if (!ours) continue;
      sentRow = await store.logEvent({ kind: 'sent', eventId: ids.sent, actionId: draft.action_id, leadId: draft.lead_id,
        threadId: draft.thread_id, detail: { source: 'owner', sentAt: ours.occurredAt, activityEventId: ours.eventId },
        occurredAt: ours.occurredAt });
      written.push(sentRow);
    }
    if (outcomes.has(draft.action_id)) continue;
    const sentAt = sentRow.detail?.sentAt || sentRow.occurred_at;
    const outcome = sampleListOutcome({ sentAt, activities, leadId: draft.lead_id, now });
    const settled = outcome === 'call_booked' || outcome === 'declined' || outcome === 'no_reply'
      || (outcome === 'replied' && now.getTime() - Date.parse(sentAt) >= 30 * DAY_MS);
    if (!settled) continue;
    written.push(await store.logEvent({ kind: 'outcome', eventId: ids.outcome, actionId: draft.action_id,
      leadId: draft.lead_id, outcome, detail: { sentAt }, occurredAt: now.toISOString() }));
  }
  return written;
}

/**
 * Weekly restock: re-check hiring rows older than 7 days, then top up each
 * state to `perState` still-hiring employers with 2+ open roles from unchecked (or long-ago
 * not-hiring) pool rows. One GetLeads call at a time; bounded by maxChecks.
 */
async function restockSampleEmployers({ store, recheck, now = new Date(), perState = 10, maxChecks = 300, log = () => {} }) {
  const pool = await store.listPool();
  const age = row => (row.checkedAt ? (now.getTime() - Date.parse(row.checkedAt)) / DAY_MS : Infinity);
  const byState = new Map();
  for (const row of pool) byState.set(row.state, [...(byState.get(row.state) || []), row]);
  const summary = { checks: 0, nowHiring: 0, dropped: 0, failures: 0, states: {} };
  const check = async row => {
    if (summary.checks >= maxChecks) return null;
    summary.checks += 1;
    try {
      const result = await recheck(row);
      const saved = await store.recordCheck({ domain: row.domain, checkedAt: now.toISOString(), ...result });
      if (result.hiring) summary.nowHiring += 1; else summary.dropped += 1;
      return saved;
    } catch (error) {
      summary.failures += 1;
      log(`restock check failed for ${row.domain}: ${error.code || error.message}`);
      if (error.code === 'getleads_unconfigured') throw error;
      return null;
    }
  };
  // Fewest still-hiring employers first, so a capped run fills the gaps.
  const order = [...byState.keys()].sort((a, b) =>
    byState.get(a).filter(r => r.status === 'hiring').length - byState.get(b).filter(r => r.status === 'hiring').length);
  for (const state of order) {
    const rows = byState.get(state);
    const current = new Map(rows.map(row => [row.domain, row]));
    for (const row of rows.filter(r => r.status === 'hiring' && age(r) > 7)) {
      const saved = await check(row);
      if (saved) current.set(row.domain, saved);
    }
    const listable = row => row?.status === 'hiring' && Number(row.openRoles) >= MIN_OPEN_ROLES;
    let hiring = [...current.values()].filter(r => listable(r) && age(r) <= 7).length;
    const candidates = rows.filter(r => r.status === 'unchecked' || (r.status === 'not_hiring' && age(r) > 30))
      .sort((a, b) => (a.status === 'unchecked' ? 0 : 1) - (b.status === 'unchecked' ? 0 : 1) || a.domain.localeCompare(b.domain));
    for (const row of candidates) {
      if (hiring >= perState || summary.checks >= maxChecks) break;
      const saved = await check(row);
      if (listable(saved)) hiring += 1;
    }
    summary.states[state] = hiring;
    if (summary.checks >= maxChecks) break;
  }
  return summary;
}

module.exports = { TASK_EVENT, CLAIM_STALE_MS, AUTOSEND_DELAY_MS, sampleListConfig, eventIds, greetingFor,
  draftBlockReason, reSubject, makeRecheck, agencyDomain, withAgencyStates, draftSampleListForAction, autoSendReadyDrafts, recordSentAndOutcomes,
  restockSampleEmployers };
