'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const { isDatacenterIp } = require('../open-filter');
const {
  buildDemoPairActivity, demoPairEventFor, bookingLinkEventFor,
} = require('../integrations/demo-intent-state');
const { mirrorEvents } = require('../integrations/supabase-mirror');

const ACTIVITY_HEADER = ['eventId','leadId','sourceLeadId','email','company','eventType','occurredAt','subject','content','metadata'];
const BOARD_HEADER = ['id','type','first','last','brokerage','tradeType','company','city','cityTrade','phone','email','website','stage','priority','followup','notes','created','emailStatus','lastEmailedAt','emailStep','meetingAt','outcome','conversationContext'];
const COLD_HEADER = ['id','company','contactName','email','city','tradeType','website','stage','emailStatus','lastEmailedAt','emailStep','notes','reviewCount','rating','tier','siteContext','campaign','campaign_notes','enrichment_attempted','leadNiche','senderInboxId','emailTemplateId','routingRequired','intendedCampaignVersion'];
const BOT_UA_PATTERN = /curl|wget|python|java|go-http|axios|node-fetch|spider|crawler|bot|preview|scan|mimecast|barracuda|proofpoint|cloudmark|symantec/i;
const BLOCKED_IPS = new Set(['75.155.151.158']);
const REPLY_EVENTS = new Set(['positive_reply','meeting_requested','late_reply','question_reply','negative_reply','unsubscribe_reply','wrong_person_reply','needs_human_reply']);
const TERMINAL_BOARD_STAGES = new Set(['closed_won','closed_lost']);
const TERMINAL_COLD_STAGES = new Set(['replied','promoted','done','unsubscribed']);

const rowObjects = (rows, header) => (rows || []).slice(1)
  .map(row => Object.fromEntries(header.map((field, index) => [field, row[index] || ''])));
const emailKey = value => String(value || '').trim().toLowerCase();
const companyKey = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
const belongsTo = (row, lead) => String(row.sourceLeadId || '').replace(/^CE-/, '') === String(lead.id || '').replace(/^CE-/, '')
  || String(row.leadId || '').replace(/^CE-/, '') === String(lead.id || '').replace(/^CE-/, '')
  || (emailKey(lead.email) && emailKey(row.email) === emailKey(lead.email));

function demoPairs(rows) {
  const map = new Map();
  for (const row of (rows || []).slice(1)) {
    const [timestamp, company, , ip, userAgent, audioType] = row;
    if (!timestamp || !company || BLOCKED_IPS.has(String(ip || '').trim())
      || BOT_UA_PATTERN.test(userAgent || '') || isDatacenterIp(ip)) continue;
    const key = companyKey(company);
    const type = String(audioType || '').trim().toLowerCase() === 'intro' ? 'intro' : 'demo';
    const item = map.get(key) || { intro: 0, demo: 0, introPlayedAt: '', demoPlayedAt: '', last: '' };
    item[type]++;
    if (!item[`${type}PlayedAt`] || timestamp < item[`${type}PlayedAt`]) item[`${type}PlayedAt`] = timestamp;
    if (timestamp > item.last) item.last = timestamp;
    map.set(key, item);
  }
  return map;
}

