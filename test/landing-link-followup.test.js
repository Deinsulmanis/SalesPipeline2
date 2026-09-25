'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { STAFFING_CAMPAIGN, STAFFING_LANDING_PAGE_URL, renderStaffingEmail } = require('../integrations/staffing-campaign');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { landingLinkMetadata, landingTokenHash } = require('../integrations/landing-link-token');
const {
  staffingColdStepLandingPlan, buildIssuanceRecord, ensureLandingIssuance, recordLandingLinkSent, providerIds,
} = require('../integrations/landing-link-issuance');
const { callRpc } = require('../integrations/landing-attribution-store');
const { STAFFING_RENDER_OPTIONS } = require('../test-support/staffing-mail');

const KEY_1 = crypto.createHash('sha256').update('followup key 1').digest('base64');
const KEY_2 = crypto.createHash('sha256').update('followup key 2').digest('base64');
const ON = { LANDING_LINK_TRACKING_ENABLED: 'true', LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '1' };
const ROTATED = { ...ON, LANDING_LINK_TOKEN_KEYS: JSON.stringify({ 1: KEY_1, 2: KEY_2 }), LANDING_LINK_TOKEN_ACTIVE_VERSION: '2' };
const lead = {
  id: 'mtwgLead0001', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing', contactName: 'Alex Harbour', firstName: 'Alex',
  leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, campaign: STAFFING_CAMPAIGN.name,
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, siteContext: 'Your team places CDL drivers.',
};
const silent = { warn() {}, error() {}, log() {} };
const render = plan => renderStaffingEmail(lead, 2, { ...STAFFING_RENDER_OPTIONS, ...(plan?.tracked ? { landingPageUrl: plan.url } : {}) }).body;
// The reservation row deliverOrdinaryColdStep writes before a tracked send.
const reservationRow = (plan, attempt = 1) => ({
  eventId: `cold-reserve:${lead.id}:step2:attempt${attempt}`, eventType: 'ordinary_send_reserved', sourceLeadId: lead.id,
  metadata: JSON.stringify({ leadId: lead.id, step: 2, senderInboxId: 'primary', ...(landingLinkMetadata(plan) ? { landingLink: landingLinkMetadata(plan) } : {}) }),
});

test('Follow-up #2 plan applies to staffing step 2 only', () => {
  assert.equal(staffingColdStepLandingPlan({ lead, step: 1, env: ON }), null);
  assert.equal(staffingColdStepLandingPlan({ lead, step: 3, env: ON }), null);
  assert.equal(staffingColdStepLandingPlan({ lead: { ...lead, emailTemplateId: 'dental-v1' }, step: 2, env: ON }), null);
  assert.equal(staffingColdStepLandingPlan({ lead, step: 2, env: {} }).tracked, false);
  const tracked = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.issuanceKey, `${ordinaryColdActionId(lead.id, 2)}|staffing_landing`);
});

test('tracking off: the Follow-up #2 body is exactly the current production body', () => {
  const plan = staffingColdStepLandingPlan({ lead, step: 2, env: {} });
  assert.equal(render(plan), renderStaffingEmail(lead, 2, STAFFING_RENDER_OPTIONS).body);
  assert.ok(render(plan).includes(`\n${STAFFING_LANDING_PAGE_URL}\n`));
});

test('retry after key rotation renders the byte-identical body the first attempt reserved', () => {
  const first = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  const firstBody = render(first);
  const retry = staffingColdStepLandingPlan({ lead, step: 2, env: ROTATED, activities: [reservationRow(first)] });
  assert.equal(render(retry), firstBody);
  // Recovery after a Gmail send whose checkpoint failed sees the same pin.
  const sendRow = { eventType: 'follow_up_sent', sourceLeadId: lead.id, metadata: JSON.stringify({ step: 2, landingLink: landingLinkMetadata(first) }) };
  assert.equal(render(staffingColdStepLandingPlan({ lead, step: 2, env: ROTATED, activities: [reservationRow(first), sendRow] })), firstBody);
});

test('an untracked first attempt stays untracked on retry after tracking is switched on', () => {
  const untracked = staffingColdStepLandingPlan({ lead, step: 2, env: {} });
  const retry = staffingColdStepLandingPlan({ lead, step: 2, env: ON, activities: [reservationRow(untracked)] });
  assert.equal(retry.tracked, false);
  assert.equal(render(retry), render(untracked));
});

