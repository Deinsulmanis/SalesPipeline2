'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const shared = require('../public/workspace-shared');
const { publicClient, getClient } = require('../integrations/clients/registry');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const scalelabLead = (id, extra = {}) => ({
  id, clientId: 'scalelab', company: `Scale ${id}`, email: `${id}@scalelab.example.com`,
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-01T12:00:00Z',
  campaign: 'Industrial Staffing Agency', senderInboxId: 'primary', bounced: false, manualHold: false,
  ...extra,
});
const joleLead = (id, extra = {}) => ({
  id, clientId: 'jole', company: `Employer ${id}`, email: `${id}@employer.example.com`,
  stage: 'Import', emailStatus: '', emailStep: '', lastEmailedAt: '',
  campaign: 'jole-btx-employer-acquisition', senderInboxId: '', bounced: false, manualHold: false,
  ...extra,
});

test('status counts: ScaleLab rows do not count as Jole rows', () => {
  const scalelab = [scalelabLead('s1'), scalelabLead('s2', { stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '' })];
  const jole = [joleLead('j1'), joleLead('j2', { stage: 'Queued' }), joleLead('j3', { stage: 'Review', manualHold: true })];
  const sl = shared.leadStatusCounts(scalelab);
  const jo = shared.leadStatusCounts(jole);
  assert.equal(sl.all, 2);
  assert.equal(sl.Contacted, 1);
  assert.equal(sl.Queued, 1);
  assert.equal(sl.Import, 0);
  assert.equal(jo.all, 3);
  assert.equal(jo.Import, 1);
  assert.equal(jo.Queued, 1);
  assert.equal(jo.Review, 1);
  assert.equal(JSON.stringify(scalelab).includes('employer.example.com'), false);
  assert.equal(JSON.stringify(jole).includes('scalelab.example.com'), false);
});

test('status filters: Import, Queued, Contacted, Replied, Review/Held match canonical fields', () => {
  const imported = joleLead('a');
  const queued = joleLead('b', { stage: 'Queued' });
  const contacted = scalelabLead('c');
  const replied = scalelabLead('d', { stage: 'Replied', replyCategory: 'positive' });
  const held = joleLead('e', { stage: 'Import', manualHold: true });
  const unsub = scalelabLead('f', { stage: 'Unsub' });
  const bounced = scalelabLead('g', { bounced: true });
  const done = scalelabLead('h', { stage: 'Done' });
  assert.equal(shared.matchesStatusFilter(imported, 'Import'), true);
  assert.equal(shared.matchesStatusFilter(queued, 'Queued'), true);
  assert.equal(shared.matchesStatusFilter(contacted, 'Contacted'), true);
  assert.equal(shared.matchesStatusFilter(replied, 'Replied'), true);
  assert.equal(shared.matchesStatusFilter(held, 'Review'), true);
  assert.equal(shared.matchesStatusFilter(unsub, 'Unsubscribed'), true);
  assert.equal(shared.matchesStatusFilter(bounced, 'Bounced'), true);
  assert.equal(shared.matchesStatusFilter(done, 'Done'), true);
  assert.equal(shared.matchesStatusFilter(imported, 'Queued'), false);
  assert.equal(shared.matchesStatusFilter(queued, 'Import'), false);
});

test('campaign counts stay client-scoped when each list is counted separately', () => {
  const scalelab = [scalelabLead('s1'), scalelabLead('s2', { campaign: 'Industrial Staffing Agency', stage: 'Import', emailStatus: '', lastEmailedAt: '' })];
  const jole = [joleLead('j1'), joleLead('j2', { stage: 'Contacted', emailStatus: 'emailed', lastEmailedAt: '2026-10-07T12:00:00Z' })];
  assert.equal(scalelab.filter(lead => lead.campaign === 'Industrial Staffing Agency').length, 2);
  assert.equal(jole.filter(lead => lead.campaign === 'jole-btx-employer-acquisition').length, 2);
  assert.equal(jole.filter(lead => lead.campaign === 'Industrial Staffing Agency').length, 0);
});

