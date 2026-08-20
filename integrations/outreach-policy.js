'use strict';

const { leadEligibility, canApplyProviderTransition, buildEventKey } = require('./smartlead-safety');

function shouldApplyRemoteEvent(localTimestamp, remoteTimestamp) {
  return canApplyProviderTransition({ currentStatus: '', currentEventAt: localTimestamp, incomingStatus: '', incomingEventAt: remoteTimestamp });
}

function isDuplicateRequest(rows, requestId) {
  const key = String(requestId || '').trim();
  return Boolean(key) && (rows || []).some(row => row.eventKey === `smartlead:request:${key}` || row.requestId === key);
}

module.exports = { leadEligibility, shouldApplyRemoteEvent, isDuplicateRequest, buildEventKey };
