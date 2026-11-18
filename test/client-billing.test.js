'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formEncode, verifyWebhook, signWebhookPayload, createStripeClient } = require('../integrations/clients/stripe-api');
const {
  clientBillingConfig, periodKeyFor, isScheduledDay, lineDescription, createBillingService,
} = require('../integrations/clients/billing');
const ledger = require('../integrations/clients/ledger');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

let restoreActivation;
test.before(() => { restoreActivation = activateJoleForTest(); });
test.after(() => restoreActivation());

const ENV = Object.freeze({
  STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'rk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  JOLE_STRIPE_CUSTOMER_ID: 'cus_jorge', JOLE_STRIPE_PRODUCT_ID: '',
});
const joleLead = (id, extra = {}) => ({
  id, company: 'American Steel Fab', contactName: 'Clifford Thornberry', email: `${id}@asf-test.invalid`,
  leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', senderInboxId: '', tradeType: '', ...extra,
});
const QUALIFIED = {
  attendee_name: 'Clifford Thornberry', attendee_title: 'Plant Manager', attendee_status: 'decision_maker',
  employer_fit: 'fit', decision_areas: ['operations', 'hiring'], use_case: 'current',
  qualification_basis: 'Runs the fabrication floor; needs 4 welders for a Q1 backlog.',
};

async function qualifiedMeeting(store, leadId) {
  const m = await ledger.recordMeetingBooked(store, {
    clientId: 'jole', lead: joleLead(leadId), bookedAt: '2026-11-13T13:15:15Z', scheduledFor: '2026-11-16T21:30:00Z',
    attendee: { attendee_name: 'Clifford Thornberry' },
  });
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: m.meeting_id, toStatus: 'HELD', patch: { held_at: '2026-11-16T22:00:00Z' } });
  return ledger.updateMeeting(store, { clientId: 'jole', meetingId: m.meeting_id, toStatus: 'QUALIFIED_HELD', patch: QUALIFIED });
}

