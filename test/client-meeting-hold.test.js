'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { ledgerClientIds, loadClientMeetingHolds, clientMeetingHoldReason, describeClientMeetingHolds } = require('../integrations/clients/meeting-hold');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const ledger = require('../integrations/clients/ledger');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

let restoreActivation;
test.before(() => { restoreActivation = activateJoleForTest(); });
test.after(() => restoreActivation());

const joleLead = (id, extra = {}) => ({
  id, company: 'American Steel Fab', contactName: 'Cliff T', email: `${id}@asf-test.invalid`,
  leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', senderInboxId: '', tradeType: '', ...extra,
});
const scalelabLead = { id: 'sl-1', email: 'owner@staffco-test.invalid', leadNiche: 'staffing', emailTemplateId: 'staffing-v1' };

async function storeWithMeeting(leadId, status) {
  const store = createMemoryLedgerStore();
  const meeting = await ledger.recordMeetingBooked(store, {
    clientId: 'jole', lead: joleLead(leadId), bookedAt: '2026-11-13T13:15:15Z', scheduledFor: '2026-11-16T21:30:00Z', by: 'google_calendar',
  });
  if (status === 'CANCELLED') await ledger.updateMeeting(store, { clientId: 'jole', meetingId: meeting.meeting_id, toStatus: 'CANCELLED' });
  return store;
}

test('only ledger clients are loaded: ScaleLab is never held', () => {
  assert.deepEqual(ledgerClientIds(), ['jole']);
});

test('a Jole lead with a booked meeting is held; others are not', async () => {
  const holds = await loadClientMeetingHolds({ store: await storeWithMeeting('booked-1') });
  assert.match(clientMeetingHoldReason(joleLead('booked-1'), holds), /meeting with this lead is in the Jole BTX LLC meeting ledger/);
  assert.equal(clientMeetingHoldReason(joleLead('other-1'), holds), '');
  assert.equal(clientMeetingHoldReason(scalelabLead, holds), '');
});

test('a cancelled meeting still ends the cold sequence', async () => {
  const holds = await loadClientMeetingHolds({ store: await storeWithMeeting('cancel-1', 'CANCELLED') });
  assert.notEqual(clientMeetingHoldReason(joleLead('cancel-1'), holds), '');
});

test('an unreadable ledger holds every Jole lead and no ScaleLab lead', async () => {
  const broken = { enabled: true, listMeetings: async () => { throw new Error('timeout'); } };
  const holds = await loadClientMeetingHolds({ store: broken });
  assert.match(clientMeetingHoldReason(joleLead('any'), holds), /meeting ledger unreadable.*timeout/);
  assert.equal(clientMeetingHoldReason(scalelabLead, holds), '');
  assert.equal(describeClientMeetingHolds(holds)[0].event, 'client_meeting_holds_unavailable');
  const disabled = await loadClientMeetingHolds({ store: { enabled: false, reason: 'no supabase' } });
  assert.match(clientMeetingHoldReason(joleLead('any'), disabled), /not enabled: no supabase/);
});

test('holds that were never loaded hold nothing', () => {
  assert.equal(clientMeetingHoldReason(joleLead('x'), null), '');
});

test('agent wiring: loaded once per run before selection and checked in all three gates', () => {
  const source = fs.readFileSync(require.resolve('../outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const load = source.indexOf('CLIENT_MEETING_HOLDS = await loadClientMeetingHolds({ store: getLedgerStore() });');
  const selection = source.indexOf('const queued = selectQueued(all);');
  assert.ok(load > 0 && load < selection, 'holds load before step-1 selection');
  const body = name => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  for (const name of ['selectQueued', 'selectFollowUps', 'coldFollowUpBlockReason']) {
    assert.match(body(name), /clientMeetingHoldReason\(\w+, CLIENT_MEETING_HOLDS\)/, `${name} checks meeting holds`);
  }
});
