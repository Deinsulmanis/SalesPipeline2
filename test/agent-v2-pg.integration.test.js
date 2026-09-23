'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPgAgentV2Store, decisionIdFor } = require('../integrations/agent-v2-store');
const { evaluateAgentV2Shadow } = require('../integrations/agent-v2-shadow');

const url = process.env.AGENT_V2_TEST_DATABASE_URL || '';
const migrationUrl = process.env.AGENT_V2_TEST_MIGRATION_DATABASE_URL || url;

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
  { skip: !url }, async () => {
    const a = createPgAgentV2Store({ connectionString: url });
    const b = createPgAgentV2Store({ connectionString: url });
    const migrator = createPgAgentV2Store({ connectionString: migrationUrl });
    const suffix = crypto.randomUUID();
    const leadId = `agent-v2-test:${suffix}`;
    const messageId = `inbound:${suffix}`;
    const decisionId = decisionIdFor(leadId, messageId);
    try {
      await migrator.applyMigration();
      await b.ensureSchema();
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
