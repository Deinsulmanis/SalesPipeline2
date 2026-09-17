'use strict';

const { normalizeEmail, normalizeStatus, ACTIVE_STATUSES } = require('./smartlead-safety');

function gmailSendEvidence(lead = {}, activities = []) {
  if (Number(lead.emailStep || 0) > 0) return true;
  const status = String(lead.emailStatus || '').trim().toLowerCase();
  if (['emailed', 'done', 'replied'].includes(status)) return true;
  return (activities || []).some(row => /^(initial_email_sent|follow_up_sent|sequence_step_sent|booking_link_sent)$/.test(String(row.eventType || '')));
}

function activeMappingsForLead(lead = {}, mappings = []) {
  const email = normalizeEmail(lead.email);
  return (mappings || []).filter(row => {
    const same = String(row.internalLeadId || '') === String(lead.id || '')
      || (email && normalizeEmail(row.normalizedEmail) === email);
    if (!same) return false;
    return ACTIVE_STATUSES.has(normalizeStatus(row.normalizedStatus));
  });
}

function campaignProviderFor(lead = {}, campaignProviders = {}) {
  const key = String(lead.campaign || '').trim();
  const mapped = campaignProviders instanceof Map
    ? campaignProviders.get(key) : campaignProviders[key];
  return mapped && mapped.provider ? mapped : { provider: 'gmail', externalCampaignId: '' };
}

function authoritativeProvider({
  lead = {}, mappings = [], campaignProviders = {}, activities = [],
} = {}) {
  const active = activeMappingsForLead(lead, mappings);
  const mappingProviders = new Set(active.map(row => String(row.provider || 'smartlead').toLowerCase()));
  const gmailSent = gmailSendEvidence(lead, activities);
  const campaign = campaignProviderFor(lead, campaignProviders);
  const campaignName = String(campaign.provider || 'gmail').toLowerCase();

  if (mappingProviders.has('smartlead') && mappingProviders.has('gmail')) {
    return {
      ok: false, provider: 'ambiguous', gmailAllowed: false, smartleadAllowed: false,
      reason: 'lead has active mappings on more than one provider',
    };
  }
  if (mappingProviders.has('smartlead') && gmailSent) {
    return {
      ok: false, provider: 'ambiguous', gmailAllowed: false, smartleadAllowed: false,
      reason: 'Smartlead-owned lead also has Gmail send evidence',
    };
  }
  if (mappingProviders.has('smartlead') || campaignName === 'smartlead') {
    if (gmailSent && campaignName === 'smartlead') {
      return {
        ok: false, provider: 'ambiguous', gmailAllowed: false, smartleadAllowed: false,
        reason: 'Gmail send evidence exists on a Smartlead campaign',
      };
    }
    return {
      ok: true, provider: 'smartlead', gmailAllowed: false,
      smartleadAllowed: !mappingProviders.has('smartlead'),
      reason: mappingProviders.has('smartlead')
        ? 'Smartlead already owns this lead' : 'campaign is mapped to Smartlead',
    };
  }
  if (gmailSent) {
    return {
      ok: true, provider: 'gmail', gmailAllowed: true, smartleadAllowed: false,
      reason: 'Gmail already sent for this lead',
    };
  }
  return {
    ok: true, provider: 'gmail', gmailAllowed: true, smartleadAllowed: false,
    reason: 'default Gmail ownership',
  };
}

function assertGmailProviderAllowed(input) {
  const ownership = authoritativeProvider(input);
  if (!ownership.gmailAllowed) {
    const error = new Error(ownership.reason || 'Gmail send is not allowed for this lead');
    error.code = 'provider_gmail_forbidden';
    throw error;
  }
  return ownership;
}

function assertSmartleadEnqueueAllowed(input) {
  const ownership = authoritativeProvider(input);
  if (!ownership.smartleadAllowed) {
    const error = new Error(ownership.reason || 'Smartlead enqueue is not allowed for this lead');
    error.code = 'provider_smartlead_forbidden';
    throw error;
  }
  return ownership;
}

module.exports = {
  gmailSendEvidence, activeMappingsForLead, campaignProviderFor,
  authoritativeProvider, assertGmailProviderAllowed, assertSmartleadEnqueueAllowed,
};
