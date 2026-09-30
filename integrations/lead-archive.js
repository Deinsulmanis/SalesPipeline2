'use strict';

/**
 * lead-archive.js — soft archival of leads, and retirement of whole offers.
 * PURE: no network, no Sheets, no Supabase. Callers load state and write it.
 *
 * ── ARCHIVE IS A STATE ON THE LEAD, NOT A COPY OF IT ────────────────────────
 *
 * An archived lead stays in outreach_leads under its own id, with every field,
 * every activity event, every Gmail message and thread id exactly where they
 * were. Archiving writes two things to the canonical row and nothing else:
 *
 *   stage  -> 'Archived'                    (what lists, counts and filters see)
 *   notes  -> '[ARCHIVED: <reason>] …'      (what every send gate sees)
 *
 * The notes marker is the durable fact. It is one of the canonical safety
 * markers (outreach-state SAFETY_NOTE_MARKERS), so no stale notes write can
 * erase it, and one of the send-suppression tags (pipeline-state
 * SEND_SUPPRESSION_TAGS), so selection, ownership and the final provider gate
 * all refuse the lead without being told about archives at all. Only an
 * explicit restore may release it. The stage is kept 'Archived' by the
 * canonical write path for as long as the marker is present, so an observer
 * recording a bounce or an opt-out cannot walk an archived lead back into a
 * cold stage.
 *
 * Who archived it, why, when, and what state it was in are recorded once, in a
 * `lead_archived` activity event. Historical events are never rewritten.
 *
 * ── RETIRED OFFERS ──────────────────────────────────────────────────────────
 *
 * Retiring an offer is separate from archiving its leads and stronger: a lead
 * of a retired offer may not be sent anything, archived or not, restored or
 * not. That is what lets a dental lead be restored for inspection while the
 * dental offer stays incapable of generating another outbound message.
 */

const ARCHIVE_MARKER_PREFIX = '[ARCHIVED';
const ARCHIVED_STAGE = 'Archived';           // ColdEmail stage
const BOARD_ARCHIVED_STAGE = 'archived';     // Pipeline board stage id
const ARCHIVE_EVENT_TYPE = 'lead_archived';
const RESTORE_EVENT_TYPE = 'lead_restored';
const ARCHIVED_REPLY_EVENT_TYPE = 'archived_reply_observed';

const ARCHIVE_REASONS = Object.freeze({
  OFFER_RETIRED_DENTAL: 'offer_retired_dental',
  MANUAL: 'manual_archive',
});
const ARCHIVE_REASON_LABELS = Object.freeze({
  [ARCHIVE_REASONS.OFFER_RETIRED_DENTAL]: 'Dental offer retired',
  [ARCHIVE_REASONS.MANUAL]: 'Archived by hand',
});

// Stage a restored lead returns to. Never a sending stage: a lead that was
// never sent re-enters as an import that must pass the queue's checks again;
// one that was sent returns to Review under a MANUAL HOLD, so nothing resumes
// until a person decides it should.
const RESTORE_STAGE_UNSENT = 'Import';
const RESTORE_STAGE_SENT = 'Review';
const MANUAL_HOLD_TAG = '[MANUAL HOLD]';

const REASON_PATTERN = /^[a-z0-9_]{1,64}$/;
const MARKER_PATTERN = /\[ARCHIVED(?::\s*([^\]]*))?\]/i;
const MARKER_PATTERN_GLOBAL = /\s*\[ARCHIVED(?::\s*[^\]]*)?\]\s*/gi;

const text = value => (value === null || value === undefined ? '' : String(value));
const norm = value => text(value).trim().toLowerCase();

function assertReason(reason) {
  if (!REASON_PATTERN.test(text(reason))) throw new Error(`archive reason "${text(reason)}" must be a lowercase identifier`);
  return reason;
}

function archiveMarker(reason) {
  return `${ARCHIVE_MARKER_PREFIX}: ${assertReason(reason)}]`;
}

/** The archive reason recorded in notes; 'unspecified' for a bare marker; null when not archived. */
function archiveReasonFromNotes(notes) {
  const match = text(notes).match(MARKER_PATTERN);
  if (!match) return null;
  return text(match[1]).trim() || 'unspecified';
}

