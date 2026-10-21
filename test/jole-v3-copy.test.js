'use strict';

// Jole BTX copy v3 (2026-10-20). Same template, campaign, cadence, senders,
// caps and windows; only the copy a never-contacted Jole lead receives
// changes. A lead already in a sequence keeps the version its first send
// recorded, so no existing thread ever switches copy. ScaleLab is untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  COPY_VERSION, COPY_VERSION_V3, JOLE_V3_OVERVIEW_URL, resolveJoleCopyVersion, renderJoleEmployerStepV3,
  validateJoleEmployerEmailV3, companyWithoutDashSuffix, JOLE_INDUSTRIAL_EMPLOYER_COPY, JOLE_INDUSTRIAL_EMPLOYER_COPY_V3,
} = require('../integrations/clients/jole-copy');
const { renderClientLeadEmail, validateClientLeadEmail, clientPersonalizationState, clientCopyVersionFor, isClientTemplateId } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { CURRENT_COPY_VERSION, COPY_VERSION_V4 } = require('../integrations/clients/jole-copy');
const { setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { queueEligibility } = require('../integrations/outreach-queue');
const { CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { LOCKED_EMAILS, LOCKED_EMAILS_V2, STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { configuredSenders } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { coldSenderHolds, coldSenderVerdict } = require('../integrations/cold-delivery-policy');
const { getClient } = require('../integrations/clients/registry');

const ADDRESS = '2738 Dallas Ave, Ingleside, TX 78362';
const ENV = Object.freeze({
  JOLE_LANDING_PAGE_URL: 'https://jolebtx.netlify.app/', JOLE_BOOKING_LINK: 'https://calendar.app.google/HfJfGYaL3gEaSg4P8',
  JOLE_COMMERCIAL_MAILING_ADDRESS: ADDRESS,
});
const NOW = Date.parse('2026-10-21T14:00:00.000Z');

const research = (n, extra = {}) => ({
  first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'Plant / operations / production',
  company_domain: `gulffab${n}.com`, sector: 'Industrial fabrication / machinery', priority_tier: 'Tier A', site_tie: 'EXACT',
  hiring_site: 'Mont Belvieu, TX', verified_role: 'Millwright', posting_date: '2026-10-01',
  hiring_evidence_url: `https://example.org/jobs/${n}`, verified_at: '2026-10-07', ...extra,
});
const joleLead = (n = 1, { profile = {}, ...extra } = {}) => ({
  id: `JV${n}`, company: `Gulf Fabrication ${n}, LLC`, contactName: 'Pat Rivera', email: `pat@gulffab${n}.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', routingRequired: 'true', senderInboxId: 'jole_group_jorge', clientId: 'jole',
  sheetRow: 2000 + n, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow(research(n, profile)) })),
  ...extra,
});
// A lead's ledger rows, as readColdCallActivities returns them.
const sent = (lead, { step = 1, copyVersion = COPY_VERSION, at = '2026-10-19T12:00:40.000Z', eventType } = {}) => ({
  eventId: `sent:${lead.id}:${step}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: eventType || (step === 1 ? 'initial_email_sent' : 'follow_up_sent'), occurredAt: at,
  metadata: JSON.stringify({ campaignVersion: 'jole_industrial_employer_acquisition_v1', sequenceStep: step, ...(copyVersion ? { copyVersion } : {}) }),
});
const reserved = (lead, { step = 1, copyVersion, at = '2026-10-19T12:00:37.000Z' } = {}) => ({
  eventId: `cold-reserve:${lead.id}:step${step}:attempt1`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'ordinary_send_reserved', occurredAt: at,
  metadata: JSON.stringify({ leadId: lead.id, step, senderInboxId: 'jole_group_jorge', ...(copyVersion ? { copyVersion } : {}) }),
});
// Since v4 (2026-10-21) an untouched lead starts v4; a lead whose thread began on v3 keeps v3.
const v3Began = lead => [reserved(lead, { copyVersion: COPY_VERSION_V3, at: '2026-10-21T12:00:00.000Z' })];
const withClassified = (ids, fn) => {
  setJoleClassificationForTests(Object.fromEntries(ids.map(id => [id, { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX' }])));
  try { return fn(); } finally { setJoleClassificationForTests(null); }
};
const contacted = (n, extra = {}) => joleLead(n, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-19T12:00:40.000Z', ...extra });

const DASH = /[‒-―−]|\s-|-\s|--/;
const coreOf = body => body.slice(0, body.indexOf('\n\nJorge Guerrero\nCEO\n'));

// ── 1. untouched → v3 ────────────────────────────────────────────────────────
test('1. a Jole thread that began on v3 renders the approved v3 copy exactly (untouched leads now start v4)', () => {
  const lead = joleLead(1);
  assert.deepEqual(resolveJoleCopyVersion(lead, []), { copyVersion: COPY_VERSION_V4, reason: 'no_outbound_evidence' });
  assert.equal(CURRENT_COPY_VERSION, COPY_VERSION_V4);
  assert.deepEqual(resolveJoleCopyVersion(lead, v3Began(lead)), { copyVersion: COPY_VERSION_V3, reason: 'first_outbound_recorded_version' });
  const t1 = renderClientLeadEmail(lead, 1, { env: ENV, now: NOW, activities: v3Began(lead) });
  assert.equal(t1.copyVersion, 'jole_industrial_employer_v3');
  assert.equal(t1.subject, 'Millwrights | Mont Belvieu, TX');
  assert.equal(coreOf(t1.body), 'Hi Pat,\n\nSaw Gulf Fabrication 1, LLC is hiring Millwrights in Mont Belvieu, TX.\n\n'
    + 'I can have our team check whether Jole has the right craft coverage for that site and what it would realistically take to fill the gap.\n\n'
    + 'Want me to check?\n\nJorge');
  const t2 = renderClientLeadEmail(lead, 2, { env: ENV, now: NOW, activities: v3Began(lead) });
  assert.equal(t2.subject, null, 'follow-ups reply in the original thread');
  assert.equal(coreOf(t2.body), 'Hi Pat,\n\nJust to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.\n\n'
    + "For an opening like Millwrights in Mont Belvieu, TX, we'd look at the site, shift, certifications, headcount and start date, then tell you whether it's something we can realistically cover.\n\n"
    + "We're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\n"
    + "Here's a quick overview of Jole:\nhttps://jolebtx.netlify.app/\n\n"
    + 'If Millwrights is still open, worth having us take a look?\n\nJorge');
  assert.deepEqual(t2.body.match(/https?:\/\/\S+/g), [JOLE_V3_OVERVIEW_URL], 'only the overview link; no booking link');
  const t3 = renderClientLeadEmail(lead, 3, { env: ENV, now: NOW, activities: v3Began(lead) });
  assert.equal(coreOf(t3.body), 'Hi Pat,\n\nIs getting the Millwrights opening in Mont Belvieu, TX covered still a priority for Gulf Fabrication 1, LLC, or has the need changed?\n\nJorge');
  for (const email of [t1, t2, t3]) {
    assert.ok(email.body.endsWith(`Jorge Guerrero\nCEO\nJole BTX LLC\n${ADDRESS}\n\nThis is a commercial email. Not relevant? Reply "unsubscribe" and I won't follow up again.`));
    assert.doesNotMatch(`${email.subject || ''}\n${email.body}`, DASH, 'no dash punctuation anywhere');
    assert.doesNotMatch(email.body, /scalelab|{{|}}|undefined|null/i);
    assert.equal(validateClientLeadEmail(lead, email, email.step, { activities: v3Began(lead) }), '');
  }
  // The cadence is v2's: Touch 1, +3 business days, +4 business days.
  assert.deepEqual(JOLE_INDUSTRIAL_EMPLOYER_COPY_V3.steps.map(step => step.sendAfterBusinessDays),
    JOLE_INDUSTRIAL_EMPLOYER_COPY.steps.map(step => step.sendAfterBusinessDays));
  assert.deepEqual(JOLE_INDUSTRIAL_EMPLOYER_COPY_V3.steps.map(step => step.sendAfterBusinessDays), [0, 3, 4]);
  // Untouched and not in the v4 classification: held, never v3.
  assert.equal(clientPersonalizationState(lead, { env: ENV, now: NOW }).status, 'hold');
});

test('1b. v3 keeps the optional second role line, and it carries no dash punctuation', () => {
  const lead = joleLead(2, { profile: { secondary_role: 'I&E Technician' } });
  const t1 = renderClientLeadEmail(lead, 1, { env: ENV, now: NOW, activities: v3Began(lead) });
  assert.equal(t1.variant, 'two_roles');
  assert.match(t1.body, /^Hi Pat,\n\nSaw Gulf Fabrication 2, LLC is hiring Millwrights in Mont Belvieu, TX and also has openings for I&E Technicians at the site\.\n\nI can have/);
  assert.doesNotMatch(`${t1.subject}\n${t1.body}`, DASH);
});

test('1c. v3 drops a dash-separated company suffix, keeps in-word hyphens, and refuses any other dash', () => {
  // The real queued company shapes seen on 2026-10-20.
  assert.equal(companyWithoutDashSuffix('Vallourec - North America'), 'Vallourec');
  assert.equal(companyWithoutDashSuffix('Metivo — a Part of BASF Group'), 'Metivo');
  assert.equal(companyWithoutDashSuffix('Marathon Electric – Motors and Generators'), 'Marathon Electric');
  assert.equal(companyWithoutDashSuffix('Custom Tool Inc. - Cookeville, TN'), 'Custom Tool Inc.');
  assert.equal(companyWithoutDashSuffix('Coca-Cola Consolidated'), 'Coca-Cola Consolidated');
  const lead = joleLead(3, { company: 'Vallourec - North America' });
  for (const step of [1, 3]) {
    const email = renderClientLeadEmail(lead, step, { env: ENV, now: NOW, activities: v3Began(lead) });
    assert.match(email.body, /Vallourec(?! -)/);
    assert.doesNotMatch(email.body, /North America/);
  }
  const base = { step: 1, firstName: 'Pat', company: 'Acme', roles: ['Welders'], location: 'Mobile, AL', mailingAddress: ADDRESS };
  assert.throws(() => renderJoleEmployerStepV3({ ...base, roles: ['Welders — Night Shift'] }), /dash punctuation/);
  assert.throws(() => renderJoleEmployerStepV3({ ...base, location: 'Mobile - AL' }), /dash punctuation/);
  assert.equal(renderJoleEmployerStepV3({ ...base, location: 'Winston-Salem, NC' }).subject, 'Welders | Winston-Salem, NC');
  // The postal address is compliance data, not copy: "Suite I-2" style values pass.
  assert.ok(renderJoleEmployerStepV3({ ...base, mailingAddress: '1313 E Alton Gloor, Suite I-2, Brownsville, TX 78526' }).body);
  assert.equal(validateJoleEmployerEmailV3({ subject: 'X — Y', body: 'Hi' }, 1), 'copy contains dash punctuation');
  assert.equal(validateJoleEmployerEmailV3({ subject: null, body: 'Hi https://example.org/x' }, 2), 'touch 2 requires exactly the Jole overview link');
});

// ── 2–3. contacted leads stay on their sequence ─────────────────────────────
test('2. a Jole lead with a Touch 1 send stays on v2 for every later touch', () => {
  const lead = contacted(10);
  const activities = [reserved(lead), sent(lead)];
  assert.deepEqual(resolveJoleCopyVersion(lead, activities), { copyVersion: COPY_VERSION, reason: 'outbound_evidence_predates_version' });
  for (const step of [2, 3]) {
    const email = renderClientLeadEmail(lead, step, { env: ENV, now: NOW, activities });
    assert.equal(email.copyVersion, 'jole_industrial_employer_v2');
    assert.equal(validateClientLeadEmail(lead, email, step), '');
  }
  assert.match(renderClientLeadEmail(lead, 2, { env: ENV, now: NOW, activities }).body, /Worth 10 minutes to see if Jole can realistically cover it\?/);
  assert.match(renderClientLeadEmail(lead, 3, { env: ENV, now: NOW, activities }).body, /^Hi Pat,\n\nJust following up on the Millwrights opening/);
  // Without the reservation row (the send event alone) the recorded version decides.
  assert.deepEqual(resolveJoleCopyVersion(lead, [sent(lead)]), { copyVersion: COPY_VERSION, reason: 'first_outbound_recorded_version' });
});

test('3. a Jole lead with Touch 2 or Touch 3 history stays on v2', () => {
  const lead = contacted(11, { emailStep: '2' });
  const t2 = [reserved(lead), sent(lead), sent(lead, { step: 2, at: '2026-10-22T12:00:00.000Z' })];
  assert.equal(resolveJoleCopyVersion(lead, t2).copyVersion, COPY_VERSION);
  assert.equal(renderClientLeadEmail(lead, 3, { env: ENV, now: NOW, activities: t2 }).copyVersion, COPY_VERSION);
  const done = contacted(12, { emailStep: '3', emailStatus: 'done' });
  const t3 = [sent(done), sent(done, { step: 2, at: '2026-10-22T12:00:00.000Z' }), sent(done, { step: 3, at: '2026-10-28T12:00:00.000Z' })];
  assert.equal(resolveJoleCopyVersion(done, t3).copyVersion, COPY_VERSION);
  // Even a later row stamped v3 cannot move a thread that began on v2: the FIRST send decides.
  const mislabelled = [sent(lead), sent(lead, { step: 2, copyVersion: COPY_VERSION_V3, at: '2026-10-22T12:00:00.000Z' })];
  assert.equal(resolveJoleCopyVersion(lead, mislabelled).copyVersion, COPY_VERSION);
  // A lead row that shows a send with no ledger evidence at hand also stays on v2.
  for (const row of [{ emailStep: '1' }, { emailStatus: 'emailed' }, { lastEmailedAt: '2026-10-19T12:00:40.000Z' }]) {
    assert.deepEqual(resolveJoleCopyVersion(joleLead(13, row), []), { copyVersion: COPY_VERSION, reason: 'lead_row_shows_prior_send' });
  }
  // Matching by address when a ledger row has no lead id (older rows).
  const byEmail = { eventType: 'initial_email_sent', email: 'PAT@gulffab14.com', occurredAt: '2026-10-19T12:00:00.000Z', metadata: '{}' };
  assert.equal(resolveJoleCopyVersion(joleLead(14), [byEmail]).copyVersion, COPY_VERSION);
  // Another lead's send is not this lead's evidence.
  assert.equal(resolveJoleCopyVersion(joleLead(15), [sent(joleLead(16))]).copyVersion, CURRENT_COPY_VERSION);
});

test('3b. a v3 thread stays on v3: its reservation and send record v3, so Touches 2 and 3 render v3', () => {
  const lead = joleLead(17);
  const t1 = renderClientLeadEmail(lead, 1, { env: ENV, now: NOW, activities: v3Began(lead) });
  const after = contacted(17);
  const ledger = [reserved(after, { copyVersion: t1.copyVersion, at: '2026-10-21T12:00:00.000Z' }), sent(after, { copyVersion: t1.copyVersion, at: '2026-10-21T12:00:03.000Z' })];
  for (const step of [2, 3]) assert.equal(renderClientLeadEmail(after, step, { env: ENV, now: NOW, activities: ledger }).copyVersion, COPY_VERSION_V3);
  // A v3 attempt whose delivery failed retries as v3 (its reservation carries the version).
  assert.equal(resolveJoleCopyVersion(lead, [reserved(lead, { copyVersion: COPY_VERSION_V3 })]).copyVersion, COPY_VERSION_V3);
});

// ── 4–6. holds, suppression, duplicates ──────────────────────────────────────
test('4. held Jole leads stay held: review, stale evidence and MANUAL HOLD refuse under v3 as under v2', () => {
  const review = joleLead(20, { stage: 'Import', profile: { verified_role: 'General Laborer' } });
  assert.equal(resolveJoleCopyVersion(review, []).copyVersion, CURRENT_COPY_VERSION);
  assert.throws(() => renderClientLeadEmail(review, 1, { env: ENV, now: NOW, activities: [] }), /needs review/);
  assert.equal(clientPersonalizationState(review, { env: ENV, now: NOW }).status, 'needs_review');
  assert.equal(queueEligibility(review, { leads: [review], env: ENV }).ok, false);
  const stale = joleLead(21);
  assert.throws(() => renderClientLeadEmail(stale, 1, { env: ENV, now: Date.parse('2026-12-31T14:00:00Z'), activities: [] }), /older than 45 days/);
  const held = joleLead(22, { notes: '[MANUAL HOLD] operator review' });
  const verdict = queueEligibility(held, { leads: [held], env: ENV });
  assert.equal(verdict.ok, false);
  // Copy v3 needs no booking link, but the Jole postal address is still mandatory.
  assert.throws(() => renderClientLeadEmail(joleLead(23), 1, { env: { ...ENV, JOLE_COMMERCIAL_MAILING_ADDRESS: '' }, now: NOW, activities: v3Began(joleLead(23)) }), /mailing address/);
});

test('5. suppressed Jole leads stay suppressed', () => {
  const lead = joleLead(30);
  const ok = withClassified([lead.id], () => queueEligibility(lead, { leads: [lead], env: ENV }));
  assert.equal(ok.ok, true, ok.reason);
  const suppressed = withClassified([lead.id], () => queueEligibility(lead, { leads: [lead], env: ENV, suppressedEmails: new Set([lead.email]) }));
  assert.equal(suppressed.ok, false);
  const unsub = joleLead(31, { stage: 'Unsub', emailStatus: 'done', emailStep: '1' });
  assert.equal(queueEligibility(unsub, { leads: [unsub], env: ENV }).ok, false);
  assert.equal(resolveJoleCopyVersion(unsub, []).copyVersion, COPY_VERSION, 'an unsubscribed contact is never treated as untouched');
});

test('6. switching untouched leads to v3 cannot create a duplicate action', () => {
  // Version resolution is pure: it writes nothing and returns the same answer for the same ledger.
  const lead = joleLead(40);
  const before = JSON.stringify(lead);
  const ledger = [sent(joleLead(41))];
  assert.deepEqual(resolveJoleCopyVersion(lead, ledger), resolveJoleCopyVersion(lead, ledger));
  assert.equal(JSON.stringify(lead), before);
  // The render the agent sends and the delivery-time re-render agree (same ledger → same body).
  withClassified([lead.id], () => assert.equal(renderClientLeadEmail(lead, 1, { env: ENV, now: NOW, activities: ledger }).body,
    renderClientLeadEmail(lead, 1, { env: ENV, now: NOW, activities: ledger }).body));
  // An already contacted lead can never be re-queued into a fresh v3 Touch 1.
  const done = contacted(42);
  for (const activities of [[], [reserved(done), sent(done)]]) {
    assert.equal(queueEligibility(done, { leads: [done], activities, env: ENV }).ok, false);
  }
  // A Queued row with a pending reservation (no send yet) is refused too: no second Touch 1.
  const pending = joleLead(43);
  const verdict = queueEligibility(pending, { leads: [pending], activities: [reserved(pending)], env: ENV });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /prior send or pending send reservation/);
  // v3 renders every touch the queue requires, so an eligible untouched lead is admitted exactly once, as today.
  assert.equal(withClassified(['JV44'], () => queueEligibility(joleLead(44), { leads: [joleLead(44)], env: ENV })).ok, true);
  // ...and an unclassified one is never admitted.
  assert.equal(queueEligibility(joleLead(45), { leads: [joleLead(45)], env: ENV }).ok, false);
});

test('6b. every agent render of Jole copy pins its version on the cycle ledger', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const calls = source.match(/renderClientLeadEmail\([^)]*\)/g);
  assert.ok(calls.length >= 3);
  for (const call of calls) assert.match(call, /activities/, call);
  assert.match(source, /clientDeliveryCopyProblem\(lead, step, body, activitiesForCycle \|\| \[\]\)/);
  assert.match(source, /isClientTemplateId\(lead\.emailTemplateId\) && attribution\?\.copyVersion \? \{ copyVersion: attribution\.copyVersion \} : \{\}/);
  const queue = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'outreach-queue.js'), 'utf8');
  assert.match(queue, /renderClientLeadEmail\(lead, step, \{ env: env \|\| process\.env, activities: mine \}\)/);
});

// ── 7–9. ScaleLab isolation ──────────────────────────────────────────────────
const scalelabLead = {
  id: 'SL1', company: 'Acme Staffing', contactName: 'Sam Lee', email: 'sam@acmestaffing.com', stage: 'Queued',
  leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, campaign: STAFFING_CAMPAIGN.id, clientId: '',
};

test('7. ScaleLab leads never resolve to Jole v3', () => {
  assert.equal(isClientTemplateId(scalelabLead.emailTemplateId), false);
  assert.throws(() => clientCopyVersionFor(scalelabLead), /no client renderer/);
  assert.throws(() => renderClientLeadEmail(scalelabLead, 1, { env: ENV, now: NOW, activities: [] }), /no client renderer/);
  assert.equal(validateClientLeadEmail(scalelabLead, { subject: 'x', body: 'y' }, 1), 'no client renderer for this template');
  // No ScaleLab campaign version carries a Jole copy version or template.
  assert.doesNotMatch(JSON.stringify(CAMPAIGN_VERSIONS), /jole/i);
  // The agent overrides attribution only with a client email's version; ScaleLab sends pass none.
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(source, /function withClientCopyVersion\(attribution, copyVersion, personalization = null\) \{\n  if \(!copyVersion\) return attribution;/);
  assert.equal(isClientTemplateId('jole-industrial-employer-v1'), true);
});

test('8. ScaleLab copy and campaign registries are byte-identical to production e25666c', () => {
  const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Fingerprints taken on e25666c before this change; an intentional ScaleLab copy edit must update them.
  assert.equal(sha(LOCKED_EMAILS), 'a5b4edf21580ddd4534617c51240e5e1fa26efb1fe243a870dd360ea43cc5397');
  assert.equal(sha(LOCKED_EMAILS_V2), '700d17e34c9d30446f786f378d6ac6876597e95a8d79cdf86e6c207961225fd1');
  assert.equal(sha(CAMPAIGN_VERSIONS), 'aec4cdceecf994b5cbbea4afe7257bc66b1541f87a8c53c3d795fb00592d28f8');
  // Jole v2 is also unchanged, for the 98 threads already on it.
  assert.equal(COPY_VERSION, 'jole_industrial_employer_v2');
  assert.equal(JOLE_INDUSTRIAL_EMPLOYER_COPY.steps[0].subject, '{{role}} — {{location}}');
});

// The live sending configuration, as the 2026-10-20 21:59 UTC boot log printed it.
const LIVE_CAPS = 'jole_group_jorge:15,jole_group_jguerrero:20,jole_team_jorge:20,jole_team_jguerrero:20,'
  + 'jole_industrial_jorge:0,jole_industrial_jguerrero:0,scalelabaiteam:15';
const LIVE_HOLDS = 'jole_industrial_jorge:warmup_incomplete,jole_industrial_jguerrero:warmup_incomplete';
const JOLE = ['jole_group_jorge', 'jole_group_jguerrero', 'jole_team_jorge', 'jole_team_jguerrero'];
const INDUSTRIAL = ['jole_industrial_jorge', 'jole_industrial_jguerrero'];
const SCALELAB = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'];
const LIVE_ENV = Object.freeze({
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_GLOBAL_DAILY_CEILING: '185', GMAIL_GLOBAL_PER_RUN_CEILING: '27', RECIPIENT_PROVIDER_POLICY: 'off',
  CLIENT_SENDING_AUTHORIZED: 'jole', COLD_SENDER_POOL: 'all', COLD_INBOX_DAILY_CAP: '50',
  COLD_SENDER_HOLDS: LIVE_HOLDS, COLD_INBOX_DAILY_CAPS: LIVE_CAPS,
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'active', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 30, perRunLimit: 5, staffingOnly: true },
    { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
    { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
  ...Object.fromEntries([...JOLE, ...INDUSTRIAL].map(id => [`GMAIL_${id.toUpperCase()}_TOKEN_JSON`, '{"refresh_token":"fixture"}'])),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([...SCALELAB, ...JOLE, ...INDUSTRIAL].map(id => ({ id, status: 'active' }))),
});
const roster = ids => Object.fromEntries(ids.map(id => {
  const sender = configuredSenders(LIVE_ENV).find(item => item.id === id);
  return [id, [sender.sendEligible, sender.dailyLimit, sender.perRunLimit]];
}));

test('9. ScaleLab caps and sending configuration are unchanged (185/day, 27/run)', () => {
  assert.deepEqual(roster(SCALELAB), {
    primary: [true, 50, 6], tryscalelabai: [true, 30, 6], scalelabaiteam: [true, 15, 5],
    deniels: [true, 45, 5], deniels_tryscalelabai: [true, 45, 5],
  });
  assert.deepEqual(capacityFromEnv(configuredSenders(LIVE_ENV), LIVE_ENV).clientLimits.scalelab, { daily: 185, perRun: 27 });
  for (const id of SCALELAB) assert.equal(coldSenderHolds(LIVE_ENV).has(id), false, id);
});

test('10. Jole caps stay 15, 20, 20, 20 (75/day) and the industrial pair stays 0/day on warmup_incomplete', () => {
  assert.deepEqual(roster(JOLE), {
    jole_group_jorge: [true, 15, 2], jole_group_jguerrero: [true, 20, 2], jole_team_jorge: [true, 20, 2], jole_team_jguerrero: [true, 20, 2],
  });
  const senders = configuredSenders(LIVE_ENV);
  for (const id of INDUSTRIAL) {
    const sender = senders.find(item => item.id === id);
    assert.equal(sender.dailyLimit, 0, id);
    assert.equal(coldSenderHolds(LIVE_ENV).get(id), 'warmup_incomplete');
    assert.equal(coldSenderVerdict(sender, LIVE_ENV).allowed, false);
  }
  assert.deepEqual(capacityFromEnv(senders, LIVE_ENV).clientLimits.jole, { daily: 75, perRun: 12 });
  assert.equal(getClient('jole').senderPolicy.maxDailyPerInbox, 20);
  assert.deepEqual(getClient('jole').senderPolicy.allowedCampaignIds, ['jole-btx-employer-acquisition'], 'same single campaign; no new campaign id');
});
