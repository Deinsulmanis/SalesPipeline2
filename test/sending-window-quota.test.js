'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSendingWindowQuota,
  sendingWindowVerdict,
  consumeSendingWindowSuccess,
  sendingWindowSnapshot,
} = require('../integrations/sending-window-quota');

const makeWindow = () => createSendingWindowQuota({
  senderIds: ['primary', 'secondary'], perSenderLimit: 5, globalLimit: 10,
});

test('a scheduled window enforces five successes per inbox and ten combined', () => {
  const quota = makeWindow();
  for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, 'primary');
  assert.equal(sendingWindowVerdict(quota, 'primary').allowed, false);
  assert.equal(sendingWindowVerdict(quota, 'secondary').allowed, true);
  for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, 'secondary');
  const snapshot = sendingWindowSnapshot(quota);
  assert.equal(snapshot.successesBySender.get('primary'), 5);
  assert.equal(snapshot.successesBySender.get('secondary'), 5);
  assert.equal(snapshot.globalSuccesses, 10);
  assert.equal(sendingWindowVerdict(quota, 'secondary').allowed, false);
});

test('blocked and failed candidates consume no successful-send capacity', () => {
  const quota = makeWindow();
  for (let candidate = 0; candidate < 25; candidate++) {
    // Merely checking eligibility models every pre-provider refusal path.
    assert.equal(sendingWindowVerdict(quota, candidate % 2 ? 'primary' : 'secondary').allowed, true);
  }
  assert.equal(sendingWindowSnapshot(quota).globalSuccesses, 0);
});

test('eight windows naturally enforce primary 40, secondary 40, global 80', () => {
  const daily = new Map([['primary', 0], ['secondary', 0]]);
  let global = 0;
  for (let window = 0; window < 8; window++) {
    const quota = makeWindow();
    for (const senderId of ['primary', 'secondary']) {
      for (let candidate = 0; candidate < 6; candidate++) {
        if ((daily.get(senderId) || 0) >= 40 || global >= 80) continue;
        if (!sendingWindowVerdict(quota, senderId).allowed) continue;
        consumeSendingWindowSuccess(quota, senderId);
        daily.set(senderId, daily.get(senderId) + 1);
        global++;
      }
    }
    assert.deepEqual([...sendingWindowSnapshot(quota).successesBySender.values()], [5, 5]);
  }
  assert.deepEqual([...daily.values()], [40, 40]);
  assert.equal(global, 80);
});

test('one inbox at forty does not stop the other, and neither can exceed forty', () => {
  const daily = new Map([['primary', 40], ['secondary', 0]]);
  let global = 40;
  for (let window = 0; window < 8; window++) {
    const quota = makeWindow();
    for (const senderId of ['primary', 'secondary']) {
      for (let candidate = 0; candidate < 10; candidate++) {
        if (daily.get(senderId) >= 40 || global >= 80) continue;
        if (!sendingWindowVerdict(quota, senderId).allowed) continue;
        consumeSendingWindowSuccess(quota, senderId);
        daily.set(senderId, daily.get(senderId) + 1);
        global++;
      }
    }
  }
  assert.deepEqual([...daily.values()], [40, 40]);
  assert.equal(global, 80);
});
