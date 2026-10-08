'use strict';

// Source pins for the multi-client wiring in the two process entry points, and
// the catalog rules that keep a managed client out of ScaleLab's legacy
// resolvers. Narrow a pin to a new sanctioned call site; never delete one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agent = read('outreach-agent.js');
const server = read('server.js');

const { CLIENT_CAMPAIGNS, CLIENT_TEMPLATES, CLIENT_LEAD_TYPES, validateCatalog } = require('../integrations/clients/campaigns');
const { leadDefinitelyOtherClient } = require('../integrations/clients/ownership');
const { isStaffingLead } = require('../integrations/staffing-launch-gate');
const { resolveLeadFamily } = require('../integrations/campaign-versions');

test('pin: both Gmail send actions carry client ownership into the reservation', () => {
  const pins = agent.match(/ownership: actionOwnership\((lead|safetyLead), sender, \{ senders: GMAIL_SENDERS \}\)/g) || [];
  assert.equal(pins.length, 2);
});

test('pin: the final gate reads the client suppression list for the one lead being sent', () => {
  assert.match(agent, /loadClientSuppression: \(clientId, lead\) => getLedgerStore\(\)\.clientSuppressionsFor\(clientId, lead\)/);
  assert.match(agent, /senders: GMAIL_SENDERS,\n    loadClientSuppression/);
});

