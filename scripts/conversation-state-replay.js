#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY replay of conversation state against the live spreadsheet.
 *
 * One Sheets values.batchGet (read-only scope) loads the ColdEmail rows, the
 * Pipeline, the activity ledger and the suppression list. Every conversation is
 * then built in memory, so replaying hundreds costs the same single read.
 * Nothing is written, sent, enrolled, held or suppressed, and no model is
 * called. --human-text also reads recorded human replies from Gmail (read-only,
 * verified, at most ten per conversation) for mailboxes with a local token.
 *
 * Usage:
 *   node scripts/conversation-state-replay.js [--family=industrial_staffing]
 *     [--lead=<id>] [--with-inbound] [--with-human] [--limit=50] [--human-text] [--json]
 *
 * Output is minimised: ids, statuses, counts and codes — never message text,
 * addresses or names. --json prints one full state and requires --lead.
 */

require('dotenv').config({ quiet: true });
const { google } = require('googleapis');
const { buildConversationState } = require('../integrations/conversation-state');
const {
  indexConversationEvidence, selectConversationEvidence, loadHumanReplyTexts,
} = require('../integrations/conversation-evidence');
const { familyForLead } = require('../integrations/campaign-versions');
const { parseRegistry, withDefaultInboxes, credentialsFor } = require('../integrations/gmail-inbox-registry');
const { COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const { LEGACY_REPLY_EVENT_TYPES } = require('../integrations/canonical-reply');

const CE_COLUMNS = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage', 'emailStatus',
  'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier', 'siteContext', 'campaign', 'campaign_notes',
  'enrichment_attempted', 'leadNiche', 'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];
const BOARD_COLUMNS = ['id', 'type', 'first', 'last', 'brokerage', 'tradeType', 'company', 'city', 'cityTrade', 'phone',
  'email', 'website', 'stage', 'priority', 'followup', 'notes', 'created'];

function args() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    out[key] = value === undefined ? true : value;
  }
  return out;
}

const norm = value => String(value || '').trim().toLowerCase();

async function loadSnapshot() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X', 'Leads!A:W', 'ColdCallActivity!A:J', 'Suppression!A:A'],
  });
  const [ce, board, activity, suppression] = response.data.valueRanges.map(range => range.values || []);
  const objects = (rows, header) => rows.slice(1).map(row => Object.fromEntries(header.map((field, i) => [field, row[i] || ''])));
  const boardLeads = board.slice(1).map((row) => {
    const lead = Object.fromEntries(BOARD_COLUMNS.map((field, i) => [field, row[i] || '']));
    lead.meetingAt = row[20] || '';
    lead.outcome = row[21] || '';
    lead.conversationContext = row[22] || '';
    return lead;
  }).filter(lead => lead.id);
  return {
    leads: objects(ce, CE_COLUMNS).filter(lead => lead.id),
    boardLeads,
    activities: objects(activity, COLD_CALL_ACTIVITY_HEADER),
    suppressedEmails: new Set(suppression.slice(1).map(row => norm(row[0])).filter(Boolean)),
    readRequests: 1,
  };
}

function mailboxFactory() {
  const mailboxes = new Map();
  if (process.env.GMAIL_TOKEN_JSON) {
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    auth.setCredentials(JSON.parse(process.env.GMAIL_TOKEN_JSON));
    mailboxes.set('primary', { email: norm(process.env.FROM_EMAIL), gmail: google.gmail({ version: 'v1', auth }) });
  }
  for (const entry of withDefaultInboxes(parseRegistry(process.env.GMAIL_INBOX_REGISTRY_JSON || '[]'))) {
    if (!entry.tokenEnv || !process.env[entry.tokenEnv]) continue;
    const auth = new google.auth.OAuth2(process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_ID,
      process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET, process.env.GMAIL_SECONDARY_GOOGLE_REDIRECT_URI);
    auth.setCredentials(credentialsFor(entry));
    mailboxes.set(entry.id, { email: norm(entry.email), gmail: google.gmail({ version: 'v1', auth }) });
  }
  return id => {
    const mailbox = mailboxes.get(id);
    if (!mailbox) throw new Error(`no local token for ${id}`);
    return mailbox;
  };
}

