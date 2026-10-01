'use strict';

// Analytics after the retirement of dental, roofing and med spa (2026-09-30).
// Every operational number describes the ACTIVE scope — leads that are not
// archived and whose offer is not retired — and only views that say
// "historical" include retired offers. Shapes mirror production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ANALYTICS_SCOPE, parseAnalyticsScope, isActiveOutreachLead, scopeLeads, activitiesForLeads,
  liveCampaignVersions, currentLiveCampaignVersion, safePercent, vancouverDay, buildSenderAnalytics,
} = require('../integrations/analytics-scope');
const { buildReplyMetrics, buildReplyEvidenceMap } = require('../integrations/reply-analytics');
const { buildFunnelAnalytics } = require('../integrations/funnel-analytics');
const { buildConfirmedSendActivity, buildCanonicalDigest, deliveredLeadIds } = require('../integrations/canonical-sends');
const { parseFunnelFilters, buildStaffingFunnel } = require('../integrations/landing-dashboard');
const { addArchiveMarker, retiredOfferFor, isProtectedRecord, ARCHIVE_REASON_LABELS } = require('../integrations/lead-archive');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const serverSrc = readSource('server.js');
const browserSrc = readSource(path.join('public', 'index.html'));
const STAFFING_VERSION = STAFFING_CAMPAIGN.id;

// ── fixtures ────────────────────────────────────────────────────────────────
const staffing = (id, extra = {}) => ({
  id, email: `${id}@staffing.test`, company: `Staffing ${id}`, stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
  lastEmailedAt: '2026-09-28T16:00:00.000Z', notes: '', leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name,
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_VERSION, senderInboxId: 'primary',
  tradeType: 'B (skilled trades / construction labor)', ...extra,
});
const archivedAs = (lead, reason) => ({ ...lead, stage: 'Archived', notes: addArchiveMarker(lead.notes, reason) });
const dental = id => archivedAs({ id, email: `${id}@dental.test`, company: 'Smile Dental', stage: 'Done', emailStatus: 'done', emailStep: '3',
  tradeType: 'Dentist', campaign: 'Surrey Dentists', leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '', notes: '', senderInboxId: 'primary' }, 'offer_retired_dental');
const roofing = id => archivedAs({ id, email: `${id}@roof.test`, company: 'Victoria Roof', stage: 'Import', emailStatus: '', emailStep: '',
  tradeType: 'Roofing contractor', campaign: 'BC Roofing Survey', leadNiche: 'roofing', emailTemplateId: '', intendedCampaignVersion: '', notes: '' }, 'offer_retired_roofing');
const medSpa = id => archivedAs({ id, email: `${id}@spa.test`, company: 'Glow Spa', stage: 'Done', emailStatus: 'done', emailStep: '3',
  tradeType: 'Medical spa', campaign: 'toronto-medspa-jul', leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '', notes: '', senderInboxId: 'primary' }, 'offer_retired_med_spa');

let seq = 0;
const send = (leadId, type, at, sender = 'primary', extra = {}) => {
  seq += 1;
  return { eventId: `gmail:m${seq}`, sourceLeadId: leadId, leadId: `CE-${leadId}`, eventType: type, occurredAt: at,
    metadata: JSON.stringify({ gmailMessageId: `m${seq}`, gmailThreadId: `t-${leadId}`, senderInboxId: sender,
      campaignVersion: extra.campaignVersion || STAFFING_VERSION, campaignFamily: extra.campaignFamily || 'industrial_staffing', ...extra.meta }) };
};
// Replies carry the prospect's own words: classification reads the text.
const REPLY_TEXT = {
  needs_human_reply: 'Can you tell me how the pricing works for a 30-day pilot? We place welders mostly.',
  positive_reply: 'Yes, I am interested. Can we set up a call next week?',
  negative_reply: 'Not interested, thanks.',
  unsubscribe_reply: 'Please unsubscribe me from this list.',
};
// The production event shape (crm_events, 2026-09-30): provider-backed, with
// the canonical state the observer stamped.
const CANONICAL_STATE = { needs_human_reply: 'needs_human', positive_reply: 'positive', negative_reply: 'negative', unsubscribe_reply: 'negative' };
const reply = (leadId, type, at, sender = 'primary') => ({ eventId: `gmail-reply:r-${leadId}-${at}`, sourceLeadId: leadId, leadId: `CE-${leadId}`,
  eventType: type, occurredAt: at, content: REPLY_TEXT[type] || '',
  metadata: JSON.stringify({ gmailMessageId: `r-${leadId}-${at}`, gmailThreadId: `t-${leadId}`, senderInboxId: sender, provider: 'gmail',
    canonicalState: CANONICAL_STATE[type], genuineHuman: true, receivedAt: at, matchedColdEmailId: leadId }) });

