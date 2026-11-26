// Usage: node pw_fetch.js <run_dir> dom1 dom2 ...  (re-renders thin/blocked sites, merges into sitecache)
// Default headless Chromium, no evasion. Each site has a hard 90 s watchdog: a page that hangs
// (a dialog, a never-settling navigation) is abandoned, the browser context is replaced, and the
// worker moves on. Sites already in pwcache are skipped, so a rerun resumes where it stopped.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const run = process.argv[2]; const doms = process.argv.slice(3);
const KEY = /(employer|client|business|service|industr|staffing|solution|about|trade|skilled|manufactur|construction|workforce|labor|who-we|what-we|location)/i;
const SITE_MS = 90000;

async function fetchSite(ctx, d, rec) {
  const p = await ctx.newPage();
  try {
    const resp = await p.goto('https://' + d, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3500);
    const text = (await p.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 20000);
    rec.pages.push({ url: 'https://' + d, final_url: p.url(), status: resp ? resp.status() : null, title: await p.title(), text });
    const host = new URL(p.url()).hostname.replace(/^www\./, '');
    let links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => [a.href, a.innerText || '']));
    links = [...new Set(links.filter(([h, t]) => { try { const u = new URL(h); return u.hostname.replace(/^www\./, '') === host && KEY.test(u.pathname + ' ' + t) && !/\.(pdf|jpg|png)$/i.test(u.pathname); } catch { return false; } }).map(([h]) => h.split('#')[0]))].slice(0, 5);
    for (const l of links) {
      try { const r2 = await p.goto(l, { timeout: 25000, waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000);
        rec.pages.push({ url: l, final_url: p.url(), status: r2 ? r2.status() : null, title: await p.title(), text: (await p.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 12000) });
      } catch (e) { rec.pages.push({ url: l, status: null, error: e.name }); }
    }
  } finally {
    p.close().catch(() => {});
  }
}

(async () => {
  const b = await chromium.launch();
  let ctx = await b.newContext();
  fs.mkdirSync(path.join(run, 'pwcache'), { recursive: true });
  for (const d of doms) {
    const out = path.join(run, 'pwcache', d + '.json');
    if (fs.existsSync(out)) continue;
    const rec = { domain: d, pages: [], error: null, renderer: 'playwright' };
    let timer;
    const watchdog = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('site watchdog ' + SITE_MS / 1000 + 's')), SITE_MS); });
    try {
      await Promise.race([fetchSite(ctx, d, rec), watchdog]);
    } catch (e) {
      rec.error = e.name + ': ' + String(e.message).slice(0, 120);
      if (/watchdog/.test(e.message)) {  // the page may still be stuck: start a fresh context
        ctx.close().catch(() => {});
        ctx = await b.newContext();
      }
    } finally {
      clearTimeout(timer);
    }
    fs.writeFileSync(out, JSON.stringify(rec));
    console.log(d, '->', rec.error || rec.pages.length + ' pages', rec.pages[0] ? rec.pages[0].text.length : 0);
  }
  await b.close();
})();
