'use strict';

const { queryAnthropicUsage } = require('./anthropic-usage');

function registerAnthropicUsageRoutes(app, requireAuth) {
  app.get('/api/ops/anthropic-usage', requireAuth, async (req, res) => {
    try {
      res.json(await queryAnthropicUsage(req.query || {}));
    } catch (error) {
      if (error.code === 'INVALID_DATE') return res.status(422).json({ error: error.message });
      console.warn(JSON.stringify({ event: 'anthropic_usage_query_failed', error: String(error.message || error).slice(0, 200) }));
      res.status(500).json({ error: 'usage query failed' });
    }
  });
}

module.exports = { registerAnthropicUsageRoutes };
