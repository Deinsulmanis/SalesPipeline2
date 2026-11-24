'use strict';

// Mailboxes the owner archived on 2026-11-24. Their Gmail access is gone
// (history API "access_not_configured"); production holds them from cold
// sending through COLD_SENDER_HOLDS. They are not listed on the dashboard
// (Settings, sender analytics, Client Ops, inbox filters, routing options,
// CRM Health observers). Display only: they stay in the sender registry so
// past sends, threads and lead history still resolve to the right inbox.
const ARCHIVED_MAILBOXES = Object.freeze([
  Object.freeze({ id: 'tryscalelabai', email: 'deins@tryscalelabai.ca' }),
  Object.freeze({ id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com' }),
  Object.freeze({ id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca' }),
]);

const norm = value => String(value || '').trim().toLowerCase();

function isArchivedMailbox(sender = {}) {
  const id = String(sender.id || sender.senderInboxId || '').trim();
  const email = norm(sender.email);
  return ARCHIVED_MAILBOXES.some(row => row.id === id || (email && row.email === email));
}

/** The senders the dashboard lists: every configured sender except archived mailboxes. */
function listedSenders(senders = []) {
  return (senders || []).filter(sender => !isArchivedMailbox(sender));
}

module.exports = { ARCHIVED_MAILBOXES, isArchivedMailbox, listedSenders };
