'use strict';
// Insurance pilot: example WC renewal sample lists (company level only, no personal data).
// Same pattern as integrations/scalelab-sample-list.js (pure select + plain-text table + simple HTML table,
// no dashes in cells), but for the insurance niche and offline: it reads the run's private employers.json and
// writes the lists into the run folder. Nothing here is wired into production or sends anything.
//
// Usage: node renewal_sample_list.js <run_dir>
// Reads  <run>/tx/employers.json (tx_renewals.py)
// Writes <run>/sample_lists/<key>.{csv,txt,html} and <run>/sample_lists/summary.json (counts only)
const fs = require('fs');
const path = require('path');

const MAX = 20;
// Staffing / labor agencies are the staffing campaign's prospects (and insure their workers under client class
// codes): never shown on an insurance employer list.
const STAFFING = /\b(staffing|recruit\w*|personnel|temporary|temps?|workforce|labor (services|solutions|force)|manpower|employment (services|agency))\b/i;
const TRUCKING_CODES = new Set(['7219', '7228', '7229', '7230', '7231', '7232', '7360', '7380']);
const INDUSTRY_LABEL = { manufacturing: 'Manufacturing', construction: 'Construction', trucking_logistics: 'Trucking', warehousing: 'Warehousing / wholesale', other: 'Other' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'LTD', 'USA', 'US', 'II', 'III', 'HVAC', 'CNC', 'DBA', 'PLLC', 'CO.', 'L.P.', 'L.L.C.']);

const LISTS = [
  { key: 'houston-manufacturing', title: 'Houston manufacturing', match: e => e.metro === 'Houston' && e.industry === 'manufacturing' },
  { key: 'dfw-construction', title: 'Dallas-Fort Worth construction', match: e => e.metro === 'Dallas-Fort Worth' && e.industry === 'construction' },
  { key: 'texas-trucking', title: 'Texas trucking (statewide)', match: e => e.industry === 'trucking_logistics' && TRUCKING_CODES.has(String(e.class_code)) },
];

// Short real words are title-cased; other 1-3 letter tokens are treated as initials (R&S, AAA, TRP).
const SHORT_WORDS = new Set(['THE', 'AND', 'OF', 'CO', 'INC', 'IN', 'ON', 'AT', 'TO', 'BY', 'FOR', 'NEW', 'OLD', 'ALL', 'ONE', 'TWO', 'BIG', 'TOP',
  'SUN', 'AIR', 'OIL', 'GAS', 'BAY', 'RED', 'ACE', 'PRO', 'MAX', 'HUB', 'KEY', 'WAY', 'OAK', 'ELM', 'FOX', 'BUY', 'GO', 'MY', 'A', 'AN', 'OR', 'DE', 'LA', 'EL', 'LOS', 'SAN', 'RIO', 'TRI', 'BAR', 'CAR', 'SKY', 'ICE', 'DRY', 'WET', 'HOT', 'ART', 'LAB', 'TEC']);
const noDashes = s => String(s).replace(/\s*[–—-]\s*/g, ' ').replace(/\s+/g, ' ').trim();

function titleCase(name) {
  return String(name).trim().split(/\s+/).map(w => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up)) return up === 'CO.' ? 'Co.' : up;
    if (/^[A-Z&]{1,3}$/.test(up) && !SHORT_WORDS.has(up)) return up; // initials such as "R&S", "AAA"
    return up.charAt(0) + up.slice(1).toLowerCase();
  }).join(' ').replace(/\bCo\b/g, 'Co');
}

