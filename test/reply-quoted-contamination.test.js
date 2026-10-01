'use strict';

// Quoted-thread contamination of reply classification.
//
// Production, 2026-09-25: a staffing prospect answered from iPhone Mail with
// "If you only get paid for meetings I would like more info please". The
// message was multipart/alternative carrying text/html ONLY. firstPlainText()
// returned '', the observer fell back to the raw HTML, and stripQuotedReply()
// — line markers only — never cut it, because Apple Mail puts "On … wrote:"
// mid-line inside <blockquote type="cite">. The classifier therefore read our
// own quoted cold email, whose footer says Reply "unsubscribe", and a positive
// reply was suppressed and marked Unsub. The fixture below keeps that exact
// structure and the prospect's exact words; signature details are placeholders.
//
// Rule under test: a classifier reads ONLY the prospect's own words. Our
// quoted email, footer and compliance copy never produce a signal, and the
// provider message itself is left untouched for audit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { firstPlainText, decodeBodies } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents, ownReplyText } = require('../integrations/mailbox-observation-events');
const { stripQuotedReply } = require('../integrations/reply-reconciliation');
const {
  classifyReplyText, hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase, REPLY_STATE,
} = require('../integrations/canonical-reply');
const { deterministicReplyCategory, classifyReplyDetailed } = require('../integrations/reply-classifier');
const { interpretInboundReply, ROUTE } = require('../integrations/reply-decision');
const { recordedTerminalReply } = require('../integrations/inbound-reply-guard');
const { processLateReply } = require('../integrations/late-reply');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const b64 = text => Buffer.from(text, 'utf8').toString('base64url');
const SENDER = 'deins@scalelabai.ca';
const PROSPECT = 'jordan@example-enterprise.test';
const OWN = 'If you only get paid for meetings I would like more info please';
const FOOTER = 'This is a commercial email. Not relevant? Reply "unsubscribe" and I won\'t follow up again.';

const lead = {
  id: 'staff-jole', company: 'Example Enterprise', email: PROSPECT, stage: 'Contacted',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-09-25T17:32:07.433Z', senderInboxId: 'primary',
  campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  leadNiche: 'industrial_staffing', intendedCampaignVersion: STAFFING_CAMPAIGN.id, notes: '',
};

// Our cold email as a prospect's client quotes it. Deliberately rich in the
// words that would fool a classifier: an opt-out, pricing, meetings, interest.
const OUTBOUND_PARAGRAPHS = [
  'Hi Jordan,',
  'Saw you place pipe fitters and welders for industrial construction contractors.',
  'We help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.',
  'Interested? Happy to send more info and pricing, or book a quick meeting.',
  'Worth seeing how we\'d do this for Example Enterprise?',
  '— Deins',
  FOOTER,
  'Ref: SA-48271',
];
const QUOTED_PLAIN = OUTBOUND_PARAGRAPHS.map(line => `> ${line}`).join('\n>\n');
const QUOTED_HTML = OUTBOUND_PARAGRAPHS.map(line => `<p>${line.replace(/"/g, '&quot;')}</p>`).join('\n');

// The production message, byte-for-byte in structure.
function appleMailHtml(own = OWN) {
  return `<html class="apple-mail-supports-explicit-dark-mode"><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body dir="auto">${own}&nbsp;<div><br id="lineBreakAtBeginningOfSignature"><div dir="ltr"><div class="">Our Job Is to make Yours Easier&nbsp;</div><div class=""><span style="font-size: 23pt;">Best Regards,</span></div><div class="">Jordan Example</div><div class="">President&nbsp;</div><div class="">Example Enterprise LLC&nbsp;</div><div class="">(555)010-0100</div><div class="">${PROSPECT}</div><div class=""><span style="background-color: rgba(255, 255, 255, 0);"><br></span></div><div><br></div><div><br></div></div><div dir="ltr"><br><blockquote type="cite">On Sep 25, 2026, at 12:32 PM, Scalelabai &lt;${SENDER}&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">﻿${QUOTED_HTML}\n</div></blockquote></div></body></html>`;
}

