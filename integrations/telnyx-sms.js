'use strict';
// Owner alert SMS through the Telnyx Messaging API v2. Configuration only from
// the environment; the owner's number never appears in the repository.
//   TELNYX_API_KEY, TELNYX_FROM_NUMBER, OWNER_ALERT_SMS_TO, TELNYX_MESSAGING_PROFILE_ID (optional)

const ENDPOINT = 'https://api.telnyx.com/v2/messages';
const E164 = /^\+[1-9]\d{7,14}$/;

function telnyxConfig(env = process.env) {
  const apiKey = String(env.TELNYX_API_KEY || '').trim();
  const from = String(env.TELNYX_FROM_NUMBER || '').trim();
  const to = String(env.OWNER_ALERT_SMS_TO || '').trim();
  const profileId = String(env.TELNYX_MESSAGING_PROFILE_ID || '').trim();
  const missing = [!apiKey && 'TELNYX_API_KEY', !E164.test(from) && 'TELNYX_FROM_NUMBER', !E164.test(to) && 'OWNER_ALERT_SMS_TO'].filter(Boolean);
  return { ok: missing.length === 0, missing, apiKey, from, to, profileId };
}

/** One send attempt. Resolves { sent, id } or { sent: false, reason }; never throws. */
async function sendOwnerSms(text, { env = process.env, fetchImpl = global.fetch } = {}) {
  const config = telnyxConfig(env);
  if (!config.ok) return { sent: false, reason: `sms_unconfigured:${config.missing.join(',')}` };
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ from: config.from, to: config.to, text: String(text).slice(0, 600),
        ...(config.profileId ? { messaging_profile_id: config.profileId } : {}) }),
    });
    if (!response.ok) return { sent: false, reason: `telnyx_http_${response.status}` };
    const data = await response.json().catch(() => ({}));
    return { sent: true, id: data?.data?.id || null };
  } catch (error) {
    return { sent: false, reason: /timeout|abort/i.test(error.name || '') ? 'telnyx_timeout' : 'telnyx_network' };
  }
}

module.exports = { ENDPOINT, telnyxConfig, sendOwnerSms };
