'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROVIDER, HOLD_REASON, createProviderClassifier, classifyMxHosts, providerVerdict, coldSenderVerdict,
  coldDeliveryVerdict, admitByRecipientProvider, recipientProviderPolicy, coldInboxDailyCap, applyColdInboxCap,
  recipientDomain, coldSenderPool,
} = require('../integrations/cold-delivery-policy');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { queueSelectedLeads } = require('../integrations/outreach-queue');
const { configuredSenders } = require('../integrations/gmail-sender-routing');

const root = path.join(__dirname, '..');
const quiet = { log() {} };
const mx = (...hosts) => hosts.map((exchange, i) => ({ exchange, priority: i + 1 }));
// A classifier over a scripted resolver, counting lookups per domain.
function classifierWith(table, { now = () => 0, ttlMs } = {}) {
  const calls = new Map();
  const resolveMx = async domain => {
    calls.set(domain, (calls.get(domain) || 0) + 1);
    const answer = typeof table === 'function' ? table(domain) : table[domain];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
    return answer;
  };
  return { classifier: createProviderClassifier({ resolveMx, now, ttlMs, logger: quiet, env: {} }), calls };
}
const err = code => Object.assign(new Error(code), { code });
const GOOGLE_POLICY = {}; // default policy = google_only
const healthy = (id = 'primary') => ({ id, status: 'active', sendEligible: true });

// Authorized env for the real final gate, as in the existing gate tests.
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
});
const lead = (overrides = {}) => ({ id: 'L1', email: 'owner@acme.test', notes: '', stage: 'Queued', emailStatus: '', emailStep: '', ...overrides });
const finalGate = (current, { classifyRecipient, coldSender, suppressed = new Set(), env = SEND_ENV } = {}) => guardProviderSend(current,
  { env, classifyRecipient, loadFreshState: async () => ({ current, suppressedEmails: suppressed }) },
  { purpose: 'cold', ...(coldSender ? { coldSender, senderInboxId: coldSender.id } : {}) });

// ── classification ────────────────────────────────────────────────────────────

test('1. gmail.com recipient is GOOGLE without a DNS lookup and is allowed', async () => {
  const { classifier, calls } = classifierWith({});
  const result = await classifier.classify('Someone@GMAIL.com');
  assert.equal(result.provider, PROVIDER.GOOGLE);
  assert.equal(result.reason, 'google_consumer_domain');
  assert.equal(calls.size, 0);
  assert.equal(providerVerdict(result, GOOGLE_POLICY).allowed, true);
  assert.equal((await classifier.classify('a@googlemail.com')).provider, PROVIDER.GOOGLE);
});

test('2. Google Workspace MX is GOOGLE and allowed', async () => {
  const { classifier } = classifierWith({
    'acme.com': mx('aspmx.l.google.com.', 'alt1.aspmx.l.google.com.', 'alt2.aspmx.l.google.com.', 'aspmx2.googlemail.com.'),
    'beta.ca': mx('smtp.google.com.'),
    // Workspace domain-verification MX beside the real Google set.
    'gamma.ca': mx('aspmx.l.google.com.', 'alt1.aspmx.l.google.com.', 'mk3nmirgsiqotqyxcfuqadv23q.mx-verification.google.com.'),
  });
  for (const email of ['jane@acme.com', 'joe@beta.ca', 'ann@gamma.ca']) {
    const result = await classifier.classify(email);
    assert.equal(result.provider, PROVIDER.GOOGLE, email);
    assert.equal(result.reason, 'google_mx');
    assert.equal(providerVerdict(result, GOOGLE_POLICY).allowed, true);
  }
});

test('3. Microsoft 365 MX is MICROSOFT and held with recipient_provider_microsoft', async () => {
  const { classifier } = classifierWith({ 'contoso.com': mx('contoso-com.mail.protection.outlook.com.'),
    'fabrikam.com': mx('fabrikam-com.o-v1.mx.microsoft.') });
  const result = await classifier.classify('pat@contoso.com');
  assert.equal(result.provider, PROVIDER.MICROSOFT);
  assert.equal((await classifier.classify('lee@fabrikam.com')).provider, PROVIDER.MICROSOFT);
  const verdict = providerVerdict(result, GOOGLE_POLICY);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.MICROSOFT);
});