const gmailHtml = own => `<div dir="ltr">${own}</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Thu, Sep 25, 2026 at 12:32 PM Scalelabai &lt;<a href="mailto:${SENDER}">${SENDER}</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${QUOTED_HTML}</blockquote></div>`;
// Gmail wraps a long attribution across two lines in text/plain.
const gmailPlain = own => `${own}\r\n\r\nOn Thu, Sep 25, 2026 at 12:32 PM Scalelabai <${SENDER}>\r\nwrote:\r\n\r\n${QUOTED_PLAIN.split('\n').join('\r\n')}\r\n`;
const outlookWebHtml = own => `<html><head><style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style></head><body dir="ltr"><div class="elementToProof" style="font-family: Aptos, sans-serif;">${own}</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt"><b>From:</b> Scalelabai &lt;${SENDER}&gt;<br><b>Sent:</b> Thursday, September 25, 2026 12:32 PM<br><b>Subject:</b> employer accounts</font><div>&nbsp;</div></div><div>${QUOTED_HTML}</div></body></html>`;
// Outlook desktop: a Word <style> head far longer than the old 1,500-char cut,
// and a From:/Sent: block with no quote container at all.
const outlookDesktopHtml = own => `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style><!--\n${'@font-face {font-family:"Cambria Math"; panose-1:2 4 5 3 5 4 6 3 2 4;}\n'.repeat(40)}--></style></head><body lang="EN-US"><div class="WordSection1"><p class="MsoNormal">${own}<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Scalelabai &lt;${SENDER}&gt;<br><b>Sent:</b> Thursday, September 25, 2026 12:32 PM<br><b>To:</b> Jordan &lt;${PROSPECT}&gt;<br><b>Subject:</b> employer accounts<o:p></o:p></p></div>${QUOTED_HTML}</div></body></html>`;
const outlookPlain = own => `${own}\r\n\r\nFrom: Scalelabai <${SENDER}>\r\nSent: Thursday, September 25, 2026 12:32 PM\r\nTo: Jordan <${PROSPECT}>\r\nSubject: employer accounts\r\n\r\n${OUTBOUND_PARAGRAPHS.join('\r\n\r\n')}`;
// A Gmail snippet: the preview flattens everything onto one line.
const flattenedSnippet = own => `${own} On Sep 25, 2026, at 12:32 PM, Scalelabai <${SENDER}> wrote: ${OUTBOUND_PARAGRAPHS.join(' ')}`;

function inboundMessage({ id = 'in-jorge', html, text, snippet = '' }) {
  const parts = [
    ...(text !== undefined ? [{ mimeType: 'text/plain', body: { data: b64(text) } }] : []),
    ...(html !== undefined ? [{ mimeType: 'text/html', body: { data: b64(html) } }] : []),
  ];
  return {
    id, threadId: 'thread-jorge', internalDate: String(Date.parse('2026-09-25T17:47:15.000Z')),
    labelIds: ['INBOX'], snippet,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: `Jordan Example <${PROSPECT}>` }, { name: 'To', value: `Scalelabai <${SENDER}>` },
        { name: 'Subject', value: 'Re: employer accounts' },
        { name: 'Message-Id', value: '<D548E629-FIXTURE@example-enterprise.test>' },
      ],
      parts,
    },
  };
}

const JORGE_SNIPPET = `${OWN} Our Job Is to make Yours Easier Best Regards, Jordan Example President Example Enterprise LLC (555)010-0100 ${PROSPECT} On Sep`;
const jorgeMessage = () => inboundMessage({ html: appleMailHtml(), snippet: JORGE_SNIPPET });
const classify = text => classifyReplyText(text, { subject: 'Re: employer accounts', currentEmail: PROSPECT });

// Every client format, for a given own-words reply.
const FORMATS = {
  'Apple Mail HTML-only (blockquote type=cite)': own => ownReplyText(inboundMessage({ html: appleMailHtml(own) }).payload),
  'Gmail HTML (div.gmail_quote)': own => ownReplyText(inboundMessage({ html: gmailHtml(own) }).payload),
  'Gmail text/plain (wrapped attribution, > quotes)': own => ownReplyText(inboundMessage({ text: gmailPlain(own), html: gmailHtml(own) }).payload),
  'Outlook web HTML (#divRplyFwdMsg)': own => ownReplyText(inboundMessage({ html: outlookWebHtml(own) }).payload),
  'Outlook desktop HTML (From:/Sent: block, long style head)': own => ownReplyText(inboundMessage({ html: outlookDesktopHtml(own) }).payload),
  'Outlook text/plain (From:/Sent: header block)': own => ownReplyText(inboundMessage({ text: outlookPlain(own) }).payload),
  'flattened Gmail snippet': own => ownReplyText({ mimeType: 'multipart/alternative', parts: [] }, flattenedSnippet(own)),
};

