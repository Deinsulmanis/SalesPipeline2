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
  return {
    activeCount: active.length,
    activeIds: active.map(sender => sender.id),
    dailySum,
    perRunSum,
    dailyCeiling: dailyCap,
    perRunCeiling: perRunCap,
    globalDailyLimit: Math.min(dailyCap, dailySum),
    globalPerRunLimit: Math.min(perRunCap, perRunSum),
  };
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
