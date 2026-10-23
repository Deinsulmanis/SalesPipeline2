'use strict';

// Industrial Staffing Agency (V1) completed on 2026-10-23. Its 1,002 leads keep
// every field and event; nothing may be sent for them by any path. Staffing
// Outreach Campaign 2, Industrial Staffing Agency V2 and every Jole campaign
// share the offer, niche or senders and must be untouched. Nothing here
// contacts Google, Gmail or Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COMPLETED_CAMPAIGNS, completedCampaignFor, completedCampaignByLabel, setCompletedCampaignsForTests,
  outreachBlockForLead, retiredOfferBlock, retiredOfferFor, retiredOfferById, isArchivedLead,
} = require('../integrations/lead-archive');
const { sendableNow } = require('../integrations/offer-retirement');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { googleRecipient } = require('../test-support/google-recipient');
const { deriveAutomationOwnership, OWNER, BLOCKED_BY } = require('../integrations/automation-ownership');
const { sequenceAllowedForLead } = require('../integrations/stage-sequences');
const { isActiveOutreachLead, scopeLeads } = require('../integrations/analytics-scope');
const { STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2 } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T06:00:00.000Z');
const STAFFING_ENV = Object.freeze({ STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' });
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true', ...STAFFING_ENV,
});
const gate = (snapshot, current = snapshot, purpose = 'cold') => guardProviderSend(snapshot,
  { env: SEND_ENV, classifyRecipient: googleRecipient, loadFreshState: async () => ({ current, suppressedEmails: new Set() }) }, { purpose });

let seq = 0;
// Production shape of a routed V1 lead (outreach_leads, 2026-10-23).
const v1Lead = (extra = {}) => {
  seq += 1;
  return { id: `v1-${seq}`, company: `Staffing Co ${seq}`, contactName: 'Alex', email: `s${seq}@staffing.test`,
    stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', tradeType: 'B (skilled trades / construction labor)',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    intendedCampaignVersion: STAFFING_CAMPAIGN.id, siteContext: 'Your warehouse staffing team serves local manufacturers.',
    senderInboxId: 'primary', routingRequired: 'true', clientId: 'scalelab', sheetRow: seq, revision: 1, ...extra };
};
const followUpDue = lead => ({ ...lead, stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
  lastEmailedAt: new Date(NOW - 10 * DAY).toISOString() });
// Production shape of a Staffing Outreach Campaign 2 lead: imported, not yet routed.
const campaign2Lead = (extra = {}) => v1Lead({ campaign: 'Staffing Outreach Campaign 2', stage: 'Import',
  emailTemplateId: '', intendedCampaignVersion: '', senderInboxId: '', ...extra });

test('the completed campaign is exactly Industrial Staffing Agency V1, owned by ScaleLab', () => {
  assert.equal(COMPLETED_CAMPAIGNS.length, 1);
  const [completed] = COMPLETED_CAMPAIGNS;
  assert.equal(completed.id, STAFFING_CAMPAIGN.id);
  assert.equal(completed.label, STAFFING_CAMPAIGN.name);
  assert.deepEqual([...completed.labels].sort(),
    [STAFFING_CAMPAIGN.name, STAFFING_CAMPAIGN.id, ...STAFFING_CAMPAIGN.legacyNames].sort());
  assert.equal(completed.clientId, 'scalelab');
  assert.equal(completed.completedAt, '2026-10-23');
  assert.ok(!completed.labels.includes(STAFFING_CAMPAIGN_V2.name));
  assert.ok(!completed.labels.includes('Staffing Outreach Campaign 2'));
  assert.equal(completedCampaignByLabel(STAFFING_CAMPAIGN.name), completed);
  assert.equal(completedCampaignByLabel('Staffing Outreach Campaign 2'), null);
});

test('a V1 lead in any state cannot be routed, sent, sequenced or refilled', async () => {
  const leads = [
    v1Lead(),
    followUpDue(v1Lead()),
    followUpDue(v1Lead({ campaign: STAFFING_CAMPAIGN.legacyNames[0] })),
    v1Lead({ stage: 'Import', emailTemplateId: '', intendedCampaignVersion: '', senderInboxId: '' }),
    v1Lead({ clientId: '' }),
  ];
  for (const lead of leads) {
    assert.equal(outreachBlockForLead(lead).code, 'campaign_completed', lead.id);
    assert.match(outreachBlockForLead(lead).reason, /Industrial Staffing Agency campaign was completed on 2026-10-23/);
    assert.equal(routedLeadReady(lead, STAFFING_ENV).code, 'campaign_completed', lead.id);
    for (const purpose of ['cold', 'sequence', 'warm']) {
      assert.equal((await gate(lead, lead, purpose)).code, 'campaign_completed', `${lead.id} ${purpose}`);
    }
    assert.equal(sequenceAllowedForLead('hot_stale_v1', lead).code, 'campaign_completed', lead.id);
    assert.equal(sendableNow(lead, { now: NOW }), false, lead.id);
  }
});

test('the final gate refuses on the lead as it is NOW, even from a stale sendable snapshot', async () => {
  const stale = followUpDue(campaign2Lead({ id: 'moved', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }));
  const current = { ...stale, campaign: STAFFING_CAMPAIGN.name };
  assert.equal((await gate(stale, current)).code, 'campaign_completed');
});

