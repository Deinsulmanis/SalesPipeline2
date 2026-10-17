'use strict';

/**
 * Reply handling for managed clients (replyPolicy.mode === 'managed').
 *
 * The existing ScaleLab reply handlers answer, promote and book for ScaleLab.
 * None of that may run for a managed client's lead, so the agent routes such a
 * reply here instead. This never sends anything: ScaleLab continues the
 * employer conversation by hand, and a question only the client can answer is
 * recorded as a clarification for an operator.
 *
 * Order, chosen so no failure can leave a replied lead in the cold cadence:
 *
 *   1. lead state   stop the sequence (and tag opt-outs) through the canonical
 *                   mutation path. If this throws, nothing else happens and the
 *                   next pass retries.
 *   2. evidence     one client_reply_classified activity, keyed by client and
 *                   message, so a message is handled once.
 *   3. suppression  unsubscribe → global; negative → the client's scope.
 *   4. ledger       opportunity status and any clarification. Best effort: the
 *                   lead is already human-owned, and the evidence row keeps
 *                   everything needed to rebuild the ledger entry.
 */

const { classifyClientReply, WORKFLOW_STATE } = require('./reply-policy');
const { buildClientSuppression } = require('./suppression');
const { upsertOpportunity, openClarification } = require('./ledger');

const REPLY_EVENT_TYPE = 'client_reply_classified';
const NOT_INTERESTED_TAG = '[REPLY: Not Interested]';

function prependTag(notes, tag) {
  const existing = String(notes || '');
  if (existing.includes(tag)) return existing;
  return existing ? `${tag} ${existing}` : tag;
}

const replyEventId = (clientId, messageId, leadId) => `client-reply:${clientId}:${messageId || `lead-${leadId}`}`;

async function handleManagedClientReply({ lead, message = {}, replyText = '', context }, deps) {
  const {
    recordActivity, applyLeadChange, applyGlobalUnsubscribe, addGlobalSuppression,
    store = null, activities = [], log = console, now = () => new Date().toISOString(),
  } = deps;
  if (!context?.ok || context.policyMode !== 'managed') throw new Error('handleManagedClientReply requires a resolved managed-client reply context');
  const clientId = context.clientId;
  const eventId = replyEventId(clientId, message.messageId, lead.id);
  if ((activities || []).some(row => String(row.eventId) === eventId)) {
    return { handled: false, skipped: 'already_handled', eventId };
  }
  const occurredAt = message.occurredAt || now();
  const verdict = classifyClientReply({
    clientId, campaignId: context.campaignId, text: replyText, subject: message.subject || '',
    currentEmail: lead.email, now: occurredAt,
  });
  const state = verdict.workflowState;
  const audit = { client_id: clientId, lead_id: lead.id, campaign_id: context.campaignId, message_id: message.messageId || '', workflow_state: state };

  // 1. Lead state.
  if (state === WORKFLOW_STATE.UNSUBSCRIBE) {
    // Opt-out is global and uses the existing handler unchanged.
    await applyGlobalUnsubscribe(lead);
  } else if (state === WORKFLOW_STATE.NOT_INTERESTED || state === WORKFLOW_STATE.OUTSIDE_ICP) {
    const notes = prependTag(prependTag(lead.notes, `[CLIENT REPLY: ${state}]`), NOT_INTERESTED_TAG);
    if (!(String(lead.notes || '') === notes && lead.stage === 'Done' && lead.emailStatus === 'done')) {
      await applyLeadChange(lead, { stage: 'Done', emailStatus: 'done', notes });
      Object.assign(lead, { stage: 'Done', emailStatus: 'done', notes });
    }
  } else if (verdict.stopsColdSequence) {
    const notes = prependTag(lead.notes, `[CLIENT REPLY: ${state}]`);
    if (!['replied', 'done'].includes(String(lead.emailStatus || '').toLowerCase()) || notes !== String(lead.notes || '')) {
      const patch = { notes, ...(['replied', 'done'].includes(String(lead.emailStatus || '').toLowerCase()) ? {} : { emailStatus: 'replied' }) };
      await applyLeadChange(lead, patch);
      Object.assign(lead, patch);
    }
  }

  // 2. Evidence.
  await recordActivity({
    eventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email || '', company: lead.company || '',
    eventType: REPLY_EVENT_TYPE, occurredAt, subject: String(message.subject || '').slice(0, 500),
    content: String(replyText || '').slice(0, 1500),
    metadata: JSON.stringify({
      clientId, campaignId: context.campaignId, workflowState: state,
      conversationStatus: verdict.conversationStatus, sentiment: verdict.sentiment,
      suppressionScope: verdict.suppressionScope, canonical: verdict.canonical,
      clarification: verdict.clarification || null,
      gmailMessageId: message.messageId || '', gmailThreadId: message.threadId || '',
      senderInboxId: message.senderInboxId || '', provider: 'gmail', autoSendAllowed: false,
    }),
  });

  // 3. Suppression.
  let suppression = null;
  if (verdict.suppressionScope === 'global' && state !== WORKFLOW_STATE.UNSUBSCRIBE) {
    await addGlobalSuppression(lead, state);
    suppression = 'global';
  } else if (verdict.suppressionScope === 'client') {
    try {
      if (!store || !store.enabled) throw new Error('client ledger store is not enabled');
      await store.addClientSuppression(buildClientSuppression({
        clientId, matchType: 'email', value: lead.email, reason: state, source: 'reply-auto',
      }));
      suppression = 'client';
    } catch (error) {
      // The lead row already carries the sticky Not Interested tag, so this
      // lead stays suppressed; the durable client entry needs an operator.
      suppression = 'client_pending';
      log.error(JSON.stringify({ event: 'client_suppression_write_failed', ...audit, error: error.message }));
    }
  } else if (state === WORKFLOW_STATE.UNSUBSCRIBE) suppression = 'global';

  // 4. Ledger.
  let ledger = 'skipped';
  if (state !== WORKFLOW_STATE.AUTOMATED) {
    try {
      if (!store || !store.enabled) throw new Error('client ledger store is not enabled');
      await upsertOpportunity(store, { clientId, lead, conversationStatus: verdict.conversationStatus, by: 'reply-auto', now: occurredAt });
      if (state === WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION) {
        await openClarification(store, {
          clientId, lead, question: verdict.clarification.question, topics: verdict.clarification.topics,
          sourceMessageId: message.messageId || '', by: 'reply-auto', now: occurredAt,
        });
      }
      ledger = 'recorded';
    } catch (error) {
      ledger = 'unavailable';
      log.error(JSON.stringify({ event: 'client_ledger_write_failed', ...audit, error: error.message }));
    }
  }

  log.log(JSON.stringify({ event: 'client_reply_handled', ...audit, sentiment: verdict.sentiment, suppression, ledger }));
  return { handled: true, eventId, verdict, suppression, ledger };
}

module.exports = { REPLY_EVENT_TYPE, replyEventId, handleManagedClientReply };
