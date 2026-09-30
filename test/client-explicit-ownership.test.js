'use strict';

// Explicit tenant ownership (lead.clientId / outreach_leads.client_id) and
// tenant-scoped email uniqueness UNIQUE(client_id, email_normalized).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLeadClient, ownerForWrite, checkClientConsistency } = require('../integrations/clients/ownership');
const {
  toOutreachLeadRow, toOutreachLeadPatch, fromOutreachLeadRow, compareOutreachLead, SHEET_FIELDS,
  getOutreachLeadByEmail,
} = require('../integrations/outreach-state');
const {
  leadsInEmailScope, leadsForCalendarMatching, emailTakenFor, emailUniquenessMode, groupByTenant,
} = require('../integrations/clients/email-scope');
const { matchMailboxMessages } = require('../integrations/gmail-mailbox-observer');
const { matchBookingIdentity } = require('../integrations/google-calendar');
const { queueEligibility } = require('../integrations/outreach-queue');
const { identityChecks, buildIndex } = require('../integrations/crm-health');
const { validateClientLeadImport } = require('../integrations/clients/lead-import');
const { planClientIdBackfill } = require('../integrations/clients/ownership-backfill');
const { createPostgrestDouble } = require('../test-support/postgrest-double');

const SHARED = 'ops@voltline.example.com';
const full = extra => Object.fromEntries(SHEET_FIELDS.map(field => [field, ''])) && ({
  ...Object.fromEntries(SHEET_FIELDS.map(field => [field, ''])), ...extra,
});
const scalelab = (id, extra = {}) => full({
  id, company: 'Voltline Dental', email: SHARED, stage: 'Queued', leadNiche: 'dental',
  emailTemplateId: 'dental-guarantee-v1', clientId: 'scalelab', ...extra,
});
const jole = (id, extra = {}) => full({
  id, company: 'Voltline Mission Critical', email: SHARED, stage: 'Queued', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-dc-mission-critical-v1', intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL',
  campaign: 'JOLE_DC_MISSION_CRITICAL', clientId: 'jole', ...extra,
});

// ── EXPLICIT OWNERSHIP ─────────────────────────────────────────────────────
test('ownership: explicit clientId is primary', () => {
  const verdict = resolveLeadClient({ id: 'x', clientId: 'jole' });
  assert.deepEqual([verdict.ok, verdict.clientId, verdict.source], [true, 'jole', 'explicit']);
  assert.equal(resolveLeadClient({ id: 'y', clientId: 'SCALELAB', leadNiche: 'dental' }).clientId, 'scalelab');
});