test('reply automation is stopped, but a human or meeting owner is still reported truthfully', () => {
  const lead = v1Lead({ stage: 'Contacted', emailStatus: 'replied', emailStep: '1' });
  const auto = deriveAutomationOwnership(lead, { boardLead: { stage: 'hot' }, sendingEnabled: true,
    replyResponseDecision: { send: true, action: 'AUTO_BOOKING_RESPONSE' } });
  assert.equal(auto.owner, OWNER.NONE);
  assert.equal(auto.blockedBy, BLOCKED_BY.OFFER_RETIRED);
  assert.equal(auto.sendAllowed, false);
  const cold = deriveAutomationOwnership(followUpDue(v1Lead()), { sendingEnabled: true, coldCadenceDue: true });
  assert.equal(cold.owner, OWNER.NONE);
  assert.equal(cold.sendAllowed, false);
  const human = deriveAutomationOwnership(v1Lead({ stage: 'Contacted', emailStatus: 'replied', emailStep: '1' }),
    { boardLead: { stage: 'meeting_booked', meetingAt: '2026-10-28T17:00:00.000Z' }, sendingEnabled: true });
  assert.equal(human.sendAllowed, false);
  assert.notEqual(human.source, 'retired_offer', 'a person or meeting still owns it; completion does not overwrite that');
});

test('completion writes nothing to the lead: stage, outcome, notes and history stay as they were', () => {
  const lead = Object.freeze(v1Lead({ stage: 'Done', emailStatus: 'done', emailStep: '3',
    lastEmailedAt: '2026-10-10T16:00:00.000Z', notes: '[REPLY: Interested] asked about pricing' }));
  const before = JSON.stringify(lead);
  assert.ok(retiredOfferBlock(lead));
  assert.equal(JSON.stringify(lead), before);
  assert.equal(isArchivedLead(lead), false, 'completed leads are not archived');
  assert.equal(retiredOfferFor(lead), null, 'the staffing offer itself is not retired');
});

test('Staffing Outreach Campaign 2 is untouched, routed or not', () => {
  const unrouted = campaign2Lead();
  const routedV1Copy = campaign2Lead({ emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id });
  for (const lead of [unrouted, routedV1Copy, followUpDue(routedV1Copy)]) {
    assert.equal(completedCampaignFor(lead), null);
    assert.equal(outreachBlockForLead(lead), null);
    assert.equal(isActiveOutreachLead(lead), true);
  }
});

test('Industrial Staffing Agency V2 and every other tenant are untouched', () => {
  const v2 = v1Lead({ campaign: STAFFING_CAMPAIGN_V2.name, emailTemplateId: STAFFING_CAMPAIGN_V2.emailTemplateId,
    intendedCampaignVersion: STAFFING_CAMPAIGN_V2.id });
  assert.equal(completedCampaignFor(v2), null);
  const jole = { id: 'j-1', campaign: 'jole-btx-employer-acquisition', clientId: 'jole', leadNiche: 'jole_industrial_employer',
    emailTemplateId: 'jole-btx-employer-v1', stage: 'Queued', notes: '' };
  assert.equal(completedCampaignFor(jole), null);
  assert.equal(outreachBlockForLead(jole), null);
  assert.equal(completedCampaignFor({ ...v1Lead(), clientId: 'jole' }), null, 'the label is ScaleLab\'s; another tenant is not matched');
  assert.equal(completedCampaignFor({ id: 'x', campaign: '', clientId: 'scalelab' }), null);
});

test('history stays in historical analytics and leaves only the active scope', () => {
  const done = v1Lead({ stage: 'Done', emailStatus: 'done', emailStep: '3' });
  const other = campaign2Lead();
  assert.equal(isActiveOutreachLead(done), false);
  assert.deepEqual(scopeLeads([done, other]).map(lead => lead.id), [other.id]);
  assert.deepEqual(scopeLeads([done, other], 'historical').map(lead => lead.id), [done.id, other.id]);
});

test('completion is not a bulk archive: the offer-retirement migration cannot target it', () => {
  assert.equal(retiredOfferById(STAFFING_CAMPAIGN.id), null);
  assert.equal(retiredOfferById('staffing'), null);
});

test('the dashboard lists completed campaigns apart from active ones, and their mapping is read-only', () => {
  const server = readSource('server.js');
  assert.match(server, /res\.json\(\{ active: ACTIVE_CAMPAIGN_VERSION, versions: CAMPAIGN_VERSIONS, completedCampaigns: completedCampaigns\(\) \}\);/);
  assert.match(server, /const completed = completedCampaignByLabel\(internalCampaignId\);\n  if \(completed\) return res\.status\(409\)/);
  const html = readSource('public/index.html');
  assert.match(html, /if \(completed\) \{ completedRows\.push\(\{ \.\.\.row, completed \}\); return false; \}/,
    'a completed campaign never reaches the active table or cards');
  assert.match(html, /<h3>Completed campaigns<\/h3>/);
  assert.match(html, /<\/table>` \+ completedHtml \+ archivedHtml;/);
});

test('completion lives in source, so no worker or data write can reactivate it', () => {
  const src = readSource('integrations/lead-archive.js');
  assert.match(src, /const COMPLETED_CAMPAIGNS = Object\.freeze\(\[/);
  for (const file of ['server.js', 'outreach-agent.js']) {
    assert.ok(!/setCompletedCampaignsForTests/.test(readSource(file)), `${file} must never override completion`);
  }
  setCompletedCampaignsForTests([]);
  assert.equal(outreachBlockForLead(v1Lead()), null);
  setCompletedCampaignsForTests(null);
  assert.equal(outreachBlockForLead(v1Lead()).code, 'campaign_completed');
});
