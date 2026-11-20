'use strict';

/**
 * READ-ONLY Industrial Staffing V4 preview.
 *
 *   node scripts/staffing-v4-preview.js <evidence.json> <out_dir>
 *
 * For every sourced V4 lead in the evidence file (built by
 * docs/scalelab-sourcing/runs/v4-copy-2026-11-20/scripts/build_evidence.py) it
 * selects the Email 1 variant, seals the profile in memory, renders all three
 * touches through the production renderer and reports holds, missing
 * variables, and suppression / admission status.
 *
 * It writes only to <out_dir>. It reads no CRM state, writes no lead, queues,
 * enrolls and sends nothing, and makes no network or model call.
 */

const fs = require('node:fs');
const path = require('node:path');
const copy = require('../integrations/staffing-v4-copy');
const profileLib = require('../integrations/staffing-v4-profile');
const { STAFFING_CAMPAIGN_V4, renderStaffingEmail, validateStaffingEmail, staffingV4SendBlock } = require('../integrations/staffing-campaign');
const { appendStaffingComplianceFooter, staffingSenderIdentity } = require('../integrations/staffing-compliance');
const { PRODUCTION_STAFFING_RENDER_OPTIONS: OPTIONS } = require('../test-support/staffing-mail');
const { recipientProviderPolicy, POLICY } = require('../integrations/cold-delivery-policy');

const [, , evidencePath, outDir] = process.argv;
if (!evidencePath || !outDir) {
  console.error('usage: node scripts/staffing-v4-preview.js <evidence.json> <out_dir>');
  process.exit(2);
}

const SELECTED_AT = '2026-11-20T00:00:00.000Z';
const records = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

// The recipient-provider policy the production code applies, from the same
// RECIPIENT_PROVIDER_POLICY setting (default off). Production is off as of
// 2026-11-20; set RECIPIENT_PROVIDER_POLICY=google_only to preview that policy.
const PROVIDER_POLICY = recipientProviderPolicy(process.env);
function admission(row) {
  const gateway = String(row.mail_gateway || '').toLowerCase() || 'unknown';
  if (PROVIDER_POLICY !== POLICY.GOOGLE_ONLY) return `ADMITTED (RECIPIENT_PROVIDER_POLICY=${PROVIDER_POLICY}; mailbox host: ${gateway})`;
  return gateway === 'google'
    ? 'ADMITTED under RECIPIENT_PROVIDER_POLICY=google_only'
    : `HELD under RECIPIENT_PROVIDER_POLICY=google_only (mailbox host: ${gateway})`;
}

