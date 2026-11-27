'use strict';

// Franchise locations in the ScaleLab ICP (owner decision 2026-11-25):
// identity by brand + owner / territory, the v2 city line, the per-domain send
// throttle and batch interleaving.

const test = require('node:test');
const assert = require('node:assert/strict');

const franchise = require('../integrations/staffing-franchise');
const copy = require('../integrations/staffing-v4-copy');
const profileLib = require('../integrations/staffing-v4-profile');
const { evaluateCampaign3Import, IMPORT_SCHEMA } = require('../integrations/staffing-campaign-3-import');

const AS_OF = '2026-11-20';
const evidence = (extra = {}) => ({
  asOf: AS_OF, firstName: 'Dana', company: 'Express Employment Professionals', contactName: 'Dana Smith',
  contactStatus: 'READY_FOR_REVIEW', emailResolved: true, attributionP: 0.99,
  employerAds: [], salesHiring: [], expansion: [], leadership: [], candidateAds: [], specialization: null, ...extra,
});
const posting = (extra = {}) => ({ url: 'https://www.expresspros.com/us-ohio-canton/job-seekers/job-openings/job-detail?jobId=1',
  quote: 'Welder | Canton, OH', role: 'Welder', location: 'Canton, OH', current: true, lastSeen: '2026-11-18', source: 'job_posting', ...extra });
const specialtyLine = { url: 'https://www.expresspros.com/us-ohio-canton', quote: 'We place welders and machine operators for manufacturers.', line: 'welders and machine operators for manufacturers' };
const identity = (extra = {}) => ({ brand: 'express', owner_key: 'express|dana|smith', territory: 'express|canton|oh', city: 'Canton', ...extra });
const record = (rowExtra = {}, ev = {}) => ({
  row: { company_name: 'Express Employment Professionals', company_domain: 'expresspros.com', email: 'dana.smith@expresspros.com',
    v4_tag: 'V4|PASS|LOW_SIGNAL|NO_ADS_OBSERVED|COPY_TIER_PENDING', demand_score: '0', signal_priority: 'LOW_SIGNAL',
    ad_class: 'NO_ADS_OBSERVED', contact_status: 'READY_FOR_REVIEW', franchise: identity(), ...rowExtra },
  evidence: evidence({ candidateAds: [posting()], ...ev }),
});
const payload = (records, extra = {}) => ({ schema: IMPORT_SCHEMA, sourcing_run_id: 'franchise-test', records,
  owner_approved_send_ready: true, owner_approved_franchise: true, ...extra });
let n = 0;
const ids = { newId: () => `f${++n}`, now: () => '2026-11-20T07:00:00.000Z' };
const codes = result => result.refusals.map(r => r.code);

test('F1. a franchise owner on a shared domain imports with the identity sealed in the profile', () => {
  const result = evaluateCampaign3Import(payload([record()]), {}, ids);
  assert.deepEqual(codes(result), []);
  assert.equal(result.accepted.length, 1);
  const lead = result.accepted[0].lead;
  assert.equal(lead.city, 'Canton');
  const sealed = profileLib.readStaffingV4Profile(lead);
  assert.equal(sealed.ok, true, sealed.detail);
  assert.equal(sealed.profile.franchise_brand, 'express');
  assert.equal(sealed.profile.franchise_owner_key, 'express|dana|smith');
  assert.equal(sealed.profile.franchise_territory, 'express|canton|oh');
  assert.equal(result.accepted[0].variant, 'COPY_B');
});

test('F2. a shared franchise domain is never deduped as one company', () => {
  const prior = { id: 'p1', email: 'other.owner@expresspros.com', website: 'https://expresspros.com', contactName: 'Pat Jones',
    stage: 'Contacted', campaign: 'Industrial Campaign 3', clientId: 'scalelab' };
  const result = evaluateCampaign3Import(payload([record()]), { leads: [prior] }, ids);
  assert.deepEqual(codes(result), []);
  // two different owners of different offices in one batch are both fine
  const two = evaluateCampaign3Import(payload([record(), record({ email: 'lee.ray@expresspros.com',
    franchise: identity({ owner_key: 'express|lee|ray', territory: 'express|akron|oh', city: 'Akron' }) })]), {}, ids);
  assert.equal(two.accepted.length, 2);
});