function world() {
  const leads = [
    staffing('s1'), staffing('s2', { senderInboxId: 'scalelabaiteam' }), staffing('s3'),
    staffing('s4', { stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '' }),
    dental('d1'), dental('d2'), roofing('r1'), medSpa('m1'),
  ];
  const activities = [
    send('s1', 'initial_email_sent', '2026-09-28T16:00:00.000Z'), send('s1', 'follow_up_sent', '2026-10-01T16:00:00.000Z'),
    send('s2', 'initial_email_sent', '2026-09-28T16:05:00.000Z', 'scalelabaiteam'),
    send('s2', 'follow_up_sent', '2026-10-01T16:05:00.000Z', 'scalelabaiteam'),
    send('s3', 'initial_email_sent', '2026-09-29T16:00:00.000Z'),
    reply('s1', 'needs_human_reply', '2026-09-29T18:00:00.000Z'),
    { eventId: 'bounce-s3', sourceLeadId: 's3', leadId: 'CE-s3', eventType: 'email_bounced', occurredAt: '2026-09-29T16:10:00.000Z',
      metadata: JSON.stringify({ senderInboxId: 'primary' }) },
    // Not campaign sends: a manual reply, an unconfirmed row, warmup-like provider noise.
    { eventId: 'gmail-outbound:h1', sourceLeadId: 's1', leadId: 'CE-s1', eventType: 'human_response_sent', occurredAt: '2026-09-29T19:00:00.000Z',
      metadata: JSON.stringify({ gmailMessageId: 'h1', senderInboxId: 'primary' }) },
    { eventId: 'unconfirmed-1', sourceLeadId: 's3', leadId: 'CE-s3', eventType: 'follow_up_sent', occurredAt: '2026-10-01T17:00:00.000Z',
      metadata: JSON.stringify({ senderInboxId: 'primary' }) },
    { eventId: 'smartlead:warm-1', sourceLeadId: '', leadId: '', eventType: 'smartlead_warmup_sent', occurredAt: '2026-10-01T17:00:00.000Z',
      metadata: JSON.stringify({ provider: 'smartlead' }) },
    // Retired history.
    send('d1', 'initial_email_sent', '2026-09-10T16:00:00.000Z', 'primary', { campaignVersion: 'dental_v3_pay_per_booking', campaignFamily: 'dental_ai_receptionist' }),
    send('d1', 'follow_up_sent', '2026-09-30T16:00:00.000Z', 'primary', { campaignVersion: 'dental_v3_pay_per_booking', campaignFamily: 'dental_ai_receptionist' }),
    send('d2', 'initial_email_sent', '2026-09-11T16:00:00.000Z', 'tryscalelabai', { campaignVersion: 'dental_v3_pay_per_booking', campaignFamily: 'dental_ai_receptionist' }),
    reply('d1', 'positive_reply', '2026-09-12T18:00:00.000Z'), reply('d2', 'negative_reply', '2026-09-12T18:00:00.000Z', 'tryscalelabai'),
    send('m1', 'initial_email_sent', '2026-07-20T16:00:00.000Z'), reply('m1', 'unsubscribe_reply', '2026-10-01T18:00:00.000Z'),
    { eventId: 'cb-d1', sourceLeadId: 'd1', leadId: 'CE-d1', eventType: 'call_booked', occurredAt: '2026-10-01T19:00:00.000Z', metadata: '{}' },
  ];
  return { leads, activities };
}
const byLead = (activities, leads) => {
  const map = new Map();
  for (const lead of leads) map.set(lead.id, activities.filter(row => row.sourceLeadId === lead.id));
  return map;
};
// Exactly the inputs the server's dataset build hands buildReplyMetrics.
const metricsFor = (leads, activities) => buildReplyMetrics(leads, {
  activitiesByLeadId: byLead(activities, leads), evidenceByLeadId: buildReplyEvidenceMap(activities),
});

