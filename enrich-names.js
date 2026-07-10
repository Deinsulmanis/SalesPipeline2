#!/usr/bin/env node
/**
 * enrich-names.js
 * ─────────────────────────────────────────────────────────────────────────────
 * For every ColdEmail lead where contactName is blank, scrapes the business's
 * About/Team page and uses Haiku to extract the owner/founder first name, then
 * writes it back to column C of the ColdEmail sheet.
 *
 * Usage (local):
 *   DRY_RUN=true  node -r dotenv/config enrich-names.js   (preview — no writes)
 *   DRY_RUN=false node -r dotenv/config enrich-names.js   (live — writes names)
 *
 * Or via the dashboard: POST /api/enrich/names (always runs live).
 *
 * Does NOT send any email. Does NOT modify outreach state.
 */

'use strict';

require('dotenv').config();

const { google }  = require('googleapis');
const Anthropic   = require('@anthropic-ai/sdk');
const axios       = require('axios');
const cheerio     = require('cheerio');
// puppeteer is required lazily inside run() — it is optional at runtime. Railway
// installs it without a Chromium binary (PUPPETEER_SKIP_DOWNLOAD), and may omit
// the package entirely; neither must break this script at file load.

// ── CONFIG ────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DRY_RUN        = process.env.DRY_RUN !== 'false'; // default TRUE

const ABOUT_PATHS = [
  '/about', '/about-us', '/our-team', '/team',
  '/meet-the-team', '/meet-us', '/who-we-are',
];

const REQUEST_TIMEOUT     = 8_000;
const HEADLESS_TIMEOUT    = 10_000;
const DELAY_BETWEEN_LEADS = 3_000;
const MAX_CONTENT_LENGTH  = 3_000;
const WRITE_DELAY         = 500;

// A JS-rendered page answers 200 with an empty shell, so cheerio extracts almost
// nothing. Anything under this is treated as a miss and handed to the headless
// fallback rather than fed to Haiku as an empty prompt.
const MIN_CONTENT_LENGTH  = 100;

const SHEET_NAME = 'ColdEmail';
const CE_RANGE   = `${SHEET_NAME}!A:P`;

// Must stay in sync with CE_COLUMNS in server.js and COLUMNS in outreach-agent.js
const COLUMNS = [
  'id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website',
  'stage', 'emailStatus', 'lastEmailedAt', 'emailStep', 'notes',
  'reviewCount', 'rating', 'tier', 'siteContext',
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── AUTH (service account — same pattern as server.js) ────────────────────────

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

function sheets() {
  return google.sheets({ version: 'v4', auth });
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeUrl(raw) {
  if (!raw) return '';
  const u = raw.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function siteOrigin(url) {
  try {
    const p = new URL(url);
    return `${p.protocol}//${p.host}`;
  } catch {
    return '';
  }
}

// ── SHEET READ ────────────────────────────────────────────────────────────────

async function readLeads() {
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: CE_RANGE,
  });
  const rows = resp.data.values || [];
  return rows.slice(1).map((row, idx) => {
    const lead = { _row: idx + 2 };
    COLUMNS.forEach((c, i) => { lead[c] = row[i] || ''; });
    return lead;
  }).filter(l => l.id);
}

// ── SCRAPING ──────────────────────────────────────────────────────────────────

// Single source of truth for turning page HTML into candidate text. Both the
// axios path and the headless path parse identically — only the fetch differs.
function extractText(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header').remove();

  const parts = [];
  $('h1, h2, h3').each((_, el) => parts.push($(el).text()));
  $('p').each((_, el) => parts.push($(el).text()));
  $([
    '[class*="about"]', '[class*="team"]', '[class*="founder"]',
    '[class*="owner"]', '[class*="bio"]',  '[class*="doctor"]',
    '[class*="dr"]',    '[class*="meet"]',
  ].join(',')).each((_, el) => parts.push($(el).text()));

  return parts
    .map(t => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_CONTENT_LENGTH);
}

async function fetchAboutContent(websiteUrl, company) {
  const base = siteOrigin(normalizeUrl(websiteUrl));
  if (!base) return null;

  for (const path of ABOUT_PATHS) {
    const url = base + path;
    console.log(`[scrape] ${company} → trying ${url}`);
    try {
      const resp = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        headers: { 'User-Agent': BROWSER_UA },
        validateStatus: s => s >= 200 && s < 300,
      });
      if (!resp.data || typeof resp.data !== 'string') continue;

      const content = extractText(resp.data);
      // A 200 carrying an empty SPA shell is not a hit — keep looking, then let
      // the caller fall back to the headless browser.
      if (content.length < MIN_CONTENT_LENGTH) continue;

      return { url, content };
    } catch {
      // 4xx, 5xx, timeout — try next path
    }
  }
  return null;
}

// Fallback for JavaScript-rendered sites. Reuses one browser for the whole run;
// only the page is per-attempt. Returns null on any failure — a crashed page or
// a browser-level fault must never take down the run.
async function fetchAboutContentHeadless(browser, websiteUrl, company) {
  const base = siteOrigin(normalizeUrl(websiteUrl));
  if (!base || !browser) return null;

  for (const path of ABOUT_PATHS) {
    const url = base + path;
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent(BROWSER_UA);
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: HEADLESS_TIMEOUT });
      if (!resp || !resp.ok()) continue;

      const content = extractText(await page.content());
      if (content.length < MIN_CONTENT_LENGTH) continue;

      console.log(`[headless] ${company} → rendered ${url}`);
      return { url, content };
    } catch (e) {
      console.warn(`[headless] ${company} → ${url} failed: ${e.message}`);
    } finally {
      // Close in finally so a mid-navigation throw cannot leak the page.
      if (page) await page.close().catch(() => {});
    }
  }
  return null;
}

