'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { google } = require('googleapis');
const { parseRegistry, credentialsFor } = require('../integrations/gmail-inbox-registry');
const { wrapSheetsReadClient } = require('../integrations/google-sheets-resilience');
const { senderEvidence, SENDER_ATTRIBUTED_EVENTS } = require('../integrations/gmail-sender-routing');
const { NON_COLD_STAGES } = require('../integrations/automation-ownership');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { TEMPLATE_ID: ROOFING_SURVEY_TEMPLATE } = require('../integrations/roofing-survey-profile');

const DATE = (process.argv.find(arg => arg.startsWith('--date=')) || '').slice(7)
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function dayInVancouver(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
}

function header(payload, name) {
  return (payload?.headers || []).find(item => String(item.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}

function addresses(value) {
  return String(value || '').split(',').map(part => {
    const match = /<([^>]+)>/.exec(part);
    return String(match ? match[1] : part).trim().toLowerCase();
  }).filter(Boolean);
}

function metadata(value) {
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function decodedText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const value = decodedText(part);
    if (value) return value;
  }
  return payload.body?.data ? Buffer.from(payload.body.data, 'base64url').toString('utf8') : '';
}

function mailboxes() {
  const result = [];
  const primaryRaw = process.env.GMAIL_TOKEN_JSON
    || fs.readFileSync(path.join(__dirname, '..', 'token.json'), 'utf8');
  const primaryAuth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI,
  );
  primaryAuth.setCredentials(JSON.parse(primaryRaw));
  result.push({ id: 'primary', expectedEmail: String(process.env.FROM_EMAIL || '').toLowerCase(), auth: primaryAuth });

  for (const entry of parseRegistry(process.env.GMAIL_INBOX_REGISTRY_JSON || '[]')) {
    if (!process.env[entry.tokenEnv]) continue;
    const auth = new google.auth.OAuth2(
      process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_ID,
      process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET,
      process.env.GMAIL_SECONDARY_GOOGLE_REDIRECT_URI,
    );
    auth.setCredentials(credentialsFor(entry));
    result.push({ id: entry.id, expectedEmail: entry.email, auth });
  }
  return result;
}

