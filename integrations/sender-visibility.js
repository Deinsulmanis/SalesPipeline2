'use strict';
/**
 * sender-visibility.js — "which Gmail inbox owns this conversation?" PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * A READ-ONLY presentation layer over the sender ownership the send path
 * already decides. It resolves nothing of its own: senderEvidence() in
 * gmail-sender-routing.js is the canonical resolver, and it is the same
 * function pinnedSenderId() and chooseSender() consult before a message goes
 * out. Asking a second way would let the screen and the sender disagree, which
 * is the one thing sender visibility must never do.
 *
 * WHAT THIS ANSWERS — and what it deliberately does not
 *
 * Sender ownership is HISTORICAL: which mailbox this conversation belongs to.
 * It is not "which inbox would be chosen for this lead right now". Those differ
 * the moment quota, warming status or eligibility changes, and showing the
 * second while labelling it the first would be a lie that survives right up
 * until someone acts on it. Nothing here reads a daily limit or an eligibility
 * flag, so a lead pinned to the primary inbox keeps showing the primary inbox
 * even when the secondary has more quota left today.
 *
 * FOUR STATES, none of them a guess
 *
 *   confirmed  a delivered message carries this sender id
 *   assigned   the lead row names a sender, but nothing has been sent yet
 *   unknown    no trustworthy evidence exists — shown as such, never defaulted
 *   conflict   two mailboxes both claim the conversation; a human must look
 *
 * `unknown` is the important one. Most production rows predate immutable sender
 * attribution, and defaulting them to the primary inbox would manufacture a
 * fact: it would read identically to a lead genuinely proven to be primary. So
 * missing evidence stays missing.
 *
 * NO SECRETS. The projection carries an id, an email address and a label. Token
 * environment variable names, OAuth client ids and credential state are not
 * part of it and must never be added — this object is rendered in a browser.
 */

const { senderEvidence, sentSenderEvidence } = require('./gmail-sender-routing');

const SENDER_STATE = Object.freeze({
  CONFIRMED: 'confirmed',
  ASSIGNED: 'assigned',
  UNKNOWN: 'unknown',
  CONFLICT: 'conflict',
});

// Operator-facing wording. The UI renders these strings; it never renders a
// state id, so "confirmed" and "conflict" stay internal vocabulary.
const STATE_LABEL = Object.freeze({
  [SENDER_STATE.CONFIRMED]: 'Confirmed by sent email',
  [SENDER_STATE.ASSIGNED]: 'Assigned, not yet sent',
  [SENDER_STATE.UNKNOWN]: 'Unknown / legacy sender',
  [SENDER_STATE.CONFLICT]: 'Sender conflict — review required',
});

/** "deins@tryscalelabai.ca" → "tryscalelabai.ca". Compact enough for a table. */
function inboxDomain(email) {
  const at = String(email || '').indexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).trim().toLowerCase();
}

/**
 * The visible identity of one configured inbox, with nothing sensitive on it.
 * `primary` is named rather than numbered because that is how the routing rules
 * and the operator both refer to it.
 */
function senderIdentity(senderId, senders = []) {
  const id = String(senderId || '').trim();
  const match = (senders || []).find(sender => String(sender.id) === id) || null;
  const email = match ? String(match.email || '').trim().toLowerCase() : '';
  return {
    senderId: id,
    email,
    domain: inboxDomain(email),
    // A pinned id with no matching configured inbox is a real condition worth
    // surfacing: the registry changed under a lead that is already pinned.
    configured: Boolean(match),
    role: id === 'primary' ? 'Primary' : 'Secondary',
  };
}

/**
 * Resolve which inbox owns a lead's conversation.
 *
 * @param lead        a ColdEmail row
 * @param activities  that lead's canonical activity rows
 * @param senders     configuredSenders() output, for id → address only
 */
