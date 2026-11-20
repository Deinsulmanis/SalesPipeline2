// Deeper re-crawl (pass 2). Plain headless Chromium with default settings; no bot-check evasion.
// Sites that show a bot check or nothing stay HOLD.
// Usage: node pw_deep.js <run_dir> dom1 dom2 ...   -> <run_dir>/sitecache2/<domain>.json
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const run = process.argv[2]; const doms = process.argv.slice(3);
const out = path.join(run, 'sitecache2'); fs.mkdirSync(out, { recursive: true });
const KEY = /(employer|client|business|service|industr|staffing|solution|about|trade|skilled|manufactur|construction|workforce|labor|light|warehouse|who-we|what-we|location|branch|office|contact|team|leadership)/i;
const PRI = u => /employer|client|business|service|industr|solution|trade|skilled|manufactur|construction|light|warehouse/i.test(u) ? 0 : /location|branch|office|contact/i.test(u) ? 1 : /about|team|leadership|who-we/i.test(u) ? 2 : 3;
async function grab(p, url) {
  const r = await p.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
  try { await p.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await p.waitForTimeout(5000);
  const text = await p.evaluate(() => document.body ? document.body.innerText : '');
  return { url, final_url: p.url(), status: r ? r.status() : null, title: await p.title(), text: text.slice(0, 20000) };
}
(async () => {
  const b = await chromium.launch();
  for (const d of doms) {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    const rec = { domain: d, pages: [], error: null, renderer: 'playwright-deep' };
    let home = null;
    for (const start of ['https://' + d, 'https://www.' + d]) {
      try { home = await grab(p, start); if (home.text.length > 300) break; } catch (e) { rec.error = e.name + ': ' + String(e.message).slice(0, 100); }
    }
    if (home) {
      rec.pages.push(home); rec.error = null;
      const host = new URL(home.final_url).hostname.replace(/^www\./, '');
      let links = [];
      for (let i = 0; i < 3; i++) {
        try { links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => [a.href, (a.innerText || '').trim()])); break; }
        catch (e) { await p.waitForTimeout(4000); }
      }
      links = [...new Set(links.filter(([h, t]) => { try { const u = new URL(h); return u.hostname.replace(/^www\./, '') === host && KEY.test(u.pathname + ' ' + t) && !/\.(pdf|jpg|png)$/i.test(u.pathname); } catch { return false; } }).map(([h]) => h.split('#')[0].replace(/\/$/, '')))];
      links = links.filter(l => l !== home.final_url.replace(/\/$/, '')).sort((a, b) => PRI(a) - PRI(b)).slice(0, 10);
      for (const l of links) { try { rec.pages.push(await grab(p, l)); } catch (e) { rec.pages.push({ url: l, status: null, error: e.name }); } }
    }
    await ctx.close();
    fs.writeFileSync(path.join(out, d + '.json'), JSON.stringify(rec));
    const tot = rec.pages.reduce((n, x) => n + (x.text ? x.text.length : 0), 0);
    console.log(d, '->', rec.error || (rec.pages.length + ' pages'), 'chars', tot, '|', home ? home.final_url + ' | ' + home.title.slice(0, 60) : '');
  }
  await b.close();
})();
