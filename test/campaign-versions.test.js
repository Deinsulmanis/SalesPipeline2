'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LEGACY_UNKNOWN, CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION,
  campaignVersion, coldSendAttribution, stageSequenceAttribution,
  attributionFromActivity, replyTouchAttribution, acquisitionAttribution,
  promotionAttribution, buildCampaignVersionIndex,
} = require('../integrations/campaign-versions');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const activity = (overrides = {}) => ({
  eventId: 'gmail:m1', leadId: 'CE-l1', sourceLeadId: 'l1', eventType: 'initial_email_sent',
  occurredAt: '2026-08-27T20:40:00Z', metadata: JSON.stringify({
    gmailMessageId: 'm1', gmailThreadId: 't1', campaignVersion: 'dental_v1_measured',
    campaignFamily: 'dental_ai_receptionist', copyVersion: 'dental_risk_reversal_hp_v1',
    subjectStrategy: 'service_curiosity_v1', sequenceId: 'cold_outreach', sequenceStep: 1,
  }), ...overrides,
});

test('active measured campaign is defined and immutable', () => {
  assert.equal(ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist, 'dental_v2_answering_booking');
  assert.equal(Object.isFrozen(CAMPAIGN_VERSIONS), true);
});
test('undefined campaign version is rejected', () => assert.throws(() => campaignVersion('missing'), /Unknown campaign version/));

