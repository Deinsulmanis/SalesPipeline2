'use strict';
// ScaleLab fast reply mode. Synthetic fixtures only; the phone numbers here
// are reserved fictional 555-01xx numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fast = require('../integrations/scalelab-fast-reply');
const { sendOwnerSms, telnyxConfig } = require('../integrations/telnyx-sms');
const { queueRoutedReplies, dispatchDueAlerts } = require('../integrations/scalelab-reply-alerts');
const drafter = require('../integrations/scalelab-reply-drafter');
const { sendFromReplyScreen, saveToGmailDrafts, dismissReply } = require('../integrations/scalelab-reply-send');
const { createReplyProbe } = require('../integrations/gmail-reply-probe');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');

const FAKE_FROM = '+15555550100';
const FAKE_TO = '+15555550199';
const ENV = { SCALELAB_FAST_REPLY_ENABLED: 'true', SCALELAB_REPLY_SMS_ENABLED: 'true', TELNYX_API_KEY: 'test-key',
  TELNYX_FROM_NUMBER: FAKE_FROM, OWNER_ALERT_SMS_TO: FAKE_TO };
const ACTION = 'a'.repeat(64);
// 10:00 and 22:30 Pacific on 2026-11-25, from the runtime's own zone rules.
const pacificNow = (y, mo, d, h, mi = 0) => { for (let t = Date.UTC(y, mo - 1, d, h + 6, mi); ; t += 3600000) {
  const p = fast.pacificParts(new Date(t)); if (p.day === d && p.hour === h && p.minute === mi) return new Date(t); } };
const DAY = pacificNow(2026, 11, 25, 10);
const NIGHT = pacificNow(2026, 11, 25, 22, 30);

// ── SMS content ──────────────────────────────────────────────────────────────
test('the SMS names the prospect and links the reply screen, never the email body or address', () => {
  const link = fast.replyLink('https://dash.example', ACTION);
  const text = fast.smsText({ firstName: 'Pat', company: 'Example Staffing', intent: 'pricing_request', link });
  assert.equal(text, `Pat at Example Staffing replied (asked about pricing). Open: https://dash.example/#replies?id=${ACTION}`);
  const body = 'Hi Deins, how much does this cost per meeting? We place welders in Ohio.';
  assert.equal(fast.smsLeaksPersonal(text, { email: 'pat@agency.example', body }), false);
  // An address smuggled into a name is stripped, and the leak check would refuse it anyway.
  const sneaky = fast.smsText({ firstName: 'pat@agency.example', company: 'X', intent: 'interest', link });
  assert.doesNotMatch(sneaky, /@/);
  assert.equal(fast.smsLeaksPersonal('Pat said: how much does this cost per meeting? Open: x', { body }), true);
  assert.equal(fast.smsLeaksPersonal('reach pat@agency.example', {}), true);
});

// ── quiet hours ──────────────────────────────────────────────────────────────
// Expected times come from the runtime's own America/Vancouver rules (tzdata
// changes, e.g. permanent daylight time, must not break the test).
function pacificAt(year, month, day, hour, minute = 0) {
  for (let t = Date.UTC(year, month - 1, day, hour + 6, minute); t <= Date.UTC(year, month - 1, day, hour + 9, minute); t += 3600000) {
    const p = fast.pacificParts(new Date(t));
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return new Date(t);
  }
  throw new Error('no such Pacific time');
}
test('alerts go out 06:00-21:00 Pacific and are held to 06:00 otherwise', () => {
  const day = pacificAt(2026, 11, 25, 10);
  const night = pacificAt(2026, 11, 25, 22, 30);
  assert.equal(fast.inActiveHours(day), true);
  assert.equal(fast.inActiveHours(night), false);
  assert.equal(fast.nextAlertTime(day).toISOString(), day.toISOString());
  assert.equal(fast.nextAlertTime(night).toISOString(), pacificAt(2026, 11, 26, 6).toISOString());
  assert.equal(fast.nextAlertTime(pacificAt(2026, 11, 26, 5, 59)).toISOString(), pacificAt(2026, 11, 26, 6).toISOString());
  assert.equal(fast.inActiveHours(pacificAt(2026, 11, 25, 21)), false);
  assert.equal(fast.inActiveHours(pacificAt(2026, 11, 25, 20, 59)), true);
  assert.equal(fast.nextAlertTime(pacificAt(2026, 7, 14, 23)).toISOString(), pacificAt(2026, 7, 15, 6).toISOString());
});

