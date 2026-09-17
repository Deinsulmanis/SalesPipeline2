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

function parseOutboundActionId(actionId) {
  const id = String(actionId || '');
  const cold = /^gmail-cold:(.+):step:(\d+)$/.exec(id);
  if (cold) {
    return {
      kind: 'gmail_cold_step', actionType: 'gmail_cold_step',
      leadId: cold[1], step: Number(cold[2]), sequenceId: null,
    };
  }
  if (id.startsWith('seq:')) {
    const parts = id.split(':');
    if (parts.length >= 4 && /^\d+$/.test(parts[parts.length - 1])) {
      return {
        kind: 'gmail_sequence_step', actionType: 'gmail_sequence_step',
        leadId: parts.slice(1, -2).join(':'),
        sequenceId: parts[parts.length - 2],
        step: Number(parts[parts.length - 1]),
      };
    }
  }
  if (id.startsWith('smartlead-enqueue:')) {
    const rest = id.slice('smartlead-enqueue:'.length);
    const cut = rest.indexOf(':');
    return {
      kind: 'smartlead_enqueue', actionType: 'smartlead_enqueue',
      leadId: cut === -1 ? rest : rest.slice(0, cut),
      externalCampaignId: cut === -1 ? '' : rest.slice(cut + 1),
      step: null, sequenceId: null,
    };
  }
  if (id.startsWith('reply-action:')) {
    return {
      kind: 'gmail_warm_reply', actionType: 'gmail_warm_reply',
      leadId: null, step: null, sequenceId: null,
    };
  }
  return { kind: 'unknown', actionType: null, leadId: null, step: null, sequenceId: null };
}

module.exports = {
  ordinaryColdActionId,
  stageSequenceActionId,
  smartleadEnqueueActionId,
  warmReplyActionId,
  responseActionId,
  sequenceStepEventId,
  parseOutboundActionId,
};
