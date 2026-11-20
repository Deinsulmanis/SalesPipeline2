'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { displayStageFor, COLD_CALL_STAGES } = require('../integrations/cold-call-pipeline');
const { stageRequiresHold, deriveNextAction } = require('../integrations/pipeline-state');
const { promotionDecision, PROMOTION_TRIGGER } = require('../integrations/promotion-policy');
const { createScaleLabBilling, scalelabBillingConfig } = require('../integrations/scalelab-billing');

// ── New stages are human-owned: no automation may act on them ────────────────

test('stages: Call Held and Proposal Sent are real stages that place the manual hold', () => {
  for (const id of ['call_held', 'proposal_sent']) {
    assert.equal(displayStageFor(id), id, `${id} must never be read as Follow Up`);
    assert.equal(stageRequiresHold(id), true, `${id} must hold cold automation`);
  }
  assert.deepEqual(COLD_CALL_STAGES.map(stage => stage.label), [
    'Follow Up', 'Hot (replied)', 'Call Booked', 'Call Held', 'Proposal / Agreement Sent', 'Client Signed + Tech Fee Paid', 'Closed / Lost']);
});

test('stages: the next action on Call Held / Proposal Sent is a person\'s, never automated', () => {
  for (const stage of ['call_held', 'proposal_sent']) {
    const action = deriveNextAction({ id: 'L1', stage, email: 'a@b-test.invalid' }, null, { now: new Date('2026-11-18T18:00:00Z') });
    assert.equal(action.owner, 'human');
    assert.equal(action.type, 'manual_follow_up');
    assert.match(action.label, stage === 'call_held' ? /Send the proposal/ : /Follow up on the proposal/);
  }
});

test('stages: a reply or a new booking never moves a lead backwards out of Call Held / Proposal Sent', () => {
  for (const existing of ['call_held', 'proposal_sent']) {
    const decision = promotionDecision({
      trigger: PROMOTION_TRIGGER.POSITIVE_REPLY, automatic: true,
      coldEmailLead: { id: 'c1', email: 'a@b-test.invalid', stage: 'Replied', notes: '' },
      identity: { boardLead: { id: 'L1', stage: existing } }, suppressedEmails: new Set(),
    });
    if (decision.shouldPromote) assert.equal(decision.shouldMove, false, `${existing} must be retained`);
  }
});

test('stages: generic re-engagement is blocked for leads a person is closing', () => {
  const source = fs.readFileSync(require.resolve('../integrations/generic-reengagement.js'), 'utf8');
  assert.match(source, /\['call_held', 'proposal_sent'\]\.includes\(boardStage\)/);
});

// ── ScaleLab tech-fee billing ────────────────────────────────────────────────

const ENV = { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'rk_test_x' };
const LEAD = { id: 'L42', email: 'owner@newclient-test.invalid', first: 'Sam', last: 'Lee', company: 'New Client Co' };
const PRICE = { id: 'price_tech', active: true, type: 'one_time', unit_amount: 150000, currency: 'usd', product: { id: 'prod_tech', name: 'Outbound infrastructure Tech Fee', active: true } };