// ── alert queue ──────────────────────────────────────────────────────────────
function memoryQueue() {
  const rows = new Map();
  return { rows,
    async get(id) { return rows.get(id) || null; },
    async enqueue(row) { if (!rows.has(row.action_id)) rows.set(row.action_id, { status: 'pending', alert_attempts: 0, draft_text: null, ...row }); return rows.get(row.action_id); },
    async listAlertsDue(now) { return [...rows.values()].filter(r => ['pending', 'queued'].includes(r.alert_status)
      && (!r.alert_send_after || Date.parse(r.alert_send_after) <= now.getTime())); },
    async listPending() { return [...rows.values()].filter(r => r.status === 'pending'); },
    async transition(id, expect, patch) {
      const row = rows.get(id);
      if (!row || Object.entries(expect).some(([k, v]) => (row[k] ?? null) !== v)) return null;
      Object.assign(row, patch); return { ...row };
    },
  };
}
const record = (extra = {}) => ({ action_id: ACTION, mode: 'apply', step: 'complete', lead_id: 'L1', message_id: 'M1', mailbox_id: 'primary',
  received_at: DAY.toISOString(), verdict: { intent: 'meeting_request' }, ...extra });
const leads = [{ id: 'L1', company: 'Example Staffing', campaign_notes: JSON.stringify({ var_first_name: 'Pat', var_company: 'Example Staffing' }) }];
const threads = new Map([[ACTION, { threadId: 'T1', text: 'Can we set up a call next week?' }]]);

test('routed alert-intent replies are queued once, with a draft; other intents, old replies and flags off are not', async () => {
  const store = memoryQueue();
  const make = createDraft => queueRoutedReplies({ records: [record(), record({ action_id: 'b'.repeat(64), verdict: { intent: 'unclear' } }),
    record({ action_id: 'c'.repeat(64), received_at: '2026-11-01T00:00:00Z' }), record({ action_id: 'd'.repeat(64), step: 'review' })],
  leads, threads, store, now: DAY, env: ENV, drafter: createDraft });
  const queued = await make(drafter.createReplyDrafter());
  assert.equal(queued.length, 1);
  const row = store.rows.get(ACTION);
  assert.equal(row.first_name, 'Pat');
  assert.match(row.draft_text, /calendar\.app\.google\/oFNAniV6HKqhSUR29/);
  await make(drafter.createReplyDrafter());
  assert.equal(store.rows.size, 1);
  assert.deepEqual(await queueRoutedReplies({ records: [record()], leads, threads, store: memoryQueue(), now: DAY, env: {} }), []);
});

test('exactly one SMS per reply, a retry once on failure, and quiet hours hold the alert to 06:00', async () => {
  const store = memoryQueue();
  await queueRoutedReplies({ records: [record()], leads, threads, store, now: DAY, env: ENV });
  const texts = [];
  const okSms = async text => { texts.push(text); return { sent: true, id: 'sms-1' }; };
  await dispatchDueAlerts({ store, sendSms: okSms, notify: async () => ({ sent: false }), now: DAY, env: ENV });
  await dispatchDueAlerts({ store, sendSms: okSms, notify: async () => ({ sent: false }), now: DAY, env: ENV });
  assert.equal(texts.length, 1);
  assert.equal(store.rows.get(ACTION).alert_status, 'sent');
  assert.doesNotMatch(texts[0], /Can we set up a call/);

  const retry = memoryQueue();
  await queueRoutedReplies({ records: [record()], leads, threads, store: retry, now: DAY, env: ENV });
  let attempts = 0;
  await dispatchDueAlerts({ store: retry, sendSms: async () => { attempts += 1; return attempts === 1 ? { sent: false, reason: 'telnyx_http_500' } : { sent: true }; },
    notify: async () => ({ sent: false }), now: DAY, env: ENV });
  assert.equal(attempts, 2);
  assert.equal(retry.rows.get(ACTION).alert_status, 'sent');

  const night = memoryQueue();
  await queueRoutedReplies({ records: [record({ received_at: NIGHT.toISOString() })], leads, threads, store: night, now: NIGHT, env: ENV });
  let nightSends = 0;
  await dispatchDueAlerts({ store: night, sendSms: async () => { nightSends += 1; return { sent: true }; }, notify: async () => ({ sent: false }), now: NIGHT, env: ENV });
  assert.equal(nightSends, 0);
  const sixAm = pacificNow(2026, 11, 26, 6);
  assert.equal(night.rows.get(ACTION).alert_send_after, sixAm.toISOString());
  await dispatchDueAlerts({ store: night, sendSms: async () => { nightSends += 1; return { sent: true }; }, notify: async () => ({ sent: false }),
    now: new Date(sixAm.getTime() + 30000), env: ENV });
  assert.equal(nightSends, 1);
});

