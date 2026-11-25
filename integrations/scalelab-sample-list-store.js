'use strict';
// Supabase storage for the ScaleLab sample employer list. Company-level data
// only (no contacts). The list lives in the database, never in the public
// repository. Server-side secret key; RLS denies anon/authenticated.
const { mirrorConfig } = require('./supabase-mirror');

const EMPLOYERS = 'sample_employers';
const EVENTS = 'scalelab_sample_list_events';
const AGENCY_STATES = 'scalelab_agency_states';
const EVENT_KINDS = Object.freeze(['drafted', 'review', 'sent', 'autosend_refused', 'outcome']);

function toEmployer(row) {
  return {
    domain: row.domain, company: row.company, city: row.city || '', state: row.state || '',
    industry: row.industry || '', tradeFocus: row.trade_focus || '',
    openRoles: Number(row.open_roles) || 0, openRolesLabel: row.open_roles_label || null,
    exampleRoles: Array.isArray(row.example_roles) ? row.example_roles : [],
    newestPosting: row.newest_posting || null, checkedAt: row.checked_at || null,
    status: row.status, nationalRank: Number.isFinite(row.national_rank) ? row.national_rank : null,
  };
}

function createSampleListStore({ env = process.env, fetchImpl = global.fetch } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) throw new Error('sample list database unavailable');
  const headers = { apikey: config.key, Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json' };
  async function request(table, method, query, body, prefer) {
    const response = await fetchImpl(`${config.url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
      method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
      signal: AbortSignal.timeout(8000), ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`sample list storage returned ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('invalid sample list storage response');
    return rows;
  }
  async function pages(table, query) {
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await request(table, 'GET', { ...query, limit: '1000', offset: String(offset) });
      all.push(...rows);
      if (rows.length < 1000) return all;
    }
  }
  return {
    async listHiring() {
      return (await pages(EMPLOYERS, { status: 'eq.hiring', order: 'domain.asc' })).map(toEmployer);
    },
    async listPool() {
      return (await pages(EMPLOYERS, { order: 'state.asc,domain.asc' })).map(toEmployer);
    },
    async recordCheck({ domain, checkedAt, hiring, openRoles, exampleRoles, newestPosting }) {
      const patch = hiring
        ? { status: 'hiring', open_roles: openRoles, open_roles_label: null, example_roles: exampleRoles,
          newest_posting: newestPosting, checked_at: checkedAt, updated_at: new Date().toISOString() }
        : { status: 'not_hiring', open_roles: 0, open_roles_label: null, checked_at: checkedAt,
          updated_at: new Date().toISOString() };
      const [row] = await request(EMPLOYERS, 'PATCH', { domain: 'eq.' + domain }, patch, 'return=representation');
      if (!row || row.domain !== domain) throw new Error('sample employer check not saved');
      return toEmployer(row);
    },
    // Discovered employer (company level). Never overwrites an existing row.
    async addEmployer(row) {
      const body = { domain: row.domain, company: row.company, city: row.city || '', state: row.state,
        industry: row.industry || '', trade_focus: row.tradeFocus || '', open_roles: row.openRoles || 0,
        example_roles: row.exampleRoles || [], newest_posting: row.newestPosting || null, checked_at: row.checkedAt,
        status: row.hiring ? 'hiring' : 'not_hiring', source: 'getleads_discovery', updated_at: new Date().toISOString() };
      const [saved] = await request(EMPLOYERS, 'POST', { on_conflict: 'domain' }, body, 'resolution=ignore-duplicates,return=representation');
      return saved ? toEmployer(saved) : null;
    },
    // Campaign 3 agencies (queued + in sequence) per agency state. Reads only
    // emails from outreach_leads and the backfilled agency states.
    async agencyDemand() {
      const states = new Map((await pages(AGENCY_STATES, { select: 'domain,state', order: 'domain.asc' }))
        .map(row => [row.domain, row.state]));
      const leads = await pages('outreach_leads', { select: 'email', client_id: 'eq.scalelab',
        campaign: 'eq.Industrial Campaign 3', stage: 'in.(Queued,Contacted)', order: 'email.asc' });
      const demand = {};
      for (const lead of leads) {
        const domain = String(lead.email || '').trim().toLowerCase().split('@')[1] || '';
        const state = states.get(domain);
        if (state) demand[state] = (demand[state] || 0) + 1;
      }
      return { demand, agencyDomains: new Set(states.keys()) };
    },
    async getAgencyStates(domain) {
      const key = String(domain || '').trim().toLowerCase();
      if (!key) return [];
      const [row] = await request(AGENCY_STATES, 'GET', { domain: 'eq.' + key, limit: '1' });
      return row && Array.isArray(row.states) ? row.states : [];
    },
    async getEvent(eventId) {
      return (await request(EVENTS, 'GET', { event_id: 'eq.' + eventId, limit: '1' }))[0] || null;
    },
    // Idempotent by event_id: a repeated pass converges on the first row.
    async logEvent(event) {
      if (!EVENT_KINDS.includes(event.kind)) throw new Error('unknown sample list event kind');
      const [row] = await request(EVENTS, 'POST', { on_conflict: 'event_id' }, {
        event_id: event.eventId, client_id: 'scalelab', kind: event.kind, action_id: event.actionId || null,
        lead_id: event.leadId, message_id: event.messageId || null, thread_id: event.threadId || null,
        mailbox_id: event.mailboxId || null, market: event.market || null, scope: event.scope || null,
        state: event.state || null, employer_domains: event.employerDomains || [], gmail_draft_id: event.gmailDraftId || null,
        outcome: event.outcome || null, detail: event.detail || {}, occurred_at: event.occurredAt || new Date().toISOString(),
      }, 'resolution=ignore-duplicates,return=representation');
      return row || this.getEvent(event.eventId);
    },
    async updateEvent(eventId, patch) {
      const [row] = await request(EVENTS, 'PATCH', { event_id: 'eq.' + eventId }, patch, 'return=representation');
      if (!row || row.event_id !== eventId) throw new Error('sample list event update not verified');
      return row;
    },
    async listEvents({ kinds = EVENT_KINDS, since } = {}) {
      return pages(EVENTS, { kind: `in.(${kinds.join(',')})`, ...(since ? { occurred_at: 'gte.' + since } : {}),
        order: 'occurred_at.asc' });
    },
  };
}

module.exports = { createSampleListStore, toEmployer, EVENT_KINDS, EMPLOYERS, EVENTS, AGENCY_STATES };
