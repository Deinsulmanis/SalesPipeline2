'use strict';

function isDefinitePreDeliveryFailure(error) {
  if (!error) return false;
  if (error.code === 'durable_checkpoint_failed') return false;
  if (error.code === 'lock_database_unavailable' || error.code === 'lock_schema_missing') return false;
  if (error.code === 'send_lock_required' || error.code === 'send_lock_action_required') return false;
  const status = Number(error.response?.status || error.code);
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

function providerIdsFromResult(result) {
  const data = result && typeof result === 'object' ? (result.data || result) : {};
  const leadId = Array.isArray(data.lead_ids) ? data.lead_ids[0] : '';
  return {
    providerMessageId: String(data.id || data.providerMessageId || data.messageId || leadId || '').trim() || null,
    providerThreadId: String(data.threadId || data.providerThreadId || '').trim() || null,
  };
}

module.exports = { isDefinitePreDeliveryFailure, providerIdsFromResult };
