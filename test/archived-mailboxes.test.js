'use strict';

// Owner-archived mailboxes (2026-11-24): deins@tryscalelabai.ca,
// deins@scalelabaiteam.com and deniels@tryscalelabai.ca are not listed on the
// dashboard. Display only: production holds them through COLD_SENDER_HOLDS, and
// lead history that names them still resolves (they stay in the registry).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ARCHIVED_MAILBOXES, isArchivedMailbox, listedSenders } = require('../integrations/archived-mailboxes');
const { buildClientOverview } = require('../integrations/clients/reporting');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('exactly the three owner-archived mailboxes', () => {
  assert.deepEqual(ARCHIVED_MAILBOXES.map(row => row.email),
    ['deins@tryscalelabai.ca', 'deins@scalelabaiteam.com', 'deniels@tryscalelabai.ca']);
  assert.ok(isArchivedMailbox({ id: 'scalelabaiteam' }));
  assert.ok(isArchivedMailbox({ id: 'whatever', email: 'Deniels@TryScaleLabAI.ca' }));
  assert.ok(!isArchivedMailbox({ id: 'primary', email: 'deins@scalelabai.ca' }));
  assert.ok(!isArchivedMailbox({ id: 'deniels', email: 'deniels@scalelabai.ca' }));
  assert.deepEqual(listedSenders([{ id: 'primary' }, { id: 'tryscalelabai' }, { id: 'outreachplateau_zoe' }]).map(s => s.id),
    ['primary', 'outreachplateau_zoe']);
});

test('the dashboard does not list archived mailboxes', () => {
  const status = server.slice(server.indexOf('async function gmailInboxStatus'), server.indexOf("app.get('/api/integrations/gmail-inboxes'"));
  assert.match(status, /inboxes: listedSenders\(inboxes\)\.map/);
  assert.match(server, /senders: listedSenders\(configuredSenders\(\)\)\.map/);
  assert.match(server, /senders: listedSenders\(view\.senderRows\)/);
  assert.match(server, /senderOptions: senderFilterOptions\(listedSenders\(/);
  assert.match(server, /inboxes: listedSenders\(gmailInboxOptions\(\)\), versions/);
  assert.match(server, /function visibleSenderIdentities\(\) \{\n  return gmailInboxOptions\(\)/, 'lead history still resolves archived inboxes');
  assert.equal((server.match(/observableSenders\(listedSenders\(configuredSenders\(\)\)\)/g) || []).length, 2, 'CRM Health observers skip them');
  assert.match(server, /mailboxObservationState: listedObservationRows\(dataset\.mailboxObservationState\)/);
  assert.match(server, /const rows = listedObservationRows\(dataset\.mailboxObservationState\);/);
});

test('Client Ops does not list archived mailboxes', () => {
  const overview = buildClientOverview({
    clientId: 'scalelab', leads: [], activities: [], routedLeadReady: () => true, env: {},
    senders: [
      { id: 'primary', email: 'deins@scalelabai.ca', clientId: 'scalelab', status: 'active', sendEligible: true, dailyLimit: 50, credentialConfigured: true },
      { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', clientId: 'scalelab', status: 'active', sendEligible: true, dailyLimit: 15, credentialConfigured: true },
    ],
  });
  assert.deepEqual(overview.deliverability.senders.map(s => s.id), ['primary']);
});