/** A Stripe stand-in that keeps invoices the way Stripe does. */
function fakeStripe({ card = null, decline = false } = {}) {
  const invoices = new Map();
  const calls = [];
  const byKey = new Map();
  let n = 0;
  const state = { card, decline, defaultPm: card ? 'pm_saved' : null };
  const api = {
    calls, invoices, state,
    async createInvoice(params, { idempotencyKey } = {}) {
      calls.push(['createInvoice', params, idempotencyKey]);
      if (byKey.has(idempotencyKey)) return { ...invoices.get(byKey.get(idempotencyKey)) };
      const inv = { id: `in_${++n}`, status: 'draft', total: 0, livemode: false, currency: params.currency, metadata: params.metadata,
        collection_method: params.collection_method, lines: [] };
      invoices.set(inv.id, inv); byKey.set(idempotencyKey, inv.id);
      return { ...inv };
    },
    async createInvoiceItem(params, { idempotencyKey } = {}) {
      calls.push(['createInvoiceItem', params, idempotencyKey]);
      const inv = invoices.get(params.invoice);
      if (!inv.lines.includes(idempotencyKey)) { inv.lines.push(idempotencyKey); inv.total += params.amount ?? 35000 * (params.quantity || 1); }
      return { id: `ii_${inv.lines.length}` };
    },
    async updateInvoice(id, params) { calls.push(['updateInvoice', id, params]); Object.assign(invoices.get(id), params); return { ...invoices.get(id) }; },
    async payInvoice(id, { idempotencyKey } = {}) {
      calls.push(['payInvoice', id, idempotencyKey]);
      if (state.decline) {
        Object.assign(invoices.get(id), { attempted: true });
        throw Object.assign(new Error(`Stripe POST /v1/invoices/${id}/pay failed: Your card was declined.`), { code: 'card_declined', status: 402 });
      }
      Object.assign(invoices.get(id), { status: 'paid', status_transitions: { paid_at: 1795100000 } });
      return { ...invoices.get(id) };
    },
    async voidInvoice(id) { calls.push(['voidInvoice', id]); Object.assign(invoices.get(id), { status: 'void', status_transitions: { voided_at: 1795100000 } }); return { ...invoices.get(id) }; },
    async getCustomer() {
      return { id: 'cus_jorge', invoice_settings: { default_payment_method: state.card ? { id: state.defaultPm, card: state.card } : null } };
    },
    async createSetupCheckout(params) { calls.push(['createSetupCheckout', params]); return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', expires_at: 1795200000 }; },
    async getSetupIntent(id) { return { id, status: 'succeeded', payment_method: 'pm_new' }; },
    async setDefaultPaymentMethod(customerId, pm) {
      calls.push(['setDefaultPaymentMethod', customerId, pm]);
      state.defaultPm = pm; state.card = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
      return { id: customerId };
    },
    async getInvoice(id) {
      if (!invoices.has(id)) throw Object.assign(new Error('No such invoice'), { code: 'resource_missing' });
      return { ...invoices.get(id) };
    },
    async finalizeInvoice(id) {
      calls.push(['finalizeInvoice', id]);
      Object.assign(invoices.get(id), { status: 'open', number: 'ABCD-0001', hosted_invoice_url: `https://invoice.stripe.test/${id}`, due_date: 1795000000 });
      return { ...invoices.get(id) };
    },
    async sendInvoice(id) { calls.push(['sendInvoice', id]); return { ...invoices.get(id) }; },
    async deleteDraftInvoice(id) { calls.push(['deleteDraftInvoice', id]); invoices.delete(id); return { id, deleted: true }; },
    pay(id) { Object.assign(invoices.get(id), { status: 'paid', status_transitions: { paid_at: 1795100000 } }); },
    void(id) { Object.assign(invoices.get(id), { status: 'void', status_transitions: { voided_at: 1795100000 } }); },
  };
  return api;
}

function harness(env = ENV, stripeOptions = {}) {
  const store = createMemoryLedgerStore();
  const stripe = fakeStripe(stripeOptions);
  const billing = createBillingService({ env, stripe, getStore: () => store, now: () => '2026-11-16T23:00:00.000Z', log: { warn() {}, info() {} } });
  return { store, stripe, billing };
}

// ── stripe-api ───────────────────────────────────────────────────────────────

test('stripe-api: nested form encoding matches Stripe\'s bracket syntax', () => {
  assert.equal(formEncode({ customer: 'cus_1', metadata: { client_id: 'jole' }, price_data: { unit_amount: 35000 } }),
    'customer=cus_1&metadata%5Bclient_id%5D=jole&price_data%5Bunit_amount%5D=35000');
  assert.equal(formEncode({ expand: ['lines'], skip: undefined }), 'expand%5B%5D=lines');
});

test('stripe-api: webhook signatures are verified against the raw body, with a time window', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const now = Date.parse('2026-11-16T23:00:00Z');
  const header = signWebhookPayload(body, 'whsec_test', Math.floor(now / 1000));
  assert.equal(verifyWebhook(Buffer.from(body), header, 'whsec_test', { now }).id, 'evt_1');
  assert.throws(() => verifyWebhook(body, header, 'whsec_other', { now }), { code: 'invalid_signature' });
  assert.throws(() => verifyWebhook(body.replace('paid', 'voided'), header, 'whsec_test', { now }), { code: 'invalid_signature' });
  assert.throws(() => verifyWebhook(body, header, 'whsec_test', { now: now + 10 * 60000 }), { code: 'invalid_signature' });
  assert.throws(() => verifyWebhook(body, header, '', { now }), { code: 'webhook_not_configured' });
});

