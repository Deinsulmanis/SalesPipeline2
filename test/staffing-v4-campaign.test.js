'use strict';

// Industrial Staffing V4 (2026-11-20): one campaign, six evidence-selected
// Email 1 variants, shared Emails 2 and 3. These tests pin the approved copy,
// the variant precedence and fallbacks, variable validation, persistence and
// stability of the selected variant, the shared cadence and safety gates, and
// that V4 is draft: nothing can queue or send under it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const copy = require('../integrations/staffing-v4-copy');
const profileLib = require('../integrations/staffing-v4-profile');
const staffing = require('../integrations/staffing-campaign');
const { CAMPAIGN_VERSIONS, activeVersionForLead, coldSendAttribution, resolveLeadFamily } = require('../integrations/campaign-versions');
const { templateById, routedLeadReady, campaignVersionsForRoute } = require('../integrations/campaign-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { staffingSendBlockReason } = require('../integrations/staffing-launch-gate');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { nextFollowUp, isFollowUpDue, nextSendWindowAt, vancouverWeekday } = require('../integrations/sequence-timing');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { isClientTemplateId } = require('../integrations/clients/client-email');
const { staffingColdStepLandingPlan } = require('../integrations/landing-link-issuance');
const { STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');

const {
  STAFFING_CAMPAIGN, STAFFING_CAMPAIGN_V2, STAFFING_CAMPAIGN_V4, renderStaffingEmail, renderStaffingPreview,
  validateStaffingEmail, staffingCampaignFor, staffingV4SendBlock, setStaffingV4LiveForTests,
  staffingV2CampaignNotesRefusal, isStaffingV4Marked, LOCKED_EMAILS, LOCKED_EMAILS_V2,
} = staffing;

const AS_OF = '2026-11-20';
const PERF = 'We only get paid when we generate qualified employer meetings for you. No qualified meetings, no fees.';
const ACTIVATED = { STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' };
const DASH = /[\u2013\u2014]/;

// ── Fixtures ────────────────────────────────────────────────────────────────

const evidence = (extra = {}) => ({
  asOf: AS_OF, firstName: 'Dana', company: 'Tradeco Staffing', contactName: 'Dana Smith',
  contactStatus: 'READY_FOR_REVIEW', emailResolved: true, attributionP: 0.99,
  employerAds: [], salesHiring: [], expansion: [], leadership: [], candidateAds: [],
  specialization: { phrase: 'skilled trades', url: 'https://tradeco.example/trades', quote: 'We place welders and electricians.' },
  ...extra,
});
const employerAd = (extra = {}) => ({ url: 'https://ads.example/a1', text: 'Need staff? We supply your workforce.', current: true, employerFacingP: 0.95, lastSeen: '2026-11-16', ...extra });
const candidateAd = (extra = {}) => ({ url: 'https://ads.example/c1', quote: 'Now hiring assemblers in Fort Worth, TX.', role: 'assembler', location: 'Fort Worth, TX', current: true, lastSeen: '2026-11-13', ...extra });
const salesHire = (extra = {}) => ({ url: 'https://jobs.example/s1', quote: 'Tradeco is hiring a Business Development Manager to win new clients.', salesPosition: 'Business Development Manager', ownCommercialTeam: true, current: true, observedAt: '2026-11-18', ...extra });
const expansion = (extra = {}) => ({ url: 'https://news.example/e1', quote: 'Tradeco opens a new branch in Houston.', market: 'Houston', announcedAt: '2026-10-01', ...extra });
const leader = (extra = {}) => ({ url: 'https://news.example/l1', quote: 'Dana Smith named Vice President of Sales.', personName: 'Dana Smith', title: 'Vice President of Sales', appointedAt: '2026-09-15', current: true, ...extra });

function v4Lead(ev = evidence(), { review = 'REVIEW_READY', lead = {}, row = {} } = {}) {
  const selection = selectV1(ev);
  const profile = profileLib.buildStaffingV4Profile({
    row: { company: 'Tradeco Staffing', company_domain: 'tradeco.example', contact_name: 'Dana Smith', email: 'dana@tradeco.example',
      v4_tag: 'V4|PASS|STANDARD|MIXED|COPY_TIER_PENDING', demand_score: 50, signal_priority: 'STANDARD', ad_class: 'MIXED',
      contact_status: ev.contactStatus, ...row },
    selection, selectedAt: '2026-11-20T18:00:00.000Z', sourcingRunId: 'v4-test',
  });
  if (review === 'SEND_READY' && profile.copy_status === 'SELECTED') profile.review_status = 'SEND_READY';
  return {
    id: 'V4L1', company: 'Tradeco Staffing', contactName: 'Dana Smith', email: 'dana@tradeco.example',
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN_V4.name, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id,
    emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, senderInboxId: 'primary', routingRequired: 'true',
    stage: 'Queued', emailStatus: '', emailStep: '', notes: '',
    campaign_notes: profileLib.serializeStaffingV4Profile(profile), ...lead,
  };
}
// These tests pin copy v1 (2026-11-20). A lead whose Email 1 went out on v1
// finishes its sequence on v1, so every render here carries a ledger showing
// a v1 Email 1 (a Campaign 3 send from before v2 records no staffingCopyVersion).
// Copy v2 is pinned in staffing-v4-copy-v2.test.js.
const V1_LEDGER = Object.freeze([{ eventType: 'initial_email_sent', sourceLeadId: 'V4L1', occurredAt: '2026-11-20T15:00:00.000Z', metadata: '{}' }]);
function selectV1(ev) { return copy.selectV4Variant(ev, { copyVersion: 'v1' }); }
const render = (lead, step, extra = {}) => renderStaffingEmail(lead, step, { ...OPTIONS, activities: V1_LEDGER, ...extra });
const copyOf = body => body.split('\n\nScaleLabAi\n')[0];

test.afterEach(() => setStaffingV4LiveForTests(null));

// ── 1. Every variant renders its approved copy ──────────────────────────────

const VARIANT_CASES = {
  COPY_A: [evidence({ employerAds: [employerAd()] }), 'Employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you were running ads to reach employers looking for staffing support.\n\nAre you looking to bring in more employer accounts beyond what you're getting through advertising?\n\nI help industrial staffing agencies generate qualified employer meetings by handling the prospecting, outreach, and qualification.\n\n" + PERF + '\n\nWould adding another employer acquisition channel be worth exploring?\n\nDeins'],
  COPY_B: [evidence({ candidateAds: [candidateAd()] }), 'Employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you were advertising assembler positions in Fort Worth, TX.\n\nAre you also looking to bring in more employer accounts that regularly hire for those roles?\n\nI help industrial staffing agencies reach companies hiring the trades they already place and turn those conversations into qualified meetings.\n\n" + PERF + "\n\nWorth seeing how we'd approach this for Tradeco Staffing?\n\nDeins"],
  COPY_C: [evidence(), 'More employer accounts for Tradeco Staffing',
    "Hi Dana,\n\nSaw you were helping employers with skilled trades staffing.\n\nIs bringing in more employer accounts something you're focused on right now?\n\nI help industrial staffing agencies generate qualified employer meetings. We handle everything from finding potential employer clients to outreach and qualification.\n\n" + PERF + '\n\nOpen to seeing how this could work for Tradeco Staffing?\n\nDeins'],
  COPY_D: [evidence({ salesHiring: [salesHire()] }), 'Growing your employer accounts',
    'Hi Dana,\n\nSaw you were hiring a Business Development Manager focused on bringing in new employer accounts.\n\nAre you looking to accelerate employer acquisition right now?\n\nI help industrial staffing agencies generate qualified employer meetings through targeted outbound outreach. We handle the prospecting and qualification so your team can focus on closing new accounts.\n\n' + PERF + '\n\nWould it be worth exploring alongside your internal sales efforts?\n\nDeins'],
  COPY_E: [evidence({ expansion: [expansion()] }), 'Employer accounts in Houston',
    "Hi Dana,\n\nSaw you were expanding into Houston.\n\nAre you currently focused on bringing in new employer accounts in that area?\n\nI help industrial staffing agencies connect with companies hiring skilled tradespeople and turn those conversations into qualified meetings.\n\n" + PERF + "\n\nWorth seeing how we'd approach employer acquisition in Houston?\n\nDeins"],
  COPY_F: [evidence({ leadership: [leader()] }), 'Employer growth at Tradeco Staffing',
    "Hi Dana,\n\nSaw you were recently appointed Vice President of Sales at Tradeco Staffing.\n\nIs growing the company's employer accounts one of your priorities?\n\nI help industrial staffing agencies generate qualified meetings with companies looking for the trades they already supply.\n\nWe handle the prospecting, outreach, and qualification.\n\n" + PERF + '\n\nOpen to seeing what this could look like for Tradeco Staffing?\n\nDeins'],
};

for (const [variant, [ev, subject, text]] of Object.entries(VARIANT_CASES)) {
  test(`1. ${variant} renders its approved subject and body, bolded and footed`, () => {
    const lead = v4Lead(ev);
    const email = render(lead, 1);
    assert.equal(email.copyVariant, variant);
    assert.equal(email.subject, subject);
    assert.equal(copyOf(email.body), text);
    assert.equal(validateStaffingEmail(email, 1), null);
    assert.equal((email.html.match(/<strong>/g) || []).length, 1);
    assert.match(email.html, new RegExp(`<strong>${PERF.replace(/\./g, '\\.')}</strong>`));
    assert.ok(!email.body.includes('*'), 'plain text carries the same wording without asterisks');
    assert.doesNotMatch(email.body, DASH);
  });
}

// ── 2. Shared follow-ups ────────────────────────────────────────────────────

test('2. Emails 2 and 3 are shared by every variant and keep the thread subject', () => {
  const E2 = "Hi Dana,\n\nWe focus specifically on helping industrial staffing agencies bring in new employer accounts, not sourcing candidates.\n\nWe identify companies hiring the trades you place, reach their decision makers, and generate qualified employer meetings.\n\nIt's entirely performance based. We only get paid for the qualified employer meetings we generate.\n\nWould bringing in more employer accounts be relevant for Tradeco Staffing?\n\nDeins";
  const E3 = "Hi Dana,\n\nQuick question, is bringing in more employer accounts something you're focused on right now?\n\nWe only get paid when we generate qualified employer meetings, so there's no meeting fee if we don't deliver results.\n\nWorth exploring, or better left for another time?\n\nDeins";
  for (const [ev] of Object.values(VARIANT_CASES)) {
    const lead = v4Lead(ev);
    const two = render(lead, 2);
    const three = render(lead, 3);
    assert.equal(copyOf(two.body), E2);
    assert.equal(copyOf(three.body), E3);
    assert.equal(two.subject, null, 'follow-ups keep "Re: <Email 1 subject>" for Gmail threading');
    assert.equal(three.subject, null);
    assert.equal(validateStaffingEmail(two, 2), null);
    assert.equal(validateStaffingEmail(three, 3), null);
    assert.match(two.html, /<strong>It&#39;s entirely performance based\. We only get paid for the qualified employer meetings we generate\.<\/strong>/);
    assert.match(three.html, /<strong>We only get paid when we generate qualified employer meetings, so there&#39;s no meeting fee if we don&#39;t deliver results\.<\/strong>/);
  }
  assert.equal(validateStaffingEmail({ ...render(v4Lead(), 2), subject: 'Employer acquisition' }, 2),
    'staffing follow-up must keep the original thread subject');
  // The approved standalone subjects are kept for review.
  assert.deepEqual(copy.FOLLOW_UPS.map(f => f.subject), ['Employer acquisition', 'Employer accounts']);
});

// ── 3. Precedence ───────────────────────────────────────────────────────────

test('3. precedence is A > D > E > F > B > C and never uses the demand score', () => {
  const all = { employerAds: [employerAd()], salesHiring: [salesHire()], expansion: [expansion()], leadership: [leader()], candidateAds: [candidateAd()] };
  assert.equal(selectV1(evidence(all)).variant, 'COPY_A');
  assert.equal(selectV1(evidence({ ...all, employerAds: [] })).variant, 'COPY_D');
  assert.equal(selectV1(evidence({ ...all, employerAds: [], salesHiring: [] })).variant, 'COPY_E');
  assert.equal(selectV1(evidence({ ...all, employerAds: [], salesHiring: [], expansion: [] })).variant, 'COPY_F');
  assert.equal(selectV1(evidence({ candidateAds: [candidateAd()], leadership: [] })).variant, 'COPY_B');
  assert.equal(selectV1(evidence()).variant, 'COPY_C');
  // Demand score is not an input: a high score with no evidence is still C.
  assert.equal(selectV1({ ...evidence(), demandScore: 100, signalPriority: 'HIGH_PRIORITY' }).variant, 'COPY_C');
  const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'staffing-v4-copy.js'), 'utf8');
  const selector = source.slice(source.indexOf('function selectV4Variant'), source.indexOf('// ── V4 tag'));
  assert.doesNotMatch(selector, /demand|score|priority/i, 'the selector never reads demand score or priority');
});

// ── 4. MIXED alone is insufficient ──────────────────────────────────────────

test('4. an ad class of MIXED without a current employer-facing ad is not COPY_A', () => {
  const mixedCandidateOnly = evidence({ employerAds: [employerAd({ employerFacingP: 0.4 })], candidateAds: [candidateAd()] });
  const result = selectV1(mixedCandidateOnly);
  assert.equal(result.variant, 'COPY_B');
  assert.match(result.considered.find(c => c.variant === 'COPY_A').detail, /MIXED alone is not evidence/);
  // Unattributed employer ads do not count either.
  assert.equal(selectV1(evidence({ employerAds: [employerAd()], attributionP: 0.3 })).variant, 'COPY_C');
});

// ── 5. Candidate-only and 6. stale ads ──────────────────────────────────────

test('5. candidate-recruitment ads give COPY_B only with a quoted role and location', () => {
  assert.equal(selectV1(evidence({ candidateAds: [candidateAd()] })).vars.verified_role, 'assembler');
  // Role not in the quote: never invented, falls back to C.
  assert.equal(selectV1(evidence({ candidateAds: [candidateAd({ role: 'welder' })] })).variant, 'COPY_C');
  // Location missing: falls back to C.
  assert.equal(selectV1(evidence({ candidateAds: [candidateAd({ location: '' })] })).variant, 'COPY_C');
});

test('6. stale or undated ads never select A or B', () => {
  const stale = evidence({ employerAds: [employerAd({ current: false, lastSeen: '2026-06-01' })],
    candidateAds: [candidateAd({ current: false, lastSeen: '2021-08-27' })] });
  const result = selectV1(stale);
  assert.equal(result.variant, 'COPY_C');
  assert.match(result.considered.find(c => c.variant === 'COPY_A').detail, /none is current/);
  // "current" flag with an old last-seen date is still stale.
  assert.equal(selectV1(evidence({ employerAds: [employerAd({ lastSeen: '2026-09-01' })] })).variant, 'COPY_C');
  // Undated (LinkedIn) employer ads are not current.
  assert.equal(selectV1(evidence({ employerAds: [employerAd({ current: false, lastSeen: null })] })).variant, 'COPY_C');
});

// ── 7. D, E, F rules ────────────────────────────────────────────────────────

test('7. D needs the agency\'s own sales team, E a recent quoted market, F the recipient now in the role', () => {
  assert.equal(selectV1(evidence({ salesHiring: [salesHire({ ownCommercialTeam: false })] })).variant, 'COPY_C', 'a client\'s sales job is not D');
  assert.equal(selectV1(evidence({ salesHiring: [salesHire({ salesPosition: 'Recruiter' })] })).variant, 'COPY_C', 'a recruiter role is not sales');
  assert.equal(selectV1(evidence({ salesHiring: [salesHire({ observedAt: '2026-08-01' })] })).variant, 'COPY_C', 'a closed posting is not D');
  assert.equal(selectV1(evidence({ expansion: [expansion({ announcedAt: '2025-01-01' })] })).variant, 'COPY_C', 'an old expansion is not E');
  assert.equal(selectV1(evidence({ expansion: [expansion({ market: 'Dallas' })] })).variant, 'COPY_C', 'the market must be in the quote');
  assert.equal(selectV1(evidence({ leadership: [leader({ personName: 'Pat Jones' })] })).variant, 'COPY_C', 'F only for the recipient');
  assert.equal(selectV1(evidence({ leadership: [leader({ current: false })] })).variant, 'COPY_C', 'F only while in the role');
  assert.equal(selectV1(evidence({ leadership: [leader({ appointedAt: '2025-11-01' })] })).variant, 'COPY_C', 'F only when recent');
  assert.equal(selectV1(evidence({ leadership: [leader({ title: 'Office Coordinator' })] })).variant, 'COPY_C', 'F only for a senior commercial role');
});

// ── 8. Missing variables: fall back, else HOLD ──────────────────────────────

test('8. missing or unsafe variables fall back to C, else HOLD, and never render', () => {
  const badMarket = selectV1(evidence({ expansion: [expansion({ market: 'Houston \u2013 TX', quote: 'Opens in Houston \u2013 TX' })] }));
  assert.equal(badMarket.variant, 'COPY_C');
  assert.ok(badMarket.considered.some(c => c.variant === 'COPY_E' && /dash/.test(c.detail)));
  const hold = selectV1(evidence({ specialization: null }));
  assert.equal(hold.status, 'HOLD');
  assert.equal(hold.variant, '');
  assert.throws(() => render(v4Lead(evidence({ specialization: null })), 1), /on hold/);
  assert.equal(renderStaffingPreview(v4Lead(evidence({ specialization: null })), null, 1, { ...OPTIONS, activities: V1_LEDGER }), null);
  // No first name: hold (never "Hi there," and never "Hi undefined,").
  const noName = selectV1(evidence({ firstName: '' }));
  assert.equal(noName.status, 'HOLD');
  for (const value of [undefined, null, 'undefined', 'null', '{{first_name}}', '  Dana', 'D', 'N/A']) {
    assert.ok(copy.variableProblem('first_name', value), `${String(value)} is refused`);
  }
  assert.equal(copy.variableProblem('company', 'RJ-Staffing'), null, 'a hyphen inside a proper name is kept');
  assert.ok(copy.variableProblem('company', 'Tradeco - Staffing'), 'a free-standing hyphen is refused');
  assert.throws(() => copy.renderV4Copy({ variant: 'COPY_B', step: 1, vars: { first_name: 'Dana', company: 'X Co' }, appendFooter: t => t }), /verified_role is missing/);
});

test('8b. a held contact (NEEDS_EVIDENCE or unresolved email) never renders', () => {
  const needs = selectV1(evidence({ employerAds: [employerAd()], contactStatus: 'NEEDS_EVIDENCE' }));
  assert.equal(needs.status, 'HOLD');
  assert.equal(needs.variant, 'COPY_A', 'the evidence-supported variant is reported for review');
  assert.throws(() => render(v4Lead(evidence({ employerAds: [employerAd()], contactStatus: 'NEEDS_EVIDENCE' })), 1), /on hold/);
  assert.equal(selectV1(evidence({ emailResolved: false })).status, 'HOLD');
});

// ── 9. Scheduling ───────────────────────────────────────────────────────────

test('9. V4 uses the shared cadence: Day 0, Day 3, Day 7 (and 3 days after Email 2), in send windows', () => {
  const lead = v4Lead();
  const t1 = '2026-11-23T16:00:00.000Z'; // Monday 08:00 Vancouver
  const after1 = nextFollowUp({ ...lead, emailStep: '1', lastEmailedAt: t1 });
  assert.equal(after1.dueAtIso, '2026-11-26T16:00:00.000Z', 'Email 2 three Vancouver days later');
  const activities = [{ eventType: 'initial_email_sent', sourceLeadId: lead.id, occurredAt: t1, metadata: '{}' }];
  const after2 = nextFollowUp({ ...lead, emailStep: '2', lastEmailedAt: '2026-11-26T16:00:00.000Z' }, { activities });
  assert.equal(after2.dueAtIso, '2026-11-30T16:00:00.000Z', 'Email 3 seven days after Email 1');
  // A late Email 2 pushes Email 3 to at least three days after it; no catching up.
  const late = nextFollowUp({ ...lead, emailStep: '2', lastEmailedAt: '2026-11-29T16:00:00.000Z' }, { activities });
  assert.equal(late.dueAtIso, '2026-12-02T16:00:00.000Z');
  assert.equal(isFollowUpDue({ ...lead, emailStep: '1', lastEmailedAt: t1 }, Date.parse('2026-11-25T16:00:00.000Z')), false);
  // Due on a Saturday: the next permitted window is Monday 07:00 Vancouver.
  const saturday = Date.parse('2026-11-28T18:00:00.000Z');
  const slot = nextSendWindowAt(saturday);
  assert.equal(vancouverWeekday(slot), 1);
  const wall = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(slot);
  assert.equal(wall, '2026-11-30, 07:00', 'Monday 07:00 Vancouver');
  // Staffing has no scheduler of its own: V4 adds no timing copy.
  const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'staffing-v4-copy.js'), 'utf8');
  assert.doesNotMatch(src, /afterTouch1Days|SEND_WINDOW|addVancouverDays/);
});

// ── 10/11. Reply and unsubscribe stop the sequence ──────────────────────────

test('10. a reply or unsubscribe stops every V4 touch at the final gate, even if V4 were live', () => {
  setStaffingV4LiveForTests(true);
  const ready = v4Lead(evidence(), { review: 'SEND_READY' });
  const env = { ...ACTIVATED };
  for (const notes of ['[REPLY: Unsubscribed]', '[REPLY: Not Interested]', '[MANUAL HOLD]', '[BOUNCED]']) {
    const current = { ...ready, notes, emailStep: '1' };
    const verdict = evaluateFreshSendSafety(ready, current, new Set(), { purpose: 'cold', env });
    assert.equal(verdict.allowed, false, notes);
  }
  const suppressed = evaluateFreshSendSafety(ready, ready, new Set(['dana@tradeco.example']), { purpose: 'cold', env });
  assert.equal(suppressed.allowed, false);
  assert.equal(suppressed.reason, 'suppression-list');
  const replied = evaluateFreshSendSafety(ready, { ...ready, stage: 'Replied', emailStep: '1' }, new Set(), { purpose: 'cold', env });
  assert.equal(replied.allowed, false);
});

// ── 12. Idempotency and stability ───────────────────────────────────────────

test('12. the selected variant is sealed: no other writer can change it, and a tampered profile renders nothing', () => {
  const lead = v4Lead(evidence({ employerAds: [employerAd()] }));
  const changed = lead.campaign_notes.replace('"copy_variant":"COPY_A"', '"copy_variant":"COPY_C"');
  assert.match(staffingV2CampaignNotesRefusal(lead, changed), /staffing_v4_profile_read_only/);
  assert.match(staffingV2CampaignNotesRefusal(lead, ''), /staffing_v4_profile_read_only/);
  assert.equal(staffingV2CampaignNotesRefusal(lead, lead.campaign_notes), null, 'rewriting the same value is not a change');
  assert.match(staffingV2CampaignNotesRefusal({ campaign_notes: '' }, lead.campaign_notes), /written only by the V4 import/);
  const tampered = { ...lead, campaign_notes: changed };
  assert.equal(profileLib.readStaffingV4Profile(tampered).reason, profileLib.PROFILE_INTEGRITY_FAILED);
  assert.throws(() => render(tampered, 1), /integrity_failed/);
  // Same lead, same step: the same deterministic reservation action id.
  assert.equal(ordinaryColdActionId(lead.id, 1), ordinaryColdActionId(lead.id, 1));
  // Re-rendering is byte-identical.
  assert.equal(render(lead, 1).body, render(lead, 1).body);
  // The original tag and score are preserved beside the variant.
  const read = profileLib.readStaffingV4Profile(lead).profile;
  assert.equal(read.v4_tag, 'V4|PASS|STANDARD|MIXED|COPY_TIER_PENDING');
  assert.equal(read.demand_score, 50);
  assert.equal(read.copy_variant, 'COPY_A');
  assert.deepEqual(copy.parseV4Tag(read.v4_tag), { tag: read.v4_tag, priority: 'STANDARD', adClass: 'MIXED', copyTier: 'COPY_TIER_PENDING' });
  // Priority is not converted to a personalization tier.
  assert.equal(read.v4_tag.includes('TIER_A'), false);
});

// ── 13. Ownership: ScaleLab, never Jole, never V1/V2 ────────────────────────

test('13. a V4 lead is ScaleLab\'s V4 or nothing', () => {
  const lead = v4Lead();
  assert.equal(staffingCampaignFor(lead), STAFFING_CAMPAIGN_V4);
  assert.equal(isStaffingV4Marked(lead), true);
  assert.equal(resolveLeadFamily(lead).family, 'industrial_staffing');
  assert.equal(resolveLeadFamily(lead).managed, undefined);
  assert.equal(isClientTemplateId(STAFFING_CAMPAIGN_V4.emailTemplateId), false);
  // A V4 profile on a V1-labelled lead matches neither V1 nor V4: held.
  const conflicted = { ...lead, campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId };
  assert.equal(staffingCampaignFor(conflicted), null);
  assert.throws(() => render(conflicted, 1), /conflicting campaign identity/);
  assert.match(staffingV4SendBlock(conflicted), /conflicting/);
  const v2Labelled = { ...lead, campaign: STAFFING_CAMPAIGN_V2.name };
  assert.equal(staffingCampaignFor(v2Labelled), null);
  assert.equal(staffingColdStepLandingPlan({ lead, step: 2, activities: [] }), null, 'V4 Email 2 carries no landing link');
  assert.throws(() => render(lead, 2, { landingPageUrl: 'https://scalelabai.ca/staffing/?t=AAAAAAAAAAAAAAAAAAAAAA' }), /no landing-page URL/);
});

// ── 14. Jole BTX unchanged ──────────────────────────────────────────────────

test('14. Jole BTX copy and modules are untouched by V4', () => {
  const clients = path.join(__dirname, '..', 'integrations', 'clients');
  for (const file of fs.readdirSync(clients, { recursive: true })) {
    const full = path.join(clients, file);
    if (!fs.statSync(full).isFile()) continue;
    assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /staffing-v4|STAFFING_CAMPAIGN_V4|industrial_staffing_campaign_3|Industrial Campaign 3/, file);
  }
  assert.doesNotMatch(JSON.stringify(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_V4.id]), /jole/i);
});

// ── 15. Existing sequences unchanged ────────────────────────────────────────

test('15. V1 and V2 copy, identity and routing are unchanged', () => {
  assert.equal(LOCKED_EMAILS.length, 3);
  assert.equal(LOCKED_EMAILS_V2.length, 3);
  const v1 = { id: 'L1', company: 'Tradeco', contactName: 'Dana Smith', campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, leadNiche: 'industrial_staffing', siteContext: 'Saw you place welders for fabricators.' };
  assert.equal(staffingCampaignFor(v1), STAFFING_CAMPAIGN);
  assert.equal(render(v1, 1).subject, 'employer accounts');
  assert.equal(isStaffingV4Marked(v1), false);
  assert.equal(staffingV4SendBlock(v1), null);
  assert.ok(campaignVersionsForRoute({ niche: 'industrial_staffing' }).some(v => v.id === STAFFING_CAMPAIGN_V4.id), 'Campaign 3 is a selectable route');
  assert.equal(STAFFING_CAMPAIGN_V4.name, 'Industrial Campaign 3');
  assert.equal(STAFFING_CAMPAIGN_V4.id, 'industrial_staffing_campaign_3');
});

// ── 16/17. Plain text + HTML, footer intact ─────────────────────────────────

test('16. plain text and HTML carry the same words; only the performance sentence is bold', () => {
  for (const step of [1, 2, 3]) {
    const email = render(v4Lead(evidence({ candidateAds: [candidateAd()] })), step);
    const htmlText = email.html.replace(/<\/p>\n<p>/g, '\n\n').replace(/<br>/g, '\n').replace(/<\/?(?:p|strong)>/g, '')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.equal(htmlText, email.body, `step ${step}`);
    assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  }
});

test('17. the ScaleLab compliance footer, address and unsubscribe line are intact; Campaign 3 has no website line', () => {
  for (const step of [1, 2, 3]) {
    const email = render(v4Lead(), step);
    // Owner copy change 2026-11-24: Campaign 3 drops the website line (both copy versions).
    assert.ok(email.body.endsWith(`\n\nScaleLabAi\n${OPTIONS.mailingAddress}\n\nThis is a commercial email. Not relevant? Reply "unsubscribe" and I won't follow up again.\n\nRef: SA-48271`));
    assert.ok(!email.body.includes('scalelabai.ca'));
    assert.ok(email.body.includes(OPTIONS.mailingAddress));
    assert.equal(email.body.split('Deins').length - 1, 1, 'one sign-off');
    assert.equal(validateStaffingEmail({ ...email, body: email.body.replace('Ref: SA-48271', '') }, step) !== null, true);
  }
});

// ── 18. No sends without authorization ──────────────────────────────────────

test('18. Campaign 3 is live, but only a SEND_READY lead under an activated staffing launch can send', async () => {
  const lead = v4Lead();
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_V4.id].status, 'approved', 'live, awaiting the shared staffing activation in tests');
  assert.equal(templateById(STAFFING_CAMPAIGN_V4.emailTemplateId).ready, true);
  assert.throws(() => activeVersionForLead(lead), /not active/, 'no staffing activation in this process');
  assert.match(staffingV4SendBlock(lead), /REVIEW READY, not SEND READY/);
  assert.match(staffingSendBlockReason(lead, ACTIVATED), /REVIEW READY/, 'a REVIEW_READY lead is held at the final gate even with staffing activated');
  assert.equal(routedLeadReady(lead, ACTIVATED).ok, false);
  const sendReady = v4Lead(evidence(), { review: 'SEND_READY' });
  assert.equal(staffingV4SendBlock(sendReady), null);
  assert.match(staffingSendBlockReason(sendReady, {}), /paused/, 'without STAFFING_LAUNCH_ACTIVATED_AT nothing sends');
  assert.equal(staffingSendBlockReason(sendReady, ACTIVATED), '');
  // The kill switch: STAFFING_V4_LIVE = false holds every Campaign 3 lead again.
  setStaffingV4LiveForTests(false);
  assert.match(staffingV4SendBlock(sendReady), /not live yet/);
  setStaffingV4LiveForTests(null);
  // A held contact (NEEDS_EVIDENCE) can never be SEND_READY-sendable.
  const needs = v4Lead(evidence({ contactStatus: 'NEEDS_EVIDENCE', employerAds: [employerAd()] }), { review: 'SEND_READY' });
  assert.match(staffingV4SendBlock(needs), /on hold/);
  // The queue refuses before any write.
  let wrote = false;
  const result = await queueSelectedLeads({ ids: [lead.id], senderInboxId: 'primary', emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN_V4.id }, {
    loadState: async () => ({ leads: [lead], activities: [] }),
    validateSelection: () => ({ ok: true }),
    applyChanges: async () => { wrote = true; return []; },
    appendActivity: async () => { wrote = true; },
    appendActivities: async () => { wrote = true; },
  });
  assert.notEqual(result.status, 200);
  assert.equal(wrote, false);
  // Nothing in V4 code calls a provider or the network.
  for (const file of ['staffing-v4-copy.js', 'staffing-v4-profile.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', file), 'utf8');
    const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(requires.every(mod => ['node:crypto', './staffing-v4-copy'].includes(mod)), `${file} requires only pure modules: ${requires}`);
    assert.doesNotMatch(src, /sendEmail|fetch\(|https\.request|messages\.create/, file);
  }
});

