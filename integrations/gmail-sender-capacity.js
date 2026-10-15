'use strict';

const DEFAULT_INBOX_DAILY_LIMIT = 40;
const DEFAULT_INBOX_PER_RUN_LIMIT = 5;
// Highest supported per-window cap for one inbox. The scheduler's per-inbox
// bucket ceiling and the Activate Sender gate both read this, so the largest
// value an inbox may be activated with is exactly what a window can deliver.
const MAX_INBOX_PER_RUN_LIMIT = 6;
const DEFAULT_DAILY_CEILING = 120;
const DEFAULT_PER_RUN_CEILING = 15;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function activeColdSenders(senders = []) {
  return (senders || []).filter(sender => sender && sender.sendEligible);
}

/**
 * Client-aware capacity. Each client gets its own allocation from its own
 * send-eligible inboxes, and the physical scheduler ceiling is their sum:
 *
 *   default client (ScaleLab): min(env ceiling, its eligible inboxes' sum)
 *   managed client C:          min(C's configured client cap, C's eligible sum)
 *
 * GMAIL_GLOBAL_*_CEILING keeps meaning exactly what it meant before managed
 * clients existed: ScaleLab's ceiling. A managed client adds its own capped
 * allocation only while its inboxes are send eligible, so a client whose final
 * send authorization is off contributes 0. With ScaleLab inboxes only, every
 * number below is identical to the single-tenant formula.
 */
function senderCapacity(senders = [], {
  dailyCeiling = DEFAULT_DAILY_CEILING,
  perRunCeiling = DEFAULT_PER_RUN_CEILING,
} = {}) {
  const active = activeColdSenders(senders);
  const dailySum = active.reduce((sum, sender) => sum + positiveInt(sender.dailyLimit, 0), 0);
  const perRunSum = active.reduce((sum, sender) => (
    sum + positiveInt(sender.perRunLimit, DEFAULT_INBOX_PER_RUN_LIMIT)
  ), 0);
  const dailyCap = positiveInt(dailyCeiling, DEFAULT_DAILY_CEILING);
  const perRunCap = positiveInt(perRunCeiling, DEFAULT_PER_RUN_CEILING);
  const clientLimits = clientAllocations(active, { dailyCap, perRunCap });
  const allocations = Object.values(clientLimits);
  return {
    activeCount: active.length,
    activeIds: active.map(sender => sender.id),
    dailySum,
    perRunSum,
    dailyCeiling: dailyCap,
    perRunCeiling: perRunCap,
    globalDailyLimit: allocations.reduce((sum, item) => sum + item.daily, 0),
    globalPerRunLimit: allocations.reduce((sum, item) => sum + item.perRun, 0),
    clientLimits,
  };
}

function clientAllocations(active, { dailyCap, perRunCap }) {
  const { DEFAULT_CLIENT_ID, getClient, listClients } = require('./clients/registry');
  const limits = {};
  for (const client of listClients()) {
    const mine = active.filter(sender => (String(sender.clientId || '').trim() || DEFAULT_CLIENT_ID) === client.id);
    const daily = mine.reduce((sum, sender) => sum + positiveInt(sender.dailyLimit, 0), 0);
    const perRun = mine.reduce((sum, sender) => sum + positiveInt(sender.perRunLimit, DEFAULT_INBOX_PER_RUN_LIMIT), 0);
    if (client.isDefault) {
      limits[client.id] = { daily: Math.min(dailyCap, daily), perRun: Math.min(perRunCap, perRun) };
    } else {
      const cfg = getClient(client.id).capacity || {};
      const capDaily = cfg.dailyCap === null || cfg.dailyCap === undefined ? daily : positiveInt(cfg.dailyCap, 0);
      const capWindow = cfg.windowCap === null || cfg.windowCap === undefined ? perRun : positiveInt(cfg.windowCap, 0);
      limits[client.id] = { daily: Math.min(capDaily, daily), perRun: Math.min(capWindow, perRun) };
    }
  }
  return limits;
}

function capacityFromEnv(senders = [], env = process.env) {
  return senderCapacity(senders, {
    dailyCeiling: env.GMAIL_GLOBAL_DAILY_CEILING || DEFAULT_DAILY_CEILING,
    perRunCeiling: env.GMAIL_GLOBAL_PER_RUN_CEILING || DEFAULT_PER_RUN_CEILING,
  });
}

module.exports = {
  DEFAULT_INBOX_DAILY_LIMIT, DEFAULT_INBOX_PER_RUN_LIMIT, MAX_INBOX_PER_RUN_LIMIT,
  DEFAULT_DAILY_CEILING, DEFAULT_PER_RUN_CEILING,
  activeColdSenders, senderCapacity, capacityFromEnv,
};
