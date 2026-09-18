'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STAFFING_CAMPAIGN, LOCKED_EMAILS, renderStaffingEmail, validateStaffingEmail,
} = require('../integrations/staffing-campaign');
const {
  STAFFING_CAMPAIGN_REF, STAFFING_REF_LINE, STAFFING_UNSUBSCRIBE_LINE,
  STAFFING_COMMERCIAL_NOTICE, STAFFING_OPT_OUT_LINE, STAFFING_GMAIL_FILTER_QUERY,
  MISSING_COMMERCIAL_MAILING_ADDRESS, isValidCommercialMailingAddress,
  resolveCommercialMailingAddress, formatStaffingComplianceFooter,
} = require('../integrations/staffing-compliance');
const { classifyReply } = require('../integrations/reply-classifier');
const { classifyReplyText, hasExplicitUnsubscribePhrase } = require('../integrations/canonical-reply');
const { sendSuppressionReason } = require('../integrations/pipeline-state');
const { evaluateFreshSendSafety, guardProviderSend } = require('../integrations/send-safety-revalidate');
const { evaluateStageSequence } = require('../integrations/stage-sequences');
const { queueEligibility } = require('../integrations/outreach-queue');
const { REQUIRED_WORKER_ROLE } = require('../integrations/send-authorization');
const { ACTIVATION_VARIABLE } = require('../integrations/staffing-launch-gate');
const { STAFFING_RENDER_OPTIONS, TEST_STAFFING_MAILING_ADDRESS } = require('../test-support/staffing-mail');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const OPENING = 'Saw you place welders and machinists for manufacturers.';
const staffingLead = (over = {}) => ({
  id: 'lead-999888777', company: 'Acme Staffing', contactName: 'Ada Byron', firstName: 'Ada',
  email: 'ada@acmestaffing.com', stage: 'Queued', emailStatus: '', emailStep: '', notes: '',
  siteContext: OPENING, campaign: STAFFING_CAMPAIGN.name,
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
  leadNiche: 'industrial_staffing', senderInboxId: 'primary', routingRequired: 'true', ...over,
});
const render = (step, over = {}) => renderStaffingEmail(staffingLead(over), step, STAFFING_RENDER_OPTIONS);
const PHRASES = [
  'unsubscribe',
  'remove me',
  'remove us',
  'take me off your list',
  'remove us from your mailing list',
  'stop emailing me',
  "please don't contact me again",
];

test('1-3. Emails 1-3 contain the unsubscribe footer beneath the locked copy', () => {
  const cores = [
    `Hi Ada,\n\n${OPENING}\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for Acme Staffing?\n\n— Deins`,
    `Hi Ada,\n\nJust to clarify — we're not talking about candidate sourcing.\n\nWe run a 30-day employer acquisition pilot built around the roles Acme Staffing already places.\n\nWe handle the prospecting, outreach and qualification, then put interested employers directly on your calendar.\n\nIf we don't generate qualified employer meetings, there are no meeting fees.\n\nYou can see how it works here:\nhttps://scalelabai.ca/staffing/\n\nOpen to seeing what this could look like for Acme Staffing?`,
    'Hi Ada,\n\nQuick question —\n\nis bringing in more employer accounts something Acme Staffing is focused on right now?',
  ];
  for (const step of [1, 2, 3]) {
    const email = render(step);
    assert.equal(validateStaffingEmail({ ...email, leadId: 'lead-999888777' }, step), null);
    assert.ok(email.body.startsWith(cores[step - 1]));
    assert.ok(email.body.includes(STAFFING_UNSUBSCRIBE_LINE), `step ${step} missing unsubscribe`);
    assert.ok(email.body.includes(STAFFING_COMMERCIAL_NOTICE), `step ${step} missing commercial notice`);
    assert.doesNotMatch(email.body, /{{|}}/);
    assert.doesNotMatch(email.body, /receptionist|missed calls?|dental|patients?|clinic/i);
    assert.equal(email.body.split(STAFFING_UNSUBSCRIBE_LINE).length - 1, 1);
  }
  assert.equal(LOCKED_EMAILS[0].includes(STAFFING_UNSUBSCRIBE_LINE), false, 'locked copy itself stays footer-free');
});

