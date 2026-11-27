'use strict';

// Campaign 4 "HOLD Company Test" (owner brief 2026-11-27). Pins: the copy and
// its validator, the sealed profile and its separation from Campaign 3, the
// send blocks at queue / routing / final gate, attribution, the dedupe guard
// both ways, the daily share of the unchanged global cap, the sample-list
// reply flow and the campaign label on replies and tasks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const c4copy = require('../integrations/campaign-4-copy');
const c4profile = require('../integrations/campaign-4-profile');
const c4import = require('../integrations/campaign-4-import');
const share = require('../integrations/campaign-4-share');
const staffing = require('../integrations/staffing-campaign');
const v4copy = require('../integrations/staffing-v4-copy');
const v4profile = require('../integrations/staffing-v4-profile');
const { CAMPAIGN_VERSIONS, activeVersionForLead, coldSendAttribution } = require('../integrations/campaign-versions');
const { templateById, routedLeadReady, campaignVersionsForRoute } = require('../integrations/campaign-routing');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { staffingSendBlockReason } = require('../integrations/staffing-launch-gate');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { evaluateCampaign3Import, IMPORT_SCHEMA: C3_IMPORT_SCHEMA } = require('../integrations/staffing-campaign-3-import');
const { offeredSampleList, agencyStates, SAMPLE_OFFER } = require('../integrations/scalelab-sample-list');
const { STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');

const {
  STAFFING_CAMPAIGN_C4, STAFFING_CAMPAIGN_V4, renderStaffingEmail, renderStaffingPreview, validateStaffingEmail,
  staffingCampaignFor, campaign4SendBlock, staffingV4SendBlock, isCampaign4Marked, isStaffingV4Marked,
  setStaffingC4LiveForTests, staffingV2CampaignNotesRefusal,
} = staffing;

const ACTIVATED = { STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-01T00:00:00.000Z' };
const DASH = /[‒–—―−]/;
const NOW = () => '2026-11-27T18:00:00.000Z';

const row = (extra = {}) => ({
  email: 'dana@tradecostaff.com', company_domain: 'tradecostaff.com', company_name: 'Tradeco Staffing',
  first_name: 'Dana', last_name: 'Smith', state: 'TX', contact_status: 'VALID',
  hold_reason: 'industrial line not established on site', source: 'apollo', gate_run: 'w2k', ...extra,
});
const payload = (records, extra = {}) => ({ schema: c4import.C4_IMPORT_SCHEMA, sourcing_run_id: 'hold-test-2026-11-27', records, ...extra });
let ids = 0;
const newId = () => `c4lead${++ids}`;

function c4Lead({ sendReady = true, extra = {}, rowExtra = {} } = {}) {
  const result = c4import.evaluateCampaign4Import(payload([{ row: row(rowExtra) }], { owner_approved_send_ready: sendReady }), {}, { now: NOW, newId });
  assert.equal(result.accepted.length, 1, JSON.stringify(result.refusals));
  return { ...result.accepted[0].lead, ...extra };
}
const queued = lead => ({ ...lead, stage: 'Queued', senderInboxId: 'primary' });

test.afterEach(() => setStaffingC4LiveForTests(null));

// ── Copy ────────────────────────────────────────────────────────────────────

test('C1. Email 1 is the conditional opener; Emails 2 and 3 are Campaign 3 copy v2, word for word', () => {
  const e1 = c4copy.C4_EMAIL_1;
  assert.match(e1.body, /^Hi {{first_name}},\n\nIf you place warehouse, production or skilled trades workers, we can help you win more employer accounts in that market\.\n\n/);
  assert.equal(e1.body.split(v4copy.V2_EMAIL_1_LOCK).length, 2, 'the v2 Email 1 lock exactly once');
  assert.equal(e1.subject, 'Employer accounts for {{company}}');
  assert.doesNotMatch(e1.body, /Saw you place|focuses on|verified|specialty/i, 'never claims a verified specialisation');
  assert.strictEqual(c4copy.C4_FOLLOW_UPS, v4copy.FOLLOW_UPS_V2);
  assert.match(c4copy.C4_FOLLOW_UPS[0].body, /Want me to pull a short sample list of employers hiring in your market/);
  for (const text of [e1.body, e1.subject, ...c4copy.C4_FOLLOW_UPS.map(f => f.body)]) assert.doesNotMatch(text, DASH);
  assert.equal(c4copy.C4_COPY_VERSION, 'c4_v1');
});

test('C2. every touch renders with the ScaleLab footer and Ref: SA-48271 once, and passes the staffing validator', () => {
  const lead = c4Lead();
  for (const step of [1, 2, 3]) {
    const email = renderStaffingEmail(lead, step, OPTIONS);
    assert.equal(email.campaignId, STAFFING_CAMPAIGN_C4.id);
    assert.equal(email.copyVersion, 'c4_v1');
    assert.equal(email.body.split('Ref: SA-48271').length, 2, `step ${step} Ref once`);
    assert.match(email.body, /\n\nDeins\n\n/);
    assert.doesNotMatch(email.body.split('\n\nDeins\n\n')[0], DASH);
    assert.doesNotMatch(email.body, /scalelabai\.ca/, 'no website line, as Campaign 3');
    assert.equal(validateStaffingEmail({ subject: email.subject, body: email.body, campaignId: email.campaignId, copyVersion: email.copyVersion }, step), null);
    if (step === 1) assert.equal(email.subject, 'Employer accounts for Tradeco Staffing');
    else assert.equal(email.subject, null, 'follow-ups keep the thread subject');
  }
  assert.match(renderStaffingEmail(lead, 1, OPTIONS).body, /^Hi Dana,\n\nIf you place warehouse/);
  assert.ok(renderStaffingPreview(lead, null, 2, OPTIONS).previewOnly);
  // An out-of-office return adds the shared line to a follow-up only.
  assert.match(renderStaffingEmail(lead, 2, { ...OPTIONS, oooResumeContext: true }).body, /^Hi Dana,\n\nCircling back now that you're back in the office\.\n\n/);
  assert.throws(() => renderStaffingEmail(lead, 1, { ...OPTIONS, oooResumeContext: true }));
});

test('C3. the validator refuses Campaign 3 Email 1 copy, claims of verification, dashes and a missing lock', () => {
  const lead = c4Lead();
  const good = renderStaffingEmail(lead, 1, OPTIONS);
  const check = (body, subject = good.subject) => validateStaffingEmail({ subject, body, campaignId: STAFFING_CAMPAIGN_C4.id, copyVersion: 'c4_v1' }, 1);
  assert.match(check(good.body.replace(c4copy.C4_OPENER, 'Saw you place welders and fitters for manufacturers.')), /opener|claims/);
  assert.match(check(good.body.replace('win more', 'win more —')), /dash/);
  assert.match(check(good.body.replace(v4copy.V2_EMAIL_1_LOCK, 'get paid')), /locked sentence/);
  assert.match(check(good.body, 'employer accounts'), /subject/);
  assert.match(validateStaffingEmail({ subject: good.subject, body: good.body, campaignId: STAFFING_CAMPAIGN_C4.id, copyVersion: 'v2' }, 1), /copy version/);
});

// ── Profile and identity ────────────────────────────────────────────────────

test('C4. the sealed profile verifies, carries hold_reason and hq_state, and is never read as Campaign 3', () => {
  const lead = c4Lead();
  const read = c4profile.readC4Profile(lead, { campaignId: STAFFING_CAMPAIGN_C4.id });
  assert.equal(read.ok, true);
  assert.equal(read.profile.hold_reason, 'industrial line not established on site');
  assert.equal(read.profile.hq_state, 'TX');
  assert.equal(read.profile.copy_version, 'c4_v1');
  assert.equal(read.profile.review_status, 'SEND_READY');
  assert.equal(v4profile.hasStaffingV4ProfileMarker(lead), false);
  assert.equal(v4profile.readStaffingV4Profile(lead).ok, false);
  assert.equal(isStaffingV4Marked(lead), false);
  assert.equal(staffingV4SendBlock(lead), null, 'Campaign 3 gates ignore a Campaign 4 lead');
  assert.equal(staffingCampaignFor(lead), STAFFING_CAMPAIGN_C4);
  // Tampering with any sealed field fails closed; nothing renders.
  const tampered = { ...lead, campaign_notes: lead.campaign_notes.replace('"hq_state":"TX"', '"hq_state":"CA"') };
  assert.equal(c4profile.readC4Profile(tampered).reason, c4profile.C4_PROFILE_INTEGRITY_FAILED);
  assert.throws(() => renderStaffingEmail(tampered, 1, OPTIONS), /integrity/);
  assert.equal(campaign4SendBlock(tampered), c4profile.C4_PROFILE_INTEGRITY_FAILED);
});

test('C5. a lead is Campaign 4 or nothing: mixed identities are held, never rendered as Campaign 3', () => {
  const lead = c4Lead();
  const asC3Label = { ...lead, campaign: STAFFING_CAMPAIGN_V4.name };
  assert.equal(staffingCampaignFor(asC3Label), null);
  assert.throws(() => renderStaffingEmail(asC3Label, 1, OPTIONS), /conflicting campaign identity/);
  assert.match(campaign4SendBlock(asC3Label), /conflicting/);
  const asC3Version = { ...lead, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id };
  assert.equal(staffingCampaignFor(asC3Version), null);
  assert.throws(() => activeVersionForLead({ ...lead, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id }));
  // A Campaign 3 label with no Campaign 4 profile is not Campaign 4.
  assert.equal(isCampaign4Marked({ campaign: STAFFING_CAMPAIGN_V4.name }), false);
});

test('C6. campaign_notes is read-only: no write path may change a Campaign 4 profile or put one on another lead', () => {
  const lead = c4Lead();
  assert.match(staffingV2CampaignNotesRefusal(lead, '{}'), /campaign_4_profile_read_only/);
  assert.equal(staffingV2CampaignNotesRefusal(lead, lead.campaign_notes), null, 'rewriting the same value is not a change');
  const other = { id: 'x', email: 'a@bstaff.com', campaign: 'Industrial Staffing Agency', campaign_notes: '' };
  assert.match(staffingV2CampaignNotesRefusal(other, lead.campaign_notes), /campaign_4_profile_read_only/);
});

// ── Send blocks ─────────────────────────────────────────────────────────────

test('C7. queue, routing and the final gate refuse a REVIEW_READY, foreign or paused Campaign 4 lead', async () => {
  const review = queued(c4Lead({ sendReady: false }));
  assert.match(campaign4SendBlock(review), /REVIEW READY/);
  assert.match(staffingSendBlockReason(review, ACTIVATED), /REVIEW READY/);
  assert.match(routedLeadReady(review, ACTIVATED).reason, /REVIEW READY/);
  const ready = queued(c4Lead());
  assert.equal(campaign4SendBlock(ready), null);
  assert.equal(staffingSendBlockReason(ready, ACTIVATED), '');
  assert.equal(routedLeadReady(ready, ACTIVATED).reason || '', '', 'only the Campaign 4 gate is under test here');
  assert.match(campaign4SendBlock({ ...ready, email: 'someone@tradecostaff.com' }), /another address/);
  setStaffingC4LiveForTests(false);
  assert.match(campaign4SendBlock(ready), /not live/);
  assert.equal(templateById(STAFFING_CAMPAIGN_C4.emailTemplateId).ready, false);
  setStaffingC4LiveForTests(null);
  // The queue route writes nothing for a REVIEW_READY lead.
  let wrote = false;
  const result = await queueSelectedLeads({ ids: [review.id], senderInboxId: 'primary', emailTemplateId: STAFFING_CAMPAIGN_C4.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN_C4.id }, {
    loadState: async () => ({ leads: [{ ...review, stage: 'Import', senderInboxId: '' }], activities: [] }),
    validateSelection: () => ({ ok: true }),
    applyChanges: async () => { wrote = true; return []; },
    appendActivity: async () => { wrote = true; }, appendActivities: async () => { wrote = true; },
  });
  assert.notEqual(result.status, 200);
  assert.equal(wrote, false);
});

test('C8. a reply, opt-out, hold, bounce or suppression stops every Campaign 4 touch at the final gate', () => {
  const ready = queued(c4Lead());
  for (const notes of ['[REPLY: Unsubscribed]', '[REPLY: Not Interested]', '[MANUAL HOLD]', '[BOUNCED]']) {
    const verdict = evaluateFreshSendSafety(ready, { ...ready, notes, emailStep: '1' }, new Set(), { purpose: 'cold', env: ACTIVATED });
    assert.equal(verdict.allowed, false, notes);
  }
  assert.equal(evaluateFreshSendSafety(ready, ready, new Set(['dana@tradecostaff.com']), { purpose: 'cold', env: ACTIVATED }).allowed, false);
});

test('C9. every send is attributed to Campaign 4 and copy version c4_v1, in the registry and on the ledger', (t) => {
  const prior = process.env.STAFFING_LAUNCH_ACTIVATED_AT;
  process.env.STAFFING_LAUNCH_ACTIVATED_AT = ACTIVATED.STAFFING_LAUNCH_ACTIVATED_AT;
  t.after(() => { if (prior === undefined) delete process.env.STAFFING_LAUNCH_ACTIVATED_AT; else process.env.STAFFING_LAUNCH_ACTIVATED_AT = prior; });
  const lead = queued(c4Lead());
  const version = CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN_C4.id];
  assert.equal(version.label, 'HOLD Company Test');
  assert.equal(version.family, 'industrial_staffing');
  assert.ok(campaignVersionsForRoute({ niche: 'industrial_staffing' }).some(v => v.id === STAFFING_CAMPAIGN_C4.id));
  const first = coldSendAttribution(lead, 1, {});
  assert.equal(first.campaignVersion, 'hold_company_test_campaign_4');
  assert.equal(first.staffingCopyVersion, 'c4_v1');
  assert.equal(first.copyVersion, 'hold_company_test_c4_e1_c4_v1');
  assert.equal(coldSendAttribution(lead, 2, {}).copyVersion, 'hold_company_test_c4_follow_up_c4_v1');
  assert.throws(() => coldSendAttribution(lead, 1, { staffingCopyVersion: 'v2' }), /differs/);
  // A lead that only names Campaign 4, with no sealed profile, cannot be attributed (or sent).
  assert.throws(() => coldSendAttribution({ leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN_C4.emailTemplateId,
    intendedCampaignVersion: STAFFING_CAMPAIGN_C4.id, campaign: STAFFING_CAMPAIGN_C4.name }, 1, {}), /no sealed profile/);
});

// ── Dedupe guard ────────────────────────────────────────────────────────────

const c3Lead = (extra = {}) => ({ id: 'c3a', email: 'pat@acmestaff.com', website: 'https://acmestaff.com', campaign: STAFFING_CAMPAIGN_V4.name,
  emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id, clientId: 'scalelab',
  stage: 'Contacted', lastEmailedAt: '2026-10-01T16:00:00.000Z', ...extra });

test('C10. the Campaign 4 import refuses any address or company already in Campaign 3 or an earlier ScaleLab campaign', () => {
  const corpus = { leads: [
    c3Lead(),
    c3Lead({ id: 'c3b', email: 'lee@acme-twostaff.com', website: 'https://acme-twostaff.com' }),
    { id: 'v1a', email: 'old@legacystaff.com', website: 'https://legacystaff.com', campaign: 'Industrial Staffing Agency', clientId: 'scalelab', stage: 'Done' },
  ], suppressedEmails: new Set(['blocked@cleanstaff.com']) };
  const records = [
    { row: row({ email: 'pat@acmestaff.com', company_domain: 'acmestaff.com' }) },
    { row: row({ email: 'new@acme-twostaff.com', company_domain: 'acme-twostaff.com' }) },
    { row: row({ email: 'kim@legacystaff.com', company_domain: 'legacystaff.com' }) },
    { row: row({ email: 'blocked@cleanstaff.com', company_domain: 'cleanstaff.com' }) },
    { row: row({ email: 'a@twicestaff.com', company_domain: 'twicestaff.com' }) },
    { row: row({ email: 'b@twicestaff.com', company_domain: 'twicestaff.com' }) },
    { row: row({ email: 'v@pendingstaff.com', company_domain: 'pendingstaff.com', contact_status: 'VERIFY_PENDING' }) },
    { row: row({ email: 'owner@expresspros.com', company_domain: 'expresspros.com' }) },
    { row: row({ email: 'me@gmail.com', company_domain: 'finestaff.com' }) },
    { row: row({ email: 'ok@freshstaff.com', company_domain: 'freshstaff.com' }) },
  ];
  const result = c4import.evaluateCampaign4Import(payload(records), corpus, { now: NOW, newId });
  const codes = Object.fromEntries(result.refusals.map(r => [r.index, r.code]));
  assert.deepEqual(codes, {
    0: 'email_in_campaign_3', 1: 'company_in_campaign_3', 2: 'company_in_earlier_campaign', 3: 'suppressed',
    4: 'duplicate_in_batch', 5: 'duplicate_in_batch', 6: 'contact_not_valid', 7: 'franchise_domain', 8: 'personal_mailbox',
  });
  assert.equal(result.accepted.length, 1);
  const accepted = result.accepted[0].lead;
  assert.equal(accepted.campaign, 'HOLD Company Test');
  assert.equal(accepted.stage, 'Import');
  assert.equal(accepted.senderInboxId, '', 'nothing routed or queued');
  assert.equal(c4profile.readC4Profile(accepted).profile.review_status, 'REVIEW_READY', 'not SEND_READY without owner approval');
  // A second import of the same record is a no-op; a second company contact is refused.
  const again = c4import.evaluateCampaign4Import(payload([{ row: row({ email: 'ok@freshstaff.com', company_domain: 'freshstaff.com' }) },
    { row: row({ email: 'two@freshstaff.com', company_domain: 'freshstaff.com' }) }].slice(0, 1)), { leads: [accepted] }, { now: NOW, newId });
  assert.equal(again.alreadyImported.length, 1);
  const second = c4import.evaluateCampaign4Import(payload([{ row: row({ email: 'two@freshstaff.com', company_domain: 'freshstaff.com' }) }]), { leads: [accepted] }, { now: NOW, newId });
  assert.equal(second.refusals[0].code, 'company_in_campaign_4');
});

test('C11. the Campaign 3 import refuses a company or address that has a Campaign 4 lead, second buyer included', () => {
  const c4 = c4Lead({ rowExtra: { email: 'dana@holdcostaff.com', company_domain: 'holdcostaff.com' }, extra: { stage: 'Done', lastEmailedAt: '2026-10-01T16:00:00.000Z' } });
  const corpus = { leads: [c4], suppressedEmails: new Set() };
  const c3payload = (records, extra = {}) => ({ schema: C3_IMPORT_SCHEMA, sourcing_run_id: 'c3-test', records, ...extra });
  const sameCompany = evaluateCampaign3Import(c3payload([{ row: { email: 'lee@holdcostaff.com', company_domain: 'holdcostaff.com' }, evidence: {} }]), corpus, { now: NOW });
  assert.equal(sameCompany.refusals[0].code, 'duplicate_company');
  const secondBuyer = evaluateCampaign3Import(c3payload([{ row: { email: 'lee@holdcostaff.com', company_domain: 'holdcostaff.com' }, evidence: {},
    second_buyer: { prior_lead_ids: [c4.id] } }], { owner_approved_second_buyer: true }), corpus, { now: NOW });
  assert.equal(secondBuyer.refusals[0].code, 'second_buyer_company_in_campaign_4');
  const sameEmail = evaluateCampaign3Import(c3payload([{ row: { email: 'dana@holdcostaff.com', company_domain: 'otherstaff.com' }, evidence: {} }]), corpus, { now: NOW });
  assert.equal(sameEmail.refusals[0].code, 'duplicate_email');
});

test('C12. Campaign 4 enters only through its own import: the flat import and lead creation refuse it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/staffing\/campaign-4\/leads\/import', requireAuth,/);
  assert.equal((src.match(/code: 'use_campaign_4_import'/g) || []).length, 2);
  // The import never queues, routes or sends.
  const importSrc = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'campaign-4-import.js'), 'utf8');
  assert.doesNotMatch(importSrc, /queueSelectedLeads|sendEmail|guardProviderSend|senderInboxId: '[a-z]/);
});