test('stripe-api: errors never carry the key; test and live keys are told apart', async () => {
  const client = createStripeClient({ secretKey: 'rk_live_secret123', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key', code: 'api_key_invalid' } }) }) });
  assert.equal(client.mode, 'live');
  await assert.rejects(client.getInvoice('in_1'), error => !error.message.includes('rk_live_secret123') && error.code === 'api_key_invalid');
  assert.equal(createStripeClient({ secretKey: 'rk_test_x' }).mode, 'test');
});

// ── configuration and pure rules ─────────────────────────────────────────────

test('config: off without the flag, unconfigured without key or customer, never exposes the key', () => {
  assert.equal(clientBillingConfig('jole', { ...ENV, STRIPE_BILLING_ENABLED: '' }).ready, false);
  assert.deepEqual(clientBillingConfig('jole', { STRIPE_BILLING_ENABLED: 'true' }).missing, ['STRIPE_SECRET_KEY', 'JOLE_STRIPE_CUSTOMER_ID']);
  const cfg = clientBillingConfig('jole', ENV);
  assert.equal(cfg.ready, true);
  assert.equal(cfg.currency, 'usd');
  assert.equal(cfg.daysUntilDue, 7);
  assert.equal(cfg.mode, 'test');
  assert.equal(JSON.stringify(cfg).includes('rk_test_example'), false);
  assert.equal(clientBillingConfig('scalelab', ENV).supported, false);
});

test('periods: 1st–14th belong to the 1st, 15th–end to the 15th, in Vancouver time', () => {
  assert.equal(periodKeyFor('2026-12-01T15:00:00Z'), '2026-12-01');
  assert.equal(periodKeyFor('2026-12-14T20:00:00Z'), '2026-12-01');
  assert.equal(periodKeyFor('2026-12-15T20:00:00Z'), '2026-12-15');
  // 00:30 UTC on the 1st is still the 30th in Vancouver.
  assert.equal(periodKeyFor('2026-12-01T00:30:00Z'), '2026-11-15');
  assert.equal(isScheduledDay('2026-12-15T18:00:00Z'), true);
  assert.equal(isScheduledDay('2026-12-16T18:00:00Z'), false);
});

test('line description names the attendee, employer and held date', () => {
  assert.equal(lineDescription({ attendee_name: 'Clifford Thornberry', held_at: '2026-11-16T22:00:00Z' },
    { label: 'Qualified meeting', employer: 'American Steel Fab', timeZone: 'America/Vancouver' }),
  'Qualified meeting: Clifford Thornberry, American Steel Fab, held Nov 16, 2026');
});

// ── the invoice lifecycle ────────────────────────────────────────────────────

test('draft → send → paid: lines, links and statuses follow Stripe', async () => {
  const { store, stripe, billing } = harness();
  const m = await qualifiedMeeting(store, 'lead-1');
  assert.equal((await billing.unbilled('jole')).length, 1);

  const draft = await billing.createDraft({ clientId: 'jole', by: 'deins' });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.amount_cents, 35000);
  assert.deepEqual(draft.meeting_ids, [m.meeting_id]);
  const created = stripe.calls.find(c => c[0] === 'createInvoice')[1];
  // Jole drafts are made for charging the saved card; "send" switches to pay-by-invoice.
  assert.equal(created.collection_method, 'charge_automatically');
  assert.equal(created.days_until_due, undefined);
  assert.equal(created.auto_advance, false);
  assert.equal(created.pending_invoice_items_behavior, 'exclude');
  assert.equal(created.metadata.source, 'salespipeline2');
  const line = stripe.calls.find(c => c[0] === 'createInvoiceItem')[1];
  assert.equal(line.amount, 35000);
  assert.equal(line.metadata.meeting_id, m.meeting_id);
  assert.equal(stripe.calls.some(c => c[0] === 'sendInvoice'), false, 'a draft is never sent by itself');

  // Nothing left to bill; the meeting cannot be re-verdicted while on a draft.
  await assert.rejects(billing.createDraft({ clientId: 'jole' }), { code: 'nothing_to_bill' });
  await assert.rejects(ledger.updateMeeting(store, { clientId: 'jole', meetingId: m.meeting_id, toStatus: 'DISQUALIFIED_HELD', patch: { qualification_basis: 'x' } }), { code: 'meeting_on_invoice' });
  await assert.rejects(ledger.setInvoiceStatus(store, { clientId: 'jole', meetingId: m.meeting_id, invoiceStatus: 'paid' }), { code: 'meeting_on_stripe_invoice' });

  const sent = await billing.send({ clientId: 'jole', invoiceId: draft.invoice_id, by: 'deins' });
  assert.equal(sent.status, 'open');
  assert.equal(sent.invoice_number, 'ABCD-0001');
  assert.equal(sent.collection_method, 'send_invoice');
  assert.deepEqual(stripe.calls.find(c => c[0] === 'updateInvoice')[2], { collection_method: 'send_invoice', days_until_due: 7 });
  assert.equal((await store.getMeeting('jole', m.meeting_id)).invoice_status, 'invoiced');

  stripe.pay(draft.invoice_id);
  const result = await billing.handleEvent({ type: 'invoice.paid', data: { object: { id: draft.invoice_id, metadata: { source: 'salespipeline2', client_id: 'jole' } } } });
  assert.equal(result.status, 'paid');
  const paid = await store.getMeeting('jole', m.meeting_id);
  assert.equal(paid.invoice_status, 'paid');
  assert.ok(paid.paid_at);
  const status = await billing.status('jole');
  assert.equal(status.totals.paidCents, 35000);
  assert.equal(status.totals.unbilledCents, 0);
});

test('discard and void return the meetings to "ready to bill"', async () => {
  const { store, stripe, billing } = harness();
  const m = await qualifiedMeeting(store, 'lead-2');
  const draft = await billing.createDraft({ clientId: 'jole' });
  await billing.discard({ clientId: 'jole', invoiceId: draft.invoice_id });
  assert.equal((await store.getMeeting('jole', m.meeting_id)).stripe_invoice_id, null);
  assert.equal((await billing.unbilled('jole')).length, 1);

  // A redraft after a discard gets a NEW Stripe invoice, not the cached deleted one.
  const again = await billing.createDraft({ clientId: 'jole' });
  assert.notEqual(again.invoice_id, draft.invoice_id);
  await billing.send({ clientId: 'jole', invoiceId: again.invoice_id });
  stripe.void(again.invoice_id);
  await billing.reconcile({ clientId: 'jole', invoiceId: again.invoice_id });
  const back = await store.getMeeting('jole', m.meeting_id);
  assert.equal(back.stripe_invoice_id, null);
  assert.equal(back.invoice_status, 'pending');
  assert.equal((await billing.unbilled('jole')).length, 1);
});

test('invoice now: one meeting, drafted and sent in one action', async () => {
  const { store, stripe, billing } = harness();
  const a = await qualifiedMeeting(store, 'lead-3');
  await qualifiedMeeting(store, 'lead-4');
  const sent = await billing.invoiceNow({ clientId: 'jole', meetingId: a.meeting_id, by: 'deins' });
  assert.equal(sent.kind, 'single');
  assert.equal(sent.status, 'open');
  assert.deepEqual(sent.meeting_ids, [a.meeting_id]);
  assert.equal((await billing.unbilled('jole')).length, 1, 'the other meeting waits for the next draft');
  assert.ok(stripe.calls.some(c => c[0] === 'sendInvoice'));
});

test('the 1st/15th job drafts once per period, only on the day, and never sends', async () => {
  const store = createMemoryLedgerStore();
  const stripe = fakeStripe();
  let clock = '2026-11-14T18:00:00.000Z';
  const billing = createBillingService({ env: ENV, stripe, getStore: () => store, now: () => clock, log: { warn() {} } });
  await qualifiedMeeting(store, 'lead-5');
  assert.equal((await billing.runScheduled(clock))[0].skipped, 'not the 1st or 15th');
  clock = '2026-11-15T18:00:00.000Z';
  const first = await billing.runScheduled(clock);
  assert.ok(first[0].drafted);
  assert.equal((await store.listInvoices('jole'))[0].period_key, '2026-11-15');
  await qualifiedMeeting(store, 'lead-6');
  assert.match((await billing.runScheduled(clock))[0].skipped, /already has an invoice/);
  assert.equal(stripe.calls.some(c => c[0] === 'sendInvoice'), false);
});

test('billing off: nothing is created, status still answers', async () => {
  const { store, stripe, billing } = harness({ ...ENV, STRIPE_BILLING_ENABLED: 'false' });
  await qualifiedMeeting(store, 'lead-7');
  await assert.rejects(billing.createDraft({ clientId: 'jole' }), { code: 'billing_disabled' });
  assert.equal((await billing.runScheduled('2026-11-15T18:00:00Z'))[0].skipped, 'STRIPE_BILLING_ENABLED is off');
  assert.equal(stripe.calls.length, 0);
  const status = await billing.status('jole');
  assert.equal(status.ready, false);
  assert.equal(status.unbilled.length, 1);
});

test('webhooks for invoices this pipeline did not create are ignored', async () => {
  const { stripe, billing } = harness();
  const other = await billing.handleEvent({ type: 'invoice.paid', data: { object: { id: 'in_website', metadata: {} } } });
  assert.equal(other.ignored, true);
  const notInvoice = await billing.handleEvent({ type: 'charge.succeeded', data: { object: {} } });
  assert.equal(notInvoice.ignored, true);
  assert.equal(stripe.calls.length, 0);
});

test('send refuses a stale draft', async () => {
  const { store, billing } = harness();
  const m = await qualifiedMeeting(store, 'lead-8');
  const draft = await billing.createDraft({ clientId: 'jole' });
  const row = await store.getMeeting('jole', m.meeting_id);
  await store.updateMeeting({ ...row, stripe_invoice_id: null });
  await assert.rejects(billing.send({ clientId: 'jole', invoiceId: draft.invoice_id }), { code: 'invoice_stale' });
});

// ── card on file ─────────────────────────────────────────────────────────────

const VISA = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };

