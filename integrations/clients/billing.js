'use strict';

/**
 * billing.js — Stripe invoices for a managed client's qualified held meetings.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BILLABLE is decided by the ledger, never here: a meeting is billable
 * only when it is QUALIFIED_HELD and ledger.withBilling() says so. This module
 * only turns billable, not-yet-invoiced meetings into Stripe invoices and keeps
 * the ledger in step with what Stripe says happened to them.
 *
 *   createDraft   billable meetings → one Stripe DRAFT invoice (one line each)
 *   send          draft → finalized and emailed by Stripe (operator action)
 *   discard       draft → deleted; its meetings are billable again
 *   invoiceNow    one meeting → draft → sent, in one operator action
 *   reconcile     Stripe's invoice → client_invoices row + its meetings
 *   runScheduled  on the 1st and 15th (America/Vancouver): a DRAFT, never sent
 *
 * A meeting is on at most one live invoice: client_meetings.stripe_invoice_id
 * links it; a void or deleted invoice clears the link. Invoices Stripe holds
 * that are not in client_invoices (website deposits, other products) are never
 * touched.
 */

const crypto = require('node:crypto');
const { getClient, listClients, resolveClientId } = require('./registry');
const ledger = require('./ledger');

const FLAG = 'STRIPE_BILLING_ENABLED';
const LIVE_INVOICE = new Set(['draft', 'open', 'paid', 'uncollectible']);
const text = value => String(value == null ? '' : value).trim();
const isoFromUnix = seconds => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);
const sha = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

class BillingError extends Error {
  constructor(code, message) { super(message); this.name = 'BillingError'; this.code = code; }
}
const fail = (code, message) => { throw new BillingError(code, message); };

// ── CONFIGURATION ───────────────────────────────────────────────────────────

/** Billing settings for one client. Never contains a secret, only whether it is set. */
function clientBillingConfig(clientId, env = process.env) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) return { supported: false, ready: false, reason: resolved.reason };
  const client = getClient(resolved.clientId);
  const spec = client.billing?.stripe;
  if (!spec || client.billing?.model !== 'per_qualified_held_meeting') {
    return { supported: false, ready: false, clientId: client.id, reason: `${client.displayName} has no Stripe billing` };
  }
  const key = text(env.STRIPE_SECRET_KEY);
  const customerId = text(env[spec.customerIdEnv]);
  const missing = [];
  if (!key) missing.push('STRIPE_SECRET_KEY');
  if (!customerId) missing.push(spec.customerIdEnv);
  const enabled = text(env[FLAG]).toLowerCase() === 'true';
  return {
    supported: true, clientId: client.id, displayName: client.displayName,
    enabled, configured: missing.length === 0, ready: enabled && missing.length === 0, missing,
    mode: key.includes('_test_') ? 'test' : key.includes('_live_') ? 'live' : (key ? 'unknown' : 'none'),
    webhookConfigured: Boolean(text(env.STRIPE_WEBHOOK_SECRET)),
    customerId, productId: text(env[spec.productIdEnv]),
    currency: text(client.billing.currency || 'USD').toLowerCase(),
    feeCents: client.billing.performanceFeeCents,
    schedule: spec.schedule || 'none', draftsRequireSend: spec.draftsRequireSend !== false,
    daysUntilDue: Number(spec.daysUntilDue) || 7, lineLabel: spec.lineLabel || 'Qualified meeting',
    timezone: 'America/Vancouver',
    reason: missing.length ? `billing is not configured: ${missing.join(', ')} not set` : (enabled ? 'ready' : `${FLAG} is off`),
  };
}

function billingClientIds() {
  return listClients().filter(client => client.billing?.stripe).map(client => client.id);
}

// ── PURE RULES ──────────────────────────────────────────────────────────────

