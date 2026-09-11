'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
function domain(value) {
  try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}
function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
  }
  // Only globally routed unicast IPv6; excludes loopback, mapped IPv4, ULA and link-local.
  return net.isIPv6(ip) && /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:db8:/i.test(ip);
}
async function checkedLookup(host, options, callback) {
  try {
    const addresses = await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(x => !publicIp(x.address))) throw new Error('non_public_address');
    const selected = options?.family ? addresses.filter(x => x.family === options.family) : addresses;
    if (!selected.length) throw new Error('address_family_unavailable');
    if (options?.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  } catch (error) { callback(error); }
}
const httpAgent = new http.Agent({ lookup: checkedLookup });
const httpsAgent = new https.Agent({ lookup: checkedLookup });
function safeUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80','443'].includes(url.port))) throw new Error('unsafe_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !net.isIP(host)) throw new Error('unsafe_host');
  if (net.isIP(host) && !publicIp(host)) throw new Error('non_public_address');
  url.hash = '';
  return url.href;
}
async function fetchPage(input, expectedDomain) {
  let url = safeUrl(input);
  for (let redirect = 0; redirect < 5; redirect++) {
    if (domain(url) !== expectedDomain && !domain(url).endsWith(`.${expectedDomain}`)) throw new Error('cross_domain_redirect');
    const response = await axios.get(url, {
      timeout: 12000, maxRedirects: 0, maxContentLength: 1500000, responseType: 'text',
      httpAgent, httpsAgent, proxy: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScaleLabWebsiteResearch/1.0)', Accept: 'text/html' },
      validateStatus: status => status >= 200 && status < 400,
    });
    if (response.status >= 300) {
      if (!response.headers.location) throw new Error('redirect_without_location');
      url = safeUrl(new URL(response.headers.location, url).href); continue;
    }
    if (!/html/i.test(response.headers['content-type'] || '')) throw new Error('not_html');
    const $ = cheerio.load(response.data);
    const title = clean($('title').text());
    const links = $('a[href]').map((_, el) => ({ href: $(el).attr('href'), label: clean($(el).text()) })).get();
    $('script,style,noscript,svg,iframe,nav,footer,form,header').remove();
    const blocks = [];
    $('h1,h2,h3,h4,p,li,td').each((_, el) => { const text = clean($(el).text()); if (text) blocks.push(text); });
    const text = [...new Set(blocks)].join('\n').slice(0,16000) || clean($('body').text()).slice(0,16000);
    if (text.length < 120 || /just a moment|checking your browser|verify you are human|enable javascript and cookies/i.test(title + ' ' + text.slice(0,400))) throw new Error('unusable_or_blocked_page');
    return { url, title, text, links, fetchedAt: new Date().toISOString() };
  }
  throw new Error('too_many_redirects');
}
function rankLink(link) {
  const text = `${link.href} ${link.label}`.toLowerCase();
  if (/privacy|terms|login|sign.?in|facebook|linkedin|instagram|blog|news|contact|\.pdf/.test(text)) return 0;
  if (/industrial|manufactur|warehouse|skilled.trade|construction|logistic|industries|specialt/.test(text)) return 5;
  if (/employer|hire.staff|find.talent|staffing.solution|our.service|\/services/.test(text)) return 4;
  if (/jobs|positions|opportunit/.test(text)) return 3;
  if (/about|who.we.are|faq/.test(text)) return 2;
  return 0;
}
async function researchStaffingCompany(lead, { fetch = fetchPage, maxPages = 6 } = {}) {
  const input = clean(lead.companyWebsite || lead.website || lead.companyDomain);
  const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const expected = domain(input), declared = domain(lead.companyDomain || input);
  const pages = [], failures = [];
  const retrieval = {homepageFailed:false,alternateCompanyPageAttempted:false,domainIdentityVerified:false,
    usableAlternateEvidence:false,attempts:[]};
  const failed = (failedUrl,error,homepage) => {
    const reason=String(error.message).slice(0,160);
    retrieval.attempts.push({url:failedUrl,homepage,ok:false,status:error.response?.status||Number(/\b(403|404)\b/.exec(reason)?.[1])||null,reason});
    failures.push(homepage?reason:`${failedUrl}: ${reason}`);
  };
  if (!expected || expected !== declared) return { pages, failures: ['company_domain_mismatch'], reviewRequired: true, retrieval };
  let home;
  try { home = await fetch(url, expected); pages.push(home); retrieval.attempts.push({url:home.url,homepage:true,ok:true,status:200}); }
  catch (error) { retrieval.homepageFailed=true; failed(url,error,true); return { pages, failures, reviewRequired: true, retrieval }; }
  const seen = new Set([home.url]);
  const candidates = (home.links || []).map(link => {
    try { const target = new URL(link.href, home.url); target.hash = ''; return { url: target.href, rank: rankLink(link) }; } catch { return null; }
  }).filter(x => x && x.rank && (domain(x.url) === expected || domain(x.url).endsWith(`.${expected}`)))
    .sort((a,b) => b.rank - a.rank || a.url.localeCompare(b.url));
  for (const item of candidates) {
    if (seen.size >= maxPages) break;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    retrieval.alternateCompanyPageAttempted=true;
    try { const page=await fetch(item.url, expected); pages.push(page); retrieval.usableAlternateEvidence=true;
      retrieval.attempts.push({url:page.url,homepage:false,ok:true,status:200}); }
    catch (error) { failed(item.url,error,false); }
  }
  return { pages: pages.map(({ links, ...page }) => page), failures, reviewRequired: false, retrieval };
}
module.exports = { clean, domain, safeUrl, publicIp, rankLink, researchStaffingCompany };