// ── Daily share of the unchanged global cap ─────────────────────────────────

test('C13. the split: Campaign 4 = 70, Campaign 3 = the rest of ScaleLab\'s 170; configurable; invalid pauses Campaign 4', () => {
  assert.deepEqual(share.campaignSplitFromEnv({}, 170), { cap: 170, c3: 100, c4: 70, source: 'default' });
  assert.deepEqual(share.campaignSplitFromEnv({ CAMPAIGN_4_DAILY_SENDS: '50' }, 170), { cap: 170, c3: 120, c4: 50, source: 'env' });
  assert.equal(share.campaignSplitFromEnv({ CAMPAIGN_4_DAILY_SENDS: '0' }, 170).c3, 170);
  for (const bad of ['abc', '-1', '7.5', '171', '35%']) {
    const split = share.campaignSplitFromEnv({ CAMPAIGN_4_DAILY_SENDS: bad }, 170);
    assert.equal(split.c4, 0, bad);
    assert.equal(split.c3, 170, `${bad}: Campaign 3 keeps the whole cap`);
    assert.equal(split.paused, true);
  }
  // Sends today per campaign, every step, Vancouver day, deduplicated; managed clients are outside.
  const activities = [
    { eventId: 'e1', eventType: 'initial_email_sent', leadId: 'CE-c4a', sourceLeadId: 'c4a', occurredAt: '2026-11-27T16:00:00.000Z', metadata: '{}' },
    { eventId: 'e2', eventType: 'follow_up_sent', leadId: 'CE-gone', occurredAt: '2026-11-27T16:05:00.000Z', metadata: JSON.stringify({ campaignVersion: 'hold_company_test_campaign_4' }) },
    { eventId: 'e3', eventType: 'initial_email_sent', leadId: 'CE-c3a', occurredAt: '2026-11-27T16:10:00.000Z', metadata: '{}' },
    { eventId: 'e4', eventType: 'initial_email_sent', leadId: 'CE-jole', occurredAt: '2026-11-27T16:10:00.000Z', metadata: '{}' },
    { eventId: 'e5', eventType: 'initial_email_sent', leadId: 'CE-c4a', occurredAt: '2026-11-26T16:10:00.000Z', metadata: '{}' },
    { eventId: 'e1', eventType: 'initial_email_sent', leadId: 'CE-c4a', occurredAt: '2026-11-27T16:00:00.000Z', metadata: '{}' },
  ];
  const known = { c4a: 'c4', c3a: 'c3', jole: null };
  const bucket = id => (id in known ? known[id] : 'unknown');
  assert.deepEqual(share.campaignSendsToday(activities, '2026-11-27', bucket), { c3: 1, c4: 2 });
});