function resolveSenderOwnership({ lead = {}, activities = [], senders = [] } = {}) {
  const all = senderEvidence(lead, activities);
  const sent = sentSenderEvidence(lead, activities);

  if (all.length > 1) {
    return {
      state: SENDER_STATE.CONFLICT,
      stateLabel: STATE_LABEL[SENDER_STATE.CONFLICT],
      senderId: null, email: '', domain: '', role: '', configured: false,
      label: 'Conflict', shortLabel: 'Conflict',
      // Both claimants, so the person reviewing does not have to go digging.
      candidates: all.map(id => senderIdentity(id, senders)),
      detail: `Two mailboxes claim this conversation: ${all.map(id => senderIdentity(id, senders).email || id).join(' and ')}.`,
    };
  }

  if (!all.length) {
    // senderEvidence() counts the row's assignment as OWNERSHIP only once the
    // lead has actually been contacted, which is right for the send path: an
    // unsent lead owns no conversation. For a reader it is still worth showing,
    // clearly marked as an intention rather than a fact — it is a persisted
    // value, not an inference, and saying "Unknown" for a lead queued to a
    // named inbox would hide real information.
    const queuedTo = String(lead.senderInboxId || '').trim();
    if (queuedTo) {
      const identity = senderIdentity(queuedTo, senders);
      const name = identity.email || identity.senderId;
      return {
        ...identity,
        state: SENDER_STATE.ASSIGNED,
        stateLabel: STATE_LABEL[SENDER_STATE.ASSIGNED],
        label: name,
        shortLabel: identity.domain ? `${identity.role} · ${identity.domain}` : identity.role,
        candidates: [],
        detail: `Queued to ${name}. Nothing has been sent yet, so no inbox owns this conversation.`,
      };
    }
    return {
      state: SENDER_STATE.UNKNOWN,
      stateLabel: STATE_LABEL[SENDER_STATE.UNKNOWN],
      senderId: null, email: '', domain: '', role: '', configured: false,
      label: 'Unknown', shortLabel: 'Unknown', candidates: [],
      detail: 'No sender was recorded for this lead. It predates immutable sender attribution, so the owning inbox cannot be proven.',
    };
  }

  const identity = senderIdentity(all[0], senders);
  // Sent beats assigned: a delivered message is a fact, a row value is an
  // intention that a failed or re-routed send would have left behind.
  const state = sent.includes(identity.senderId) ? SENDER_STATE.CONFIRMED : SENDER_STATE.ASSIGNED;
  const name = identity.email || identity.senderId;
  return {
    ...identity,
    state,
    stateLabel: STATE_LABEL[state],
    label: name,
    // Table-sized: "Primary · scalelabai.ca".
    shortLabel: identity.domain ? `${identity.role} · ${identity.domain}` : identity.role,
    candidates: [],
    detail: state === SENDER_STATE.CONFIRMED
      ? `Sent from ${name}.`
      : `Assigned to ${name}. Nothing has been sent from it yet.`,
  };
}

/**
 * The sender attached to ONE activity row, for the timeline's "Sent from …"
 * subline. Returns null when the event stored no attribution — historical
 * sender is never reconstructed, because the only honest answer for a message
 * delivered before the field existed is that we do not know.
 */
function activitySender(row = {}, senders = []) {
  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata || '{}'); } catch (_) { metadata = {}; }
  }
  const id = String((metadata || {}).senderInboxId || '').trim();
  if (!id) return null;
  const identity = senderIdentity(id, senders);
  return { ...identity, label: identity.email || identity.senderId };
}

/** The filter options a sender-aware view offers. Ids only — no credentials. */
function senderFilterOptions(senders = []) {
  return [
    { value: 'all', label: 'All inboxes' },
    ...(senders || []).map(sender => {
      const identity = senderIdentity(sender.id, senders);
      return { value: identity.senderId, label: identity.email || identity.senderId };
    }),
    { value: 'unknown', label: 'Unknown / legacy' },
    { value: 'conflict', label: 'Sender conflict' },
  ];
}

/** Does a resolved ownership match a filter value? */
function matchesSenderFilter(ownership, value) {
  const filter = String(value || 'all').trim();
  if (!filter || filter === 'all') return true;
  if (!ownership) return filter === 'unknown';
  if (filter === 'unknown') return ownership.state === SENDER_STATE.UNKNOWN;
  if (filter === 'conflict') return ownership.state === SENDER_STATE.CONFLICT;
  return ownership.senderId === filter;
}

module.exports = {
  SENDER_STATE, STATE_LABEL, inboxDomain, senderIdentity,
  resolveSenderOwnership, activitySender,
  senderFilterOptions, matchesSenderFilter,
};