const results = records.map(({ row, evidence }) => {
  const selection = copy.selectV4Variant(evidence);
  const profile = profileLib.buildStaffingV4Profile({
    row: { company: evidence.company, company_domain: row.company_domain, contact_name: evidence.contactName, email: row.email,
      v4_tag: row.v4_tag, demand_score: row.demand_score, signal_priority: row.signal_priority, ad_class: row.ad_class,
      contact_status: row.contact_status },
    selection, selectedAt: SELECTED_AT, sourcingRunId: row.wave,
  });
  const lead = {
    id: `preview-${row.company_domain}`, company: evidence.company, contactName: evidence.contactName, email: row.email,
    leadNiche: 'industrial_staffing', campaign: STAFFING_CAMPAIGN_V4.name, intendedCampaignVersion: STAFFING_CAMPAIGN_V4.id,
    emailTemplateId: STAFFING_CAMPAIGN_V4.emailTemplateId, notes: '', stage: 'Import',
    campaign_notes: profileLib.serializeStaffingV4Profile(profile),
  };
  const emails = [];
  const problems = [];
  if (selection.status === 'SELECTED') {
    for (const step of [1, 2, 3]) {
      try {
        const email = renderStaffingEmail(lead, step, OPTIONS);
        const invalid = validateStaffingEmail(email, step);
        if (invalid) problems.push(`Email ${step}: ${invalid}`);
        emails.push({ step, subject: email.subject || `Re: ${emails[0]?.subject || ''}`, body: email.body, html: email.html, sendable: true });
      } catch (error) { problems.push(`Email ${step}: ${error.message}`); }
    }
  } else if (selection.variant) {
    // Evidence supports a variant but the lead is held: show the copy for
    // review, clearly marked, through the same strict merge.
    const identity = staffingSenderIdentity(OPTIONS.env, OPTIONS);
    for (const step of [1, 2, 3]) {
      try {
        const r = copy.renderV4Copy({ variant: selection.variant, step, vars: selection.vars, appendFooter: t => appendStaffingComplianceFooter(t, identity) });
        emails.push({ step, subject: step === 1 ? r.subject : `Re: ${emails[0]?.subject || ''}`, body: r.body, html: r.html, sendable: false });
      } catch (error) { problems.push(`Email ${step}: ${error.message}`); }
    }
  }
  const nameChanged = evidence.company !== row.company_name;
  return {
    company: row.company_name, displayCompany: evidence.company, nameChanged, domain: row.company_domain, wave: row.wave,
    buyer: evidence.contactName, title: row.buyer_title, email: row.email, emailStatus: row.email_status,
    catchAll: row.catch_all, gateway: row.mail_gateway,
    tag: row.v4_tag, demandScore: row.demand_score, priority: row.signal_priority, adClass: row.ad_class, copyTier: row.copy_tier,
    contactStatus: row.contact_status, qcFlags: row.qc_flags,
    status: selection.status, variant: selection.variant, vars: selection.vars, evidence: selection.evidence,
    specialization: evidence.specialization, considered: selection.considered, holds: selection.holds,
    signalsNotSearched: evidence.signalsNotSearched,
    sendBlock: staffingV4SendBlock(lead), admission: admission(row),
    suppression: row.suppression_status, dedupe: row.dedupe_status,
    emails, problems,
  };
});