async function main() {
  if (!process.env.SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are required');
  }
  const repairArg = process.argv.find(arg => arg.startsWith('--repair-lead='));
  const repairLeadId = repairArg ? repairArg.slice('--repair-lead='.length) : '';
  const backfillFired = process.argv.includes('--backfill-fired-deliveries');
  const confirmed = process.argv.includes('--confirm-no-send');
  if ((repairLeadId || backfillFired) && !confirmed) throw new Error('repair requires --confirm-no-send');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: [repairLeadId || backfillFired
      ? 'https://www.googleapis.com/auth/spreadsheets'
      : 'https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const snapshot = await api.spreadsheets.values.batchGet({
    spreadsheetId: process.env.SPREADSHEET_ID,
    ranges: ['ColdEmail!A:X','Leads!A:W','ColdCallActivity!A:J','DemoPlays!A:F','Suppression!A:A','IntentFired!A:E'],
  });
  const at = index => snapshot.data.valueRanges?.[index]?.values || [];
  const cold = rowObjects(at(0), COLD_HEADER);
  const board = rowObjects(at(1), BOARD_HEADER);
  const activities = rowObjects(at(2), ACTIVITY_HEADER);
  const plays = demoPairs(at(3));
  const suppressed = new Set(at(4).slice(1).map(row => emailKey(row[0])).filter(Boolean));
  const firedByLead = new Map(at(5).slice(1)
    .filter(row => row[1] && (row[4] || 'both-audios') === 'both-audios')
    .map(row => [row[1], { occurredAt: row[0] || '', trigger: row[4] || 'both-audios' }]));

  const affected = [];
  const historicalDeliveryGaps = [];
  for (const lead of cold) {
    const pair = plays.get(companyKey(lead.company));
    if (!pair || pair.intro < 1 || pair.demo < 1) continue;
    const mine = activities.filter(row => belongsTo(row, lead));
    const boardLead = board.find(row => String(row.id || '') === `CE-${lead.id}`)
      || board.find(row => emailKey(row.email) === emailKey(lead.email));
    const replied = lead.emailStatus === 'replied' || mine.some(row => REPLY_EVENTS.has(row.eventType));
    const meeting = Boolean(boardLead && (boardLead.meetingAt
      || String(boardLead.stage || '').toLowerCase() === 'call_booked'));
    const held = String(lead.notes || '').includes('[MANUAL HOLD]');
    const terminal = TERMINAL_COLD_STAGES.has(String(lead.stage || '').toLowerCase())
      || TERMINAL_BOARD_STAGES.has(String(boardLead?.stage || '').toLowerCase());
    const ordinaryCold = lead.emailStatus === 'emailed' && [1, 2].includes(Number(lead.emailStep));
    const bookingEvent = bookingLinkEventFor(lead, mine);
    const fired = firedByLead.get(lead.id) || null;
    if (fired && !bookingEvent) historicalDeliveryGaps.push({ lead, pair, mine, fired });
    if (!bookingEvent && !fired && !replied && !meeting
      && !suppressed.has(emailKey(lead.email)) && !held && !terminal && ordinaryCold) {
      affected.push({ lead, pair, mine, canonicalPairPresent: Boolean(demoPairEventFor(lead, mine)) });
    }
  }

  const report = {
    mode: repairLeadId ? 'targeted-repair' : backfillFired ? 'legacy-delivery-backfill' : 'read-only-audit',
    affectedCount: affected.length,
    affected: affected.map(item => ({
      id: item.lead.id, company: item.lead.company, email: item.lead.email,
      senderInboxId: item.lead.senderInboxId,
      canonicalPairPresent: item.canonicalPairPresent,
      introPlayedAt: item.pair.introPlayedAt, demoPlayedAt: item.pair.demoPlayedAt,
    })),
    historicalDeliveryGapCount: historicalDeliveryGaps.length,
    historicalDeliveryGaps: historicalDeliveryGaps.map(item => ({
      id: item.lead.id, company: item.lead.company,
      intentFiredAt: item.fired.occurredAt, canonicalBookingLinkPresent: false,
    })),
    repaired: null,
    deliveryBackfill: [],
  };

  if (repairLeadId) {
    const target = affected.find(item => item.lead.id === repairLeadId);
    if (!target) throw new Error(`lead ${repairLeadId} is not an affected, repairable lead`);
    if (target.canonicalPairPresent) {
      report.repaired = { eventId: demoPairEventFor(target.lead, target.mine).eventId, unchanged: true };
    } else {
      // Re-read immediately before append so a worker repair racing this command
      // cannot be mistaken for permission to append a second event.
      const freshRows = (await api.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
      })).data.values || [];
      const fresh = rowObjects(freshRows, ACTIVITY_HEADER).filter(row => belongsTo(row, target.lead));
      if (demoPairEventFor(target.lead, fresh)) {
        report.repaired = { eventId: demoPairEventFor(target.lead, fresh).eventId, unchanged: true };
      } else if (bookingLinkEventFor(target.lead, fresh)) {
        throw new Error('booking link was delivered after audit; refusing intent-only repair');
      } else {
        const event = buildDemoPairActivity(target.lead, target.pair, {
          campaign: target.lead.campaign,
          campaignVersion: target.lead.intendedCampaignVersion,
        });
        await api.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
          valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [ACTIVITY_HEADER.map(field => String(event[field] || ''))] },
        });
        const mirror = await mirrorEvents([event]);
        report.repaired = { eventId: event.eventId, unchanged: false,
          mirrored: mirror.mirrored || 0, mirrorDeferred: mirror.failed || 0 };
      }
    }
  }

  if (backfillFired) {
    for (const item of historicalDeliveryGaps) {
      const freshRows = (await api.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
      })).data.values || [];
      const fresh = rowObjects(freshRows, ACTIVITY_HEADER).filter(row => belongsTo(row, item.lead));
      const existing = bookingLinkEventFor(item.lead, fresh);
      if (existing) {
        report.deliveryBackfill.push({ id: item.lead.id, eventId: existing.eventId, unchanged: true });
        continue;
      }
      if (!item.fired.occurredAt) throw new Error(`IntentFired timestamp missing for ${item.lead.id}`);
      const event = {
        eventId: `booking-link:legacy-intent:${item.lead.id}`,
        leadId: `CE-${item.lead.id}`, sourceLeadId: item.lead.id,
        email: item.lead.email, company: item.lead.company,
        eventType: 'booking_link_sent', occurredAt: item.fired.occurredAt,
        subject: '', content: '',
        metadata: JSON.stringify({
          deliveryEvidence: 'IntentFired', trigger: item.fired.trigger,
          senderInboxId: String(item.lead.senderInboxId || ''),
          campaign: String(item.lead.campaign || ''),
          campaignVersion: String(item.lead.intendedCampaignVersion || ''),
          historicalBackfill: true,
        }),
      };
      await api.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [ACTIVITY_HEADER.map(field => String(event[field] || ''))] },
      });
      const mirror = await mirrorEvents([event]);
      report.deliveryBackfill.push({ id: item.lead.id, eventId: event.eventId,
        unchanged: false, mirrored: mirror.mirrored || 0, mirrorDeferred: mirror.failed || 0 });
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
