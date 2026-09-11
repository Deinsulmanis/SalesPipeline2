'use strict';

const { STAFFING_CAMPAIGN, isStaffingCampaign } = require('./staffing-campaign');
const { previewStaffingPersonalization } = require('./staffing-personalization');

function registerStaffingPreviewRoutes(app, requireAuth, preview = previewStaffingPersonalization) {
  app.get('/api/staffing/personalization/config', requireAuth, (_req,res) => res.json(STAFFING_CAMPAIGN));
  let running = false;
  app.post('/api/staffing/personalization/preview', requireAuth, async (req,res) => {
    const lead = req.body?.lead;
    if (!lead || !isStaffingCampaign(lead)) return res.status(422).json({ error: 'Exact staffing campaign assignment required' });
    if (running) return res.status(409).json({ error: 'A staffing preview is already running' });
    running = true;
    try { res.json(await preview(lead)); }
    catch (_) { res.status(422).json({ error: 'Staffing preview failed; no lead data was changed' }); }
    finally { running = false; }
  });
}
module.exports = { registerStaffingPreviewRoutes };