test('4. hotmail / outlook / live / msn consumer recipients are MICROSOFT without DNS', async () => {
  const { classifier, calls } = classifierWith({});
  for (const email of ['a@hotmail.com', 'b@outlook.com', 'c@live.ca', 'd@hotmail.co.uk', 'e@msn.com', 'f@live.com']) {
    const result = await classifier.classify(email);
    assert.equal(result.provider, PROVIDER.MICROSOFT, email);
    assert.equal(providerVerdict(result, GOOGLE_POLICY).code, HOLD_REASON.MICROSOFT);
  }
  assert.equal(calls.size, 0);
});

test('5. Proofpoint / Mimecast / external gateways are UNKNOWN and held, even beside Google MX', async () => {
  const { classifier } = classifierWith({
    'pp.com': mx('mx0a-001.pphosted.com.', 'mx0b-001.pphosted.com.'),
    'mc.com': mx('us-smtp-inbound-1.mimecast.com.'),
    'mixed.com': mx('aspmx.l.google.com.', 'mx1.pphosted.com.'),
    'zoho.biz': mx('mx.zoho.com.'),
    'odd.com': mx('mail.odd-host.example.'),
    'split.com': mx('aspmx.l.google.com.', 'split-com.mail.protection.outlook.com.'),
    // Google plus the clinic's own backup host is ambiguous routing: held.
    'backup.ca': mx('aspmx.l.google.com.', 'mx.backup.ca.'),
  });
  for (const [email, provider, reason] of [
    ['a@pp.com', PROVIDER.UNKNOWN, 'security_gateway'], ['a@mc.com', PROVIDER.UNKNOWN, 'security_gateway'],
    ['a@mixed.com', PROVIDER.UNKNOWN, 'security_gateway'], ['a@zoho.biz', PROVIDER.OTHER, 'other_provider_mx'],
    ['a@odd.com', PROVIDER.UNKNOWN, 'unrecognized_mx'], ['a@split.com', PROVIDER.UNKNOWN, 'mixed_mx'],
    ['a@backup.ca', PROVIDER.UNKNOWN, 'mixed_mx'],
  ]) {
    const result = await classifier.classify(email);
    assert.equal(result.provider, provider, email);
    assert.equal(result.reason, reason, email);
    assert.equal(providerVerdict(result, GOOGLE_POLICY).allowed, false, email);
  }
  assert.equal(providerVerdict({ provider: PROVIDER.OTHER }, GOOGLE_POLICY).code, HOLD_REASON.OTHER);
});

test('6. DNS failure and timeout are UNKNOWN and held', async () => {
  const { classifier } = classifierWith({ 'down.com': err('ESERVFAIL'), 'slow.com': err('ETIMEOUT'), 'refused.com': err('ECONNREFUSED') });
  for (const email of ['a@down.com', 'a@slow.com', 'a@refused.com']) {
    const result = await classifier.classify(email);
    assert.equal(result.provider, PROVIDER.UNKNOWN, email);
    assert.match(result.reason, /^lookup_failed:/);
    assert.equal(providerVerdict(result, GOOGLE_POLICY).code, HOLD_REASON.UNKNOWN);
  }
});

test('7. no MX (NODATA, NXDOMAIN, empty, RFC 7505 null MX) and malformed addresses are UNKNOWN', async () => {
  const { classifier } = classifierWith({ 'nodata.com': err('ENODATA'), 'empty.com': [], 'null.com': mx('') });
  for (const email of ['a@nodata.com', 'a@empty.com', 'a@null.com', 'a@nxdomain-not-in-table.com']) {
    const result = await classifier.classify(email);
    assert.equal(result.provider, PROVIDER.UNKNOWN, email);
    assert.equal(result.reason, 'no_mx', email);
  }
  for (const email of ['', 'no-at-sign', 'a@', '@x.com', 'a@b@c.com', 'a@-bad-.com', 'a@nodot']) {
    assert.equal((await classifier.classify(email)).reason, 'malformed_address', JSON.stringify(email));
  }
  assert.equal(recipientDomain('Ana@Ex-Ample.CA.'), 'ex-ample.ca');
});