test('card setup: a Stripe setup page for this customer; nothing is charged', async () => {
  const { stripe, billing } = harness();
  const link = await billing.cardSetupLink({ clientId: 'jole', by: 'deins' });
  assert.equal(link.url, 'https://checkout.stripe.test/cs_1');
  const params = stripe.calls.find(c => c[0] === 'createSetupCheckout')[1];
  assert.equal(params.mode, 'setup');
  assert.equal(params.customer, 'cus_jorge');
  assert.equal(params.metadata.client_id, 'jole');
  assert.match(params.success_url, /\/billing\/card-saved$/);
  assert.equal(stripe.calls.some(c => ['payInvoice', 'createInvoice'].includes(c[0])), false);
});

test('card saved: the webhook makes the new card the default and status shows it', async () => {
  const { stripe, billing } = harness();
  assert.equal((await billing.status('jole')).card, null);
  const result = await billing.handleEvent({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_1', mode: 'setup', customer: 'cus_jorge', setup_intent: 'seti_1', metadata: { source: 'salespipeline2', client_id: 'jole' },
  } } });
  assert.equal(result.cardSaved, true);
  assert.deepEqual(stripe.calls.find(c => c[0] === 'setDefaultPaymentMethod').slice(1), ['cus_jorge', 'pm_new']);
  const status = await billing.status('jole');
  assert.equal(status.card.last4, '4242');
  assert.equal(status.collection, 'charge_card');
  // Someone else's checkout is ignored.
  assert.equal((await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { mode: 'payment', metadata: {} } } })).ignored, true);
});

