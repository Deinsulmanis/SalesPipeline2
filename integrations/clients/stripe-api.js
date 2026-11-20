'use strict';

/**
 * stripe-api.js — the few Stripe REST calls billing needs, over fetch.
 * ─────────────────────────────────────────────────────────────────────────────
 * No SDK dependency: Stripe's API is form-encoded REST, and webhook signatures
 * are an HMAC over `${timestamp}.${rawBody}`. Both are implemented here and
 * covered by tests.
 *
 * The key is STRIPE_SECRET_KEY: a RESTRICTED key (rk_...) limited to customers,
 * products, invoice items and invoices. A test-mode key bills nobody.
 * Error messages carry Stripe's error code and message, never the key or the
 * request body.
 */

const crypto = require('node:crypto');

const API = 'https://api.stripe.com';
const REQUEST_TIMEOUT_MS = 15000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

class StripeError extends Error {
  constructor(message, { status = 0, code = '', type = '' } = {}) {
    super(message); this.name = 'StripeError'; this.status = status; this.code = code || 'stripe_error'; this.type = type;
  }
}

/** Stripe's bracketed form encoding: a[b]=1, a[0][c]=2, expand[]=x. */
function formEncode(params = {}, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') parts.push(formEncode(item, `${name}[${index}]`));
        else parts.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      parts.push(formEncode(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

function createStripeClient({ secretKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const key = String(secretKey || '').trim();
  const mode = key.includes('_test_') ? 'test' : key.includes('_live_') ? 'live' : 'unknown';

  async function request(method, path, params, { idempotencyKey = '' } = {}) {
    if (!key) throw new StripeError('Stripe is not configured: STRIPE_SECRET_KEY is not set', { code: 'stripe_not_configured' });
    const body = params && method !== 'GET' ? formEncode(params) : '';
    const query = params && method === 'GET' ? formEncode(params) : '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API}${path}${query ? `?${query}` : ''}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Stripe-Version': '2024-06-20',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = data.error || {};
        throw new StripeError(`Stripe ${method} ${path.split('?')[0]} failed: ${err.message || `HTTP ${response.status}`}`,
          { status: response.status, code: err.code || '', type: err.type || '' });
      }
      return data;
    } catch (error) {
      if (error instanceof StripeError) throw error;
      throw new StripeError(error?.name === 'AbortError' ? `Stripe ${method} timed out after ${timeoutMs}ms` : `Stripe ${method} request failed`, { code: 'stripe_request_failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured: Boolean(key), mode,
    getCustomer: id => request('GET', `/v1/customers/${encodeURIComponent(id)}`, { expand: ['invoice_settings.default_payment_method'] }),
    setDefaultPaymentMethod: (customerId, paymentMethodId) => request('POST', `/v1/customers/${encodeURIComponent(customerId)}`,
      { invoice_settings: { default_payment_method: paymentMethodId } }),
    // Card setup: a Stripe-hosted page where the customer saves a card and
    // agrees to future charges. Nothing is charged here.
    createSetupCheckout: (params, opts) => request('POST', '/v1/checkout/sessions', params, opts),
    getSetupIntent: id => request('GET', `/v1/setup_intents/${encodeURIComponent(id)}`),
    // ScaleLab's own prospects (integrations/scalelab-billing.js).
    listPrices: () => request('GET', '/v1/prices', { active: true, limit: 100, expand: ['data.product'] }),
    searchCustomers: query => request('GET', '/v1/customers/search', { query, limit: 100, expand: ['data.invoice_settings.default_payment_method'] }),
    createCustomer: (params, opts) => request('POST', '/v1/customers', params, opts),
    listInvoices: customerId => request('GET', '/v1/invoices', { customer: customerId, limit: 20 }),
    updateInvoice: (id, params, opts) => request('POST', `/v1/invoices/${encodeURIComponent(id)}`, params, opts),
    payInvoice: (id, opts) => request('POST', `/v1/invoices/${encodeURIComponent(id)}/pay`, {}, opts),
    voidInvoice: (id, opts) => request('POST', `/v1/invoices/${encodeURIComponent(id)}/void`, {}, opts),
    createInvoice: (params, opts) => request('POST', '/v1/invoices', params, opts),
    createInvoiceItem: (params, opts) => request('POST', '/v1/invoiceitems', params, opts),
    getInvoice: id => request('GET', `/v1/invoices/${encodeURIComponent(id)}`),
    finalizeInvoice: (id, opts) => request('POST', `/v1/invoices/${encodeURIComponent(id)}/finalize`, { auto_advance: false }, opts),
    sendInvoice: (id, opts) => request('POST', `/v1/invoices/${encodeURIComponent(id)}/send`, {}, opts),
    deleteDraftInvoice: id => request('DELETE', `/v1/invoices/${encodeURIComponent(id)}`),
  };
}

/**
 * Verify a Stripe-Signature header against the RAW request body.
 * Returns the parsed event, or throws StripeError('invalid_signature').
 */
function verifyWebhook(rawBody, signatureHeader, secret, { toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS, now = Date.now() } = {}) {
  if (!secret) throw new StripeError('STRIPE_WEBHOOK_SECRET is not set', { code: 'webhook_not_configured' });
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const fields = String(signatureHeader || '').split(',').map(part => part.trim().split('='));
  const timestamp = Number((fields.find(([k]) => k === 't') || [])[1]);
  const signatures = fields.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean);
  if (!Number.isFinite(timestamp) || !signatures.length) throw new StripeError('missing or malformed Stripe-Signature header', { code: 'invalid_signature' });
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) throw new StripeError('Stripe signature timestamp is outside the tolerance', { code: 'invalid_signature' });
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  const ok = signatures.some(sig => sig.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8')));
  if (!ok) throw new StripeError('Stripe signature does not match', { code: 'invalid_signature' });
  try { return JSON.parse(payload); } catch (_) { throw new StripeError('Stripe webhook body is not JSON', { code: 'invalid_payload' }); }
}

/** Test helper and documentation of the scheme. */
function signWebhookPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

module.exports = { StripeError, formEncode, createStripeClient, verifyWebhook, signWebhookPayload };