test('revenue panel is only for a ledger-billed managed client', () => {
  const scalelab = publicClient(getClient('scalelab'));
  const jole = publicClient(getClient('jole'));
  assert.equal(shared.shouldShowRevenuePanel(scalelab), false);
  assert.equal(shared.shouldShowRevenuePanel(jole), true);
  assert.equal(shared.shouldShowRevenuePanel({ isDefault: true, billing: { model: 'per_qualified_held_meeting' } }), false);
});

test('revenue: empty meetings stay at zero and do not invent a fee when config has none', () => {
  const empty = shared.revenueFromMeetings([], { model: 'per_qualified_held_meeting' }, { billing: { model: 'per_qualified_held_meeting' } });
  assert.equal(empty.totalMeetings, 0);
  assert.equal(empty.qualifiedMeetings, 0);
  assert.equal(empty.missingFee, true);
  const configured = shared.revenueFromMeetings([], {}, publicClient(getClient('jole')));
  assert.equal(configured.feeConfigured, true);
  assert.equal(configured.feePerMeetingCents, 35000);
  assert.equal(configured.earnedCents, 0);
});

test('revenue: populated qualified meeting uses config fee and invoice status', () => {
  const meetings = [
    { meeting_status: 'QUALIFIED_HELD', qualification_status: 'qualified', billable: true, performance_fee_cents: 35000, invoice_status: 'pending', campaign_id: 'jole-btx-employer-acquisition', scheduled_for: '2026-10-08T15:00:00Z' },
    { meeting_status: 'BOOKED', billable: false, invoice_status: 'not_billable', campaign_id: 'jole-btx-employer-acquisition', scheduled_for: '2026-10-20T15:00:00Z' },
  ];
  const rev = shared.revenueFromMeetings(meetings, { configuredFeeCents: 35000, currency: 'USD', accruedCents: 35000, invoicedCents: 0 }, publicClient(getClient('jole')));
  assert.equal(rev.totalMeetings, 2);
  assert.equal(rev.qualifiedMeetings, 1);
  assert.equal(rev.earnedCents, 35000);
  assert.equal(rev.invoicedCents, 0);
  assert.equal(rev.meetingsByCampaign['jole-btx-employer-acquisition'], 2);
});

test('archived campaigns are partitioned away from active ones', () => {
  const parts = shared.partitionCampaigns(
    [{ id: 'jole-btx-employer-acquisition', label: 'Live' }],
    [{ id: 'jole-dc-mission-critical-v1', label: 'Old', archivedAt: '2026-10-08' }],
  );
  assert.deepEqual(parts.active.map(item => item.id), ['jole-btx-employer-acquisition']);
  assert.equal(parts.archived.length, 1);
});