test('charge: a draft is finalized and charged to the saved card; meetings are paid', async () => {
  const { store, stripe, billing } = harness(ENV, { card: VISA });
  const m = await qualifiedMeeting(store, 'card-1');
  const draft = await billing.createDraft({ clientId: 'jole' });
  const charged = await billing.charge({ clientId: 'jole', invoiceId: draft.invoice_id, by: 'deins' });
  assert.equal(charged.status, 'paid');
  assert.equal(charged.card.last4, '4242');
  assert.ok(stripe.calls.findIndex(c => c[0] === 'finalizeInvoice') < stripe.calls.findIndex(c => c[0] === 'payInvoice'));
  assert.equal(stripe.calls.some(c => c[0] === 'sendInvoice'), false, 'a charged invoice is not emailed for payment');
  const paid = await store.getMeeting('jole', m.meeting_id);
  assert.equal(paid.invoice_status, 'paid');
});

test('charge refuses without a card on file', async () => {
  const { store, stripe, billing } = harness();
  await qualifiedMeeting(store, 'card-2');
  const draft = await billing.createDraft({ clientId: 'jole' });
  await assert.rejects(billing.charge({ clientId: 'jole', invoiceId: draft.invoice_id }), { code: 'no_card_on_file' });
  const someMeeting = (await store.listMeetings('jole'))[0];
  await assert.rejects(billing.chargeNow({ clientId: 'jole', meetingId: someMeeting.meeting_id }), { code: 'no_card_on_file' });
  assert.equal(stripe.calls.some(c => c[0] === 'payInvoice'), false);
});

