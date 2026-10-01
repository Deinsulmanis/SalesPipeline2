'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
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
    identity: { leadId, family: 'industrial_staffing', clientId: 'scalelab', clientSource: 'explicit' },
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
    const aPool = new Pool({ connectionString: url, max: 2 });
    const bPool = new Pool({ connectionString: url, max: 2 });
    const migratorPool = new Pool({ connectionString: migrationUrl, max: 2 });
    const a = createPgAgentV2Store({ pool: aPool });
    const b = createPgAgentV2Store({ pool: bPool });
    const migrator = createPgAgentV2Store({ pool: migratorPool });
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
      assert.equal((await a.verifyRoleRestrictions()).ok, true);
      assert.equal((await a.verifyPrivileges()).ok, true);
      const roleAdmin = new Client({ connectionString: migrationUrl });
      await roleAdmin.connect();
      try {
        await roleAdmin.query('GRANT anon TO agent_v2_shadow_worker');
        try {
          await assert.rejects(a.verifyRoleRestrictions(), /attributes or memberships/);
        } finally { await roleAdmin.query('REVOKE anon FROM agent_v2_shadow_worker'); }
        await roleAdmin.query('GRANT CREATE ON SCHEMA public TO agent_v2_shadow_worker');
        try {
          await assert.rejects(a.verifyRoleRestrictions(), /attributes or memberships|can create in a schema/);
        } finally { await roleAdmin.query('REVOKE CREATE ON SCHEMA public FROM agent_v2_shadow_worker'); }
        await roleAdmin.query('GRANT SELECT ON public.outbound_send_reservations TO agent_v2_shadow_worker');
        try {
          await assert.rejects(a.verifyRoleRestrictions(), /unrelated tables/);
        } finally { await roleAdmin.query('REVOKE SELECT ON public.outbound_send_reservations FROM agent_v2_shadow_worker'); }
        await roleAdmin.query('GRANT DELETE ON public.agent_v2_shadow_decisions TO agent_v2_shadow_worker');
        try {
          await assert.rejects(a.verifyPrivileges(), /privileges are not restricted/);
        } finally { await roleAdmin.query('REVOKE DELETE ON public.agent_v2_shadow_decisions FROM agent_v2_shadow_worker'); }
      } finally { await roleAdmin.end(); }
      assert.equal((await a.verifyRoleRestrictions()).ok, true);
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

      const updateDeniedMessageId = `update-denied:${suffix}`;
      const roleAdminAfterClaim = new Client({ connectionString: migrationUrl });
      await roleAdminAfterClaim.connect();
      let updateDeniedCalls = 0;
      try {
        await assert.rejects(evaluateAgentV2Shadow({
          state: state(leadId, updateDeniedMessageId), messageId: updateDeniedMessageId,
          store: a, model: async () => {
            updateDeniedCalls++;
            await roleAdminAfterClaim.query('REVOKE UPDATE ON public.agent_v2_shadow_decisions FROM agent_v2_shadow_worker');
            return { status: 'ok', raw: { invented: true }, usage: { inputTokens: 1, outputTokens: 1 } };
          },
        }), error => error.code === '42501');
      } finally {
        await roleAdminAfterClaim.query('GRANT UPDATE ON public.agent_v2_shadow_decisions TO agent_v2_shadow_worker');
        await roleAdminAfterClaim.end();
      }
      const updateDeniedRecovery = await evaluateAgentV2Shadow({
        state: state(leadId, updateDeniedMessageId), messageId: updateDeniedMessageId,
        store: b, model: async () => { updateDeniedCalls++; throw new Error('model must not be called again'); },
      });
      assert.equal(updateDeniedRecovery.calledModel, false);
      assert.equal(updateDeniedRecovery.record.modelStatus, 'previous_model_attempt_unresolved');
      assert.equal(updateDeniedCalls, 1);

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

      // ── transient failure → bounded, backed-off retry on the same row ──
      const aged = async id => {
        const ager = new Client({ connectionString: migrationUrl });
        await ager.connect();
        try {
          await ager.query(`UPDATE public.agent_v2_shadow_decisions
            SET completed_at = now() - interval '6 hours', model_started_at = LEAST(model_started_at, now() - interval '6 hours')
            WHERE decision_id = $1`, [id]);
        } finally { await ager.end(); }
      };
      const retryMessageId = `retry:${suffix}`;
      const retryId = decisionIdFor(leadId, retryMessageId);
      let retryCalls = 0;
      const outage = async () => { retryCalls++; return { raw: null, status: 'model_error',
        errorCategory: 'credits', errorCode: '400', usage: { inputTokens: 0, outputTokens: 0 } }; };
      const failed = await evaluateAgentV2Shadow({ state: state(leadId, retryMessageId),
        messageId: retryMessageId, store: a, model: outage });
      assert.equal(failed.record.retryable, true);
      assert.equal(failed.record.errorCategory, 'credits');
      assert.equal(failed.record.attempt, 1);
      // Within the backoff: reused, no model call, not listed.
      const early = await evaluateAgentV2Shadow({ state: state(leadId, retryMessageId),
        messageId: retryMessageId, store: b, model: outage });
      assert.equal(early.reused, true);
      assert.equal(early.retryPending, true);
      assert.equal(retryCalls, 1);
      assert.ok(!(await a.listRetryable({ limit: 50 })).some(row => row.decision_id === retryId));
      await aged(retryId);
      assert.ok((await a.listRetryable({ limit: 50 })).some(row => row.decision_id === retryId));
      const recovered2 = await evaluateAgentV2Shadow({ state: state(leadId, retryMessageId),
        messageId: retryMessageId, store: b, model: async actual => { retryCalls++; return {
          status: 'ok', raw: { version: 'agent_v2_decision_v1', actionId: 'SUGGEST_INFO', handoffCode: 'NONE',
            factIds: ['F_TARGET_AGENCIES'], slotIds: [], objectionType: 'NONE', evidenceRefs: [actual.targetRef],
            templateId: 'INFO_OVERVIEW', reasonCode: 'INFO_REQUEST', confidence: 0.9 },
          usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 7 }; } });
      assert.equal(recovered2.calledModel, true);
      assert.equal(recovered2.record.modelStatus, 'ok');
      assert.equal(recovered2.record.decision.status, 'valid');
      assert.equal(recovered2.record.retryable, false);
      assert.equal(recovered2.record.attempt, 2);
      assert.deepEqual(recovered2.record.retryHistory.map(item => item.errorCategory), ['credits']);
      assert.equal(retryCalls, 2);
      // A success is final even long after.
      await aged(retryId);
      const final = await evaluateAgentV2Shadow({ state: state(leadId, retryMessageId),
        messageId: retryMessageId, store: a, model: outage });
      assert.equal(final.reused, true);
      assert.equal(retryCalls, 2);
      const row = await a.getDecisionRow(retryId);
      assert.ok(row.model_started_at <= row.completed_at);
      assert.equal(row.claim_attempts, 2);

      // A crash during a retry is recorded (no second call in that claim) and
      // the row stays within the same bounded budget.
      const crashMessageId = `retry-crash:${suffix}`;
      const crashId = decisionIdFor(leadId, crashMessageId);
      await evaluateAgentV2Shadow({ state: state(leadId, crashMessageId), messageId: crashMessageId, store: a, model: outage });
      await aged(crashId);
      const midRetry = await a.claim({ decisionId: crashId, leadId, messageId: crashMessageId });
      assert.equal(midRetry.status, 'claimed');
      assert.equal(midRetry.attempt, 2);
      assert.equal(midRetry.priorModelAttempt, false);
      await midRetry.markModelStarted();
      await midRetry.release();
      const callsBefore = retryCalls;
      // The interrupted call is recorded on the next claim, without calling
      // the model again in that claim; it spends one attempt of the budget.
      const afterRetryCrash = await evaluateAgentV2Shadow({ state: state(leadId, crashMessageId),
        messageId: crashMessageId, store: b, model: outage });
      assert.equal(afterRetryCrash.calledModel, false);
      assert.equal(afterRetryCrash.record.modelStatus, 'previous_model_attempt_unresolved');
      assert.equal(afterRetryCrash.record.retryable, true);
      assert.equal(afterRetryCrash.record.attempt, 3);
      assert.equal(retryCalls, callsBefore);

      // The budget is finite: after MAX attempts the failure is final.
      const exhaustMessageId = `retry-exhaust:${suffix}`;
      const exhaustId = decisionIdFor(leadId, exhaustMessageId);
      let exhaustCalls = 0;
      const down = async () => { exhaustCalls++; return { raw: null, status: 'model_error',
        errorCategory: 'server_error', usage: { inputTokens: 0, outputTokens: 0 } }; };
      for (let i = 0; i < 6; i++) {
        await evaluateAgentV2Shadow({ state: state(leadId, exhaustMessageId), messageId: exhaustMessageId, store: a, model: down });
        await aged(exhaustId);
      }
      assert.equal(exhaustCalls, 4);
      assert.ok(!(await a.listRetryable({ limit: 50 })).some(item => item.decision_id === exhaustId));

      // A deterministic failure is never retried.
      const invalidMessageId = `retry-invalid:${suffix}`;
      const invalidId = decisionIdFor(leadId, invalidMessageId);
      const invalidRun = await evaluateAgentV2Shadow({ state: state(leadId, invalidMessageId),
        messageId: invalidMessageId, store: a, model });
      assert.equal(invalidRun.record.retryable, false);
      await aged(invalidId);
      assert.ok(!(await a.listRetryable({ limit: 50 })).some(item => item.decision_id === invalidId));

      // A retry whose input can no longer be built is closed, keeping its record.
      const abandonMessageId = `retry-abandon:${suffix}`;
      const abandonId = decisionIdFor(leadId, abandonMessageId);
      await evaluateAgentV2Shadow({ state: state(leadId, abandonMessageId), messageId: abandonMessageId, store: a, model: outage });
      assert.equal(await b.abandonRetry(abandonId, 'input_unbuildable'), true);
      assert.equal(await b.abandonRetry(abandonId, 'input_unbuildable'), false);
      const abandonedRecord = await a.get(abandonId);
      assert.equal(abandonedRecord.retryable, false);
      assert.equal(abandonedRecord.retryAbandoned, 'input_unbuildable');
      assert.equal(abandonedRecord.errorCategory, 'credits');

      const totals = await b.summary();
      assert.equal(typeof totals.total, 'number');
      assert.ok(totals.successful >= 1);
      assert.ok(totals.failed >= 1);
      assert.ok(totals.retry_exhausted >= 1);
      assert.ok(totals.retryable >= 1);
      assert.equal(typeof totals.actions, 'object');
      assert.ok(totals.last_success_at);
    } finally { await Promise.all([aPool.end(), bPool.end(), migratorPool.end()]); }
  });

