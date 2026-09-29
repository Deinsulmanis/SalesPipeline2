'use strict';

// Multi-client isolation: ScaleLab AI (default) and Jole Enterprise (managed).
// Every cross-client combination must be an execution-blocking refusal.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CLIENT_ID, resolveClientId, getClient, listClients, isKnownClient, buildRegistry,
} = require('../integrations/clients/registry');
const {
  resolveLeadClient, checkClientConsistency, actionOwnership, checkActionOwnership, leadsForClient,
  resolveSenderClient,
} = require('../integrations/clients/ownership');
const { clientSendBlock } = require('../integrations/clients/send-policy');
const { allowedForLead, chooseSender } = require('../integrations/gmail-sender-routing');
const { validateRoute, routedLeadReady, validateCampaignVersionRoute } = require('../integrations/campaign-routing');
const { evaluateFreshSendSafety, revalidateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { withOutboundReservation, setSendReservationStoreForTests } = require('../integrations/send-lock');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { resolveReplyClientContext } = require('../integrations/clients/reply-policy');
const { parseRegistry, publicRegistry } = require('../integrations/gmail-inbox-registry');

// ── Fixtures ───────────────────────────────────────────────────────────────
const JOLE_SENDER = Object.freeze({
  id: 'jole_test', email: 'outreach@jole-test.invalid', clientId: 'jole',
  status: 'active', sendEligible: true, dailyLimit: 10, perRunLimit: 2, credentialConfigured: true,
});
const SCALELAB_SENDER = Object.freeze({
  id: 'primary', email: 'deins@scalelabai.ca', status: 'active', sendEligible: true,
  dailyLimit: 60, perRunLimit: 6, credentialConfigured: true,
});
const SENDERS = [SCALELAB_SENDER, JOLE_SENDER];

const joleLead = (extra = {}) => ({
  id: 'jole-lead-1', company: 'Voltline Mission Critical LLC', contactName: 'Pat Rivera',
  email: 'pat.rivera@voltline-test.invalid', stage: 'Queued', emailStatus: '', emailStep: '', notes: '',
  leadNiche: 'jole_employer', emailTemplateId: 'jole-dc-mission-critical-v1',
  intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL', campaign: 'JOLE_DC_MISSION_CRITICAL',
  senderInboxId: 'jole_test', routingRequired: 'true', tradeType: '', ...extra,
});
// Shapes taken from production rows (2026-09-29 read-only audit).
const scalelabDental = (extra = {}) => ({
  id: 'sl-dental-1', company: 'Bright Smiles Dental', email: 'office@brightsmiles-test.invalid',
  stage: 'Queued', emailStatus: '', emailStep: '', notes: '', leadNiche: 'dental',
  emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: 'dental_v3_pay_per_booking',
  campaign: 'Ontario List', senderInboxId: 'primary', routingRequired: 'true', tradeType: 'Dentist', ...extra,
});
const legacyBlank = () => ({ id: 'legacy-1', email: 'x@legacy-test.invalid', leadNiche: '', emailTemplateId: '', intendedCampaignVersion: '', campaign: '', senderInboxId: '', tradeType: '' });

// ── CLIENT REGISTRY ────────────────────────────────────────────────────────
test('registry: ScaleLab and Jole resolve; unknown and blank are rejected', () => {
  assert.equal(DEFAULT_CLIENT_ID, 'scalelab');
  assert.deepEqual(resolveClientId('scalelab'), { ok: true, clientId: 'scalelab' });
  assert.deepEqual(resolveClientId('JOLE'), { ok: true, clientId: 'jole' });
  assert.equal(resolveClientId('acme').code, 'client_unknown');
  assert.equal(resolveClientId('').code, 'client_required');
  assert.equal(isKnownClient('acme'), false);
  assert.throws(() => getClient('acme'), error => error.code === 'client_unknown');
  assert.deepEqual(listClients().map(client => client.id).sort(), ['jole', 'scalelab']);
});

test('registry: Jole is an active managed client with no platform access and sending disabled', () => {
  const jole = getClient('jole');
  assert.equal(jole.displayName, 'Jole Enterprise');
  assert.equal(jole.active, true);
  assert.equal(jole.sending.enabled, false);
  assert.equal(jole.platformAccess, 'none');
  assert.equal(jole.representative.name, 'Jorge Guerrero');
  assert.equal(jole.representative.operatesPlatform, false);
  assert.equal(jole.conversationOwnership.owner, 'scalelab');
  assert.equal(jole.conversationOwnership.handOffOnPositiveReply, false);
  assert.equal(jole.billing.model, 'per_qualified_held_meeting');
  assert.equal(jole.billing.currency, 'USD');
});

test('registry: a managed client cannot be configured with platform access or without the send locks', () => {
  const base = getClient('jole');
  const scalelab = getClient('scalelab');
  assert.throws(() => buildRegistry([scalelab, { ...base, platformAccess: 'login' }]), /platformAccess "none"/);
  assert.throws(() => buildRegistry([scalelab, { ...base, sending: { ...base.sending, requiresEnvAuthorization: false } }]), /env send authorization/);
  assert.throws(() => buildRegistry([scalelab, { ...base, namespace: '' }]), /namespace/);
  assert.throws(() => buildRegistry([base]), /default client/);
});

// ── OWNERSHIP ──────────────────────────────────────────────────────────────
test('ownership: every production lead shape resolves to ScaleLab without a stored column', () => {
  for (const lead of [
    scalelabDental(), legacyBlank(),
    { leadNiche: 'industrial_staffing', emailTemplateId: 'industrial-staffing-employer-v1', intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1', campaign: 'Industrial Staffing Agency', senderInboxId: 'scalelabaiteam' },
    { leadNiche: 'roofing', emailTemplateId: 'roofing-survey-v1', campaign: 'BC Roofing Survey' },
    { campaign: 'toronto-medspa-jul' }, { campaign: 'Campaign #2' },
  ]) {
    const verdict = resolveLeadClient(lead);
    assert.equal(verdict.ok, true, JSON.stringify(lead));
    assert.equal(verdict.clientId, 'scalelab');
  }
  assert.equal(resolveLeadClient(joleLead()).clientId, 'jole');
});

test('ownership: a lead whose fields name two clients is a conflict, never a guess', () => {
  for (const conflict of [
    joleLead({ emailTemplateId: 'dental-guarantee-v1' }),
    joleLead({ tradeType: 'Staffing agency' }),
    joleLead({ campaign: 'BC Dentists' }),
    scalelabDental({ intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL' }),
  ]) {
    const verdict = resolveLeadClient(conflict);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'client_ownership_conflict');
  }
});

test('ownership: correct Jole lead + Jole campaign + Jole sender passes', () => {
  const verdict = checkClientConsistency({ lead: joleLead(), sender: JOLE_SENDER, senders: SENDERS });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.clientId, 'jole');
});

test('ownership: JOLE LEAD + SCALELAB CAMPAIGN is blocked', () => {
  const verdict = checkClientConsistency({ lead: joleLead(), campaignId: 'dental_v3_pay_per_booking', senders: SENDERS });
  assert.equal(verdict.code, 'client_ownership_conflict');
});

test('ownership: JOLE LEAD + SCALELAB SENDER is blocked', () => {
  const verdict = checkClientConsistency({ lead: joleLead(), sender: SCALELAB_SENDER, senders: SENDERS });
  assert.equal(verdict.code, 'client_ownership_conflict');
  // …including when the ScaleLab sender is only on the lead row.
  assert.equal(checkClientConsistency({ lead: joleLead({ senderInboxId: 'primary' }), senders: SENDERS }).code, 'client_ownership_conflict');
});

test('ownership: SCALELAB LEAD + JOLE CAMPAIGN is blocked', () => {
  assert.equal(checkClientConsistency({ lead: scalelabDental(), campaignId: 'JOLE_DC_MISSION_CRITICAL', senders: SENDERS }).code, 'client_ownership_conflict');
});

test('ownership: SCALELAB LEAD + JOLE SENDER is blocked', () => {
  assert.equal(checkClientConsistency({ lead: scalelabDental(), sender: JOLE_SENDER, senders: SENDERS }).code, 'client_ownership_conflict');
});

test('ownership: cross-client template is blocked, and an unregistered Jole id is not ScaleLab', () => {
  assert.equal(checkClientConsistency({ lead: scalelabDental(), templateId: 'jole-dc-mission-critical-v1', senders: SENDERS }).code, 'client_ownership_conflict');
  assert.equal(checkClientConsistency({ lead: joleLead(), templateId: 'jole-unregistered-v9', senders: SENDERS }).code, 'template_unknown');
  assert.equal(checkClientConsistency({ lead: joleLead(), campaignId: 'JOLE_NOT_REAL', senders: SENDERS }).code, 'campaign_unknown');
});

test('ownership: an unconfigured sender resolves to ScaleLab, so it can never serve a Jole lead', () => {
  assert.equal(resolveSenderClient('mystery', { senders: SENDERS }).clientId, 'scalelab');
  assert.equal(checkClientConsistency({ lead: joleLead({ senderInboxId: 'mystery' }), senders: SENDERS }).code, 'client_ownership_conflict');
});

test('ownership: server-side scoping returns only that client\'s leads', () => {
  const corpus = [joleLead(), scalelabDental(), legacyBlank(), joleLead({ id: 'bad', tradeType: 'staffing' })];
  assert.deepEqual(leadsForClient(corpus, 'jole').map(lead => lead.id), ['jole-lead-1']);
  assert.deepEqual(leadsForClient(corpus, 'scalelab').map(lead => lead.id), ['sl-dental-1', 'legacy-1']);
  assert.throws(() => leadsForClient(corpus, 'acme'), error => error.code === 'client_unknown');
});

// ── SENDER SELECTION ───────────────────────────────────────────────────────
test('sender selection: Jole uses Jole senders only; ScaleLab uses ScaleLab senders only', () => {
  assert.equal(allowedForLead(JOLE_SENDER, joleLead()), true);
  assert.equal(allowedForLead(SCALELAB_SENDER, joleLead()), false);
  assert.equal(allowedForLead(SCALELAB_SENDER, scalelabDental()), true);
  // Before isolation a send-eligible inbox could take ANY dental lead dynamically.
  assert.equal(allowedForLead(JOLE_SENDER, scalelabDental()), false);
  assert.equal(allowedForLead(JOLE_SENDER, legacyBlank()), false);
});

test('sender selection: a Jole lead with no usable Jole sender does NOT fall back to ScaleLab', () => {
  const unassigned = joleLead({ senderInboxId: '', routingRequired: '' });
  const noJole = [SCALELAB_SENDER, { ...SCALELAB_SENDER, id: 'tryscalelabai', email: 'deins@tryscalelabai.ca' }];
  const verdict = chooseSender({ lead: unassigned, senders: noJole, sendsToday: new Map() });
  assert.equal(verdict.sender, null);
  // An exhausted Jole sender also never spills onto ScaleLab capacity.
  const full = chooseSender({ lead: unassigned, senders: SENDERS, sendsToday: new Map([['jole_test', 10]]) });
  assert.equal(full.sender, null);
  // Assigned to a ScaleLab inbox: refused outright.
  assert.throws(() => chooseSender({ lead: joleLead({ senderInboxId: 'primary' }), senders: SENDERS }), /not delivery eligible/);
});

test('sender selection: an unassigned legacy dental lead still routes dynamically among ScaleLab inboxes only', () => {
  const lead = { id: 'd', leadNiche: 'dental', routingRequired: '' };
  const verdict = chooseSender({ lead, senders: SENDERS, sendsToday: new Map([['primary', 0]]) });
  assert.equal(verdict.sender.id, 'primary');
  const onlyJoleFree = chooseSender({ lead, senders: SENDERS, sendsToday: new Map([['primary', 60]]) });
  assert.equal(onlyJoleFree.sender, null);
});

// ── ROUTING / QUEUE ────────────────────────────────────────────────────────
test('routing: validateRoute refuses cross-client sender, template and campaign', () => {
  const inboxes = [{ ...SCALELAB_SENDER, deliveryImplemented: true }, { ...JOLE_SENDER, deliveryImplemented: true }];
  const scalelabOnJole = validateRoute({ niche: 'dental', senderInboxId: 'jole_test', emailTemplateId: 'dental-guarantee-v1', inboxes });
  assert.equal(scalelabOnJole.ok, false); assert.equal(scalelabOnJole.code, 'client_ownership_conflict');
  const joleOnScalelab = validateRoute({ niche: 'jole_employer', senderInboxId: 'primary', emailTemplateId: 'jole-dc-mission-critical-v1', inboxes });
  assert.equal(joleOnScalelab.code, 'client_ownership_conflict');
  const campaignMismatch = validateRoute({ niche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes, campaignVersionId: 'JOLE_DC_MISSION_CRITICAL' });
  assert.equal(campaignMismatch.code, 'client_ownership_conflict');
  // Same client end to end: isolation passes; the draft template's readiness is what refuses.
  const jole = validateRoute({ niche: 'jole_employer', senderInboxId: 'jole_test', emailTemplateId: 'jole-dc-mission-critical-v1', inboxes, campaignVersionId: 'JOLE_DC_MISSION_CRITICAL' });
  assert.equal(jole.ok, false); assert.equal(jole.code, undefined); assert.match(jole.reason, /not final/);
  // Legacy route unchanged.
  assert.equal(validateRoute({ niche: 'dental', senderInboxId: 'primary', emailTemplateId: 'dental-guarantee-v1', inboxes }).ok, true);
});

test('routing: inbox rows without clientId (as sender-balance passes them) still resolve the real sender client', () => {
  const stripped = [{ id: 'jole_test', email: 'x', sendEligible: true, deliveryImplemented: true }];
  const original = process.env.GMAIL_INBOX_REGISTRY_JSON;
  process.env.GMAIL_INBOX_REGISTRY_JSON = JSON.stringify([{ id: 'jole_test', email: 'outreach@jole-test.invalid', status: 'warming', tokenEnv: 'GMAIL_JOLE_TEST_TOKEN_JSON', dailyLimit: 0, clientId: 'jole' }]);
  try {
    const verdict = validateRoute({ niche: 'dental', senderInboxId: 'jole_test', emailTemplateId: 'dental-guarantee-v1', inboxes: stripped });
    assert.equal(verdict.code, 'client_ownership_conflict');
  } finally {
    if (original === undefined) delete process.env.GMAIL_INBOX_REGISTRY_JSON; else process.env.GMAIL_INBOX_REGISTRY_JSON = original;
  }
});

test('routing: Jole campaigns are not queueable while draft/placeholder', () => {
  assert.match(validateCampaignVersionRoute({ niche: 'jole_employer', emailTemplateId: 'jole-dc-mission-critical-v1', campaignVersionId: 'JOLE_DC_MISSION_CRITICAL' }).reason, /draft/);
  assert.match(validateCampaignVersionRoute({ niche: 'jole_employer', emailTemplateId: 'jole-gulf-industrial-v1', campaignVersionId: 'JOLE_GULF_INDUSTRIAL' }).reason, /disabled/);
  assert.match(validateCampaignVersionRoute({ niche: 'jole_employer', emailTemplateId: 'jole-shipyard-v1', campaignVersionId: 'JOLE_SHIPYARD' }).reason, /disabled/);
});

test('routing: routedLeadReady refuses Jole leads through their own registry and never the legacy bypass', () => {
  // Unregistered Jole sender id: it is not a Jole sender, so the lead is refused.
  assert.equal(routedLeadReady(joleLead({ routingRequired: '' }), {}).code, 'client_ownership_conflict');
  const original = process.env.GMAIL_INBOX_REGISTRY_JSON;
  process.env.GMAIL_INBOX_REGISTRY_JSON = JSON.stringify([{ id: 'jole_test', email: 'outreach@jole-test.invalid', status: 'warming', tokenEnv: 'GMAIL_JOLE_TEST_TOKEN_JSON', dailyLimit: 0, clientId: 'jole' }]);
  try {
    // Registered Jole sender: ownership passes; the draft campaign refuses.
    const verdict = routedLeadReady(joleLead({ routingRequired: '' }), {});
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'campaign_draft');
    assert.equal(routedLeadReady(joleLead({ tradeType: 'staffing' }), {}).code, 'client_ownership_conflict');
    // A legacy lead holding a Jole sender id is refused before the legacy bypass.
    assert.equal(routedLeadReady({ ...legacyBlank(), senderInboxId: 'jole_test' }, {}).code, 'client_ownership_conflict');
  } finally {
    if (original === undefined) delete process.env.GMAIL_INBOX_REGISTRY_JSON; else process.env.GMAIL_INBOX_REGISTRY_JSON = original;
  }
  // Legacy leads are unchanged.
  assert.deepEqual(routedLeadReady(legacyBlank(), {}), { ok: true, legacy: true });
  assert.equal(routedLeadReady(scalelabDental(), {}).ok, true);
});

// ── FINAL GATE ─────────────────────────────────────────────────────────────
const cleanEnv = {};

test('final gate: JOLE SEND DISABLE — blocked even when every other requirement passes', () => {
  const lead = joleLead();
  const verdict = evaluateFreshSendSafety(lead, lead, new Set(), {
    purpose: 'cold', env: cleanEnv, senderInboxId: 'jole_test', senders: SENDERS,
    clientSuppression: { available: true, entries: [] },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'client_sending_disabled');
  // Naming Jole in the env allow-list does not override the source-controlled switch.
  const envOnly = evaluateFreshSendSafety(lead, lead, new Set(), {
    purpose: 'cold', env: { CLIENT_SENDING_AUTHORIZED: 'jole' }, senderInboxId: 'jole_test', senders: SENDERS,
    clientSuppression: { available: true, entries: [] },
  });
  assert.equal(envOnly.code, 'client_sending_disabled');
  assert.equal(clientSendBlock('jole', { CLIENT_SENDING_AUTHORIZED: 'jole' }).code, 'client_sending_disabled');
  assert.equal(clientSendBlock('scalelab', {}), null);
});

test('final gate: cross-client sender or lead is refused before suppression or sending', () => {
  const jole = joleLead();
  assert.equal(evaluateFreshSendSafety(jole, jole, new Set(), { env: cleanEnv, senderInboxId: 'primary', senders: SENDERS }).code, 'client_ownership_conflict');
  const dental = scalelabDental();
  assert.equal(evaluateFreshSendSafety(dental, dental, new Set(), { env: cleanEnv, senderInboxId: 'jole_test', senders: SENDERS }).code, 'client_ownership_conflict');
  // The row changed ownership since selection: the fresh row decides.
  const drifted = { ...dental, intendedCampaignVersion: 'JOLE_DC_MISSION_CRITICAL' };
  assert.equal(evaluateFreshSendSafety(dental, drifted, new Set(), { env: cleanEnv, senderInboxId: 'primary', senders: SENDERS }).code, 'client_ownership_conflict');
});

test('final gate: legacy ScaleLab verdicts are unchanged', () => {
  const dental = scalelabDental();
  const ok = evaluateFreshSendSafety(dental, dental, new Set(), { env: cleanEnv, senderInboxId: 'primary', senders: SENDERS });
  assert.equal(ok.allowed, true); assert.equal(ok.clientId, 'scalelab');
  assert.equal(evaluateFreshSendSafety(dental, { ...dental, notes: '[REPLY: Unsubscribed]' }, new Set(), { env: cleanEnv }).code, 'unsubscribed');
  assert.equal(evaluateFreshSendSafety(dental, dental, new Set([dental.email]), { env: cleanEnv }).code, 'suppressed');
  assert.equal(evaluateFreshSendSafety(dental, { ...dental, notes: '[MANUAL HOLD]' }, new Set(), { env: cleanEnv }).code, 'manual_hold');
  assert.equal(evaluateFreshSendSafety(dental, null, new Set(), { env: cleanEnv }).code, 'identity_changed');
  // Legacy callers that pass no sender and no client suppression still pass.
  assert.equal(evaluateFreshSendSafety(dental, dental, new Set(), { env: cleanEnv }).allowed, true);
});

test('final gate: revalidation loads client suppression for the fresh row\'s client', async () => {
  const dental = scalelabDental();
  const seen = [];
  const verdict = await revalidateFreshSendSafety(dental, {
    env: cleanEnv, senders: SENDERS,
    loadFreshState: async () => ({ current: dental, suppressedEmails: new Set() }),
    loadClientSuppression: async (clientId, lead) => { seen.push([clientId, lead.id]); return { available: true, entries: [{ client_id: 'scalelab', match_type: 'domain', match_value: 'brightsmiles-test.invalid', active: true }] }; },
  }, { senderInboxId: 'primary' });
  assert.deepEqual(seen, [['scalelab', 'sl-dental-1']]);
  assert.equal(verdict.code, 'client_suppressed');
});

// ── RESERVATIONS ───────────────────────────────────────────────────────────
test('reservation: MIXED CLIENT RESERVATION is impossible — refused before any row exists', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  let providerCalled = false;
  try {
    const mixed = actionOwnership(joleLead(), SCALELAB_SENDER, { senders: SENDERS });
    assert.equal(mixed.ok, false);
    await assert.rejects(
      withOutboundReservation({ actionId: 'gmail-cold:jole-lead-1:step:1', leadId: 'jole-lead-1', provider: 'gmail', actionType: 'gmail_cold_step', ownership: mixed },
        async () => { providerCalled = true; return {}; }, { SEND_LOCK_ENABLED: 'true' }),
      error => error.code === 'client_ownership_conflict',
    );
    const handMixed = { clientId: 'jole', leadClientId: 'jole', senderClientId: 'scalelab', ok: true };
    assert.equal(checkActionOwnership(handMixed).code, 'client_ownership_conflict');
    await assert.rejects(withOutboundReservation({ actionId: 'a2', leadId: 'x', provider: 'gmail', ownership: handMixed }, async () => { providerCalled = true; }, {}),
      error => error.code === 'client_ownership_conflict');
    assert.equal(providerCalled, false);
    assert.equal(await store.getOutboundReservation?.('gmail-cold:jole-lead-1:step:1') ?? null, null);
  } finally {
    setSendReservationStoreForTests(null);
  }
});

test('reservation: consistent single-client ownership reserves normally; legacy actions without ownership unchanged', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  try {
    const owner = actionOwnership(scalelabDental(), SCALELAB_SENDER, { senders: SENDERS });
    assert.equal(owner.ok, true); assert.equal(owner.clientId, 'scalelab');
    const result = await withOutboundReservation({ actionId: 'gmail-cold:sl-dental-1:step:1', leadId: 'sl-dental-1', provider: 'gmail', actionType: 'gmail_cold_step', ownership: owner },
      async () => ({ data: { id: 'm1', threadId: 't1' } }), { SEND_LOCK_ENABLED: 'true' });
    assert.equal(result.data.id, 'm1');
    const legacy = await withOutboundReservation({ actionId: 'gmail-cold:legacy:step:1', leadId: 'legacy', provider: 'gmail', actionType: 'gmail_cold_step' },
      async () => ({ data: { id: 'm2', threadId: 't2' } }), { SEND_LOCK_ENABLED: 'true' });
    assert.equal(legacy.data.id, 'm2');
  } finally {
    setSendReservationStoreForTests(null);
  }
});