test('C14. unused share rolls over both ways; once Campaign 3 is done Campaign 4 gets all 170; the plan is logged', () => {
  const split = share.campaignSplitFromEnv({}, 170);
  const busy = share.planDailySplit(split, { c3: { sent: 0, followUpsDue: 40, queuedEmail1: 200 }, c4: { sent: 0, followUpsDue: 0, queuedEmail1: 383 } });
  assert.deepEqual(busy.allowance, { c3: 100, c4: 70 });
  // Campaign 3 has 30 sends due today in all: 70 of its 100 go to Campaign 4.
  const thin = share.planDailySplit(split, { c3: { sent: 10, followUpsDue: 20, queuedEmail1: 0 }, c4: { sent: 0, followUpsDue: 5, queuedEmail1: 383 } });
  assert.deepEqual(thin.rollover, { toC3: 0, toC4: 70 });
  assert.deepEqual(thin.allowance, { c3: 100, c4: 140 });
  // Campaign 3 finished: Campaign 4 gets the whole cap.
  const done = share.planDailySplit(split, { c3: { sent: 0, followUpsDue: 0, queuedEmail1: 0 }, c4: { sent: 0, followUpsDue: 30, queuedEmail1: 383 } });
  assert.equal(done.allowance.c4, 170);
  // No Campaign 4 leads yet: Campaign 3 keeps all 170, as today.
  const before = share.planDailySplit(split, { c3: { sent: 0, followUpsDue: 30, queuedEmail1: 269 }, c4: {} });
  assert.equal(before.allowance.c3, 170);
  // A paused Campaign 4 receives nothing.
  const paused = share.planDailySplit(share.campaignSplitFromEnv({ CAMPAIGN_4_DAILY_SENDS: 'x' }, 170), { c3: {}, c4: { queuedEmail1: 383 } });
  assert.deepEqual(paused.allowance, { c3: 170, c4: 0 });
  const line = share.splitLogLine(thin, '2026-11-27');
  assert.match(line, /^\[campaign-split\] day=2026-11-27 scalelabCap=170 base c3=100 c4=70 \(default\)/);
  assert.match(line, /rollover toC4=70 toC3=0 \| allowance c3=100 c4=140$/);
});