test('Postgres runtime kill switch: disarmed by default, audited, expiring, versioned; invisible to the shadow worker',
  { skip: !url || !migrationUrl || process.env.AGENT_V2_TEST_TEMPORARY_DATABASE !== 'true'
      || process.env.AGENT_V2_TEST_WORKER_ROLE !== 'agent_v2_shadow_worker' }, async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const admin = new Client({ connectionString: migrationUrl });
    await admin.connect();
    const workerPool = new Pool({ connectionString: url, max: 2 });
    const worker = createPgAgentV2Store({ pool: workerPool });
    try {
      await admin.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
        '20261001000000_agent_v2_runtime_control.sql'), 'utf8'));
      const initial = (await admin.query('SELECT * FROM public.agent_v2_runtime_control')).rows;
      assert.equal(initial.length, 1);
      assert.equal(initial[0].armed, false);
      // Armed without expiry is refused by the table itself.
      await assert.rejects(admin.query(`UPDATE public.agent_v2_runtime_control SET armed = true`), /armed_is_deliberate/);
      const set = (armed, until, reason, by, version) => admin.query(
        'SELECT * FROM public.agent_v2_set_runtime_control($1, $2, $3, $4, $5)', [armed, until, reason, by, version]);
      await assert.rejects(set(true, null, 'go', 'Deins', null), /expiry within 15 days/);
      await assert.rejects(set(true, new Date(Date.now() + 20 * 86400000), 'go', 'Deins', null), /expiry within 15 days/);
      await assert.rejects(set(true, new Date(Date.now() + 86400000), '', 'Deins', null), /reason is required/);
      await assert.rejects(set(false, null, 'stop', ' ', null), /changed_by is required/);
      const armed = (await set(true, new Date(Date.now() + 86400000), 'canary', 'Deins', 1)).rows[0];
      assert.equal(armed.armed, true);
      assert.equal(Number(armed.version), 2);
      await assert.rejects(set(false, null, 'stop', 'Deins', 1), /version conflict/);
      const disarmed = (await set(false, null, 'stop', 'Deins', 2)).rows[0];
      assert.equal(disarmed.armed, false);
      assert.equal(disarmed.armed_until, null);
      const events = (await admin.query('SELECT armed, previous_armed, changed_by, version FROM public.agent_v2_runtime_control_events ORDER BY event_id')).rows;
      assert.deepEqual(events.map(e => [e.armed, e.previous_armed, Number(e.version)]), [[true, false, 2], [false, true, 3]]);
      // service_role may read and call the function only; no direct writes.
      const grants = (await admin.query(`SELECT
        has_table_privilege('service_role', 'public.agent_v2_runtime_control', 'SELECT') AS read,
        has_table_privilege('service_role', 'public.agent_v2_runtime_control', 'UPDATE') AS update,
        has_table_privilege('service_role', 'public.agent_v2_runtime_control_events', 'DELETE') AS delete_events,
        has_table_privilege('anon', 'public.agent_v2_runtime_control', 'SELECT') AS anon_read,
        has_function_privilege('service_role', 'public.agent_v2_set_runtime_control(boolean, timestamptz, text, text, bigint)', 'EXECUTE') AS rpc,
        has_function_privilege('anon', 'public.agent_v2_set_runtime_control(boolean, timestamptz, text, text, bigint)', 'EXECUTE') AS anon_rpc`)).rows[0];
      assert.deepEqual(grants, { read: true, update: false, delete_events: false, anon_read: false, rpc: true, anon_rpc: false });
      // The restricted shadow worker still passes its own privilege audit.
      assert.equal((await worker.verifyRoleRestrictions()).ok, true);
      assert.equal((await worker.verifyPrivileges()).ok, true);
    } finally { await admin.end(); await workerPool.end(); }
  });