// ── The production failure, reproduced and fixed ───────────────────────────

test('Jorge: the message has no text/plain part, and the raw provider copy carries our footer', () => {
  const message = jorgeMessage();
  assert.equal(firstPlainText(message.payload), '', 'iPhone Mail sent text/html only');
  const raw = decodeBodies(message.payload);
  assert.match(raw, /Reply &quot;unsubscribe&quot; and I won't follow up again/);
  assert.match(raw, /<blockquote type="cite">On Sep 25, 2026, at 12:32 PM/);
});

test('Jorge: classifier input is only his own words, never the quoted cold email', () => {
  const text = ownReplyText(jorgeMessage().payload, JORGE_SNIPPET);
  assert.ok(text.startsWith(OWN), text);
  for (const leaked of ['unsubscribe', 'commercial email', 'SA-48271', 'Hi Jordan', 'we get paid based', 'wrote:', '<']) {
    assert.ok(!text.includes(leaked), `quoted copy leaked into classifier input: ${leaked}`);
  }
});

test('Jorge: NOT unsubscribe, NOT negative; positive send-info, routed per staffing policy', async () => {
  const text = ownReplyText(jorgeMessage().payload, JORGE_SNIPPET);
  const canonical = classify(text);
  assert.equal(canonical.state, REPLY_STATE.POSITIVE);
  assert.equal(canonical.reason, 'explicit_evaluation_intent');
  assert.ok(canonical.signals.includes('send_info'));
  assert.notEqual(canonical.reason, 'unsubscribe_request');
  assert.equal(hasExplicitUnsubscribePhrase(text, { subject: 'Re: employer accounts' }), false);
  assert.equal(hasExplicitNegativePhrase(text, { subject: 'Re: employer accounts' }), false);
  // Existing policy: purely informational interest routes as QUESTION, so a
  // human reviews the answer; analytics still records the positive intent.
  assert.equal(deterministicReplyCategory(text, { subject: 'Re: employer accounts' }), 'QUESTION');

  const message = { messageId: 'in-jorge', threadId: 'thread-jorge', subject: 'Re: employer accounts',
    occurredAt: '2026-09-25T17:47:15.000Z' };
  const { decision } = await interpretInboundReply({
    lead, message, replyText: text, ruleCanonical: canonical, maySend: true,
    now: new Date('2026-09-25T18:00:14.000Z'), ruleCategory: deterministicReplyCategory,
    classify: () => classifyReplyDetailed({ lead, subject: message.subject, plainTextReply: text, apiKey: '', messageId: 'in-jorge' }),
  });
  assert.notEqual(decision.finalClassification, 'UNSUBSCRIBE');
  assert.notEqual(decision.finalClassification, 'NOT_INTERESTED');
  assert.equal(decision.route, ROUTE.QUESTION);
});

test('Jorge: the observer records a positive reply, adds no suppression, and leaves the provider message intact', async () => {
  const message = jorgeMessage();
  const before = JSON.parse(JSON.stringify(message));
  const plan = await planMailboxEvents({
    observation: { messages: [message], unavailable: [], recovered: false },
    gmail: { users: { threads: { get: async () => { throw new Error('unexpected Gmail read'); } } } },
    leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: SENDER,
    now: new Date('2026-09-25T18:00:07.000Z'),
  });
  assert.deepEqual(plan.suppressions, [], 'a quoted footer must never suppress a prospect');
  const reply = plan.events.find(event => event.eventId === 'gmail-reply:in-jorge');
  assert.ok(reply);
  assert.notEqual(reply.eventType, 'unsubscribe_reply');
  assert.equal(reply.eventType, 'positive_reply');
  const metadata = JSON.parse(reply.metadata);
  assert.equal(metadata.canonicalState, REPLY_STATE.POSITIVE);
  assert.notEqual(metadata.reason, 'unsubscribe_request');
  // Classifier input is stripped; the stored evidence is the prospect's words.
  assert.ok(reply.content.startsWith(OWN));
  assert.ok(!/unsubscribe/i.test(reply.content));
  // The raw audit copy is untouched and still addressable at the provider.
  assert.deepEqual(message, before, 'the provider message must not be mutated');
  assert.equal(metadata.gmailMessageId, 'in-jorge');
  assert.equal(metadata.rfcMessageId, '<D548E629-FIXTURE@example-enterprise.test>');
  assert.match(decodeBodies(message.payload), /Reply &quot;unsubscribe&quot;/, 'the original still holds the quoted footer');
  assert.equal(plan.replies.length, 1);
  assert.equal(plan.replies[0].canonical.reason, 'explicit_evaluation_intent');
});

test('Jorge: a legacy event stored from the raw HTML no longer replays as an unsubscribe', () => {
  // What production persisted: the raw HTML cut at 1,500 characters, typed
  // unsubscribe_reply because the classifier read our quoted footer.
  const stored = appleMailHtml().replace(/\bJordan Example\b/, 'Jorge').slice(0, 1500);
  assert.match(stored, /unsubscribe/);
  const verdict = recordedTerminalReply({
    eventType: 'unsubscribe_reply', content: stored, subject: 'Re: employer accounts',
    occurredAt: '2026-09-25T17:47:15.000Z',
  }, { currentEmail: PROSPECT });
  assert.equal(verdict.recordedTypeTrusted, false);
  assert.equal(verdict.unsubscribe, false);
  assert.equal(verdict.rejection, false);
  assert.ok(verdict.text.startsWith(OWN));
});

test('a clean or unreadable stored opt-out keeps its recorded verdict (fail closed)', () => {
  // A model-classified opt-out whose words have no explicit phrase.
  const clean = recordedTerminalReply({ eventType: 'unsubscribe_reply', content: 'Please do not reach out to our office again.' });
  assert.equal(clean.recordedTypeTrusted, true);
  assert.equal(clean.unsubscribe, true);
  const empty = recordedTerminalReply({ eventType: 'unsubscribe_reply', content: '' });
  assert.equal(empty.unsubscribe, true);
  const onlyQuoted = recordedTerminalReply({ eventType: 'negative_reply', content: `<blockquote type="cite">${QUOTED_HTML}</blockquote>` });
  assert.equal(onlyQuoted.text, '');
  assert.equal(onlyQuoted.rejection, true, 'nothing of theirs is readable, so the recorded verdict stands');
  const genuine = recordedTerminalReply({ eventType: 'unsubscribe_reply', content: appleMailHtml('Please unsubscribe me.') });
  assert.equal(genuine.recordedTypeTrusted, false);
  assert.equal(genuine.unsubscribe, true, 'their own opt-out is still honoured after re-reading');
});

// ── Required cases, in every client format ──────────────────────────────────

for (const [format, own] of Object.entries(FORMATS)) {
  test(`${format}: "unsubscribe" + quoted outbound is still an unsubscribe`, () => {
    const text = own('unsubscribe');
    assert.equal(classify(text).reason, 'unsubscribe_request', text);
    assert.ok(!text.includes('commercial email'), text);
  });

  test(`${format}: "please remove me" + quoted outbound is an unsubscribe`, () => {
    const text = own('please remove me');
    assert.equal(classify(text).reason, 'unsubscribe_request', text);
  });

  test(`${format}: "not interested" + quoted positive offer language is negative`, () => {
    const text = own('Not interested, thanks.');
    const canonical = classify(text);
    assert.equal(canonical.state, REPLY_STATE.NEGATIVE, text);
    assert.equal(canonical.reason, 'explicit_rejection', text);
    assert.ok(!/pricing|meeting|interested\?/i.test(text.replace(/Not interested/i, '')), text);
  });

  test(`${format}: a positive reply + quoted "unsubscribe" footer is positive`, () => {
    const text = own('Yes, interested. Send me more info.');
    const canonical = classify(text);
    assert.equal(canonical.state, REPLY_STATE.POSITIVE, text);
    assert.equal(hasExplicitUnsubscribePhrase(text), false, text);
    assert.ok(!/unsubscribe|SA-48271/.test(text), text);
  });

  test(`${format}: Jorge's words + quoted outbound are positive send-info`, () => {
    const text = own(OWN);
    const canonical = classify(text);
    assert.equal(canonical.state, REPLY_STATE.POSITIVE, text);
    assert.ok(canonical.signals.includes('send_info'), text);
  });
}

// ── Boundaries of the stripping ─────────────────────────────────────────────

test('prose that mentions writing is not mistaken for a quote attribution', () => {
  const prose = 'Thanks. On Monday you wrote: meetings only — yes, send pricing.';
  assert.equal(stripQuotedReply(prose), prose);
});

test('our compliance sentences are removed, a prospect\'s own opt-out words are not', () => {
  assert.equal(stripQuotedReply('unsubscribe'), 'unsubscribe');
  assert.equal(stripQuotedReply('Please unsubscribe me from this list.'), 'Please unsubscribe me from this list.');
  const pasted = `Send details please.\n\n${FOOTER}\nRef: SA-48271`;
  assert.equal(stripQuotedReply(pasted), 'Send details please.');
  const dental = 'Sounds good.\nYou\'re receiving this because your business is publicly listed. Reply "unsubscribe" and I\'ll remove you immediately.  ·  Ref: SL-ABC123';
  assert.ok(!/unsubscribe/i.test(stripQuotedReply(dental)));
});

test('a plain-text reply with no quote is returned unchanged', () => {
  assert.equal(stripQuotedReply('We might be interested next quarter.'), 'We might be interested next quarter.');
});

// ── The reply pass is wired to the same extraction ──────────────────────────
// runReplyCheckPass is one long procedure over Sheets and Gmail, so its wiring
// is pinned from source, as the other reply-pass tests do.

test('the reply pass classifies own words and re-reads persisted opt-outs through them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const pass = agent.slice(agent.indexOf('async function runReplyCheckPass'),
    agent.indexOf('async function commitMailboxObservationCheckpoints'));
  assert.match(pass, /body: ownReplyText\(rawMessage\.payload, rawMessage\.snippet\)\.slice\(0, 1500\)/);
  assert.ok(!/firstPlainText\(rawMessage\.payload\)/.test(pass), 'the HTML-blind reader must not feed the classifier');
  assert.match(pass, /const recorded = recordedTerminalReply\(row, \{ currentEmail: lead\.email \}\)/);
  assert.ok(!/row\.eventType === 'unsubscribe_reply'/.test(pass), 'a stored type alone must not re-apply an opt-out');
  // An applied opt-out satisfies a rejection replay, so re-reading an old
  // contaminated opt-out as "not interested" cannot move Unsub back to Done.
  assert.match(pass, /if \(neg && !unsub && \(optOutApplied \|\|/);
  assert.match(agent, /body: ownReplyText\(m\.payload, m\.snippet\)\.slice\(0, 1500\)/, 'late replies read own words');
});

// ── The late-reply watcher reads own words too ──────────────────────────────

test('late replies are classified and stored from the prospect\'s own words only', async () => {
  const seen = [];
  const recorded = [];
  const suppressed = [];
  const result = await processLateReply({
    lead: { ...lead, stage: 'Done', emailStatus: 'done', notes: '' },
    message: { messageId: 'late-1', threadId: 'thread-jorge', subject: 'Re: employer accounts',
      body: gmailPlain(OWN), snippet: '', occurredAt: '2026-09-25T17:47:15.000Z' },
    outbound: null,
    classify: async (_company, text) => { seen.push(text); return 'QUESTION'; },
    existingEventIds: new Set(),
    writeNotes: async () => {},
    addSuppression: async (_lead, reason) => { suppressed.push(reason); },
    recordActivity: async activity => { recorded.push(activity); },
  });
  assert.equal(result.status, 'recorded');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith(OWN));
  assert.ok(!/unsubscribe/i.test(seen[0]), 'the late-reply classifier must not see our footer');
  assert.ok(!/unsubscribe/i.test(recorded[0].content));
  assert.deepEqual(suppressed, []);
});