// The dataset cuts employer names at ~35 characters and carrier names at 30: drop a cut-off last word.
const untruncate = (name, limit) => {
  const n = String(name).trim();
  return n.length >= limit && n.includes(' ') ? n.slice(0, n.lastIndexOf(' ')) : n;
};
const CARRIER_TAIL = /\s+(COMPAN?Y?|COMP|COM|CO|INSURANC?E?|INSUR|INSU|INS|CORPORATI?O?N?|CORP|ASSOCIATI?O?N?|ASSN|OF|AND|&)$/i;
const carrierClean = c => { let n = String(c).trim(); if (n.length >= 29) n = untruncate(n, 29); for (let i = 0; i < 2; i += 1) n = n.replace(CARRIER_TAIL, m => (/insur/i.test(m) && !/insur.*insur/i.test(n) ? ' Insurance' : '')); return n.trim(); };
const bandLabel = b => String(b).replace('-', ' to ');
const renewalMonth = iso => { const [y, m] = String(iso).split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
const carrierLabel = c => titleCase(carrierClean(c));

/** Up to 20 employers: Texas addresses, obvious business names only, largest premium first (one row per name). */
function selectRenewalList(employers, spec, max = MAX) {
  const seen = new Set();
  return employers
    .filter(e => e.state === 'TX' && e.business_name && !STAFFING.test(e.employer_name) && spec.match(e))
    .sort((a, b) => b.premium - a.premium || a.employer_name.localeCompare(b.employer_name))
    .filter(e => { const k = e.employer_name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, max)
    .map(e => ({
      company: titleCase(untruncate(e.employer_name, 34)), city: titleCase(e.city), industry: INDUSTRY_LABEL[e.industry] || e.industry,
      carrier: carrierLabel(e.carrier), renewal: renewalMonth(e.expiration), premiumBand: bandLabel(e.premium_band),
    }));
}

const COLUMNS = [['Company', 'company'], ['City', 'city'], ['Industry', 'industry'], ['Current carrier', 'carrier'], ['Renewal month', 'renewal'], ['Premium band', 'premiumBand']];

function renderTable(rows) {
  const data = [COLUMNS.map(c => c[0]), ...rows.map(r => COLUMNS.map(c => noDashes(r[c[1]])))];
  const width = COLUMNS.map((_, i) => Math.max(...data.map(row => row[i].length)));
  const line = row => row.map((v, i) => (i === row.length - 1 ? v : v.padEnd(width[i]))).join(' | ');
  const header = line(data[0]);
  return [header, '='.repeat(header.length), ...data.slice(1).map(line)].join('\n');
}

const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CELL = 'text-align:left;padding:4px 10px;';

function htmlTable(rows, title) {
  const head = COLUMNS.map(c => `<th style="${CELL}border-bottom:1px solid;">${c[0]}</th>`).join('');
  const body = rows.map(r => '<tr>' + COLUMNS.map(c => `<td style="${CELL}">${escapeHtml(noDashes(r[c[1]]))}</td>`).join('') + '</tr>').join('');
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + `<h3 style="font-family:sans-serif">${escapeHtml(title)}: WC policies renewing Jan to Mar 2027</h3>`
    + `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    + '<p style="font-family:sans-serif;font-size:12px">Source: Texas Department of Insurance, Division of Workers\' Compensation, coverage subscriber data (data.texas.gov). Company-level public coverage data; premium shown as a band.</p>';
}

const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

function main() {
  const run = process.argv[2];
  const employers = JSON.parse(fs.readFileSync(path.join(run, 'tx', 'employers.json'), 'utf8'));
  const out = path.join(run, 'sample_lists');
  fs.mkdirSync(out, { recursive: true });
  const summary = {};
  for (const spec of LISTS) {
    const rows = selectRenewalList(employers, spec);
    fs.writeFileSync(path.join(out, `${spec.key}.csv`), [COLUMNS.map(c => c[0]).join(','), ...rows.map(r => COLUMNS.map(c => csvCell(r[c[1]])).join(','))].join('\n') + '\n');
    fs.writeFileSync(path.join(out, `${spec.key}.txt`), `${spec.title}: WC policies renewing Jan to Mar 2027\n\n${renderTable(rows)}\n`);
    fs.writeFileSync(path.join(out, `${spec.key}.html`), htmlTable(rows, spec.title));
    const pool = employers.filter(e => e.state === 'TX' && e.business_name && !STAFFING.test(e.employer_name) && spec.match(e)).length;
    summary[spec.key] = { rows: rows.length, pool, by_band: rows.reduce((a, r) => ((a[r.premiumBand] = (a[r.premiumBand] || 0) + 1), a), {}),
      by_month: rows.reduce((a, r) => ((a[r.renewal] = (a[r.renewal] || 0) + 1), a), {}) };
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

if (require.main === module) main();
module.exports = { STAFFING, selectRenewalList, renderTable, htmlTable, titleCase, noDashes, LISTS };