// ── 1–5: active vs historical ──────────────────────────────────────────────

test('1. the active lead count contains staffing only', () => {
  const { leads } = world();
  const active = scopeLeads(leads, ANALYTICS_SCOPE.ACTIVE);
  assert.deepEqual(active.map(lead => lead.id), ['s1', 's2', 's3', 's4']);
  assert.ok(active.every(lead => lead.leadNiche === 'industrial_staffing'));
  assert.equal(parseAnalyticsScope(undefined), 'active', 'active is the default');
  assert.equal(parseAnalyticsScope('HISTORICAL'), 'historical');
});

for (const [n, label, make] of [[2, 'dental', dental], [3, 'roofing', roofing], [4, 'med spa', medSpa]]) {
  test(`${n}. archived ${label} is excluded from active analytics, and so is an un-archived retired ${label} lead`, () => {
    const archived = make(`x-${label}`);
    assert.equal(isActiveOutreachLead(archived), false);
    const unarchived = { ...archived, stage: 'Done', notes: '' };
    assert.equal(isActiveOutreachLead(unarchived), false, 'retirement alone removes it from active analytics');
    assert.ok(retiredOfferFor(unarchived), 'the same retired-offer test the send gates use');
  });
}

test('5. the historical scope intentionally includes retired campaigns, and says so', () => {
  const { leads, activities } = world();
  assert.equal(scopeLeads(leads, ANALYTICS_SCOPE.HISTORICAL).length, leads.length);
  const historical = metricsFor(leads, activities);
  assert.ok(historical.positive >= 1, 'dental positive reply is historical performance');
  const history = buildConfirmedSendActivity(activities);
  assert.ok(history.some(day => day.date === '2026-09-10'), 'dental send days remain in the historical series');
  assert.match(serverSrc, /historical: \{\n      scope: ANALYTICS_SCOPE\.HISTORICAL, includesArchived: true,/);
  assert.match(serverSrc, /const scope = parseAnalyticsScope\(req\.query\.scope\);/);
});

// ── 6/7: protected clients ──────────────────────────────────────────────────

test('6/7. Trade Select and SureSky stay Closed/Won Pipeline clients and never count as active roofing outreach', () => {
  const tradeSelect = { id: 'mq4vq4pw2t0w6u6qwmp', company: 'tradeselect', tradeType: 'Roofer', stage: 'closed_won', email: '360estimates@gmail.com' };
  const suresky = { id: 'mq3i7yq86ri0ueadqtl', company: 'suresky.inc', tradeType: 'Roofer', stage: 'closed_won', email: 'xxx@xx' };
  const { leads, activities } = world();
  const active = scopeLeads(leads, ANALYTICS_SCOPE.ACTIVE);
  const funnel = buildFunnelAnalytics({ leads: active, boardLeads: [tradeSelect, suresky], activities, currentVersion: currentLiveCampaignVersion() },
    { version: 'lifetime' });
  assert.equal(funnel.reconciliation.outsideFunnel.byStage.closed_won, 2, 'both remain visible as Closed/Won');
  assert.equal(funnel.counts.won, 0, 'they are not cold-outreach wins');
  for (const card of [tradeSelect, suresky]) {
    assert.equal(isProtectedRecord(card), true);
    assert.equal(retiredOfferFor(card), null, 'not a retired roofing prospect');
    assert.ok(!active.some(lead => lead.id === card.id), 'not an outreach lead at all');
  }
  assert.equal(active.filter(lead => retiredOfferFor(lead)?.offer.id === 'roofing').length, 0, 'active roofing outreach is zero');
});

// ── 8–12: counts, sends, rates, senders ─────────────────────────────────────

test('8. staffing lead counts match the source rows', () => {
  const { leads } = world();
  const source = leads.filter(lead => lead.leadNiche === 'industrial_staffing' && lead.stage !== 'Archived');
  assert.equal(scopeLeads(leads).length, source.length);
});

test('9/10. sends exclude manual replies, unconfirmed rows and warmup; first sends and follow-ups are distinct', () => {
  const { leads, activities } = world();
  const active = scopeLeads(leads);
  const series = buildConfirmedSendActivity(activitiesForLeads(activities, active));
  assert.equal(series.reduce((sum, day) => sum + day.count, 0), 5, '3 first emails + 2 follow-ups; no manual, unconfirmed or warmup');
  const senders = buildSenderAnalytics({ leads, activities, now: new Date('2026-10-01T20:00:00.000Z'),
    senders: [{ id: 'primary', email: 'p@x', dailyLimit: 60 }, { id: 'scalelabaiteam', email: 't@x', dailyLimit: 40, staffingOnly: true }] });
  const primary = senders.senders.find(row => row.id === 'primary');
  assert.equal(primary.firstSends, 2);
  assert.equal(primary.followUps, 1);
  assert.equal(senders.totals.firstSends + senders.totals.followUps, 5);
});

test('11. reply rate divides replying LEADS by delivered LEADS — never by messages', () => {
  const { leads, activities } = world();
  const active = scopeLeads(leads);
  const metrics = metricsFor(active, activities);
  // Delivered leads: s1, s2 (s3 bounced, s4 never sent). Genuine replies: s1.
  assert.equal(metrics.delivered, 2);
  assert.deepEqual([...deliveredLeadIds({ leads: active, activities })].sort(), ['s1', 's2']);
  assert.equal(metrics.confirmedSends, 5, 'messages are still reported, under their own name');
  assert.equal(metrics.genuineReplies, 1);
  assert.equal(metrics.genuineReplyRate, 50);
  assert.equal(metrics.positive, 0, 'dental positives never reach the active cards');
});

test('12. sender statistics total correctly and keep scalelabaiteam staffing-only', () => {
  const { leads, activities } = world();
  const result = buildSenderAnalytics({ leads, activities, now: new Date('2026-10-01T20:00:00.000Z'),
    senders: [{ id: 'primary', dailyLimit: 60 }, { id: 'tryscalelabai', dailyLimit: 60 }, { id: 'scalelabaiteam', dailyLimit: 40, staffingOnly: true }] });
  for (const key of ['firstSends', 'followUps', 'sentToday', 'repliedLeads', 'bouncedLeads', 'queued', 'inSequence']) {
    assert.equal(result.totals[key], result.senders.reduce((sum, row) => sum + row[key], 0), key);
  }
  assert.equal(result.senders.find(row => row.id === 'tryscalelabai').firstSends, 0, 'tryscalelabai sent only dental, which is not active');
  assert.equal(result.senders.find(row => row.id === 'scalelabaiteam').staffingOnly, true);
  assert.equal(result.senders.find(row => row.id === 'primary').bouncedLeads, 1);
  assert.equal(result.senders.find(row => row.id === 'primary').queued, 1);
});

// ── 13–15: funnel, archive, page attribution ────────────────────────────────

test('13. archived records never appear in active funnel stages; Current campaign is the live staffing campaign', () => {
  const { leads, activities } = world();
  assert.deepEqual(liveCampaignVersions(), [STAFFING_VERSION]);
  const active = buildFunnelAnalytics({ leads: scopeLeads(leads), activities, currentVersion: currentLiveCampaignVersion() }, {});
  assert.equal(active.filters.version, STAFFING_VERSION);
  const ids = Object.values(active.stageLeadIds).flat();
  for (const id of ['d1', 'd2', 'r1', 'm1']) assert.ok(!ids.includes(id), `${id} is not in the active funnel`);
  assert.equal(active.counts.sent, 3);
  const lifetimeActive = buildFunnelAnalytics({ leads: scopeLeads(leads), activities, currentVersion: currentLiveCampaignVersion() }, { version: 'lifetime' });
  assert.ok(!Object.values(lifetimeActive.stageLeadIds).flat().some(id => /^[drm]\d$/.test(id)), 'Lifetime in the active scope is staffing lifetime');
  const historical = buildFunnelAnalytics({ leads, activities, currentVersion: currentLiveCampaignVersion() }, { version: 'lifetime' });
  assert.ok(historical.stageLeadIds.sent.includes('d1'), 'the historical scope keeps them');
  assert.match(serverSrc, /currentVersion: currentLiveCampaignVersion\(\),\n    \}, req\.query\);/);
  assert.ok(!/currentVersion: ACTIVE_CAMPAIGN_VERSION\.dental_ai_receptionist/.test(serverSrc), 'no surface defaults to the retired dental campaign');
});