test('a failing SMS and push never throw into reply processing', async () => {
  const store = memoryQueue();
  await queueRoutedReplies({ records: [record()], leads, threads, store, now: DAY, env: { ...ENV, OWNER_PUSH_URL: 'https://push.example/topic' } });
  const out = await dispatchDueAlerts({ store, sendSms: async () => ({ sent: false, reason: 'telnyx_network' }),
    notify: async () => { throw new Error('push down'); }, now: DAY, env: { ...ENV, OWNER_PUSH_URL: 'https://push.example/topic' } });
  assert.equal(out[0].alert_status, 'failed');
});

// ── Telnyx ───────────────────────────────────────────────────────────────────
test('the Telnyx request uses Messaging API v2 and env-only configuration', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ data: { id: 'msg-1' } }) }; };
  const result = await sendOwnerSms('hello', { env: { ...ENV, TELNYX_MESSAGING_PROFILE_ID: 'profile-1' }, fetchImpl });
  assert.deepEqual(result, { sent: true, id: 'msg-1' });
  assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: FAKE_FROM, to: FAKE_TO, text: 'hello', messaging_profile_id: 'profile-1' });
  assert.equal((await sendOwnerSms('x', { env: {}, fetchImpl: async () => { throw new Error('no'); } })).sent, false);
  assert.deepEqual(telnyxConfig({}).missing, ['TELNYX_API_KEY', 'TELNYX_FROM_NUMBER', 'OWNER_ALERT_SMS_TO']);
});