test('4-6. every staffing message uses identical Ref: SA-48271 after unsubscribe', () => {
  const refs = [];
  for (const step of [1, 2, 3]) {
    const email = render(step);
    assert.equal((email.body.match(/Ref: SA-48271/g) || []).length, 1);
    assert.equal((email.body.match(/SA-48271/g) || []).length, 1);
    assert.equal((email.html.match(/SA-48271/g) || []).length, 1);
    assert.ok(email.body.trim().endsWith(STAFFING_REF_LINE));
    const unsubAt = email.body.indexOf(STAFFING_UNSUBSCRIBE_LINE);
    const refAt = email.body.indexOf(STAFFING_REF_LINE);
    assert.ok(unsubAt >= 0 && refAt > unsubAt, `step ${step} reference must follow unsubscribe`);
    refs.push(email.body.slice(refAt).trim());
  }
  assert.equal(new Set(refs).size, 1);
  assert.equal(refs[0], STAFFING_REF_LINE);
  assert.equal(STAFFING_CAMPAIGN_REF, 'SA-48271');
  assert.equal(STAFFING_GMAIL_FILTER_QUERY, '"SA-48271"');
});

test('7. footer does not expose a raw lead id', () => {
  for (const step of [1, 2, 3]) {
    const email = render(step);
    const footer = email.body.slice(email.body.indexOf('ScaleLabAi'));
    assert.doesNotMatch(footer, /lead-999888777/);
    assert.doesNotMatch(footer, /\bCE-/);
    assert.doesNotMatch(footer, /Ref: SL-/);
    assert.doesNotMatch(email.subject || '', /SA-48271|lead-999888777/);
  }
});

test('8. obvious staffing unsubscribe uses zero Claude calls', async () => {
  let calls = 0;
  const createMessage = async () => { calls += 1; throw new Error('model must not run'); };
  for (const phrase of PHRASES) {
    assert.equal(hasExplicitUnsubscribePhrase(phrase), true, phrase);
    assert.equal(classifyReplyText(phrase).reason, 'unsubscribe_request', phrase);
    assert.equal(await classifyReply({ plainTextReply: phrase, createMessage }), 'UNSUBSCRIBE', phrase);
  }
  assert.equal(calls, 0);
});

