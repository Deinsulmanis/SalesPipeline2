'use strict';

// ScaleLab UI data audit, 2026-11-24: each surface shows what the stores say.
// 1 digest scope and freshness · 2 current campaign · 4 held inboxes ·
// 5 client cap in Settings · 6 bounced leads read as stopped · 7 Client Ops
// bounces and per-lead rates · 3 replies without a Pipeline card.

process.env.STAFFING_LAUNCH_ACTIVATED_AT = process.env.STAFFING_LAUNCH_ACTIVATED_AT || '2026-09-16T07:03:44.000Z';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCanonicalDigest } = require('../integrations/canonical-sends');
const { buildSenderAnalytics, currentLiveCampaignVersion, liveCampaignVersions } = require('../integrations/analytics-scope');
const { CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { buildClientOverview } = require('../integrations/clients/reporting');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

const send = (id, at, n = 1) => ({
  eventId: `gmail:gm-${id}-${n}`, leadId: `CE-${id}`, sourceLeadId: id, email: `${id}@test.ca`,
  eventType: 'initial_email_sent', occurredAt: at,
  metadata: JSON.stringify({ gmailMessageId: `gm-${id}-${n}`, provider: 'gmail', senderInboxId: 'primary' }),
});

// ── 1. Daily digest ────────────────────────────────────────────────────────

test('digest sends count only the scoped leads, not another client\'s', () => {
  const activities = [send('mine', '2026-11-23T15:01:00.000Z'), send('jole1', '2026-11-23T15:02:00.000Z'), send('jole2', '2026-11-23T15:03:00.000Z')];
  const scoped = buildCanonicalDigest({ day: '2026-11-23', activities, activeLeadIds: new Set(['mine']) });
  assert.equal(scoped.emailsSent, 1);
  assert.equal(scoped.sendClasses.confirmed, 1);
  const unscoped = buildCanonicalDigest({ day: '2026-11-23', activities });
  assert.equal(unscoped.emailsSent, 3, 'without a scope every send still counts');
});

test('the digest is ScaleLab-only, today is live, and a partial stored day is recomputed', () => {
  const compute = slice(server, 'async function computeDigest', 'async function getOrCreateDigest');
  assert.match(compute, /leadsForClient\(allLeads, DIGEST_CLIENT_ID\)/);
  assert.match(server, /const DIGEST_CLIENT_ID = 'scalelab';/);
  assert.match(compute, /activeLeadIds\.has\(String\(r\[1\] \|\| ''\)\.trim\(\)\)/, 'pending drafts are counted on active leads only');
  const getter = server.slice(server.indexOf('async function getOrCreateDigest'), server.indexOf('// ── ', server.indexOf('async function getOrCreateDigest')));
  assert.match(getter, /day === vanDay\(\) && !store/, 'today is computed live unless the cron stores it');
  assert.match(getter, /digestRowIsFinal\(day, rows\[idx\]\[1\]\)/, 'a stored row is reused only when final');
  assert.match(server, /getOrCreateDigest\(vanDay\(\), \{ store: true \}\)/, 'the 18:00 cron still stores the day');
  assert.match(server, /function digestRowIsFinal\(day, generatedAt\)[\s\S]{0,200}vanDay\(at\) > day/);
});

// ── 2. Current campaign ────────────────────────────────────────────────────

test('Current campaign is the most recently activated live campaign (Campaign 3)', () => {
  assert.equal(CAMPAIGN_VERSIONS.industrial_staffing_campaign_3.status, 'active');
  assert.equal(CAMPAIGN_VERSIONS.industrial_staffing_campaign_3.activatedAt, '2026-11-20T15:00:00.000Z');
  assert.ok(liveCampaignVersions().includes('industrial_staffing_campaign_3'));
  assert.equal(currentLiveCampaignVersion(), 'industrial_staffing_campaign_3');
});

test('the dashboard names the current campaign by label and keeps send routing unchanged', () => {
  assert.match(server, /current: \{ industrial_staffing: currentLiveCampaignVersion\(\) \}/);
  assert.match(server, /res\.json\(\{ active: ACTIVE_CAMPAIGN_VERSION,/, 'the routing default is still served as-is');
  assert.match(html, /const liveId = registry\.current\?\.industrial_staffing \|\| '';/);
  assert.match(html, /registry\.versions\?\.\[liveId\]\?\.label \|\| liveId/);
  assert.doesNotMatch(html, /registry\.active\?\.industrial_staffing/);
});

// ── 4. Held inboxes ────────────────────────────────────────────────────────

test('a held inbox reads archived in sender analytics and adds no capacity', () => {
  const senders = [
    { id: 'primary', email: 'p@x.ca', status: 'active', dailyLimit: 50 },
    { id: 'old', email: 'o@x.ca', status: 'active', dailyLimit: 15 },
    { id: 'paused', email: 'q@x.ca', status: 'paused', dailyLimit: 30 },
  ];
  const result = buildSenderAnalytics({ senders, holds: new Map([['old', 'mailbox_archived_access_not_configured']]) });
  const old = result.senders.find(row => row.id === 'old');
  assert.equal(old.status, 'archived');
  assert.equal(old.coldHold, 'mailbox_archived_access_not_configured');
  assert.equal(old.remainingToday, 0);
  assert.equal(result.senders.find(row => row.id === 'paused').remainingToday, 0);
  assert.equal(result.totals.dailyLimit, 50, 'only the active, unheld inbox counts toward capacity');
});

test('inbox status marks a cold-held inbox as not sending', () => {
  const status = slice(server, 'async function gmailInboxStatus', 'app.get(\'/api/integrations/gmail-inboxes\'');
  assert.match(status, /const holds = coldSenderHolds\(\);/);
  assert.match(status, /sendEligible: false, sendingActive: false, coldHold: holdReason/);
  assert.match(status, /const remaining = holdReason \? 0 :/);
  assert.match(status, /canPause: inbox\.status === 'active' && !holdReason/);
  assert.match(html, /inbox\.coldHold \? `\$\{esc\(inbox\.coldHoldLabel \|\| 'Held'\)\}/);
});

// ── 5. Settings cap ────────────────────────────────────────────────────────

test('Settings shows the workspace client\'s daily cap, not the platform total', () => {
  const settings = slice(html, 'async function loadSettingsWorkspace', 'function simplifyScaleLabSettings');
  assert.match(settings, /const clientDailyCap = inboxData\?\.capacity\?\.globalDailyLimit \?\? data\.sending\.dailyLimit;/);
  assert.match(settings, /daily cap \$\{clientDailyCap/);
});

// ── 6. Bounced leads ───────────────────────────────────────────────────────

test('a bounced lead is shown as stopped, never as a live sequence', () => {
  assert.match(server, /const bouncedStop = row\.bounced && automation\.state === 'active';/);
  assert.match(server, /email bounced — address suppressed, no further sends/);
});

// ── 7. Client Ops ──────────────────────────────────────────────────────────

test('Client Ops counts canonical bounces, delivered leads and held inboxes', () => {
  const leads = [{ id: 'a', email: 'a@test.ca' }, { id: 'b', email: 'b@test.ca' }];
  const bounce = (n, at) => ({ eventId: `b${n}`, leadId: 'CE-a', sourceLeadId: 'a', email: 'a@test.ca', eventType: 'email_bounced',
    occurredAt: at, metadata: JSON.stringify({ gmailMessageId: 'gm-a-1' }) });
  const activities = [send('a', '2026-11-20T15:00:00.000Z'), send('b', '2026-11-20T15:01:00.000Z'),
    bounce(1, '2026-11-20T15:10:00.000Z'), bounce(2, '2026-11-20T15:11:00.000Z')];
  const senders = [
    { id: 'primary', email: 'deins@scalelabai.ca', clientId: 'scalelab', status: 'active', sendEligible: true, dailyLimit: 50, credentialConfigured: true },
    { id: 'old', email: 'old@scalelabai.ca', clientId: 'scalelab', status: 'active', sendEligible: true, dailyLimit: 15, credentialConfigured: true },
  ];
  const overview = buildClientOverview({ clientId: 'scalelab', leads, activities, senders,
    env: { COLD_SENDER_HOLDS: 'old:mailbox_archived_access_not_configured' }, routedLeadReady: () => true });
  assert.equal(overview.deliverability.sends, 2);
  assert.equal(overview.deliverability.bounced, 1, 'two notices for one message are one bounce');
  assert.equal(overview.deliverability.deliveredLeads, 1);
  const old = overview.deliverability.senders.find(row => row.id === 'old');
  assert.equal(old.status, 'archived');
  assert.equal(old.sendEligible, false);
  assert.equal(overview.deliverability.senders.find(row => row.id === 'primary').sendEligible, true);
});

test('Client Ops rates divide by delivered leads, like the Outreach analytics', () => {
  assert.match(html, /reply rate \$\{esc\(pct\(o\.replies\.total, o\.deliverability\.deliveredLeads \?\? o\.deliverability\.sends\)\)\}/);
  assert.match(html, /pct\(campaign\.replies, campaign\.deliveredLeads \?\? campaign\.sent\)/);
});

// ── 3. Replies without a Pipeline card ─────────────────────────────────────

test('Pipeline shows positive and needs-a-human replies that have no card, mounted inside the workspace', () => {
  assert.match(html, /<div id="pipeline-unboarded" class="pipeline-unboarded"/);
  assert.match(html, /const UNBOARDED_REPLY_CATEGORIES = new Set\(\['positive', 'needs_human'\]\);/);
  assert.match(html, /!record\.pipelinePresence && record\.mappingStatus !== 'conflict'/);
  assert.match(html, /const pipelineUnboarded = document\.querySelector\('body > #pipeline-unboarded'\);/);
  assert.match(html, /if \(pipelineUnboarded\) pipeline\.appendChild\(pipelineUnboarded\);/);
  const strip = slice(html, 'async function refreshUnboardedReplies', 'async function loadLeads');
  assert.doesNotMatch(strip, /method: 'POST'/, 'the strip itself never moves a lead');
  assert.match(strip, /openManualPromotion\(leadId\)/);
});
