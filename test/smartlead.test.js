'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature, verifySharedSecret, normalizeEvent } = require('../integrations/smartlead-events');
const { SmartleadClient, MockSmartleadClient } = require('../integrations/smartlead-client');
const { SmartleadOutreachProvider, GmailOutreachProvider } = require('../integrations/outreach-providers');
const { leadEligibility, shouldApplyRemoteEvent, isDuplicateRequest } = require('../integrations/outreach-policy');

test('validates webhook signatures and rejects invalid signatures', () => {
  const body = Buffer.from('{"event_type":"EMAIL_REPLY"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(body, signature + '0', 'secret'), false);
});

test('validates URL-token fallback with a timing-safe comparison', () => {
  assert.equal(verifySharedSecret('shared-secret', 'shared-secret'), true);
  assert.equal(verifySharedSecret('wrong-secret', 'shared-secret'), false);
  assert.equal(verifySharedSecret('', 'shared-secret'), false);
});

test('normalizes reply, unsubscribe, bounce, and unknown events', () => {
  assert.equal(normalizeEvent({ event_type: 'EMAIL_REPLY', to_email: 'A@B.COM' }).status, 'Replied');
  assert.equal(normalizeEvent({ event_type: 'LEAD_UNSUBSCRIBED', lead_email: 'a@b.com' }).status, 'Unsubscribed');
  assert.equal(normalizeEvent({ event_type: 'EMAIL_BOUNCE' }).status, 'Bounced');
  assert.equal(normalizeEvent({ event_type: 'NEW_EVENT' }).status, 'Ignored');
});

test('live mutations are disabled by default', async () => {
  const client = new SmartleadClient({ apiKey: 'test', integrationEnabled: true });
  const result = await client.addLeads(1, [{ email: 'approved@example.com' }]);
  assert.equal(result.testMode, true);
});

test('provider boundary keeps gmail and smartlead independent', async () => {
  let sent = false;
  const gmail = new GmailOutreachProvider({ send: async () => { sent = true; } });
  await gmail.sendEmail({ to: 'x@example.com' });
  assert.equal(sent, true);
  const mock = new MockSmartleadClient();
  const smartlead = new SmartleadOutreachProvider({ client: mock });
  await smartlead.addLeads({ externalCampaignId: '123' }, [{ email: 'x@example.com' }]);
  assert.match(mock.calls[0].path, /campaigns\/123\/leads/);
});

test('retries temporary Smartlead failures only', async () => {
  let calls = 0;
  const http = { request: async () => { calls++; if (calls < 3) { const e = new Error('temporary'); e.response = { status: 503, data: {} }; throw e; } return { data: { ok: true } }; } };
  const client = new SmartleadClient({ apiKey: 'test', integrationEnabled: true, liveMutationsEnabled: true, http, maxRetries: 2 });
  assert.deepEqual(await client.getCampaign('1'), { ok: true });
  assert.equal(calls, 3);
});

test('suppressed and actively assigned leads cannot be imported', () => {
  const lead = { id: 'local-1', email: 'lead@example.com' };
  assert.equal(leadEligibility({ lead, suppressedEmails: new Set(['lead@example.com']), providerMappings: [] }).ok, false);
  assert.equal(leadEligibility({ lead, suppressedEmails: new Set(), providerMappings: [{ internalLeadId: 'local-1', normalizedStatus: 'Queued' }] }).ok, false);
  assert.equal(leadEligibility({ lead, suppressedEmails: new Set(), providerMappings: [{ internalLeadId: 'local-1', normalizedStatus: 'Completed' }] }).ok, true);
});

test('duplicate request IDs are recognized', () => {
  assert.equal(isDuplicateRequest([{ requestId: 'req-1' }], 'req-1'), true);
  assert.equal(isDuplicateRequest([{ requestId: 'req-1' }], 'req-2'), false);
});

test('reconciliation never overwrites a newer local event', () => {
  assert.equal(shouldApplyRemoteEvent('2026-08-19T12:00:00Z', '2026-08-19T11:00:00Z'), false);
  assert.equal(shouldApplyRemoteEvent('2026-08-19T12:00:00Z', '2026-08-19T13:00:00Z'), true);
});