test('C15a. follow-ups come first inside each campaign: Email 1s leave room for every follow-up still due today', () => {
  const plan = share.planDailySplit(share.campaignSplitFromEnv({}, 170),
    { c3: { sent: 95, followUpsDue: 3, queuedEmail1: 50 }, c4: { sent: 68, followUpsDue: 2, queuedEmail1: 50 } });
  const throttle = share.createCampaignSplitThrottle({ plan, bucketOf: lead => lead.bucket });
  // Campaign 4: 68 sent, 2 follow-ups due, allowance 70: no Email 1, both follow-ups go.
  assert.match(throttle.reserve({ bucket: 'c4' }, 1).reason, /reserved for follow-ups due today/);
  assert.equal(throttle.reserve({ bucket: 'c4' }, 2).ok, true);
  assert.equal(throttle.reserve({ bucket: 'c4' }, 3).ok, true);
  assert.match(throttle.reserve({ bucket: 'c4' }, 2).reason, /Campaign 4 daily split reached \(70\/70\)/);
  // Campaign 3: 95 sent, 3 follow-ups due, allowance 100: two Email 1s fit, a third would eat a follow-up's slot.
  assert.equal(throttle.reserve({ bucket: 'c3' }, 1).ok, true);
  assert.equal(throttle.reserve({ bucket: 'c3' }, 1).ok, true);
  assert.equal(throttle.reserve({ bucket: 'c3' }, 1).ok, false);
  for (const step of [2, 2, 3]) assert.equal(throttle.reserve({ bucket: 'c3' }, step).ok, true);
  assert.equal(throttle.reserve({ bucket: 'c3' }, 2).ok, false);
  // Managed clients are outside the split.
  assert.equal(throttle.reserve({ bucket: null }, 1).ok, true);
});