// ── final pre-send authorization ─────────────────────────────────────────────

test('8. an existing queued Microsoft lead is blocked at the final pre-send gate', async () => {
  const { classifier } = classifierWith({ 'contoso.com': mx('contoso-com.mail.protection.outlook.com.') });
  const verdict = await finalGate(lead({ email: 'pat@contoso.com', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1' }),
    { classifyRecipient: email => classifier.classify(email), coldSender: healthy() });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.MICROSOFT);
});

test('9. an existing queued UNKNOWN lead is blocked, including when no classifier is supplied (fail closed)', async () => {
  const { classifier } = classifierWith({ 'down.com': err('ESERVFAIL') });
  const viaLookup = await finalGate(lead({ email: 'a@down.com' }), { classifyRecipient: email => classifier.classify(email), coldSender: healthy() });
  assert.equal(viaLookup.code, HOLD_REASON.UNKNOWN);
  const noClassifier = await finalGate(lead({ email: 'a@acme.com' }), {});
  assert.equal(noClassifier.allowed, false);
  assert.equal(noClassifier.code, HOLD_REASON.UNKNOWN);
  const throwing = await finalGate(lead({ email: 'a@acme.com' }), { classifyRecipient: async () => { throw new Error('boom'); } });
  assert.equal(throwing.code, HOLD_REASON.UNKNOWN);
  // A cache read (peek) of a never-classified domain is UNKNOWN too.
  assert.equal(classifier.peek('a@never-seen.com').provider, PROVIDER.UNKNOWN);
});

test('10. an existing queued Google lead passes the provider gate with a healthy pooled sender', async () => {
  const { classifier } = classifierWith({ 'acme.com': mx('aspmx.l.google.com.') });
  await classifier.classify('owner@acme.com');
  const verdict = await finalGate(lead({ email: 'owner@acme.com' }), { classifyRecipient: email => classifier.peek(email), coldSender: healthy('scalelabaiteam') });
  assert.equal(verdict.allowed, true);
});

test('11. a paused sender still cannot send, even to a Google recipient', async () => {
  const google = { provider: PROVIDER.GOOGLE, domain: 'gmail.com' };
  const paused = { id: 'tryscalelabai', status: 'paused', sendEligible: false };
  const verdict = coldDeliveryVerdict({ sender: paused, classification: google, env: {} });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'sender_not_send_eligible');
  const gate = await finalGate(lead({ email: 'x@gmail.com' }), { classifyRecipient: async () => google, coldSender: paused });
  assert.equal(gate.code, 'sender_not_send_eligible');
  assert.equal(coldDeliveryVerdict({ sender: null, classification: google, env: {} }).allowed, false);
});

test('12. SURBL-listed and Gmail-bad senders are refused even to a Google recipient, while eligible', async () => {
  const google = { provider: PROVIDER.GOOGLE, domain: 'gmail.com' };
  // 2026-10-07 policy: tryscalelabai.ca is on SURBL ABUSE; deniels@scalelabai.ca
  // lands in Gmail Spam. Held whatever the pool says, while send-eligible.
  for (const [id, hold] of [['tryscalelabai', 'sender_domain_surbl_listed'], ['deniels_tryscalelabai', 'sender_domain_surbl_listed'], ['deniels', 'sender_gmail_placement_spam']]) {
    for (const env of [{}, { COLD_SENDER_POOL: 'all' }, { COLD_SENDER_POOL: id }]) {
      const verdict = coldDeliveryVerdict({ sender: healthy(id), classification: google, env });
      assert.equal(verdict.allowed, false, id);
      assert.equal(verdict.code, 'sender_cold_hold', id);
      assert.equal(verdict.holdReason, hold, id);
    }
  }
  for (const id of ['primary', 'scalelabaiteam']) {
    assert.equal(coldDeliveryVerdict({ sender: healthy(id), classification: google, env: {} }).allowed, true, id);
  }
  assert.deepEqual([...coldSenderPool({})].sort(), ['primary', 'scalelabaiteam']);
  assert.equal(coldSenderPool({ COLD_SENDER_POOL: 'all' }), null);
  assert.deepEqual([...coldSenderPool({ COLD_SENDER_POOL: ' primary ' })], ['primary']);
});