test('issuance record: ids and categories only, never contact details', () => {
  const plan = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  const record = buildIssuanceRecord({
    plan, actionId: ordinaryColdActionId(lead.id, 2), lead, campaignVersion: 'industrial_staffing_employer_acquisition_v1',
    templateId: lead.emailTemplateId, templateVersion: 'industrial_staffing_follow_up_v1', senderInboxId: 'primary', env: {},
  });
  assert.deepEqual(record, {
    issuance_key: `gmail-cold:${lead.id}:step:2|staffing_landing`, action_id: `gmail-cold:${lead.id}:step:2`,
    token_hash: plan.tokenHash, token_key_version: 1, lead_id: lead.id, source: 'followup_2', trigger_action: null,
    campaign_id: STAFFING_CAMPAIGN.id, campaign_version: 'industrial_staffing_employer_acquisition_v1',
    template_id: lead.emailTemplateId, template_version: 'industrial_staffing_follow_up_v1', sender_inbox_id: 'primary', is_test: false,
  });
  const serialised = JSON.stringify(record);
  for (const value of [lead.email, lead.company, plan.token, plan.url]) assert.equal(serialised.includes(value), false);
  assert.equal(record.token_hash, landingTokenHash(plan.token));
  assert.equal(buildIssuanceRecord({ plan, actionId: 'a', lead: { ...lead, email: 'deins@scalelabai.ca' }, templateId: 't', templateVersion: 'v', senderInboxId: 's', env: {} }).is_test, true);
  assert.throws(() => buildIssuanceRecord({ plan: staffingColdStepLandingPlan({ lead, step: 2, env: {} }), lead }), /only a tracked/);
});

test('issuance before send is best-effort: failures proceed, only a contradicting row refuses', async () => {
  const plan = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  const record = { issuance_key: plan.issuanceKey };
  const row = { issuance_key: plan.issuanceKey, token_key_version: 1, token_hash: plan.tokenHash };
  assert.deepEqual(await ensureLandingIssuance({ plan: staffingColdStepLandingPlan({ lead, step: 2, env: {} }), record: null, logger: silent }),
    { proceed: true, stored: false, reason: 'untracked' });
  assert.equal((await ensureLandingIssuance({ plan, record, issue: async () => ({ ok: false, error: 'timeout after 2000ms' }), logger: silent })).proceed, true);
  assert.equal((await ensureLandingIssuance({ plan, record, issue: async () => { throw new Error('boom'); }, logger: silent })).proceed, true);
  const ok = await ensureLandingIssuance({ plan, record, issue: async () => ({ ok: true, data: [row] }), logger: silent });
  assert.deepEqual([ok.proceed, ok.stored], [true, true]);
  const conflict = await ensureLandingIssuance({ plan, record, issue: async () => ({ ok: true, data: { ...row, token_key_version: 2 } }), logger: silent });
  assert.equal(conflict.proceed, false);
  assert.match(conflict.reason, /issuance conflict/);
});

