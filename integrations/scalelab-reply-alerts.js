'use strict';
// Fast reply mode: queue routed ScaleLab replies for the reply screen, attach
// a draft, and alert the owner (Telnyx SMS + optional ntfy push). At most one
// SMS per reply; quiet hours 21:00–06:00 Pacific queue the alert for 06:00.
// Every failure is logged and retried once; nothing here can block or change
// reply processing, and nothing here sends email.
const { ALERT_INTENTS, fastReplyConfig, nextAlertTime, replyLink, smsText, smsLeaksPersonal, isRecent } = require('./scalelab-fast-reply');

function namesFor(lead = {}) {
  let notes = {};
  try { notes = String(lead.campaign_notes || '').trim().startsWith('{') ? JSON.parse(lead.campaign_notes) : {}; } catch (_) { notes = {}; }
  return {
    firstName: notes.var_first_name || notes.first_name || String(lead.contactName || lead.contact_name || '').trim().split(/\s+/)[0] || '',
    company: notes.var_company || lead.company || '',
  };
}

/**
 * Called after the ScaleLab routing step. records: routing rows (action_id,
 * lead_id, message_id, mailbox_id, received_at, step, verdict); threads: by
 * action id, { threadId, text } of the inbound (text only feeds the drafter).
 */
async function queueRoutedReplies({ records, leads, threads, store, drafter = null, now = new Date(), env = process.env, log = () => {} }) {
  const config = fastReplyConfig(env);
  if (!config.enabled) return [];
  const byLead = new Map(leads.map(lead => [lead.id, lead]));
  const queued = [];
  for (const record of records) {
    const intent = record.verdict?.intent;
    if (record.mode !== 'apply' || record.step !== 'complete' || !ALERT_INTENTS.includes(intent)) continue;
    if (!isRecent(record.received_at, now)) continue;
    const thread = threads.get(record.action_id);
    if (!thread?.threadId) continue;
    // Already answered (a human reply went out after this inbound): nothing to alert.
    if (thread.answered) continue;
    try {
      const { firstName, company } = namesFor(byLead.get(record.lead_id));
      let row = await store.enqueue({ action_id: record.action_id, lead_id: record.lead_id, message_id: record.message_id,
        thread_id: thread.threadId, mailbox_id: record.mailbox_id, intent, received_at: record.received_at,
        first_name: firstName, company, state: thread.state || null,
        alert_status: config.smsEnabled || env.OWNER_PUSH_URL ? 'pending' : 'disabled',
        alert_send_after: nextAlertTime(now).toISOString() });
      if (row && !row.draft_text && drafter) {
        try {
          const draft = await drafter({ intent, inboundText: thread.text || '', firstName, company });
          if (draft?.text) {
            row = (await store.transition(record.action_id, { status: 'pending', draft_text: null },
              { draft_text: draft.text, draft_source: draft.source || 'drafter_v0', draft_updated_at: now.toISOString() })) || row;
          }
        } catch (error) { log(`draft failed for ${record.action_id}: ${error.message}`); }
      }
      queued.push(row);
    } catch (error) {
      log(`reply queue unavailable for ${record.action_id}: ${error.message}`);
    }
  }
  return queued;
}

/**
 * Send the owner alerts that are due. Claim (pending|queued -> sending) by
 * compare-and-set so one SMS per reply even with two workers; on failure
 * retry once, then mark failed. The push goes out with the SMS attempt.
 */
async function dispatchDueAlerts({ store, sendSms, notify, now = new Date(), env = process.env, log = () => {} }) {
  const config = fastReplyConfig(env);
  if (!config.enabled) return [];
  const results = [];
  let due;
  try { due = await store.listAlertsDue(now); } catch (error) { log(`alert queue unavailable: ${error.message}`); return results; }
  for (const row of due) {
    const sendAfter = Date.parse(row.alert_send_after || '');
    if (Number.isFinite(sendAfter) && sendAfter > now.getTime()) continue;
    if (nextAlertTime(now).getTime() > now.getTime()) {   // quiet hours: hold until 06:00
      if (row.alert_status === 'pending') await store.transition(row.action_id, { alert_status: 'pending' },
        { alert_status: 'queued', alert_send_after: nextAlertTime(now).toISOString() }).catch(() => null);
      continue;
    }
    const claimed = await store.transition(row.action_id, { alert_status: row.alert_status, alert_attempts: row.alert_attempts },
      { alert_status: 'sending', alert_attempts: (row.alert_attempts || 0) + 1 }).catch(() => null);
    if (!claimed) continue;
    const text = smsText({ firstName: row.first_name, company: row.company, intent: row.intent, link: replyLink(config.dashboardUrl, row.action_id) });
    if (smsLeaksPersonal(text, {})) {
      await store.transition(row.action_id, { alert_status: 'sending' }, { alert_status: 'failed', alert_detail: { reason: 'sms_text_refused' } }).catch(() => null);
      continue;
    }
    let sms = { sent: false, reason: 'sms_disabled' };
    if (config.smsEnabled) {
      sms = await sendSms(text);
      if (!sms.sent) { log(`sms failed for ${row.action_id}: ${sms.reason}; retrying once`); sms = await sendSms(text); }
    }
    const push = env.OWNER_PUSH_URL ? await notify({ title: 'ScaleLab reply', message: text }).catch(() => ({ sent: false })) : { sent: false, reason: 'push_unconfigured' };
    const delivered = sms.sent || push.sent;
    const final = await store.transition(row.action_id, { alert_status: 'sending' }, {
      alert_status: delivered ? 'sent' : 'failed',
      alert_detail: { sms: sms.sent ? 'sent' : sms.reason, smsId: sms.id || null, push: push.sent ? 'sent' : (push.reason || 'failed'), at: now.toISOString() },
    }).catch(() => null);
    if (!delivered) log(`owner alert failed for ${row.action_id}: sms ${sms.reason}, push ${push.reason || 'failed'}`);
    results.push(final || { action_id: row.action_id, alert_status: delivered ? 'sent' : 'failed' });
  }
  return results;
}

module.exports = { namesFor, queueRoutedReplies, dispatchDueAlerts };
