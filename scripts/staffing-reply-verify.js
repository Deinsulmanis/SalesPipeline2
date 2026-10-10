'use strict';

// Read-only current reply and watchdog report from the existing activity ledger.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { readOutreachCorpus } = require('../integrations/outreach-state');
const { buildReplyMetrics, buildReplyRecords } = require('../integrations/reply-analytics');
const { orphanedHumanReplies, ALERT_EVENT } = require('../integrations/reply-watchdog');
const { LEGACY_REPLY_EVENT_TYPES } = require('../integrations/canonical-reply');

async function main() {
  const corpus = await readOutreachCorpus({ env: { ...process.env, SUPABASE_OUTREACH_MODE: 'primary' } });
  if (!corpus.ok) throw new Error(corpus.reason);
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const values = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'ColdCallActivity!A:J' })).data.values || [];
  const fields = values[0] || [];
  const activities = values.slice(1).map(row => Object.fromEntries(fields.map((key, i) => [key, row[i] || ''])));
  const activityByLead = new Map();
  for (const row of activities) {
    const id = String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '');
    if (!activityByLead.has(id)) activityByLead.set(id, []);
    activityByLead.get(id).push(row);
  }
  const scale = corpus.leads.filter(lead => String(lead.clientId || 'scalelab') === 'scalelab');
  const metrics = buildReplyMetrics(scale, { activitiesByLeadId: activityByLead });
  const records = buildReplyRecords(scale, { activitiesByLeadId: activityByLead });
  const staffing = scale.filter(lead => String(lead.leadNiche || '').toLowerCase().includes('staffing'));
  const staffingMetrics = buildReplyMetrics(staffing, { activitiesByLeadId: activityByLead });
  const orphans = orphanedHumanReplies({ leads: corpus.leads, activities });
  const inbound = activities.filter(row => LEGACY_REPLY_EVENT_TYPES.includes(row.eventType));
  const alerts = activities.filter(row => row.eventType === ALERT_EVENT);
  const alertIds = new Set(alerts.map(row => row.eventId));
  const report = { verifiedAt: new Date().toISOString(), activityCount: activities.length,
    scaleLab: { ...metrics, records: records.length },
    staffing: staffingMetrics,
    inboundEvents: inbound.length,
    unresolvedGenuine: orphans.length,
    orphans: orphans.map(row => ({ leadId: row.leadId, clientId: row.clientId,
      senderInboxId: row.senderInboxId, receivedAt: row.receivedAt, alreadyAlerted: row.alreadyAlerted })),
    watchdogAlerts: alerts.length, duplicateWatchdogAlerts: alerts.length - alertIds.size };
  fs.writeFileSync(process.env.REPLY_VERIFY_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.unresolvedGenuine || report.duplicateWatchdogAlerts) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