test('pin: every reply resolves its client context before any legacy handler runs', () => {
  const contextAt = agent.indexOf('const replyContext = resolveReplyClientContext({ senderInboxId: sender.id, lead, senders: GMAIL_SENDERS });');
  const roofingAt = agent.indexOf('if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) {', contextAt);
  const classifyAt = agent.indexOf('const canonicalReply = classifyReplyText(replyText', contextAt);
  assert.ok(contextAt > 0 && roofingAt > contextAt && classifyAt > contextAt);
  const block = agent.slice(contextAt, roofingAt);
  assert.match(block, /if \(!replyContext\.ok\) \{[\s\S]*client_reply_isolation_blocked[\s\S]*continue;\n    \}/);
  assert.match(block, /if \(replyContext\.policyMode === 'managed'\) \{[\s\S]*handleManagedClientReply[\s\S]*continue;\n    \}/);
  // A managed reply never reaches a sending path from here.
  assert.doesNotMatch(block, /sendEmail\(|deliverOrdinaryColdStep\(|guardProviderSend\(/);
});

test('pin: observers match only their own client\'s leads and route negative suppression by scope', () => {
  assert.match(agent, /const senderLeads = senderClient\.ok \? leadsInEmailScope\(candidates, senderClient\.clientId\) : candidates;/);
  // The legacy human-outbound scan correlates addresses inside the mailbox's client only.
  assert.match(agent, /if \(mailboxClient\.ok\) leads = leadsInEmailScope\(leads, mailboxClient\.clientId\);/);
  assert.match(agent, /suppress: item => withAuth\(\(\) => routeObserverSuppression\(item, senderLeads\)\)/);
  assert.doesNotMatch(agent, /suppress: item => withAuth\(\(\) => addSuppression\(item\.email, item\.reason, item\.company, 'gmail-observer'\)\)/);
});

test('pin: the directory endpoint scopes rows to a client on the server', () => {
  assert.match(server, /const ids = new Set\(leadsForClient\(dataset\.leads \|\| \[\], client\.clientId\)\.map\(lead => String\(lead\.id\)\)\);/);
  assert.match(server, /registerClientRoutes\(app, \{\n  requireAuth,/);
});

test('pin: client capacity is checked before every sender choice, and a refused lead never ends the pass', () => {
  const checks = [...agent.matchAll(/const clientCap = clientCapacityVerdict\(clientCapacity, tenantOf\(lead\)\);\n    if \(!clientCap\.allowed\) \{[^\n]*(return false|continue); \}\n    let senderChoice;/g)];
  assert.equal(checks.length, 3, 'all three attempt sites check client capacity');
  // Site 1 is inside attemptFollowUp (a function); sites 2 and 3 are loop bodies
  // of the send pass, where `return` would stop every other client's sends.
  assert.deepEqual(checks.map(match => match[1]), ['return false', 'continue', 'continue']);
  assert.equal((agent.match(/onProviderSuccess: providerSuccessCounter\(selectedSender, lead\),/g) || []).length, 3);
  assert.match(agent, /recordClientSend\(clientCapacity, tenantOf\(lead\)\);/);
});

test('pin: ownership is explicit from the first write; legacy imports stamp scalelab', () => {
  assert.match(server, /clientId: DEFAULT_CLIENT_ID,\n        \};/);
  assert.match(server, /lead\.clientId = DEFAULT_CLIENT_ID;/);
  assert.match(server, /const existingEmails = await existingColdEmailAddresses\(DEFAULT_CLIENT_ID\);/);
  assert.match(server, /coldEmailLeads: leadsForCalendarMatching\(dataset\.leads\), boardLeads,/);
});

test('legacy: observer scoping is the identity for every production lead shape', () => {
  const shapes = [
    { leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' }, { leadNiche: '' }, { campaign: 'Ontario List' },
    { leadNiche: 'industrial_staffing', campaign: 'Industrial Staffing Agency' }, { leadNiche: 'roofing' },
  ];
  for (const lead of shapes) assert.equal(leadDefinitelyOtherClient(lead, 'scalelab'), false);
  // A conflicted lead stays visible to every inbox so its opt-out is still applied.
  assert.equal(leadDefinitelyOtherClient({ leadNiche: 'jole_employer', tradeType: 'staffing' }, 'scalelab'), false);
  assert.equal(leadDefinitelyOtherClient({ leadNiche: 'jole_employer' }, 'scalelab'), true);
});

test('catalog: Jole contractor campaigns #1-#3 are archived; employer acquisition is the approved sender campaign', () => {
  const byId = Object.fromEntries(CLIENT_CAMPAIGNS.map(campaign => [campaign.id, campaign]));
  assert.equal(byId.JOLE_DC_MISSION_CRITICAL.clientId, 'jole');
  assert.equal(byId.JOLE_DC_MISSION_CRITICAL.audience, 'employers');
  assert.ok(byId.JOLE_DC_MISSION_CRITICAL.icp.contractorTypes.includes('electrical contractor'));
  assert.ok(byId.JOLE_DC_MISSION_CRITICAL.icp.workerCategories.includes('pipefitters'));
  assert.equal(byId.JOLE_GULF_INDUSTRIAL.status, 'disabled');
  assert.equal(byId.JOLE_SHIPYARD.status, 'disabled');
  for (const id of ['JOLE_DC_MISSION_CRITICAL', 'JOLE_GULF_INDUSTRIAL', 'JOLE_SHIPYARD']) assert.ok(byId[id].archivedAt, id);
  const acquisition = byId['jole-btx-employer-acquisition'];
  assert.equal(acquisition.status, 'approved');
  assert.equal(acquisition.label, 'Jole BTX — Manufacturing & Heavy Industry Employers');
  assert.equal(acquisition.emailTemplateId, 'jole-industrial-employer-v1');
  assert.equal(acquisition.campaignVersion, 'jole_industrial_employer_acquisition_v1');
  assert.ok(CLIENT_CAMPAIGNS.every(campaign => campaign.clientId === 'jole'));
  // Only the employer-acquisition copy is ready; placeholder templates never are.
  assert.deepEqual(CLIENT_TEMPLATES.filter(template => template.ready).map(template => template.id), ['jole-industrial-employer-v1']);
});

test('catalog: no Jole identifier can pull a lead into ScaleLab\'s legacy staffing/dental/roofing resolvers', () => {
  assert.equal(validateCatalog(), true);
  for (const id of [...CLIENT_CAMPAIGNS, ...CLIENT_TEMPLATES, ...CLIENT_LEAD_TYPES].map(item => item.id)) {
    assert.equal(isStaffingLead({ campaign: id }), false, id);
    // A Jole id resolves to Jole's own family or to nothing, never to a ScaleLab family.
    assert.ok(!['dental_ai_receptionist', 'roofing_survey', 'industrial_staffing'].includes(resolveLeadFamily({ campaign: id }).family), id);
  }
});
