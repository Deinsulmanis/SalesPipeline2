'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { queueEligibility, queueSelectedLeads } = require('../integrations/outreach-queue');
const { STAFFING_CAMPAIGN, renderStaffingEmail, BOLD_PHRASES } = require('../integrations/staffing-campaign');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');
const { buildMultipartAlternative } = require('../integrations/email-alternative');
const { applyLeadChange } = require('../integrations/outreach-state');
const { createPostgrestDouble } = require('../test-support/postgrest-double');

const senders = [
  { id: 'primary', email: 'deins@scalelabai.ca', sendEligible: true, dailyLimit: 40 },
  { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', sendEligible: true, dailyLimit: 40 },
];
const staffing = { id: 'L1', company: 'Example Staffing', email: 'owner@example.com', contactName: 'Alex',
  stage: 'Import', emailStatus: '', emailStep: '', notes: '', lastEmailedAt: '', leadNiche: 'industrial_staffing',
  campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  siteContext: 'Your warehouse staffing team serves local manufacturers.', senderInboxId: 'primary', routingRequired: 'true' };
const dental = { ...staffing, leadNiche: 'dental', campaign: 'Dental pilot', emailTemplateId: 'dental-guarantee-v1', senderInboxId: 'tryscalelabai' };
const sent = id => ({ sourceLeadId: 'L1', eventType: 'initial_email_sent', metadata: JSON.stringify({ senderInboxId: id }) });
const eligibility = (lead, extra = {}) => queueEligibility(lead, { leads: [lead], ...STAFFING_RENDER_OPTIONS, ...extra });

test('new staffing honours chosen scalelabai despite the other inbox having more capacity', () => {
  assert.equal(chooseSender({ lead: staffing, senders, sendsToday: new Map([['primary', 20]]) }).sender.email, senders[0].email);
});
test('new dental honours chosen tryscalelabai despite the other inbox having more capacity', () => {
  assert.equal(chooseSender({ lead: dental, senders, sendsToday: new Map([['tryscalelabai', 20]]) }).sender.email, senders[1].email);
});
for (const [family, lead] of [['staffing', staffing], ['dental', dental]]) {
  for (const id of ['primary', 'tryscalelabai']) {
    test(`${family}: operator can choose ${id} for a new sequence`, () => {
      assert.equal(chooseSender({ lead: { ...lead, senderInboxId: id }, senders }).sender.id, id);
    });
    for (const step of [2, 3]) test(`${family}: step ${step} preserves established ${id}`, () => {
      assert.equal(chooseSender({ lead: { ...lead, senderInboxId: id, emailStatus: 'emailed', emailStep: '1' }, activities: [sent(id)], senders, step }).sender.id, id);
    });
  }
}
test('unavailable selected mailbox fails closed', () => assert.throws(() => chooseSender({ lead: dental, senders: [senders[0], { ...senders[1], sendEligible: false }] }), /not delivery eligible/));
test('unknown selected mailbox fails closed', () => assert.throws(() => chooseSender({ lead: { ...dental, senderInboxId: 'unknown' }, senders }), /not configured/));
test('missing required assignment fails closed', () => assert.throws(() => chooseSender({ lead: { ...dental, senderInboxId: '' }, senders }), /assignment is missing/));
test('unassigned staffing cannot enter legacy round-robin', () => assert.throws(() => chooseSender({ lead: { ...staffing, senderInboxId: '', routingRequired: '' }, senders }), /assignment is missing/));
test('exhausted assigned daily cap cannot fall back', () => assert.equal(chooseSender({ lead: dental, senders, sendsToday: new Map([['tryscalelabai', 40]]) }).sender, null));
test('exhausted assigned window cannot fall back', () => assert.equal(chooseSender({ lead: dental, senders, windowRemainingBySender: new Map([['primary', 5], ['tryscalelabai', 0]]) }).sender, null));
test('assignment alone cannot invent follow-up ownership', () => assert.throws(() => chooseSender({ lead: dental, senders, step: 2 }), /no proven sender/));
test('conflicting established senders fail closed', () => assert.throws(() => chooseSender({ lead: { ...dental, emailStep: '1' }, senders, activities: [sent('primary')], step: 2 }), /conflict/));
test('a conflicting source ID does not supply false sender proof', () => assert.throws(() => chooseSender({ lead: dental, senders, activities: [{ ...sent('primary'), sourceLeadId: 'OTHER', leadId: 'CE-L1' }], step: 2 }), /no proven sender/));

test('normal imported staffing passes preflight', () => assert.equal(eligibility(staffing).ok, true));
for (const stage of ['Hot', 'Closed Won', 'Closed Lost', 'Call Booked', 'Promoted', 'Replied', 'Unsubscribed']) {
  test(`${stage} cannot be queued`, () => assert.equal(eligibility({ ...staffing, stage }).ok, false));
}
test('MANUAL HOLD cannot be queued', () => assert.equal(eligibility({ ...staffing, notes: '[MANUAL HOLD]' }).ok, false));
test('genuine reply in notes cannot be queued', () => assert.equal(eligibility({ ...staffing, notes: '[REPLY: Interested]' }).ok, false));
test('genuine reply in activity cannot be queued', () => assert.equal(eligibility(staffing, { activities: [{ sourceLeadId: 'L1', eventType: 'positive_reply' }] }).ok, false));
test('durable suppression cannot be queued', () => assert.equal(eligibility(staffing, { suppressedEmails: new Set([staffing.email]) }).ok, false));
test('prior successful send cannot re-enroll', () => assert.equal(eligibility(staffing, { activities: [sent('primary')] }).ok, false));
test('unresolved send reservation cannot re-enroll', () => assert.equal(eligibility(staffing, { activities: [{ sourceLeadId: 'L1', eventType: 'ordinary_send_reserved' }] }).ok, false));
test('duplicate normalized emails fail closed', () => assert.equal(eligibility(staffing, { leads: [staffing, { ...staffing, id: 'L2', email: ' OWNER@EXAMPLE.COM ' }] }).ok, false));
test('Pipeline Hot cannot be re-enrolled', () => assert.equal(eligibility(staffing, { boardLeads: [{ id: 'CE-L1', stage: 'Hot', email: staffing.email }] }).ok, false));
test('company name never matches Pipeline ownership', () => assert.equal(eligibility(staffing, { boardLeads: [{ id: 'different', company: staffing.company, stage: 'Hot', email: 'different@example.com' }] }).ok, true));
test('staffing with dental attribution cannot queue', () => assert.equal(eligibility({ ...staffing, intendedCampaignVersion: 'dental_v3_pay_per_booking' }).ok, false));
test('missing approved opening cannot queue', () => assert.equal(eligibility({ ...staffing, siteContext: '' }).ok, false));

test('queue only changes five routing/stage fields and repeated enrollment is a no-op', async () => {
  let lead = { ...staffing };
  const mutations = [], events = [];
  const deps = {
    loadState: async () => ({ leads: [lead], ...STAFFING_RENDER_OPTIONS }), validateSelection: () => ({ ok: true }),
    applyChanges: async changes => changes.map(({ lead: before, patch }) => { mutations.push(patch); lead = { ...before, ...patch }; return { leadId: before.id, status: 'succeeded' }; }),
    appendActivity: async event => events.push(event),
  };
  const request = { ids: ['L1'], senderInboxId: 'primary', emailTemplateId: staffing.emailTemplateId, campaignVersionId: STAFFING_CAMPAIGN.id };
  assert.equal((await queueSelectedLeads(request, deps)).queued, 1);
  const repeated = await queueSelectedLeads(request, deps);
  assert.equal(repeated.queued, 0); assert.equal(repeated.alreadyQueued, 1);
  assert.equal(events.length, 1); assert.equal(mutations.length, 1);
  assert.deepEqual(Object.keys(mutations[0]).sort(), ['stage', 'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'].sort());
  assert.equal(lead.siteContext, staffing.siteContext);
});
test('queue refusal preserves the whole batch before any mutation', async () => {
  let writes = 0;
  const result = await queueSelectedLeads({ ids: ['L1', 'L2'] }, {
    loadState: async () => ({ leads: [staffing, { ...staffing, id: 'L2', email: 'other@example.com', notes: '[MANUAL HOLD]' }] }),
    validateSelection: () => ({ ok: true }), applyChanges: async () => { writes++; return []; }, appendActivity: async () => writes++,
  });
  assert.equal(result.status, 409); assert.equal(writes, 0);
});

test('canonical queue refuses a hold that arrived after preflight but before the first CAS read', async () => {
  const db = createPostgrestDouble({ secret: 'test-secret', rows: [{ lead_id: 'L1', revision: 2, stage: 'Import', notes: '[MANUAL HOLD]' }] });
  const started = await db.start();
  try {
    const env = { ...started, SUPABASE_OUTREACH_WRITES: 'supabase' };
    await assert.rejects(applyLeadChange('L1', { stage: 'Queued' }, {
      env, row: 2, spreadsheetId: 'fake', sheetsClient: { spreadsheets: { values: { batchUpdate: async () => assert.fail('mirror must not run') } } },
      expectedState: { stage: 'Import', notes: '' },
    }), /validated lead state changed/);
  } finally { await db.stop(); }
});

for (const step of [1, 2, 3]) test(`step ${step} MIME preserves exact text and its one approved bold phrase`, () => {
  const email = renderStaffingEmail(staffing, step, STAFFING_RENDER_OPTIONS);
  const mime = buildMultipartAlternative(email.body, email.html);
  const parts = [...mime.body.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(m => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  assert.equal(parts[0], email.body); assert.equal(parts[1], email.html);
  assert.equal((email.html.match(/<strong>/g) || []).length, 1);
  assert.ok(email.html.includes(BOLD_PHRASES[step - 1].replace('{{company}}', staffing.company)));
  assert.ok(!email.body.includes('https://scalelabai.ca/staffing/'));
});
test('server queue uses canonical full rows and expected-state mutations', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8').split('\r\n').join('\n');
  const route = source.slice(source.indexOf("app.post('/api/coldemail/queue'"), source.indexOf('// The Outreach summary.'));
  assert.match(route, /readOutreachCorpus\(\)/); assert.match(route, /expectedState: lead/);
  assert.doesNotMatch(route, /patch: Object\.fromEntries\(CE_COLUMNS/);
});

test('server staffing queue refuses Sheets authority before route validation', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8').split('\r\n').join('\n');
  const start = source.indexOf('validateSelection: lead => {', source.indexOf("app.post('/api/coldemail/queue'"));
  const arrow = source.slice(start + 'validateSelection: '.length, source.indexOf(',\n      applyChanges:', start));
  let routeCalls = 0;
  const make = new Function('outreachStateMode', 'outreachWriteAuthority', 'normalizeNiche', 'validateRoute', 'validateCampaignVersionRoute', 'gmailInboxOptions', 'ROOFING_SURVEY_TEMPLATE', 'qualifyRoofingLead', 'senderInboxId', 'emailTemplateId', 'campaignVersionId', `return (${arrow});`);
  for (const [mode, authority, allowed] of [['dual', 'sheets', false], ['primary', 'sheets', false], ['dual', 'supabase', false], ['primary', 'supabase', true]]) {
    const validate = make(() => mode, () => authority, s => s, () => { routeCalls++; return { ok: true }; }, () => ({ ok: true }), () => [], 'roofing-survey-v1', () => ({ ok: true }), 'primary', staffing.emailTemplateId, STAFFING_CAMPAIGN.id);
    const result = validate(staffing);
    assert.equal(result.ok, allowed);
    if (!allowed) assert.match(result.reason, /requires Supabase/);
  }
  assert.equal(routeCalls, 1);
});

for (const ok of [true, false]) test(`queue confirmation client handles server ${ok ? 'success' : 'refusal'} without inventing success`, async () => {
  const source = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const body = source.slice(source.indexOf('async function confirmQueueRoute()'), source.indexOf('async function setCeLeadStage('));
  const fields = {
    'queue-route-inbox': { value: 'tryscalelabai' },
    'queue-route-version': { value: 'dental_v3_pay_per_booking' },
    'queue-route-template': { value: 'dental-guarantee-v1' },
    'queue-route-error': { textContent: '' },
  };
  const calls = []; let closed = false, refreshed = false;
  const confirm = new Function('document', 'fetch', 'queueRouteIds', 'closeQueueRouteModal', 'ceSelected', 'updateBulkQueueBtn', 'showToast', 'loadCeLeads',
    `${body}; return confirmQueueRoute;`)(
    { getElementById: id => fields[id] },
    async (url, request) => { calls.push({ url, request }); return { ok, json: async () => ok ? { queued: 1 } : { error: 'MANUAL HOLD blocks queueing' } }; },
    ['L1'], () => { closed = true; }, new Set(['L1']), () => {}, () => {}, () => { refreshed = true; },
  );
  await confirm();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/coldemail/queue');
  assert.equal(calls[0].request.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].request.body), { ids: ['L1'], senderInboxId: 'tryscalelabai', campaignVersionId: 'dental_v3_pay_per_booking', emailTemplateId: 'dental-guarantee-v1' });
  assert.equal(closed, ok); assert.equal(refreshed, ok);
  if (!ok) assert.match(fields['queue-route-error'].textContent, /MANUAL HOLD/);
});