// ── EXTRACTION ────────────────────────────────────────────────────────────────

async function extractOwnerName(company, content, websiteUrl) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      system: [
        'You are an expert at identifying the owner, founder, or lead practitioner of a small medical spa or aesthetic clinic from website text.',
        'Extract ONLY the first name of the primary owner, founder, or head practitioner.',
        '',
        'Rules:',
        '- Return ONLY the first name, nothing else (no last name, no title, no punctuation, no explanation)',
        '- If you find a name like "Dr. Sarah Chen", return "Sarah"',
        '- If you find "Founded by Michelle", return "Michelle"',
        '- If multiple names appear, pick the owner/founder, not staff',
        '- If you cannot confidently identify an owner/founder name, return exactly: UNKNOWN',
        '- Never guess or hallucinate a name',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: `Company: ${company}\nWebsite: ${websiteUrl}\n\nPage content:\n${content}\n\nWhat is the owner or founder's first name?`,
      }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    if (!raw || raw === 'UNKNOWN') return null;
    if (raw.includes(' ') || raw.length > 20) return null;
    return raw;
  } catch (e) {
    console.warn(`[extract] API error for ${company}: ${e.message}`);
    return null;
  }
}

// ── SHEET WRITE ───────────────────────────────────────────────────────────────

async function writeName(rowIndex, name, company) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[name]] },
  });
  console.log(`[write] "${name}" → ${company} (row ${rowIndex})`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!SPREADSHEET_ID)                       throw new Error('SPREADSHEET_ID missing from .env');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing from .env');
  if (!process.env.ANTHROPIC_API_KEY)        throw new Error('ANTHROPIC_API_KEY missing from .env');

  console.log('────────────────────────────────────────');
  console.log('enrich-names.js — About/Team page owner name extraction');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (nothing written)' : '🔴 LIVE — writing to sheet'}`);
  console.log('────────────────────────────────────────\n');

  const allLeads = await readLeads();

  const filtered = allLeads.filter(l =>
    (!l.contactName || !l.contactName.trim()) &&
    l.website && l.website.trim() &&
    l.emailStatus !== 'replied' &&
    l.stage !== 'Replied'
  );

  console.log(`[enrich] ${filtered.length} leads need name enrichment\n`);

  let attempted    = 0;
  let viaFast      = 0;
  let viaHeadless  = 0;
  let namesFound   = 0;
  let written      = 0;
  let noPage       = 0;
  let noName       = 0;

  // Launched lazily — no leads means no Chromium.
  let browser = null;

  try {
    if (filtered.length > 0) {
      // Both the require and the launch are optional. A missing package
      // (MODULE_NOT_FOUND) or a missing Chromium binary must degrade this run to
      // the fast path, never abort it — Railway has neither.
      try {
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        console.log('[headless] browser launched\n');
      } catch (e) {
        console.warn('[headless] Puppeteer launch failed — falling back to fast-path only for this run');
        console.warn(`[headless] reason: ${(e.message || String(e)).split('\n')[0]}\n`);
        browser = null;
      }
    }

    for (const lead of filtered) {
      const company = lead.company || lead.id;
      attempted++;

      let result = await fetchAboutContent(lead.website, company);
      if (result) {
        viaFast++;
      } else if (browser) {
        console.log(`[fallback] ${company} — trying headless browser`);
        result = await fetchAboutContentHeadless(browser, lead.website, company);
        if (result) viaHeadless++;
      }

      if (!result) {
        console.log(`[skip] ${company} — no about page found`);
        noPage++;
        await sleep(DELAY_BETWEEN_LEADS);
        continue;
      }

      const name = await extractOwnerName(company, result.content, result.url);
      if (!name) {
        console.log(`[skip] ${company} — name not found in content`);
        noName++;
        await sleep(DELAY_BETWEEN_LEADS);
        continue;
      }

      namesFound++;
      if (DRY_RUN) {
        console.log(`[dry-run] Would write "${name}" → ${company} (row ${lead._row})`);
      } else {
        await writeName(lead._row, name, company);
        written++;
        await sleep(WRITE_DELAY);
      }

      await sleep(DELAY_BETWEEN_LEADS);
    }
  } finally {
    if (browser) {
      await browser.close().catch(e => console.warn(`[headless] close failed: ${e.message}`));
      console.log('\n[headless] browser closed');
    }
  }

  const writtenLine = DRY_RUN ? 'dry run — nothing written' : String(written);

  console.log('\n' + '─'.repeat(36));
  console.log('Enrichment complete');
  console.log(`  Leads attempted:     ${attempted}`);
  console.log(`  Found via fast path: ${viaFast}`);
  console.log(`  Found via headless:  ${viaHeadless}`);
  console.log(`  Names found:         ${namesFound}`);
  console.log(`  Names written:       ${writtenLine}`);
  console.log(`  Skipped (no page):   ${noPage}`);
  console.log(`  Skipped (no name):   ${noName}`);
  console.log('─'.repeat(36));
}

run().catch(console.error);
