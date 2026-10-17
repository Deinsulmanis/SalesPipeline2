'use strict';
const { createAgent } = require('./agent');
const { createStore } = require('./store');
const { config } = require('./config');

function registerResearchRoutes(app, requireAuth, { env = process.env, store = createStore({ env }), agent = createAgent({ env, store }) } = {}) {
  let running = false;
  app.post('/api/agents/research/test', requireAuth, async (req, res) => {
    const cfg = config(env);
    if (!cfg.enabled) return res.status(503).json({ error: 'RESEARCH_DISABLED' });
    if (cfg.invalidMode) return res.status(503).json({ error: 'SHADOW_MODE_REQUIRED' });
    if (running) return res.status(409).json({ error: 'RESEARCH_ALREADY_RUNNING' });
    const items = req.body?.items === undefined ? [req.body] : req.body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 5 || items.some(i => !i || typeof i !== 'object' || Array.isArray(i))) {
      return res.status(422).json({ error: 'Provide one input or items containing 1–5 inputs.' });
    }
    running = true;
    try {
      const runs = [];
      for (const item of items) {
        try { runs.push(await agent.run(item)); }
        catch (error) {
          const known = ['RESEARCH_STORAGE_UNAVAILABLE', 'RESEARCH_DISABLED', 'SHADOW_MODE_REQUIRED'];
          const code = known.includes(error.message) ? error.message : 'INVALID_INPUT';
          // Stop the batch on infrastructure failure; retain completed results.
          if (known.includes(code)) return res.status(503).json({ error: code, runs });
          runs.push({ status: 'rejected', errorCode: code });
        }
      }
      if (req.body?.items !== undefined) return res.json({ mode: 'shadow', runs });
      return res.status(runs[0].status === 'rejected' ? 422 : 200).json(runs[0]);
    } finally { running = false; }
  });
  app.get('/api/agents/research/runs', requireAuth, async (req, res) => {
    try {
      const { leadId, campaignId } = req.query;
      if ([leadId, campaignId].some(v => v !== undefined && (typeof v !== 'string' || v.length > 250))) return res.status(422).json({ error: 'INVALID_FILTER' });
      res.json({ runs: await store.list({ leadId, campaignId }) });
    } catch { res.status(503).json({ error: 'RESEARCH_STORAGE_UNAVAILABLE' }); }
  });
  app.get('/api/agents/research/runs/:id', requireAuth, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(422).json({ error: 'INVALID_RUN_ID' });
    try {
      const run = await store.get(req.params.id);
      return run ? res.json(run) : res.status(404).json({ error: 'RUN_NOT_FOUND' });
    } catch { res.status(503).json({ error: 'RESEARCH_STORAGE_UNAVAILABLE' }); }
  });
}
module.exports = { registerResearchRoutes };
