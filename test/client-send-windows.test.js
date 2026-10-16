'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getClient } = require('../integrations/clients/registry');
const { JOLE_EARLY_CRON, joleWallClock, clientSendWindowVerdict } = require('../integrations/clients/send-windows');
const { SEND_WINDOWS, SEND_WINDOW_CRON } = require('../integrations/sequence-timing');

const allowed = (clientId, iso, scheduledClientScope = '') =>
  clientSendWindowVerdict(clientId, { now: Date.parse(iso), scheduledClientScope }).allowed;

test('Jole uses its confirmed Chicago timezone and keeps the dedicated caps', () => {
  const jole = getClient('jole');
  assert.equal(jole.timezone, 'America/Chicago');
  assert.equal(jole.timezoneConfirmed, true);
  assert.deepEqual(jole.capacity, { dailyCap: 120, windowCap: 12, reservedDaily: 0, reservedWindow: 0 });
  assert.equal(jole.senderPolicy.maxDailyPerInbox, 20);
});

test('Jole weekday window starts at 07:00 and closes at 12:00 Chicago time', () => {
  assert.equal(allowed('jole', '2026-10-19T11:59:59Z'), false); // 06:59:59 CDT
  assert.equal(allowed('jole', '2026-10-19T12:00:00Z'), true);  // 07:00 CDT
  assert.equal(allowed('jole', '2026-10-19T16:59:59Z'), true);  // 11:59 CDT
  assert.equal(allowed('jole', '2026-10-19T17:00:00Z'), false); // 12:00 CDT
  assert.equal(allowed('jole', '2026-10-18T13:00:00Z'), false); // Sunday
  assert.deepEqual(joleWallClock(Date.parse('2026-10-19T12:00:00Z')), { weekday: 'Mon', hour: 7, minute: 0 });
});

test('Chicago DST changes do not shift Jole local send hours', () => {
  assert.equal(allowed('jole', '2026-10-30T12:00:00Z'), true); // 07:00 CDT
  assert.equal(allowed('jole', '2026-11-02T12:00:00Z'), false); // 06:00 CST
  assert.equal(allowed('jole', '2026-11-02T13:00:00Z'), true); // 07:00 CST
  assert.equal(allowed('jole', '2026-11-02T18:00:00Z'), false); // noon CST
});

test('early Jole runs cannot send ScaleLab mail; Pacific ScaleLab windows stay exact', () => {
  assert.equal(JOLE_EARLY_CRON, '0,30 7-8 * * 1-5');
  assert.equal(allowed('scalelab', '2026-10-19T12:00:00Z', 'jole'), false);
  assert.equal(allowed('jole', '2026-10-19T12:00:00Z', 'jole'), true);
  assert.equal(allowed('scalelab', '2026-10-19T20:00:00Z'), true);
  assert.deepEqual(SEND_WINDOWS, { timezone: 'America/Vancouver', weekdays: [1, 2, 3, 4, 5], firstHour: 7, lastHour: 11, minutes: [0, 30] });
  assert.equal(SEND_WINDOW_CRON, '0,30 7-11 * * 1-5');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5',[\s\S]*?timezone: 'America\/Vancouver'/);
  assert.match(server, /cron\.schedule\(JOLE_EARLY_CRON,[\s\S]*?SCHEDULED_CLIENT_SCOPE: 'jole'[\s\S]*?timezone: 'America\/Chicago'/);
});

test('Jole remains held by the final client authorization gate', () => {
  const { clientSendBlock } = require('../integrations/clients/send-policy');
  assert.match(clientSendBlock('jole', {}).reason, /CLIENT_SENDING_AUTHORIZED/);
  assert.equal(clientSendBlock('jole', { CLIENT_SENDING_AUTHORIZED: 'scalelab' }).code, 'client_sending_disabled');
});
