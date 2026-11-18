'use strict';

/**
 * scalelab-billing.js — ScaleLab bills its own new clients (the tech fee) from
 * the Bookings tracker, after a meeting.
 * ─────────────────────────────────────────────────────────────────────────────
 * Separate from integrations/clients/billing.js, which bills a managed client
 * (Jole) for qualified meetings through the client ledger. Here the prospect is
 * a ScaleLab Pipeline lead; Stripe is the only record, so there is no table:
 *
 *   - a Stripe customer per lead, found by metadata sp2_lead_id, created on
 *     first use with the lead's email;
 *   - the products and prices are whatever is active in Stripe (the tech fee
 *     products already exist there), chosen per bill;
 *   - email an invoice, create a card setup link, or charge the saved card.
 *
 * Every action is an operator POST; nothing here runs on a schedule. The same
 * STRIPE_BILLING_ENABLED switch and restricted key as client billing.
 */

const text = value => String(value == null ? '' : value).trim();
const isoFromUnix = seconds => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KIND = 'scalelab_prospect';

class ScaleLabBillingError extends Error {
  constructor(code, message) { super(message); this.name = 'ScaleLabBillingError'; this.code = code; }
}
const fail = (code, message) => { throw new ScaleLabBillingError(code, message); };

function scalelabBillingConfig(env = process.env) {
  const enabled = text(env.STRIPE_BILLING_ENABLED).toLowerCase() === 'true';
  const key = text(env.STRIPE_SECRET_KEY);
  const appUrl = text(env.PUBLIC_APP_URL || 'https://salespipeline2-production.up.railway.app').replace(/\/+$/, '');
  return {
    enabled, configured: Boolean(key), ready: enabled && Boolean(key),
    mode: key.includes('_test_') ? 'test' : key.includes('_live_') ? 'live' : (key ? 'unknown' : 'none'),
    appUrl, defaultDaysUntilDue: 7,
    reason: !key ? 'STRIPE_SECRET_KEY is not set' : (enabled ? 'ready' : 'STRIPE_BILLING_ENABLED is off'),
  };
}

