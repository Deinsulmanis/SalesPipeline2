'use strict';

// Jole BTX copy v5 (2026-10-27): the approved three-touch sequence, and the
// rollout that makes it the copy of every Jole touch not yet attempted.
//
// The version is decided per step from the activity ledger
// (clients/jole-copy.js resolveJoleCopyVersion):
//   a SENT step          keeps the version its send recorded (history)
//   a live ATTEMPT       keeps the version its reservation recorded, so the
//                        reservation, delivery re-check and recovery agree
//   every other step     v5, whatever version the thread began on
// The claims a v5 follow-up makes are the ones its thread's Touch 1 made
// (jole-personalization.js). Step, timing, thread and sender come from the
// ledger exactly as before; nothing here writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COPY_VERSION, COPY_VERSION_V3, COPY_VERSION_V4, COPY_VERSION_V5, CURRENT_COPY_VERSION, JOLE_COPY_VERSIONS,
  JOLE_INDUSTRIAL_EMPLOYER_COPY_V5, resolveJoleCopyVersion, renderJoleEmployerStepV5, validateJoleEmployerEmailV5,
} = require('../integrations/clients/jole-copy');
const { jolePersonalizationFor, setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail, validateClientLeadEmail, clientCopyVersionFor, clientSelectionHold } = require('../integrations/clients/client-email');
const { buildLeadProfile, profileFromResearchRow, serializeLeadProfile } = require('../integrations/clients/lead-profile');
const { queueEligibility } = require('../integrations/outreach-queue');
const { nextFollowUp, isFollowUpDue } = require('../integrations/sequence-timing');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { resolveColdFollowUpThread } = require('../integrations/gmail-threading');
const { STAFFING_CAMPAIGN, renderStaffingEmail } = require('../integrations/staffing-campaign');

const ADDRESS = '2738 Dallas Ave, Ingleside, TX 78362';
const ENV = Object.freeze({ JOLE_COMMERCIAL_MAILING_ADDRESS: ADDRESS, JOLE_LANDING_PAGE_URL: 'https://jolebtx.netlify.app/', JOLE_BOOKING_LINK: 'https://calendar.app.google/HfJfGYaL3gEaSg4P8' });
const NOW = Date.parse('2026-10-28T14:00:00.000Z');
const FOOTER = `\n\nJorge Guerrero\nCEO\nJole BTX LLC\n${ADDRESS}\n\nThis is a commercial email. Not relevant? Reply "unsubscribe" and I won't follow up again.`;
const core = body => body.slice(0, body.indexOf('\n\nJorge Guerrero\nCEO\n'));
const DASH = /[‒-―−]|\s-|-\s|--/;

