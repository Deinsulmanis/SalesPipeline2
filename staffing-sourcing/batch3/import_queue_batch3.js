'use strict';
/**
 * Import and queue only Batch 3 leads that cleared personalization AND live
 * preflight. Uses POST /api/coldemail/import and POST /api/coldemail/queue
 * through the authenticated ops proxy. Does not send mail or change campaign
 * copy/cadence/caps.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadOpsEnv, parseCsv } = require('./personalize_batch3');
const { classify: classifyLeadEmail } = require('../../check-leads');

const STAFFING_CAMPAIGN = {
  id: 'industrial_staffing_employer_acquisition_v1',
  name: 'Industrial Staffing Agency',
  emailTemplateId: 'industrial-staffing-employer-v1',
  senderInboxId: 'primary',
};

async function ops(pathname, opts = {}) {
  const { url, token } = loadOpsEnv();
  const res = await fetch(`${url}${pathname}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${pathname} -> ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
    err.status = res.status; err.json = json;
    throw err;
  }
  return json;
}

function norm(email) { return String(email || '').toLowerCase().trim(); }

function preflight(row, live) {
  const email = norm(row.email);
  if (!email) return 'invalid (no email)';
  const verdict = classifyLeadEmail(email);
  if (verdict !== 'CLEAN') return `junk (${verdict})`;
  if (!row.siteContext) return 'missing opening';
  if (!row.notes) return 'missing notes';
  if (live.emails.has(email)) return 'duplicate email vs live corpus';
  if (live.ids.has(String(row.id || ''))) return 'duplicate id vs live corpus';
  return null;
}

async function run({ csvFile, out }) {
  fs.mkdirSync(out, { recursive: true });
  const before = await ops('/corpus');
  const beforeDental = before.dentalTotal;
  const live = {
    emails: new Set((before.leads || []).map(l => norm(l.email))),
    ids: new Set((before.leads || []).map(l => String(l.id))),
    companies: new Set((before.leads || []).map(l => String(l.company || '').toLowerCase().trim())),
    total: before.total,
    queued: before.queued,
    sent: before.sent,
  };
  const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  const blocked = [];
  const accepted = [];
  for (const row of rows) {
    const reason = preflight(row, live);
    if (reason) blocked.push({ email: row.email, company: row.company, reason });
    else accepted.push(row);
  }

  const importRows = accepted.map(r => ({
    email: r.email,
    company: r.company,
    contactName: r.contactName,
    city: r.city,
    tradeType: r.tradeType,
    website: r.website,
    notes: r.notes,
    reviewCount: r.reviewCount || '',
    rating: r.rating || '',
    tier: r.tier || '',
    siteContext: r.siteContext,
  }));

  const report = {
    before: { total: before.total, queued: before.queued, sent: before.sent, dentalTotal: beforeDental, unfiltered: before.totalUnfiltered },
    csvRows: rows.length,
    preflightAccepted: accepted.length,
    preflightBlocked: blocked,
    import: null,
    queue: null,
    after: null,
    verification: null,
  };
  fs.writeFileSync(path.join(out, 'import-preflight.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ preflightAccepted: accepted.length, blocked: blocked.length, before: report.before }, null, 2));
  if (!importRows.length) {
    fs.writeFileSync(path.join(out, 'import-report.json'), JSON.stringify(report, null, 2));
    return report;
  }

  report.import = await ops('/import', {
    method: 'POST',
    body: {
      campaign: STAFFING_CAMPAIGN.name,
      lead_niche: 'industrial_staffing',
      rows: importRows,
    },
  });
  fs.writeFileSync(path.join(out, 'import-report.json'), JSON.stringify(report, null, 2));
  console.log('import', report.import);

  const wanted = new Set(importRows.map(r => norm(r.email)));
  let afterImport = await ops('/corpus');
  let newLeads = (afterImport.leads || []).filter(l => wanted.has(norm(l.email)) && !live.ids.has(String(l.id)));
  for (let i = 0; i < 30 && newLeads.length < (report.import.imported || 0); i++) {
    await new Promise(r => setTimeout(r, 2000));
    afterImport = await ops('/corpus');
    newLeads = (afterImport.leads || []).filter(l => wanted.has(norm(l.email)) && !live.ids.has(String(l.id)));
    console.log(`mirror poll ${i + 1}: ${newLeads.length}/${report.import.imported} visible`);
  }
  const importedByEmail = new Map(newLeads.map(l => [norm(l.email), l]));
  const missing = importRows.filter(r => !importedByEmail.has(norm(r.email)));
  const extra = (afterImport.leads || []).filter(l => !live.ids.has(String(l.id)) && !wanted.has(norm(l.email)));
  report.afterImport = {
    total: afterImport.total, queued: afterImport.queued, sent: afterImport.sent,
    dentalTotal: afterImport.dentalTotal, newLeadCount: newLeads.length,
    missing: missing.map(r => r.email), extra: extra.map(l => ({ id: l.id, email: l.email })),
  };

  const queueIds = newLeads.map(l => l.id);
  if (queueIds.length) {
    report.queue = await ops('/queue', {
      method: 'POST',
      body: {
        ids: queueIds,
        senderInboxId: STAFFING_CAMPAIGN.senderInboxId,
        emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
        campaignVersionId: STAFFING_CAMPAIGN.id,
      },
    });
    console.log('queue', {
      queued: report.queue.queued, alreadyQueued: report.queue.alreadyQueued,
      failed: report.queue.failed, error: report.queue.error || null,
    });
  }

  const after = await ops('/corpus');
  const finalNew = (after.leads || []).filter(l => live.emails.has(norm(l.email)) === false);
  const activities = [];
  for (const lead of finalNew) {
    const activity = await ops(`/activity/${encodeURIComponent(lead.id)}`);
    activities.push({ id: lead.id, email: lead.email, activity });
  }

  const queuedEvents = activities.map(a => {
    const list = Array.isArray(a.activity?.activities) ? a.activity.activities : [];
    const queued = list.filter(e => (e.eventType || e.type) === 'lead_queued');
    return {
      id: a.id, email: a.email, leadQueuedCount: queued.length,
      eventTypes: list.map(e => e.eventType || e.type).slice(0, 20),
      notesHasCatchAll: false,
    };
  });

  report.after = {
    total: after.total, queued: after.queued, sent: after.sent,
    dentalTotal: after.dentalTotal, unfiltered: after.totalUnfiltered,
    corpusDelta: after.total - before.total,
    dentalDelta: (after.dentalTotal ?? 0) - (beforeDental ?? 0),
  };
  report.verification = {
    importedCount: report.import?.imported ?? null,
    newCanonical: finalNew.length,
    queue: report.queue ? {
      requested: report.queue.requested, succeeded: report.queue.succeeded,
      unchanged: report.queue.unchanged, failed: report.queue.failed,
      conflict: report.queue.conflict, queuedIds: report.queue.queuedIds,
    } : null,
    notesCatchAll: finalNew.filter(l => String(l.notes || '').includes('[B3 CATCH-ALL]')).map(l => l.email),
    notesB3: finalNew.filter(l => /\[B3\]/.test(l.notes || '')).length,
    sender: [...new Set(finalNew.map(l => l.senderInboxId))],
    template: [...new Set(finalNew.map(l => l.emailTemplateId))],
    version: [...new Set(finalNew.map(l => l.intendedCampaignVersion))],
    stages: [...new Set(finalNew.map(l => l.stage))],
    activities: queuedEvents,
    dentalUntouched: report.after.dentalDelta === 0,
  };
  fs.writeFileSync(path.join(out, 'import-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ after: report.after, verification: report.verification }, null, 2));
  return report;
}

if (require.main === module) {
  run({
    csvFile: process.argv[2] || path.join(__dirname, 'personalization/batch3-import-ready-approved.csv'),
    out: process.argv[3] || path.join(__dirname, 'personalization'),
  }).catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { run };
