'use strict';

const { STAFFING_CAMPAIGN, isStaffingCampaign, staffingReviewStatus, replaceStaffingReviewTag,
  renderStaffingEmail, validateStaffingEmail } = require('./staffing-campaign');
const { previewStaffingPersonalization, personalizeStaffingLead, buildStaffingPersonalizationLead,
  emailAdmission } = require('./staffing-personalization');
const { createProviderClassifier, providerVerdict } = require('./cold-delivery-policy');

const CONFIDENCE_TO_REVIEW = Object.freeze({
  HIGH: 'SPECIFIC_HIGH', MEDIUM: 'BROAD_MEDIUM', SAFE_FALLBACK: 'SAFE_FALLBACK',
});

function unsentImportEligible(lead) {
  if (!lead || !lead.id) return { ok: false, reason: 'lead not found' };
  if (!isStaffingCampaign(lead)) return { ok: false, reason: 'Exact staffing campaign assignment required' };
  if (String(lead.stage || '') !== 'Import') return { ok: false, reason: `stage ${lead.stage || '(blank)'} is not Import` };
  if (String(lead.emailStatus || '').trim() || Number(lead.emailStep) > 0 || String(lead.lastEmailedAt || '').trim()) {
    return { ok: false, reason: 'prior send or sequence status exists' };
  }
  if (/\[MANUAL HOLD\]/i.test(String(lead.notes || ''))) return { ok: false, reason: 'manual hold' };
  if (/\[(?:UNSUBSCRIBED|SUPPRESSED|BOUNCED)/i.test(String(lead.notes || ''))) return { ok: false, reason: 'suppressed' };
  if (!String(lead.email || '').trim() || !String(lead.company || '').trim()) return { ok: false, reason: 'missing identity' };
  const input = buildStaffingPersonalizationLead(lead);
  if (!input.firstName) return { ok: false, reason: 'missing first name' };
  if (!emailAdmission(input.emailStatus)) return { ok: false, reason: 'verified email with stated catch-all required' };
  return { ok: true, input };
}

function holdReviewTag(lead) {
  const current = staffingReviewStatus(lead) || { fit: 'ICP_CONFIRMED' };
  const fit = current.fit === 'ICP_REJECT' ? 'ICP_REJECT' : 'ICP_CONFIRMED';
  return replaceStaffingReviewTag(lead.campaign_notes || lead.campaignNotes || '', {
    fit, personalization: 'FAILED', routingReady: false,
  });
}

function passReviewTag(lead, confidence) {
  return replaceStaffingReviewTag(lead.campaign_notes || lead.campaignNotes || '', {
    fit: 'ICP_CONFIRMED', personalization: CONFIDENCE_TO_REVIEW[confidence], routingReady: true,
  });
}

async function admitStaffingPersonalization({ id, dryRun = false, avoidOpenings = [] }, {
  loadLead, applyPatch, classifyEmail, personalize = personalizeStaffingLead, env = process.env,
} = {}) {
  if (!loadLead || !applyPatch || !classifyEmail) throw new Error('staffing personalization admit requires canonical load/apply/classify');
  const lead = await loadLead(String(id || '').trim());
  const eligible = unsentImportEligible(lead);
  if (!eligible.ok) return { ok: false, queued: false, sent: false, reason: eligible.reason, leadId: String(id || '') };

  const classification = await classifyEmail(lead.email);
  const recipient = providerVerdict(classification, env);
  if (!recipient.allowed) {
    return {
      ok: false, queued: false, sent: false, held: true, layer: 'recipient',
      leadId: lead.id, email: lead.email, company: lead.company,
      provider: recipient.provider, reason: recipient.code, writes: 0,
    };
  }

  const result = await personalize(eligible.input, { avoidOpenings });
  const reviewPersonalization = CONFIDENCE_TO_REVIEW[result.confidence];
  if (!result.safeToSend || !reviewPersonalization || !String(result.hyperPersonalizedOpening || '').trim()) {
    const patch = { campaign_notes: holdReviewTag(lead) };
    if (!dryRun) await applyPatch(lead, patch);
    return {
      ok: false, queued: false, sent: false, held: true, writes: dryRun ? 0 : 1,
      leadId: lead.id, email: lead.email, company: lead.company, provider: 'GOOGLE',
      confidence: result.confidence, reason: result.primaryReason || 'PERSONALIZATION_REVIEW',
      supportingReasons: result.supportingReasons || result.reviewReasons || [],
      opening: '',
    };
  }

  const nextNotes = passReviewTag(lead, result.confidence);
  const nextLead = { ...lead, siteContext: result.hyperPersonalizedOpening, campaign_notes: nextNotes };
  const renderOptions = { env };
  for (const step of [1, 2, 3]) {
    const rendered = renderStaffingEmail(nextLead, step, renderOptions);
    const error = validateStaffingEmail(rendered, step);
    if (error) {
      const patch = { campaign_notes: holdReviewTag(lead) };
      if (!dryRun) await applyPatch(lead, patch);
      return {
        ok: false, queued: false, sent: false, held: true, writes: dryRun ? 0 : 1,
        leadId: lead.id, email: lead.email, company: lead.company, provider: 'GOOGLE',
        confidence: result.confidence, reason: error, opening: '',
      };
    }
  }
  const preview = renderStaffingEmail(nextLead, 1, renderOptions);
  const patch = { siteContext: result.hyperPersonalizedOpening, campaign_notes: nextNotes };
  if (!dryRun) await applyPatch(lead, patch);
  return {
    ok: true, queued: false, sent: false, held: false, writes: dryRun ? 0 : 1,
    leadId: lead.id, email: lead.email, company: lead.company, provider: 'GOOGLE',
    confidence: result.confidence, personalization: reviewPersonalization,
    opening: result.hyperPersonalizedOpening, subject: preview.subject,
    body: preview.body, facts: (result.facts || []).map(f => ({ kind: f.kind, value: f.value })),
    catchAllAdmitted: result.catchAllAdmitted === true,
    duplicateAlternateUsed: result.duplicateAlternateUsed === true,
  };
}

let running = false;

function registerStaffingPreviewRoutes(app, requireAuth, preview = previewStaffingPersonalization) {
  app.get('/api/staffing/personalization/config', requireAuth, (_req, res) => res.json(STAFFING_CAMPAIGN));
  app.post('/api/staffing/personalization/preview', requireAuth, async (req, res) => {
    const lead = req.body?.lead;
    if (!lead || !isStaffingCampaign(lead)) return res.status(422).json({ error: 'Exact staffing campaign assignment required' });
    if (running) return res.status(409).json({ error: 'A staffing preview is already running' });
    running = true;
    try { res.json(await preview(lead)); }
    catch (_) { res.status(422).json({ error: 'Staffing preview failed; no lead data was changed' }); }
    finally { running = false; }
  });
}

function registerStaffingAdmitRoute(app, requireAuth, persist) {
  app.post('/api/staffing/personalization/admit', requireAuth, async (req, res) => {
    const id = String(req.body?.id || '').trim();
    const dryRun = req.body?.dryRun === true;
    const avoidOpenings = [...new Set((Array.isArray(req.body?.avoidOpenings) ? req.body.avoidOpenings : [])
      .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 200);
    if (!id) return res.status(422).json({ error: 'Lead id is required' });
    if (!persist) return res.status(503).json({ error: 'Staffing personalization admit is not wired' });
    if (running) return res.status(409).json({ error: 'A staffing personalization run is already in progress' });
    running = true;
    try {
      const result = await admitStaffingPersonalization({ id, dryRun, avoidOpenings }, persist);
      res.status(result.ok || result.held ? 200 : 409).json({ ...result, previewOnly: dryRun, sent: false, queued: false });
    } catch (error) {
      res.status(422).json({ error: 'Staffing personalization admit failed; no send was attempted', detail: error.message, sent: false, queued: false });
    } finally { running = false; }
  });
}

module.exports = {
  registerStaffingPreviewRoutes, registerStaffingAdmitRoute, admitStaffingPersonalization,
  unsentImportEligible, CONFIDENCE_TO_REVIEW,
};
