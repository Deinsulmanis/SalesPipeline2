'use strict';
/**
 * open-filter.js — scanner-detonation filtering for ProposalOpens.
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE source of truth for "is this proposal open a real human, or a machine?".
 * Required by BOTH outreach-agent.js (warm-follow-up gating) and server.js
 * (dashboard open stats), the same way check-leads.js owns the junk classifier.
 * Do not fork this logic into either caller — a second copy silently drifts,
 * exactly the problem the cleanCompanyName/proposalToken "must stay in sync"
 * comments exist to warn about.
 *
 * READ-TIME ONLY. Nothing here mutates or deletes a ProposalOpens row; the raw
 * log stays intact and every count is derived on read.
 *
 * Two independent scanner signals (either one is enough to flag a row):
 *   (a) the open lands within OPEN_SCANNER_WINDOW_MS of that lead's recorded
 *       lastEmailedAt — mail filters detonate links at delivery; humans read
 *       later.
 *   (b) the open comes from a datacenter/cloud egress IP — a dental practice
 *       browses from a residential or business ISP, not from AWS.
 *
 * ...then a rescue, so a genuinely interested prospect is never deflated: a
 * flagged open still counts as REAL if that same company shows independent
 * human behaviour — a ProposalEngaged or DemoPlays event, or opens spanning
 * two different Vancouver calendar days. (Live example: Sasamat Dental opened
 * 157s after send from a residential IP — flagged by (a) — but scrolled the
 * page to 100%, so it counts.)
 *
 * TWO DELIBERATE LIMITS ON THE RESCUE, both measured against the live log:
 *   1. The multi-day rescue counts only NON-datacenter opens. A scanner re-fires
 *      once per send step, so its hits naturally land on different days —
 *      letting those days vouch for themselves rescued 22 of the 35 confirmed
 *      Azure SafeLinks rows, i.e. it re-inflated the exact number this filter
 *      exists to remove.
 *   2. A datacenter-IP open is rescued ONLY by a direct human signal
 *      (ProposalEngaged / DemoPlays) for that company, never by day-spanning.
 *      A machine egress is not a person; if a human at that company also
 *      visited, their own residential open is already counted on its own.
 */

// Detonation happens at delivery; a human read is later than this.
const OPEN_SCANNER_WINDOW_MS = 5 * 60 * 1000;

// Datacenter / cloud egress ranges, matched as literal dotted-string prefixes.
// The trailing dot on every entry is load-bearing: '3.' matches 3.141.14.156
// but NOT 34.162.230.9, and '4.' does not match 44.214.52.7.
// EXTEND BY ADDING A LINE — no other change is needed anywhere.
const DATACENTER_IP_PREFIXES = [
  '4.204.72.', // Azure / Outlook SafeLinks — confirmed offender, fires seconds
               // after send. Subsumed by '4.' below but kept explicit as the
               // documented case that motivated this filter.
  '3.',        // AWS
  '4.',        // Azure
  '13.',       // AWS / Azure
  '18.',       // AWS
  '20.',       // Azure
  '34.',       // GCP
  '35.',       // GCP
  '40.',       // Azure
  '52.',       // AWS / Azure
  '54.',       // AWS
  '107.178.',  // GCP (Google Cloud egress seen in the same fanout bursts)
];

function isDatacenterIp(ip) {
  const s = String(ip == null ? '' : ip).trim();
  if (!s) return false;
  return DATACENTER_IP_PREFIXES.some(p => s.startsWith(p));
}

const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

/**
 * Is this single open row machine-generated?
 * `lead` may be null/undefined (an orphaned open) — then only rule (b) applies.
 * Pure: no rescue logic here, so it stays usable row-by-row.
 */
function isScannerOpen(open, lead) {
  if (!open) return false;
  if (isDatacenterIp(open.ip)) return true;                       // (b)
  const ts = new Date(open.timestamp).getTime();                  // (a)
  const sent = lead ? new Date(lead.lastEmailedAt).getTime() : NaN;
  if (!isNaN(ts) && !isNaN(sent) && Math.abs(ts - sent) <= OPEN_SCANNER_WINDOW_MS) return true;
  return false;
}

/**
 * Annotate every open row with { key, scanner, rescued, real }.
 *
 * @param opens        ProposalOpens rows: { timestamp, company, id, ip, ... }
 * @param leadFor(open) → the matching lead (for lastEmailedAt), or null
 * @param keyOf(row)   → canonical company key. Caller supplies it so each side
 *                       reuses its own cleanCompanyName rather than this module
 *                       becoming a third copy of that function.
 * @param engagedRows  ProposalEngaged rows (any object with .company)
 * @param demoRows     DemoPlays rows (any object with .company)
 */
function annotateOpens({ opens = [], leadFor = () => null, keyOf, engagedRows = [], demoRows = [] }) {
  const key = keyOf || (r => String((r && r.company) || '').toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Companies with independent proof a human was on the page.
  const humanKeys = new Set();
  for (const r of engagedRows) { const k = key(r); if (k) humanKeys.add(k); }
  for (const r of demoRows)    { const k = key(r); if (k) humanKeys.add(k); }

  // Distinct Vancouver calendar days per company, counting ONLY opens that did
  // not come from a datacenter IP — see limit 1 in the header comment.
  const daysByKey = new Map();
  for (const o of opens) {
    if (isDatacenterIp(o.ip)) continue;
    const k = key(o);
    const ts = new Date(o.timestamp).getTime();
    if (!k || isNaN(ts)) continue;
    if (!daysByKey.has(k)) daysByKey.set(k, new Set());
    daysByKey.get(k).add(dayOf(ts));
  }

  return opens.map(o => {
    const k = key(o);
    const datacenter = isDatacenterIp(o.ip);
    const scanner = isScannerOpen(o, leadFor(o));
    const humanProof = !!k && humanKeys.has(k);
    const multiDay = (daysByKey.get(k) || new Set()).size >= 2;
    // A datacenter open needs direct human proof; a timing-only flag can also
    // be cleared by a genuine return visit on another day (limit 2 above).
    const rescued = scanner && (datacenter ? humanProof : (humanProof || multiDay));
    return { ...o, key: k, datacenter, scanner, rescued, real: !scanner || rescued };
  });
}

/**
 * Headline numbers. `isLeadKey` (optional) restricts counting to companies that
 * match an actual lead, so orphaned rows ('Unknown', test clinics) are excluded
 * exactly as the dashboard already does.
 */
function countRealOpens(args) {
  const rows = annotateOpens(args);
  const isLeadKey = args.isLeadKey || (() => true);
  const real = rows.filter(r => r.real && r.key && isLeadKey(r.key));
  return {
    rows,
    realRowCount: real.length,
    uniqueCompanies: new Set(real.map(r => r.key)).size,
    scannerRowCount: rows.length - real.length,
  };
}

module.exports = {
  OPEN_SCANNER_WINDOW_MS,
  DATACENTER_IP_PREFIXES,
  isDatacenterIp,
  isScannerOpen,
  annotateOpens,
  countRealOpens,
};
