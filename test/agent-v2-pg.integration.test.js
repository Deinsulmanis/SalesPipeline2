'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createPgAgentV2Store, decisionIdFor } = require('../integrations/agent-v2-store');
const { evaluateAgentV2Shadow } = require('../integrations/agent-v2-shadow');

const url = process.env.AGENT_V2_TEST_DATABASE_URL || '';
const migrationUrl = process.env.AGENT_V2_TEST_MIGRATION_DATABASE_URL || '';

async function workerDuplicate(connectionString, decisionId, leadId, messageId) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`INSERT INTO public.agent_v2_shadow_decisions (decision_id, lead_id, message_id)
      VALUES ($1, $2, $3)`, [`${decisionId}:duplicate`, leadId, messageId]);
  } finally { await client.end(); }
}

function state(leadId, messageId) {
  return {
    version: 'conversation_state_v1', asOf: '2026-09-23T18:00:00Z', evidenceDigest: 'test',
    identity: { leadId, family: 'industrial_staffing' },
    turns: [{ turnId: `turn:${messageId}`, index: 0, direction: 'inbound', actor: 'prospect',
      messageId, threadId: 't1', content: 'Please send information.', contentAvailable: true,
      decision: { status: 'recorded', finalClassification: 'SEND_INFO', policyAction: 'HUMAN_REVIEW' } }],
    thread: { threadIds: ['t1'] }, terminalState: { blockedBy: null },
    ownership: { owner: 'human_review', humanTakeover: { value: false }, staffingAutomationHold: { applies: false } },
    qualification: { status: 'not_started', slots: {} }, questions: [], objections: [],
    referral: { status: 'none' }, booking: { linkSent: { status: 'not_observed' },
      meetingIntent: { value: false }, call: { status: 'none', live: false } },
    responseState: { answered: 'no', waitingOn: 'human' }, evidenceWarnings: [], ambiguities: [],
  };
}