test('F3. the same owner, or a second owner of the same office, is refused', () => {
  const prior = { id: 'p1', email: 'dsmith@expresspros.com', website: 'https://expresspros.com', contactName: 'Dana Smith', stage: 'Done', clientId: 'scalelab' };
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record()]), { leads: [prior] }, ids)), ['duplicate_franchise']);
  const sameOffice = record({ email: 'lee.ray@expresspros.com', franchise: identity({ owner_key: 'express|lee|ray' }) });
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record(), sameOffice]), {}, ids)), ['duplicate_in_batch', 'duplicate_in_batch']);
  const sameOwnerTwoOffices = record({ email: 'dana@expresspros.com', franchise: identity({ territory: 'express|akron|oh', city: 'Akron' }) });
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record(), sameOwnerTwoOffices]), {}, ids)), ['duplicate_in_batch', 'duplicate_in_batch']);
});

test('F4. a franchise record needs the owner flag and a complete identity', () => {
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record()], { owner_approved_franchise: false }), {}, ids)), ['franchise_not_approved']);
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record({ franchise: undefined })]), {}, ids)), ['franchise_identity_missing']);
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record({ franchise: identity({ brand: 'pridestaff' }) })]), {}, ids)), ['franchise_identity_missing']);
  assert.deepEqual(codes(evaluateCampaign3Import(payload([record({ franchise: identity({ owner_key: 'express|dana' }) })]), {}, ids)), ['franchise_identity_missing']);
});

test('F5. non-franchise imports are unchanged: domain dedupe still applies', () => {
  const rec = record({ company_name: 'Tradeco Staffing', company_domain: 'tradecostaffing.com', email: 'dana@tradecostaffing.com', franchise: undefined },
    { company: 'Tradeco Staffing' });
  const prior = { id: 'p1', email: 'owner@tradecostaffing.com', website: 'https://tradecostaffing.com', stage: 'Done', clientId: 'scalelab' };
  assert.deepEqual(codes(evaluateCampaign3Import(payload([rec]), { leads: [prior] }, ids)), ['duplicate_company']);
  const ok = evaluateCampaign3Import(payload([rec]), {}, ids);
  assert.equal(ok.accepted.length, 1);
  const sealed = profileLib.readStaffingV4Profile(ok.accepted[0].lead);
  assert.equal(sealed.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sealed.profile, 'franchise_brand'), false, 'no franchise fields on an ordinary profile');
});

test('F6. the v2 city line: "Saw your <city> office places ..." and never the brand-name fallback', () => {
  const sel = copy.selectV4Variant(evidence({ specialtyLine, franchise: { city: 'Canton' } }), { copyVersion: 'v2' });
  assert.equal(sel.status, 'SELECTED');
  assert.equal(sel.variant, 'COPY_C');
  assert.equal(sel.vars.franchise_city, 'Canton');
  const render = vars => copy.renderV4Copy({ variant: 'COPY_C', step: 1, vars, copyVersion: 'v2', appendFooter: text => text });
  const body = JSON.stringify(render(sel.vars));
  assert.match(body, /Saw your Canton office places welders and machine operators for manufacturers\./);
  const fallbackOnly = copy.selectV4Variant(evidence({ specialization: { phrase: 'industrial', url: 'https://x.example', quote: 'industrial staffing' }, franchise: { city: 'Canton' } }), { copyVersion: 'v2' });
  assert.equal(fallbackOnly.status, 'HOLD');
  // the ordinary (non-franchise) primary line is unchanged
  const plain = copy.selectV4Variant(evidence({ specialtyLine }), { copyVersion: 'v2' });
  assert.match(JSON.stringify(render(plain.vars)), /Saw you place welders and machine operators for manufacturers\./);
  assert.throws(() => copy.selectV4Variant(evidence({ franchise: { city: 'Canton' } }), { copyVersion: 'v1' }), /needs copy v2/);
  assert.equal(copy.variableProblem('franchise_city', 'canton ohio'), 'franchise_city is not a plain city name');
  assert.equal(copy.variableProblem('franchise_city', 'Fort Wayne'), null);
});