const count = key => results.reduce((acc, r) => ({ ...acc, [r[key] || 'HOLD']: (acc[r[key] || 'HOLD'] || 0) + 1 }), {});
const summary = {
  generatedFrom: path.basename(evidencePath), leads: results.length,
  byStatus: count('status'),
  byVariant: results.reduce((acc, r) => { const k = r.status === 'SELECTED' ? r.variant : `HOLD${r.variant ? ` (evidence: ${r.variant})` : ''}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
  providerPolicy: PROVIDER_POLICY,
  admitted: results.filter(r => r.admission.startsWith('ADMITTED')).length,
  googleHosted: results.filter(r => String(r.gateway).toLowerCase() === 'google').length,
  sendable: results.filter(r => !r.sendBlock).length,
  renderProblems: results.reduce((n, r) => n + r.problems.length, 0),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'v4-preview.json'), JSON.stringify({ summary, leads: results }, null, 1));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const order = { COPY_A: 1, COPY_D: 2, COPY_E: 3, COPY_F: 4, COPY_B: 5, COPY_C: 6, '': 7 };
const sorted = [...results].sort((a, b) => (a.status === b.status ? 0 : a.status === 'HOLD' ? 1 : -1) || order[a.variant] - order[b.variant] || a.company.localeCompare(b.company));
const card = r => `
<section class="lead ${r.status === 'HOLD' ? 'hold' : ''}">
  <h2>${esc(r.displayCompany)} <span class="pill v">${esc(r.status === 'SELECTED' ? r.variant : `HOLD${r.variant ? ` · evidence ${r.variant}` : ''}`)}</span></h2>
  <table>
    <tr><th>Company (sourced)</th><td>${esc(r.company)}${r.nameChanged ? ' <span class="warn">display name shortened: confirm</span>' : ''} · ${esc(r.domain)} · ${esc(r.wave)}</td></tr>
    <tr><th>Buyer</th><td>${esc(r.buyer)}, ${esc(r.title)} · ${esc(r.email)}</td></tr>
    <tr><th>Original tag</th><td><code>${esc(r.tag)}</code> · demand ${esc(r.demandScore)} · copy tier ${esc(r.copyTier)} (unchanged)</td></tr>
    <tr><th>Variant evidence</th><td>${r.evidence ? `<a href="${esc(r.evidence.url)}">${esc(r.evidence.url)}</a><br><q>${esc((r.evidence.quote || r.evidence.text || '').slice(0, 300))}</q>${r.evidence.lastSeen ? ` · last seen ${esc(r.evidence.lastSeen)}` : ''}` : '—'}</td></tr>
    <tr><th>Variables</th><td>${Object.entries(r.vars).map(([k, v]) => `<code>${esc(k)}</code> = ${esc(v)}`).join('<br>') || '—'}</td></tr>
    <tr><th>Passed over</th><td>${r.considered.map(c => `${esc(c.variant)}: ${esc(c.detail)}`).join('<br>') || '—'}</td></tr>
    <tr><th>Not searched</th><td>${esc((r.signalsNotSearched || []).join(', '))}</td></tr>
    <tr><th>Holds</th><td class="${r.holds.length ? 'warn' : ''}">${esc(r.holds.join('; ') || 'none')}</td></tr>
    <tr><th>Send status</th><td>${esc(r.sendBlock || 'sendable')}</td></tr>
    <tr><th>Contact QC</th><td>${esc(r.contactStatus)} · ${esc(r.emailStatus)} · catch-all ${esc(r.catchAll || 'unknown')}${r.qcFlags ? ` · ${esc(r.qcFlags)}` : ''}</td></tr>
    <tr><th>Suppression</th><td>${esc(r.suppression)} · global Suppression sheet must be checked at import</td></tr>
    <tr><th>Admission</th><td class="${/HELD/.test(r.admission) ? 'warn' : ''}">${esc(r.admission)}</td></tr>
    ${r.problems.length ? `<tr><th>Render problems</th><td class="warn">${esc(r.problems.join('; '))}</td></tr>` : ''}
  </table>
  ${r.emails.map(e => `<div class="email${e.sendable ? '' : ' unsendable'}"><div class="meta">Email ${e.step}${e.step === 1 ? ' (day 0)' : e.step === 2 ? ' (day 3)' : ' (day 7)'} · Subject: <b>${esc(e.subject)}</b>${e.sendable ? '' : ' · NOT SENDABLE (lead on hold)'}</div>${e.html}</div>`).join('')}
</section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V4 Copy Preview</title><style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--line:#e2e1dc;--card:#fff;--warn:#a4441b;--pill:#eef1f7}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a3a29c;--line:#34332f;--card:#1f1f1d;--warn:#f0a07a;--pill:#2a2f3a}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:980px;margin:auto}
h1{font-size:22px}h2{font-size:18px;margin:0 0 8px}.lead{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.lead.hold{border-color:var(--warn)}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;color:var(--mut);font-weight:500;width:150px;vertical-align:top;padding:3px 8px 3px 0}td{padding:3px 0;overflow-wrap:anywhere}
.pill{background:var(--pill);border-radius:99px;padding:2px 10px;font-size:13px}.warn{color:var(--warn)}
.email{border-top:1px solid var(--line);margin-top:12px;padding-top:8px}.email p{margin:0 0 10px}.email.unsendable{opacity:.75}.meta{color:var(--mut);font-size:13px;margin-bottom:6px}
code{font-size:12px}</style></head><body>
<h1>Industrial Staffing V4: copy preview (read only)</h1>
<p>${esc(summary.leads)} leads · ${esc(JSON.stringify(summary.byVariant))}. Nothing here is queued or sent. All leads stay REVIEW READY; V4 is a draft campaign.</p>
${sorted.map(card).join('\n')}
</body></html>`;
fs.writeFileSync(path.join(outDir, 'v4-preview.html'), html);
console.log(JSON.stringify(summary, null, 1));
