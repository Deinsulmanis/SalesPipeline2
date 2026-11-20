const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
for (const id of process.argv.slice(2)) { try { await p.goto('https://www.linkedin.com/ad-library/detail/' + id, { timeout: 30000 }); await p.waitForTimeout(3000);
 const t = await p.evaluate(() => document.body.innerText); console.log('=====', id, p.url()); console.log(t.slice(0, 1500)); } catch (e) { console.log(id, 'ERR', e.name); } }
await b.close(); })();