test('F7. a franchise profile round-trips; tampering with its identity breaks the digest', () => {
  const result = evaluateCampaign3Import(payload([record({}, { candidateAds: [], specialtyLine })]), {}, ids);
  assert.equal(result.accepted.length, 1, JSON.stringify(result.refusals));
  const lead = result.accepted[0].lead;
  const sealed = profileLib.readStaffingV4Profile(lead);
  assert.equal(sealed.vars.franchise_city, 'Canton');
  const tampered = JSON.parse(lead.campaign_notes);
  tampered.franchise_owner_key = 'express|someone|else';
  assert.equal(profileLib.readStaffingV4Profile({ campaign_notes: JSON.stringify(tampered) }).ok, false);
});

test('F8. throttle: at most 10 sends per shared franchise domain per day, reserved before the attempt', () => {
  const throttle = franchise.createFranchiseDomainThrottle({ sendsToday: new Map([['expresspros.com', 8]]) });
  const a = throttle.reserve('a@expresspros.com');
  const b = throttle.reserve('b@expresspros.com');
  assert.equal(a.ok && b.ok, true);
  const c = throttle.reserve('c@expresspros.com');
  assert.equal(c.ok, false);
  assert.match(c.reason, /reached 10 sends today/);
  b.release();
  assert.equal(throttle.reserve('d@expresspros.com').ok, true, 'a released slot is reusable');
  assert.equal(throttle.reserve('x@pridestaff.com').ok, true, 'domains are counted separately');
  for (let i = 0; i < 50; i++) assert.equal(throttle.reserve(`o${i}@tradeco.com`).ok, true, 'ordinary domains are never throttled');
});

test('F9. throttle seed counts today\'s successful sends to franchise recipients only', () => {
  const day = '2026-11-20';
  const rows = [
    { eventId: 'e1', leadId: 'l1', eventType: 'initial_email_sent', occurredAt: '2026-11-20T16:00:00Z' },
    { eventId: 'e1', leadId: 'l1', eventType: 'initial_email_sent', occurredAt: '2026-11-20T16:00:00Z' },
    { eventId: 'e2', leadId: 'l2', eventType: 'follow_up_sent', occurredAt: '2026-11-20T17:00:00Z' },
    { eventId: 'e3', leadId: 'l3', eventType: 'initial_email_sent', occurredAt: '2026-11-20T17:00:00Z' },
    { eventId: 'e4', leadId: 'l1', eventType: 'send_failed', occurredAt: '2026-11-20T17:00:00Z' },
    { eventId: 'e5', leadId: 'l1', eventType: 'initial_email_sent', occurredAt: '2026-11-19T17:00:00Z' },
  ];
  const emails = { l1: 'a@expresspros.com', l2: 'b@expresspros.com', l3: 'c@tradeco.com' };
  const counts = franchise.franchiseDomainSendsToday(rows, day, id => emails[id]);
  assert.deepEqual([...counts], [['expresspros.com', 2]]);
});

test('F10. interleave spreads franchise leads through the batch and keeps everyone', () => {
  const batch = [...Array(6)].map((_, i) => ({ email: `f${i}@expresspros.com` })).concat([...Array(12)].map((_, i) => ({ email: `o${i}@tradeco${i}.com` })));
  const out = franchise.interleaveFranchiseLeads(batch);
  assert.equal(out.length, batch.length);
  assert.deepEqual(new Set(out), new Set(batch));
  for (let i = 1; i < out.length; i++) {
    assert.ok(!(franchise.franchiseDomainOfEmail(out[i].email) && franchise.franchiseDomainOfEmail(out[i - 1].email)), `no two franchise leads adjacent at ${i}`);
  }
  assert.deepEqual(out.filter(l => l.email.startsWith('o')).map(l => l.email), batch.filter(l => l.email.startsWith('o')).map(l => l.email));
  const onlyOthers = [{ email: 'a@x.com' }, { email: 'b@y.com' }];
  assert.deepEqual(franchise.interleaveFranchiseLeads(onlyOthers), onlyOthers);
});

