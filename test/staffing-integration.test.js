'use strict';
/**
 * Staffing CRM/runtime integration.
 *
 * The property that matters most: a staffing lead must never inherit dental
 * anything — not copy, not offer facts, not campaign attribution — and must not
 * be sendable while the campaign is a draft.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { STAFFING_CAMPAIGN, isStaffingCampaign, renderStaffingEmail, validateStaffingEmail,
  staffingOpeningFor, STAFFING_FOLLOW_UP_DELAY_DAYS, BOLD_PHRASES } = require('../integrations/staffing-campaign');
const { templateById, routedLeadReady, validateRoute, normalizeNiche,
  campaignVersionsForRoute, validateCampaignVersionRoute } = require('../integrations/campaign-routing');
const { CAMPAIGN_VERSIONS, familyForLead } = require('../integrations/campaign-versions');
const { offerForLead, warmResponse, OFFERS } = require('../integrations/offer-config');
const { stageSendGate } = require('../integrations/pipeline-sequence-safety');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const agent = readSource('outreach-agent.js');
const OPENING = 'Saw you place welders and machinists for manufacturers.';

// A row exactly as POST /api/coldemail/import would persist it, then routed.
const imported = (over = {}) => ({
  id: 'ce1', company: 'Acme Staffing', contactName: 'Ada Byron', email: 'ada@acmestaffing.com',
  city: 'Houston', tradeType: 'B', website: 'https://acmestaffing.com', stage: 'Import',
  emailStatus: '', lastEmailedAt: '', emailStep: '', notes: `[STAFFING HIGH] ${OPENING}`,
  reviewCount: '', rating: '', tier: '', siteContext: OPENING,
  campaign: STAFFING_CAMPAIGN.name, campaign_notes: '', enrichment_attempted: '',
  leadNiche: 'industrial_staffing', senderInboxId: '', emailTemplateId: '',
  routingRequired: 'true', intendedCampaignVersion: '', firstName: 'Ada', ...over });
const routed = (over = {}) => imported({ senderInboxId: 'primary',
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, ...over });

// ── A. import row resolves to the staffing campaign ─────────────────────────
test('A. an imported staffing row resolves to the staffing campaign, not a default', () => {
  assert.equal(isStaffingCampaign(imported()), true);
  assert.equal(normalizeNiche('industrial_staffing'), 'industrial_staffing');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].emailTemplateId, STAFFING_CAMPAIGN.emailTemplateId);
  assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).niche, 'industrial_staffing');
});

// ── B. siteContext carries the approved opening ─────────────────────────────
test('B. siteContext becomes the personalized opening the renderer uses', () => {
  assert.equal(staffingOpeningFor(imported()), OPENING);
  assert.ok(renderStaffingEmail(routed(), 1).body.includes(OPENING));
  // An explicit field wins, but nothing is invented when both are absent.
  assert.equal(staffingOpeningFor({ hyperPersonalizedOpening: 'x', siteContext: 'y' }), 'x');
  assert.equal(staffingOpeningFor({}), '');
  assert.throws(() => renderStaffingEmail(routed({ siteContext: '', notes: '' }), 1), /no stored personalized opening/);
});

// ── C/D/E. the three locked emails ──────────────────────────────────────────
test('C. Email #1 renders the locked staffing copy, subject and single bold', () => {
  const email = renderStaffingEmail(routed(), 1);
  assert.equal(email.subject, 'employer accounts');
  assert.equal(email.body, `Hi Ada,\n\n${OPENING}\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for Acme Staffing?\n\n— Deins`);
  assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  assert.match(email.html, /<strong>we get paid based on the meetings we generate\.<\/strong>/);
  assert.equal(validateStaffingEmail(email, 1), null);
  // The opening sets up the locked "that exact market" line.
  assert.ok(email.body.indexOf(OPENING) < email.body.indexOf('that exact market'));
});

test('D. Email #2 renders the locked clarification copy with its own bold', () => {
  const email = renderStaffingEmail(routed(), 2);
  assert.equal(email.subject, null, 'follow-ups thread rather than inventing a subject');
  assert.match(email.body, /we're not talking about candidate sourcing/);
  assert.match(email.body, /30-day employer acquisition pilot built around the roles Acme Staffing already places/);
  assert.match(email.body, /If we don't generate qualified employer meetings, there are no meeting fees\./);
  assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  assert.match(email.html, /<strong>We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar\.<\/strong>/);
  assert.equal(validateStaffingEmail(email, 2), null);
});

test('E. Email #3 renders the locked close with its bolded question', () => {
  const email = renderStaffingEmail(routed(), 3);
  assert.equal(email.body, 'Hi Ada,\n\nQuick question —\n\nis bringing in more employer accounts something Acme Staffing is focused on right now?');
  assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  assert.match(email.html, /<strong>is bringing in more employer accounts something Acme Staffing is focused on right now\?<\/strong>/);
  assert.equal(validateStaffingEmail(email, 3), null);
  assert.equal(BOLD_PHRASES.length, 3);
});

// ── F. no dental copy anywhere ──────────────────────────────────────────────
test('F. no dental or receptionist language can appear in a staffing email', () => {
  for (const step of [1, 2, 3]) {
    const body = renderStaffingEmail(routed(), step).body;
    assert.doesNotMatch(body, /receptionist|missed call|dental|patient|clinic|guarantee/i, `step ${step}`);
    assert.doesNotMatch(body, /{{|}}/, `step ${step} has no unmerged placeholder`);
  }
  // The validator refuses dental wording even if it somehow reached the body.
  assert.match(validateStaffingEmail({ subject: 'employer accounts', body: 'We answer missed calls for your clinic.' }, 1),
    /non-staffing offer language/);
});

// ── G/H. ambiguity fails closed ─────────────────────────────────────────────
test('G. a missing or conflicting campaign assignment fails closed', () => {
  assert.equal(isStaffingCampaign({}), false);
  assert.equal(isStaffingCampaign({ campaign: 'Something else' }), false);
  assert.equal(isStaffingCampaign(imported({ emailTemplateId: 'dental-guarantee-v1' })), false);
  assert.equal(isStaffingCampaign(imported({ intendedCampaignVersion: 'dental_v1_measured' })), false);
  for (const lead of [{}, { campaign: 'Something else' }])
    assert.throws(() => renderStaffingEmail(lead, 1), /Staffing campaign assignment required/);
});

test('H. a staffing lead never silently resolves to the dental family', () => {
  assert.equal(familyForLead(imported()), 'industrial_staffing');
  assert.equal(familyForLead(routed()), 'industrial_staffing');
  assert.equal(familyForLead({ emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId }), 'industrial_staffing');
  // Dental, roofing and legacy rows are untouched by that addition.
  assert.equal(familyForLead({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' }), 'dental_ai_receptionist');
  assert.equal(familyForLead({ leadNiche: 'roofing', emailTemplateId: 'roofing-survey-v1' }), 'roofing_survey');
  assert.equal(familyForLead({}), 'dental_ai_receptionist', 'legacy unrouted rows stay dental');
});

// ── I/J/K/L. reply offer context ────────────────────────────────────────────
test('I. staffing replies are answered from staffing offer facts', () => {
  const offer = offerForLead(imported());
  assert.equal(offer.id, STAFFING_CAMPAIGN.id);
  assert.equal(offer.targetCustomer, 'industrial staffing agencies');
  assert.ok(offer.approvedClaims.some(c => /employer acquisition, not candidate sourcing/i.test(c)));
  assert.ok(offer.approvedClaims.some(c => /no qualified employer meetings.*no meeting fees/i.test(c)));
  assert.ok(OFFERS.industrial_staffing, 'a staffing offer family is registered');
});

test('J. a staffing positive reply never mentions receptionist or dental services', () => {
  const offer = offerForLead(imported());
  for (const action of ['AUTO_BOOKING_RESPONSE', 'AUTO_MEETING_RESPONSE']) {
    const text = warmResponse({ action, lead: imported(), offer });
    assert.doesNotMatch(text, /receptionist|missed call|dental|patient|clinic/i, action);
    assert.ok(text.includes(offer.bookingUrl), `${action} uses the configured booking link`);
  }
  // A blank company must not be described as a clinic.
  const blank = warmResponse({ action: 'AUTO_BOOKING_RESPONSE', lead: imported({ company: '' }), offer });
  assert.match(blank, /your agency/);
  assert.doesNotMatch(blank, /your clinic/);
  // Dental keeps its own wording exactly.
  const dentalLead = { leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', company: '' };
  assert.match(warmResponse({ action: 'AUTO_BOOKING_RESPONSE', lead: dentalLead, offer: offerForLead(dentalLead) }), /your clinic/);
});

test('K. staffing pricing is never invented', () => {
  const offer = offerForLead(imported());
  assert.equal(offer.pricing, null);
  assert.throws(() => warmResponse({ action: 'AUTO_PRICING_RESPONSE', lead: imported(), offer }),
    /approved pricing is not configured/);
  assert.ok(offer.prohibitedClaims.includes('unconfigured prices'));
  assert.ok(offer.prohibitedClaims.includes('candidate sourcing'));
  assert.ok(offer.prohibitedClaims.includes('receptionist or call answering'));
});

test('L. the staffing booking CTA is the configured campaign link, not a dental one', () => {
  const staffing = offerForLead(imported());
  const dental = offerForLead({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' });
  assert.ok(staffing.bookingUrl, 'staffing has a booking URL');
  assert.equal(staffing.bookingUrl, dental.bookingUrl, 'both use the same configured calendar');
  assert.notEqual(staffing.faq.what, dental.faq.what, 'but the offer explanation is campaign-specific');
  assert.match(staffing.faq.what, /employer acquisition/i);
});

// ── M/N. sender and thread behaviour are the shared hardened ones ───────────
test('M/N. staffing reuses the shared sender, thread and follow-up machinery', () => {
  // Staffing supplies copy only: no separate send, reservation or thread path.
  assert.ok(!/staffingSendEmail|sendStaffingEmail|staffingQuota|staffingReservation/.test(agent),
    'staffing must not fork the sending infrastructure');
  // Follow-up bodies branch on the template; sender/thread selection does not.
  assert.match(agent, /if \(lead\.emailTemplateId === STAFFING_TEMPLATE\) \{\n\s*try \{ body = staffingFollowUpBody\(lead, nextStepNum\); \}/);
  assert.equal(agent.split('staffingFollowUpBody(lead, nextStepNum)').length - 1, 2, 'both follow-up sites are covered');
  // Dental and roofing keep the original unguarded call, so their behaviour is
  // provably unchanged by the staffing branch.
  assert.equal(agent.split('      body = template.body(lead);').length - 1, 2, 'both non-staffing paths are untouched');
  // chooseSender / resolveColdFollowUpThread stay on the shared path.
  assert.match(agent, /thread = await resolveColdFollowUpThread\(/);
  assert.equal(STAFFING_FOLLOW_UP_DELAY_DAYS.length, 2);
  assert.deepEqual([...STAFFING_FOLLOW_UP_DELAY_DAYS], [3, 5], 'same spacing as the ordinary cadence');
});

test('N. an unrenderable staffing follow-up defers instead of using other copy', () => {
  assert.match(agent, /follow-up deferred[\s\S]{0,160}\$\{error\.message\}/);
  // Both staffing follow-up sites catch and bail; one returns, one continues.
  const guarded = agent.split('try { body = staffingFollowUpBody(lead, nextStepNum); }');
  assert.equal(guarded.length - 1, 2);
  assert.ok(/catch \(error\)/.test(guarded[1]) && /catch \(error\)/.test(guarded[2]));
  assert.ok(/return false;/.test(guarded[1].slice(0, 300)));
  assert.ok(/continue;/.test(guarded[2].slice(0, 300)));
});

// ── O/P/Q. the shared safety stack still gates staffing ─────────────────────
test('O/P/Q. suppression, observer health and quota gate staffing identically', () => {
  const sender = { id: 'primary', email: 'd@x.ca', sendEligible: true, dailyLimit: 40 };
  const base = { checkOnly: false, sendingEnabled: true, senderProof: { ok: true, senderInboxId: 'primary' },
    sender, thread: { threadId: 'T' }, threadVerified: true, observationOk: true,
    senderCount: 0, globalCount: 0, globalLimit: 80 };
  assert.equal(stageSendGate({ ...base, observationOk: false }).code, 'observation_failed');
  assert.equal(stageSendGate({ ...base, senderCount: 40 }).code, 'sender_quota');
  assert.equal(stageSendGate({ ...base, globalCount: 80 }).code, 'global_quota');
  assert.equal(stageSendGate({ ...base, checkOnly: true }).code, 'check_only');
  assert.equal(stageSendGate({ ...base, sendingEnabled: false }).code, 'sending_disabled');
  // The agent's own suppression and junk choke points are template-agnostic.
  assert.match(agent, /SUPPRESSED_EMAILS\.has\(normEmail\(l\.email\)\)/);
  assert.match(agent, /classifyLeadEmail\(l\.email\)/);
});

// ── R/S/T. draft campaign cannot send; import alone changes nothing ─────────
test('R. a draft, not-ready staffing campaign cannot pass the routing gate', () => {
  assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).ready, false);
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].status, 'draft');
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].activatedAt, null);
  const gate = routedLeadReady(routed());
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /not approved for sending/);
  assert.equal(validateRoute({ niche: 'industrial_staffing', senderInboxId: 'primary',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
    inboxes: [{ id: 'primary', email: 'd@x.ca', sendEligible: true, deliveryImplemented: true }] }).ok, false);
  assert.equal(validateCampaignVersionRoute({ niche: 'industrial_staffing',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN.id }).ok, false);
  assert.equal(campaignVersionsForRoute({ niche: 'industrial_staffing' }).length, 0, 'no active staffing version');
});

test('S. importing alone leaves a lead unqueued and unroutable', () => {
  const lead = imported();
  assert.equal(lead.stage, 'Import', 'the importer never writes the Queued stage');
  assert.notEqual(lead.stage, process.env.QUEUE_STAGE || 'Queued');
  assert.equal(lead.senderInboxId, '', 'no sender is assigned at import');
  assert.equal(lead.emailTemplateId, '', 'no template is assigned at import');
  assert.equal(lead.emailStatus, '');
  const gate = routedLeadReady(lead);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /routing assignment is incomplete/);
  // Queue selection requires the queued stage, so an imported row is not picked up.
  assert.match(agent, /if \(l\.stage !== QUEUE_STAGE\) return false;/);
});

test('T. check-only and dry-run cannot reach a provider send', () => {
  assert.match(agent, /if \(CHECK_ONLY\) \{ console\.log\('\[StageSeq\] check-only/);
  assert.match(agent, /if \(DRY_RUN\) \{ console\.log\('\[StageSeq\] dry run/);
  const sender = { id: 'primary', email: 'd@x.ca', sendEligible: true, dailyLimit: 40 };
  assert.equal(stageSendGate({ checkOnly: true, sendingEnabled: true, senderProof: { ok: true },
    sender, thread: { threadId: 'T' }, threadVerified: true, observationOk: true }).allowed, false);
});

// ── U/V. analytics isolation and dental untouched ───────────────────────────
test('U. staffing attribution is isolated from dental reporting', () => {
  assert.equal(familyForLead(imported()), 'industrial_staffing');
  assert.notEqual(familyForLead(imported()), familyForLead({ leadNiche: 'dental' }));
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].family, 'industrial_staffing');
  // Every registered version carries a family, so nothing lands in an unlabelled bucket.
  for (const version of Object.values(CAMPAIGN_VERSIONS)) assert.ok(version.family, `${version.id} has a family`);
});

test('V. dental and roofing behaviour is unchanged by the staffing integration', () => {
  assert.equal(templateById('dental-guarantee-v1').ready, true);
  assert.equal(templateById('roofing-survey-v1').niche, 'roofing');
  const dentalLead = { leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' };
  assert.equal(offerForLead(dentalLead).id, 'dental_pay_per_booking_v1');
  assert.equal(offerForLead(dentalLead).targetCustomer, 'dental practices');
  assert.equal(familyForLead(dentalLead), 'dental_ai_receptionist');
  // The agent still routes roofing and generic dental exactly as before.
  assert.match(agent, /if \(lead\.emailTemplateId === ROOFING_SURVEY_TEMPLATE\) \{/);
  assert.match(agent, /built = await buildEmail\(lead\);/);
});