/**
 * Is this lead archived? Either signal is enough: the marker is the durable
 * fact, the stage is what a board card or a mirror copy may carry. A lead that
 * shows either one is treated as archived by every gate — fail closed.
 */
function isArchivedLead(lead) {
  if (!lead || typeof lead !== 'object') return false;
  return archiveReasonFromNotes(lead.notes) !== null || norm(lead.stage) === BOARD_ARCHIVED_STAGE;
}

function addArchiveMarker(notes, reason) {
  const existing = text(notes);
  if (archiveReasonFromNotes(existing) !== null) return existing;
  return existing ? `${archiveMarker(reason)} ${existing}` : archiveMarker(reason);
}

function removeArchiveMarker(notes) {
  return text(notes).replace(MARKER_PATTERN_GLOBAL, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Retired offers ──────────────────────────────────────────────────────────

const DENTAL_NICHES = Object.freeze(['dental', 'dentist', 'dentists', 'dental clinic']);
// Clinical vocabulary that appears in legacy tradeType values and campaign
// names ("Orthodontist", "Periodontist", "Oral surgeon", "Denture care center",
// "Surrey Dentists"). Word-anchored on purpose: a bare "dent" substring also
// matches "independent", "student", "resident" and "accident", and a staffing
// lead described that way must never be mistaken for the retired dental offer.
// Checked against production on 2026-09-30: selects exactly the same 1,327
// leads as the loose substring, with no staffing or roofing lead among them.
const DENTAL_TRADE_PATTERN = /(\bdent(al|ist|ists|istry|ure|ures)?\b|orthodont|periodont|endodont|\boral surg|prosthodont)/i;

const RETIRED_OFFERS = Object.freeze([
  Object.freeze({
    id: 'dental',
    label: 'Dental AI receptionist',
    family: 'dental_ai_receptionist',
    leadType: 'dental',
    archiveReason: ARCHIVE_REASONS.OFFER_RETIRED_DENTAL,
    retiredAt: '2026-09-30',
    templateIds: Object.freeze(['dental-guarantee-v1']),
    campaignVersionPattern: /^dental_/i,
  }),
]);

/**
 * Every field that says this lead belongs to the dental offer, strongest first.
 * Canonical identifiers (niche, template, campaign version) exist only on rows
 * routed since August; legacy rows carry the offer in tradeType and the
 * campaign name. Company name is never used: it is display text, not identity.
 */
function dentalSignals(lead = {}) {
  const signals = [];
  if (DENTAL_NICHES.includes(norm(lead.leadNiche))) signals.push('lead_niche');
  if (RETIRED_OFFERS[0].templateIds.includes(text(lead.emailTemplateId).trim())) signals.push('email_template_id');
  if (RETIRED_OFFERS[0].campaignVersionPattern.test(text(lead.intendedCampaignVersion).trim())
    || RETIRED_OFFERS[0].campaignVersionPattern.test(text(lead.campaignVersion).trim())) signals.push('campaign_version');
  if (norm(lead.campaignFamily) === 'dental_ai_receptionist') signals.push('campaign_family');
  if (DENTAL_TRADE_PATTERN.test(text(lead.tradeType))) signals.push('trade_type');
  if (DENTAL_TRADE_PATTERN.test(text(lead.campaign))) signals.push('campaign');
  return signals;
}

const SIGNALS_BY_OFFER = Object.freeze({ dental: dentalSignals });

/** The retired offer this lead belongs to, or null. */
function retiredOfferFor(lead) {
  if (!lead || typeof lead !== 'object') return null;
  for (const offer of RETIRED_OFFERS) {
    const signals = SIGNALS_BY_OFFER[offer.id](lead);
    if (signals.length) return { offer, signals };
  }
  return null;
}

function retiredOfferById(id) {
  return RETIRED_OFFERS.find(offer => offer.id === text(id).trim()) || null;
}

/** { code: 'offer_retired', reason } when the lead's offer is retired, else null. */
function retiredOfferBlock(lead) {
  const match = retiredOfferFor(lead);
  if (!match) return null;
  return {
    code: 'offer_retired', offerId: match.offer.id,
    reason: `the ${match.offer.label} offer was retired on ${match.offer.retiredAt}; nothing may be sent for it`,
  };
}

/**
 * Why nothing may be sent to this lead on archive or offer grounds, or null.
 * The one question every send path asks; archive first because it is the more
 * specific fact about this lead.
 */
function outreachBlockForLead(lead) {
  if (isArchivedLead(lead)) {
    return { code: 'archived',
      reason: `lead is archived (${archiveReasonFromNotes(lead.notes) || 'archived stage'}); restore it before any send` };
  }
  return retiredOfferBlock(lead);
}

// ── Archive records ─────────────────────────────────────────────────────────

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(text(value) || '{}'); } catch (_) { return {}; }
}