/** Billable by the ledger's own rules and not on any live invoice. */
function isBillableUnbilled(meeting, client) {
  if (!meeting || meeting.meeting_status !== ledger.MEETING_STATUS.QUALIFIED_HELD) return false;
  if (text(meeting.stripe_invoice_id)) return false;
  if (['invoiced', 'paid'].includes(text(meeting.invoice_status))) return false;
  return ledger.withBilling(meeting, client).billable === true;
}

function meetingFeeCents(meeting, client) {
  const fee = Number(meeting.performance_fee_cents);
  return Number.isInteger(fee) && fee > 0 ? fee : client.billing.performanceFeeCents;
}

function dateIn(timeZone, iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Qualified meeting: Clifford Thornberry, American Steel Fab, held Nov 16, 2026" */
function lineDescription(meeting, { label, employer, timeZone }) {
  const who = text(meeting.attendee_name) || text(meeting.attendee_email) || 'attendee';
  const parts = [who, text(employer)].filter(Boolean).join(', ');
  const held = dateIn(timeZone, meeting.held_at || meeting.scheduled_for);
  return `${label}: ${parts}${held ? `, held ${held}` : ''}`.slice(0, 500);
}

/** '2026-12-01' on the 1st–14th, '2026-12-15' on the 15th–end, in the client's zone. */
function periodKeyFor(now = new Date(), timeZone = 'America/Vancouver') {
  const [y, m, d] = new Date(now).toLocaleDateString('en-CA', { timeZone }).split('-');
  return `${y}-${m}-${Number(d) >= 15 ? '15' : '01'}`;
}

function isScheduledDay(now = new Date(), timeZone = 'America/Vancouver') {
  const day = Number(new Date(now).toLocaleDateString('en-CA', { timeZone }).split('-')[2]);
  return day === 1 || day === 15;
}

/** Stripe invoice → client_invoices fields. Pure. */
function invoiceFields(invoice) {
  return {
    status: text(invoice.status) || 'draft',
    currency: text(invoice.currency),
    amount_cents: Number.isInteger(invoice.total) ? invoice.total : Number(invoice.amount_due) || 0,
    invoice_number: text(invoice.number),
    hosted_invoice_url: text(invoice.hosted_invoice_url),
    due_at: isoFromUnix(invoice.due_date),
    paid_at: isoFromUnix(invoice.status_transitions?.paid_at),
    voided_at: isoFromUnix(invoice.status_transitions?.voided_at),
    livemode: Boolean(invoice.livemode),
  };
}

// ── SERVICE ─────────────────────────────────────────────────────────────────

/**
 * @param deps { env, stripe (stripe-api client), getStore, now(), log }
 */
function createBillingService({ env = process.env, stripe, getStore, now = () => new Date().toISOString(), log = console }) {
  let chain = Promise.resolve();
  // Every operation reads and writes the same invoice and meeting rows.
  const exclusive = task => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  const store = () => {
    const s = getStore();
    if (!s?.enabled) fail('ledger_unavailable', `client ledger is disabled: ${s?.reason || ''}`.trim());
    return s;
  };
  const ready = (clientId, { requireEnabled = true } = {}) => {
    const cfg = clientBillingConfig(clientId, env);
    if (!cfg.supported) fail('billing_not_supported', cfg.reason);
    if (!cfg.configured) fail('billing_not_configured', cfg.reason);
    if (requireEnabled && !cfg.enabled) fail('billing_disabled', cfg.reason);
    return { cfg, client: getClient(cfg.clientId) };
  };

  async function audit(s, clientId, invoiceId, type, payload) {
    const at = now();
    await s.appendEvent({
      event_id: ledger.ids.event(`inv:${invoiceId}`, type, at), client_id: clientId, entity_type: 'invoice',
      entity_id: invoiceId, event_type: type, payload, occurred_at: at,
    }).catch(error => log.warn?.(`[billing] audit write failed: ${error.message}`));
  }

  async function employerByLead(s, clientId) {
    const rows = await s.listOpportunities(clientId).catch(() => []);
    return new Map(rows.map(row => [row.lead_id, row.employer]));
  }

  async function setMeeting(s, client, meeting, patch) {
    const next = ledger.withBilling({ ...meeting, ...patch, updated_at: now() }, client);
    await s.updateMeeting(next);
    return next;
  }

  /** Billable meetings, not yet invoiced, for the Bookings view and drafts. */
  async function unbilled(clientId) {
    const { cfg, client } = ready(clientId, { requireEnabled: false });
    const s = store();
    const [meetings, employers] = await Promise.all([s.listMeetings(cfg.clientId), employerByLead(s, cfg.clientId)]);
    return meetings.filter(m => m.client_id === cfg.clientId && isBillableUnbilled(m, client)).map(m => ({
      meeting: m, amountCents: meetingFeeCents(m, client), employer: employers.get(m.lead_id) || '',
      description: lineDescription(m, { label: cfg.lineLabel, employer: employers.get(m.lead_id), timeZone: cfg.timezone }),
    }));
  }

  async function createDraftLocked({ clientId, meetingIds = null, kind, periodKey = '', by }) {
    const { cfg, client } = ready(clientId);
    const s = store();
    let items = await unbilled(cfg.clientId);
    if (meetingIds) {
      const wanted = new Set(meetingIds);
      items = items.filter(item => wanted.has(item.meeting.meeting_id));
      const missing = meetingIds.filter(id => !items.some(item => item.meeting.meeting_id === id));
      if (missing.length) fail('meeting_not_billable', `not billable or already invoiced: ${missing.join(', ')}`);
    }
    if (!items.length) fail('nothing_to_bill', 'there are no qualified held meetings waiting to be invoiced');
    const ids = items.map(item => item.meeting.meeting_id).sort();
    // A retry after a crash must resume the SAME Stripe draft (same key), but a
    // discarded or voided invoice for these meetings must not replay from
    // Stripe's 24h idempotency cache, so the key moves on only past those.
    const prior = (await s.listInvoices(cfg.clientId)).filter(row => ['deleted', 'void'].includes(row.status)
      && (row.meeting_ids || []).some(id => ids.includes(id))).length;
    const key = `sp2:inv:${cfg.clientId}:${kind}:${periodKey || ids[0]}:${sha(ids.join(','))}:${prior}`;
    const invoice = await stripe.createInvoice({
      customer: cfg.customerId, collection_method: 'send_invoice', days_until_due: cfg.daysUntilDue,
      currency: cfg.currency, auto_advance: false, pending_invoice_items_behavior: 'exclude',
      description: kind === 'period'
        ? `Qualified meetings — invoice for the period starting ${periodKey}`
        : (ids.length === 1 ? 'Qualified meeting' : 'Qualified meetings'),
      metadata: { source: 'salespipeline2', client_id: cfg.clientId, kind, period_key: periodKey, meeting_count: String(ids.length) },
    }, { idempotencyKey: key });

    const at = now();
    const row = {
      invoice_id: invoice.id, client_id: cfg.clientId, kind, period_key: periodKey, status: 'draft',
      currency: cfg.currency, amount_cents: items.reduce((sum, item) => sum + item.amountCents, 0), meeting_ids: ids,
      invoice_number: '', hosted_invoice_url: '', due_at: null, sent_at: null, paid_at: null, voided_at: null,
      livemode: Boolean(invoice.livemode), created_by: text(by) || 'system', sent_by: '', last_error: '',
      created_at: at, updated_at: at,
    };
    const existing = await s.getInvoice(cfg.clientId, invoice.id);
    if (!existing) await s.insertInvoice(row);

    for (const item of items) {
      const m = item.meeting;
      await stripe.createInvoiceItem({
        customer: cfg.customerId, invoice: invoice.id, currency: cfg.currency, description: item.description,
        ...(cfg.productId ? { price_data: { currency: cfg.currency, product: cfg.productId, unit_amount: item.amountCents } } : { amount: item.amountCents }),
        metadata: { source: 'salespipeline2', client_id: cfg.clientId, meeting_id: m.meeting_id, lead_id: m.lead_id },
      }, { idempotencyKey: `sp2:ii:${invoice.id}:${m.meeting_id}` });
      await setMeeting(s, client, m, { stripe_invoice_id: invoice.id });
    }
    const fresh = await stripe.getInvoice(invoice.id);
    const fields = invoiceFields(fresh);
    const mismatch = fields.amount_cents !== row.amount_cents
      ? `Stripe total ${fields.amount_cents} differs from the ledger total ${row.amount_cents}` : '';
    const saved = { ...(existing || row), ...fields, last_error: mismatch, updated_at: now() };
    await s.updateInvoice(saved);
    await audit(s, cfg.clientId, invoice.id, 'invoice_drafted', { kind, periodKey, meetings: ids.length, amountCents: fields.amount_cents, by: text(by) || 'system' });
    if (mismatch) log.warn?.(`[billing:${cfg.clientId}] ${invoice.id}: ${mismatch}`);
    return saved;
  }

  async function sendLocked({ clientId, invoiceId, by }) {
    const { cfg, client } = ready(clientId);
    const s = store();
    const row = await s.getInvoice(cfg.clientId, invoiceId);
    if (!row) fail('invoice_not_found', `invoice ${invoiceId} is not a ${cfg.displayName} invoice`);
    if (row.status !== 'draft') fail('invoice_not_draft', `invoice is ${row.status}, not a draft`);
    // Re-check every line against the ledger at the moment of sending.
    const meetings = (await s.listMeetings(cfg.clientId)).filter(m => (row.meeting_ids || []).includes(m.meeting_id));
    const stale = meetings.filter(m => m.stripe_invoice_id !== invoiceId || m.meeting_status !== 'QUALIFIED_HELD'
      || !ledger.withBilling(m, client).billable);
    if (stale.length || meetings.length !== (row.meeting_ids || []).length) {
      fail('invoice_stale', 'a meeting on this draft is no longer billable or no longer linked to it; discard the draft and create a new one');
    }
    await stripe.finalizeInvoice(invoiceId, { idempotencyKey: `sp2:fin:${invoiceId}` });
    const sent = await stripe.sendInvoice(invoiceId, { idempotencyKey: `sp2:send:${invoiceId}` });
    const at = now();
    const saved = { ...row, ...invoiceFields(sent), sent_at: at, sent_by: text(by) || 'operator', last_error: '', updated_at: at };
    await s.updateInvoice(saved);
    for (const m of meetings) await setMeeting(s, client, m, { invoice_status: 'invoiced', invoiced_at: at });
    await audit(s, cfg.clientId, invoiceId, 'invoice_sent', { amountCents: saved.amount_cents, by: saved.sent_by });
    return saved;
  }

  async function discardLocked({ clientId, invoiceId, by }) {
    const { cfg, client } = ready(clientId, { requireEnabled: false });
    const s = store();
    const row = await s.getInvoice(cfg.clientId, invoiceId);
    if (!row) fail('invoice_not_found', `invoice ${invoiceId} is not a ${cfg.displayName} invoice`);
    if (row.status !== 'draft') fail('invoice_not_draft', `only a draft can be discarded; this invoice is ${row.status} (void it in Stripe instead)`);
    try {
      await stripe.deleteDraftInvoice(invoiceId);
    } catch (error) {
      if (error.code !== 'resource_missing') throw error;
    }
    const saved = { ...row, status: 'deleted', updated_at: now() };
    await s.updateInvoice(saved);
    await unlinkMeetings(s, client, cfg.clientId, invoiceId);
    await audit(s, cfg.clientId, invoiceId, 'invoice_discarded', { by: text(by) || 'operator' });
    return saved;
  }

  async function unlinkMeetings(s, client, clientId, invoiceId) {
    const linked = (await s.listMeetings(clientId)).filter(m => m.stripe_invoice_id === invoiceId);
    for (const m of linked) await setMeeting(s, client, m, { stripe_invoice_id: null, invoice_status: 'pending', invoiced_at: null });
    return linked.length;
  }

  /** Make the row and its meetings match Stripe's invoice. Safe to repeat. */
  async function reconcileLocked({ clientId, invoiceId }) {
    const { cfg, client } = ready(clientId, { requireEnabled: false });
    const s = store();
    const row = await s.getInvoice(cfg.clientId, invoiceId);
    if (!row) return { ok: true, ignored: true, reason: 'not an invoice this pipeline created' };
    let fields;
    try {
      fields = invoiceFields(await stripe.getInvoice(invoiceId));
    } catch (error) {
      if (error.code !== 'resource_missing') throw error;
      fields = { status: 'deleted' };
    }
    const saved = { ...row, ...fields, updated_at: now() };
    await s.updateInvoice(saved);
    const linked = (await s.listMeetings(cfg.clientId)).filter(m => m.stripe_invoice_id === invoiceId);
    if (['void', 'deleted'].includes(saved.status)) {
      await unlinkMeetings(s, client, cfg.clientId, invoiceId);
    } else if (saved.status === 'paid') {
      for (const m of linked) if (m.invoice_status !== 'paid') {
        await setMeeting(s, client, m, { invoice_status: 'paid', paid_at: saved.paid_at || now(), invoiced_at: m.invoiced_at || saved.sent_at || now() });
      }
    } else if (['open', 'uncollectible'].includes(saved.status)) {
      for (const m of linked) if (m.invoice_status !== 'invoiced') {
        await setMeeting(s, client, m, { invoice_status: 'invoiced', invoiced_at: m.invoiced_at || saved.sent_at || now() });
      }
    }
    if (saved.status !== row.status) await audit(s, cfg.clientId, invoiceId, `invoice_${saved.status}`, { from: row.status });
    return { ok: true, invoiceId, status: saved.status, meetings: linked.length };
  }

  return {
    config: clientId => clientBillingConfig(clientId, env),
    unbilled,
    // An operator's "draft now": all (or chosen) billable meetings, never sent here.
    createDraft: args => exclusive(() => createDraftLocked({ ...args, kind: 'manual', periodKey: '' })),
    send: args => exclusive(() => sendLocked(args)),
    discard: args => exclusive(() => discardLocked(args)),
    reconcile: args => exclusive(() => reconcileLocked(args)),

    /** One meeting, invoiced and emailed now (operator action). */
    invoiceNow: ({ clientId, meetingId, by }) => exclusive(async () => {
      const draft = await createDraftLocked({ clientId, meetingIds: [meetingId], kind: 'single', by });
      return sendLocked({ clientId, invoiceId: draft.invoice_id, by });
    }),

    /** Status for the Bookings view. Reads only. */
    async status(clientId, at = now()) {
      const cfg = clientBillingConfig(clientId, env);
      const base = {
        supported: cfg.supported, enabled: Boolean(cfg.enabled), configured: Boolean(cfg.configured), ready: Boolean(cfg.ready),
        reason: cfg.reason, mode: cfg.mode || 'none', webhookConfigured: Boolean(cfg.webhookConfigured),
        currency: cfg.currency || '', daysUntilDue: cfg.daysUntilDue || 0, schedule: cfg.schedule || 'none',
        nextPeriodKey: cfg.supported ? periodKeyFor(at, cfg.timezone) : '',
      };
      if (!cfg.supported || !cfg.configured) return { ...base, unbilled: [], invoices: [], totals: {} };
      const s = store();
      const [pending, invoices] = await Promise.all([unbilled(cfg.clientId), s.listInvoices(cfg.clientId)]);
      const nowMs = Date.parse(at);
      const live = invoices.filter(row => row.status !== 'deleted');
      const sum = rows => rows.reduce((total, row) => total + (Number(row.amount_cents) || 0), 0);
      const open = live.filter(row => row.status === 'open');
      return {
        ...base,
        unbilled: pending.map(item => ({
          meetingId: item.meeting.meeting_id, leadId: item.meeting.lead_id, attendee: item.meeting.attendee_name || '',
          employer: item.employer, heldAt: item.meeting.held_at || item.meeting.scheduled_for || '', amountCents: item.amountCents,
          description: item.description,
        })),
        invoices: live.slice(0, 50).map(row => ({ ...row, overdue: row.status === 'open' && row.due_at && Date.parse(row.due_at) < nowMs })),
        totals: {
          unbilledCents: sum(pending.map(item => ({ amount_cents: item.amountCents }))),
          draftCents: sum(live.filter(row => row.status === 'draft')),
          outstandingCents: sum(open),
          overdueCents: sum(open.filter(row => row.due_at && Date.parse(row.due_at) < nowMs)),
          paidCents: sum(live.filter(row => row.status === 'paid')),
        },
      };
    },

    /**
     * The 1st/15th draft. Runs often; acts once per client per period, only on
     * the scheduled day, and never sends.
     */
    runScheduled: (at = now()) => exclusive(async () => {
      const results = [];
      for (const clientId of billingClientIds()) {
        const cfg = clientBillingConfig(clientId, env);
        if (!cfg.ready || cfg.schedule !== 'semi_monthly') { results.push({ clientId, skipped: cfg.reason || 'not scheduled' }); continue; }
        if (!isScheduledDay(at, cfg.timezone)) { results.push({ clientId, skipped: 'not the 1st or 15th' }); continue; }
        const periodKey = periodKeyFor(at, cfg.timezone);
        const s = store();
        const exists = (await s.listInvoices(cfg.clientId)).some(row => row.kind === 'period' && row.period_key === periodKey && LIVE_INVOICE.has(row.status));
        if (exists) { results.push({ clientId, skipped: `period ${periodKey} already has an invoice` }); continue; }
        if (!(await unbilled(cfg.clientId)).length) { results.push({ clientId, skipped: 'nothing to bill' }); continue; }
        const draft = await createDraftLocked({ clientId: cfg.clientId, kind: 'period', periodKey, by: 'schedule' });
        results.push({ clientId, drafted: draft.invoice_id, amountCents: draft.amount_cents, meetings: draft.meeting_ids.length });
      }
      return results;
    }),

    /** Catch a missed webhook: re-read every draft and open invoice from Stripe. */
    reconcileOpen: () => exclusive(async () => {
      const results = [];
      for (const clientId of billingClientIds()) {
        const cfg = clientBillingConfig(clientId, env);
        if (!cfg.configured) continue;
        const rows = (await store().listInvoices(cfg.clientId)).filter(row => ['draft', 'open'].includes(row.status)).slice(0, 50);
        for (const row of rows) results.push(await reconcileLocked({ clientId: cfg.clientId, invoiceId: row.invoice_id }));
      }
      return results;
    }),

    /** A verified Stripe event. Only invoices this pipeline created are acted on. */
    handleEvent: event => exclusive(async () => {
      const type = text(event?.type);
      if (!type.startsWith('invoice.')) return { ok: true, ignored: true, reason: `event ${type || 'unknown'} is not an invoice event` };
      const invoice = event.data?.object || {};
      const clientId = text(invoice.metadata?.client_id);
      if (invoice.metadata?.source !== 'salespipeline2' || !billingClientIds().includes(clientId)) {
        return { ok: true, ignored: true, reason: 'invoice was not created by this pipeline' };
      }
      return reconcileLocked({ clientId, invoiceId: text(invoice.id) });
    }),
  };
}

module.exports = {
  FLAG, BillingError, clientBillingConfig, billingClientIds,
  isBillableUnbilled, meetingFeeCents, lineDescription, periodKeyFor, isScheduledDay, invoiceFields,
  createBillingService,
};
