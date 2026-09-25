'use strict';

/**
 * Send-path glue for staffing landing-link issuances. The agent calls these at
 * fixed points of its existing send lifecycle; none of them adds a gate that
 * can send, resend or skip a reservation:
 *
 *   plan      pure, before render  — which URL this action carries
 *   ensure    before the pre-send reservation — best-effort issuance write;
 *             a stored row that CONTRADICTS the plan refuses the send
 *   sent      after provider success or Gmail recovery — best-effort
 *
 * A failed or slow write never blocks a send: the token is deterministic, the
 * canonical send activity records the pin, and the reconciler rebuilds any
 * missing issuance from it.
 */

const { STAFFING_CAMPAIGN, isStaffingCampaign } = require('./staffing-campaign');
const { ordinaryColdActionId, responseActionId } = require('./outbound-action-id');
const {
  LANDING_LINK_SOURCE, landingTrackingState, planLandingLink, coldStepPriorAttempts,
  warmReplyPriorAttempts, issuanceConflict,
} = require('./landing-link-token');
const { isTestRecipient } = require('./landing-attribution-config');
const store = require('./landing-attribution-store');

// The two automated staffing replies whose copy carries the landing page.
const LANDING_REPLY_TEMPLATE = Object.freeze({
  AUTO_STAFFING_SEND_INFO: 'staffing_send_info_reply_v1',
  AUTO_STAFFING_QUALIFIED: 'staffing_qualified_reply_v1',
});
const WARM_REPLY_TEMPLATE_ID = 'staffing_warm_reply';

/** Follow-up #2 plan, or null for anything that isn't a staffing step 2. */
function staffingColdStepLandingPlan({ lead, step, activities = [], env = process.env }) {
  if (!lead || lead.emailTemplateId !== STAFFING_CAMPAIGN.emailTemplateId || Number(step) !== 2) return null;
  return planLandingLink({
    actionId: ordinaryColdActionId(lead.id, step), source: LANDING_LINK_SOURCE.FOLLOWUP_2,
    priorAttempts: coldStepPriorAttempts(activities, lead.id, step), tracking: landingTrackingState(env),
  });
}

/** Positive-reply plan, or null for replies that don't carry the landing page. */
function staffingWarmReplyLandingPlan({ lead, inboundMessageId, action, activities = [], env = process.env }) {
  if (!lead || !isStaffingCampaign(lead) || !LANDING_REPLY_TEMPLATE[action]) return null;
  const actionId = responseActionId(lead.id, inboundMessageId, action);
  return planLandingLink({
    actionId, source: LANDING_LINK_SOURCE.POSITIVE_REPLY,
    priorAttempts: warmReplyPriorAttempts(activities, actionId), tracking: landingTrackingState(env),
  });
}

/** The issuance row for a tracked plan. Carries ids and categories only, never contact details. */
function buildIssuanceRecord({ plan, actionId, lead, triggerAction = null, campaignVersion = null, templateId, templateVersion, senderInboxId, isTest = null, env = process.env }) {
  if (!plan?.tracked) throw new Error('only a tracked landing link has an issuance');
  return {
    issuance_key: plan.issuanceKey,
    action_id: String(actionId),
    token_hash: plan.tokenHash,
    token_key_version: plan.keyVersion,
    lead_id: String(lead.id),
    source: plan.source,
    trigger_action: triggerAction,
    campaign_id: STAFFING_CAMPAIGN.id,
    campaign_version: campaignVersion || null,
    template_id: String(templateId || ''),
    template_version: String(templateVersion || ''),
    sender_inbox_id: String(senderInboxId || ''),
    // The reconciler passes isTest from the recipient's domain; the send path derives it.
    is_test: typeof isTest === 'boolean' ? isTest : isTestRecipient(lead.email, env),
  };
}

function warmReplyTemplate(action) {
  return { templateId: WARM_REPLY_TEMPLATE_ID, templateVersion: LANDING_REPLY_TEMPLATE[action] || '' };
}

/** Provider ids from a Gmail send result or a recovered send. */
function providerIds(result) {
  const data = result?.data || result || {};
  return { providerMessageId: String(data.id || data.providerMessageId || ''), providerThreadId: String(data.threadId || '') };
}

/**
 * Best-effort issuance write before the pre-send reservation.
 * @returns { proceed, stored, reason } — proceed is false ONLY when the stored
 *          row contradicts this render (a different key version or token).
 */
async function ensureLandingIssuance({ plan, record, issue = store.issueLandingLink, logger = console }) {
  if (!plan?.tracked || !record) return { proceed: true, stored: false, reason: 'untracked' };
  let result;
  try { result = await issue(record); } catch (error) { result = { ok: false, error: error?.message || 'issuance failed' }; }
  if (!result?.ok) {
    logger.warn(`[landing-link] issuance write deferred for ${record.issuance_key} (${result?.error || 'unknown'}); the reconciler will rebuild it`);
    return { proceed: true, stored: false, reason: result?.error || 'issuance write failed' };
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  const conflict = issuanceConflict(plan, row);
  if (conflict) {
    logger.error(JSON.stringify({ event: 'LANDING_LINK_ISSUANCE_CONFLICT', issuance_key: record.issuance_key, reason: conflict }));
    return { proceed: false, stored: true, reason: `landing link issuance conflict: ${conflict}` };
  }
  return { proceed: true, stored: true, reason: 'ok' };
}

/** Best-effort: make sure the issuance exists, then mark it sent. Never throws. */
async function recordLandingLinkSent({
  plan, record, sentAt, result, issue = store.issueLandingLink, markSent = store.markLandingLinkSent, logger = console,
}) {
  if (!plan?.tracked || !record) return { ok: true, skipped: true };
  try {
    const issued = await issue(record);
    if (issued?.ok) {
      const conflict = issuanceConflict(plan, Array.isArray(issued.data) ? issued.data[0] : issued.data);
      if (conflict) {
        logger.error(JSON.stringify({ event: 'LANDING_LINK_ISSUANCE_CONFLICT', issuance_key: record.issuance_key, reason: conflict }));
        return { ok: false, reason: conflict };
      }
    }
    const ids = providerIds(result);
    const marked = await markSent({
      issuance_key: record.issuance_key, sent_at: sentAt || new Date().toISOString(),
      provider_message_id: ids.providerMessageId || null, provider_thread_id: ids.providerThreadId || null,
    });
    if (!marked?.ok) {
      logger.warn(`[landing-link] sent marker deferred for ${record.issuance_key} (${marked?.error || 'unknown'}); the reconciler will apply it`);
      return { ok: false, reason: marked?.error || 'mark sent failed' };
    }
    return { ok: true };
  } catch (error) {
    logger.warn(`[landing-link] sent marker deferred for ${record.issuance_key} (${error?.message || 'error'})`);
    return { ok: false, reason: error?.message || 'error' };
  }
}

module.exports = {
  LANDING_REPLY_TEMPLATE, WARM_REPLY_TEMPLATE_ID,
  staffingColdStepLandingPlan, staffingWarmReplyLandingPlan, buildIssuanceRecord, warmReplyTemplate,
  providerIds, ensureLandingIssuance, recordLandingLinkSent,
};
