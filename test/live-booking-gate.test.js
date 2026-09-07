'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findLiveBooking } = require('../integrations/live-booking-gate');

const booking = (email, schedule = 'schedule-1') => ({
  id: `event-${email}`, status: 'confirmed', eventType: 'default',
  start: { dateTime: '2026-10-01T10:00:00-07:00' }, end: { dateTime: '2026-10-01T10:15:00-07:00' },
  organizer: { email: 'owner@example.com', self: true },
  attendees: [{ email: 'owner@example.com', self: true, organizer: true }, { email }],
  extendedProperties: { shared: { 'goo.createdByAvailId': schedule, 'goo.createdBySet': 'default_cita' } },
});

test('an exact pinned Calendar booking cancels a prepared warm response', async () => {
  const calendar = { events: { list: async () => ({ data: { items: [booking('lead@example.com')] } }) } };
  const found = await findLiveBooking({ calendar, leadEmail: 'lead@example.com', calendarId: 'cal',
    appointmentScheduleId: 'schedule-1', ownerEmails: ['owner@example.com'], now: Date.parse('2026-09-06T00:00:00Z') });
  assert.equal(found.attendeeEmail, 'lead@example.com');
});

test('another attendee or another schedule never blocks this prospect', async () => {
  const calendar = { events: { list: async () => ({ data: { items: [booking('other@example.com'), booking('lead@example.com', 'other-schedule')] } }) } };
  assert.equal(await findLiveBooking({ calendar, leadEmail: 'lead@example.com', calendarId: 'cal',
    appointmentScheduleId: 'schedule-1', ownerEmails: ['owner@example.com'], now: Date.parse('2026-09-06T00:00:00Z') }), null);
});

test('an unreadable or unconfigured Calendar fails closed', async () => {
  await assert.rejects(() => findLiveBooking({ calendar: {}, leadEmail: 'lead@example.com' }), /not fully configured/);
});
