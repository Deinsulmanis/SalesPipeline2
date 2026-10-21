'use strict';

// Jole BTX copy v4 (2026-10-21): evidence-aware personalization. Every
// untouched Jole lead resolves to exactly one of exact / role_only /
// general_craft / hold from the reviewed classification
// (clients/data/jole-personalization-v4.json, built from the 1,000-lead
// re-audit). A v4 thread keeps the mode its first send recorded; v2 and v3
// threads keep their copy; contacted threads whose next touch would repeat a
// false claim are held. ScaleLab is untouched (jole-v3-copy.test.js pins it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COPY_VERSION, COPY_VERSION_V3, COPY_VERSION_V4, CURRENT_COPY_VERSION, renderJoleEmployerStepV4, v4ModeProblem,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V4, JOLE_V3_OVERVIEW_URL,
} = require('../integrations/clients/jole-copy');
const {
  JOLE_PERSONALIZATION_DATA: DATA, jolePersonalizationFor, joleSelectionHold, joleFollowUpHold, setJoleClassificationForTests,
} = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail, validateClientLeadEmail, clientPersonalizationState, clientSelectionHold, clientFollowUpHold } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { queueEligibility } = require('../integrations/outreach-queue');

const ADDRESS = '2738 Dallas Ave, Ingleside, TX 78362';
const ENV = Object.freeze({ JOLE_COMMERCIAL_MAILING_ADDRESS: ADDRESS, JOLE_LANDING_PAGE_URL: 'https://jolebtx.netlify.app/', JOLE_BOOKING_LINK: 'https://calendar.app.google/HfJfGYaL3gEaSg4P8' });
const NOW = Date.parse('2026-10-22T14:00:00.000Z');
const DASH = /[‒-―−]|\s-|-\s|--/;
const FOOTER = `\n\nJorge Guerrero\nCEO\nJole BTX LLC\n${ADDRESS}\n\nThis is a commercial email. Not relevant? Reply "unsubscribe" and I won't follow up again.`;
const core = body => body.slice(0, body.indexOf('\n\nJorge Guerrero\nCEO\n'));