// ── REPLY ROUTING ──────────────────────────────────────────────────────────
test('replies: a Jole reply resolves Jole context; a ScaleLab reply resolves ScaleLab legacy context', () => {
  const jole = resolveReplyClientContext({ senderInboxId: 'jole_test', lead: joleLead(), senders: SENDERS });
  assert.deepEqual({ ok: jole.ok, clientId: jole.clientId, policyMode: jole.policyMode, campaignId: jole.campaignId },
    { ok: true, clientId: 'jole', policyMode: 'managed', campaignId: 'JOLE_DC_MISSION_CRITICAL' });
  const scalelab = resolveReplyClientContext({ senderInboxId: 'primary', lead: scalelabDental(), senders: SENDERS });
  assert.equal(scalelab.clientId, 'scalelab'); assert.equal(scalelab.policyMode, 'legacy');
});

test('replies: MIXED CLIENT REPLY ROUTING is impossible (cross-client thread contamination)', () => {
  const intoScalelabInbox = resolveReplyClientContext({ senderInboxId: 'primary', lead: joleLead(), senders: SENDERS });
  assert.equal(intoScalelabInbox.ok, false); assert.equal(intoScalelabInbox.code, 'client_ownership_conflict');
  const intoJoleInbox = resolveReplyClientContext({ senderInboxId: 'jole_test', lead: scalelabDental(), senders: SENDERS });
  assert.equal(intoJoleInbox.ok, false);
  assert.equal(resolveReplyClientContext({ senderInboxId: '', lead: joleLead(), senders: SENDERS }).code, 'reply_sender_missing');
});

