'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { STAFFING_CAMPAIGN, STAFFING_LANDING_PAGE_URL } = require('../integrations/staffing-campaign');
const { offerForLead, warmResponse } = require('../integrations/offer-config');
const { responseActionId } = require('../integrations/prospect-reply-delivery');
const { landingLinkMetadata } = require('../integrations/landing-link-token');
const {
  staffingWarmReplyLandingPlan, staffingColdStepLandingPlan, buildIssuanceRecord, warmReplyTemplate,
} = require('../integrations/landing-link-issuance');

const KEY_1 = crypto.createHash('sha256').update('reply key 1').digest('base64');
const KEY_2 = crypto.createHash('sha256').update('reply key 2').digest('base64');
const ON = { LANDING_LINK_TRACKING_ENABLED: 'true', LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '1' };
const ROTATED = { ...ON, LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1, 2: KEY_2 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '2' };
const lead = {
  id: 'mtwgLead0002', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing', contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, siteContext: 'Your team places welders.',
};
const offer = offerForLead(lead);
const plan = (action, env = ON, activities = [], inbound = 'inbound-1') => staffingWarmReplyLandingPlan({ lead, inboundMessageId: inbound, action, activities, env });

test('only the two automated staffing replies that carry the landing page get a plan', () => {
  for (const action of ['AUTO_STAFFING_QUALIFY_QUESTION', 'AUTO_BOOKING_RESPONSE', 'AUTO_MEETING_RESPONSE', 'AUTO_QUESTION_RESPONSE', 'AUTO_PRICING_RESPONSE']) {
    assert.equal(plan(action), null, action);
  }
  assert.equal(staffingWarmReplyLandingPlan({ lead: { ...lead, campaign: 'Dental', intendedCampaignVersion: '', emailTemplateId: 'dental' }, inboundMessageId: 'i', action: 'AUTO_STAFFING_SEND_INFO', env: ON }), null);
  assert.equal(plan('AUTO_STAFFING_SEND_INFO', {}).tracked, false);
  assert.equal(plan('AUTO_STAFFING_SEND_INFO').tracked, true);
  assert.equal(plan('AUTO_STAFFING_QUALIFIED').tracked, true);
});

test('Follow-up #2 token A and positive-reply token B map to the same lead and stay distinct', () => {
  const followUp = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  const reply = plan('AUTO_STAFFING_QUALIFIED');
  assert.notEqual(followUp.url, reply.url);
  assert.notEqual(followUp.tokenHash, reply.tokenHash);
  const a = buildIssuanceRecord({ plan: followUp, actionId: 'gmail-cold:x:step:2', lead, templateId: 't', templateVersion: 'v', senderInboxId: 'primary', env: {} });
  const b = buildIssuanceRecord({ plan: reply, actionId: responseActionId(lead.id, 'inbound-1', 'AUTO_STAFFING_QUALIFIED'), lead,
    triggerAction: 'AUTO_STAFFING_QUALIFIED', ...warmReplyTemplate('AUTO_STAFFING_QUALIFIED'), senderInboxId: 'primary', env: {} });
  assert.equal(a.lead_id, b.lead_id);
  assert.deepEqual([a.source, b.source], ['followup_2', 'positive_reply']);
  assert.deepEqual([b.trigger_action, b.template_id, b.template_version],
    ['AUTO_STAFFING_QUALIFIED', 'staffing_warm_reply', 'staffing_qualified_reply_v1']);
  assert.equal(warmReplyTemplate('AUTO_STAFFING_SEND_INFO').templateVersion, 'staffing_send_info_reply_v1');
  // Different inbound messages are different issuances too.
  assert.notEqual(plan('AUTO_STAFFING_SEND_INFO', ON, [], 'inbound-1').url, plan('AUTO_STAFFING_SEND_INFO', ON, [], 'inbound-2').url);
});

test('the delivered reply carries the tracked link; the plain reply is unchanged for drafts', () => {
  const tracked = plan('AUTO_STAFFING_SEND_INFO');
  const plain = warmResponse({ action: 'AUTO_STAFFING_SEND_INFO', lead, offer });
  const delivered = warmResponse({ action: 'AUTO_STAFFING_SEND_INFO', lead, offer, landingPageUrl: tracked.url });
  assert.equal(delivered, plain.replace(STAFFING_LANDING_PAGE_URL, tracked.url));
  assert.ok(plain.includes(`\n${STAFFING_LANDING_PAGE_URL}\n`));
});

test('a reply retried after key rotation keeps its first reservation pin', () => {
  const first = plan('AUTO_STAFFING_QUALIFIED');
  const actionId = responseActionId(lead.id, 'inbound-1', 'AUTO_STAFFING_QUALIFIED');
  const reserved = { eventId: `${actionId}:attempt:1`, eventType: 'prospect_reply_reserved', metadata: JSON.stringify({ actionId, landingLink: landingLinkMetadata(first) }) };
  assert.equal(plan('AUTO_STAFFING_QUALIFIED', ROTATED, [reserved]).url, first.url);
  const plainReserved = { ...reserved, metadata: JSON.stringify({ actionId }) };
  assert.equal(plan('AUTO_STAFFING_QUALIFIED', ROTATED, [plainReserved]).tracked, false);
});

// Normalised so the structural checks don't depend on the checkout's line endings.
const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => agent.slice(agent.indexOf(from), agent.indexOf(to, agent.indexOf(from) + from.length));
const handler = slice('async function handlePositiveAutomation', '\nasync function handleTimingReply');
const warm = slice('async function deliverHardenedWarmReply', '\n// Phase 6 reads the same canonical stores');

test('Agent v2 delivery is untouched and human drafts keep the plain URL', () => {
  assert.match(handler, /const landingPlan = agentV2Cutover \? null : staffingWarmReplyLandingPlan\(/);
  assert.match(handler, /\? await deliverAgentV2Qualification\(\{ lead, message, activities, decision,\n\s+outboundObservationOk, subject \}\)\n\s+: await deliverHardenedWarmReply\(\{ lead, message, action: policy\.action, body: deliveryBody,/);
  const drafts = handler.match(/queueDraft\(lead, \{[^}]*\}/g) || [];
  assert.ok(drafts.length >= 3);
  for (const call of drafts) assert.equal(/deliveryBody|landingPlan/.test(call), false, call);
  assert.equal((handler.match(/landingPageUrl: landingPlan\.url/g) || []).length, 1);
});

test('deliverHardenedWarmReply: issuance is the last gate before the reservation; marker after confirmation', () => {
  const order = [
    "landingPlan?.status === LANDING_PLAN_STATUS.BLOCKED",
    'await deliverProspectReply(',
    'finalRevalidate: async () => {',
    "code: 'window_quota'",
    'ensureLandingIssuance({ plan: landingPlan, record: landingRecord })',
    "code: 'landing_link_conflict'",
    'return { allowed: true };',
    'persistReservation: async',
    '...(landingLink ? { landingLink } : {}),',
    'persistDelivered: async',
    'if (recovery) await recordLandingLinkSent(',
    'confirmDurableReservation: async actionId => {',
    'await confirmOutboundReservation(actionId);',
    'if (landingRecord && landingSent) await recordLandingLinkSent(',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = warm.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `${marker} must follow the previous step`);
    cursor = at;
  }
  // Every other caller keeps the default null plan.
  assert.equal((agent.match(/landingPlan \}\);/g) || []).length, 1);
  assert.equal((agent.match(/await deliverHardenedWarmReply\(/g) || []).length >= 3, true);
});
