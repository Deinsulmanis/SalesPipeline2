'use strict';

// Conversation state recognises the staffing "priority question" for both
// campaigns: V1's Touch 3 by its wording (unchanged), V2's Touch 3 ("Should I
// close the loop here, or is bringing in more employer accounts still
// something {{company}} is looking to grow?") by its send event — a step-3 send
// recorded under V2's campaign version and follow-up copy version. No V2 text
// is matched, so no company name or unrelated message can trigger it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildConversationState } = require('../integrations/conversation-state');
const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2, renderStaffingEmail, staffingV2Live, setStaffingV2LiveForTests,
} = require('../integrations/staffing-campaign');
const { coldSendAttribution, CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');

const NOW = '2026-10-20T18:00:00.000Z';
const at = day => `2026-10-${String(day).padStart(2, '0')}T15:00:00.000Z`;
const V2_TOUCH_3_WORDING = 'Should I close the loop here, or is bringing in more employer accounts still something Harbour Staffing is looking to grow?';

const leadFor = (campaign, extra = {}) => ({
  id: 'S1', email: 'owner@harbour.test', company: 'Harbour Staffing', contactName: 'Alex Harbour',
  campaign: campaign.name, intendedCampaignVersion: campaign.id, emailTemplateId: campaign.emailTemplateId,
  leadNiche: 'industrial_staffing', siteContext: 'Saw you place CDL drivers for manufacturers.',
  stage: 'Replied', emailStatus: 'replied', emailStep: '3', notes: '', senderInboxId: 'primary', ...extra,
});
const v1Lead = leadFor(STAFFING_CAMPAIGN);
const v2Lead = leadFor(STAFFING_CAMPAIGN_V2);

// Production's recorded attribution (recordSendActivity spreads it into the
// send event's metadata). Computed with the real function, V2 modelled live
// only for the computation, then locked again.
function attributionFor(lead, step) {
  const saved = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = '2026-09-01T00:00:00.000Z';
  setStaffingV2LiveForTests(true);
  try { return coldSendAttribution(lead, step); } finally {
    setStaffingV2LiveForTests(null);
    if (saved === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = saved;
  }
}
// A cold send exactly as production records it: the rendered body, the step and the attribution.
const send = (lead, step, day, { body, meta } = {}) => ({
  eventId: `gmail:c${step}-${day}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: at(day),
  subject: step === 1 ? 'employer accounts' : '', content: body ?? renderStaffingEmail(lead, step, OPTIONS).body,
  metadata: JSON.stringify({ step, gmailMessageId: `c${step}-${day}`, gmailThreadId: 't1', senderInboxId: 'primary',
    ...(meta === undefined ? attributionFor(lead, step) : meta) }),
});
const inbound = (lead, id, day, text) => ({
  eventId: `gmail-reply:${id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType: 'positive_reply', occurredAt: at(day), subject: 'Re: employer accounts', content: text,
  metadata: JSON.stringify({ provider: 'gmail', senderInboxId: 'primary', gmailMessageId: id, gmailThreadId: 't1',
    from: lead.email, canonicalState: 'positive', genuineHuman: true }),
});
const humanOut = (lead, id, day, text) => ({
  eventId: `gmail-outbound:${id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType: 'human_response_sent', occurredAt: at(day), subject: 'Re: employer accounts', content: text,
  metadata: JSON.stringify({ provider: 'gmail', direction: 'outbound', actor: 'human', trigger: 'gmail_outbound_ingestion',
    isResponseToInbound: true, gmailMessageId: id, gmailThreadId: 't1', senderInboxId: 'primary' }),
});
const priority = (lead, activities) => buildConversationState({ lead, activities, now: NOW, suppressedEmails: new Set() })
  .qualification.slots.employerAcquisitionPriority;
const askedSteps = slot => slot.askedBy.map(ref => ref.actionType);

// ── V1: unchanged ────────────────────────────────────────────────────────────

test('V1 Touch 3 is recognised exactly as before, by its wording', () => {
  const slot = priority(v1Lead, [send(v1Lead, 1, 1), send(v1Lead, 2, 4), send(v1Lead, 3, 8), inbound(v1Lead, 'r1', 9, 'Yes, it is.')]);
  assert.deepEqual(askedSteps(slot), ['cold_step_3']);
  assert.deepEqual(slot.repliesAfterAsk, ['r1']);
  // Historical Touch 3s: no attribution metadata and the pre-2026-10-03 lowercase wording.
  const legacy = priority(v1Lead, [send(v1Lead, 3, 8, { meta: {},
    body: 'Hi Alex,\n\nQuick question —\n\nis bringing in more employer accounts something Harbour Staffing is focused on right now?' })]);
  assert.deepEqual(askedSteps(legacy), ['cold_step_3']);
  // A V1 Touch 3 whose body was not recorded was, and still is, not counted.
  assert.deepEqual(askedSteps(priority(v1Lead, [send(v1Lead, 3, 8, { body: '' })])), []);
  // V1 Touches 1 and 2 never set it.
  assert.deepEqual(askedSteps(priority(v1Lead, [send(v1Lead, 1, 1), send(v1Lead, 2, 4)])), []);
});

// ── V2: recognised from the send event ───────────────────────────────────────

test('V2 Touch 3 is recognised as having asked the priority / close-the-loop question', () => {
  const t3 = send(v2Lead, 3, 8);
  assert.deepEqual([JSON.parse(t3.metadata).campaignVersion, JSON.parse(t3.metadata).copyVersion],
    [STAFFING_CAMPAIGN_V2.id, CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_V2.id].followUpCopyVersion]);
  const slot = priority(v2Lead, [send(v2Lead, 1, 1), send(v2Lead, 2, 4), t3, inbound(v2Lead, 'r1', 9, 'Not right now.')]);
  assert.deepEqual(askedSteps(slot), ['cold_step_3']);
  assert.equal(slot.askedBy[0].messageId, 'c3-8');
  assert.deepEqual(slot.repliesAfterAsk, ['r1']);
  assert.equal(slot.status, 'unknown', 'only "asked" is recognised; the answer stays unread, as for V1');
  // Independent of the company name and of whether the body was recorded at all.
  assert.deepEqual(askedSteps(priority(v2Lead, [send(v2Lead, 3, 8, { body: '' })])), ['cold_step_3']);
  const other = leadFor(STAFFING_CAMPAIGN_V2, { company: 'Gulf Coast Industrial Labor, Inc.' });
  assert.deepEqual(askedSteps(priority(other, [send(other, 3, 8)])), ['cold_step_3']);
});

test('V2 Touch 1 and Touch 2 do not set it', () => {
  assert.deepEqual(askedSteps(priority(v2Lead, [send(v2Lead, 1, 1)])), []);
  assert.deepEqual(askedSteps(priority(v2Lead, [send(v2Lead, 1, 1), send(v2Lead, 2, 4)])), []);
  // Touch 2 shares Touch 3's follow-up copy version; the step keeps them apart.
  assert.equal(JSON.parse(send(v2Lead, 2, 4).metadata).copyVersion, JSON.parse(send(v2Lead, 3, 8).metadata).copyVersion);
});

test('unrelated inbound or outbound text never triggers it', () => {
  const v2Meta = attributionFor(v2Lead, 3);
  const cases = {
    'prospect quotes the V2 question': [send(v2Lead, 1, 1), inbound(v2Lead, 'r1', 2, `> ${V2_TOUCH_3_WORDING}\nWho is this?`)],
    'a human reply uses the V2 question': [send(v2Lead, 1, 1), humanOut(v2Lead, 'h1', 2, V2_TOUCH_3_WORDING)],
    'a V2 Touch 2 containing the wording': [send(v2Lead, 2, 4, { body: V2_TOUCH_3_WORDING })],
    'a step-3 send with V2 wording but no attribution': [send(v2Lead, 3, 8, { meta: {} })],
    'a step-3 send attributed to V1': [send(v2Lead, 3, 8, { meta: { ...v2Meta, campaignVersion: STAFFING_CAMPAIGN.id } })],
    'a V2 step-3 send under another copy version': [send(v2Lead, 3, 8, { meta: { ...v2Meta, copyVersion: 'industrial_staffing_follow_up_v1' } })],
  };
  for (const [name, activities] of Object.entries(cases)) assert.deepEqual(askedSteps(priority(v2Lead, activities)), [], name);
  // V1 likewise: a reply carrying V2's wording is not an ask.
  assert.deepEqual(askedSteps(priority(v1Lead, [send(v1Lead, 1, 1), inbound(v1Lead, 'r1', 2, V2_TOUCH_3_WORDING)])), []);
});

// ── Copy and switches untouched ──────────────────────────────────────────────

// Fingerprints of the approved renders (subject, text, HTML) for the shared
// sample lead used by staffing-v2-campaign.test.js.
const FINGERPRINTS = {
  [STAFFING_CAMPAIGN.id]: [
    'e83950057c9cdc49d0ccc2ec5a56346fa3626d3fdb6978fbd4edb9c69bca92bb',
    '29b6b5529b006bf15cd120df33335241b09fb6895f62c2c7d7a12758463ee159',
    'd12521017d57af5b91f2d93408071a5b0100d72ea81c52238cdeff9be0b29d03',
  ],
  [STAFFING_CAMPAIGN_V2.id]: [
    'b10366b6383a74fd527247359c52f14a65c4eacd634b59304df0edb75e3ec344',
    '3a251be793bf620956ac28a257ab89f81102fc042d25078eb77f09ca714acc76',
    '1cb2edd1574818a11459dda31247106881563cc00fedde8cd2c0d1093f36a6d0',
  ],
};

test('V1 Touches 1–3 and V2 Touches 1–3 render byte-identically to the approved copy', () => {
  const sample = campaign => ({ id: 'L1', company: 'Tradeco Construction', contactName: 'Dana Smith', email: 'dana@tradeco.com',
    leadNiche: 'industrial_staffing', siteContext: 'Saw you place electricians and plumbers for commercial and industrial contractors.',
    campaign: campaign.name, intendedCampaignVersion: campaign.id, emailTemplateId: campaign.emailTemplateId });
  for (const campaign of [STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2]) {
    for (const step of [1, 2, 3]) {
      const email = renderStaffingEmail(sample(campaign), step, OPTIONS);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([email.subject, email.body, email.html])).digest('hex');
      assert.equal(fingerprint, FINGERPRINTS[campaign.id][step - 1], `${campaign.id} touch ${step}`);
    }
  }
});

test('STAFFING_V2_LIVE stays false and V2 stays draft', () => {
  assert.equal(staffingV2Live(), false);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_V2.id].status, 'draft');
});