test('Postgres shadow store: durable claim, concurrent exclusion, crash recovery, readback and invalid output',
  { skip: !url || !migrationUrl || process.env.AGENT_V2_TEST_TEMPORARY_DATABASE !== 'true'
      || process.env.AGENT_V2_TEST_WORKER_ROLE !== 'agent_v2_shadow_worker' }, async () => {
    for (const connectionString of [url, migrationUrl]) {
      const host = new URL(connectionString).hostname;
      assert.ok(['localhost', '127.0.0.1', '::1'].includes(host),
        'integration test may only apply its migration to local temporary Postgres');
    }
    const a = createPgAgentV2Store({ connectionString: url });
    const b = createPgAgentV2Store({ connectionString: url });
    const migrator = createPgAgentV2Store({ connectionString: migrationUrl });
    const suffix = crypto.randomUUID();
    const leadId = `agent-v2-test:${suffix}`;
    const messageId = `inbound:${suffix}`;
    const decisionId = decisionIdFor(leadId, messageId);
    try {
      await migrator.applyMigration();
      await assert.rejects(migrator.applyMigration(), /already exists/);
      const admin = new Client({ connectionString: migrationUrl });
      await admin.connect();
      try {
        const security = await admin.query(`SELECT c.relrowsecurity AS rls_enabled,
          has_table_privilege('anon', 'public.agent_v2_shadow_decisions', 'SELECT') AS anon_can_read,
          has_table_privilege('authenticated', 'public.agent_v2_shadow_decisions', 'INSERT') AS authenticated_can_insert,
          has_table_privilege('service_role', 'public.agent_v2_shadow_decisions', 'UPDATE') AS service_can_update
          FROM pg_class c WHERE c.oid = 'public.agent_v2_shadow_decisions'::regclass`);
        assert.deepEqual(security.rows[0], { rls_enabled: true,
          anon_can_read: false, authenticated_can_insert: false, service_can_update: false });
      } finally { await admin.end(); }
      const grantClient = new Client({ connectionString: migrationUrl });
      await grantClient.connect();
      try {
        await grantClient.query('GRANT USAGE ON SCHEMA public TO agent_v2_shadow_worker');
        await grantClient.query('GRANT SELECT, INSERT, UPDATE ON public.agent_v2_shadow_decisions TO agent_v2_shadow_worker');
      } finally { await grantClient.end(); }
      assert.equal((await a.verifySessionLock()).ok, true);
      assert.equal((await a.verifyPrivileges()).ok, true);
      await b.ensureSchema();
      const worker = new Client({ connectionString: url });
      await worker.connect();
      try {
        const grants = await worker.query(`SELECT
          has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'SELECT') AS can_read,
          has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'INSERT') AS can_insert,
          has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'UPDATE') AS can_update,
          has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'DELETE') AS can_delete,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
          to_regclass('public.outbound_send_reservations') AS unrelated_table`);
        assert.equal(grants.rows[0].can_read, true);
        assert.equal(grants.rows[0].can_insert, true);
        assert.equal(grants.rows[0].can_update, true);
        assert.equal(grants.rows[0].can_delete, false);
        assert.equal(grants.rows[0].can_create, false);
        if (grants.rows[0].unrelated_table) {
          const denied = await worker.query(`SELECT
            has_table_privilege(current_user, 'public.outbound_send_reservations', 'SELECT') AS can_read,
            has_table_privilege(current_user, 'public.outbound_send_reservations', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'public.outbound_send_reservations', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'public.outbound_send_reservations', 'DELETE') AS can_delete`);
          assert.ok(Object.values(denied.rows[0]).every(value => value === false));
          await assert.rejects(worker.query('INSERT INTO public.outbound_send_reservations DEFAULT VALUES'),
            /permission denied/);
        }
        const unrelated = await worker.query(`SELECT schemaname, tablename FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
            AND (schemaname, tablename) <> ('public', 'agent_v2_shadow_decisions')
            AND (has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT')
              OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT')
              OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE')
              OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE')
              OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE')
              OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRIGGER'))`);
        assert.deepEqual(unrelated.rows, []);
      } finally { await worker.end(); }
      const crashed = await a.claim({ decisionId, leadId, messageId });
      assert.equal(crashed.status, 'claimed');
      const blocked = await b.claim({ decisionId, leadId, messageId });
      assert.equal(blocked.status, 'busy');
      assert.equal(await b.get(decisionId), null);
      await crashed.release();
      let calls = 0;
      const model = async () => { calls++; return { status: 'ok', raw: { invented: true },
        usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 5, estimatedCostUsd: 0.000035 }; };
      const first = await evaluateAgentV2Shadow({ state: state(leadId, messageId), messageId, store: b, model });
      assert.equal(first.record.decision.status, 'invalid_model_output');
      assert.equal(first.record.decision.handoffCode, 'MODEL_ERROR');
      assert.equal(first.record.decision.suggestedWording, '');
      assert.deepEqual(await a.get(decisionId), first.record);
      await assert.rejects(workerDuplicate(migrationUrl, decisionId, leadId, messageId),
        error => error.code === '23505');
      const replayed = await evaluateAgentV2Shadow({ state: state(leadId, messageId), messageId, store: a, model });
      assert.equal(replayed.reused, true);
      assert.equal(calls, 1);

      const uncertainMessageId = `uncertain:${suffix}`;
      const uncertainId = decisionIdFor(leadId, uncertainMessageId);
      const uncertain = await a.claim({ decisionId: uncertainId, leadId, messageId: uncertainMessageId });
      await uncertain.markModelStarted();
      await uncertain.release();
      const recovered = await evaluateAgentV2Shadow({ state: state(leadId, uncertainMessageId),
        messageId: uncertainMessageId, store: b, model });
      assert.equal(recovered.calledModel, false);
      assert.equal(recovered.record.modelStatus, 'previous_model_attempt_unresolved');
      assert.equal(recovered.record.decision.handoffCode, 'MODEL_ERROR');
      assert.equal(calls, 1);

      const terminatedMessageId = `terminated:${suffix}`;
      const terminatedId = decisionIdFor(leadId, terminatedMessageId);
      const abandoned = await a.claim({ decisionId: terminatedId, leadId,
        messageId: terminatedMessageId });
      await abandoned.markModelStarted();
      const killer = new Client({ connectionString: migrationUrl });
      await killer.connect();
      try {
        const killed = await killer.query('SELECT pg_terminate_backend($1) AS terminated', [abandoned.backendPid]);
        assert.equal(killed.rows[0].terminated, true);
      } finally { await killer.end(); }
      await abandoned.release().catch(() => {});
      const afterCrash = await b.claim({ decisionId: terminatedId, leadId,
        messageId: terminatedMessageId });
      assert.equal(afterCrash.status, 'claimed');
      assert.equal(afterCrash.priorModelAttempt, true);
      await afterCrash.release();

      const racingMessageId = `race:${suffix}`;
      let unblock;
      let entered;
      const inModel = new Promise(resolve => { entered = resolve; });
      let racingCalls = 0;
      const slowModel = async () => { racingCalls++; entered();
        await new Promise(resolve => { unblock = resolve; });
        return { status: 'ok', raw: { invented: true }, usage: { inputTokens: 10, outputTokens: 5 } }; };
      const running = evaluateAgentV2Shadow({ state: state(leadId, racingMessageId),
        messageId: racingMessageId, store: a, model: slowModel });
      await inModel;
      const competing = await evaluateAgentV2Shadow({ state: state(leadId, racingMessageId),
        messageId: racingMessageId, store: b, model: slowModel });
      assert.equal(competing.busy, true);
      assert.equal(racingCalls, 1);
      unblock();
      await running;
    } finally { await Promise.all([a.close(), b.close(), migrator.close()]); }
  });