function fakeStripe({ card = null, decline = false } = {}) {
  const customers = [];
  const calls = [];
  let n = 0;
  return {
    calls, customers,
    async listPrices() { return { data: [PRICE, { ...PRICE, id: 'price_sub', type: 'recurring' }] }; },
    async searchCustomers(query) {
      calls.push(['searchCustomers', query]);
      const lead = query.match(/sp2_lead_id'\]:'([^']+)'/);
      return { data: lead ? customers.filter(c => c.metadata.sp2_lead_id === lead[1]) : customers };
    },
    async createCustomer(params) {
      calls.push(['createCustomer', params]);
      const c = { id: `cus_${++n}`, email: params.email, metadata: params.metadata, invoice_settings: { default_payment_method: card ? { id: 'pm_1', card } : null } };
      customers.push(c); return c;
    },
    async listInvoices() { return { data: [] }; },
    async createInvoice(params, opts) { calls.push(['createInvoice', params, opts.idempotencyKey]); return { id: 'in_1', ...params }; },
    async createInvoiceItem(params) { calls.push(['createInvoiceItem', params]); return { id: 'ii_1' }; },
    async finalizeInvoice(id) { calls.push(['finalizeInvoice', id]); return { id, status: 'open' }; },
    async sendInvoice(id) { calls.push(['sendInvoice', id]); return { id, status: 'open', total: 150000, currency: 'usd', collection_method: 'send_invoice' }; },
    async payInvoice(id) {
      calls.push(['payInvoice', id]);
      if (decline) throw Object.assign(new Error(`Stripe POST /v1/invoices/${id}/pay failed: Your card was declined.`), { code: 'card_declined' });
      return { id, status: 'paid', total: 150000, currency: 'usd', status_transitions: { paid_at: 1795100000 } };
    },
    async createSetupCheckout(params) { calls.push(['createSetupCheckout', params]); return { url: 'https://checkout.stripe.test/s', expires_at: 1795200000 }; },
    async getSetupIntent(id) { return { id, status: 'succeeded', payment_method: 'pm_new' }; },
    async setDefaultPaymentMethod(customerId, pm) { calls.push(['setDefaultPaymentMethod', customerId, pm]); return {}; },
  };
}

const billingWith = (stripe, env = ENV) => createScaleLabBilling({ stripe, env, findLead: async id => (id === LEAD.id ? LEAD : null), log: { info() {} } });

test('tech fee: off unless billing is on; only one-time prices are offered', async () => {
  assert.equal(scalelabBillingConfig({}).ready, false);
  await assert.rejects(billingWith(fakeStripe(), { STRIPE_SECRET_KEY: 'rk_test_x' }).emailInvoice({ leadId: LEAD.id, priceId: PRICE.id }), { code: 'billing_disabled' });
  const prices = await billingWith(fakeStripe()).prices();
  assert.deepEqual(prices.map(p => p.priceId), ['price_tech']);
});

test('tech fee: email an invoice creates the client in Stripe once and emails a 7-day invoice', async () => {
  const stripe = fakeStripe();
  const billing = billingWith(stripe);
  const sent = await billing.emailInvoice({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'n1' });
  assert.equal(sent.status, 'open');
  const customer = stripe.calls.find(c => c[0] === 'createCustomer')[1];
  assert.equal(customer.email, LEAD.email);
  assert.equal(customer.metadata.sp2_lead_id, 'L42');
  const invoice = stripe.calls.find(c => c[0] === 'createInvoice')[1];
  assert.equal(invoice.collection_method, 'send_invoice');
  assert.equal(invoice.days_until_due, 7);
  assert.equal(invoice.auto_advance, false);
  assert.deepEqual(stripe.calls.find(c => c[0] === 'createInvoiceItem')[1], { customer: 'cus_1', invoice: 'in_1', price: 'price_tech', quantity: 1 });
  await billing.emailInvoice({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'n2' });
  assert.equal(stripe.calls.filter(c => c[0] === 'createCustomer').length, 1, 'the same client is never created twice');
});

test('tech fee: charging needs a saved card; a decline is reported, never retried', async () => {
  await assert.rejects(billingWith(fakeStripe()).chargeCard({ leadId: LEAD.id, priceId: PRICE.id }), { code: 'no_card_on_file' });
  const card = { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2031 };
  const withCard = fakeStripe({ card });
  const billing = billingWith(withCard);
  await billing.emailInvoice({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'make-customer' });
  const paid = await billing.chargeCard({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'c1' });
  assert.equal(paid.status, 'paid');
  assert.equal(withCard.calls.filter(c => c[0] === 'createInvoice').pop()[1].collection_method, 'charge_automatically');
  const declining = fakeStripe({ card, decline: true });
  const b2 = billingWith(declining);
  await b2.emailInvoice({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'mk' });
  await assert.rejects(b2.chargeCard({ leadId: LEAD.id, priceId: PRICE.id, nonce: 'c2' }), error => error.code === 'charge_failed' && /declined/.test(error.message));
  assert.equal(declining.calls.filter(c => c[0] === 'payInvoice').length, 1);
});

test('tech fee: card setup link and the card-saved webhook', async () => {
  const stripe = fakeStripe();
  const billing = billingWith(stripe);
  const link = await billing.cardSetupLink({ leadId: LEAD.id });
  assert.equal(link.url, 'https://checkout.stripe.test/s');
  const params = stripe.calls.find(c => c[0] === 'createSetupCheckout')[1];
  assert.equal(params.mode, 'setup');
  assert.equal(params.metadata.kind, 'scalelab_prospect');
  const saved = await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { mode: 'setup', customer: 'cus_1', setup_intent: 'seti_1', metadata: { source: 'salespipeline2', kind: 'scalelab_prospect', sp2_lead_id: 'L42' } } } });
  assert.equal(saved.cardSaved, true);
  // Jole's card setups belong to client billing, not here.
  assert.equal((await billing.handleEvent({ type: 'checkout.session.completed', data: { object: { mode: 'setup', metadata: { source: 'salespipeline2', client_id: 'jole' } } } })).ignored, true);
});

