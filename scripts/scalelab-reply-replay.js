#!/usr/bin/env node
'use strict';
// Run with the private audit inputs already collected by the operator.
// This script needs no credentials and performs no provider or database calls.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { classifyScaleLabReply, verifiedContext, scaleLabOwner } = require('../integrations/scalelab-response-classification');

function tally(rows, field) {
  const counts = { correct: 0, incorrect: 0, uncertain: 0 };
  for (const row of rows) counts[row[field]]++;
  return counts;
}

function replay(folder) {
  const read = name => readFileSync(join(folder, name), 'utf8');
  const labels = read('scalelab-reviewed-replies.jsonl').trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (labels.length !== 76 || labels.some(row => row.client !== 'scalelab')) throw new Error('Expected the 76-record ScaleLab audit');
  const cases = new Map(JSON.parse(read('review-private.json')).filter(row => row.client === 'scalelab')
    .map(row => [row.mid, row]));
  const snapshot = JSON.parse(read('snapshot-private.json'));
  const leads = new Map(snapshot.leads.filter(scaleLabOwner).map(row => [row.id, row]));
  const messages = Object.values(JSON.parse(read('gmail-private.json')).messages);
  const fits = {
    positive: new Set(['interest', 'pricing_request', 'information_request', 'meeting_request', 'reschedule_request']),
    negative: new Set(['explicit_rejection', 'opt_out']),
    automated_reply: new Set(['out_of_office', 'automated_acknowledgment', 'contact_change', 'calendar_notice']),
    contact_change_review: new Set(['contact_change', 'automated_acknowledgment', 'referral']),
    needs_human: new Set(['unclear', 'referral', 'objection', 'acknowledgment', 'reschedule_request', 'future_contact']),
  };
  const rows = labels.map(label => {
    const row = cases.get(label.messageId);
    const lead = leads.get(label.leadId);
    if (!row || row.leadId !== label.leadId || !lead) throw new Error('Case identity mismatch: ' + label.case);
    const direct = messages.find(message => message.id === row.mid && message.leadId === lead.id);
    const event = snapshot.events.find(item => item.eventId === row.ledgerEvent && item.sourceLeadId === lead.id);
    const threadId = direct?.threadId || JSON.parse(event?.metadata || '{}').gmailThreadId;
    const context = verifiedContext(snapshot.events, { leadId: lead.id, threadId, senderInboxId: row.mailbox,
      messageId: row.mid, occurredAt: row.at });
    const verdict = classifyScaleLabReply({ text: row.body, subject: row.subject, autoSubmitted: row.auto,
      occurredAt: row.at, currentEmail: lead.email, context });
    const expected = label.reviewedIntent || (row.reason === 'unsubscribe_request' ? 'opt_out' : null);
    const before = label.reviewVerdict === 'correct_at_recorded_granularity' ? 'correct' : label.reviewVerdict;
    const after = before === 'uncertain' ? 'uncertain'
      : (expected ? verdict.intent === expected : fits[row.rule]?.has(verdict.intent)) ? 'correct' : 'incorrect';
    return { case: label.case, before, after, expected: expected || row.rule, intent: verdict.intent };
  });
  return { total: rows.length, before: tally(rows, 'before'), after: tally(rows, 'after'),
    correctedCases: rows.filter(row => row.before === 'incorrect' && row.after === 'correct').map(row => row.case),
    review: rows.filter(row => row.after !== 'correct') };
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Pass the private audit folder path');
  console.log(JSON.stringify(replay(process.argv[2]), null, 2));
}
module.exports = { replay };
