'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { registerClientRoutes } = require('../integrations/clients/routes');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { buildClientOverview } = require('../integrations/clients/reporting');
const { routedLeadReady } = require('../integrations/campaign-routing');
const ledger = require('../integrations/clients/ledger');

const joleLead = (id, extra = {}) => ({
  id, company: `Jole Employer ${id}`, contactName: 'Pat', email: `${id}@jole-employer-test.invalid`,
  stage: 'Import', emailStatus: '', emailStep: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', senderInboxId: '', routingRequired: 'true', tradeType: '', ...extra,
});
const scalelabLead = (id, extra = {}) => ({
  id, company: `Dental ${id}`, email: `${id}@dental-test.invalid`, stage: 'Contacted', emailStatus: 'emailed',
  emailStep: '1', notes: '', leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List', senderInboxId: 'primary', routingRequired: 'true', ...extra,
});
const DATASET = {
  at: Date.parse('2026-10-01T00:00:00Z'),
  leads: [joleLead('j1'), joleLead('j2'), scalelabLead('s1'), scalelabLead('s2'), scalelabLead('s3')],
  activities: [
    { eventId: 'e1', sourceLeadId: 's1', eventType: 'initial_email_sent', metadata: '{}' },
    { eventId: 'e2', sourceLeadId: 's1', eventType: 'positive_reply', metadata: '{"gmailMessageId":"g1"}' },
    { eventId: 'e3', sourceLeadId: 'j1', eventType: 'client_reply_classified', metadata: '{"sentiment":"positive","gmailMessageId":"g2"}' },
  ],
  suppressedEmails: new Set(['s3@dental-test.invalid']),
};

async function withServer(store, run) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => (req.headers.authorization === 'Basic test' ? next() : res.status(401).json({ error: 'auth' }));
  registerClientRoutes(app, {
    requireAuth, loadDataset: async () => DATASET, getStore: () => store, senders: () => [], routedLeadReady,
    env: {}, log: { log() {}, error() {} },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, auth = true) => fetch(base + path, { headers: auth ? { authorization: 'Basic test' } : {} });
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { authorization: 'Basic test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try { await run({ get, post }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('API: every client route requires operator auth; there is no client-facing route', async () => {
  await withServer(createMemoryLedgerStore(), async ({ get }) => {
    assert.equal((await get('/api/clients', false)).status, 401);
    assert.equal((await get('/api/clients/jole/overview', false)).status, 401);
    const list = await (await get('/api/clients')).json();
    const jole = list.clients.find(client => client.clientId === 'jole');
    assert.equal(jole.platformAccess, 'none');
    assert.equal(jole.sending.sendingEnabled, false);
    assert.equal((await get('/api/clients/acme')).status, 404);
  });
});

test('API: Jole filters Jole data; ScaleLab filters ScaleLab data — on the server', async () => {
  const store = createMemoryLedgerStore();
  await withServer(store, async ({ get }) => {
    const jole = await (await get('/api/clients/jole/leads')).json();
    assert.deepEqual(jole.leads.map(lead => lead.id), ['j1', 'j2']);
    const scalelab = await (await get('/api/clients/scalelab/leads')).json();
    assert.deepEqual(scalelab.leads.map(lead => lead.id), ['s1', 's2', 's3']);
    const overview = await (await get('/api/clients/jole/overview')).json();
    assert.equal(overview.leads.imported, 2);
    assert.equal(overview.deliverability.sends, 0);
    assert.equal(overview.replies.positive, 1);
    assert.equal(overview.sending.sendingEnabled, false);
    assert.equal(overview.campaigns.length, 4);
    assert.equal(overview.campaigns.find(c => c.id === 'jole-btx-employer-acquisition').leads, 2);
    assert.equal(overview.campaigns.find(c => c.id === 'jole-btx-employer-acquisition').sendable, false);
    assert.equal(JSON.stringify(overview).includes('dental-test.invalid'), false, 'no ScaleLab record leaks into the Jole view');
    const sl = await (await get('/api/clients/scalelab/overview')).json();
    assert.equal(sl.leads.imported, 3);
    assert.equal(sl.deliverability.sends, 1);
    assert.equal(sl.deliverability.suppressed, 1);
    assert.equal(sl.pipeline, null);
    assert.equal(JSON.stringify(sl).includes('jole-employer-test.invalid'), false);
  });
});