// ── Onboarding documents ─────────────────────────────────────────────────────

test('onboarding docs: a prefilled Gmail compose link for the main mailbox; the server sends nothing', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const start = html.indexOf('function gmailComposeUrl(');
  const fnSource = html.slice(start, html.indexOf('\n}\n', start) + 2);
  const gmailComposeUrl = new Function(`${fnSource}; return gmailComposeUrl;`)();
  const url = new URL(gmailComposeUrl({ mailbox: 'deins@scalelabai.ca', to: 'owner@newclient-test.invalid', cc: 'ops@newclient-test.invalid', subject: 'Welcome & docs', body: 'Hi Sam,\nAttached.' }));
  assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/');
  assert.equal(url.searchParams.get('view'), 'cm');
  assert.equal(url.searchParams.get('authuser'), 'deins@scalelabai.ca');
  assert.equal(url.searchParams.get('to'), 'owner@newclient-test.invalid');
  assert.equal(url.searchParams.get('cc'), 'ops@newclient-test.invalid');
  assert.equal(url.searchParams.get('su'), 'Welcome & docs');
  assert.equal(url.searchParams.get('body'), 'Hi Sam,\nAttached.');
  // No server route for onboarding mail exists.
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.equal(/onboarding-(email|draft)/.test(server), false);
});

// ── Dashboard wiring ─────────────────────────────────────────────────────────

test('dashboard: board summary cards, conversation inbox and meeting tracker are wired', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(html, /id="pipeline-metrics"/);
  assert.match(html, /function inboxConversations\(\)/);
  assert.match(html, /id="inbox-metrics"/);
  assert.match(html, /function openTechFeeDialog\(leadId\)/);
  assert.match(html, /function openOnboardingDialog\(leadId\)/);
  assert.match(html, /\/api\/scalelab-billing\/overview/);
  assert.match(html, /function simplifyScaleLabSettings\(\)/);
  for (const id of ['call_held', 'proposal_sent']) assert.match(html, new RegExp(`id: '${id}'`));
});

