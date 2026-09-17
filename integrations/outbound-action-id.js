'use strict';

const { sequenceStepEventId } = require('./stage-sequences');
const { responseActionId } = require('./prospect-reply-delivery');

function ordinaryColdActionId(leadId, step) {
  return `gmail-cold:${String(leadId)}:step:${Number(step)}`;
}

function stageSequenceActionId(leadId, sequenceId, step) {
  return sequenceStepEventId(leadId, sequenceId, step);
}

function smartleadEnqueueActionId(leadId, externalCampaignId) {
  return `smartlead-enqueue:${String(leadId)}:${String(externalCampaignId)}`;
}

function warmReplyActionId(leadId, inboundMessageId, action) {
  return responseActionId(leadId, inboundMessageId, action);
}

module.exports = {
  ordinaryColdActionId,
  stageSequenceActionId,
  smartleadEnqueueActionId,
  warmReplyActionId,
  responseActionId,
  sequenceStepEventId,
};