test('9-11. unsubscribe creates/preserves global suppression and is idempotent', () => {
  const lead = staffingLead({ emailStatus: 'emailed', emailStep: '1' });
  const suppressed = new Set([lead.email]);
  const tagged = { ...lead, stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed]' };

  assert.equal(sendSuppressionReason(lead, { suppressedEmails: suppressed }), 'suppression-list');
  assert.equal(sendSuppressionReason(tagged, { suppressedEmails: new Set() }), '[REPLY: Unsubscribed]');
  assert.equal(sendSuppressionReason(tagged, { suppressedEmails: suppressed }), '[REPLY: Unsubscribed]');

  const dentalTwin = { id: 'D9', email: lead.email, leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', notes: '' };
  assert.equal(sendSuppressionReason(dentalTwin, { suppressedEmails: suppressed }), 'suppression-list',
    'staffing opt-out suppresses the address across campaigns');

  for (const purpose of ['cold', 'sequence', 'warm']) {
    const safety = evaluateFreshSendSafety(lead, tagged, suppressed, {
      purpose,
      env: { [ACTIVATION_VARIABLE]: '2026-09-01T00:00:00.000Z' },
    });
    assert.equal(safety.allowed, false, purpose);
    assert.match(safety.code, /unsubscribed|suppressed/);
  }

  assert.equal(queueEligibility(tagged, {
    leads: [tagged], suppressedEmails: suppressed, ...STAFFING_RENDER_OPTIONS,
  }).ok, false);

  const sequence = evaluateStageSequence({
    boardLead: { stage: 'hot' }, twin: tagged, featureEnabled: true, suppressedEmails: suppressed,
    activities: [{ eventType: 'sequence_enrolled', occurredAt: '2026-09-01T00:00:00.000Z', metadata: JSON.stringify({ sequenceId: 'hot_stale_v1' }) }],
  });
  assert.equal(sequence.eligible, false);

  const agent = read('outreach-agent.js');
  assert.match(agent, /if \(!e \|\| SUPPRESSED_EMAILS\.has\(e\)\) return;/);
  const handler = agent.slice(agent.indexOf('async function handleUnsubscribe'), agent.indexOf('async function handleOutOfOffice'));
  assert.match(handler, /already Unsub; suppression confirmed/);
  assert.match(handler, /await addSuppression\(lead\.email, 'unsubscribe', lead\.company, 'reply-auto'\)/);
  assert.match(agent, /if \(classification === 'UNSUBSCRIBE'\) return handleUnsubscribe\(lead\);/);
  assert.ok(!/auto.?unsuppress|suppressedAt \+|expires?At/.test(agent), 'unsubscribe must not auto-expire');
});

test('12. compliance footer does not affect subject or thread identity', () => {
  assert.equal(render(1).subject, 'employer accounts');
  assert.equal(render(2).subject, null);
  assert.equal(render(3).subject, null);
  assert.doesNotMatch(render(1).subject, /SA-48271/);
  assert.match(validateStaffingEmail({ subject: 'employer accounts SA-48271', body: render(1).body }, 1) || '', /must not contain the campaign reference/);
  const agent = read('outreach-agent.js');
  assert.match(agent, /if \(lead\.emailTemplateId === STAFFING_TEMPLATE\) \{\n\s*try \{ body = staffingFollowUpBody\(lead, nextStepNum\); \}/);
});

test('13. dental campaign templates are not modified', () => {
  const dental = read('integrations/dental-email.js');
  const dentalSubject = read('integrations/dental-subject.js');
  assert.doesNotMatch(dental, /SA-48271|STAFFING_REF_LINE|industrial staffing/);
  assert.doesNotMatch(dentalSubject, /SA-48271/);
  assert.match(dental, /Reply with\\n"unsubscribe" and I'll remove you immediately/);
  assert.match(dental, /Ref: \$\{reference\}/);
  assert.equal(fs.readFileSync(path.join(root, 'integrations/dental-email.js'), 'utf8').includes('SA-48271'), false);
});

test('14. fail-closed mailing address, global send-lock, and Gmail body preservation', () => {
  assert.equal(isValidCommercialMailingAddress('ScaleLab AI, New Westminster, BC'), false);
  assert.equal(isValidCommercialMailingAddress('Your Company, Your City, Province'), false);
  assert.equal(isValidCommercialMailingAddress(TEST_STAFFING_MAILING_ADDRESS), true);
  assert.equal(isValidCommercialMailingAddress('PO Box 123, New Westminster, BC V3L 1A1'), true);
  assert.throws(() => resolveCommercialMailingAddress({}), error => error.code === MISSING_COMMERCIAL_MAILING_ADDRESS);
  assert.throws(() => renderStaffingEmail(staffingLead(), 1, { env: { MAILING_ADDRESS: 'ScaleLab AI, New Westminster, BC' } }),
    /commercial mailing address/);

  const footer = formatStaffingComplianceFooter(STAFFING_RENDER_OPTIONS);
  assert.ok(footer.startsWith('ScaleLabAi\n1 Harbour Street, New Westminster, BC V3L 1A1\nscalelabai.ca'));
  assert.ok(footer.includes(STAFFING_OPT_OUT_LINE));
  assert.ok(footer.trim().endsWith(STAFFING_REF_LINE));
  assert.equal(footer.indexOf(STAFFING_OPT_OUT_LINE) < footer.indexOf(STAFFING_REF_LINE), true);

  const email = render(1);
  assert.doesNotMatch(email.html, /font-size:\s*1px|color:\s*#fff{3,6}|display:\s*none/i);
  assert.match(email.html, /SA-48271/);
  assert.ok(!email.body.includes('https://scalelabai.ca/staffing/'));

  const sendLock = read('test/send-lock-concurrency.test.js');
  assert.match(sendLock, /SEND_LOCK_ENABLED/);
});

test('fresh-send safety still checks suppression immediately before provider send', async () => {
  const lead = staffingLead({ emailStatus: 'emailed', emailStep: '1' });
  const result = await guardProviderSend(lead, {
    env: {
      SENDING_ENABLED: 'true',
      RAILWAY_ENVIRONMENT: 'prod-sender',
      SEND_AUTHORIZED_ENV: 'prod-sender',
      SEND_AUTHORIZED_TOKEN: 'test-sender-token',
      SEND_WORKER_ROLE: REQUIRED_WORKER_ROLE,
      SEND_LOCK_ENABLED: 'true',
      [ACTIVATION_VARIABLE]: '2026-09-01T00:00:00.000Z',
    },
    loadFreshState: async () => ({
      current: { ...lead, notes: '[REPLY: Unsubscribed]', stage: 'Unsub', emailStatus: 'done' },
      suppressedEmails: new Set([lead.email]),
    }),
  }, { purpose: 'cold' });
  assert.equal(result.allowed, false);
});
