'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('outside the canary (or flag OFF) the existing warm reply call is the fallback', () => {
  const handler = between('async function handlePositiveAutomation', 'async function handleTimingReply');
  // Agent v2 executes only when the flag is on, the canary pre-scope passes,
  // the live kill switch is armed and the daily cap is open.
  assert.match(handler, /let agentV2Cutover = false;\s*if \(process\.env\[AGENT_V2_EXECUTION_FLAG\] === 'true' && process\.env\.AGENT_V2_SHADOW_ENABLED === 'true'\)/);
  assert.match(handler, /canaryPreScope\(\{ lead, message, policy, activities \}\)/);
  assert.match(handler, /readAgentV2KillSwitch\(\)/);
  assert.match(handler, /canaryCapVerdict\(activities/);
  assert.match(handler, /agentV2Cutover = !gate;/);
  assert.doesNotMatch(handler, /Agent v2 initial authority permits qualification only/);
  assert.match(handler, /const delivered = agentV2Cutover\s*\? await deliverAgentV2Qualification\([\s\S]*?: await deliverHardenedWarmReply\(/);
  assert.match(handler, /classification: effectiveClassification, replyDecisionId: decision\?\.decisionId \|\| ''/);
  assert.doesNotMatch(handler, /sendEmail\(/);
  const question = between('async function handleQuestion', 'async function handleNeedsHuman');
  assert.match(question, /mode === 'auto' && isStaffingCampaign\(lead\)\s*&& process\.env\[AGENT_V2_EXECUTION_FLAG\] === 'true'/);
});

test('Phase 6 can reach Gmail only through the existing hardened warm reply and send lock', () => {
  const cutover = between('async function deliverAgentV2Qualification', 'async function handlePositiveAutomation');
  assert.match(cutover, /runAgentV2OneShotReadiness\(/);
  assert.match(cutover, /executeAgentV2Qualification\(/);
  assert.match(cutover, /deliverHardenedWarmReply\(/);
  assert.doesNotMatch(cutover, /sendEmail\(|messages\.send\(/);
  const delivery = between('async function deliverHardenedWarmReply', 'async function loadAgentV2ReplyEvidence');
  assert.match(delivery, /deliverProspectReply\(/);
  assert.match(delivery, /sendEmail\(/);
  assert.match(source, /withGmailProviderSend\(/);
});

test('Phase 6 pending execution must durably finalize before the inbound is marked evaluated', () => {
  const pass = between('async function runReplyCheckPass', 'async function commitMailboxObservationCheckpoints');
  const final = pass.indexOf('await persistReplyDecision(lead, replyDecision, activitiesForCycle, {');
  const evaluated = pass.indexOf('eventType: \'gmail_reply_evaluated\'');
  assert.ok(final >= 0 && evaluated > final);
  assert.match(pass.slice(final, evaluated), /strict: process\.env\[AGENT_V2_EXECUTION_FLAG\] === 'true'/);
  assert.match(pass.slice(final, evaluated), /pendingDecisionFor\(activitiesForCycle, message\.messageId, lead\.id\)/);
});