test('a declined card is recorded, can be retried, or switched to an emailed invoice', async () => {
  const { store, stripe, billing } = harness(ENV, { card: VISA, decline: true });
  const m = await qualifiedMeeting(store, 'card-3');
  const draft = await billing.createDraft({ clientId: 'jole' });
  await assert.rejects(billing.charge({ clientId: 'jole', invoiceId: draft.invoice_id }), error => error.code === 'charge_failed' && /declined/.test(error.message));
  let row = await store.getInvoice('jole', draft.invoice_id);
  assert.equal(row.status, 'open');
  assert.match(row.last_error, /attempt 1\): Your card was declined/);
  assert.equal((await store.getMeeting('jole', m.meeting_id)).invoice_status, 'invoiced');

  // Retry uses a new idempotency key so Stripe really tries again.
  await assert.rejects(billing.charge({ clientId: 'jole', invoiceId: draft.invoice_id }), { code: 'charge_failed' });
  const keys = stripe.calls.filter(c => c[0] === 'payInvoice').map(c => c[2]);
  assert.equal(new Set(keys).size, 2);

  // Email instead: the failed invoice is voided and a pay-by-invoice goes out for the same meeting.
  const emailed = await billing.emailInstead({ clientId: 'jole', invoiceId: draft.invoice_id, by: 'deins' });
  row = await store.getInvoice('jole', draft.invoice_id);
  assert.equal(row.status, 'void');
  assert.notEqual(emailed.invoice_id, draft.invoice_id);
  assert.equal(emailed.collection_method, 'send_invoice');
  assert.deepEqual(emailed.meeting_ids, [m.meeting_id]);
  assert.equal((await store.getMeeting('jole', m.meeting_id)).stripe_invoice_id, emailed.invoice_id);
});

test('void: an unpaid invoice is voided and its meetings are billable again', async () => {
  const { store, billing } = harness(ENV, { card: VISA, decline: true });
  await qualifiedMeeting(store, 'card-4');
  const draft = await billing.createDraft({ clientId: 'jole' });
  await billing.charge({ clientId: 'jole', invoiceId: draft.invoice_id }).catch(() => {});
  await billing.voidInvoice({ clientId: 'jole', invoiceId: draft.invoice_id });
  assert.equal((await billing.unbilled('jole')).length, 1);
});

test('charge now: one meeting drafted and charged in one action; the standard fee uses the catalogue price', async () => {
  const { store, stripe, billing } = harness({ ...ENV, JOLE_STRIPE_PRICE_ID: 'price_350' }, { card: VISA });
  const m = await qualifiedMeeting(store, 'card-5');
  const charged = await billing.chargeNow({ clientId: 'jole', meetingId: m.meeting_id, by: 'deins' });
  assert.equal(charged.status, 'paid');
  assert.equal(charged.kind, 'single');
  const line = stripe.calls.find(c => c[0] === 'createInvoiceItem')[1];
  assert.equal(line.price, 'price_350');
  assert.equal(line.amount, undefined);
});