function cardSummary(customer) {
  const pm = customer?.invoice_settings?.default_payment_method;
  if (!pm || typeof pm !== 'object' || !pm.card) return null;
  return { brand: text(pm.card.brand), last4: text(pm.card.last4), expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
}

function invoiceSummary(invoice) {
  const line = invoice.lines?.data?.[0];
  return {
    id: invoice.id, number: text(invoice.number), status: text(invoice.status), collection: text(invoice.collection_method),
    amountCents: Number.isInteger(invoice.total) ? invoice.total : Number(invoice.amount_due) || 0, currency: text(invoice.currency),
    hostedUrl: text(invoice.hosted_invoice_url), createdAt: isoFromUnix(invoice.created),
    paidAt: isoFromUnix(invoice.status_transitions?.paid_at), dueAt: isoFromUnix(invoice.due_date),
    description: text(line?.description || invoice.description),
  };
}

/**
 * @param deps { stripe (stripe-api client), findLead(leadId) → { id, email, first, last, company } | null, env, log }
 */
function createScaleLabBilling({ stripe, findLead, env = process.env, log = console }) {
  const ready = () => {
    const cfg = scalelabBillingConfig(env);
    if (!cfg.configured) fail('billing_not_configured', cfg.reason);
    if (!cfg.enabled) fail('billing_disabled', cfg.reason);
    return cfg;
  };

  async function leadOrFail(leadId) {
    const lead = await findLead(text(leadId));
    if (!lead) fail('lead_not_found', `Pipeline lead ${leadId} was not found`);
    return lead;
  }

  async function customerFor(lead, { email = '', create = true } = {}) {
    const id = text(lead.id).replace(/'/g, '');
    const found = (await stripe.searchCustomers(`metadata['sp2_lead_id']:'${id}'`)).data || [];
    if (found.length) return found[0];
    if (!create) return null;
    const address = text(email || lead.email).toLowerCase();
    if (!EMAIL.test(address)) fail('email_required', 'this lead has no valid email address to bill');
    const name = [text(lead.first), text(lead.last)].filter(Boolean).join(' ') || text(lead.contactName) || address;
    return stripe.createCustomer({
      email: address, name, description: text(lead.company) || undefined, preferred_locales: ['en-US'],
      metadata: { source: 'salespipeline2', kind: KIND, sp2_lead_id: id, company: text(lead.company).slice(0, 450) },
    }, { idempotencyKey: `sp2:sl:cus:${id}` });
  }

  async function priceOrFail(priceId) {
    const prices = await activePrices();
    const price = prices.find(item => item.priceId === text(priceId));
    if (!price) fail('price_not_found', 'choose an active one-time price from your Stripe products');
    return price;
  }

  /** Active one-time prices of active products, for the Bill dialog. */
  async function activePrices() {
    const data = (await stripe.listPrices()).data || [];
    return data
      .filter(price => price.active && price.type === 'one_time' && price.product && typeof price.product === 'object' && price.product.active)
      .map(price => ({
        priceId: price.id, productId: price.product.id, productName: text(price.product.name),
        description: text(price.product.description), amountCents: price.unit_amount, currency: text(price.currency),
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  async function draftInvoice({ lead, customer, price, collection, daysUntilDue, nonce }) {
    const key = `sp2:sl:${collection}:${text(lead.id)}:${price.priceId}:${text(nonce) || Date.now()}`;
    const invoice = await stripe.createInvoice({
      customer: customer.id,
      ...(collection === 'charge_automatically' ? { collection_method: 'charge_automatically' } : { collection_method: 'send_invoice', days_until_due: daysUntilDue }),
      auto_advance: false, pending_invoice_items_behavior: 'exclude', currency: price.currency,
      description: price.productName,
      metadata: { source: 'salespipeline2', kind: 'scalelab_tech_fee', sp2_lead_id: text(lead.id) },
    }, { idempotencyKey: `${key}:inv` });
    await stripe.createInvoiceItem({ customer: customer.id, invoice: invoice.id, price: price.priceId, quantity: 1 },
      { idempotencyKey: `${key}:item` });
    return { invoice, key };
  }

  return {
    config: () => scalelabBillingConfig(env),
    prices: async () => { ready(); return activePrices(); },

    /** Billing state per Pipeline lead: card on file and recent invoices. */
    async overview() {
      const cfg = scalelabBillingConfig(env);
      if (!cfg.ready) return { ...cfg, leads: {} };
      const customers = (await stripe.searchCustomers(`metadata['kind']:'${KIND}'`)).data || [];
      const leads = {};
      for (const customer of customers) {
        const leadId = text(customer.metadata?.sp2_lead_id);
        if (!leadId) continue;
        const invoices = ((await stripe.listInvoices(customer.id)).data || []).filter(item => item.status !== 'draft');
        leads[leadId] = { customerId: customer.id, email: text(customer.email), card: cardSummary(customer), invoices: invoices.map(invoiceSummary) };
      }
      return { ...cfg, leads };
    },

    /** Email the client an invoice to pay. */
    async emailInvoice({ leadId, priceId, daysUntilDue, email, nonce }) {
      const cfg = ready();
      const lead = await leadOrFail(leadId);
      const price = await priceOrFail(priceId);
      const customer = await customerFor(lead, { email });
      const days = Math.max(1, Math.min(60, Number(daysUntilDue) || cfg.defaultDaysUntilDue));
      const { invoice, key } = await draftInvoice({ lead, customer, price, collection: 'send_invoice', daysUntilDue: days, nonce });
      await stripe.finalizeInvoice(invoice.id, { idempotencyKey: `${key}:fin` });
      const sent = await stripe.sendInvoice(invoice.id, { idempotencyKey: `${key}:send` });
      log.info?.(`[scalelab-billing] ${leadId}: invoice ${sent.id} emailed (${price.productName})`);
      return invoiceSummary(sent);
    },

    /** A Stripe page where the client saves a card. Nothing is charged. */
    async cardSetupLink({ leadId, email }) {
      const cfg = ready();
      const lead = await leadOrFail(leadId);
      const customer = await customerFor(lead, { email });
      const session = await stripe.createSetupCheckout({
        mode: 'setup', customer: customer.id, currency: 'usd', payment_method_types: ['card'],
        success_url: `${cfg.appUrl}/billing/card-saved`, cancel_url: `${cfg.appUrl}/billing/card-saved?cancelled=1`,
        metadata: { source: 'salespipeline2', kind: KIND, sp2_lead_id: text(lead.id), purpose: 'card_on_file' },
        setup_intent_data: { metadata: { source: 'salespipeline2', kind: KIND, sp2_lead_id: text(lead.id) }, description: `${text(lead.company) || 'Client'}: card on file for ScaleLab AI` },
      });
      return { url: session.url, expiresAt: isoFromUnix(session.expires_at) };
    },

    /** Charge the client's saved card now; Stripe emails the paid invoice. */
    async chargeCard({ leadId, priceId, nonce }) {
      ready();
      const lead = await leadOrFail(leadId);
      const price = await priceOrFail(priceId);
      const customer = await customerFor(lead, { create: false });
      if (!customer || !cardSummary(customer)) fail('no_card_on_file', 'this client has no card on file; send a card setup link first');
      const { invoice, key } = await draftInvoice({ lead, customer, price, collection: 'charge_automatically', nonce });
      await stripe.finalizeInvoice(invoice.id, { idempotencyKey: `${key}:fin` });
      try {
        const paid = await stripe.payInvoice(invoice.id, { idempotencyKey: `${key}:pay` });
        log.info?.(`[scalelab-billing] ${leadId}: charged ${paid.id} (${price.productName})`);
        return invoiceSummary(paid);
      } catch (error) {
        // The open invoice stays in Stripe (and in the overview) to retry or void there.
        fail('charge_failed', `charge failed: ${error.message.replace(/^Stripe POST \S+ failed: /, '')}`);
      }
    },

    /** checkout.session.completed for a ScaleLab prospect's card setup. */
    async handleEvent(event) {
      const session = event?.data?.object || {};
      if (event?.type !== 'checkout.session.completed' || session.mode !== 'setup'
        || session.metadata?.source !== 'salespipeline2' || session.metadata?.kind !== KIND) {
        return { ok: true, ignored: true };
      }
      const intentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
      if (!intentId) return { ok: true, ignored: true, reason: 'no setup intent' };
      const intent = await stripe.getSetupIntent(intentId);
      const pm = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
      if (intent.status !== 'succeeded' || !pm || !session.customer) return { ok: true, ignored: true, reason: `setup intent is ${intent.status}` };
      await stripe.setDefaultPaymentMethod(text(session.customer), pm);
      return { ok: true, cardSaved: true, leadId: text(session.metadata?.sp2_lead_id) };
    },
  };
}

module.exports = { KIND, scalelabBillingConfig, createScaleLabBilling, ScaleLabBillingError };