test('API: before activation, Jole fulfillment writes are refused (422 client_not_active)', async t => {
  t.after(require('../test-support/client-lifecycle').pendingJoleForTest());
  await withServer(createMemoryLedgerStore(), async ({ get, post }) => {
    const refused = await post('/api/clients/jole/meetings', { leadId: 'j1', scheduledFor: '2026-10-08T16:00:00Z' });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).code, 'client_not_active');
    const overview = await (await get('/api/clients/jole/overview')).json();
    assert.equal(overview.client.active, false);
    assert.equal(overview.client.lifecycleStatus, 'onboarding_pending');
    assert.equal(overview.sending.blockCode, 'client_inactive');
  });
});

test('API: ledger routes are client-scoped and refuse another client\'s lead', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const store = createMemoryLedgerStore();
  await withServer(store, async ({ get, post }) => {
    const cross = await post('/api/clients/jole/meetings', { leadId: 's1', scheduledFor: '2026-10-08T16:00:00Z' });
    assert.equal(cross.status, 409);
    const ok = await post('/api/clients/jole/meetings', { leadId: 'j1', scheduledFor: '2026-10-08T16:00:00Z', by: 'deins' });
    assert.equal(ok.status, 200);
    const meeting = await ok.json();
    const held = await post(`/api/clients/jole/meetings/${encodeURIComponent(meeting.meeting_id)}/transition`, { toStatus: 'HELD' });
    assert.equal((await held.json()).meeting_status, 'HELD');
    const scalelabView = await get('/api/clients/scalelab/meetings');
    assert.equal(scalelabView.status, 200);
    assert.deepEqual((await scalelabView.json()).meetings, []);
    const sup = await post('/api/clients/jole/suppressions', { matchType: 'company', value: 'Current Customer Inc.', reason: 'Jole current client' });
    assert.equal((await sup.json()).match_value, 'current customer');
    assert.equal((await (await get('/api/clients/scalelab/suppressions')).json()).suppressions.length, 0);
  });
});

test('API: ledger routes report 503 when the ledger is disabled; overview still renders', async () => {
  await withServer(createMemoryLedgerStore({ available: false }), async ({ get, post }) => {
    assert.equal((await get('/api/clients/jole/meetings')).status, 503);
    assert.equal((await post('/api/clients/jole/suppressions', { matchType: 'email', value: 'a@b.co' })).status, 503);
    const overview = await (await get('/api/clients/jole/overview')).json();
    assert.equal(overview.pipeline.available, false);
  });
});

test('reporting: pipeline and billing come only from this client\'s ledger rows', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const store = createMemoryLedgerStore();
  const meeting = await ledger.recordMeetingBooked(store, { clientId: 'jole', lead: joleLead('j1'), scheduledFor: '2026-10-08T16:00:00Z' });
  await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'NO_SHOW' });
  const overview = buildClientOverview({
    clientId: 'jole', leads: DATASET.leads, activities: DATASET.activities, routedLeadReady, env: {},
    ledger: {
      available: true, opportunities: await store.listOpportunities('jole'),
      meetings: [...await store.listMeetings('jole'), { meeting_id: 'foreign', client_id: 'scalelab', meeting_status: 'QUALIFIED_HELD' }],
      clarifications: [],
    },
  });
  assert.equal(overview.pipeline.meetingsBooked, 1);
  assert.equal(overview.pipeline.noShow, 1);
  assert.equal(overview.billing.billableMeetings, 0);
  assert.equal(overview.billing.configuredFeeCents, 35000);
});
