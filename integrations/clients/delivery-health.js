'use strict';

/**
 * Operator answer: how is this client's mail failing, by inbox and by domain?
 *
 * Built from the activity ledger only: no Gmail calls, no sends, no writes. The
 * denominator of every rate is first-touch recipients, because a bad address
 * can only be discovered once. A failed delivery counts against the Touch 1
 * cohort of its lead, whichever touch surfaced it.
 *
 * Rows recorded before notices kept their codes have no deliveryClass. They are
 * counted as `unclassified`, never guessed at.
 */

const { getClient } = require('./registry');
const { retractedBounceEventIds, DELIVERY_DEFERRED_EVENT, DELIVERY_FAILED_EVENT, DELIVERY_CLASS } = require('../delivery-status');

// The lines in the Jole rollout plan. A rate over a line is a flag for a person;
// nothing here changes a cap.
const FREEZE_RATE = 0.03;
const REDUCE_RATE = 0.05;
const MIN_ROLLING_FIRST_TOUCHES = 40;

const meta = row => {
  if (row?.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch (_) { return {}; }
};
const leadOf = row => String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
const percent = (part, whole) => (whole ? Number(((part / whole) * 100).toFixed(1)) : null);
const emptyCounts = () => ({ sends: 0, firstTouches: 0, bouncedRecipients: 0, bounceRatePct: null,
  hardBounces: 0, bouncesByClass: {}, unclassified: 0, policyRejections: 0, deliveryFailed: 0, deferred: 0, senderAuthFailures: 0 });

function rollingRate(cohort, days) {
  const windowDays = days.length;
  const lastDays = [...new Set(cohort.map(item => item.day))].sort().slice(-windowDays);
  const inWindow = cohort.filter(item => lastDays.includes(item.day));
  const bounced = inWindow.filter(item => item.bounced).length;
  const rate = inWindow.length ? bounced / inWindow.length : 0;
  const enough = inWindow.length >= MIN_ROLLING_FIRST_TOUCHES;
  return { sendDays: lastDays, firstTouches: inWindow.length, bouncedRecipients: bounced, bounceRatePct: percent(bounced, inWindow.length),
    flag: !enough ? 'too_few_first_touches' : rate > REDUCE_RATE ? 'over_reduce_line' : rate > FREEZE_RATE ? 'over_freeze_line' : 'clear' };
}

function clientDeliveryHealth({ clientId, senders = [], activities = [] } = {}) {
  const client = getClient(clientId);
  const mine = (senders || []).filter(sender => String(sender.clientId || '') === client.id);
  const ids = new Set(mine.map(sender => sender.id));
  const domainOf = id => String(mine.find(sender => sender.id === id)?.email || '').split('@')[1] || 'unknown';
  const dayOf = at => new Date(at).toLocaleDateString('en-CA', { timeZone: client.timezone || 'America/Vancouver' });
  const totals = emptyCounts();
  const inboxes = new Map(mine.map(sender => [sender.id, emptyCounts()]));
  const domains = new Map([...new Set(mine.map(sender => domainOf(sender.id)))].map(domain => [domain, emptyCounts()]));
  const retracted = retractedBounceEventIds(activities);
  const firstTouchOf = new Map();
  const failedLeads = new Set();
  const scopes = id => [totals, inboxes.get(id), domains.get(domainOf(id))];

  for (const row of activities || []) {
    const data = meta(row);
    const inbox = String(data.senderInboxId || '');
    if (!ids.has(inbox)) continue;
    const type = String(row.eventType || '');
    if (type === 'initial_email_sent' || type === 'follow_up_sent') {
      for (const scope of scopes(inbox)) { scope.sends += 1; if (type === 'initial_email_sent') scope.firstTouches += 1; }
      if (type === 'initial_email_sent') firstTouchOf.set(leadOf(row), { inbox, day: dayOf(row.occurredAt) });
    } else if (type === 'email_bounced' && !retracted.has(String(row.eventId))) {
      failedLeads.add(leadOf(row));
      const deliveryClass = data.deliveryClass || null;
      for (const scope of scopes(inbox)) {
        scope.hardBounces += 1;
        if (deliveryClass) scope.bouncesByClass[deliveryClass] = (scope.bouncesByClass[deliveryClass] || 0) + 1;
        else scope.unclassified += 1;
      }
    } else if (type === DELIVERY_FAILED_EVENT) {
      for (const scope of scopes(inbox)) {
        scope.deliveryFailed += 1;
        if (data.deliveryClass === DELIVERY_CLASS.POLICY_REJECTION) scope.policyRejections += 1;
      }
    } else if (type === DELIVERY_DEFERRED_EVENT) {
      for (const scope of scopes(inbox)) scope.deferred += 1;
    } else if (type === 'sender_auth_delivery_failure') {
      for (const scope of scopes(inbox)) scope.senderAuthFailures += 1;
    }
  }

  const cohort = [...firstTouchOf].map(([leadId, item]) => ({ ...item, bounced: failedLeads.has(leadId) }));
  const finish = (scope, items) => {
    scope.bouncedRecipients = items.filter(item => item.bounced).length;
    scope.bounceRatePct = percent(scope.bouncedRecipients, scope.firstTouches);
    return scope;
  };
  finish(totals, cohort);
  return {
    clientId: client.id, timezone: client.timezone || null, totals,
    inboxes: mine.map(sender => ({ senderInboxId: sender.id, email: sender.email, ...finish(inboxes.get(sender.id), cohort.filter(item => item.inbox === sender.id)) })),
    domains: [...domains].map(([domain, scope]) => {
      const items = cohort.filter(item => domainOf(item.inbox) === domain);
      return { domain, ...finish(scope, items), lastThreeSendDays: rollingRate(items, [1, 2, 3]), lastFiveSendDays: rollingRate(items, [1, 2, 3, 4, 5]) };
    }),
    lines: { freezePct: FREEZE_RATE * 100, reducePct: REDUCE_RATE * 100, minFirstTouches: MIN_ROLLING_FIRST_TOUCHES },
    note: 'unclassified rows predate stored status codes. A flag here is for a person; nothing here changes a cap.',
    sends: 0, writes: 0,
  };
}

module.exports = { clientDeliveryHealth, FREEZE_RATE, REDUCE_RATE, MIN_ROLLING_FIRST_TOUCHES };
