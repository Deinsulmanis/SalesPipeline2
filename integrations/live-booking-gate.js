'use strict';

const { classifyCalendarEvent, BOOKING_DECISION } = require('./google-calendar');

const norm = value => String(value || '').trim().toLowerCase();

/**
 * Read the pinned appointment schedule immediately before a warm response.
 * This closes the small gap between the scheduler's Calendar sync and the
 * provider send without changing Calendar or CRM state.
 */
async function findLiveBooking({ calendar, leadEmail, calendarId, appointmentScheduleId,
  ownerEmails = [], now = Date.now() }) {
  if (!calendarId || !appointmentScheduleId) throw new Error('booking Calendar is not fully configured');
  const events = [];
  let pageToken;
  do {
    const response = await calendar.events.list({
      calendarId, singleEvents: true, showDeleted: false, maxResults: 250,
      timeMin: new Date(Number(now) - 30 * 86400000).toISOString(),
      timeMax: new Date(Number(now) + 730 * 86400000).toISOString(),
      sharedExtendedProperty: `goo.createdByAvailId=${appointmentScheduleId}`,
      ...(pageToken ? { pageToken } : {}),
    });
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  const wanted = norm(leadEmail);
  for (const event of events) {
    const result = classifyCalendarEvent(event, {
      calendarId, bookingCalendarId: calendarId, appointmentScheduleId,
      requireAppointmentScheduleId: true, ownerEmails: new Set(ownerEmails.map(norm)),
    });
    if (result.decision === BOOKING_DECISION.BOOKED && norm(result.attendeeEmail) === wanted) return result;
  }
  return null;
}

module.exports = { findLiveBooking };
