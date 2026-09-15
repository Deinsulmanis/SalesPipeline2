'use strict';

// Incident repair, Phase 5 — sender proof for an Outreach-only lead.
//
// The legacy evidence endpoint could never produce a plan. legacyEvidencePlan
// called proveLegacyEvidence without expectedMailboxIds, and the coverage check
// rightly refuses to prove from an unknown roster, so every request failed. It
// also refused any lead without a Pipeline card, which excludes exactly the
// Outreach-only demo-pair leads whose booking links wait on sender proof.
//
// legacyEvidenceInputs() now resolves exact ColdEmail identity, an OPTIONAL card,
// and the full configured sending roster. Proof stays evidence-based: one
// provider claimant proves a sender; no claimant, or several, writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  legacyEvidenceInputs, legacyEvidenceRoster, proveLegacyEvidence,
} = require('../integrations/gmail-evidence-reconciliation');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\r\n').join('\n');

// Synthetic identities only.
const PRIMARY = { id: 'primary', email: 'owner@scalelab.example', status: 'active', dailyLimit: 40, credentialConfigured: true, sendEligible: true };
const SECONDARY = { id: 'tryscalelabai', email: 'hello@tryscalelab.example', status: 'active', dailyLimit: 40, credentialConfigured: true, sendEligible: true };
const SENDERS = [PRIMARY, SECONDARY];
const LEAD = {
  id: 'outreach-only-1', email: 'front@clinic.example', company: 'Harbour Dental',
  senderInboxId: '', notes: '', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1',
};

function sent(id, from, { to = LEAD.email, threadId = 'thread-1' } = {}) {
  return {
    id, threadId, labelIds: ['SENT'], internalDate: String(Date.parse('2026-09-11T16:45:17Z')),
    payload: { headers: [
      { name: 'From', value: from }, { name: 'To', value: to },
      { name: 'Message-ID', value: `<${id}@mail.example>` }, { name: 'Subject', value: 'A demo for Harbour Dental' },
    ], body: { data: '' } },
  };
}

function mailbox(sender, messages = []) {
  return { id: sender.id, email: sender.email, gmail: { users: {
    getProfile: async () => ({ data: { emailAddress: sender.email } }),
    messages: {
      list: async () => ({ data: { messages } }),
      get: async params => ({ data: messages.find(message => message.id === params.id) }),
    },
    threads: { get: async () => ({ data: { messages: [] } }) },
  } } };
}

const inputsFor = (overrides = {}) => legacyEvidenceInputs({
  leadId: LEAD.id, leads: [LEAD, { id: 'other', email: 'x@other.example' }],
  boardLeads: [], activities: [], senders: SENDERS, ...overrides,
});

test('an Outreach-only lead with no Pipeline card resolves, expecting every configured mailbox', () => {
  const inputs = inputsFor();
  assert.equal(inputs.lead.id, LEAD.id);
  assert.equal(inputs.board, null, 'no card is reported as none, not refused');
  assert.deepEqual(inputs.expectedMailboxIds, ['primary', 'tryscalelabai']);
});

test('one provider claimant proves the sender for an Outreach-only lead', async () => {
  const inputs = inputsFor();
  const plan = await proveLegacyEvidence({
    ...inputs, now: new Date('2026-09-14T22:00:00Z'),
    mailboxes: [mailbox(PRIMARY), mailbox(SECONDARY, [sent('m1', SECONDARY.email)])],
  });
  assert.equal(plan.repairable, true, plan.reason);
  assert.equal(plan.senderInboxId, 'tryscalelabai');
  assert.equal(plan.events[0].leadId, `CE-${LEAD.id}`, 'the timeline id comes from the lead when there is no card');
  assert.deepEqual(plan.writes[0], { field: 'senderInboxId', value: 'tryscalelabai' });
});

test('two provider claimants are a conflict: nothing is assigned', async () => {
  const plan = await proveLegacyEvidence({
    ...inputsFor(), now: new Date('2026-09-14T22:00:00Z'),
    mailboxes: [mailbox(PRIMARY, [sent('p1', PRIMARY.email)]), mailbox(SECONDARY, [sent('s1', SECONDARY.email)])],
  });
  assert.equal(plan.repairable, false);
  assert.match(plan.reason, /CONFLICT/);
  assert.deepEqual(plan.writes, []);
});

