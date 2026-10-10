'use strict';

/**
 * DASHBOARD (authenticated)
 *   GET /api/landing/funnel   the Staffing Landing Funnel read model
 *
 * Query: range=7d|30d|90d|custom (from/to as YYYY-MM-DD, Vancouver days),
 * source, campaign, sender, template, includeTest=1, includeInternal=1.
 * Internal, debug and test traffic are excluded unless explicitly asked for.
 * The response carries no token, token hash, IP address or user agent (see
 * landing-dashboard.js). A Supabase failure returns 503 with a generic message.
 */

const { loadStaffingFunnel } = require('./landing-dashboard');

function registerLandingDashboardRoutes(app, requireAuth, { load = loadStaffingFunnel, env = process.env, now = () => new Date(), logger = console } = {}) {
  app.get('/api/landing/funnel', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let result;
    try {
      result = await load({ query: req.query || {}, env, now: now() });
    } catch (_) {
      result = { ok: false, error: 'unexpected error' };
    }
    if (!result?.ok) {
      logger.warn(`[landing-dashboard] funnel unavailable (${result?.error || 'unknown'})`);
      return res.status(503).json({ error: 'Staffing funnel data is unavailable right now.' });
    }
    return res.json(result.data);
  });
}

module.exports = { registerLandingDashboardRoutes };
