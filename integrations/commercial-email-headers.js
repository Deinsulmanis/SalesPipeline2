'use strict';

// RFC 2369 List-Unsubscribe for cold commercial mail.
// mailto: only. One-click (RFC 8058 List-Unsubscribe-Post) is deferred: it
// requires an externally exposed authenticated endpoint that this repository
// does not have.

function commercialListUnsubscribeHeaders({ fromEmail = '', campaignRef = '' } = {}) {
  const addr = String(fromEmail || '').trim();
  if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return [];
  const subject = encodeURIComponent('unsubscribe');
  const body = encodeURIComponent(campaignRef ? `unsubscribe ${campaignRef}` : 'unsubscribe');
  return [
    `List-Unsubscribe: <mailto:${addr}?subject=${subject}&body=${body}>`,
  ];
}

module.exports = { commercialListUnsubscribeHeaders };
