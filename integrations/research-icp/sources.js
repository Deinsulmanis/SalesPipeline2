'use strict';
const { fetchPage, domain } = require('../staffing-research');

// Reuse the DNS/redirect-checked fetch transport. Link ranking here is neutral:
// the older staffing crawler retains its original ranking and behavior.
async function collectSources(company, { fetch = fetchPage } = {}) {
  const sources = [], warnings = [];
  const add = (id, sourceType, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text && text !== '{}') sources.push({ id, sourceType, text: text.slice(0, 30000) });
  };
  add('input:company', 'existing_data', { name: company.name, domain: company.domain });
  add('input:existingData', 'existing_data', company.existingData);
  let attempted = false, retrieved = false;
  if (company.domain) {
    attempted = true;
    try {
      const input = company.website || `https://${company.domain}`;
      const home = await fetch(/^https?:\/\//i.test(input) ? input : `https://${input}`, company.domain);
      retrieved = true;
      add(home.url, 'website', home.text);
      const seen = new Set([home.url]);
      const candidates = (home.links || []).filter(l => /services|industries|specialt|solutions|about|employers|markets/i.test(`${l.href} ${l.label}`));
      for (const link of candidates) {
        if (seen.size >= 4) break;
        let url;
        try { url = new URL(link.href, home.url); url.hash = ''; } catch { continue; }
        if (domain(url.href) !== company.domain || seen.has(url.href)) continue;
        seen.add(url.href);
        try { const page = await fetch(url.href, company.domain); add(page.url, 'website', page.text); }
        catch { warnings.push('SECONDARY_PAGE_UNAVAILABLE'); }
      }
    } catch { warnings.push('WEBSITE_RETRIEVAL_FAILED'); }
  }
  const hasExistingFacts = Object.values(company.existingData || {}).some(v => v !== null && v !== '' && JSON.stringify(v) !== '[]' && JSON.stringify(v) !== '{}');
  return { sources, warnings: [...new Set(warnings)], retrievalFailed: attempted && !retrieved && !hasExistingFacts,
    insufficient: !retrieved && !hasExistingFacts };
}
module.exports = { collectSources };
