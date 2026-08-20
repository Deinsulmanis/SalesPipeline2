'use strict';

class GmailOutreachProvider {
  constructor({ send }) { this.name = 'gmail'; this.send = send; }
  async sendEmail(message) { return this.send(message); }
}

class SmartleadOutreachProvider {
  constructor({ client }) { this.name = 'smartlead'; this.client = client; }
  addLeads(campaign, leads) { return this.client.addLeads(campaign.externalCampaignId, leads); }
  pauseLead(ref) { return this.client.pauseLead(ref.externalCampaignId, ref.externalLeadId, ref.email); }
  resumeLead(ref) { return this.client.resumeLead(ref.externalCampaignId, ref.externalLeadId, ref.email, ref.delayDays); }
  unsubscribeLead(ref) { return this.client.unsubscribeLead(ref.externalCampaignId, ref.externalLeadId, ref.email); }
  getCampaignStats(id) { return this.client.getCampaignStats(id); }
  getCampaignLeads(id, cursor = 0) { return this.client.getCampaignLeads(id, { offset: Number(cursor) || 0 }); }
}

module.exports = { GmailOutreachProvider, SmartleadOutreachProvider };
