'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('flag OFF leaves the existing warm reply call as the staffing and dental fallback', () => {
  const handler = between('async function handlePositiveAutomation', 'async function handleTimingReply');
  assert.match(handler, /const agentV2Cutover = isStaffingCampaign\(lead\)\s*&& process\.env\[AGENT_V2_EXECUTION_FLAG\] === 'true'/);
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