function eventsForLead(activities = [], leadId) {
  const id = text(leadId);
  return activities.filter(row => text(row.sourceLeadId) === id || text(row.leadId) === id || text(row.leadId) === `CE-${id}`);
}

/** How many times this lead has been restored — the archive "generation". */
function restoreCount(activities = [], leadId) {
  return eventsForLead(activities, leadId).filter(row => row.eventType === RESTORE_EVENT_TYPE).length;
}

/**
 * The archive event that describes the lead's CURRENT archive, or null: the
 * newest lead_archived with no lead_restored after it.
 */
function currentArchiveRecord(activities = [], leadId) {
  const mine = eventsForLead(activities, leadId)
    .filter(row => row.eventType === ARCHIVE_EVENT_TYPE || row.eventType === RESTORE_EVENT_TYPE)
    .sort((a, b) => text(a.occurredAt).localeCompare(text(b.occurredAt)));
  const last = mine[mine.length - 1];
  if (!last || last.eventType !== ARCHIVE_EVENT_TYPE) return null;
  return { eventId: last.eventId, occurredAt: last.occurredAt, ...parseMetadata(last.metadata) };
}

function neverSent(lead = {}) {
  const status = norm(lead.emailStatus);
  return (status === '' || status === 'draft') && !(Number(lead.emailStep) > 0) && !text(lead.lastEmailedAt).trim();
}

/**
 * Plan archiving one ColdEmail lead. Returns null when it is already archived
 * (idempotent), else { patch, expectedState, event }.
 *
 * expectedState is every field the plan was made from. The canonical write
 * refuses the change if any of them moved since the snapshot, so a lead that
 * was sent, replied or held a moment ago is reported as a conflict instead of
 * being overwritten by a stale plan.
 */
function planLeadArchive(lead, {
  reason, archivedBy, source, now = new Date(), activities = [], stableId,
  boardLead = null, unresolved = [],
} = {}) {
  if (!lead || !text(lead.id).trim()) throw new Error('planLeadArchive requires a lead with an id');
  assertReason(reason);
  if (!text(archivedBy).trim()) throw new Error('planLeadArchive requires archivedBy');
  if (typeof stableId !== 'function') throw new Error('planLeadArchive requires a stableId function');
  if (isArchivedLead(lead)) return null;
  const archivedAt = now.toISOString();
  const generation = restoreCount(activities, lead.id);
  const offer = retiredOfferFor(lead);
  const metadata = {
    archived: true,
    archiveReason: reason,
    archivedAt,
    archivedBy: text(archivedBy).trim(),
    archiveSource: text(source).trim() || 'manual',
    generation,
    previousStage: text(lead.stage),
    previousEmailStatus: text(lead.emailStatus),
    previousEmailStep: text(lead.emailStep),
    previousLastEmailedAt: text(lead.lastEmailedAt),
    senderInboxId: text(lead.senderInboxId),
    emailTemplateId: text(lead.emailTemplateId),
    intendedCampaignVersion: text(lead.intendedCampaignVersion),
    campaign: text(lead.campaign),
    leadNiche: text(lead.leadNiche),
    tradeType: text(lead.tradeType),
    clientId: text(lead.clientId),
    retiredOffer: offer ? offer.offer.id : '',
    offerSignals: offer ? offer.signals : [],
    heldAtArchive: text(lead.notes).includes(MANUAL_HOLD_TAG),
    boardLeadId: boardLead ? text(boardLead.id) : '',
    previousBoardStage: boardLead ? text(boardLead.stage) : '',
    unresolved: unresolved.map(item => ({ ...item })),
  };
  return {
    leadId: text(lead.id),
    patch: { stage: ARCHIVED_STAGE, notes: addArchiveMarker(lead.notes, reason) },
    expectedState: {
      stage: text(lead.stage), emailStatus: text(lead.emailStatus), emailStep: text(lead.emailStep),
      lastEmailedAt: text(lead.lastEmailedAt), senderInboxId: text(lead.senderInboxId), notes: text(lead.notes),
    },
    event: {
      eventId: stableId('lead-archived', [lead.id, reason, generation]),
      leadId: `CE-${lead.id}`, sourceLeadId: text(lead.id),
      email: text(lead.email), company: text(lead.company),
      eventType: ARCHIVE_EVENT_TYPE, occurredAt: archivedAt,
      subject: `Archived — ${ARCHIVE_REASON_LABELS[reason] || reason}`, content: '',
      metadata: JSON.stringify(metadata),
    },
    metadata,
  };
}