test('13. DNC / unsubscribe / suppression still win over a Google recipient', async () => {
  const google = async () => ({ provider: PROVIDER.GOOGLE, domain: 'gmail.com' });
  const unsub = await finalGate(lead({ email: 'a@gmail.com', notes: '[REPLY: Unsubscribed]' }), { classifyRecipient: google, coldSender: healthy() });
  assert.equal(unsub.allowed, false);
  assert.equal(unsub.code, 'unsubscribed');
  const listed = await finalGate(lead({ email: 'a@gmail.com' }), { classifyRecipient: google, coldSender: healthy(), suppressed: new Set(['a@gmail.com']) });
  assert.equal(listed.code, 'suppressed');
  const replied = await finalGate(lead({ email: 'a@gmail.com', emailStatus: 'replied' }), { classifyRecipient: google, coldSender: healthy() });
  assert.equal(replied.code, 'terminal_state');
  const held = await finalGate(lead({ email: 'a@gmail.com', notes: '[MANUAL HOLD]' }), { classifyRecipient: google, coldSender: healthy() });
  assert.equal(held.code, 'manual_hold');
});

test('14. a provider hold changes nothing on the lead and admits nothing to the queue', async () => {
  const deepFreeze = obj => Object.freeze(obj);
  const held = deepFreeze(lead({ id: 'M1', email: 'pat@outlook.com', stage: 'Contacted', emailStatus: 'emailed', emailStep: '2', lastEmailedAt: '2026-10-01T00:00:00Z' }));
  const before = JSON.stringify(held);
  const { classifier } = classifierWith({});
  const admission = await admitByRecipientProvider([held], classifier, {});
  assert.equal(admission.allowed.size, 0);
  assert.deepEqual(admission.held.map(item => item.holdReason), [HOLD_REASON.MICROSOFT]);
  assert.equal(JSON.stringify(held), before);
  // The queue action refuses before any mutation.
  let applied = 0;
  const result = await queueSelectedLeads({ ids: ['M1'], senderInboxId: 'primary', emailTemplateId: 't', campaignVersionId: 'v' }, {
    loadState: async () => ({ leads: [lead({ id: 'M1', email: 'pat@outlook.com', stage: 'Import', campaign: 'c' })], activities: [], boardLeads: [] }),
    validateSelection: () => ({ ok: true }), applyChanges: async () => { applied++; return []; },
    admitRecipients: leads => admitByRecipientProvider(leads, classifier, {}),
  });
  assert.equal(result.status, 409);
  assert.equal(result.holdReason, HOLD_REASON.MICROSOFT);
  assert.equal(applied, 0);
  // Policy off: the same lead is admitted with no repair.
  assert.equal((await admitByRecipientProvider([held], classifier, { RECIPIENT_PROVIDER_POLICY: 'off' })).allowed.has('M1'), true);
});