test('sent marker: issues then marks with provider ids; never throws; conflict stops the marker', async () => {
  const plan = staffingColdStepLandingPlan({ lead, step: 2, env: ON });
  const record = { issuance_key: plan.issuanceKey };
  const row = { issuance_key: plan.issuanceKey, token_key_version: 1, token_hash: plan.tokenHash };
  const marked = [];
  const result = await recordLandingLinkSent({
    plan, record, sentAt: '2026-09-25T10:00:00.000Z', result: { data: { id: 'gm-1', threadId: 'th-1' } },
    issue: async () => ({ ok: true, data: [row] }), markSent: async update => { marked.push(update); return { ok: true }; }, logger: silent,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(marked, [{ issuance_key: plan.issuanceKey, sent_at: '2026-09-25T10:00:00.000Z', provider_message_id: 'gm-1', provider_thread_id: 'th-1' }]);
  assert.deepEqual(providerIds({ providerMessageId: 'rec-1', threadId: 'th-2' }), { providerMessageId: 'rec-1', providerThreadId: 'th-2' });
  assert.equal((await recordLandingLinkSent({ plan, record, issue: async () => { throw new Error('x'); }, logger: silent })).ok, false);
  const stopped = [];
  await recordLandingLinkSent({ plan, record, issue: async () => ({ ok: true, data: { ...row, token_hash: 'f'.repeat(64) } }), markSent: async u => { stopped.push(u); return { ok: true }; }, logger: silent });
  assert.equal(stopped.length, 0);
});

test('store RPC: posts to /rest/v1/rpc/<name> with the server key, bounded, never throws', async () => {
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
  const calls = [];
  const ok = await callRpc('landing_issue_link', { p: { a: 1 } }, { env, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('[{"issuance_key":"k"}]', { status: 200 }); } });
  assert.deepEqual([ok.ok, ok.data[0].issuance_key], [true, 'k']);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/landing_issue_link');
  assert.equal(calls[0].init.headers.apikey, 'sb_secret_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p: { a: 1 } });
  const http = await callRpc('x', {}, { env, fetchImpl: async () => new Response('{"message":"echo of sent values"}', { status: 500 }) });
  assert.deepEqual([http.ok, http.error], [false, 'HTTP 500']);
  const timeout = await callRpc('x', {}, { env, timeoutMs: 20, fetchImpl: (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.deepEqual([timeout.ok, timeout.error], [false, 'timeout after 20ms']);
  const off = await callRpc('x', {}, { env: {} });
  assert.equal(off.ok, false);
  const thrown = await callRpc('x', {}, { env, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.deepEqual([thrown.ok, thrown.error], [false, 'socket hang up']);
});

// Normalised so the structural checks don't depend on the checkout's line endings.
const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => agent.slice(agent.indexOf(from), agent.indexOf(to, agent.indexOf(from)));
const delivery = between('async function deliverOrdinaryColdStep', '// Phase 4: mark a lead');

test('deliverOrdinaryColdStep: plan before re-render and recovery; issuance before the reservation; marker after confirmation', () => {
  const order = [
    'staffingColdStepLandingPlan({ lead, step, activities: activitiesForCycle || [] })',
    'landing link blocked',
    "renderStaffingEmail(lead, step, landingPlan?.tracked ? { landingPageUrl: landingPlan.url } : {})",
    "staffing delivery body differs from locked copy",
    'findSuccessfulSequenceSend',
    'an unresolved delivery reservation exists',
    'ensureLandingIssuance({ plan: landingPlan, record: landingRecord })',
    'await recordColdCallActivityStrict(reservation)',
    'guardProviderSend',
    'await sendEmail(',
    'await confirmOutboundReservation(sendAction.actionId)',
    'recordLandingLinkSent({ plan: landingPlan, record: landingRecord, sentAt: new Date().toISOString(), result })',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = delivery.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `${marker} must follow the previous step`);
    cursor = at;
  }
  assert.equal(delivery.split('await sendEmail(').length, 2, 'exactly one provider call');
  assert.match(delivery, /\.\.\.\(landingLink \? \{ landingLink \} : \{\}\),\n\s+\}\),\n\s+\};/);
  // Recovery marks the issuance sent without any provider call.
  const recovery = between('if (recovered) {', 'Backward-compatible protection for step 1');
  assert.match(recovery, /recordLandingLinkSent\(\{ plan: landingPlan, record: landingRecord, sentAt: recovered\.occurredAt, result: recovered \}\)/);
  assert.equal(recovery.includes('sendEmail('), false);
});

test('both follow-up loops render Follow-up #2 from the run activities', () => {
  const calls = agent.match(/staffingFollowUpBody\(lead, nextStepNum, ownershipActivities\)/g) || [];
  assert.equal(calls.length, 2);
  assert.equal(/staffingFollowUpBody\(lead, nextStepNum\)/.test(agent), false);
  assert.match(agent, /\.\.\.\(sendMeta\?\.landingLink \? \{ landingLink: sendMeta\.landingLink \} : \{\}\)/);
});

test('no log line can print a landing link or token', () => {
  for (const line of agent.split('\n').filter(text => /console\.(log|warn|error|info)/.test(text))) {
    assert.equal(/landingPlan\.(url|token)|landingLink\.url|\.token\b/.test(line), false, line.trim());
  }
  const issuance = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'landing-link-issuance.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const line of issuance.split('\n').filter(text => /logger\.(warn|error|log)/.test(text))) {
    assert.equal(/plan\.(url|token)|token_hash/.test(line), false, line.trim());
  }
});
