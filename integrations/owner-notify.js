'use strict';
// Owner push notification (ntfy-compatible: POST plain text to a topic URL).
// Optional: with OWNER_PUSH_URL unset it reports push_unconfigured and the
// dashboard task remains the record. A failed push never fails the caller.

async function notifyOwner({ title, message, env = process.env, fetchImpl = global.fetch } = {}) {
  const url = String(env.OWNER_PUSH_URL || '').trim();
  if (!url) return { sent: false, reason: 'push_unconfigured' };
  if (!/^https:\/\//i.test(url)) return { sent: false, reason: 'push_url_not_https' };
  try {
    const token = String(env.OWNER_PUSH_TOKEN || '').trim();
    const response = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: String(title || 'SalesPipeline').slice(0, 120),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: String(message || '').slice(0, 1000) });
    return response.ok ? { sent: true } : { sent: false, reason: `push_http_${response.status}` };
  } catch (error) {
    return { sent: false, reason: 'push_failed' };
  }
}

module.exports = { notifyOwner };
