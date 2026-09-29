'use strict';

/**
 * Internal ScaleLab operator endpoints for managed clients.
 *
 * Every route sits behind the dashboard's Basic auth (requireAuth). There is no
 * client-facing route, login or token: a managed client never reaches these.
 *
 * Every client-scoped route resolves :clientId through the registry first
 * (unknown ids are 404), scopes the corpus to that client server side, and
 * reads ledger rows with a client_id filter in the database query. Nothing
 * here sends, queues or reserves.
 */

const express = require('express');
const { listClients, getClient, resolveClientId, publicClient } = require('./registry');
const { clientSendState } = require('./send-policy');
const { campaignsForClient, campaignSendable } = require('./campaigns');
const { leadsForClient } = require('./ownership');
const { buildClientOverview } = require('./reporting');
const { buildClientSuppression } = require('./suppression');
const ledger = require('./ledger');
const { validateClientLeadImport } = require('./lead-import');

function registerClientRoutes(app, {
  requireAuth, loadDataset, getStore, senders, routedLeadReady, env = process.env, log = console,
}) {
  const router = express.Router();
  router.use(requireAuth);

  const clientParam = (req, res, next) => {
    const resolved = resolveClientId(req.params.clientId);
    if (!resolved.ok) return res.status(404).json({ error: resolved.reason, code: resolved.code });
    req.client = getClient(resolved.clientId);
    return next();
  };
  const operator = req => String(req.body?.by || req.headers['x-operator'] || 'operator').slice(0, 200);
  const fail = (res, error) => {
    const status = ['client_isolation_violation', 'client_ownership_conflict'].includes(error.code) ? 409
      : /not_found$/.test(error.code || '') ? 404
        : error.code === 'ledger_unavailable' ? 503
          : error.code ? 422 : 500;
    if (status === 500) log.error(`[clients] ${error.message}`);
    return res.status(status).json({ error: error.message, code: error.code || 'error' });
  };

  async function ledgerFor(clientId) {
    const store = getStore();
    if (!store?.enabled) return { available: false, reason: store?.reason || 'client ledger is disabled' };
    try {
      const [opportunities, meetings, clarifications] = await Promise.all([
        store.listOpportunities(clientId), store.listMeetings(clientId), store.listClarifications(clientId),
      ]);
      return { available: true, opportunities, meetings, clarifications };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  router.get('/', (_req, res) => {
    res.json({
      clients: listClients().map(config => ({ ...publicClient(config), sending: clientSendState(config.id, env) })),
    });
  });

  router.get('/:clientId', clientParam, (req, res) => {
    res.json({
      client: publicClient(req.client),
      sending: clientSendState(req.client.id, env),
      campaigns: campaignsForClient(req.client.id).map(campaign => ({ ...campaign, sendable: campaignSendable(campaign) })),
    });
  });

  router.get('/:clientId/overview', clientParam, async (req, res) => {
    try {
      const dataset = await loadDataset({ force: req.query.refresh === '1' });
      const overview = buildClientOverview({
        clientId: req.client.id, leads: dataset.leads || [], activities: dataset.activities || [],
        senders: senders(), suppressedEmails: dataset.suppressedEmails || new Set(),
        ledger: await ledgerFor(req.client.id), env, routedLeadReady,
      });
      res.json({ ...overview, fetchedAt: new Date(dataset.at || Date.now()).toISOString() });
    } catch (error) { fail(res, error); }
  });

  router.get('/:clientId/leads', clientParam, async (req, res) => {
    try {
      const dataset = await loadDataset({ force: req.query.refresh === '1' });
      const mine = leadsForClient(dataset.leads || [], req.client.id);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      res.json({
        clientId: req.client.id, total: mine.length,
        leads: mine.slice(0, limit).map(lead => ({
          id: lead.id, company: lead.company, contactName: lead.contactName, email: lead.email,
          stage: lead.stage, emailStatus: lead.emailStatus, emailStep: lead.emailStep,
          campaign: lead.intendedCampaignVersion || lead.campaign, senderInboxId: lead.senderInboxId,
          routingReady: routedLeadReady(lead, env).ok,
        })),
      });
    } catch (error) { fail(res, error); }
  });

  router.post('/:clientId/leads/import-validate', clientParam, async (req, res) => {
    try {
      const dataset = await loadDataset({ force: false });
      res.json(validateClientLeadImport({
        clientId: req.client.id, campaignId: req.body?.campaignId, rows: req.body?.rows || [],
        existingLeads: dataset.leads || [], suppressedEmails: dataset.suppressedEmails || new Set(),
      }));
    } catch (error) { fail(res, error); }
  });

  // ── Ledger ────────────────────────────────────────────────────────────────
  const withStore = handler => async (req, res) => {
    const store = getStore();
    if (!store?.enabled) return res.status(503).json({ error: `client ledger is disabled: ${store?.reason || ''}`.trim(), code: 'ledger_unavailable' });
    try { return await handler(req, res, store); } catch (error) { return fail(res, error); }
  };
  const findLead = async (clientId, leadId) => {
    const dataset = await loadDataset({ force: true });
    const lead = leadsForClient(dataset.leads || [], clientId).find(item => String(item.id) === String(leadId));
    if (!lead) throw Object.assign(new Error(`lead ${leadId} does not belong to this client`), { code: 'client_isolation_violation' });
    return lead;
  };

  router.get('/:clientId/opportunities', clientParam, withStore(async (req, res, store) => {
    res.json({ clientId: req.client.id, opportunities: await store.listOpportunities(req.client.id) });
  }));
  router.post('/:clientId/opportunities', clientParam, withStore(async (req, res, store) => {
    const lead = await findLead(req.client.id, req.body?.leadId);
    res.json(await ledger.upsertOpportunity(store, {
      clientId: req.client.id, lead, conversationStatus: req.body?.conversationStatus,
      contactTitle: req.body?.contactTitle, notes: req.body?.notes, by: operator(req),
    }));
  }));

  router.get('/:clientId/meetings', clientParam, withStore(async (req, res, store) => {
    const meetings = (await store.listMeetings(req.client.id)).map(row => ledger.withBilling(row, req.client));
    res.json({ clientId: req.client.id, meetings, billing: ledger.billingSummary(meetings, req.client) });
  }));
  router.post('/:clientId/meetings', clientParam, withStore(async (req, res, store) => {
    const lead = await findLead(req.client.id, req.body?.leadId);
    res.json(await ledger.recordMeetingBooked(store, {
      clientId: req.client.id, lead, bookedAt: req.body?.bookedAt, scheduledFor: req.body?.scheduledFor,
      attendee: req.body?.attendee || {}, notes: req.body?.notes, by: operator(req),
    }));
  }));
  router.post('/:clientId/meetings/:meetingId/transition', clientParam, withStore(async (req, res, store) => {
    res.json(await ledger.updateMeeting(store, {
      clientId: req.client.id, meetingId: req.params.meetingId, toStatus: String(req.body?.toStatus || ''),
      patch: req.body?.patch || {}, by: operator(req),
    }));
  }));
  router.post('/:clientId/meetings/:meetingId/invoice', clientParam, withStore(async (req, res, store) => {
    res.json(await ledger.setInvoiceStatus(store, {
      clientId: req.client.id, meetingId: req.params.meetingId, invoiceStatus: String(req.body?.invoiceStatus || ''), by: operator(req),
    }));
  }));

  router.get('/:clientId/clarifications', clientParam, withStore(async (req, res, store) => {
    res.json({ clientId: req.client.id, clarifications: await store.listClarifications(req.client.id, { status: req.query.status || undefined }) });
  }));
  router.post('/:clientId/clarifications/:clarificationId/answer', clientParam, withStore(async (req, res, store) => {
    res.json(await ledger.answerClarification(store, {
      clientId: req.client.id, clarificationId: req.params.clarificationId,
      answer: req.body?.answer, answeredBy: operator(req),
    }));
  }));

  router.get('/:clientId/suppressions', clientParam, withStore(async (req, res, store) => {
    res.json({ clientId: req.client.id, suppressions: await store.listClientSuppressions(req.client.id) });
  }));
  router.post('/:clientId/suppressions', clientParam, withStore(async (req, res, store) => {
    const row = buildClientSuppression({
      clientId: req.client.id, matchType: req.body?.matchType, value: req.body?.value,
      reason: req.body?.reason, source: 'operator', createdBy: operator(req),
    });
    await store.addClientSuppression(row);
    log.log(JSON.stringify({ event: 'client_suppression_added', client_id: req.client.id, match_type: row.match_type, source: 'operator' }));
    res.json(row);
  }));
  router.post('/:clientId/suppressions/deactivate', clientParam, withStore(async (req, res, store) => {
    const row = buildClientSuppression({ clientId: req.client.id, matchType: req.body?.matchType, value: req.body?.value });
    await store.deactivateClientSuppression(req.client.id, row.match_type, row.match_value);
    log.log(JSON.stringify({ event: 'client_suppression_deactivated', client_id: req.client.id, match_type: row.match_type, by: operator(req) }));
    res.json({ ok: true });
  }));

  app.use('/api/clients', router);
  return router;
}

module.exports = { registerClientRoutes };
