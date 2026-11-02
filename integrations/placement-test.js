'use strict';

/**
 * Controlled inbox-placement test: a small labelled email from each of a
 * client's inboxes to mailboxes we own and can inspect.
 *
 * It never reads the prospect queue. Recipients come only from the list below.
 * The agent runs it behind the same send authorization, durable reservation and
 * quota coordinator as a scheduled send, so a test send spends real daily
 * capacity and cannot exceed a cap. A repeat of the same label sends nothing:
 * its action ids are already held.
 */

const PLACEMENT_TEST_EVENT = 'placement_test_sent';
const PLACEMENT_TEST_CLIENT = 'jole';
const PLACEMENT_TEST_CONFIRM = 'SEND_PLACEMENT_TEST';

// Mailboxes the operator owns, whose inbox and spam folders can both be read.
const PLACEMENT_TEST_RECIPIENTS = Object.freeze([
  Object.freeze({ id: 'workspace_scalelabai', email: 'deins@scalelabai.ca', provider: 'google_workspace' }),
  Object.freeze({ id: 'workspace_scalelabaiteam', email: 'deins@scalelabaiteam.com', provider: 'google_workspace' }),
]);

const validPlacementLabel = label => /^[a-z0-9][a-z0-9-]{3,39}$/.test(String(label || ''));
const placementActionId = (label, senderId, recipientId) => `placement-test:${label}:${senderId}:${recipientId}`;

function placementMessage({ label, sender, recipient, senderName, mailingAddress }) {
  return {
    to: recipient.email,
    subject: `Inbox placement test ${label} from ${sender.email}`,
    body: [
      'This is a controlled inbox placement test from Jole BTX. It was sent on purpose to a mailbox we own, and no action is needed.',
      `Test run: ${label}\nSending inbox: ${sender.email}\nReceiving mailbox: ${recipient.id}`,
      'The text below matches the length and format of a normal first email.',
      'I can have our team check whether we have the right craft coverage for a site and what it would realistically take to fill the gap.',
      'Want me to check?',
      [senderName, 'Jole BTX LLC', mailingAddress].filter(Boolean).join('\n'),
    ].join('\n\n'),
  };
}

// The inboxes a run may use: this client's, eligible, and still allowed to send.
function placementSenders(senders = [], { mayStillSend = () => true } = {}) {
  return senders.filter(sender => sender.clientId === PLACEMENT_TEST_CLIENT && sender.sendEligible && mayStillSend(sender));
}

/**
 * Send one message per inbox per recipient. Every send goes through `quota`
 * (the shared coordinator) and `reserve` (the durable action reservation). A
 * refused or failed send is reported and the run moves on: it can only ever
 * send fewer messages than planned.
 */
async function runPlacementTest({ label, senders = [], recipients = PLACEMENT_TEST_RECIPIENTS, quota, reserve, deliver, record, between = async () => {}, messageFor }) {
  if (!validPlacementLabel(label)) throw new Error('placement test label is invalid');
  const allowed = new Set(PLACEMENT_TEST_RECIPIENTS.map(item => item.email));
  if (recipients.some(item => !allowed.has(item.email))) throw new Error('placement test recipient is not on the owned list');
  const results = [];
  for (const sender of senders) {
    for (const recipient of recipients) {
      const actionId = placementActionId(label, sender.id, recipient.id);
      const message = messageFor({ label, sender, recipient });
      const action = { actionId, leadId: `placement-test:${label}`, actionType: 'gmail_placement_test', provider: 'gmail',
        ownership: { clientId: sender.clientId, senderClientId: sender.clientId } };
      const base = { senderInboxId: sender.id, senderEmail: sender.email, recipientId: recipient.id, provider: recipient.provider, subject: message.subject };
      try {
        const sent = await quota.execute({ actionId, clientId: sender.clientId, senderId: sender.id,
          run: ({ markProviderStart }) => reserve(action, async () => {
            await markProviderStart();
            return deliver(sender, message);
          }) });
        const data = sent?.data || sent || {};
        const accepted = { ...base, status: 'accepted', gmailMessageId: data.id || '', gmailThreadId: data.threadId || '' };
        results.push(accepted);
        // Gmail accepted it: a ledger failure must not report the send as refused.
        await record({ actionId, sender, recipient, message, label, gmailMessageId: data.id || '', gmailThreadId: data.threadId || '' })
          .catch(error => { accepted.ledger = 'failed'; accepted.reason = String(error.message || '').slice(0, 200); });
      } catch (error) {
        results.push({ ...base, status: 'refused', code: error.code || 'send_failed', reason: String(error.message || '').slice(0, 200) });
      }
      await between();
    }
  }
  return results;
}

module.exports = {
  PLACEMENT_TEST_EVENT, PLACEMENT_TEST_CLIENT, PLACEMENT_TEST_CONFIRM, PLACEMENT_TEST_RECIPIENTS,
  validPlacementLabel, placementActionId, placementMessage, placementSenders, runPlacementTest,
};