test('14. archive totals come from the archive source of truth, one card per reason', () => {
  const start = serverSrc.indexOf('function archiveFacets(');
  const archiveFacets = new Function(`${serverSrc.slice(start, serverSrc.indexOf('\n}\n', start) + 3)}\nreturn archiveFacets;`)();
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, archiveReason: 'offer_retired_dental', niche: 'dental' })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `r${i}`, archiveReason: 'offer_retired_roofing', niche: 'roofing' })),
    { id: 'm0', archiveReason: 'offer_retired_med_spa', niche: 'med_spa' },
  ];
  const facets = archiveFacets(rows);
  assert.deepEqual(facets.reasons, { offer_retired_dental: 4, offer_retired_roofing: 2, offer_retired_med_spa: 1 });
  assert.equal(Object.values(facets.reasons).reduce((sum, n) => sum + n, 0), rows.length);
  assert.ok(ARCHIVE_REASON_LABELS.offer_retired_roofing && ARCHIVE_REASON_LABELS.offer_retired_med_spa);
  const summary = browserSrc.slice(browserSrc.indexOf('function renderArchiveSummary'), browserSrc.indexOf('function renderArchiveRows'));
  assert.match(summary, /Object\.entries\(facets\.reasons \|\| \{\}\)/, 'cards are built from the Archive facets, not a second definition');
});

