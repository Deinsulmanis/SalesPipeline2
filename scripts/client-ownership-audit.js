#!/usr/bin/env node
'use strict';

/**
 * Read-only client ownership audit of the canonical outreach_leads table.
 *
 *   node scripts/client-ownership-audit.js
 *
 * Resolves every lead's client with the SAME function the send path uses
 * (integrations/clients/ownership.js) and reports the distribution, any
 * ownership conflicts, and any lead holding a sender of another client.
 *
 * Lead ownership is derived from routing columns that Supabase and the Sheets
 * mirror hold verbatim, so it cannot differ between them; the column-level
 * parity itself is what scripts/supabase-parity-audit.js checks.
 *
 * GET only, one narrow select (7 columns). Writes nothing, sends nothing.
 * Output carries lead ids and counts, never email addresses.
 */

require('dotenv').config();
const { mirrorConfig } = require('../integrations/supabase-mirror');
const { resolveLeadClient, checkClientConsistency } = require('../integrations/clients/ownership');
const { configuredSenders } = require('../integrations/gmail-sender-routing');

const PAGE = 1000;
const COLUMNS = 'lead_id,lead_niche,email_template_id,intended_campaign_version,campaign,trade_type,sender_inbox_id';

async function main() {
  const config = mirrorConfig();
  if (!config.enabled) throw new Error(`Supabase is not configured: ${config.reason}`);
  // PostgREST caps a response at 1,000 rows; page by a stable order.
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const response = await fetch(`${config.url}/rest/v1/outreach_leads?select=${COLUMNS}&order=lead_id.asc&limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`outreach_leads HTTP ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const senders = configuredSenders();
  const byClient = {};
  const conflicts = [];
  const senderMismatches = [];
  for (const row of rows) {
    const lead = {
      id: row.lead_id, leadNiche: row.lead_niche, emailTemplateId: row.email_template_id,
      intendedCampaignVersion: row.intended_campaign_version, campaign: row.campaign,
      tradeType: row.trade_type, senderInboxId: row.sender_inbox_id,
    };
    const owner = resolveLeadClient(lead);
    if (!owner.ok) { conflicts.push({ leadId: lead.id, reason: owner.reason }); continue; }
    byClient[owner.clientId] = (byClient[owner.clientId] || 0) + 1;
    const full = checkClientConsistency({ lead, senders });
    if (!full.ok) senderMismatches.push({ leadId: lead.id, reason: full.reason });
  }
  const report = {
    at: new Date().toISOString(), leads: rows.length, byClient,
    conflicts: conflicts.length, senderMismatches: senderMismatches.length,
    conflictSample: conflicts.slice(0, 20), senderMismatchSample: senderMismatches.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));
  if (conflicts.length || senderMismatches.length) process.exitCode = 2;
}

main().catch(error => { console.error(`[client-ownership-audit] ${error.message}`); process.exitCode = 1; });