// ── SENDER REGISTRY ────────────────────────────────────────────────────────
test('sender registry: clientId is optional (default ScaleLab), validated, and exposed', () => {
  const entries = parseRegistry(JSON.stringify([
    { id: 'jole_a', email: 'a@jole-test.invalid', status: 'warming', tokenEnv: 'GMAIL_JOLE_A_TOKEN_JSON', dailyLimit: 0, clientId: 'jole' },
    { id: 'legacy_b', email: 'b@scalelab-test.invalid', status: 'warming', tokenEnv: 'GMAIL_LEGACY_B_TOKEN_JSON', dailyLimit: 0 },
  ]));
  assert.equal(entries[0].clientId, 'jole');
  assert.equal('clientId' in entries[1], false);
  assert.deepEqual(publicRegistry(entries, {}).map(entry => entry.clientId), ['jole', 'scalelab']);
  assert.throws(() => parseRegistry(JSON.stringify([{ id: 'x', email: 'x@y.invalid', tokenEnv: 'GMAIL_X_TOKEN_JSON', clientId: 'acme' }])), /unknown client/);
  assert.throws(() => parseRegistry(JSON.stringify([{ id: 'x', email: 'x@y.invalid', tokenEnv: 'GMAIL_X_TOKEN_JSON', clientId: 'jole', staffingOnly: true }])), /staffing-only/);
});