test('15. the staffing page excludes retired-campaign bookings and keeps staffing ones', () => {
  const now = new Date('2026-10-01T03:00:00Z');
  const filters = parseFunnelFilters({ range: '30d' }, now);
  const issuance = { issuance_id: 'I1', lead_id: 'S1', source: 'followup_2', campaign_id: STAFFING_VERSION, campaign_version: STAFFING_VERSION,
    template_id: 'x', template_version: 'v', sender_inbox_id: 'primary', is_test: false, status: 'sent', sent_at: '2026-09-25T17:00:00Z' };
  const leads = [
    { lead_id: 'S1', company: 'Acme Staffing', email: 'a@acme.test', stage: 'Contacted', notes: '', lead_niche: 'industrial_staffing',
      email_template_id: STAFFING_CAMPAIGN.emailTemplateId, intended_campaign_version: STAFFING_VERSION, campaign: STAFFING_CAMPAIGN.name, trade_type: 'A' },
    { lead_id: 'S2', company: 'Jole Enterprise', email: 'j@jole.test', stage: 'Review', notes: '', lead_niche: 'industrial_staffing',
      email_template_id: STAFFING_CAMPAIGN.emailTemplateId, intended_campaign_version: STAFFING_VERSION, campaign: STAFFING_CAMPAIGN.name, trade_type: 'A' },
    { lead_id: 'D1', company: 'Silver 7 Dental', email: 'i@s7.test', stage: 'Archived', notes: '[ARCHIVED: offer_retired_dental]', lead_niche: 'dental',
      email_template_id: 'dental-guarantee-v1', intended_campaign_version: 'dental_v3_pay_per_booking', campaign: 'Ontario List', trade_type: 'Dental clinic' },
  ];
  const bookings = [
    { lead_id: 'S1', booked_at: '2026-09-26T18:00:00Z', attributed_issuance_id: 'I1', attributed_source: 'followup_2', assist_label: 'page_assisted' },
    { lead_id: 'S2', booked_at: '2026-09-25T19:20:32Z', attributed_issuance_id: null, attributed_source: null, assist_label: 'no_link_issued' },
    { lead_id: 'D1', booked_at: '2026-09-15T08:32:41Z', attributed_issuance_id: null, attributed_source: null, assist_label: 'no_link_issued' },
  ];
  const result = buildStaffingFunnel({ filters, issuances: [issuance], sessions: [], bookings, leads, now });
  assert.deepEqual(result.bookings.rows.map(row => row.company).sort(), ['Acme Staffing', 'Jole Enterprise']);
  assert.equal(result.bookings.total, 2, 'the dental meeting is not a staffing booking');
});

