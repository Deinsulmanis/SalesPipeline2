'use strict';

/**
 * Franchise locations in the ScaleLab ICP (owner decision 2026-11-25).
 *
 * Independently owned franchise offices (Express Employment Professionals,
 * PrideStaff, Spherion, ...) share one mail domain per brand. Three things
 * follow, and this module is their one source of truth:
 *
 *   1. Identity. A franchise lead is keyed by brand + owner (one contact per
 *      owner) and brand + territory (one owner per office), never by its email
 *      domain. The import uses these keys instead of the domain.
 *   2. Send safety. At most FRANCHISE_DOMAIN_DAILY_CAP successful sends per
 *      shared franchise domain per Vancouver day, across every inbox and step.
 *      The cap is reserved before the provider attempt and released only when
 *      the attempt ends without delivery, so parallel sender lanes cannot
 *      overshoot it. A send whose outcome is uncertain keeps its slot.
 *   3. Ordering. Franchise leads are spread through the step-1 batch instead of
 *      sitting in one block (selection order only; every guard still runs).
 */

const FRANCHISE_SHARED_DOMAINS = Object.freeze({
  'expresspros.com': 'express',
  'pridestaff.com': 'pridestaff',
  'spherion.com': 'spherion',
  'snelling.com': 'snelling',
  'laborfinders.com': 'labor_finders',
  'hirequestdirect.com': 'hirequest',
  'hirequestllc.com': 'hirequest',
  'hirequest.com': 'hirequest',
  'trojanlabor.com': 'trojan',
  'linkstaffing.com': 'link',
  'remedystaff.com': 'remedy',
});
const FRANCHISE_DOMAIN_DAILY_CAP = 10;
const SUCCESSFUL_SEND_EVENTS = Object.freeze([
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent', 'placement_test_sent',
]);

const text = value => String(value ?? '').trim();
const domainOf = email => text(email).toLowerCase().split('@').pop() || '';
const bare = domain => text(domain).toLowerCase().replace(/^www\./, '');

/** The franchise brand of a shared mail/web domain, or ''. */
function franchiseBrandOfDomain(domain) {
  return FRANCHISE_SHARED_DOMAINS[bare(domain)] || '';
}

/** The shared franchise domain an address belongs to, or ''. */
function franchiseDomainOfEmail(email) {
  const domain = domainOf(email);
  return FRANCHISE_SHARED_DOMAINS[domain] ? domain : '';
}

const keyPart = value => text(value).toLowerCase().replace(/[^a-z0-9|]+/g, '');

/** Why a record's franchise identity is unusable for this domain, or null. */
function franchiseIdentityProblem(franchise, domains = []) {
  const brands = [...new Set(domains.map(franchiseBrandOfDomain).filter(Boolean))];
  if (!franchise || typeof franchise !== 'object') return 'a shared franchise domain needs row.franchise {brand, owner_key, territory, city}';
  if (brands.length !== 1 || text(franchise.brand) !== brands[0]) return `franchise brand must be ${brands.join(' or ') || '(none)'}`;
  const owner = text(franchise.owner_key).split('|');
  if (owner.length !== 3 || owner[0] !== brands[0] || !owner[1] || !owner[2]) return 'franchise owner_key must be brand|first|last';
  const territory = text(franchise.territory).split('|');
  if (territory.length !== 3 || territory[0] !== brands[0] || !territory[1] || !territory[2]) return 'franchise territory must be brand|city|state';
  if (!text(franchise.city)) return 'franchise city is required';
  return null;
}

/** The dedupe keys of a franchise identity. */
function franchiseKeys(franchise = {}) {
  return [`franchise-owner:${keyPart(franchise.owner_key)}`, `franchise-territory:${keyPart(franchise.territory)}`];
}

/**
 * Successful sends today per shared franchise domain. `emailForLead(leadId)`
 * resolves a ledger row to its recipient.
 */
function franchiseDomainSendsToday(activities = [], dayKey, emailForLead = () => '') {
  const counts = new Map();
  const seen = new Set();
  for (const row of activities) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const day = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && day !== dayKey) continue;
    const eventKey = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}:${row.metadata || ''}`);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const domain = franchiseDomainOfEmail(emailForLead(row.leadId));
    if (domain) counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return counts;
}

/**
 * The per-run throttle. reserve(email) is synchronous, so lanes that run in
 * parallel cannot both take the last slot. Non-franchise addresses always pass.
 */
function createFranchiseDomainThrottle({ sendsToday = new Map(), cap = FRANCHISE_DOMAIN_DAILY_CAP } = {}) {
  const used = new Map(sendsToday);
  return Object.freeze({
    cap,
    used: domain => used.get(domain) || 0,
    reserve(email) {
      const domain = franchiseDomainOfEmail(email);
      if (!domain) return { ok: true, domain: '', release() {} };
      const count = used.get(domain) || 0;
      if (count >= cap) return { ok: false, domain, reason: `franchise domain ${domain} reached ${cap} sends today` };
      used.set(domain, count + 1);
      let released = false;
      return { ok: true, domain, release() { if (!released) { released = true; used.set(domain, Math.max(0, (used.get(domain) || 1) - 1)); } } };
    },
  });
}

/**
 * Spreads franchise-domain leads through a batch: the others keep their order,
 * and franchise leads are placed at even intervals instead of in one block.
 */
function interleaveFranchiseLeads(leads = [], emailOf = lead => lead?.email) {
  const franchise = leads.filter(lead => franchiseDomainOfEmail(emailOf(lead)));
  if (!franchise.length || franchise.length === leads.length) return [...leads];
  const others = leads.filter(lead => !franchiseDomainOfEmail(emailOf(lead)));
  const out = [];
  const gap = (others.length + 1) / franchise.length;
  let next = 0;
  let placed = 0;
  others.forEach((lead, index) => {
    while (placed < franchise.length && index >= Math.floor(next)) { out.push(franchise[placed++]); next += gap; }
    out.push(lead);
  });
  while (placed < franchise.length) out.push(franchise[placed++]);
  return out;
}

module.exports = {
  FRANCHISE_SHARED_DOMAINS, FRANCHISE_DOMAIN_DAILY_CAP,
  franchiseBrandOfDomain, franchiseDomainOfEmail, franchiseIdentityProblem, franchiseKeys,
  franchiseDomainSendsToday, createFranchiseDomainThrottle, interleaveFranchiseLeads,
};