test('F11. every ordinary cold step takes a franchise slot before any probe or reservation; step 1 is interleaved', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const start = src.indexOf('async function deliverOrdinaryColdStep(');
  const deliver = src.slice(start, src.indexOf('\n}\n', start));
  const at = needle => { const i = deliver.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at('clientSendWindowVerdict(') < at('franchiseSendSlot(lead)'));
  for (const later of ['findSuccessfulSequenceSend(', 'stepOneAlreadySent(', 'guardProviderSend(', 'recordColdCallActivityStrict(reservation)', 'sendEmail({']) {
    assert.ok(at('franchiseSendSlot(lead)') < at(later), later);
  }
  assert.match(src, /function franchiseSendSlot\(lead\) \{[\s\S]*?if \(!activeFranchiseThrottle\) return \{ ok: false/, 'fails closed without a throttle');
  assert.match(src, /activeFranchiseThrottle = createFranchiseDomainThrottle\(\{\s*sendsToday: franchiseDomainSendsToday\(ownershipActivities, senderDayKey/);
  // The Campaign 3 / Campaign 4 split interleave (2026-11-27) runs first; the franchise interleave still covers every step-1 lead.
  assert.match(src, /for \(const lead of interleaveFranchiseLeads\(interleaveCampaign4Leads\(newBatch, campaign4Email1Fraction\(activeCampaignSplit\.plan\), isCampaign4Marked\)\)\) \{/);
  assert.equal(franchise.FRANCHISE_DOMAIN_DAILY_CAP, 10);
});

test('F12. franchise copy (owner 2026-11-25): "your <city> office" subject and closing, never the brand', () => {
  const render = vars => copy.renderV4Copy({ variant: sel.variant, step: 1, vars, copyVersion: 'v2', appendFooter: text => `${text}\n\nfooter` });
  // employer ads present: a franchise location still gets only the office copy (COPY_B here)
  const employerAd = { url: 'https://ads.example/a1', text: 'Need staff?', current: true, employerFacingP: 0.95, lastSeen: '2026-11-16' };
  const sel = copy.selectV4Variant(evidence({ candidateAds: [posting()], employerAds: [employerAd], franchise: { city: 'Canton' } }), { copyVersion: 'v2' });
  assert.equal(sel.status, 'SELECTED');
  assert.equal(sel.variant, 'COPY_B');
  assert.ok(sel.considered.some(item => item.variant === 'COPY_A' && item.outcome === 'not used'));
  const email = render(sel.vars);
  const text = JSON.stringify(email);
  assert.equal(email.subject, 'Employer accounts for your Canton office');
  assert.match(text, /Worth a look for your Canton office\?/);
  assert.doesNotMatch(text, /Express Employment Professionals/, 'the franchise brand never appears');
  assert.equal(copy.v4CopyProblem({ body: email.text || email.body, subject: email.subject, copyVersion: 'v2' }, 1), null);
  // the COPY_C city line uses the same subject and closing
  const c = copy.selectV4Variant(evidence({ specialtyLine, franchise: { city: 'Canton' } }), { copyVersion: 'v2' });
  const cEmail = copy.renderV4Copy({ variant: 'COPY_C', step: 1, vars: c.vars, copyVersion: 'v2', appendFooter: t => t });
  assert.equal(cEmail.subject, 'Employer accounts for your Canton office');
  assert.match(JSON.stringify(cEmail), /Worth a look for your Canton office\?/);
  assert.doesNotMatch(JSON.stringify(cEmail), /Express Employment Professionals/);
  // ordinary leads keep their company subject and closing
  const plain = copy.selectV4Variant(evidence({ candidateAds: [posting()], company: 'Tradeco Staffing' }), { copyVersion: 'v2' });
  const plainEmail = copy.renderV4Copy({ variant: 'COPY_B', step: 1, vars: plain.vars, copyVersion: 'v2', appendFooter: t => t });
  assert.equal(plainEmail.subject, 'Employer accounts for Tradeco Staffing');
  // a dash or a non-city value in franchise_city is refused by the validator
  assert.throws(() => render({ ...sel.vars, franchise_city: 'Canton – East' }), /franchise_city/);
  // a franchise profile cannot render a brand-merging variant
  assert.throws(() => copy.renderV4Copy({ variant: 'COPY_A', step: 1, vars: { ...sel.vars, company: 'Express Employment Professionals' }, copyVersion: 'v2', appendFooter: t => t }), /only its office copy/);
});