function summarize(state) {
  const count = (list, key) => list.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
  return {
    leadId: state.identity.leadId, boardLeadId: state.identity.boardLeadId, family: state.identity.family,
    turns: count(state.turns, 'actor'),
    humanTextAvailable: `${state.turns.filter(turn => turn.actor === 'human' && turn.contentAvailable).length}/${state.turns.filter(turn => turn.actor === 'human').length}`,
    decisions: state.decisionCoverage,
    qualification: state.qualification.applicable ? {
      status: state.qualification.status,
      slots: Object.fromEntries(Object.entries(state.qualification.slots).map(([slot, value]) => [slot, value.status])),
    } : 'not_applicable',
    questions: state.questions.map(item => `${item.topic}:${item.status}`),
    objections: state.objections.map(item => `${item.type}:${item.status}`),
    referral: state.referral.status,
    booking: { link: state.booking.linkSent.status, intent: state.booking.meetingIntent.value, call: state.booking.call.status },
    terminal: state.terminalState.blockedBy,
    owner: `${state.ownership.owner}${state.ownership.blockedBy ? `/${state.ownership.blockedBy}` : ''}`,
    humanTakeover: state.ownership.humanTakeover.value,
    response: `${state.responseState.answered}${state.responseState.answeredBy ? `:${state.responseState.answeredBy}` : ''} waiting=${state.responseState.waitingOn}`,
    warnings: [...new Set(state.evidenceWarnings.map(item => item.code))],
    ambiguities: [...new Set(state.ambiguities.map(item => item.code))],
  };
}

async function main() {
  const options = args();
  if (options.json && !options.lead) throw new Error('--json prints one full state and requires --lead=<id>');
  const started = Date.now();
  const snapshot = await loadSnapshot();
  const loadedMs = Date.now() - started;
  const index = indexConversationEvidence(snapshot);
  const inboundTypes = new Set(LEGACY_REPLY_EVENT_TYPES);
  let leads = options.lead ? [{ id: String(options.lead) }] : snapshot.leads;
  if (!options.lead && options.family) {
    leads = leads.filter((lead) => { try { return familyForLead(lead) === options.family; } catch (_) { return false; } });
  }
  const mailboxFor = options['human-text'] ? mailboxFactory() : null;
  const results = [];
  let gmailReads = 0;
  const buildStarted = Date.now();
  for (const candidate of leads) {
    const selected = selectConversationEvidence(index, candidate.id);
    if (!selected.lead && !selected.boardLead) continue;
    const types = new Set(selected.activities.map(row => String(row.eventType || '')));
    if (options['with-inbound'] && ![...types].some(type => inboundTypes.has(type))) continue;
    if (options['with-human'] && !types.has('human_response_sent')) continue;
    let messageTexts = {};
    let textFailures = [];
    if (mailboxFor) {
      const loaded = await loadHumanReplyTexts({ activities: selected.activities, mailboxFor });
      gmailReads += loaded.providerCalls;
      messageTexts = loaded.texts;
      textFailures = loaded.failures.map(item => item.reason).sort();
    }
    const state = buildConversationState({
      lead: selected.lead, boardLead: selected.boardLead, activities: selected.activities,
      suppressedEmails: snapshot.suppressedEmails, messageTexts, selection: selected.selection,
      config: { sequencesEnabled: true, sendingEnabled: true }, now: new Date(),
    });
    results.push({ state, textFailures });
    if (options.limit && results.length >= Number(options.limit)) break;
  }
  const buildMs = Date.now() - buildStarted;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(results[0] ? results[0].state : null, null, 2)}\n`);
    return;
  }
  const tally = {};
  for (const { state } of results) {
    for (const code of new Set(state.evidenceWarnings.map(item => item.code))) tally[code] = (tally[code] || 0) + 1;
  }
  process.stdout.write(`${JSON.stringify({
    readOnly: true,
    sheetsReadRequests: snapshot.readRequests,
    gmailMessageReads: gmailReads,
    snapshot: { leads: snapshot.leads.length, boardLeads: snapshot.boardLeads.length, activities: snapshot.activities.length },
    conversationsBuilt: results.length,
    loadMs: loadedMs,
    buildMs,
    msPerConversation: results.length ? Number((buildMs / results.length).toFixed(2)) : 0,
    warningFrequency: Object.fromEntries(Object.entries(tally).sort()),
    conversations: results.map(({ state, textFailures }) => ({
      ...summarize(state), ...(mailboxFor ? { humanTextFailures: textFailures } : {}),
    })),
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`conversation-state replay failed: ${error.message}`);
  process.exit(1);
});