test('campaign display names come from the client catalog; the stored id never changes', () => {
  const { campaignsForClient, campaignSendable } = require('../integrations/clients/campaigns');
  // The exact shape GET /api/clients/:id returns.
  const catalog = {
    campaigns: campaignsForClient('jole').map(campaign => ({ ...campaign, sendable: campaignSendable(campaign) })),
    archivedCampaigns: campaignsForClient('jole', { includeArchived: true }).filter(campaign => campaign.archivedAt)
      .map(campaign => ({ id: campaign.id, label: campaign.label, archivedAt: campaign.archivedAt })),
  };
  const NAME = 'Jole BTX — Manufacturing & Heavy Industry Employers';
  assert.deepEqual(catalog.campaigns.map(campaign => [campaign.id, campaign.label]), [['jole-btx-employer-acquisition', NAME]]);
  assert.deepEqual(catalog.archivedCampaigns.map(campaign => campaign.id).sort(), ['JOLE_DC_MISSION_CRITICAL', 'JOLE_GULF_INDUSTRIAL', 'JOLE_SHIPYARD']);

  assert.equal(shared.campaignDisplayName('jole-btx-employer-acquisition', catalog), NAME);
  assert.equal(shared.campaignDisplayName('JOLE-BTX-EMPLOYER-ACQUISITION', catalog), NAME);
  assert.equal(shared.campaignDisplayName('jole_industrial_employer_acquisition_v1', catalog), NAME, 'by campaign version');
  assert.equal(shared.isArchivedCampaign('jole-btx-employer-acquisition', catalog), false);
  for (const id of ['JOLE_DC_MISSION_CRITICAL', 'JOLE_GULF_INDUSTRIAL', 'JOLE_SHIPYARD']) {
    assert.equal(shared.isArchivedCampaign(id, catalog), true, id);
  }
  // ScaleLab has no catalog: its campaign names pass through untouched.
  assert.equal(shared.campaignDisplayName('Industrial Staffing Agency', null), 'Industrial Staffing Agency');
  assert.equal(shared.campaignDisplayName('Industrial Staffing Agency', catalog), 'Industrial Staffing Agency');
  assert.equal(shared.isArchivedCampaign('Industrial Staffing Agency', null), false);
  // Display only: the lead keeps its internal campaign id.
  const lead = joleLead('j1');
  shared.campaignDisplayName(lead.campaign, catalog);
  assert.equal(lead.campaign, 'jole-btx-employer-acquisition');
});

test('dashboard HTML: Jole surfaces print the display name, filters keep the raw id', () => {
  assert.match(HTML, /campaign-card-name">\$\{esc\(campaignName\(r\.name\)\)\}/);
  assert.match(HTML, /data-campaign="\$\{escAttr\(r\.name\)\}"/, 'filtering still sends the stored id');
  assert.match(HTML, /name\.textContent = campaignName\(ceCampaignFilter\)/);
  assert.match(HTML, /isArchivedCampaign\(row\.name, catalog\)/);
  assert.equal(HTML.includes('Manufacturing & Heavy Industry'), false, 'the name lives in the catalog only');
});

test('import visibility distinguishes never-sent Import from queued', () => {
  const imported = shared.importVisibility(joleLead('j1'), { personalization: { status: 'needs_review', reason: 'review' }, routingReady: false });
  assert.equal(imported.sent, false);
  assert.equal(imported.sender, 'unassigned');
  assert.ok(imported.blockers.includes('no sender'));
  const queued = shared.queuedVisibility(joleLead('j2', { stage: 'Queued', senderInboxId: 'jole_a', senderEmail: 'outreach@jole.example.com' }), {});
  assert.equal(queued.sender, 'outreach@jole.example.com');
  assert.equal(shared.everSent(joleLead('j1')), false);
  assert.equal(shared.everSent(scalelabLead('s1')), true);
});

test('dashboard HTML: shared status cards, client-scoped directory, revenue gated on billing model', () => {
  assert.match(HTML, /id="lead-status-summary"/);
  assert.match(HTML, /function setLeadStatusFilter\(/);
  assert.match(HTML, /function renderRevenuePanel\(/);
  assert.match(HTML, /shouldShowRevenuePanel\(client\)/);
  assert.match(HTML, /ce-extra-col/);
  assert.match(HTML, /lead-status-callout/);
  assert.match(HTML, /src="\/workspace-shared\.js"/);
  assert.match(HTML, /params\.set\('client', activeClientId\)/);
  assert.equal(HTML.includes("=== 'jole'") || HTML.includes('clientId === "jole"'), false);
  assert.match(HTML, /Archived \/ inactive/);
});

test('dashboard HTML: empty and populated Import copy is dynamic, not hard-coded to 689', () => {
  assert.equal(HTML.includes('689'), false);
  assert.match(HTML, /No \$\{clientTerms\(\)\.leads\} yet/);
  assert.match(HTML, /imported \$\{esc\(terms\.leads\)\}/);
});
