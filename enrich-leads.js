#!/usr/bin/env node
/**
 * enrich-leads.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads a raw Apify/Thunderbit/PhantomBuster export (CSV or TSV), filters to
 * reviewCount ≥ 50, scrapes each site for an email address and siteContext,
 * then writes:
 *
 *   leads-enriched.csv  — rows where an email was found (import-ready)
 *   leads-noemail.csv   — qualifying rows with no email (handle manually)
 *
 * Usage:
 *   node enrich-leads.js input.csv
 *   node enrich-leads.js input.tsv
 *
 * Does NOT send any email or touch any sheet.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const cheerio = require('cheerio');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const [,, INPUT_FILE] = process.argv;
const MIN_REVIEWS    = 50;
const SCRAPE_TIMEOUT = 8_000;
const DELAY_MIN      = 1_000;
const DELAY_MAX      = 2_000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Substrings that flag an email as junk — skip these regardless of domain
const JUNK_PATTERNS = [
  'example@', 'sentry@', 'wixpress', 'godaddy', '.png', '.jpg', '.gif',
  'noreply', 'no-reply', '@sentry', 'privacy@', 'dmarc@',
];

// Personal webmail domains — prefer a business-domain address over these
const GENERIC_DOMAINS = new Set([
  'gmail.com','hotmail.com','yahoo.com','outlook.com',
  'live.com','icloud.com','yahoo.ca','hotmail.ca','msn.com',
]);

// Maps actual (lowercased, trimmed) column headers to the internal field names
// the script uses. Only columns that differ need entries; others pass through.
const FIELD_MAP = {
  'business name':   'name',         // → r.name  (used as company)
  'reviews':         'reviewcount',  // → r.reviewcount
  'google rating':   'rating',       // → r.rating
  'google maps url': 'mapsurl',      // stored but not used in output
};

function normalizeHeader(raw) {
  const key = raw.trim().toLowerCase();
  return FIELD_MAP[key] ?? key;
}

const CSV_HEADER = [
  'company','email','contactName','city','tradeType',
  'website','reviewCount','rating','tier','siteContext',
];

// ── UTILITIES ─────────────────────────────────────────────────────────────────

const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = ()   => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));

function csvCell(val) {
  const s = String(val ?? '').replace(/\r?\n|\r/g, ' ');
  return (s.includes(',') || s.includes('"'))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}
const toRow = (obj) => CSV_HEADER.map(h => csvCell(obj[h] ?? '')).join(',');

// ── INPUT PARSING ─────────────────────────────────────────────────────────────

function detectDelimiter(sample) {
  const tabs   = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g)  || []).length;
  return tabs > commas ? '\t' : ',';
}

// Handles quoted fields (RFC 4180 compatible)
function splitLine(line, delim) {
  const cells = [];
  let curr = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { curr += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === delim && !inQ) {
      cells.push(curr); curr = '';
    } else {
      curr += ch;
    }
  }
  cells.push(curr);
  return cells;
}

function parseInput(filePath) {
  const raw   = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const delim = detectDelimiter(raw.slice(0, 4_000));
  const lines = raw.split('\n').filter(l => l.trim());
  // Strip BOM / outer quotes, then normalize via FIELD_MAP (case-insensitive, space-tolerant)
  const header = splitLine(lines[0], delim)
    .map(h => normalizeHeader(h.replace(/^﻿/, '').replace(/^"|"$/g, '')));

  return lines.slice(1).map(line => {
    const cells = splitLine(line, delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  }).filter(r => header.some(h => r[h])); // drop blank rows
}

// ── URL CLEANING ──────────────────────────────────────────────────────────────

function cleanUrl(raw) {
  if (!raw) return '';
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // Strip query string (utm params etc.) as instructed
  const q = u.indexOf('?');
  if (q !== -1) u = u.slice(0, q);
  try {
    const p = new URL(u);
    const clean = `${p.protocol}//${p.host}${p.pathname}`;
    return clean.endsWith('/') ? clean.slice(0, -1) : clean;
  } catch {
    return u;
  }
}

function siteOrigin(url) {
  try { const p = new URL(url); return `${p.protocol}//${p.host}`; }
  catch { return ''; }
}

function ownDomainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// ── EMAIL EXTRACTION ──────────────────────────────────────────────────────────

// Lookbehind/lookahead prevent mid-string matches; TLD capped at 6 to block "comwe"/"comtel" bleed
const EMAIL_RE = /(?<![a-zA-Z0-9._%+\-])([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})(?![a-zA-Z])/g;

function isJunk(email) {
  const lower = email.toLowerCase();
  return JUNK_PATTERNS.some(p => lower.includes(p));
}

function pickBestEmail(candidates, ownDomain) {
  const clean = candidates.filter(e => !isJunk(e) && e.length < 80);
  if (!clean.length) return null;

  // 1. Exact own-domain or subdomain of own domain
  if (ownDomain) {
    const own = clean.filter(e => {
      const dom = (e.split('@')[1] || '').toLowerCase();
      return dom === ownDomain || dom.endsWith('.' + ownDomain);
    });
    if (own.length) return own[0];
  }

  // 2. Any non-generic business domain
  const biz = clean.filter(e => !GENERIC_DOMAINS.has((e.split('@')[1] || '').toLowerCase()));
  if (biz.length) return biz[0];

  return clean[0];
}

function extractEmails(html, ownDomain) {
  const $ = cheerio.load(html);
  const seen = new Set();

  // mailto: links first — most reliable
  $('a[href^="mailto:"]').each((_, el) => {
    let href = $(el).attr('href') || '';
    try { href = decodeURIComponent(href); } catch(e) {}
    const e = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (e.includes('@')) seen.add(e);
  });

  // Inject spaces between elements to prevent text node concatenation bleed
  $('body *').each((_, el) => {
    const cur = $(el).text();
    if (cur) $(el).before(' ').after(' ');
  });
  const text = $('body').text();
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    if (m[1]) seen.add(m[1].toLowerCase());
  }

  const sanitized = [...seen].filter(e => {
    if (!/^[a-zA-Z0-9]/.test(e)) return false;
    const [local] = e.split('@');
    if (!local || local.length < 2) return false;
    const tld = e.split('.').pop();
    if (!tld || !/^[a-zA-Z]{2,6}$/.test(tld)) return false;
    return true;
  });

  return pickBestEmail(sanitized, ownDomain);
}

// ── SITE SCRAPING ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  try {
    const resp = await axios.get(url, {
      timeout: SCRAPE_TIMEOUT,
      maxRedirects: 3,
      headers: { 'User-Agent': BROWSER_UA },
      validateStatus: s => s >= 200 && s < 300,
    });
    return typeof resp.data === 'string' ? resp.data : null;
  } catch {
    return null;
  }
}

function extractContext(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer').remove();
  const parts = [];
  $('h1, h2, h3').each((_, el) => parts.push($(el).text()));
  $('p').each((_, el) => parts.push($(el).text()));
  $('[class*="about"],[class*="service"],[id*="about"],[id*="service"]')
    .each((_, el) => parts.push($(el).text()));
  return parts
    .map(t => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1_500);
}

async function enrichSite(websiteUrl) {
  const ownDomain = ownDomainOf(websiteUrl);
  const origin    = siteOrigin(websiteUrl);

  const homeHtml = await fetchHtml(websiteUrl);
  if (!homeHtml) return { email: '', siteContext: '' };

  const siteContext = extractContext(homeHtml);
  let email = extractEmails(homeHtml, ownDomain);

  // No email on homepage — try /contact then /contact-us once each
  if (!email && origin) {
    for (const slug of ['/contact', '/contact-us']) {
      const html = await fetchHtml(`${origin}${slug}`);
      if (!html) continue;
      email = extractEmails(html, ownDomain);
      if (email) break;
    }
  }

  return { email: email || '', siteContext };
}

// ── CITY EXTRACTION ──────────────────────────────────────────────────────────

// PhantomBuster address: "Street, City, Province PostalCode, Country"
// City is at index length-3 for 4-part addresses (e.g. "Vancouver" from
// "123 Main St, Vancouver, BC V5K 1A1, Canada").
function cityFromAddress(address) {
  if (!address) return '';
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  return parts[0] || '';
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!INPUT_FILE) {
    console.error('Usage: node enrich-leads.js <input.csv|tsv>');
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const rows = parseInput(INPUT_FILE);
  const isThunderbit    = rows.length > 0 && 'title' in rows[0] && 'review rating' in rows[0] && '# of reviews' in rows[0];
  const isPhantomBuster = !isThunderbit && rows.length > 0 && 'title' in rows[0] && 'placeurl' in rows[0];
  const sourceName      = isThunderbit ? 'Thunderbit' : isPhantomBuster ? 'PhantomBuster' : 'Apify';
  console.log(`\nLoaded ${rows.length} rows from ${path.resolve(INPUT_FILE)}`);
  console.log(`Source: ${sourceName}`);

  // Filter: normalizeHeader maps each source's review count column to a known key
  const qualified = rows.filter(r => {
    const raw = isThunderbit ? (r['# of reviews'] ?? '') : (r.reviewcount ?? '');
    const n   = parseInt(raw.replace(/,/g, ''), 10);
    return !isNaN(n) && n >= MIN_REVIEWS;
  });
  const skipped = rows.length - qualified.length;
  console.log(`Qualified (reviewCount ≥ ${MIN_REVIEWS}): ${qualified.length}  |  skipped (blank/low): ${skipped}`);
  console.log('─'.repeat(64) + '\n');

  const withEmail    = [];
  const withoutEmail = [];

  for (let i = 0; i < qualified.length; i++) {
    const r           = qualified[i];
    const rawReviewCount = isThunderbit ? (r['# of reviews'] || '') : (r.reviewcount || '');
    const reviewCount    = parseInt(rawReviewCount.replace(/,/g, ''), 10);
    const tier           = reviewCount >= 200 ? 'busy' : 'medium';
    const website     = cleanUrl(r.website || '');
    const label       = (r.name || r.title || r.company || '').slice(0, 38).padEnd(38);

    process.stdout.write(`[${String(i + 1).padStart(3)}/${qualified.length}] ${label}  `);

    let email = '', siteContext = '';

    if (website) {
      const result = await enrichSite(website);
      email       = result.email;
      siteContext = result.siteContext;
    } else {
      process.stdout.write('(no website)  ');
    }

    const out = isThunderbit ? {
      company:     r.title || '',
      email,
      contactName: '',
      city:        cityFromAddress(r.address),
      tradeType:   r.type || 'Med Spa',
      website:     website || r.website || '',
      reviewCount,
      rating:      r['review rating'] || '',
      tier,
      siteContext,
    } : isPhantomBuster ? {
      company:     r.title || '',
      email,
      contactName: '',
      city:        cityFromAddress(r.address),
      tradeType:   r.category || 'Med Spa',
      website:     website || r.website || '',
      reviewCount,
      rating:      r.rating || '',
      tier,
      siteContext,
    } : {
      company:     r.name || r.company || '',
      email,
      contactName: '',
      city:        r.city || '',
      // Raw Apify export: category lives in "categoryName", or "categories/0"
      // when the export flattens the categories array. Both come through
      // lowercased by normalizeHeader() like every other column here. Was
      // hardcoded to 'med spa' — silently mislabeled every non-med-spa import
      // (e.g. dental) and bypassed the agent's niche-aware personalization
      // entirely. Empty string (not a fake default) when neither is present —
      // nicheFor() in outreach-agent.js already falls back gracefully.
      tradeType:   r.categoryname || r['categories/0'] || '',
      website:     website || r.website || '',
      reviewCount,
      rating:      r.rating || '',
      tier,
      siteContext,
    };

    if (email) {
      withEmail.push(out);
      console.log(`✓  ${email}`);
    } else {
      withoutEmail.push(out);
      console.log(`—  no email`);
    }

    // Polite pause between sites; skip after last entry
    if (i < qualified.length - 1 && website) {
      await sleep(jitter());
    }
  }

  // ── Write output files ────────────────────────────────────────────────────

  const outDir       = process.cwd();
  const enrichedPath = path.join(outDir, 'leads-enriched.csv');
  const noEmailPath  = path.join(outDir, 'leads-noemail.csv');

  const writeCSV = (filePath, records) => {
    const lines = [CSV_HEADER.join(','), ...records.map(toRow)];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  };

  writeCSV(enrichedPath, withEmail);
  writeCSV(noEmailPath, withoutEmail);

  // ── Summary ───────────────────────────────────────────────────────────────

  const all         = [...withEmail, ...withoutEmail];
  const busyCount   = all.filter(r => r.tier === 'busy').length;
  const mediumCount = all.filter(r => r.tier === 'medium').length;
  const hitRate     = qualified.length
    ? ((withEmail.length / qualified.length) * 100).toFixed(1)
    : '0.0';

  console.log('\n' + '─'.repeat(64));
  console.log('Summary');
  console.log(`  Input rows total:    ${rows.length}`);
  console.log(`  Qualified (≥ 50):    ${qualified.length}`);
  console.log(`  Emails found:        ${withEmail.length}  →  ${enrichedPath}`);
  console.log(`  No email:            ${withoutEmail.length}  →  ${noEmailPath}`);
  console.log(`  Hit rate:            ${hitRate}%`);
  console.log(`  Tier — busy (200+):  ${busyCount}  ·  medium (50–199): ${mediumCount}`);
  console.log('─'.repeat(64));
}

main().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