test('an intended compatible version is honored but queued state alone is not acquisition evidence', () => {
  const selected = coldSendAttribution({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v2_answering_booking' }, 1);
  assert.equal(selected.campaignVersion, 'dental_v2_answering_booking');
  assert.throws(() => coldSendAttribution({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v1_measured' }, 1), /not active/);
  assert.throws(() => coldSendAttribution({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'roofing_survey_v1_measured' }, 1), /incompatible/);
  assert.equal(buildCampaignVersionIndex([{ id: 'queued-only', intendedCampaignVersion: 'dental_v1_measured' }], []).get('queued-only').campaignVersion, LEGACY_UNKNOWN);
});
test('cold initial attribution stamps mandatory fields and personalization', () => {
  const value = coldSendAttribution({ leadNiche: 'dental' }, 1, { personalizationMetadata: { profileVersion: 'hp-v1', personalizationLevel: 2, selectedAngle: 'implants' } });
  assert.equal(value.campaignVersion, 'dental_v2_answering_booking');
  assert.equal(value.sequenceStep, 1); assert.equal(value.copyVersion, 'dental_risk_reversal_hp_v2');
  assert.equal(value.subjectStrategy, 'service_curiosity_v1'); assert.equal(value.personalizationLevel, 2);
  assert.equal(value.personalizationAngle, 'implants'); assert.equal(value.offerVersion, 'three_patients_30d_rr_v1');
});
test('updated dental follow-ups carry a distinct copy version', () => {
  const value = coldSendAttribution({ leadNiche: 'dental' }, 2);
  assert.equal(value.campaignVersion, 'dental_v2_answering_booking');
  assert.equal(value.copyVersion, 'dental_answering_booking_follow_up_v2');
});
test('historical activity without stamped version remains legacy unknown', () => {
  assert.deepEqual(attributionFromActivity(activity({ metadata: '{}' })), { campaignVersion: LEGACY_UNKNOWN });
});
test('reply touch selects latest outbound in the same thread before reply', () => {
  const older = activity();
  const newer = activity({ eventId: 'gmail:m2', occurredAt: '2026-08-27T21:00:00Z', metadata: JSON.stringify({ gmailMessageId: 'm2', gmailThreadId: 't1', campaignVersion: 'dental_v1_measured', sequenceStep: 2 }) });
  assert.equal(replyTouchAttribution({ occurredAt: '2026-08-27T22:00:00Z', threadId: 't1' }, [older, newer]).sourceMessageId, 'm2');
});
test('reply touch never uses another thread or the global active version', () => {
  assert.equal(replyTouchAttribution({ occurredAt: '2026-08-27T22:00:00Z', threadId: 'other' }, [activity()]).campaignVersion, LEGACY_UNKNOWN);
});
test('stage sequence preserves acquisition and stamps its own sequence identity', () => {
  const value = stageSequenceAttribution({ acquisition: attributionFromActivity(activity()), sequenceId: 'no_show_recovery_v1', step: 1 });
  assert.equal(value.campaignVersion, 'dental_v1_measured'); assert.equal(value.sequenceId, 'no_show_recovery_v1');
  assert.equal(value.sequenceVersion, 'v1'); assert.equal(value.copyVersion, 'no_show_recovery_v1');
});
test('promotion metadata is immutable once acquisition is known', () => {
  const existing = { campaignVersion: 'dental_v1_measured', campaignFamily: 'dental_ai_receptionist', sourceSendEventId: 'old' };
  const value = promotionAttribution({ campaignVersion: 'other' }, existing);
  assert.equal(value.acquisitionCampaignVersion, 'dental_v1_measured'); assert.equal(value.acquisitionSourceEventId, 'old');
});
test('acquisition reads the first canonical promotion attribution', () => {
  const rows = [{ eventType: 'pipeline_promoted', occurredAt: '2026-08-27T20:00:00Z', metadata: JSON.stringify({ acquisitionCampaignVersion: 'dental_v1_measured', acquisitionSourceEventId: 'gmail:m1' }) }];
  assert.equal(acquisitionAttribution(rows).sourceSendEventId, 'gmail:m1');
});
test('lightweight campaign index uses activities without external reads', () => {
  assert.equal(buildCampaignVersionIndex([{ id: 'l1' }, { id: 'l2' }], [activity()]).get('l1').campaignVersion, 'dental_v1_measured');
  assert.equal(buildCampaignVersionIndex([{ id: 'l2' }], []).get('l2').campaignVersion, LEGACY_UNKNOWN);
});
test('changing an intended route cannot rewrite historical send attribution', () => {
  const lead = { id: 'l1', intendedCampaignVersion: 'roofing_survey_v1_measured' };
  assert.equal(buildCampaignVersionIndex([lead], [activity()]).get('l1').campaignVersion, 'dental_v1_measured');
});
test('version filtering is server-side and composes with reply filtering', () => {
  assert.match(server, /query\.campaignVersion/); assert.match(server, /row\.campaignVersion !== campaignVersion/);
  assert.match(server, /filterReplyRecords[\s\S]*campaignVersion/);
});
test('Outreach UI sends version filter and displays current campaign', () => {
  assert.match(ui, /id="ce-version-filter"/); assert.match(ui, /params\.set\('campaignVersion'/);
  assert.match(ui, /Current campaign:/);
});
test('summary metrics remain independent of the version filter', () => {
  const stats = server.slice(server.indexOf("app.get('/api/coldemail/stats'"), server.indexOf("app.get('/api/coldemail/summary'"));
  assert.doesNotMatch(stats, /filterOutreachRows|campaignVersion/);
});
test('send attribution is written only in post-provider activity paths', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /const sendResult = await sendEmail[\s\S]*markSent/);
  assert.match(agent, /successful send is missing campaign attribution/);
});
test('registry documents an explicit clean activation boundary', () => {
  assert.equal(CAMPAIGN_VERSIONS.dental_v1_measured.activatedAt, '2026-08-27T20:31:18.220Z');
  assert.match(CAMPAIGN_VERSIONS.dental_v1_measured.meaning, /hyper-personalized/i);
  assert.equal(CAMPAIGN_VERSIONS.dental_v1_measured.status, 'retired');
  assert.equal(CAMPAIGN_VERSIONS.dental_v2_answering_booking.status, 'active');
});
test('active prospect-facing dental sources no longer lead with AI receptionist terminology', () => {
  const files = ['guarantee.js', 'product-facts.js', 'outreach-agent.js',
    path.join('integrations', 'dental-email.js'), path.join('integrations', 'dental-personalization.js')];
  const copy = files.map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  assert.doesNotMatch(copy, /\bAI receptionist\b/i);
  assert.match(copy, /24\/7 answering and booking software for dental practices that handles missed calls and helps turn them into booked patients\./);
});