test('no provider claimant is unknown: nothing is assigned', async () => {
  const plan = await proveLegacyEvidence({
    ...inputsFor(), now: new Date('2026-09-14T22:00:00Z'),
    mailboxes: [mailbox(PRIMARY, [sent('p1', PRIMARY.email, { to: 'someone@else.example' })]), mailbox(SECONDARY)],
  });
  assert.equal(plan.repairable, false);
  assert.match(plan.reason, /UNKNOWN/);
  assert.deepEqual(plan.writes, []);
});

test('a proof that omits a configured mailbox is refused before any provider read', async () => {
  let read = false;
  const onlyPrimary = mailbox(PRIMARY);
  onlyPrimary.gmail.users.getProfile = async () => { read = true; return { data: { emailAddress: PRIMARY.email } }; };
  await assert.rejects(
    () => proveLegacyEvidence({ ...inputsFor(), mailboxes: [onlyPrimary] }),
    /missing tryscalelabai/);
  assert.equal(read, false);
});

test('the roster covers paused mailboxes, skips warming ones, and fails closed without credentials', () => {
  const paused = { id: 'retired', email: 'old@scalelab.example', status: 'paused', dailyLimit: 0, credentialConfigured: true, sendEligible: false };
  const warming = { id: 'new', email: 'new@scalelab.example', status: 'warming', dailyLimit: 0, credentialConfigured: true, sendEligible: false };
  assert.deepEqual(legacyEvidenceRoster([PRIMARY, paused, warming]), ['primary', 'retired'],
    'a paused mailbox may have sent to this lead, so it must be asked');
  assert.throws(() => legacyEvidenceRoster([PRIMARY, { ...paused, credentialConfigured: false }]),
    /without credentials: retired/);
  assert.throws(() => legacyEvidenceRoster([{ ...SECONDARY, credentialConfigured: false }]), /without credentials/);
  assert.throws(() => legacyEvidenceRoster([]), /No configured sending mailbox/);
  assert.throws(() => legacyEvidenceRoster([warming]), /No configured sending mailbox/);
});

test('identity is the exact ColdEmail id, and its email must be unique', () => {
  assert.throws(() => inputsFor({ leadId: 'missing' }), /One exact ColdEmail identity/);
  assert.throws(() => inputsFor({ leads: [LEAD, { ...LEAD }] }), /One exact ColdEmail identity/);
  assert.throws(() => inputsFor({ leads: [LEAD, { id: 'twin', email: ' FRONT@clinic.example ' }] }), /Duplicate CRM identity/);
  assert.throws(() => inputsFor({ leads: [{ ...LEAD, email: '' }] }), /Exact canonical lead identity/);
});

test('a card matches by exact id first, and by email only when exactly one card has it', () => {
  const exact = { id: `CE-${LEAD.id}`, email: 'changed@clinic.example', stage: 'follow_up' };
  const byEmail = { id: 'CE-legacy', email: LEAD.email, stage: 'call_booked' };
  assert.equal(inputsFor({ boardLeads: [byEmail, exact] }).board, exact, 'the exact card wins over an email match');
  assert.equal(inputsFor({ boardLeads: [byEmail] }).board, byEmail);
  assert.throws(() => inputsFor({ boardLeads: [byEmail, { ...byEmail, id: 'CE-legacy-2' }] }), /Duplicate Pipeline identity/);
});

test('activities are scoped to this lead and its card', () => {
  const card = { id: 'CE-legacy', email: LEAD.email };
  const inputs = inputsFor({
    boardLeads: [card],
    activities: [
      { eventId: 'a', sourceLeadId: LEAD.id }, { eventId: 'b', leadId: `CE-${LEAD.id}` },
      { eventId: 'c', leadId: 'CE-legacy' }, { eventId: 'd', email: 'FRONT@clinic.example' },
      { eventId: 'e', sourceLeadId: 'other', email: 'x@other.example' },
    ],
  });
  assert.deepEqual(inputs.activities.map(row => row.eventId), ['a', 'b', 'c', 'd']);
});

test('the evidence endpoint proves from the resolved inputs and no longer requires a card', () => {
  const plan = serverSrc.slice(serverSrc.indexOf('async function legacyEvidencePlan'),
    serverSrc.indexOf("app.get('/api/ops/legacy-evidence/:leadId'"));
  assert.match(plan, /legacyEvidenceInputs\(\{/);
  assert.match(plan, /senders: configuredSenders\(\)/);
  assert.match(plan, /mailboxes: inputs\.expectedMailboxIds\.map\(id => operationalMailbox\(id\)\)/,
    'the mailboxes proven are exactly the expected roster');
  assert.ok(!serverSrc.includes('Only current Pipeline leads may be reconciled'));
});