test('C15b. the agent plans once per run from the ledger, reserves before any probe, and the cap is untouched', () => {
  const leads = [...Array.from({ length: 13 }, (_, i) => ({ id: `c3-${i}` })), ...Array.from({ length: 7 }, (_, i) => ({ id: `c4-${i}`, c4: true }))];
  const out = share.interleaveCampaign4Leads(leads, 0.35, lead => lead.c4);
  assert.equal(out.length, 20);
  const firstTen = out.slice(0, 10).filter(l => l.c4).length;
  assert.ok(firstTen >= 3 && firstTen <= 4, `first 10 hold ${firstTen} Campaign 4 leads`);
  assert.deepEqual(out.filter(l => !l.c4).map(l => l.id), leads.filter(l => !l.c4).map(l => l.id), 'Campaign 3 keeps its order');
  const src = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const start = src.indexOf('async function deliverOrdinaryColdStep(');
  const deliver = src.slice(start, src.indexOf('\n}\n', start));
  const at = needle => { const i = deliver.indexOf(needle); assert.ok(i > 0, needle); return i; };
  for (const later of ['guardProviderSend(', 'recordColdCallActivityStrict(reservation)', 'sendEmail({']) assert.ok(at('campaignSplitSlot(lead, step)') < at(later), later);
  assert.match(src, /function campaignSplitSlot\(lead, step\) \{[\s\S]*?if \(!activeCampaignSplit\) return \{ ok: false/, 'fails closed without a plan');
  assert.match(src, /const scalelabCap = Number\(SENDER_CAPACITY\.clientLimits\?\.\[DEFAULT_CLIENT_ID\]\?\.daily\) \|\| 0;/, 'the split is of ScaleLab\'s own allocation');
  assert.match(src, /selectFollowUps\(all, ownershipActivities, \{ now: endOfDay, quiet: true \}\)/, 'follow-ups due by the end of today are reserved');
  assert.match(src, /console\.log\(splitLogLine\(plan, senderDayKey\)\);/, 'the split used is logged');
  assert.match(src, /const DAILY_SEND_LIMIT = SENDER_CAPACITY\.globalDailyLimit;/, 'the global cap is still derived from sender capacity');
});

// ── Replies, sample list, labels ────────────────────────────────────────────

test('C15. the sample-list reply flow works for Campaign 4: offer detected in Email 2, agency state and greeting from the profile', () => {
  const lead = c4Lead();
  const email2 = renderStaffingEmail(lead, 2, OPTIONS);
  assert.match(email2.body, SAMPLE_OFFER);
  assert.equal(offeredSampleList([{ direction: 'outbound', step: 2, text: email2.body }]) || SAMPLE_OFFER.test(email2.body), true);
  assert.deepEqual(agencyStates(lead), ['TX']);
  const notes = JSON.parse(lead.campaign_notes);
  assert.equal(notes.var_first_name, 'Dana');
  assert.equal(notes.var_company, 'Tradeco Staffing');
  assert.equal(notes.company_domain, 'tradecostaff.com');
  const store = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'scalelab-sample-list-store.js'), 'utf8');
  assert.match(store, /campaign: 'in\.\("Industrial Campaign 3","HOLD Company Test"\)'/);
});

test('C16. replies and tasks carry the campaign label so the dashboard shows "HOLD Company Test"', () => {
  const router = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'scalelab-reply-router.js'), 'utf8');
  assert.match(router, /campaign: String\(state\.lead\.campaign \|\| ''\)/);
  const flow = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'scalelab-sample-list-flow.js'), 'utf8');
  assert.match(flow, /campaign: String\(lead\.campaign \|\| ''\)/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /campaign: campaigns\.get\(String\(row\.lead_id\)\) \|\| ''/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(ui, /row\.campaign \? `<span class="replies-meta">\$\{esc\(campaignName\(row\.campaign\)\)\}<\/span>`/);
  assert.equal(STAFFING_CAMPAIGN_C4.name, 'HOLD Company Test');
});