test('15. the gate runs before any reservation and every existing send protection stays in order', () => {
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
  const step = agent.slice(agent.indexOf('async function deliverOrdinaryColdStep'), agent.indexOf('// Phase 4: mark a lead'));
  const at = needle => { const i = step.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  // provider-first recovery and the step-1 probe still precede; then the gate;
  // then the unresolved-reservation refusal, the reservation, the final guard, the send.
  assert.ok(at('findSuccessfulSequenceSend') < at('recipientProviderClassifier.classify(lead.email)'));
  assert.ok(at('stepOneAlreadySent') < at('coldDeliveryVerdict({ sender, classification: recipientProvider })'));
  assert.ok(at('coldDeliveryVerdict({ sender, classification: recipientProvider })') < at("row.eventType === 'ordinary_send_reserved'"));
  assert.ok(at('an unresolved delivery reservation exists') < at('await recordColdCallActivityStrict(reservation)'));
  assert.ok(at('await recordColdCallActivityStrict(reservation)') < at('guardProviderSend(lead'));
  assert.ok(at('guardProviderSend(lead') < at('result = await sendEmail('));
  assert.ok(at('if (!coldVerdict.allowed)') < at('const reservationEventId'));
  assert.match(step, /isDefinitePreDeliveryFailure\(error\)/);
  assert.match(step, /delivery outcome is ambiguous; reservation retained/);
  // Admission sits after selection, before batching; the selection lines are unchanged.
  const admit = agent.indexOf('admitByRecipientProvider([...queued, ...followUps], recipientProviderClassifier)');
  assert.ok(agent.indexOf('const queued = selectQueued(all)') < admit);
  assert.ok(agent.indexOf('const followUps = selectFollowUps(all, ownershipActivities)') < admit);
  assert.ok(admit < agent.indexOf('const newBatch    = fairShareQueuedOrder(queued'));
  // The server queue action and Smartlead route are wired to the same policy.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /admitRecipients: leads => admitByRecipientProvider\(leads, recipientProviderClassifier\)/);
  assert.match(server, /classifyRecipient: email => recipientProviderClassifier\.classify\(email\),\n      loadFreshLead/);
  const view = server.slice(server.indexOf("app.get('/api/ops/cold-delivery-gate'"), server.indexOf("app.get('/api/ops/mailbox-diagnostic'"));
  assert.doesNotMatch(view, /applyLeadChange|appendColdCallActivities|sendEmail|values\.(?:append|update)/);
});

// ── cache ────────────────────────────────────────────────────────────────────

test('16. one lookup per domain: cached reuse and concurrent de-duplication', async () => {
  const { classifier, calls } = classifierWith({ 'acme.com': mx('aspmx.l.google.com.') });
  const results = await Promise.all(['a@acme.com', 'b@acme.com', 'c@ACME.com'].map(email => classifier.classify(email)));
  assert.equal(calls.get('acme.com'), 1);
  assert.ok(results.every(result => result.provider === PROVIDER.GOOGLE));
  const again = await classifier.classify('d@acme.com');
  assert.equal(again.cache, 'hit');
  assert.equal(calls.get('acme.com'), 1);
  assert.equal(classifier.peek('e@acme.com').provider, PROVIDER.GOOGLE);
  assert.ok(classifier.stats().hits >= 1);
  const admission = await admitByRecipientProvider([lead({ id: 'x', email: 'x@acme.com' }), lead({ id: 'y', email: 'y@acme.com' })], classifier, {});
  assert.equal(admission.allowed.size, 2);
  assert.equal(calls.get('acme.com'), 1);
});

test('17. a stale entry refreshes; a failed refresh is UNKNOWN, never the stale GOOGLE', async () => {
  let clock = 0;
  let answer = mx('aspmx.l.google.com.');
  const { classifier, calls } = classifierWith(() => answer, { now: () => clock, ttlMs: 1000 });
  assert.equal((await classifier.classify('a@acme.com')).provider, PROVIDER.GOOGLE);
  clock = 500;
  assert.equal((await classifier.classify('a@acme.com')).cache, 'hit');
  clock = 1500; // expired
  answer = mx('acme-com.mail.protection.outlook.com.');
  assert.equal((await classifier.classify('a@acme.com')).provider, PROVIDER.MICROSOFT);
  assert.equal(calls.get('acme.com'), 2);
  clock = 3000; // expired again, and now the lookup fails
  answer = err('ESERVFAIL');
  assert.equal((await classifier.classify('a@acme.com')).provider, PROVIDER.UNKNOWN);
  clock = 100000;
  assert.equal(classifier.peek('a@acme.com').provider, PROVIDER.UNKNOWN);
});

test('18. a transient lookup failure never becomes GOOGLE, and recovers after its short TTL', async () => {
  let clock = 0;
  let answer = err('ETIMEOUT');
  const { classifier } = classifierWith(() => answer, { now: () => clock });
  const first = await classifier.classify('a@acme.com');
  assert.equal(first.provider, PROVIDER.UNKNOWN);
  assert.notEqual(providerVerdict(first, GOOGLE_POLICY).allowed, true);
  answer = mx('aspmx.l.google.com.');
  clock = 60 * 1000; // inside the 10-minute failure TTL: still UNKNOWN, no retry storm
  assert.equal((await classifier.classify('a@acme.com')).provider, PROVIDER.UNKNOWN);
  clock = 11 * 60 * 1000; // failure TTL elapsed: re-resolved, now Google
  assert.equal((await classifier.classify('a@acme.com')).provider, PROVIDER.GOOGLE);
});

// ── configuration and caps ───────────────────────────────────────────────────

test('policy flag: default and unrecognised values fail closed to google_only; off disables', () => {
  assert.equal(recipientProviderPolicy({}), 'google_only');
  assert.equal(recipientProviderPolicy({ RECIPIENT_PROVIDER_POLICY: 'block_microsoft' }), 'google_only');
  assert.equal(recipientProviderPolicy({ RECIPIENT_PROVIDER_POLICY: 'OFF' }), 'off');
  assert.equal(providerVerdict({ provider: PROVIDER.MICROSOFT }, { RECIPIENT_PROVIDER_POLICY: 'off' }).allowed, true);
  assert.equal(providerVerdict(null, {}).code, HOLD_REASON.UNKNOWN);
  assert.equal(classifyMxHosts('x.com', null).reason, 'no_mx');
});

test('cold inbox cap is a ceiling: lowers to 30, never raises, absent means unchanged', () => {
  assert.equal(coldInboxDailyCap({}), null);
  assert.equal(coldInboxDailyCap({ COLD_INBOX_DAILY_CAP: 'off' }), null);
  assert.equal(coldInboxDailyCap({ COLD_INBOX_DAILY_CAP: '30' }), 30);
  assert.equal(coldInboxDailyCap({ COLD_INBOX_DAILY_CAP: 'thirty' }), 30);
  const capped = applyColdInboxCap([{ id: 'a', dailyLimit: 60 }, { id: 'b', dailyLimit: 20 }, { id: 'c', dailyLimit: 30 }], { COLD_INBOX_DAILY_CAP: '30' });
  assert.deepEqual(capped.map(s => s.dailyLimit), [30, 20, 30]);
  assert.equal(capped[0].configuredDailyLimit, 60);
  const env = { FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '60', COLD_INBOX_DAILY_CAP: '30',
    GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([{ id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'paused', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 60, perRunLimit: 6 },
      { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'paused', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 20, perRunLimit: 2 }]) };
  const byId = Object.fromEntries(configuredSenders(env).map(sender => [sender.id, sender]));
  assert.equal(byId.primary.dailyLimit, 30);
  assert.equal(byId.tryscalelabai.dailyLimit, 30);
  assert.equal(byId.tryscalelabai.status, 'paused');
  assert.equal(byId.tryscalelabai.sendEligible, false);
  assert.equal(byId.deniels_tryscalelabai.dailyLimit, 20);
  const { COLD_INBOX_DAILY_CAP, ...uncapped } = env;
  assert.equal(Object.fromEntries(configuredSenders(uncapped).map(s => [s.id, s])).primary.dailyLimit, 60);
});

test('classification logs the domain and verdict, never a mailbox local-part or message body', async () => {
  const lines = [];
  const classifier = createProviderClassifier({ resolveMx: async () => mx('aspmx.l.google.com.'), logger: { log: line => lines.push(line) }, env: {} });
  await classifier.classify('secret.person@acme.com');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual([entry.event, entry.domain, entry.provider, entry.cache], ['recipient_provider_classified', 'acme.com', 'GOOGLE', 'miss']);
  assert.doesNotMatch(lines[0], /secret\.person/);
});