test('ownership: an explicit owner contradicted by its own routing fields fails closed', () => {
  assert.equal(resolveLeadClient({ clientId: 'jole', leadNiche: 'dental' }).code, 'client_ownership_conflict');
  assert.equal(resolveLeadClient({ clientId: 'scalelab', intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL' }).code, 'client_ownership_conflict');
  assert.equal(resolveLeadClient({ clientId: 'acme' }).code, 'client_ownership_conflict');
  assert.throws(() => ownerForWrite({ clientId: 'jole', emailTemplateId: 'dental-guarantee-v1' }), error => error.code === 'client_ownership_conflict');
});

test('ownership: inference only for blank legacy rows', () => {
  const legacy = resolveLeadClient({ leadNiche: 'dental' });
  assert.deepEqual([legacy.clientId, legacy.source], ['scalelab', 'inferred']);
  assert.equal(resolveLeadClient({ leadNiche: '' }).clientId, 'scalelab');
});

test('ownership: operational boundaries compare the explicit lead owner with campaign and sender', () => {
  const senders = [{ id: 'jole_test', email: 'o@jole.example.com', clientId: 'jole' }, { id: 'primary', email: 'p@x.example.com' }];
  assert.equal(checkClientConsistency({ lead: jole('j'), senderInboxId: 'jole_test', senders }).ok, true);
  assert.equal(checkClientConsistency({ lead: jole('j'), senderInboxId: 'primary', senders }).code, 'client_ownership_conflict');
  assert.equal(checkClientConsistency({ lead: scalelab('s'), campaignId: 'JOLE_DC_MISSION_CRITICAL', senders }).code, 'client_ownership_conflict');
});

// ── CANONICAL STORE ────────────────────────────────────────────────────────
test('store: client_id is written when explicit, never written blank, and patches cannot clear it', () => {
  assert.equal(toOutreachLeadRow(jole('j')).client_id, 'jole');
  assert.equal('client_id' in toOutreachLeadRow(scalelab('s', { clientId: '' })), false, 'blank owner leaves the stored value / default');
  // ScaleLab rows never depend on the column: the default supplies the owner.
  assert.equal('client_id' in toOutreachLeadRow(scalelab('s')), false);
  assert.equal(fromOutreachLeadRow({ lead_id: 'j', client_id: 'jole' }).clientId, 'jole');
  assert.throws(() => toOutreachLeadPatch('j', { clientId: '' }), /never cleared/);
  assert.throws(() => toOutreachLeadPatch('j', { clientId: 'acme' }), /registered client/);
  assert.equal(toOutreachLeadPatch('j', { clientId: 'jole' }).client_id, 'jole');
});

test('store: ownership parity is on the effective owner — no split brain passes', () => {
  // Sheets not yet backfilled (blank) vs stored 'scalelab': the same owner.
  assert.deepEqual(compareOutreachLead(scalelab('s', { clientId: '' }), scalelab('s')).critical, []);
  // Supabase = jole, Sheets = scalelab: critical.
  assert.ok(compareOutreachLead(jole('j', { clientId: 'scalelab', leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '', campaign: '' }),
    jole('j', { leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '', campaign: '' })).critical.includes('clientId'));
  // Supabase = jole, Sheets = blank with ScaleLab-looking routing: critical.
  assert.ok(compareOutreachLead(scalelab('s', { clientId: '' }), scalelab('s', { clientId: 'jole', leadNiche: '', emailTemplateId: '' })).critical.includes('clientId'));
});

test('store (PostgREST double): default scalelab backfill, tenant-scoped uniqueness, no same-client duplicate', async () => {
  const insert = async (double, rows) => fetch(`${double.url}/rest/v1/outreach_leads`, {
    method: 'POST', headers: { ...double.headers, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(rows),
  });
  for (const [mode, crossClientStatus] of [['global', 409], ['client', 201]]) {
    const double = createPostgrestDouble({ emailUniqueness: mode });
    const env = await double.start();
    double.url = env.SUPABASE_URL;
    double.headers = { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` };
    try {
      const legacy = await insert(double, [{ lead_id: 'old', email: SHARED }]);
      assert.equal(legacy.status, 201);
      assert.equal((await legacy.json())[0].client_id, 'scalelab', 'the column default is the backfill');
      assert.equal((await insert(double, [{ lead_id: 'dup', email: SHARED, client_id: 'scalelab' }])).status, 409, 'never two rows for one address inside one client');
      assert.equal((await insert(double, [{ lead_id: 'j1', email: SHARED, client_id: 'jole' }])).status, crossClientStatus, `cross-client under ${mode}`);
      assert.equal((await insert(double, [{ lead_id: 'bad', email: 'x@y.example.com', client_id: 'acme' }])).status, 409, 'foreign key to clients');
    } finally { await double.stop(); }
  }
});

test('store: an email lookup is client-scoped and never returns one of two clients arbitrarily', async () => {
  const double = createPostgrestDouble({ emailUniqueness: 'client', rows: [
    { lead_id: 's1', email: SHARED, client_id: 'scalelab' }, { lead_id: 'j1', email: SHARED, client_id: 'jole' },
  ] });
  const env = await double.start();
  try {
    const ambiguous = await getOutreachLeadByEmail(SHARED, { env });
    assert.equal(ambiguous.ok, false); assert.equal(ambiguous.ambiguous, true);
    assert.equal((await getOutreachLeadByEmail(SHARED, { env, clientId: 'jole' })).lead.id, 'j1');
    assert.equal((await getOutreachLeadByEmail(SHARED, { env, clientId: 'scalelab' })).lead.id, 's1');
  } finally { await double.stop(); }
});

// ── EMAIL SCOPE ────────────────────────────────────────────────────────────
test('email scope: uniqueness mode defaults to global until the index migration is applied', () => {
  assert.equal(emailUniquenessMode({}), 'global');
  assert.equal(emailUniquenessMode({ OUTREACH_EMAIL_UNIQUENESS: 'client' }), 'client');
});

test('email scope: each inbox sees one lead per address; conflicted leads stay visible unless they collide', () => {
  const corpus = [scalelab('s1'), jole('j1'), full({ id: 'c1', email: 'solo@x.example.com', clientId: 'jole', leadNiche: 'dental' })];
  assert.deepEqual(leadsInEmailScope(corpus, 'scalelab').map(lead => lead.id), ['s1', 'c1']);
  assert.deepEqual(leadsInEmailScope(corpus, 'jole').map(lead => lead.id), ['j1', 'c1']);
  const colliding = [...corpus, full({ id: 'c2', email: SHARED, clientId: 'jole', leadNiche: 'dental' })];
  assert.deepEqual(leadsInEmailScope(colliding, 'scalelab').map(lead => lead.id), ['s1', 'c1']);
  assert.deepEqual(leadsForCalendarMatching(corpus).map(lead => lead.id), ['s1', 'c1']);
  assert.deepEqual(groupByTenant([scalelab('a'), jole('b')]).map(group => group.map(lead => lead.id)), [['a'], ['b']]);
});

test('replies: the same address under two clients never makes a Gmail observer throw or cross-match', () => {
  const message = { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-10-02T15:00:00Z')), labelIds: ['INBOX'],
    payload: { headers: [{ name: 'From', value: `Ops <${SHARED}>` }, { name: 'Subject', value: 'Re: staffing' }], mimeType: 'text/plain', body: { data: Buffer.from('Interested').toString('base64url') } } };
  const leads = [scalelab('s1', { lastEmailedAt: '2026-10-01T00:00:00Z' }), jole('j1', { lastEmailedAt: '2026-10-01T00:00:00Z' })];
  // Unscoped, the observer refuses an ambiguous identity (and would stall).
  assert.throws(() => matchMailboxMessages([message], { leads, senderInboxId: 'jole_test', senderEmail: 'o@jole.example.com' }), /Ambiguous inbound CRM identity/);
  const joleInbox = matchMailboxMessages([message], { leads: leadsInEmailScope(leads, 'jole'), senderInboxId: 'jole_test', senderEmail: 'o@jole.example.com' });
  assert.deepEqual([...joleInbox.replies.keys()], ['j1']);
  const scalelabInbox = matchMailboxMessages([message], { leads: leadsInEmailScope(leads, 'scalelab'), senderInboxId: 'primary', senderEmail: 'p@scalelab.example.com' });
  assert.deepEqual([...scalelabInbox.replies.keys()], ['s1']);
});

test('calendar: another client\'s lead with the same address never turns a ScaleLab booking into a blocking conflict', () => {
  const leads = [scalelab('s1'), jole('j1')];
  assert.equal(matchBookingIdentity(SHARED, { coldEmailLeads: leads }).status, 'conflict');
  const scoped = matchBookingIdentity(SHARED, { coldEmailLeads: leadsForCalendarMatching(leads) });
  assert.equal(scoped.status, 'matched');
  assert.equal(scoped.coldEmailLead.id, 's1');
});

test('queue: a cross-client duplicate is not ambiguous; a same-client duplicate still is', () => {
  const lead = scalelab('s1', { email: 'office@brightsmiles.example.com', emailStatus: '' });
  const other = jole('j1', { email: 'office@brightsmiles.example.com' });
  assert.notEqual(queueEligibility(lead, { leads: [lead, other] }).reason, 'ambiguous lead identity');
  const twin = scalelab('s2', { email: 'office@brightsmiles.example.com' });
  assert.equal(queueEligibility(lead, { leads: [lead, twin, other] }).reason, 'ambiguous lead identity');
  const unowned = full({ id: 'c', email: 'office@brightsmiles.example.com', clientId: 'jole', leadNiche: 'dental' });
  assert.equal(queueEligibility(lead, { leads: [lead, unowned] }).reason, 'ambiguous lead identity');
});

test('CRM health: duplicates are judged per client', () => {
  const findings = identityChecks({ leads: [scalelab('s1'), jole('j1')], boardLeads: [] }, buildIndex({ leads: [scalelab('s1'), jole('j1')] }));
  assert.equal(findings.find(item => item.id === 'identity.duplicate_coldemail').status, 'pass');
  const dup = [scalelab('s1'), scalelab('s2')];
  assert.equal(identityChecks({ leads: dup, boardLeads: [] }, buildIndex({ leads: dup })).find(item => item.id === 'identity.duplicate_coldemail').status, 'fail');
  // A ScaleLab Pipeline card never maps to the Jole lead by address.
  const index = buildIndex({ leads: [jole('j1')], boardLeads: [{ id: 'card-1', email: SHARED }] });
  assert.equal(index.boardToLead.has('card-1'), false);
});

// ── IMPORT ─────────────────────────────────────────────────────────────────
test('import: explicit owner on every proposed row; cross-client allowed only once uniqueness is tenant-scoped', () => {
  const existing = [scalelab('s1')];
  const row = { company: 'Voltline Mission Critical', email: SHARED };
  const global = validateClientLeadImport({ clientId: 'jole', campaignId: 'JOLE_DC_MISSION_CRITICAL', rows: [row], existingLeads: existing, env: {} });
  assert.deepEqual(global.refusals.map(r => r.code), ['cross_client_collision']);
  const scoped = validateClientLeadImport({ clientId: 'jole', campaignId: 'JOLE_DC_MISSION_CRITICAL', rows: [row], existingLeads: existing, env: { OUTREACH_EMAIL_UNIQUENESS: 'client' } });
  assert.equal(scoped.accepted, 1);
  assert.equal(scoped.leads[0].clientId, 'jole');
  assert.equal(scoped.emailUniqueness, 'client');
  const again = validateClientLeadImport({ clientId: 'jole', campaignId: 'JOLE_DC_MISSION_CRITICAL', rows: [row], existingLeads: [...existing, jole('j1')], env: { OUTREACH_EMAIL_UNIQUENESS: 'client' } });
  assert.deepEqual(again.refusals.map(r => r.code), ['duplicate'], 'never a second row inside the same client');
});

test('import: tenant mode still honours the global suppression list', () => {
  const verdict = validateClientLeadImport({ clientId: 'jole', campaignId: 'JOLE_DC_MISSION_CRITICAL', rows: [{ company: 'X', email: SHARED }],
    existingLeads: [], suppressedEmails: new Set([SHARED]), env: { OUTREACH_EMAIL_UNIQUENESS: 'client' } });
  assert.deepEqual(verdict.refusals.map(r => r.code), ['globally_suppressed']);
  assert.equal(emailTakenFor({ email: SHARED, clientId: 'jole', leads: [scalelab('s1')], env: { OUTREACH_EMAIL_UNIQUENESS: 'client' } }).taken, false);
});

// ── BACKFILL PLAN ──────────────────────────────────────────────────────────
test('backfill: fills blank Sheets owners that agree with the store, refuses any split brain', () => {
  const sheet = [scalelab('a', { clientId: '', _row: 2 }), scalelab('b', { _row: 3 })];
  const store = [scalelab('a'), scalelab('b')];
  const plan = planClientIdBackfill({ sheetLeads: sheet, storeLeads: store });
  assert.equal(plan.refuse, false);
  assert.deepEqual(plan.writes, [{ id: 'a', row: 2, clientId: 'scalelab' }]);
  assert.equal(plan.ok, 1);
  const split = planClientIdBackfill({ sheetLeads: [scalelab('a', { clientId: '', _row: 2 })], storeLeads: [scalelab('a', { clientId: 'jole', leadNiche: '', emailTemplateId: '' })] });
  assert.equal(split.refuse, true); assert.equal(split.mismatch, 1); assert.deepEqual(split.writes, []);
  const missing = planClientIdBackfill({ sheetLeads: [scalelab('z', { _row: 9 })], storeLeads: [] });
  assert.equal(missing.refuse, true); assert.equal(missing.notInStore, 1);
});
