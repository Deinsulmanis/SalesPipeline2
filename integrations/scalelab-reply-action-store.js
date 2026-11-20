'use strict';
const { randomUUID } = require('node:crypto');
const { mirrorConfig } = require('./supabase-mirror');
const { loadRoutingPolicy } = require('./scalelab-reply-router');

function createScaleLabReplyActionStore({ env = process.env, fetchImpl = global.fetch } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) throw new Error('ScaleLab reply action database unavailable');
  const endpoint = config.url + '/rest/v1/scalelab_reply_actions';
  const headers = { apikey: config.key, Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json' };
  const policy = loadRoutingPolicy();
  async function request(method, query, body, prefer, target = endpoint) {
    const response = await fetchImpl(target + '?' + new URLSearchParams(query), {
      method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
      signal: AbortSignal.timeout(5000), ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('ScaleLab reply action storage returned ' + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid ScaleLab action storage response');
    return rows;
  }
  const get = async id => (await request('GET', { action_id: 'eq.' + id, limit: '1' }))[0] || null;
  const classificationTable = config.url + '/rest/v1/scalelab_reply_classifications';
  const getClassification = async id => (await request('GET', { decision_id: 'eq.' + id, limit: '1' },
    null, null, classificationTable))[0] || null;
  return {
    get,
    async claimClassification(id, candidate, now) {
      const claim = randomUUID();
      const [row] = await request('POST', { on_conflict: 'decision_id' }, {
        decision_id: id, client_id: 'scalelab', lead_id: candidate.leadId,
        mailbox_id: candidate.senderInboxId, message_id: candidate.messageId,
        claim_id: claim, started_at: now.toISOString(), status: 'pending',
      }, 'resolution=ignore-duplicates,return=representation', classificationTable);
      const saved = row || await getClassification(id);
      if (!saved || saved.decision_id !== id || saved.client_id !== 'scalelab'
          || saved.lead_id !== candidate.leadId || saved.mailbox_id !== candidate.senderInboxId
          || saved.message_id !== candidate.messageId) throw new Error('ScaleLab classification claim not verified');
      return { acquired: Boolean(row && saved.claim_id === claim && saved.status === 'pending'), record: saved };
    },
    async finishClassification(record, verdict) {
      const [row] = await request('PATCH', { decision_id: 'eq.' + record.decision_id, status: 'eq.pending',
        claim_id: 'eq.' + record.claim_id }, { status: 'finished', verdict }, 'return=representation', classificationTable);
      const saved = row || await getClassification(record.decision_id);
      if (!saved || saved.status !== 'finished' || !saved.verdict) throw new Error('ScaleLab classification result not verified');
      return saved.verdict;
    },
    async listSince(mode, since) {
      const all = [];
      for (let offset = 0; ; offset += 500) {
        const rows = await request('GET', { mode: 'eq.' + mode, received_at: 'gte.' + since,
          order: 'action_id.asc', limit: '500', offset: String(offset) });
        all.push(...rows);
        if (rows.length < 500) return all;
      }
    },
    async record(candidate, plan, mode) {
      const [row] = await request('POST', { on_conflict: 'action_id' }, {
        action_id: candidate.id, client_id: 'scalelab', mode, lead_id: candidate.leadId,
        message_id: candidate.messageId, mailbox_id: candidate.senderInboxId, received_at: candidate.at,
        source_event_id: candidate.eventId, verdict: candidate.verdict, plan,
        policy_version: policy.version, policy_digest: policy.digest, step: 'planned',
      }, 'resolution=ignore-duplicates,return=representation');
      const saved = row || await get(candidate.id);
      if (!saved || saved.client_id !== 'scalelab' || saved.mode !== mode || saved.lead_id !== candidate.leadId
          || saved.message_id !== candidate.messageId || saved.mailbox_id !== candidate.senderInboxId) {
        throw new Error('ScaleLab reply action identity commitment not verified');
      }
      return saved;
    },
    async advance(record, step, outcome) {
      const [next] = await request('PATCH', { action_id: 'eq.' + record.action_id, step: 'eq.' + record.step, mode: 'eq.apply' },
        { step, outcome, updated_at: new Date().toISOString() }, 'return=representation');
      const saved = next || await get(record.action_id);
      if (!saved || saved.step === record.step) throw new Error('ScaleLab reply action transition not verified');
      return saved;
    },
  };
}
module.exports = { createScaleLabReplyActionStore };