test('18b. live and SEND_READY, V4 attributes each send to its variant', () => {
  setStaffingV4LiveForTests(true);
  const prev = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = ACTIVATED.STAFFING_LAUNCH_ACTIVATED_AT;
  try {
    const lead = v4Lead(evidence({ employerAds: [employerAd()] }), { review: 'SEND_READY' });
    assert.equal(staffingV4SendBlock(lead), null);
    const v1 = { activities: V1_LEDGER };
    assert.equal(coldSendAttribution(lead, 1, v1).copyVersion, 'industrial_staffing_v4_e1_copy_a');
    assert.equal(coldSendAttribution(lead, 1, v1).copyVariant, 'COPY_A');
    assert.equal(coldSendAttribution(lead, 1, v1).staffingCopyVersion, 'v1');
    assert.equal(coldSendAttribution(lead, 2, v1).copyVersion, 'industrial_staffing_v4_follow_up');
    assert.equal(coldSendAttribution(lead, 2, v1).subjectStrategy, 'thread_follow_up_v1');
    // A lead whose Email 1 has not gone out is attributed to v2.
    assert.equal(coldSendAttribution(lead, 1).copyVersion, 'industrial_staffing_v4_e1_v2_copy_a');
    assert.equal(coldSendAttribution(lead, 1).staffingCopyVersion, 'v2');
  } finally {
    if (prev === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = prev;
  }
});

// ── 19. The approved copy itself ────────────────────────────────────────────

test('19. the approved copy has no en/em dashes, signs as Deins, and has six variants', () => {
  assert.deepEqual(Object.keys(copy.EMAIL_1).sort(), ['COPY_A', 'COPY_B', 'COPY_C', 'COPY_D', 'COPY_E', 'COPY_F']);
  for (const item of [...Object.values(copy.EMAIL_1), ...copy.FOLLOW_UPS]) {
    assert.doesNotMatch(item.body + item.subject, DASH);
    assert.ok(item.body.endsWith('\n\nDeins'));
    assert.doesNotMatch(item.body, /(?:^|\s)-(?:\s|$)/);
  }
});

// ── 20. OOO resume keeps the copy ───────────────────────────────────────────

test('20. an out-of-office resume adds the shared line to a follow-up only', () => {
  const lead = v4Lead();
  const resumed = render(lead, 2, { oooResumeContext: true });
  assert.ok(resumed.body.startsWith("Hi Dana,\n\nCircling back now that you're back in the office.\n\nWe focus specifically"));
  assert.equal(validateStaffingEmail(resumed, 2), null);
  assert.throws(() => render(lead, 1, { oooResumeContext: true }), /only a staffing follow-up/);
});

// ── Campaign 3 import ───────────────────────────────────────────────────────

const { evaluateCampaign3Import, IMPORT_SCHEMA } = require('../integrations/staffing-campaign-3-import');
const record = (extra = {}, ev = {}) => ({
  row: { company_name: 'Tradeco Staffing, Inc.', company_domain: 'tradecostaffing.com', email: 'dana@tradecostaffing.com',
    v4_tag: 'V4|PASS|LOW_SIGNAL|NO_ADS_OBSERVED|COPY_TIER_PENDING', demand_score: '0', signal_priority: 'LOW_SIGNAL',
    ad_class: 'NO_ADS_OBSERVED', contact_status: 'READY_FOR_REVIEW', ...extra },
  evidence: evidence(ev),
});
const payload = (records, extra = {}) => ({ schema: IMPORT_SCHEMA, sourcing_run_id: 'v4-test', records, ...extra });
let n = 0;
const ids = { newId: () => `new${++n}`, now: () => '2026-11-20T07:00:00.000Z' };

test('21. the import selects the variant server side and seals SEND_READY only with owner approval', () => {
  const approved = evaluateCampaign3Import(payload([record({}, { candidateAds: [candidateAd()] })], { owner_approved_send_ready: true }), {}, ids);
  assert.equal(approved.accepted.length, 1);
  const lead = approved.accepted[0].lead;
  assert.equal(lead.campaign, 'Industrial Campaign 3');
  assert.equal(lead.intendedCampaignVersion, 'industrial_staffing_campaign_3');
  assert.equal(lead.emailTemplateId, 'industrial-staffing-campaign-3');
  assert.equal(lead.stage, 'Import', 'the import never queues');
  assert.equal(lead.senderInboxId, '', 'no sender at import');
  const profile = profileLib.readStaffingV4Profile(lead).profile;
  assert.equal(profile.copy_variant, 'COPY_B');
  assert.equal(profile.review_status, 'SEND_READY');
  assert.equal(render({ ...lead, routingRequired: 'true' }, 1).copyVariant, 'COPY_B');
  const notApproved = evaluateCampaign3Import(payload([record()]), {}, ids);
  assert.equal(profileLib.readStaffingV4Profile(notApproved.accepted[0].lead).profile.review_status, 'REVIEW_READY');
});

test('22. the import refuses suppressed, duplicate, previously contacted and held leads', () => {
  const corpus = {
    leads: [{ id: 'old', email: 'owner@contactedstaffing.com', website: 'https://contactedstaffing.com', campaign: 'Industrial Staffing Agency', clientId: '' }],
    suppressedEmails: new Set(['stop@optoutstaffing.com']),
  };
  const result = evaluateCampaign3Import(payload([
    record({ email: 'stop@optoutstaffing.com', company_domain: 'optoutstaffing.com' }),
    record({ email: 'owner@contactedstaffing.com', company_domain: 'contactedstaffing.com' }),
    record({ email: 'new@contactedstaffing.com', company_domain: 'contactedgroup.com' }),
    record({ email: 'rick@heldstaffing.com', company_domain: 'heldstaffing.com', contact_status: 'NEEDS_EVIDENCE' }, { contactStatus: 'NEEDS_EVIDENCE' }),
    record({ email: 'x@nospecstaffing.com', company_domain: 'nospecstaffing.com' }, { specialization: null }),
    record({ email: 'someone@gmail.com', company_domain: 'gmail.com' }),
  ], { owner_approved_send_ready: true }), corpus, ids);
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.refusals.map(r => r.code), ['suppressed', 'duplicate_email', 'duplicate_company', 'held', 'held', 'personal_mailbox']);
});