const joleLead = (n, { profile = {}, ...extra } = {}) => ({
  id: `JV4${n}`, company: `Gulf Fabrication ${n}, LLC`, contactName: 'Pat Rivera', email: `pat@gulffab4${n}.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', routingRequired: 'true', senderInboxId: 'jole_group_jorge', clientId: 'jole', sheetRow: 4000 + n, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow({
    first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'Plant / operations / production',
    company_domain: `gulffab4${n}.com`, sector: 'Industrial fabrication / machinery', site_tie: 'EXACT', hiring_site: 'Mont Belvieu, TX',
    verified_role: 'Millwright', secondary_role: 'Pipefitter', posting_date: '2026-10-01', hiring_evidence_url: `https://example.org/jobs/${n}`,
    verified_at: '2026-10-07', ...profile,
  }) })),
  ...extra,
});
const reservation = (lead, meta, at = '2026-10-22T12:00:00.000Z') => ({
  eventId: `cold-reserve:${lead.id}:step1:attempt1`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'ordinary_send_reserved', occurredAt: at, metadata: JSON.stringify({ leadId: lead.id, step: 1, ...meta }),
});
const CLASSIFIED = {
  JV41: { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX', evidenceCheckedAt: '2026-10-15', unsupportedLocations: ['Mont Belvieu, TX'], unsupportedRoles: ['Millwrights', 'Millwright', 'Pipefitters'], reason: 'fixture' },
  JV42: { mode: 'role_only', role: 'Millwrights', location: null, evidenceCheckedAt: '2026-10-05', unsupportedLocations: ['Mont Belvieu, TX', 'Baytown, TX'], unsupportedRoles: ['Millwrights', 'Millwright', 'Pipefitters'], reason: 'fixture' },
  JV43: { mode: 'general_craft', role: null, location: null, unsupportedLocations: ['Mont Belvieu, TX'], unsupportedRoles: ['Millwrights', 'Millwright', 'Pipefitters'], reason: 'fixture' },
  JV44: { mode: 'hold', role: null, location: null, reason: 'cited role is travel or non-site work' },
  JV46: { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX', evidenceCheckedAt: '2026-09-20', unsupportedLocations: ['Mont Belvieu, TX'], unsupportedRoles: ['Millwrights', 'Millwright', 'Pipefitters'], reason: 'fixture' },
  followUpHolds: { JV49: { reason: 'jole_industrial_employer_v2 thread: audit A; its next touch would repeat that claim' } },
};
const classified = fn => { setJoleClassificationForTests(CLASSIFIED); try { return fn(); } finally { setJoleClassificationForTests(null); } };
const render = (lead, step, activities = []) => renderClientLeadEmail(lead, step, { env: ENV, now: NOW, activities });

// ── The approved copy, mode by mode ──────────────────────────────────────────
test('exact: names the verified role and site on every touch, exactly the approved v4 copy', () => classified(() => {
  const lead = joleLead(1);
  const [t1, t2, t3] = [1, 2, 3].map(step => render(lead, step));
  assert.equal(t1.copyVersion, 'jole_industrial_employer_v4');
  assert.deepEqual(t1.personalization, { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX' });
  assert.equal(t1.subject, 'Millwrights | Mont Belvieu, TX');
  assert.equal(core(t1.body), 'Hi Pat,\n\nSaw Gulf Fabrication 1, LLC is hiring Millwrights in Mont Belvieu, TX.\n\nI can have our team check whether Jole has the right craft coverage for that site and what it would realistically take to fill the gap.\n\nWant me to check?\n\nJorge');
  assert.equal(core(t2.body), "Hi Pat,\n\nJust to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.\n\nFor an opening like Millwrights in Mont Belvieu, TX, we'd look at the site, shift, certifications, headcount and start date, then tell you whether it's something we can realistically cover.\n\nWe're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\nHere's a quick overview of Jole:\nhttps://jolebtx.netlify.app/\n\nIf Millwrights is still open, worth having us take a look?\n\nJorge");
  assert.equal(core(t3.body), 'Hi Pat,\n\nIs getting the Millwrights opening in Mont Belvieu, TX covered still a priority for Gulf Fabrication 1, LLC, or has the need changed?\n\nJorge');
  // The profile's second role was never checked against its own posting: no second-role line.
  assert.doesNotMatch(t1.body, /also has openings|Pipefitter/);
}));

test('role_only: names the role, never a city or site', () => classified(() => {
  const lead = joleLead(2);
  const [t1, t2, t3] = [1, 2, 3].map(step => render(lead, step));
  assert.equal(t1.subject, 'Millwrights');
  assert.equal(core(t1.body), 'Hi Pat,\n\nSaw Gulf Fabrication 2, LLC has been hiring Millwrights recently.\n\nI can have our team check whether Jole has the right craft coverage and what it would realistically take to support the need.\n\nWant me to check?\n\nJorge');
  assert.equal(core(t2.body), "Hi Pat,\n\nJust to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.\n\nFor a need like Millwrights, we'd look at the shift, certifications, headcount, start date and site requirements, then tell you whether it's something we can realistically cover.\n\nWe're not trying to force every opening into a fit. If we can't cover it properly, we'll tell you.\n\nHere's a quick overview of Jole:\nhttps://jolebtx.netlify.app/\n\nIf the Millwrights need is still active, worth having us take a look?\n\nJorge");
  assert.equal(core(t3.body), 'Hi Pat,\n\nIs getting the Millwrights need covered still a priority for Gulf Fabrication 2, LLC, or has the need changed?\n\nJorge');
  for (const email of [t1, t2, t3]) assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, /Mont Belvieu|Baytown|, TX\b/);
}));

test('general_craft: names neither a role, a place nor a current opening', () => classified(() => {
  const lead = joleLead(3);
  const [t1, t2, t3] = [1, 2, 3].map(step => render(lead, step));
  assert.equal(t1.subject, 'skilled trade coverage');
  assert.equal(core(t1.body), 'Hi Pat,\n\nReaching out because Gulf Fabrication 3, LLC operates in an industrial environment where skilled trade coverage can become a bottleneck.\n\nI can have our team look at where Jole could realistically support your craft needs when coverage gets tight.\n\nWorth a look?\n\nJorge');
  assert.equal(core(t2.body), "Hi Pat,\n\nJust to give you some context, Jole has supported industrial employers with skilled trade labor for about 25 years and works with roughly 800 workers a year.\n\nWhen an employer needs additional craft coverage, we look at the trades, site requirements, headcount, certifications and timing, then tell them whether it's something we can realistically support.\n\nWe're not trying to force every requirement into a fit. If we can't cover it properly, we'll tell you.\n\nHere's a quick overview of Jole:\nhttps://jolebtx.netlify.app/\n\nWorth keeping Jole in mind when coverage gets tight?\n\nJorge");
  assert.equal(core(t3.body), 'Hi Pat,\n\nIs adding another option for skilled trade coverage something Gulf Fabrication 3, LLC is focused on right now, or are you mostly covered?\n\nJorge');
  for (const email of [t1, t2, t3]) assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, /hiring|opening|Millwright|Pipefitter|Mont Belvieu/i);
}));

test('every v4 mode: no dash punctuation, the v3 footer, the overview link on Touch 2 only, and the v3 cadence', () => classified(() => {
  for (const n of [1, 2, 3]) {
    for (const step of [1, 2, 3]) {
      const email = render(joleLead(n), step);
      assert.doesNotMatch(`${email.subject || ''}\n${email.body}`, DASH);
      assert.ok(email.body.endsWith(FOOTER));
      assert.deepEqual(email.body.match(/https?:\/\/\S+/g) || [], step === 2 ? [JOLE_V3_OVERVIEW_URL] : []);
      assert.equal(validateClientLeadEmail(joleLead(n), email, step), '');
    }
  }
  assert.deepEqual(JOLE_INDUSTRIAL_EMPLOYER_COPY_V4.steps.map(item => item.sendAfterBusinessDays), [0, 3, 4]);
}));

test('the mode guard refuses any claim its mode does not permit', () => {
  const email = { step: 1, subject: 'Millwrights', coreBody: 'Saw Acme has been hiring Millwrights in Baytown, TX.' };
  assert.match(v4ModeProblem(email, { mode: 'role_only', role: 'Millwrights' }), /must not name a location/);
  assert.match(v4ModeProblem({ step: 1, subject: 'x', coreBody: 'Acme is hiring' }, { mode: 'general_craft' }), /current opening/);
  assert.match(v4ModeProblem({ step: 1, subject: 'x', coreBody: 'Need Welders?' }, { mode: 'general_craft', forbiddenRoles: ['Welders'] }), /must not name a role/);
  assert.match(v4ModeProblem({ step: 3, subject: null, coreBody: 'Is Welders covered?' }, { mode: 'exact', role: 'Welders', location: 'Mobile, AL' }), /role and site/);
  // A company name such as "Acme, LP" is not a place.
  assert.equal(v4ModeProblem({ step: 1, subject: 'Welders', coreBody: 'Saw Acme, LP has been hiring Welders recently.' }, { mode: 'role_only', role: 'Welders', company: 'Acme, LP' }), '');
  // An exact render with no verified site never falls back to the stored one.
  assert.throws(() => renderJoleEmployerStepV4({ step: 1, firstName: 'Pat', company: 'Acme', mailingAddress: ADDRESS, personalization: { mode: 'exact', role: 'Welders' } }), /location is missing|unsafe/);
});

// ── 30-day freshness ─────────────────────────────────────────────────────────
test('exact and role_only need evidence checked within 30 days; older evidence falls to general_craft', () => classified(() => {
  // JV46: exact, checked 2026-09-20, which is 32 days before NOW.
  for (const step of [1, 2, 3]) {
    const email = render(joleLead(6), step);
    assert.equal(email.personalization.mode, 'general_craft');
    assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, /hiring|opening|Millwright|Pipefitter|Mont Belvieu/i);
  }
  assert.match(jolePersonalizationFor(joleLead(6), [], { now: NOW }).reason, /older than 30 days; exact fell to general_craft/);
  // JV42: role_only checked 2026-10-05 is fresh through Nov 3 and stale from Nov 4 00:00 UTC.
  const lead = joleLead(2);
  assert.equal(renderClientLeadEmail(lead, 1, { env: ENV, now: Date.parse('2026-11-03T12:00:00Z') }).personalization.mode, 'role_only');
  assert.equal(renderClientLeadEmail(lead, 1, { env: ENV, now: Date.parse('2026-11-05T12:00:00Z') }).personalization.mode, 'general_craft');
  // general_craft claims no current opening: no evidence-age gate, not even the old 45-day one.
  const late = Date.parse('2026-12-31T14:00:00Z');
  assert.equal(renderClientLeadEmail(joleLead(3), 1, { env: ENV, now: late }).personalization.mode, 'general_craft');
  assert.equal(renderClientLeadEmail(joleLead(1), 1, { env: ENV, now: late }).personalization.mode, 'general_craft');
  // A started v4 thread keeps its recorded mode on Touches 2 and 3.
  const started = joleLead(1, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-22T12:00:03.000Z' });
  const ledger = [reservation(started, { copyVersion: COPY_VERSION_V4, personalizationMode: 'exact', personalizationRole: 'Millwrights', personalizationSite: 'Mont Belvieu, TX' })];
  assert.equal(renderClientLeadEmail(started, 3, { env: ENV, now: Date.parse('2026-11-06T12:00:00Z'), activities: ledger }).personalization.mode, 'exact');
}));

// ── Holds ────────────────────────────────────────────────────────────────────
test('hold and unclassified leads never render, never queue, and are skipped before any render', () => classified(() => {
  for (const lead of [joleLead(4), joleLead(5)]) { // 4 = hold, 5 = not classified
    assert.throws(() => render(lead, 1), /personalization hold|no Jole personalization mode/);
    assert.ok(clientSelectionHold(lead));
    assert.equal(queueEligibility(lead, { leads: [lead], env: ENV }).ok, false);
    assert.equal(clientPersonalizationState(lead, { env: ENV, now: NOW }).status, 'hold');
  }
  assert.match(joleSelectionHold(joleLead(4)), /travel or non-site/);
  for (const n of [1, 2, 3]) assert.equal(clientSelectionHold(joleLead(n)), '');
  assert.equal(queueEligibility(joleLead(1), { leads: [joleLead(1)], env: ENV }).ok, true);
}));

test('the agent skips held leads in selection and held threads in follow-ups, and pins the mode on every send', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const select = source.slice(source.indexOf('function selectQueued('), source.indexOf('function routedLeadCanUseCurrentSender('));
  assert.match(select, /isClientTemplateId\(l\.emailTemplateId\) && clientSelectionHold\(l\)/);
  const blocked = source.slice(source.indexOf('function coldFollowUpBlockReason('), source.indexOf('function selectQueued('));
  assert.match(blocked, /clientFollowUpHold\(lead\)/);
  assert.match(source, /personalizationMode: attribution\.personalizationMode, personalizationRole: attribution\.personalizationRole/);
  assert.match(source, /withClientCopyVersion\(coldSendAttribution\(lead, nextStepNum\), clientCopyVersion, clientPersonalization\)/);
  assert.match(source, /withClientCopyVersion\(coldSendAttribution\(lead, 1, \{ personalizationMetadata: validatedPersonalizationMetadata \}\), built\.copyVersion, built\.clientPersonalization\)/);
});

// ── Thread consistency ───────────────────────────────────────────────────────
test('a v4 thread keeps the mode, role and site its first send recorded, whatever the classification says later', () => {
  const lead = joleLead(2, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-22T12:00:03.000Z' });
  const ledger = [reservation(lead, { copyVersion: COPY_VERSION_V4, personalizationMode: 'role_only', personalizationRole: 'Millwrights', personalizationSite: '' })];
  setJoleClassificationForTests({ JV42: { mode: 'exact', role: 'Pipefitters', location: 'Baytown, TX' } });
  try {
    for (const step of [2, 3]) {
      const email = render(lead, step, ledger);
      assert.equal(email.copyVersion, COPY_VERSION_V4);
      assert.deepEqual(email.personalization, { mode: 'role_only', role: 'Millwrights', location: null });
      assert.doesNotMatch(email.body, /Pipefitter|Baytown/);
    }
    assert.equal(jolePersonalizationFor(lead, ledger).source, 'ledger');
  } finally { setJoleClassificationForTests(null); }
});

test('contacted v2 threads stay v2; a held one never sends its next touch', () => classified(() => {
  const v2Sent = lead => [{ eventType: 'initial_email_sent', sourceLeadId: lead.id, occurredAt: '2026-10-19T12:00:40.000Z',
    metadata: JSON.stringify({ copyVersion: COPY_VERSION, sequenceStep: 1 }) }];
  const contacted = n => joleLead(n, { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-10-19T12:00:40.000Z' });
  const ok = contacted(8);
  assert.equal(render(ok, 2, v2Sent(ok)).copyVersion, COPY_VERSION);
  const held = contacted(9);
  assert.match(clientFollowUpHold(held), /Jole follow-up hold: .*next touch would repeat that claim/);
  for (const step of [2, 3]) assert.throws(() => render(held, step, v2Sent(held)), /Jole follow-up hold/);
  assert.equal(joleFollowUpHold(ok), '');
  // A v3 thread is unaffected by v4.
  const v3 = contacted(7);
  const v3Ledger = [reservation(v3, { copyVersion: COPY_VERSION_V3 })];
  assert.equal(render(v3, 2, v3Ledger).copyVersion, COPY_VERSION_V3);
}));

// ── The reviewed production classification (2026-10-21) ─────────────────────
test('the classification covers the 902 untouched leads and 50 contacted holds, with only permitted, fresh claims', () => {
  assert.equal(DATA.schema, 'jole_personalization_v4');
  assert.equal(CURRENT_COPY_VERSION, COPY_VERSION_V4);
  const entries = Object.entries(DATA.leads);
  assert.equal(entries.length, 902, '846 Queued + 56 Import untouched leads');
  const count = mode => entries.filter(([, entry]) => entry.mode === mode).length;
  assert.deepEqual({ exact: count('exact'), role_only: count('role_only'), general_craft: count('general_craft'), hold: count('hold') },
    { exact: 463, role_only: 241, general_craft: 131, hold: 67 });
  const firstWindow = Date.parse('2026-10-22T12:00:00.000Z');
  for (const [id, entry] of entries) {
    if (entry.mode === 'exact') {
      assert.ok(entry.role && entry.location && /^[^,]+, [A-Z]{2}$/.test(entry.location), id);
      assert.ok(['site_and_role_verified', 'site_corrected_within_50mi'].includes(entry.evidenceStatus), id);
      // Role and site from the same cited posting: its public page title, or its job-location data.
      assert.ok(['posting_title', 'posting_job_json'].includes(entry.siteSource) && entry.siteCheckedAt, `${id}: site evidence`);
      assert.ok(['posting_title', 'posting_recheck'].includes(entry.roleSource), `${id}: role evidence`);
    }
    if (entry.mode === 'role_only') assert.ok(entry.role && entry.location === null, id);
    if (entry.mode === 'exact' || entry.mode === 'role_only') {
      // A current-hiring claim: independently checked role, evidence at most 30 days old at the first window.
      assert.ok(['phase3_reopen_2026-10-05', 'posting_date'].includes(entry.freshnessSource), `${id}: freshness source`);
      assert.ok(firstWindow - Date.parse(entry.evidenceCheckedAt) <= 30 * 86400000, `${id}: evidence ${entry.evidenceCheckedAt} older than 30 days`);
      assert.ok(['posting_title', 'posting_recheck'].includes(entry.roleSource), `${id}: role evidence`);
    }
    assert.ok(Array.isArray(entry.unsupportedRoles) && Array.isArray(entry.unsupportedLocations), `${id}: what a lower mode must never print`);
    if (entry.mode === 'general_craft' || entry.mode === 'hold') assert.ok(entry.role === null && entry.location === null, id);
    assert.equal(entry.secondaryRole, null, `${id}: no second role was independently verified`);
    assert.ok(entry.evidenceStatus && entry.reason, id);
  }
  // Every Import lead keeps its existing hold.
  assert.equal(entries.filter(([, entry]) => entry.evidenceStatus === 'import_hold' && entry.mode === 'hold').length, 56);
  // Contacted threads: 50 held, none of them re-routed into v4.
  const holds = Object.keys(DATA.followUpHolds);
  assert.equal(holds.length, 50);
  for (const id of holds) assert.equal(DATA.leads[id], undefined, id);
  // No contact details are stored with the classification.
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'integrations', 'clients', 'data', 'jole-personalization-v4.json'), 'utf8'), /@[a-z0-9-]+\.[a-z]/i);
});