async function sentOnDate(mailbox) {
  const gmail = google.gmail({ version: 'v1', auth: mailbox.auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const authenticatedEmail = String(profile.data.emailAddress || '').toLowerCase();
  if (mailbox.expectedEmail && authenticatedEmail !== mailbox.expectedEmail) {
    throw new Error(`${mailbox.id} credential belongs to ${authenticatedEmail}, not ${mailbox.expectedEmail}`);
  }
  const listed = await gmail.users.messages.list({
    userId: 'me', q: `in:sent after:${DATE.replaceAll('-', '/')} before:${nextDate(DATE).replaceAll('-', '/')}`,
    maxResults: 500,
  });
  const messages = [];
  for (const stub of listed.data.messages || []) {
    const response = await gmail.users.messages.get({
      userId: 'me', id: stub.id, format: 'full',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID'],
    });
    const item = response.data;
    const occurredAt = Number(item.internalDate) ? new Date(Number(item.internalDate)).toISOString() : '';
    if (dayInVancouver(occurredAt) !== DATE) continue;
    messages.push({
      senderInboxId: mailbox.id, senderEmail: authenticatedEmail,
      providerMessageId: item.id || '', threadId: item.threadId || '', occurredAt,
      rfcMessageId: header(item.payload, 'Message-ID'), subject: header(item.payload, 'Subject'),
      bodySha256: crypto.createHash('sha256').update(decodedText(item.payload)).digest('hex'),
      recipients: [...addresses(header(item.payload, 'To')), ...addresses(header(item.payload, 'Cc'))],
    });
  }
  return messages.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

async function historicalSenderProof(mailbox, email) {
  const gmail = google.gmail({ version: 'v1', auth: mailbox.auth });
  const listed = await gmail.users.messages.list({
    userId: 'me', q: `in:sent to:"${String(email).replaceAll('"', '')}"`, maxResults: 1,
  });
  const stub = (listed.data.messages || [])[0];
  if (!stub) return null;
  const response = await gmail.users.messages.get({
    userId: 'me', id: stub.id, format: 'metadata', metadataHeaders: ['To', 'From'],
  });
  return { senderInboxId: mailbox.id, providerMessageId: response.data.id || stub.id,
    threadId: response.data.threadId || '', occurredAt: Number(response.data.internalDate)
      ? new Date(Number(response.data.internalDate)).toISOString() : '' };
}

function nextDate(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function ordinaryFollowUpsDue(leads, now = Date.now()) {
  const delayDays = new Map([[1, 3], [2, 5]]);
  return leads.filter(lead => {
    if (lead.emailStatus !== 'emailed') return false;
    if (NON_COLD_STAGES.includes(String(lead.stage || '').trim().toLowerCase())) return false;
    if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email) || !routedLeadReady(lead).ok) return false;
    const step = Number(lead.emailStep || 0);
    const requiredDays = delayDays.get(step);
    const lastSent = Date.parse(lead.lastEmailedAt || '');
    return requiredDays && Number.isFinite(lastSent) && (now - lastSent) >= requiredDays * 86400000;
  });
}

async function main() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID is required');
  const sheetAuth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = wrapSheetsReadClient(google.sheets({ version: 'v4', auth: sheetAuth }));
  const snapshot = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X', 'ColdCallActivity!A:J', 'Leads!A:W'],
  });
  const values = index => snapshot.data.valueRanges?.[index]?.values || [];
  const cold = values(0).slice(1).map((row, index) => ({
    row: index + 2, id: row[0] || '', company: row[1] || '', email: String(row[3] || '').toLowerCase(),
    stage: row[7] || '', emailStatus: row[8] || '', lastEmailedAt: row[9] || '',
    emailStep: row[10] || '', senderInboxId: row[20] || '',
    emailTemplateId: row[21] || '', routingRequired: row[22] || '', leadNiche: row[19] || '',
  })).filter(row => row.id);
  const activityHeader = ['eventId','leadId','sourceLeadId','email','company','eventType','occurredAt','subject','content','metadata'];
  const activities = values(1).slice(1).map(row => Object.fromEntries(activityHeader.map((key, i) => [key, row[i] || ''])));
  const activityByProviderId = new Map();
  for (const row of activities) {
    const meta = metadata(row.metadata);
    const providerId = meta.providerMessageId || meta.gmailMessageId || '';
    if (providerId) activityByProviderId.set(providerId, row);
  }
  const coldByEmail = new Map();
  for (const lead of cold) {
    const bucket = coldByEmail.get(lead.email) || [];
    bucket.push(lead); coldByEmail.set(lead.email, bucket);
  }

  const configuredMailboxes = mailboxes();
  const allSent = (await Promise.all(configuredMailboxes.map(sentOnDate))).flat()
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const crmMessages = [];
  for (const message of allSent) {
    const matchedLeads = [...new Map(message.recipients.flatMap(email => coldByEmail.get(email) || [])
      .map(lead => [lead.id, lead])).values()];
    const activity = activityByProviderId.get(message.providerMessageId)
      || activities.find(row => {
        if (!['initial_email_sent','follow_up_sent','booking_link_sent','sequence_step_sent','human_response_sent'].includes(row.eventType)) return false;
        if (!matchedLeads.some(lead => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`)) return false;
        const meta = metadata(row.metadata);
        if (meta.senderInboxId && meta.senderInboxId !== message.senderInboxId) return false;
        if (meta.gmailThreadId && meta.gmailThreadId !== message.threadId) return false;
        const delta = Math.abs(new Date(row.occurredAt).getTime() - new Date(message.occurredAt).getTime());
        return Number.isFinite(delta) && delta <= 10000;
      }) || null;
    if (!matchedLeads.length && !activity) continue;
    crmMessages.push({
      ...message, matchedLeadIds: matchedLeads.map(lead => lead.id),
      activityEventId: activity?.eventId || null, activityType: activity?.eventType || null,
      checkpointed: Boolean(activity) && (activity.eventType === 'booking_link_sent'
        || activity.eventType === 'sequence_step_sent'
        || matchedLeads.some(lead => Number(lead.emailStep || 0) > 0
          && dayInVancouver(lead.lastEmailedAt) === DATE)),
      leadState: matchedLeads.map(lead => ({ id: lead.id, company: lead.company, row: lead.row,
        stage: lead.stage, emailStatus: lead.emailStatus, emailStep: lead.emailStep,
        lastEmailedAt: lead.lastEmailedAt, senderInboxId: lead.senderInboxId })),
    });
  }

  const board = values(2).slice(1).map(row => ({
    id: row[0] || '', company: row[6] || '', email: String(row[10] || '').toLowerCase(), stage: row[12] || '',
  })).filter(row => row.id);
  const unknownSenderOwnership = [];
  for (const lead of cold) {
    const related = activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`);
    const ids = new Set([lead.senderInboxId, ...related.map(row => metadata(row.metadata).senderInboxId)].filter(Boolean));
    const pipeline = board.find(row => row.id === `CE-${lead.id}` || (lead.email && row.email === lead.email));
    if (pipeline && !['closed_won','closed_lost','lost','won','done'].includes(String(pipeline.stage).toLowerCase()) && ids.size !== 1) {
      unknownSenderOwnership.push({ leadId: lead.id, company: lead.company, email: lead.email,
        pipelineLeadId: pipeline.id, pipelineStage: pipeline.stage,
        reason: ids.size ? `conflicting sender ids: ${[...ids].join(', ')}` : 'no provider-backed sender evidence' });
    }
  }
  for (const item of unknownSenderOwnership) {
    const proof = (await Promise.all(configuredMailboxes.map(box => historicalSenderProof(box, item.email)))).filter(Boolean);
    item.gmailEvidence = proof;
    item.deterministicallyAttributable = proof.length === 1;
    if (proof.length === 1) item.inferredSenderInboxId = proof[0].senderInboxId;
    else if (proof.length > 1) item.reason = `Gmail evidence exists in multiple inboxes: ${proof.map(row => row.senderInboxId).join(', ')}`;
  }

  const dueFollowUps = ordinaryFollowUpsDue(cold);
  const senderUnknownFollowUps = dueFollowUps.filter(lead => senderEvidence(lead, activities).length !== 1);
  const attributedEvents = activities.filter(row => SENDER_ATTRIBUTED_EVENTS.includes(row.eventType));
  const firstMultiInboxEvidenceAt = attributedEvents
    .filter(row => metadata(row.metadata).senderInboxId && metadata(row.metadata).senderInboxId !== 'primary')
    .map(row => row.occurredAt).filter(Boolean).sort()[0] || null;
  const missingAfterMultiInbox = senderUnknownFollowUps.filter(lead => {
    if (!firstMultiInboxEvidenceAt) return false;
    return activities.some(row => (row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`)
      && ['initial_email_sent','follow_up_sent'].includes(row.eventType)
      && row.occurredAt >= firstMultiInboxEvidenceAt && !metadata(row.metadata).senderInboxId);
  });

  console.log(JSON.stringify({
    date: DATE, mailboxesAudited: configuredMailboxes.map(box => box.id),
    allSentMessages: allSent.length, crmMatchedMessages: crmMessages.length,
    crmMessages, deterministicGaps: crmMessages.filter(row => !row.checkpointed),
    ordinaryFollowUpOwnership: {
      due: dueFollowUps.length,
      blockedUnknown: senderUnknownFollowUps.length,
      legacyAmbiguous: senderUnknownFollowUps.length - missingAfterMultiInbox.length,
      missingAfterMultiInbox: missingAfterMultiInbox.map(lead => ({ leadId: lead.id, company: lead.company, email: lead.email })),
      firstMultiInboxEvidenceAt,
    },
    unknownSenderOwnership,
  }, null, 2));
}

main().catch(error => { console.error(`[audit] ${error.message}`); process.exitCode = 1; });
