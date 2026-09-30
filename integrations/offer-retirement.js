'use strict';

/**
 * offer-retirement.js — plan the archive of every lead of a retired offer.
 * PURE: the server loads canonical state, this decides, the server writes.
 *
 * The plan is recomputed from canonical state on every call, so running it
 * twice is safe by construction: a lead that is already archived produces no
 * plan and no event, and every write is a compare-and-set against the exact
 * state the plan was made from.
 */

const {
  retiredOfferFor, retiredOfferById, isArchivedLead, dentalSignals, roofingSignals, medSpaSignals,
  PROTECTED_RECORDS, isProtectedRecord,
  planLeadArchive, planBoardArchive, eventsForLead, archiveReasonFromNotes,
} = require('./lead-archive');
const { sendSuppressionReason } = require('./pipeline-state');
const { routedLeadReady } = require('./campaign-routing');
const { NON_COLD_STAGES } = require('./automation-ownership');

const DAY_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_DAYS = Object.freeze({ 1: 3, 2: 5 });
const SENT_EVENTS = new Set(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent', 'human_response_sent']);
const INBOUND_EVENT = /(reply|meeting_requested)/;

const text = value => (value === null || value === undefined ? '' : String(value));
const norm = value => text(value).trim().toLowerCase();

function parseMetadata(value) {
  try { return JSON.parse(text(value) || '{}'); } catch (_) { return {}; }
}

function neverSent(lead) {
  return ['', 'draft'].includes(norm(lead.emailStatus)) && !(Number(lead.emailStep) > 0) && !text(lead.lastEmailedAt).trim();
}

function followUpDueByTime(lead, now) {
  if (norm(lead.emailStatus) !== 'emailed') return false;
  if (NON_COLD_STAGES.includes(norm(lead.stage))) return false;
  const delay = FOLLOW_UP_DELAY_DAYS[Number(lead.emailStep)];
  if (!delay) return false;
  const sent = Date.parse(text(lead.lastEmailedAt));
  return Number.isFinite(sent) && now.getTime() - sent >= delay * DAY_MS;
}

/**
 * Could the CURRENT send code select this lead? The same gates the agent
 * applies before any provider call is considered: routing (which carries the
 * archive and retired-offer refusal), suppression, stage and cadence.
 */
function sendableNow(lead, { suppressedEmails = new Set(), now = new Date(), env = process.env } = {}) {
  if (!routedLeadReady(lead, env).ok) return false;
  if (sendSuppressionReason(lead, { suppressedEmails })) return false;
  if (text(lead.stage) === 'Queued' && text(lead.emailStatus) === '') return true;
  return followUpDueByTime(lead, now);
}

/**
 * Summarise one retired offer's leads and plan archiving the ones still active.
 *
 * @returns {
 *   offer, summary, leadPlans, boardPlans, cards, alreadyArchivedLeads, alreadyArchivedCards
 * }
 */
// An offer's own fields on a record, ignoring the protected-client exemption:
// used only to report which protected records the retirement would otherwise
// have reached.
const RAW_SIGNALS = Object.freeze({ dental: dentalSignals, roofing: roofingSignals, med_spa: medSpaSignals });
const companyKey = value => norm(value).replace(/[^a-z0-9]/g, '');

/**
 * Every protected client record must be present exactly once, un-archived, at
 * its recorded stage and company. Anything else means the identity is no longer
 * certain, and a migration that cannot be sure it is sparing the right record
 * must not run at all. Throws; never returns a partial verdict.
 */
function verifyProtectedRecords({ leads = [], boardLeads = [], archivedBoardLeads = [] } = {}) {
  const records = [...leads, ...boardLeads, ...archivedBoardLeads];
  return PROTECTED_RECORDS.map(record => {
    const matches = records.filter(item => text(item.id).trim() === record.id);
    if (matches.length !== 1) {
      throw new Error(`protected client ${record.client} (${record.id}) resolves to ${matches.length} records; refusing to plan`);
    }
    const [found] = matches;
    if (isArchivedLead(found)) throw new Error(`protected client ${record.client} (${record.id}) is archived; refusing to plan`);
    if (norm(found.stage) !== record.stage) {
      throw new Error(`protected client ${record.client} (${record.id}) is at stage "${found.stage}", not ${record.stage}; refusing to plan`);
    }
    if (!companyKey(found.company).includes(record.companyKey)) {
      throw new Error(`protected client ${record.client} (${record.id}) names company "${found.company}"; refusing to plan`);
    }
    return { id: record.id, client: record.client, contact: record.contact, company: found.company, stage: found.stage, verified: true };
  });
}

function planOfferRetirement({
  offerId, leads = [], activities = [], boardLeads = [], archivedBoardLeads = [],
  suppressedEmails = new Set(), unresolvedByLead = new Map(),
  archivedBy, source = 'offer_retirement', now = new Date(), stableId, env = process.env,
} = {}) {
  const offer = retiredOfferById(offerId);
  if (!offer) throw new Error(`"${offerId}" is not a retired offer`);
  // Fail closed before anything else: the protected clients must be exactly
  // where they were verified to be.
  const protectedRecords = verifyProtectedRecords({ leads, boardLeads, archivedBoardLeads });
  const offerLeads = leads.filter(lead => !isProtectedRecord(lead) && (retiredOfferFor(lead) || {}).offer === offer);
  const ids = new Set(offerLeads.map(lead => text(lead.id)));
  const emails = new Set(offerLeads.map(lead => norm(lead.email)).filter(Boolean));

  const byLead = new Map();
  for (const row of activities) {
    const key = text(row.sourceLeadId).trim() || text(row.leadId).replace(/^CE-/, '').trim();
    if (!ids.has(key)) continue;
    const bucket = byLead.get(key) || [];
    bucket.push(row);
    byLead.set(key, bucket);
  }

  // Pipeline cards that belong to this offer: a card for one of its leads (by
  // foreign key or exact email), or a board-only card whose own fields name the
  // offer. Company names are display text and never decide this.
  const cardLink = card => {
    const id = text(card.id);
    if (id.startsWith('CE-') && ids.has(id.slice(3))) return 'coldemail_id';
    if (norm(card.email) && emails.has(norm(card.email))) return 'coldemail_email';
    return '';
  };
  const cardBelongs = card => {
    if (isProtectedRecord(card)) return '';           // never planned, whatever it matches
    return cardLink(card) || ((retiredOfferFor(card) || {}).offer === offer ? 'card_fields' : '');
  };
  const allCards = [...boardLeads, ...archivedBoardLeads];
  const cards = allCards
    .map(card => ({ card, matchedBy: cardBelongs(card) }))
    .filter(item => item.matchedBy);
  // Protected records this retirement would otherwise have reached.
  const spared = allCards.filter(card => isProtectedRecord(card)
    && (cardLink(card) || RAW_SIGNALS[offer.id](card).length))
    .map(card => protectedRecords.find(record => record.id === card.id));
  const cardFor = lead => cards.find(item => text(item.card.id) === `CE-${lead.id}`)
    || cards.find(item => norm(item.card.email) && norm(item.card.email) === norm(lead.email)) || null;

  const summary = {
    offerId: offer.id, retiredAt: offer.retiredAt,
    total: offerLeads.length, archived: 0, active: 0, sendable: 0,
    queued: 0, draftOrImport: 0, alreadySent: 0, followUpsDue: 0,
    conversations: 0, gmailOwned: 0, reservations: 0, unresolvedSendState: 0,
    held: 0, suppressed: 0,
    events: 0, providerMessageIds: 0, providerThreadIds: 0,
    cards: cards.length, cardsArchived: cards.filter(item => isArchivedLead(item.card)).length,
    protected: spared.length,
    closedWon: offerLeads.filter(lead => ['closed_won', 'won'].includes(norm(lead.stage))).length
      + cards.filter(item => ['closed_won', 'won'].includes(norm(item.card.stage))).length,
    byStage: {}, bySender: {}, bySignal: {},
  };
  const messageIds = new Set();
  const threadIds = new Set();
  const leadPlans = [];
  let alreadyArchivedLeads = 0;

  for (const lead of offerLeads) {
    const mine = byLead.get(text(lead.id)) || [];
    const archived = isArchivedLead(lead);
    const unresolved = unresolvedByLead.get(text(lead.id)) || [];
    summary.byStage[text(lead.stage) || '(blank)'] = (summary.byStage[text(lead.stage) || '(blank)'] || 0) + 1;
    for (const signal of (retiredOfferFor(lead) || { signals: [] }).signals) {
      summary.bySignal[signal] = (summary.bySignal[signal] || 0) + 1;
    }
    if (archived) { summary.archived++; alreadyArchivedLeads++; } else summary.active++;
    if (!archived && sendableNow(lead, { suppressedEmails, now, env })) summary.sendable++;
    if (!archived && text(lead.stage) === 'Queued') summary.queued++;
    if (neverSent(lead)) summary.draftOrImport++; else summary.alreadySent++;
    if (!archived && followUpDueByTime(lead, now)) summary.followUpsDue++;
    if (norm(lead.emailStatus) === 'replied' || mine.some(row => INBOUND_EVENT.test(text(row.eventType)))) summary.conversations++;
    const senders = new Set([text(lead.senderInboxId).trim(),
      ...mine.filter(row => SENT_EVENTS.has(text(row.eventType)))
        .map(row => text(parseMetadata(row.metadata).senderInboxId).trim())].filter(Boolean));
    if (senders.size) summary.gmailOwned++;
    for (const sender of senders) summary.bySender[sender] = (summary.bySender[sender] || 0) + 1;
    if (unresolved.length) { summary.reservations++; summary.unresolvedSendState++; }
    const notes = text(lead.notes);
    if (notes.includes('[MANUAL HOLD]')) summary.held++;
    if (/\[REPLY: Unsubscribed\]|\[REPLY: Not Interested\]|\[BOUNCED/.test(notes)
      || suppressedEmails.has(norm(lead.email))) summary.suppressed++;
    summary.events += mine.length;
    for (const row of mine) {
      const meta = parseMetadata(row.metadata);
      const msg = text(meta.gmailMessageId || meta.providerMessageId).trim();
      const thread = text(meta.gmailThreadId || meta.providerThreadId).trim();
      if (msg) messageIds.add(msg);
      if (thread) threadIds.add(thread);
    }
    if (archived) continue;
    const card = cardFor(lead);
    const plan = planLeadArchive(lead, {
      reason: offer.archiveReason, archivedBy, source, now, activities: mine, stableId,
      boardLead: card ? card.card : null, unresolved,
    });
    if (plan) leadPlans.push(plan);
  }
  summary.providerMessageIds = messageIds.size;
  summary.providerThreadIds = threadIds.size;

  const boardPlans = [];
  let alreadyArchivedCards = 0;
  for (const { card, matchedBy } of cards) {
    if (isArchivedLead(card)) { alreadyArchivedCards++; continue; }
    const linked = offerLeads.find(lead => text(card.id) === `CE-${lead.id}`)
      || offerLeads.find(lead => norm(lead.email) && norm(lead.email) === norm(card.email));
    const plan = planBoardArchive(card, {
      reason: offer.archiveReason, archivedBy, source, now, stableId,
      activities: eventsForLead(activities, card.id), sourceLeadId: linked ? linked.id : '',
    });
    if (plan) boardPlans.push({ ...plan, matchedBy });
  }

  return {
    offer: { id: offer.id, label: offer.label, retiredAt: offer.retiredAt, archiveReason: offer.archiveReason },
    summary, leadPlans, boardPlans,
    cards: cards.map(({ card, matchedBy }) => ({
      id: card.id, company: card.company, stage: card.stage, matchedBy,
      archived: isArchivedLead(card), archiveReason: archiveReasonFromNotes(card.notes),
    })),
    alreadyArchivedLeads, alreadyArchivedCards,
    protectedRecords, spared,
  };
}

module.exports = { planOfferRetirement, verifyProtectedRecords, sendableNow, followUpDueByTime, neverSent };