// ── drafter ──────────────────────────────────────────────────────────────────
test('the drafter writes only for alert intents, keeps the booking link and turns unknown facts into placeholders', async () => {
  const make = drafter.createReplyDrafter({ engine: async () => ({ text: 'Thanks. See https://evil.example for details.\n\nDeins', source: 'test' }) });
  for (const intent of ['opt_out', 'explicit_rejection', 'unclear', 'acknowledgment']) assert.equal(await make({ intent, firstName: 'Pat' }), null);
  const meeting = await make({ intent: 'meeting_request', firstName: 'Pat' });
  assert.match(meeting.text, /^Hi Pat,\n/);
  assert.match(meeting.text, /https:\/\/calendar\.app\.google\/oFNAniV6HKqhSUR29/);
  assert.doesNotMatch(meeting.text, /evil\.example/);
  assert.match(meeting.text, /\[FILL: link\]/);
  assert.match(meeting.text, /\n\nDeins$/);
  const failing = drafter.createReplyDrafter({ engine: async () => { throw new Error('budget'); } });
  const pricing = await failing({ intent: 'pricing_request', firstName: '' });
  assert.match(pricing.text, /^Hi there,/);
  assert.match(pricing.text, /\[FILL: pricing answer\]/);
  assert.equal(pricing.source, 'template_v0');
  assert.match(drafter.loadRules(), /\[FILL:/);
});

// ── reply screen actions ─────────────────────────────────────────────────────
function screenDeps({ notes = '[MANUAL HOLD]', latestId = 'M1', sendImpl } = {}) {
  const store = memoryQueue();
  store.rows.set(ACTION, { action_id: ACTION, status: 'pending', lead_id: 'L1', message_id: 'M1', thread_id: 'T1', mailbox_id: 'primary', alert_attempts: 0 });
  const sent = [];
  const activities = [];
  const holds = [];
  const lead = { id: 'L1', email: 'pat@agency.example', company: 'Example Staffing', clientId: 'scalelab', notes, stage: 'Follow Up', emailStatus: 'replied' };
  const message = (id, internalDate, headers) => ({ id, internalDate, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
  const gmail = { users: {
    threads: { get: async () => ({ data: { messages: [
      message('OUT1', '1', { 'Message-ID': '<out1@scalelab.example>', Subject: 'Employer accounts for Example Staffing' }),
      message('M1', '2', { 'Message-ID': '<in1@agency.example>', References: '<out1@scalelab.example>', Subject: 'Re: Employer accounts for Example Staffing' }),
      ...(latestId !== 'M1' ? [message(latestId, '3', { 'Message-ID': '<in2@agency.example>' })] : []),
    ] } }) },
    messages: { send: sendImpl || (async request => { sent.push(request); return { data: { id: 'G1', threadId: 'T1' } }; }) },
    drafts: { create: async request => { sent.push({ draft: request }); return { data: { id: 'D1' } }; } },
  } };
  const deps = { store, gmail, sender: { id: 'primary', email: 'deins@scalelab.example', fromName: 'Deins' }, env: { SENDING_ENABLED: 'true' },
    readLead: async () => ({ lead, current: lead, suppressedEmails: new Set() }),
    withGmailProviderSend: async ({ run }) => run(), confirmReservation: async () => ({ ok: true }),
    ownership: () => ({ clientId: 'scalelab' }), recordActivity: async event => activities.push(event), ensureHold: async l => holds.push(l.id) };
  return { deps, store, sent, activities, holds };
}
const decode = raw => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('Send is blocked while any [FILL: ...] remains', async () => {
  const { deps, sent } = screenDeps();
  const result = await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi Pat,\n\nIt costs [FILL: pricing answer].\n\nDeins', deps });
  assert.deepEqual([result.ok, result.code], [false, 'placeholder_present']);
  assert.equal(sent.length, 0);
});

test('Send replies in the same thread with correct In-Reply-To and References, logs a human reply and keeps the hold', async () => {
  const { deps, sent, activities, holds, store } = screenDeps();
  const result = await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi Pat,\n\nThanks for the note.\n\nDeins', deps });
  assert.equal(result.ok, true);
  assert.equal(sent[0].requestBody.threadId, 'T1');
  const raw = decode(sent[0].requestBody.raw);
  assert.match(raw, /\r\nIn-Reply-To: <in1@agency\.example>\r\n/);
  assert.match(raw, /\r\nReferences: <out1@scalelab\.example> <in1@agency\.example>\r\n/);
  assert.match(raw, /\r\nSubject: Re: Employer accounts for Example Staffing\r\n/);
  assert.match(raw, /\r\nTo: pat@agency\.example\r\n/);
  assert.equal(activities[0].eventType, 'human_response_sent');
  assert.equal(JSON.parse(activities[0].metadata).trigger, 'reply_screen');
  assert.deepEqual(holds, ['L1']);
  assert.equal(store.rows.get(ACTION).status, 'sent');
  const again = await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi Pat,\n\nAgain.\n\nDeins', deps });
  assert.equal(again.code, 'not_pending');
  assert.equal(sent.length, 1);
});

test('Send refuses opted-out leads and newer thread activity; an uncertain send is never retried', async () => {
  const optedOut = screenDeps({ notes: '[MANUAL HOLD] [REPLY: Unsubscribed]' });
  assert.equal((await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi.\n\nDeins', deps: optedOut.deps })).code, 'unsubscribed');
  const newer = screenDeps({ latestId: 'M2' });
  assert.equal((await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi.\n\nDeins', deps: newer.deps })).code, 'newer_thread_activity');
  const uncertain = screenDeps({ sendImpl: async () => { const e = new Error('socket hang up'); throw e; } });
  assert.equal((await sendFromReplyScreen({ actionId: ACTION, draftText: 'Hi.\n\nDeins', deps: uncertain.deps })).code, 'outcome_uncertain');
  assert.equal(uncertain.store.rows.get(ACTION).status, 'sending');
});

test('the human_reply gate passes a held lead; warm and cold still refuse it', () => {
  const lead = { id: 'L1', email: 'pat@agency.example', clientId: 'scalelab', notes: '[MANUAL HOLD]', stage: 'Follow Up', emailStatus: 'replied' };
  assert.equal(evaluateFreshSendSafety(lead, lead, new Set(), { purpose: 'human_reply', env: {} }).allowed, true);
  assert.equal(evaluateFreshSendSafety(lead, lead, new Set(), { purpose: 'warm', env: {} }).code, 'manual_hold');
  // Held AND on the Suppression list: the list still refuses (regression: the hold used to mask it).
  assert.equal(evaluateFreshSendSafety(lead, lead, new Set(['pat@agency.example']), { purpose: 'human_reply', env: {} }).code, 'suppressed');
  const bounced = { ...lead, notes: '[MANUAL HOLD] [BOUNCED 2026-11-01]' };
  assert.equal(evaluateFreshSendSafety(bounced, bounced, new Set(), { purpose: 'human_reply', env: {} }).code, 'bounced');
});

test('Save to Gmail drafts creates a draft in the thread and sends nothing; Dismiss closes the row', async () => {
  const { deps, sent, store } = screenDeps();
  const result = await saveToGmailDrafts({ actionId: ACTION, draftText: 'Hi Pat,\n\n[FILL: answer]\n\nDeins', deps });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].draft && sent[0].draft.requestBody.message.threadId === 'T1');
  assert.equal(store.rows.get(ACTION).status, 'gmail_draft');
  const other = screenDeps();
  assert.equal((await dismissReply({ actionId: ACTION, deps: other.deps })).ok, true);
  assert.equal(other.store.rows.get(ACTION).status, 'dismissed');
});

// ── fast detection probe ─────────────────────────────────────────────────────
test('the probe starts from the current position, counts only new INBOX messages and recovers from expired history', async () => {
  let history = { history: [], historyId: '101' };
  let profileCalls = 0;
  const gmail = { users: {
    getProfile: async () => { profileCalls += 1; return { data: { historyId: '100' } }; },
    history: { list: async () => { if (history === 'expired') { const e = new Error('gone'); e.code = 404; throw e; } return { data: history }; } },
  } };
  const probe = createReplyProbe({ listInboxes: () => [{ id: 'primary' }], gmailFor: () => gmail });
  assert.equal((await probe()).initialized, 1);
  history = { historyId: '105', history: [{ messagesAdded: [{ message: { id: 'a', labelIds: ['INBOX', 'UNREAD'] } },
    { message: { id: 'b', labelIds: ['SENT'] } }, { message: { id: 'c', labelIds: ['DRAFT'] } }] }] };
  assert.equal((await probe()).newInbound, 1);
  history = { historyId: '106', history: [] };
  assert.equal((await probe()).newInbound, 0);
  history = 'expired';
  assert.equal((await probe()).errors, 1);
  history = { historyId: '200', history: [] };
  await probe();
  assert.equal(profileCalls, 2);
});

// ── repository hygiene ───────────────────────────────────────────────────────
test('no real phone number or owner number lives in the fast reply code, docs or env example', () => {
  const root = path.join(__dirname, '..');
  const files = ['integrations/scalelab-fast-reply.js', 'integrations/telnyx-sms.js', 'integrations/scalelab-reply-alerts.js',
    'integrations/scalelab-reply-drafter.js', 'integrations/scalelab-reply-send.js', 'integrations/scalelab-reply-queue-store.js',
    'integrations/gmail-reply-probe.js', 'docs/skills/scalelab-reply-drafting/RULES.md', 'docs/scalelab-fast-reply.md',
    'supabase/migrations/20261125120000_scalelab_reply_queue.sql', 'test/scalelab-fast-reply.test.js', '.env.example'];
  const phone = /\+?1?[\s.(-]*[2-9]\d{2}[\s.)-]*\d{3}[\s.-]*\d{4}\b/g;
  // The existing public business signature line (SIGNATURE_PHONE) is the only allowed number.
  const signature = (fs.readFileSync(path.join(root, '.env.example'), 'utf8').match(/^SIGNATURE_PHONE=(.*)$/m) || [])[1] || '';
  const signatureDigits = signature.replace(/\D/g, '');
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    // Fictional 555 numbers only.
    const real = (text.match(phone) || []).filter(n => !/555/.test(n) && !(file === '.env.example' && signatureDigits && n.replace(/\D/g, '') === signatureDigits));
    assert.deepEqual(real, [], `${file} must not contain a real phone number`);
  }
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(env, /^OWNER_ALERT_SMS_TO=$/m, 'the owner number is set in Railway only');
  assert.match(env, /^SCALELAB_FAST_REPLY_ENABLED=false$/m);
  assert.match(env, /^SCALELAB_REPLY_SMS_ENABLED=false$/m);
});

test('the Replies workspace is registered for ScaleLab and the browser blocks Send while a placeholder remains', () => {
  const root = path.join(__dirname, '..');
  const { WORKSPACE_IDS } = require('../integrations/clients/navigation');
  assert.ok(WORKSPACE_IDS.includes('replies'));
  const configs = fs.readFileSync(path.join(root, 'integrations/clients/client-configs.js'), 'utf8');
  assert.match(configs, /'inbox', 'replies', 'bookings'/);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /data-workspace="replies"/);
  assert.match(html, /if \(name === 'replies'\) return loadRepliesWorkspace\(\);/);
  assert.match(html, /const REPLY_PLACEHOLDER = \/\\\[FILL:\[\^\\\]\]\*\\\]\/i;/);
  assert.match(html, /if \(send\) send\.disabled = blocked;/);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const route of ['/api/scalelab/replies', '/api/scalelab/replies/:id', '/api/scalelab/replies/:id/send',
    '/api/scalelab/replies/:id/gmail-draft', '/api/scalelab/replies/:id/dismiss']) {
    assert.ok(server.includes(`'${route}', requireAuth`), `${route} is behind the dashboard auth`);
  }
  assert.match(server, /cron\.schedule\('\*\/2 6-20 \* \* \*'/);
  assert.match(server, /if \(!fastReplyConfig\(\)\.enabled \|\| fastReplyInFlight \|\| !inActiveHours\(\)\) return;/);
});