/**
 * Plan archiving a Pipeline board card that has no ColdEmail row of its own
 * (or whose ColdEmail twin is archived in the same run). The card's stage is
 * moved to 'archived' so it leaves the board; its notes carry the marker.
 */
function planBoardArchive(card, {
  reason, archivedBy, source, now = new Date(), activities = [], stableId, sourceLeadId = '',
} = {}) {
  if (!card || !text(card.id).trim()) throw new Error('planBoardArchive requires a card with an id');
  assertReason(reason);
  if (typeof stableId !== 'function') throw new Error('planBoardArchive requires a stableId function');
  if (isArchivedLead(card)) return null;
  const archivedAt = now.toISOString();
  const generation = eventsForLead(activities, card.id)
    .filter(row => row.eventType === RESTORE_EVENT_TYPE && parseMetadata(row.metadata).scope === 'board').length;
  const metadata = {
    archived: true, scope: 'board', archiveReason: reason, archivedAt,
    archivedBy: text(archivedBy).trim(), archiveSource: text(source).trim() || 'manual', generation,
    previousBoardStage: text(card.stage), tradeType: text(card.tradeType), sourceLeadId: text(sourceLeadId),
    meetingAt: text(card.meetingAt), outcome: text(card.outcome),
  };
  return {
    cardId: text(card.id),
    patch: { stage: BOARD_ARCHIVED_STAGE, notes: addArchiveMarker(card.notes, reason) },
    expectedState: { stage: text(card.stage), notes: text(card.notes) },
    event: {
      eventId: stableId('board-archived', [card.id, reason, generation]),
      leadId: text(card.id), sourceLeadId: text(sourceLeadId),
      email: text(card.email), company: text(card.company),
      eventType: ARCHIVE_EVENT_TYPE, occurredAt: archivedAt,
      subject: `Removed from Sales Pipeline — ${ARCHIVE_REASON_LABELS[reason] || reason}`, content: '',
      metadata: JSON.stringify(metadata),
    },
    metadata,
  };
}

/**
 * Plan restoring an archived ColdEmail lead. Never to a sending state:
 *   never sent -> stage Import, emailStatus cleared of 'draft' (queue again, with
 *                 every queue check, to send anything)
 *   sent       -> stage Review under [MANUAL HOLD] (a person resumes it, or not)
 * History is untouched; one lead_restored event records the decision. A lead
 * whose offer is retired stays unsendable after restore — the offer gate does
 * not read the archive at all.
 */
