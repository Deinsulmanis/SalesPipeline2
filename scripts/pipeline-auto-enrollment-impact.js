'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const { deriveCallLifecycle, deriveHotState } = require('../integrations/pipeline-state');
const {
  evaluateStageSequence, deriveSequenceState, provenSequenceSenderId,
  resolveSequenceThread, automaticEnrollmentDecision,
} = require('../integrations/stage-sequences');

const ACTIVITY_HEADER = ['eventId','leadId','sourceLeadId','email','company','eventType','occurredAt','subject','content','metadata'];
const BOARD_HEADER = ['id','type','first','last','brokerage','tradeType','company','city','cityTrade','phone','email','website','stage','priority','followup','notes','created','emailStatus','lastEmailedAt','emailStep','meetingAt','outcome','conversationContext'];
const COLD_HEADER = ['id','company','contactName','email','city','tradeType','website','stage','emailStatus','lastEmailedAt','emailStep','notes','reviewCount','rating','tier','siteContext','campaign','campaign_notes','enrichment_attempted','leadNiche','senderInboxId','emailTemplateId','routingRequired','intendedCampaignVersion'];
const rowObjects = (rows, header) => (rows || []).slice(1)
  .map(row => Object.fromEntries(header.map((field, index) => [field, row[index] || ''])));
const emailKey = value => String(value || '').trim().toLowerCase();

async function main() {
  if (!process.env.SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are required');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const [boardResponse, coldResponse, activityResponse, suppressionResponse] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'Leads!A:W' }),
    api.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdEmail!A:X' }),
    api.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J' }),
    api.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'Suppression!A:A' }).catch(() => ({ data: {} })),
  ]);
  const board = rowObjects(boardResponse.data.values, BOARD_HEADER);
  const cold = rowObjects(coldResponse.data.values, COLD_HEADER);
  const activities = rowObjects(activityResponse.data.values, ACTIVITY_HEADER);
  const suppressedEmails = new Set((suppressionResponse.data.values || []).slice(1).map(row => emailKey(row[0])).filter(Boolean));
  const byColdId = new Map(cold.map(row => [row.id, row]));
  const byEmail = new Map();
  for (const row of cold) {
    const key = emailKey(row.email);
    if (!key) continue;
    byEmail.set(key, [...(byEmail.get(key) || []), row]);
  }

  const results = [];
  for (const lead of board) {
    const key = emailKey(lead.email);
    const foreign = String(lead.id || '').replace(/^CE-/, '');
    const exact = foreign ? byColdId.get(foreign) : null;
    const emailMatches = key ? (byEmail.get(key) || []) : [];
    const twin = exact || (emailMatches.length === 1 ? emailMatches[0] : null);
    const mine = activities.filter(row => String(row.leadId || '') === String(lead.id)
      || (key && emailKey(row.email) === key));
    const callState = deriveCallLifecycle(lead, { activities: mine });
    const hotState = deriveHotState(lead, { activities: mine });
    const verdict = evaluateStageSequence({
      boardLead: lead, twin: twin || {}, activities: mine, callState, hotState,
      suppressedEmails, featureEnabled: true,
    });
    const senderProof = provenSequenceSenderId(twin || {}, mine);
    const thread = senderProof.ok
      ? resolveSequenceThread(mine, { senderInboxId: senderProof.senderInboxId }) : null;
    const decision = automaticEnrollmentDecision({
      boardLead: lead, twin: twin || {}, activities: mine, verdict,
      senderProof, thread, callState, hotState, now: new Date(),
    });
    const state = deriveSequenceState(mine);
    if (verdict.offer || state.status !== 'none' || /Galaxy Dental/i.test(lead.company || '')) {
      results.push({
        id: lead.id, company: lead.company || lead.email, stage: lead.stage,
        currentSequence: state.sequenceId, sequenceStatus: state.status,
        offer: verdict.offer, newlyQualifies: decision.enroll,
        decision: decision.enroll ? decision.authorization : decision.reason,
        sender: senderProof.ok ? senderProof.senderInboxId : senderProof.reason,
        thread: thread ? 'proven' : 'unproven', manualHold: String(twin?.notes || '').includes('[MANUAL HOLD]'),
      });
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), boardLeadCount: board.length,
    newlyQualifying: results.filter(row => row.newlyQualifies), reviewed: results }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
