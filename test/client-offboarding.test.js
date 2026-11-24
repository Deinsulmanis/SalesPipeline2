'use strict';

// Client offboarding (Jole BTX, 2026-11-24). CLIENT_OFFBOARDED=jole makes Jole
// an inactive client: nothing sends for it, it holds no capacity, its
// workspace and inboxes are not listed, its jobs do not run, and its leads can
// be archived in bulk. ScaleLab (the default client) is never touched.

process.env.CLIENT_OFFBOARDED = 'jole';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getClient, buildRegistry, offboardedClientIds } = require('../integrations/clients/registry');
const { clientSendBlock } = require('../integrations/clients/send-policy');
const { planClientOffboarding } = require('../integrations/client-offboarding');
const { listedSenders, retiredClientInbox } = require('../integrations/archived-mailboxes');
const { ARCHIVE_REASONS, isArchivedLead } = require('../integrations/lead-archive');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'integrations', 'clients', 'routes.js'), 'utf8');
const report = fs.readFileSync(path.join(root, 'integrations', 'clients', 'daily-report.js'), 'utf8');

const stableId = (...parts) => parts.join(':');
const joleLead = (id, extra = {}) => ({ id, email: `${id}@employer.com`, company: `Employer ${id}`, stage: 'Queued', emailStatus: '',
  campaign: 'jole-btx-employer-acquisition', emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  leadNiche: 'jole_employer', clientId: 'jole', notes: '', ...extra });
const scalelabLead = (id, extra = {}) => ({ id, email: `${id}@staffing.com`, company: `Staffing ${id}`, stage: 'Queued', emailStatus: '',
  campaign: 'Industrial Campaign 3', emailTemplateId: 'industrial-staffing-campaign-3', intendedCampaignVersion: 'industrial_staffing_campaign_3',
  leadNiche: 'industrial_staffing', notes: '', ...extra });

test('CLIENT_OFFBOARDED=jole makes Jole an inactive, non-sending client with no capacity', () => {
  const jole = getClient('jole');
  assert.equal(jole.lifecycleStatus, 'offboarded');
  assert.equal(jole.active, false);
  assert.equal(jole.sending.enabled, false);
  assert.equal(jole.capacity.dailyCap, 0);
  assert.equal(jole.capacity.windowCap, 0);
  assert.equal(clientSendBlock('jole', { CLIENT_SENDING_AUTHORIZED: 'jole' }).code, 'client_inactive');
});

test('the default client can never be offboarded, and other clients are unchanged', () => {
  assert.deepEqual([...offboardedClientIds({ CLIENT_OFFBOARDED: ' Jole , scalelab ' })], ['jole', 'scalelab']);
  const registry = buildRegistry(undefined, { CLIENT_OFFBOARDED: 'scalelab,jole' });
  assert.equal(registry.byId.get('scalelab').lifecycleStatus, 'active');
  assert.equal(registry.byId.get('scalelab').active, true);
  assert.equal(getClient('scalelab').active, true);
  assert.equal(clientSendBlock('scalelab', {}), null);
  assert.equal(buildRegistry(undefined, {}).byId.get('jole').lifecycleStatus, 'active', 'without the variable Jole is as configured');
});

test('the offboarding plan archives only the offboarded client\'s unarchived leads', () => {
  const leads = [
    joleLead('j1'), joleLead('j2', { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-11-20T15:00:00.000Z' }),
    joleLead('j3', { notes: '[ARCHIVED: manual_archive]', stage: 'Archived' }),
    scalelabLead('s1'), scalelabLead('s2', { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1' }),
  ];
  const plan = planClientOffboarding({ clientId: 'jole', leads, archivedBy: 'test', stableId, now: new Date('2026-11-24T09:30:00Z') });
  assert.deepEqual(plan.leadPlans.map(item => item.leadId).sort(), ['j1', 'j2']);
  assert.equal(plan.summary.total, 3);
  assert.equal(plan.summary.alreadyArchived, 1);
  assert.equal(plan.summary.toArchive, 2);
  for (const item of plan.leadPlans) {
    assert.equal(item.event.eventType, 'lead_archived');
    assert.match(JSON.stringify(item.patch), new RegExp(ARCHIVE_REASONS.CLIENT_OFFBOARDED));
  }
  assert.ok(!plan.leadPlans.some(item => item.leadId.startsWith('s')), 'no ScaleLab lead is ever planned');
});

test('the plan refuses ScaleLab and any client that is not offboarded', () => {
  assert.throws(() => planClientOffboarding({ clientId: 'scalelab', leads: [], archivedBy: 'x', stableId }), /default client/);
});

test('an offboarded client\'s workspace and inboxes are not listed; its jobs do not run', () => {
  assert.match(routes, /listClients\(\)\.filter\(config => config\.lifecycleStatus !== 'offboarded'\)/);
  assert.ok(retiredClientInbox({ id: 'jole_group_jorge', clientId: 'jole' }));
  assert.ok(!retiredClientInbox({ id: 'primary' }));
  assert.deepEqual(listedSenders([{ id: 'primary' }, { id: 'jole_group_jorge', clientId: 'jole' }, { id: 'outreachplateau_zoe', clientId: 'scalelab' }]).map(s => s.id),
    ['primary', 'outreachplateau_zoe']);
  assert.equal((server.match(/if \(!getManagedClientConfig\('jole'\)\.active\) return;   \/\/ offboarded: no refill/g) || []).length, 2);
  assert.match(server, /filter\(\(\[clientId\]\) => getManagedClientConfig\(clientId\)\.active\)/);
  assert.match(report, /if \(!getClient\(CLIENT_ID\)\.active\) return null;/);
});

test('bulk archive routes exist, are dry-run first, and use the archive guards', () => {
  assert.match(server, /app\.get\('\/api\/ops\/client-offboarding\/:clientId'/);
  const apply = server.slice(server.indexOf("app.post('/api/ops/client-offboarding/:clientId'"), server.indexOf('// Archive one lead by hand'));
  assert.match(apply, /archiveMutationBlocked\(\)/);
  assert.match(apply, /Number\(req\.body\?\.expectedLeads\) !== plan\.leadPlans\.length/);
  assert.match(apply, /applyArchivePlans\(batch\)/);
  assert.match(server, /client\.isDefault \|\| client\.lifecycleStatus !== 'offboarded' \? null : client/);
  assert.equal(isArchivedLead({ notes: '[ARCHIVED: client_offboarded]' }), true);
});