const joleLead = (n, extra = {}) => ({
  id: `JV5${n}`, company: `Gulf Fabrication ${n}, LLC`, contactName: 'Pat Rivera', email: `pat@gulffab5${n}.com`,
  stage: 'Queued', emailStatus: '', emailStep: '', lastEmailedAt: '', notes: '', leadNiche: 'jole_employer',
  emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', routingRequired: 'true', senderInboxId: 'jole_group_jorge', clientId: 'jole', sheetRow: 5000 + n, revision: 1,
  campaign_notes: serializeLeadProfile(buildLeadProfile({ clientId: 'jole', profile: profileFromResearchRow({
    first_name: 'Pat', last_name: 'Rivera', title: 'Plant Manager', buyer_type: 'Plant / operations / production',
    company_domain: `gulffab5${n}.com`, sector: 'Industrial fabrication / machinery', site_tie: 'EXACT', hiring_site: 'Mont Belvieu, TX',
    verified_role: 'Millwright', posting_date: '2026-10-01', hiring_evidence_url: `https://example.org/jobs/${n}`, verified_at: '2026-10-07',
  }) })),
  ...extra,
});
const contacted = (n, step, at = '2026-10-21T12:00:03.000Z', extra = {}) => joleLead(n, {
  stage: 'Contacted', emailStatus: 'emailed', emailStep: String(step), lastEmailedAt: at, ...extra,
});
const CLASSIFIED = {
  JV51: { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX', evidenceCheckedAt: '2026-10-15', unsupportedLocations: ['Mont Belvieu, TX'], unsupportedRoles: ['Millwrights', 'Millwright'], reason: 'fixture' },
  JV52: { mode: 'role_only', role: 'Millwrights', location: null, evidenceCheckedAt: '2026-10-15', unsupportedLocations: ['Mont Belvieu, TX', 'Baytown, TX'], unsupportedRoles: ['Millwrights', 'Millwright'], reason: 'fixture' },
  JV53: { mode: 'general_craft', role: null, location: null, unsupportedLocations: ['Mont Belvieu, TX'], unsupportedRoles: ['Millwrights', 'Millwright'], reason: 'fixture' },
  JV54: { mode: 'hold', role: null, location: null, reason: 'cited role is travel or non-site work' },
  followUpHolds: { JV59: { reason: 'jole_industrial_employer_v2 thread: audit A; its next touch would repeat that claim' } },
};
const classified = fn => { setJoleClassificationForTests(CLASSIFIED); try { return fn(); } finally { setJoleClassificationForTests(null); } };
const render = (lead, step, activities = []) => renderClientLeadEmail(lead, step, { env: ENV, now: NOW, activities });

// Ledger rows exactly as the agent writes them.
const THREAD = 'thread-1';
const sendRow = (lead, step, version, { at, subject = '', mode, role = '', site = '', sender = 'jole_group_jorge' } = {}) => ({
  eventId: `sent:${lead.id}:${step}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: at || `2026-10-${19 + step * 2}T12:00:03.000Z`, subject,
  metadata: JSON.stringify({ leadId: lead.id, step, sequenceStep: step, senderInboxId: sender, gmailMessageId: `m${step}`, gmailThreadId: THREAD,
    ...(version ? { copyVersion: version } : {}), ...(mode ? { personalizationMode: mode, personalizationRole: role, personalizationSite: site } : {}) }),
});
const reservationRow = (lead, step, version, meta = {}, attempt = 1) => ({
  eventId: `cold-reserve:${lead.id}:step${step}:attempt${attempt}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'ordinary_send_reserved', occurredAt: `2026-10-${19 + step * 2}T12:00:00.000Z`, subject: '',
  metadata: JSON.stringify({ leadId: lead.id, step, senderInboxId: 'jole_group_jorge', ...(version ? { copyVersion: version } : {}), ...meta }),
});
const failedRow = (lead, step, attempt = 1) => ({
  eventId: `cold-reserve:${lead.id}:step${step}:attempt${attempt}:failed`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
  eventType: 'ordinary_send_failed', occurredAt: `2026-10-${19 + step * 2}T12:00:01.000Z`,
  metadata: JSON.stringify({ leadId: lead.id, step, reservationEventId: `cold-reserve:${lead.id}:step${step}:attempt${attempt}` }),
});
const v4Exact = { mode: 'exact', role: 'Millwrights', site: 'Mont Belvieu, TX' };
const v4Thread = (lead, sentSteps) => sentSteps.flatMap(step => [
  reservationRow(lead, step, COPY_VERSION_V4, { personalizationMode: 'exact', personalizationRole: 'Millwrights', personalizationSite: 'Mont Belvieu, TX' }),
  sendRow(lead, step, COPY_VERSION_V4, { subject: step === 1 ? 'Millwrights | Mont Belvieu, TX' : '', ...v4Exact }),
]);
const v2Thread = (lead, sentSteps) => sentSteps.flatMap(step => [
  reservationRow(lead, step, step === 1 ? '' : COPY_VERSION),
  sendRow(lead, step, COPY_VERSION, { subject: step === 1 ? 'Millwrights — Mont Belvieu, TX' : '' }),
]);

// ── 10–12. The approved copy, mode by mode ──────────────────────────────────
const APPROVED_T1 = "Hi Pat,\n\nSaw you were hiring Millwrights in Mont Belvieu, TX.\n\nIs that strictly a permanent hire, or would bringing in contract labor help in the meantime?\n\nJole supplies contract skilled tradespeople to industrial sites. If that's an option, I can check whether we could cover the role and how quickly someone could realistically start.\n\nJorge";
const APPROVED_T2 = 'Hi Pat,\n\nWas the Millwrights opening in Mont Belvieu, TX for a specific project, or are you looking to grow your crew long term?\n\nI help industrial sites with both contract crews and permanent skilled trade hires.\n\nIf useful, I can send over the trades I typically help with.\n\nJorge';
const APPROVED_T3 = 'Hi Pat,\n\nQuick question, are you the one who handles bringing in outside tradespeople, or does someone else on your team take care of that?\n\nJorge';

test('1 + 10. an uncontacted exact lead gets v5 Email 1: the approved copy word for word', () => classified(() => {
  const lead = joleLead(1);
  assert.equal(CURRENT_COPY_VERSION, 'jole_industrial_employer_v5');
  assert.deepEqual(resolveJoleCopyVersion(lead, []), { copyVersion: COPY_VERSION_V5, threadCopyVersion: null, step: 1, reason: 'no_outbound_evidence' });
  const t1 = render(lead, 1);
  assert.equal(t1.copyVersion, COPY_VERSION_V5);
  assert.deepEqual(t1.personalization, { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX' });
  assert.equal(t1.subject, 'Millwrights in Mont Belvieu, TX');
  assert.equal(core(t1.body), APPROVED_T1);
  // Touches 2 and 3 of the same thread, as their reservations would pin them.
  const ledger = [sendRow(lead, 1, COPY_VERSION_V5, { subject: t1.subject, ...v4Exact })];
  assert.equal(render(contacted(1, 1), 2, ledger).subject, null, 'follow-ups reply in the original thread');
  assert.equal(core(render(contacted(1, 1), 2, ledger).body), APPROVED_T2);
  assert.equal(core(render(contacted(1, 2), 3, ledger).body), APPROVED_T3);
}));

test('11. role_only: only the location references are dropped; no place anywhere', () => classified(() => {
  const lead = joleLead(2);
  const [t1, t2, t3] = [1, 2, 3].map(step => render(lead, step));
  assert.equal(t1.subject, 'Millwrights');
  assert.equal(core(t1.body), APPROVED_T1.replace(' in Mont Belvieu, TX.', '.'));
  assert.ok(core(t1.body).includes('\n\nSaw you were hiring Millwrights.\n\n'));
  assert.equal(core(t2.body), APPROVED_T2.replace(' in Mont Belvieu, TX', ''));
  assert.equal(core(t3.body), APPROVED_T3);
  for (const email of [t1, t2, t3]) {
    assert.equal(email.personalization.mode, 'role_only');
    assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, /Mont Belvieu|Baytown|, TX\b/);
  }
}));

test('12. general_craft: no hiring claim, no role, no place; the same low-pressure offer in three touches', () => classified(() => {
  const lead = joleLead(3);
  const [t1, t2, t3] = [1, 2, 3].map(step => render(lead, step));
  assert.equal(t1.subject, 'contract tradespeople');
  assert.equal(core(t1.body), "Hi Pat,\n\nWhen a skilled trade position comes up at Gulf Fabrication 3, LLC, is it strictly a permanent hire, or would bringing in contract labor help in the meantime?\n\nJole supplies contract skilled tradespeople to industrial sites. If that's ever an option, I can check whether we could cover it and how quickly someone could realistically start.\n\nJorge");
  assert.equal(core(t2.body), 'Hi Pat,\n\nWhen Gulf Fabrication 3, LLC brings on skilled trades, is it usually for a specific project, or to grow your crew long term?\n\nI help industrial sites with both contract crews and permanent skilled trade hires.\n\nIf useful, I can send over the trades I typically help with.\n\nJorge');
  assert.equal(core(t3.body), APPROVED_T3);
  for (const email of [t1, t2, t3]) {
    assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, /hiring|opening|posting|Millwright|Mont Belvieu|, TX\b/i);
  }
  // The guard refuses a general_craft email that claims an opening or names a role.
  assert.match(validateJoleEmployerEmailV5({ subject: 'x', body: 'Hi Pat,\n\nSaw you were hiring.\n\nJorge' }, 1, { mode: 'general_craft' }), /current opening/);
  assert.match(validateJoleEmployerEmailV5({ subject: 'x', body: 'Hi Pat,\n\nNeed Millwrights?\n\nJorge' }, 1, { mode: 'general_craft', forbiddenRoles: ['Millwrights'] }), /must not name a role/);
}));

test('13. hold and unclassified leads stay blocked under v5', () => classified(() => {
  for (const lead of [joleLead(4), joleLead(5)]) {
    assert.throws(() => render(lead, 1), /personalization hold|no Jole personalization mode/);
    assert.ok(clientSelectionHold(lead));
    assert.equal(queueEligibility(lead, { leads: [lead], env: ENV }).ok, false);
  }
  // A contacted thread on the follow-up hold list never sends its next touch.
  const held = contacted(9, 1);
  for (const step of [2, 3]) assert.throws(() => render(held, step, v2Thread(held, [1])), /Jole follow-up hold/);
}));

test('17. every v5 touch: Jole footer and opt-out line, no link, no dash punctuation, the v4 cadence', () => classified(() => {
  for (const n of [1, 2, 3]) {
    for (const step of [1, 2, 3]) {
      const email = render(joleLead(n), step);
      assert.ok(email.body.endsWith(FOOTER), `${n}/${step} footer`);
      assert.doesNotMatch(email.body, /https?:\/\/|www\.|calendar|booking/i);
      assert.doesNotMatch(`${email.subject || ''}\n${core(email.body)}`, DASH);
      assert.equal(validateClientLeadEmail(joleLead(n), email, step), '');
    }
  }
  assert.deepEqual(JOLE_INDUSTRIAL_EMPLOYER_COPY_V5.steps.map(item => item.sendAfterBusinessDays), [0, 3, 4]);
  assert.match(validateJoleEmployerEmailV5({ subject: null, body: 'Hi\n\nhttps://jolebtx.netlify.app/' }, 2), /no link/);
  // Without Jole's own postal address the copy refuses; it never borrows ScaleLab's.
  assert.throws(() => renderClientLeadEmail(joleLead(1), 1, { env: { COMMERCIAL_MAILING_ADDRESS: 'ScaleLab AI, New Westminster, BC' }, now: NOW }), /mailing address/);
  // An exact render with no verified site never falls back to the stored one.
  assert.throws(() => renderJoleEmployerStepV5({ step: 1, firstName: 'Pat', company: 'Acme', mailingAddress: ADDRESS, personalization: { mode: 'exact', role: 'Welders' } }), /location is missing/);
}));

// ── 2–4. Migrating open threads, step by step ────────────────────────────────
test('2. a v4 lead with Email 1 sent gets v5 Email 2 only; its Email 1 stays v4', () => {
  const lead = contacted(6, 1);
  const ledger = v4Thread(lead, [1]);
  assert.deepEqual(resolveJoleCopyVersion(lead, ledger), { copyVersion: COPY_VERSION_V5, threadCopyVersion: COPY_VERSION_V4, step: 2, reason: 'v5_rollout_next_unsent_step' });
  const t2 = render(lead, 2, ledger);
  assert.equal(t2.copyVersion, COPY_VERSION_V5);
  assert.equal(t2.threadCopyVersion, COPY_VERSION_V4);
  assert.equal(core(t2.body), APPROVED_T2);
  const t1 = render(lead, 1, ledger);
  assert.equal(t1.copyVersion, COPY_VERSION_V4);
  assert.equal(t1.subject, 'Millwrights | Mont Belvieu, TX', 'the delivered v4 Email 1 is unchanged');
});

test('3. a v4 lead with Emails 1 and 2 sent gets v5 Email 3 only; nothing after Email 3', () => {
  const lead = contacted(7, 2);
  const ledger = v4Thread(lead, [1, 2]);
  const t3 = render(lead, 3, ledger);
  assert.equal(t3.copyVersion, COPY_VERSION_V5);
  assert.equal(core(t3.body), APPROVED_T3);
  for (const step of [1, 2]) assert.equal(render(lead, step, ledger).copyVersion, COPY_VERSION_V4);
  const done = contacted(8, 3, '2026-10-28T12:00:03.000Z', { emailStatus: 'done', stage: 'Done' });
  const doneLedger = [...v4Thread(done, [1, 2]), sendRow(done, 3, COPY_VERSION_V5, v4Exact)];
  assert.equal(nextFollowUp(done, { activities: doneLedger }), null, 'all three sent: no further step exists');
  assert.equal(isFollowUpDue(done, Date.parse('2026-12-01T15:00:00Z'), { activities: doneLedger }), false);
  assert.throws(() => render(done, 4, doneLedger), /invalid Jole step/);
});

test('4. v2 and v3 threads migrate without losing history: the claim of their Touch 1, nothing new', () => {
  const v2 = contacted(10, 2);
  const v2Ledger = v2Thread(v2, [1, 2]);
  const t3 = render(v2, 3, v2Ledger);
  assert.equal(t3.copyVersion, COPY_VERSION_V5);
  assert.equal(t3.threadCopyVersion, COPY_VERSION);
  assert.equal(render(v2, 1, v2Ledger).subject, 'Millwrights — Mont Belvieu, TX');
  assert.match(render(v2, 2, v2Ledger).body, /Worth 10 minutes to see if Jole can realistically cover it\?/, 'its sent v2 Email 2 reconstructs');
  const at2 = contacted(11, 1);
  const t2 = render(at2, 2, v2Thread(at2, [1]));
  assert.deepEqual(t2.personalization, { mode: 'exact', role: 'Millwrights', location: 'Mont Belvieu, TX' });
  assert.equal(core(t2.body), APPROVED_T2);
  assert.equal(jolePersonalizationFor(at2, v2Thread(at2, [1])).source, 'thread_origin');
  // After its v5 Email 2 is sent, Email 3 pins the claim from that v5 send.
  const after = [...v2Thread(at2, [1]), sendRow(at2, 2, COPY_VERSION_V5, v4Exact)];
  assert.equal(jolePersonalizationFor(contacted(11, 2), after).source, 'ledger');
  // v3 the same way.
  const v3 = contacted(12, 1);
  const v3Ledger = [reservationRow(v3, 1, COPY_VERSION_V3), sendRow(v3, 1, COPY_VERSION_V3, { subject: 'Millwrights | Mont Belvieu, TX' })];
  assert.equal(core(render(v3, 2, v3Ledger).body), APPROVED_T2);
  // A thread whose Touch 1 subject does not prove the claim is held, never guessed.
  const unproven = contacted(13, 1);
  assert.throws(() => render(unproven, 2, [sendRow(unproven, 1, COPY_VERSION, { subject: 'Welders — Baytown, TX' })]), /personalization hold: .*does not prove/);
});

// ── 5–6. Thread and sender continuity ───────────────────────────────────────
test('5–6. a migrated follow-up uses the original Gmail thread and the inbox that sent Email 1', async () => {
  const lead = contacted(14, 1);
  const ledger = v4Thread(lead, [1]);
  const gmail = { users: { messages: { get: async ({ id }) => ({ data: { threadId: THREAD, payload: { headers: [
    { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }, { name: 'To', value: lead.email }, { name: 'References', value: '' },
  ] } } }) } } };
  const thread = await resolveColdFollowUpThread({ gmail, lead, activities: ledger, expectedSenderId: 'jole_group_jorge' });
  assert.equal(thread.threadId, THREAD);
  assert.equal(thread.subject, 'Re: Millwrights | Mont Belvieu, TX', 'the v4 thread subject, not a v5 subject');
  // The v5 render has no subject of its own: the agent sends thread.subject.
  assert.equal(render(lead, 2, ledger).subject, null);
  // Sender ownership comes from the delivered Email 1, whatever the lead row now says.
  const senders = ['jole_group_jorge', 'jole_team_jorge'].map(id => ({ id, dailyLimit: 20, status: 'active', sendEligible: true, clientId: 'jole', allowedCampaignIds: ['jole-btx-employer-acquisition'] }));
  const moved = { ...lead, senderInboxId: 'jole_team_jorge' };
  assert.throws(() => chooseSender({ lead: moved, activities: ledger, senders, step: 2 }), /sender ownership conflict/);
  const choice = chooseSender({ lead, activities: ledger, senders, step: 2 });
  assert.equal(choice.sender?.id, 'jole_group_jorge', choice.reason);
  assert.equal(choice.pinned, true);
  // Copy resolution writes nothing to the lead.
  const before = JSON.stringify(lead);
  render(lead, 2, ledger);
  assert.equal(JSON.stringify(lead), before);
  // The follow-up path still proves the thread and uses its subject.
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(source, /thread = await resolveColdFollowUpThread\(\{ gmail: gmailForSender\(selectedSender\), lead, activities: ownershipActivities, expectedSenderId: selectedSender\.id \}\)/);
  assert.match(source, /const subject = thread\.subject;/);
});

// ── 7–9. No duplicates, no early sends ──────────────────────────────────────
test('7. no duplicate first touch: a contacted lead never resolves to a fresh v5 Email 1', () => classified(() => {
  const lead = contacted(1, 1);
  const ledger = v4Thread(lead, [1]);
  assert.equal(resolveJoleCopyVersion(lead, ledger, { step: 1 }).copyVersion, COPY_VERSION_V4);
  assert.equal(queueEligibility(lead, { leads: [lead], activities: ledger, env: ENV }).ok, false);
  // A Queued row with only a pending reservation is refused too.
  const pending = joleLead(1);
  assert.equal(queueEligibility(pending, { leads: [pending], activities: [reservationRow(pending, 1, COPY_VERSION_V4)], env: ENV }).ok, false);
}));

test('8–9. a sent step is never due again, and v5 keeps the existing due dates', () => {
  const t1At = '2026-10-21T12:00:03.000Z';
  const lead = contacted(15, 1, t1At);
  for (const ledger of [v4Thread(lead, [1]), v2Thread(lead, [1])]) {
    const next = nextFollowUp(lead, { activities: ledger });
    assert.equal(next.nextStep, 2);
    assert.equal(next.dueAtIso, '2026-10-24T12:00:03.000Z', 'Touch 1 + 3 days, unchanged');
  }
  // Touch 2 already in the ledger (row not yet advanced): not due, so never repeated.
  const sent2 = [...v4Thread(lead, [1]), sendRow(lead, 2, COPY_VERSION_V5, { at: '2026-10-26T12:00:00.000Z', ...v4Exact })];
  assert.equal(isFollowUpDue(lead, Date.parse('2026-11-30T15:00:00Z'), { activities: sent2 }), false);
  // Touch 3 timing: MAX(T1 + 7 days, T2 + 3 days), from the sends, whatever their copy.
  const at2 = contacted(15, 2, '2026-10-26T12:00:00.000Z');
  assert.equal(nextFollowUp(at2, { activities: sent2 }).dueAtIso, '2026-10-29T12:00:00.000Z');
  assert.equal(isFollowUpDue(at2, Date.parse('2026-10-29T11:59:00Z'), { activities: sent2 }), false, 'never earlier than its original date');
});

// ── 14–15, 18. History, retirement and reservation agreement ────────────────
test('14. sent v4 content reconstructs exactly from its ledger metadata', () => {
  const lead = contacted(16, 2);
  const ledger = v4Thread(lead, [1, 2]);
  assert.equal(core(render(lead, 1, ledger).body), 'Hi Pat,\n\nSaw Gulf Fabrication 16, LLC is hiring Millwrights in Mont Belvieu, TX.\n\nI can have our team check whether Jole has the right craft coverage for that site and what it would realistically take to fill the gap.\n\nWant me to check?\n\nJorge');
  assert.match(render(lead, 2, ledger).body, /Here's a quick overview of Jole:\nhttps:\/\/jolebtx\.netlify\.app\//);
  for (const version of [COPY_VERSION, COPY_VERSION_V3, COPY_VERSION_V4, COPY_VERSION_V5]) assert.ok(JOLE_COPY_VERSIONS[version], version);
});

test('15. no new v4 (or v2/v3) send: every step not yet attempted resolves to v5', () => {
  const histories = { none: () => [], v2: lead => v2Thread(lead, [1]), v4: lead => v4Thread(lead, [1]),
    v3: lead => [sendRow(lead, 1, COPY_VERSION_V3, { subject: 'Millwrights | Mont Belvieu, TX' })] };
  for (const [name, history] of Object.entries(histories)) {
    const lead = name === 'none' ? joleLead(17) : contacted(17, 1);
    for (const step of name === 'none' ? [1] : [2, 3]) {
      assert.equal(resolveJoleCopyVersion(lead, history(lead), { step }).copyVersion, COPY_VERSION_V5, `${name} step ${step}`);
    }
  }
  // Only a sent step or a live attempt resolves to anything older.
  const reasons = new Set(['step_sent_recorded_version', 'step_attempt_recorded_version']);
  const lead = contacted(18, 1);
  for (const row of v4Thread(lead, [1])) {
    const resolved = resolveJoleCopyVersion(lead, [row], { step: 1 });
    assert.ok(reasons.has(resolved.reason), resolved.reason);
  }
});

test('18. reservation, delivery re-check and recovery agree on the copy version of the pending step', () => {
  const lead = contacted(19, 1);
  const ledger = v4Thread(lead, [1]);
  // The agent renders Email 2 (v5), reserves it recording v5, then re-renders before delivery.
  const rendered = render(lead, 2, ledger);
  const reservation = reservationRow(lead, 2, rendered.copyVersion, {
    threadCopyVersion: rendered.threadCopyVersion, personalizationMode: rendered.personalization.mode,
    personalizationRole: rendered.personalization.role, personalizationSite: rendered.personalization.location,
  });
  const recheck = render(lead, 2, [...ledger, reservation]);
  assert.equal(recheck.body, rendered.body);
  assert.equal(validateClientLeadEmail(lead, recheck, 2), '');
  // An attempt reserved BEFORE v5 (recorded v4) whose outcome is unresolved stays v4,
  // so a provider recovery records exactly what may have been delivered.
  const preV5 = reservationRow(lead, 2, COPY_VERSION_V4, { personalizationMode: 'exact', personalizationRole: 'Millwrights', personalizationSite: 'Mont Belvieu, TX' });
  assert.equal(render(lead, 2, [...ledger, preV5]).copyVersion, COPY_VERSION_V4);
  assert.equal(clientCopyVersionFor(lead, { activities: [...ledger, preV5], step: 2 }).reason, 'step_attempt_recorded_version');
  // Once its failure (nothing delivered) is recorded, the retry is v5.
  assert.equal(render(lead, 2, [...ledger, preV5, failedRow(lead, 2)]).copyVersion, COPY_VERSION_V5);
  // The agent records the version, the thread's origin and the claims on reservation and send.
  const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(source, /attribution\?\.threadCopyVersion \? \{ threadCopyVersion: attribution\.threadCopyVersion \} : \{\}/);
  assert.match(source, /clientCopyAudit = \{ threadCopyVersion: email\.threadCopyVersion, copyVersionReason: email\.copyVersionReason \}/);
});

// ── 16. ScaleLab ────────────────────────────────────────────────────────────
test('16. ScaleLab copy and routing never reach the Jole renderer', () => {
  const scalelab = { id: 'SL5', company: 'Acme Staffing', contactName: 'Sam Lee', email: 'sam@acmestaffing.com', stage: 'Queued',
    leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id, campaign: STAFFING_CAMPAIGN.id, clientId: '' };
  assert.throws(() => renderClientLeadEmail(scalelab, 1, { env: ENV, now: NOW }), /no client renderer/);
  assert.equal(typeof renderStaffingEmail, 'function');
  for (const version of Object.keys(JOLE_COPY_VERSIONS)) assert.match(version, /^jole_industrial_employer_v\d$/);
  const jole = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'clients', 'jole-copy.js'), 'utf8');
  assert.doesNotMatch(jole, /require\(['"]\.\.\/staffing-campaign['"]\)/);
});
