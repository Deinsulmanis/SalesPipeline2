'use strict';

const axios = require('axios');
const crypto = require('crypto');

class SmartleadError extends Error {
  constructor(message, { status = 0, retryable = false, code = 'SMARTLEAD_ERROR' } = {}) {
    super(message);
    this.name = 'SmartleadError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SmartleadClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.SMARTLEAD_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.SMARTLEAD_API_BASE_URL ?? 'https://server.smartlead.ai/api/v1').replace(/\/$/, '');
    this.integrationEnabled = options.integrationEnabled ?? process.env.SMARTLEAD_INTEGRATION_ENABLED === 'true';
    this.liveMutationsEnabled = options.liveMutationsEnabled ?? process.env.SMARTLEAD_LIVE_MUTATIONS_ENABLED === 'true';
    this.timeout = options.timeout ?? Number(process.env.SMARTLEAD_REQUEST_TIMEOUT_MS || 10000);
    this.maxRetries = options.maxRetries ?? 2;
    this.http = options.http ?? axios.create({ timeout: this.timeout });
    if (this.integrationEnabled && !this.apiKey) throw new SmartleadError('SMARTLEAD_API_KEY is required when Smartlead is enabled', { code: 'CONFIGURATION_ERROR' });
  }

  assertConfigured() {
    if (!this.integrationEnabled) throw new SmartleadError('Smartlead integration is disabled', { code: 'INTEGRATION_DISABLED' });
    if (!this.apiKey) throw new SmartleadError('Smartlead API key is not configured', { code: 'CONFIGURATION_ERROR' });
  }

  async request(method, path, { params = {}, data, mutation = false, correlationId } = {}) {
    this.assertConfigured();
    if (mutation && !this.liveMutationsEnabled) {
      return { testMode: true, skipped: true, reason: 'SMARTLEAD_LIVE_MUTATIONS_ENABLED is not true' };
    }
    const headers = { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId || crypto.randomUUID() };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.http.request({ method, url: `${this.baseUrl}${path}`, params: { ...params, api_key: this.apiKey }, data, headers });
        return response.data;
      } catch (error) {
        const status = error.response?.status || 0;
        const retryable = status === 0 || status === 429 || status >= 500;
        if (retryable && attempt < this.maxRetries) {
          await sleep(Math.min(250 * (2 ** attempt), 1000));
          continue;
        }
        const providerMessage = error.response?.data?.message || error.response?.data?.error;
        throw new SmartleadError(providerMessage || `Smartlead request failed (${status || 'network error'})`, {
          status, retryable, code: status === 401 ? 'AUTHENTICATION_ERROR' : status === 422 ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
        });
      }
    }
  }

  listCampaigns() { return this.request('get', '/campaigns'); }
  getCampaign(campaignId) { return this.request('get', `/campaigns/${encodeURIComponent(campaignId)}`); }
  getCampaignLeads(campaignId, { offset = 0, limit = 100 } = {}) { return this.request('get', `/campaigns/${encodeURIComponent(campaignId)}/leads`, { params: { offset, limit } }); }
  getCampaignStats(campaignId) { return this.request('get', `/campaigns/${encodeURIComponent(campaignId)}/analytics`); }
  addLeads(campaignId, leadList) {
    return this.request('post', `/campaigns/${encodeURIComponent(campaignId)}/leads`, {
      mutation: true,
      data: { lead_list: leadList, settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false, ignore_community_bounce_list: false, return_lead_ids: true } },
    });
  }
  pauseLead(campaignId, leadId) { return this.request('post', `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/pause`, { mutation: true }); }
  resumeLead(campaignId, leadId) { return this.request('post', `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/resume`, { mutation: true }); }
  unsubscribeLead(_campaignId, leadId) { return this.request('post', `/leads/${encodeURIComponent(leadId)}/unsubscribe`, { mutation: true }); }
  getMessageHistory(campaignId, leadId) { return this.request('get', `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/message-history`); }
  updateLeadCategory(campaignId, leadId, categoryId) { return this.request('post', `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/category`, { mutation: true, data: { category_id: categoryId } }); }
}

class MockSmartleadClient extends SmartleadClient {
  constructor(fixtures = {}) {
    super({ apiKey: 'mock', integrationEnabled: true, liveMutationsEnabled: true, maxRetries: 0 });
    this.fixtures = fixtures;
    this.calls = [];
  }
  async request(method, path, options = {}) {
    this.calls.push({ method, path, options });
    const key = `${method.toUpperCase()} ${path}`;
    if (this.fixtures[key] instanceof Error) throw this.fixtures[key];
    return this.fixtures[key] ?? { success: true, mock: true };
  }
}

module.exports = { SmartleadClient, SmartleadError, MockSmartleadClient };
