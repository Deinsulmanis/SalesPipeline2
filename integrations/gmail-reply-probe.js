'use strict';
// Fast reply detection probe. READ-ONLY: Gmail users.getProfile and
// users.history.list. It keeps its own in-memory position per inbox and never
// touches the observer's checkpoint; the regular check-only pass (which owns
// the cursor, classification and every write) is started only when a new
// INBOX message has arrived. If a triggered pass fails, the :15/:45 pass still
// observes the same messages, so nothing is skipped.

function createReplyProbe({ listInboxes, gmailFor, log = () => {} }) {
  const position = new Map();
  return async function probe() {
    const summary = { inboxes: 0, newInbound: 0, errors: 0, initialized: 0 };
    for (const inbox of listInboxes()) {
      summary.inboxes += 1;
      try {
        const gmail = gmailFor(inbox);
        const start = position.get(inbox.id);
        if (!start) {
          const profile = await gmail.users.getProfile({ userId: 'me' });
          position.set(inbox.id, String(profile.data.historyId));
          summary.initialized += 1;
          continue;
        }
        const res = await gmail.users.history.list({ userId: 'me', startHistoryId: start, historyTypes: ['messageAdded'],
          labelId: 'INBOX', maxResults: 100 });
        const added = (res.data.history || []).flatMap(h => h.messagesAdded || [])
          .filter(item => {
            const labels = item.message?.labelIds || [];
            return labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT');
          });
        summary.newInbound += added.length + (res.data.nextPageToken ? 1 : 0);
        if (res.data.historyId) position.set(inbox.id, String(res.data.historyId));
      } catch (error) {
        summary.errors += 1;
        const status = Number(error.code || error.status || error.response?.status);
        if (status === 404) position.delete(inbox.id);   // history expired: re-initialize next time
        log(`[fast-reply] probe ${inbox.id} failed: ${status || error.message}`);
      }
    }
    return summary;
  };
}

module.exports = { createReplyProbe };
