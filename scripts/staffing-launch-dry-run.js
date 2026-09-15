'use strict';

// No agent import, scheduler, provider client or write credentials are loaded.
// Uses the real routing/ownership/copy modules and a saved read-only snapshot.
const fs = require('node:fs');
const path = require('node:path');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { activeVersionForLead, CAMPAIGN_VERSIONS } = require('../integrations/campaign-versions');
const { STAFFING_CAMPAIGN, renderStaffingEmail } = require('../integrations/staffing-campaign');
const { deriveAutomationOwnership, mayColdSend } = require('../integrations/automation-ownership');
const { sendSuppressionReason } = require('../integrations/pipeline-state');
const { queueEligibility } = require('../integrations/outreach-queue');

const output = path.resolve(__dirname, '../outputs/staffing-launch-20260914');
const actual = JSON.parse(fs.readFileSync(path.join(output, 'canonical-before.json'), 'utf8')).leads[0];
const senders = JSON.parse(fs.readFileSync(path.join(output, 'routing-options.json'), 'utf8')).inboxes;
const staffing = { ...actual, stage: 'Queued', senderInboxId: 'primary', routingRequired: 'true',
  intendedCampaignVersion: STAFFING_CAMPAIGN.id, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId };
const dental = { ...staffing, id: 'dry-dental', email: 'dental@example.com', campaign: 'Dental pilot',
  leadNiche: 'dental', tradeType: 'dental', senderInboxId: 'tryscalelabai',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', emailTemplateId: 'dental-guarantee-v1' };
const cases = [
  ['new staffing', staffing], ['new dental', dental],
  ['held staffing', { ...staffing, notes: '[MANUAL HOLD]' }],
  ['replied staffing', { ...staffing, emailStatus: 'replied', notes: '[REPLY: Interested]' }],
  ['suppressed staffing', staffing, { suppressedEmails: new Set([staffing.email.toLowerCase()]) }],
  ['terminal staffing', { ...staffing, stage: 'Closed Lost' }],
  ['ambiguous staffing identity', staffing, { duplicate: true }],
  ['unknown version', { ...staffing, intendedCampaignVersion: 'unknown' }],
  ['unavailable chosen mailbox', staffing, { senders: senders.map(s => ({ ...s, sendEligible: s.id !== 'primary' })) }],
];
for (const lead of [staffing, dental]) for (const senderInboxId of ['primary', 'tryscalelabai']) for (const step of [2, 3]) {
  const established = { ...lead, stage: 'Contacted', emailStatus: 'emailed', emailStep: String(step - 1), senderInboxId };
  cases.push([`${lead.leadNiche} step ${step}, established ${senderInboxId}`, established, { step,
    activities: [{ sourceLeadId: established.id, eventType: 'initial_email_sent', metadata: JSON.stringify({ senderInboxId }) }] }]);
}
const results = cases.map(([name, lead, options = {}]) => {
  const step = options.step || 1;
  const activities = options.activities || [];
  const suppressedEmails = options.suppressedEmails || new Set();
  const ownership = deriveAutomationOwnership(lead, { activities, coldCadenceDue: true, sendingEnabled: true,
    suppressionReason: item => sendSuppressionReason(item, { suppressedEmails }) });
  const safety = mayColdSend(ownership);
  let sequence, sequenceError, sender, senderError;
  try { sequence = activeVersionForLead(lead).id; } catch (e) { sequenceError = e.message; }
  try { const selection = chooseSender({ lead, activities, senders: options.senders || senders, step }); sender = selection.sender?.email; senderError = selection.reason; } catch (e) { senderError = e.message; }
  const identity = !options.duplicate;
  const route = routedLeadReady(lead);
  const preflight = step === 1 ? queueEligibility(lead, { activities, suppressedEmails,
    leads: options.duplicate ? [lead, { ...lead, id: 'duplicate' }] : [lead] }) : null;
  return { name, simulatedState: true, campaign: lead.leadNiche, sequence: sequence || lead.intendedCampaignVersion,
    configuredSequenceStatus: CAMPAIGN_VERSIONS[lead.intendedCampaignVersion]?.status || 'unknown',
    step, automationOwner: ownership.owner, sender: sender || null,
    eligible: identity && route.ok && safety.allowed && !sequenceError && !senderError && (!preflight || preflight.ok),
    reasons: [!identity && 'ambiguous identity', !route.ok && route.reason, !safety.allowed && safety.reason, sequenceError, senderError,
      preflight && !preflight.ok && preflight.reason].filter(Boolean),
    providerAction: 'STOPPED BEFORE PROVIDER; no provider client is loaded',
  };
});
fs.writeFileSync(path.join(output, 'dry-run-results.json'), JSON.stringify({ actualLeadsMutated: 0, providerCalls: 0, results }, null, 2));
const sequence = [1, 2, 3].map(step => renderStaffingEmail(staffing, step));
fs.writeFileSync(path.join(output, 'configured-sequence.json'), JSON.stringify(sequence, null, 2));
console.log(JSON.stringify({ scenarios: results.length, providerCalls: 0, results }, null, 2));