function planLeadRestore(lead, { restoredBy, now = new Date(), activities = [], stableId } = {}) {
  if (!lead || !text(lead.id).trim()) throw new Error('planLeadRestore requires a lead with an id');
  if (!text(restoredBy).trim()) throw new Error('planLeadRestore requires restoredBy');
  if (typeof stableId !== 'function') throw new Error('planLeadRestore requires a stableId function');
  if (!isArchivedLead(lead)) return null;
  const record = currentArchiveRecord(activities, lead.id) || {};
  const unsent = neverSent(lead);
  const released = removeArchiveMarker(lead.notes);
  const notes = unsent || released.includes(MANUAL_HOLD_TAG)
    ? released : (released ? `${MANUAL_HOLD_TAG} ${released}` : MANUAL_HOLD_TAG);
  const patch = { stage: unsent ? RESTORE_STAGE_UNSENT : RESTORE_STAGE_SENT, notes };
  if (unsent && norm(lead.emailStatus) === 'draft') patch.emailStatus = '';
  const restoredAt = now.toISOString();
  const generation = restoreCount(activities, lead.id);
  const offer = retiredOfferBlock(lead);
  const metadata = {
    restoredBy: text(restoredBy).trim(), restoredAt, restoredStage: patch.stage,
    heldOnRestore: !unsent, archiveEventId: record.eventId || '',
    archiveReason: record.archiveReason || archiveReasonFromNotes(lead.notes) || '',
    previousStage: record.previousStage || '', generation,
    offerRetired: Boolean(offer), sendableAfterRestore: false,
  };
  return {
    leadId: text(lead.id), patch,
    expectedState: { stage: text(lead.stage), emailStatus: text(lead.emailStatus), notes: text(lead.notes) },
    event: {
      eventId: stableId('lead-restored', [lead.id, generation]),
      leadId: `CE-${lead.id}`, sourceLeadId: text(lead.id),
      email: text(lead.email), company: text(lead.company),
      eventType: RESTORE_EVENT_TYPE, occurredAt: restoredAt,
      subject: `Restored from Archive — ${patch.stage}${offer ? ' (offer still retired; cannot send)' : ''}`, content: '',
      metadata: JSON.stringify(metadata),
    },
    metadata,
  };
}

/** Restore a board card to its previous stage, held. */
function planBoardRestore(card, { restoredBy, now = new Date(), activities = [], stableId } = {}) {
  if (!card || !text(card.id).trim()) throw new Error('planBoardRestore requires a card with an id');
  if (!text(restoredBy).trim()) throw new Error('planBoardRestore requires restoredBy');
  if (!isArchivedLead(card)) return null;
  const record = eventsForLead(activities, card.id)
    .filter(row => row.eventType === ARCHIVE_EVENT_TYPE && parseMetadata(row.metadata).scope === 'board')
    .sort((a, b) => text(b.occurredAt).localeCompare(text(a.occurredAt)))[0];
  const meta = record ? parseMetadata(record.metadata) : {};
  const previous = text(meta.previousBoardStage).trim();
  const stage = previous && norm(previous) !== BOARD_ARCHIVED_STAGE ? previous : 'follow_up';
  const released = removeArchiveMarker(card.notes);
  const notes = released.includes(MANUAL_HOLD_TAG) ? released : (released ? `${MANUAL_HOLD_TAG} ${released}` : MANUAL_HOLD_TAG);
  const generation = eventsForLead(activities, card.id)
    .filter(row => row.eventType === RESTORE_EVENT_TYPE && parseMetadata(row.metadata).scope === 'board').length;
  const restoredAt = now.toISOString();
  return {
    cardId: text(card.id), patch: { stage, notes },
    expectedState: { stage: text(card.stage), notes: text(card.notes) },
    event: {
      eventId: stableId('board-restored', [card.id, generation]),
      leadId: text(card.id), sourceLeadId: text(meta.sourceLeadId),
      email: text(card.email), company: text(card.company),
      eventType: RESTORE_EVENT_TYPE, occurredAt: restoredAt,
      subject: `Returned to Sales Pipeline — ${stage} (held)`, content: '',
      metadata: JSON.stringify({ scope: 'board', restoredBy: text(restoredBy).trim(), restoredAt,
        restoredStage: stage, archiveEventId: record ? record.eventId : '', generation, heldOnRestore: true }),
    },
  };
}

module.exports = {
  ARCHIVE_MARKER_PREFIX, ARCHIVED_STAGE, BOARD_ARCHIVED_STAGE,
  ARCHIVE_EVENT_TYPE, RESTORE_EVENT_TYPE, ARCHIVED_REPLY_EVENT_TYPE,
  ARCHIVE_REASONS, ARCHIVE_REASON_LABELS, RESTORE_STAGE_UNSENT, RESTORE_STAGE_SENT,
  RETIRED_OFFERS, DENTAL_TRADE_PATTERN,
  archiveMarker, archiveReasonFromNotes, isArchivedLead, addArchiveMarker, removeArchiveMarker,
  dentalSignals, retiredOfferFor, retiredOfferById, retiredOfferBlock, outreachBlockForLead,
  eventsForLead, restoreCount, currentArchiveRecord, neverSent, parseMetadata,
  planLeadArchive, planBoardArchive, planLeadRestore, planBoardRestore,
};