// ── 16/17: dates and zero denominators ──────────────────────────────────────

test('16. date ranges use the Vancouver business day', () => {
  // 23:30 Pacific on Sep 30 is 06:30Z on Oct 1: it belongs to Sep 30.
  assert.equal(vancouverDay('2026-10-01T06:30:00.000Z'), '2026-09-30');
  assert.equal(vancouverDay('2026-10-01T07:30:00.000Z'), '2026-10-01');
  const late = send('s1', 'initial_email_sent', '2026-10-01T06:30:00.000Z');
  const series = buildConfirmedSendActivity([late]);
  assert.deepEqual(series, [{ date: '2026-09-30', count: 1 }]);
  const senders = buildSenderAnalytics({ leads: [staffing('s1')], activities: [late], senders: [{ id: 'primary', dailyLimit: 60 }],
    now: new Date('2026-10-01T05:00:00.000Z') });
  assert.equal(senders.day, '2026-09-30');
  assert.equal(senders.senders[0].sentToday, 1);
  // The funnel's date-only bounds are Vancouver days, inclusive.
  const { leads, activities } = world();
  const window = buildFunnelAnalytics({ leads: scopeLeads(leads), activities, currentVersion: STAFFING_VERSION }, { from: '2026-09-29', to: '2026-09-29' });
  assert.deepEqual(window.stageLeadIds.sent, ['s3'], 'only the lead first sent on Sep 29 Pacific');
  // The digest: replies of archived leads are reported apart, never as campaign replies.
  const digest = buildCanonicalDigest({ day: '2026-10-01', activities, leads, activeLeadIds: new Set(scopeLeads(leads).map(lead => lead.id)) });
  assert.equal(digest.replies.total, 0);
  assert.equal(digest.replies.archived, 1);
  assert.equal(digest.bookings, 0, 'a booking by an archived dental lead is not an active booking');
  assert.equal(digest.scope, 'active');
});

test('17. a rate with a zero denominator is unknown, never NaN, Infinity or 0%', () => {
  assert.equal(safePercent(1, 0), null);
  assert.equal(safePercent(0, 0), null);
  assert.equal(safePercent(5, -1), null);
  assert.equal(safePercent(1, Number.NaN), null);
  assert.equal(safePercent(1, 4), 25);
  const empty = buildReplyMetrics([staffing('q', { stage: 'Queued', emailStatus: '', emailStep: '' })], { activitiesByLeadId: new Map() });
  assert.equal(empty.genuineReplyRate, null);
  assert.equal(empty.positiveReplyRate, null);
  assert.equal(empty.positiveOfReplies, null);
  const senders = buildSenderAnalytics({ leads: [], activities: [], senders: [{ id: 'deniels', dailyLimit: 20 }] });
  assert.equal(senders.senders[0].genuineReplyRate, null);
  assert.equal(senders.senders[0].bounceRate, null);
  const funnel = buildFunnelAnalytics({ leads: [], activities: [], currentVersion: STAFFING_VERSION }, {});
  for (const value of Object.values(funnel.conversions)) assert.ok(value === null || Number.isFinite(value));
  // The browser renders null as "—".
  assert.match(browserSrc, /const pct = value => \(value === null \|\| value === undefined \? '—'/);
});

test('every operational summary names its scope; retired telemetry panels are labelled historical', () => {
  assert.match(serverSrc, /scope: \{ scope: ANALYTICS_SCOPE\.ACTIVE, activeLeads: active\.length,/);
  assert.equal((serverSrc.match(/\.\.\.analyticsScopeBlocks\(dataset\),/g) || []).length, 2, 'stats and summary');
  assert.equal((browserSrc.match(/<b>Retired offers · historical<\/b>/g) || []).length, 2, 'demo plays and proposal opens');
  assert.match(browserSrc, /<select id="funnel-scope" aria-label="Analytics scope"/);
  assert.match(browserSrc, /scope: document\.getElementById\('funnel-scope'\)\?\.value \|\| 'active'/);
});