test('bookings: Closed / Lost meetings are not listed, and a signed client is never offered a tech fee', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const loader = html.slice(html.indexOf('async function loadBookingsWorkspace()'), html.indexOf('function bookingRowHtml('));
  assert.match(loader, /\.filter\(lead => displayStageFor\(lead\.stage\) !== 'closed_lost'\)\s*\n\s*\.map\(lead => \(\{ lead, at: Date\.parse\(lead\.meetingAt/);

  // Run the real row renderer.
  const start = html.indexOf('function bookingRowHtml(');
  const rowSource = html.slice(start, html.indexOf('\n}\n', start) + 2);
  const bookingRowHtml = new Function('ctx', `
    const { esc, escAttr, nextActions, CALL_STATUS_LABEL, clientMoney, stageLabel, displayStageFor, callWhen } = ctx;
    let scalelabBillingOverview = ctx.overview;
    ${rowSource}
    return bookingRowHtml;`)({
    esc: v => String(v), escAttr: v => String(v), nextActions: new Map(), CALL_STATUS_LABEL: {},
    clientMoney: c => `$${c / 100}`, stageLabel: s => s, displayStageFor: s => s, callWhen: iso => iso,
    overview: { ready: true },
  });
  const at = Date.parse('2026-10-02T23:30:00Z');
  const prospect = bookingRowHtml({ id: 'L1', company: 'Prospect Co', stage: 'call_held' }, at, true, null);
  assert.match(prospect, />Bill tech fee</);
  assert.match(prospect, /Not billed yet/);
  const client = bookingRowHtml({ id: 'L2', company: 'Signed Co', stage: 'closed_won' }, at, true, null);
  assert.doesNotMatch(client, /Bill tech fee/, 'a signed client has already paid');
  assert.doesNotMatch(client, /Not billed yet/);
  assert.match(client, /Client · tech fee paid/);
  assert.match(client, />Send onboarding docs</, 'onboarding documents stay available');
});

test('inbox: the client Inbox layout, a read-only conversation drawer, and reply actions one click away', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const render = html.slice(html.indexOf('function renderInboxWorkspace() {'), html.indexOf('// ── SCALELAB CONVERSATION DRAWER'));
  assert.match(render, /clientStatusBadges\(client, client\.sending\)/, 'status badges like a client Inbox');
  for (const card of ['Conversations', 'Needs response', 'Positive', 'Needs review']) assert.match(render, new RegExp(`metricCard\\('${card}'`));
  assert.doesNotMatch(html, /id="inbox-toolbar"|INBOX_FILTERS|setInboxFilter/, 'no filter tabs, as in a client Inbox');
  assert.match(render, /onclick="openScaleLabConversation\(this\.dataset\.leadId\)"/);
  const drawer = html.slice(html.indexOf('// ── SCALELAB CONVERSATION DRAWER'), html.indexOf('async function loadSequencesWorkspace() {'));
  // It reads ScaleLab's own lead activity, refuses an answer for another lead, and writes nothing.
  assert.match(drawer, /fetch\(`\/api\/coldemail\/\$\{encodeURIComponent\(leadId\)\}\/activity\?client=\$\{encodeURIComponent\(clientId\)\}`\)/);
  assert.match(drawer, /String\(data\.lead\.id\) !== String\(leadId\)/);
  assert.doesNotMatch(drawer, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/);
  // Same sections as the managed drawer, plus the way to the full lead's actions.
  for (const section of ['Contact', 'Sending inbox', 'Email sequence', 'Campaign context', 'Pipeline & next action', 'Activity']) {
    assert.ok(drawer.includes(`cdSection('${section}'`), section);
  }
  assert.match(drawer, /function openFullLeadFromConversation\(leadId\) \{[\s\S]*openCeDetail\(leadId\);/);
});

test('dashboard: staffing only — no dental, roofing or trades choices are offered', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /<option value="(?:dental|roofing)">/, 'no dental or roofing filter or campaign option');
  assert.doesNotMatch(html, /<option>Roofer<\/option>/, 'the lead form offers staffing lead types');
  assert.doesNotMatch(html, /Roofing reply flow|Dental sender eligibility|e\.g\. dental-ca|dental and med spa/);
  assert.doesNotMatch(html, /data-f="trade" onclick="setFilter\('trade'\)"/, 'the Trades board tab is gone');
  assert.match(html, /const liveVersion = registry\.active\?\.industrial_staffing \|\| '—';/);
  assert.match(html, /\.filter\(\(\[, version\]\) => version && version\.family === 'industrial_staffing'\)/);
});

test('dashboard: the board summary cards move into the Pipeline workspace, never left on <body>', () => {
  // Left as a body child, the cards broke the workspace shell and the board
  // collapsed to a sliver, so the dashboard looked like nothing had loaded.
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(html, /const pipelineMetrics = document\.querySelector\('body > #pipeline-metrics'\);/);
  assert.match(html, /if \(pipelineMetrics\) pipeline\.appendChild\(pipelineMetrics\);/);
});
