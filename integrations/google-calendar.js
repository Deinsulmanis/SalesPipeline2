'use strict';
/**
 * google-calendar.js — Google Calendar as the BOOKING EVENT SOURCE. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Google tells us a meeting was booked, moved or cancelled. It does not tell us
 * anything about the opportunity: promotion, identity, hold and lifecycle rules
 * all stay where they already live. This module normalises provider events and
 * decides which of them are real bookings; everything downstream is the Step 7
 * promotion policy and the Step 9 call lifecycle, unchanged.
 *
 * Every function here is pure — no network, no sheets, no writes. The caller
 * supplies already-fetched events.
 *
 * SYNC ARCHITECTURE (verified against the current API docs, Aug 2026)
 * ------------------------------------------------------------------
 * Incremental sync with a syncToken, polled on the existing cron. Chosen over
 * push channels because:
 *   - a push notification carries NO event body, so the client must call
 *     events.list anyway — push saves latency, not work;
 *   - channels expire and Google provides no automatic renewal, so push adds a
 *     renewal job that can fail silently and stop bookings arriving;
 *   - incremental sync already returns cancellations, so one mechanism covers
 *     booked, moved and cancelled.
 * An expired token returns HTTP 410, whose documented recovery is "clear state
 * and run a full sync" — safe here because provider event ids make reprocessing
 * a no-op. Push can be layered on later without changing anything below.
 */

const PROVIDER = 'google_calendar';

// Google exposes no eventType for appointment-schedule bookings (the enum is
// default / birthday / focusTime / fromGmail / outOfOffice / workingLocation),
// but it DOES stamp a deterministic marker on the created event:
//
//   extendedProperties.shared = {
//     "goo.createdByAvailId": "<appointment schedule id>",
//     "goo.createdBySet": "default_cita"
//   }
//
// Verified against the live booking calendar: of 15 real events, exactly one
// carried this marker — the genuine booking. Structural signals alone accepted
// THREE, because an ordinary manually-created one-to-one meeting is otherwise
// identical: timed, default type, not recurring, organiser self, one external
// attendee. Without the marker this integration would have promoted two real
// internal meetings into the sales pipeline.
//
// The marker is therefore REQUIRED. If Google ever renames it, bookings stop
// being detected rather than ordinary meetings starting to be — the safe
// direction, and the dry run makes it obvious.
const APPOINTMENT_SCHEDULE_PROPERTY = 'goo.createdByAvailId';
const APPOINTMENT_CREATED_BY_SET = 'goo.createdBySet';
const IGNORED_EVENT_TYPES = Object.freeze(['birthday', 'focusTime', 'outOfOffice', 'workingLocation', 'fromGmail']);

/**
 * The appointment-schedule id that created this event, or '' when the event did
 * not come from a booking page.
 */
function appointmentScheduleId(event = {}) {
  const shared = (event.extendedProperties && event.extendedProperties.shared) || {};
  return String(shared[APPOINTMENT_SCHEDULE_PROPERTY] || '').trim();
}

const BOOKING_DECISION = Object.freeze({
  BOOKED: 'booked',
  CANCELLED: 'cancelled',
  IGNORED: 'ignored',
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Provider event → a shape the CRM understands. Nothing is interpreted here;
 * this only flattens the fields the rest of the module needs.
 */
function normalizeCalendarEvent(event = {}) {
  const start = event.start || {};
  const end = event.end || {};
  return {
    providerEventId: String(event.id || '').trim(),
    iCalUID: String(event.iCalUID || '').trim(),
    status: String(event.status || '').trim().toLowerCase(),
    eventType: String(event.eventType || 'default').trim(),
    summary: String(event.summary || ''),
    // A booking is always a TIMED event. An all-day entry supplies `date`
    // instead of `dateTime`, and is never an appointment-schedule booking.
    startAt: String(start.dateTime || '').trim(),
    endAt: String(end.dateTime || '').trim(),
    isAllDay: Boolean(start.date && !start.dateTime),
    timeZone: String(start.timeZone || '').trim(),
    organizerEmail: normalizeEmail(event.organizer && event.organizer.email),
    organizerSelf: Boolean(event.organizer && event.organizer.self),
    creatorEmail: normalizeEmail(event.creator && event.creator.email),
    attendees: (event.attendees || []).map(a => ({
      email: normalizeEmail(a.email),
      self: Boolean(a.self),
      organizer: Boolean(a.organizer),
      responseStatus: String(a.responseStatus || ''),
      displayName: String(a.displayName || ''),
    })),
    updatedAt: String(event.updated || '').trim(),
    recurringEventId: String(event.recurringEventId || '').trim(),
    // Google's appointment-schedule stamp — the one deterministic booking signal.
    appointmentScheduleId: appointmentScheduleId(event),
    createdBySet: String(((event.extendedProperties && event.extendedProperties.shared) || {})[APPOINTMENT_CREATED_BY_SET] || '').trim(),
  };
}

/**
 * The attendee who booked: an attendee who is neither us nor the organizer.
 * Returns null when that cannot be determined unambiguously.
 */
function bookerAttendee(normalized, ownerEmails = new Set()) {
  const candidates = (normalized.attendees || []).filter(a =>
    a.email
    && !a.self
    && !a.organizer
    && a.email !== normalized.organizerEmail
    && !ownerEmails.has(a.email));
  if (candidates.length !== 1) return null;   // none, or ambiguous — fail closed
  return candidates[0];
}

/**
 * Is this provider event a booking made through our public booking page, and
 * what does it mean?
 *
 * Deliberately conservative: anything that cannot be positively identified is
 * IGNORED with a reason rather than guessed into the pipeline.
 *
 * @param event      raw provider event
 * @param options    { bookingCalendarId, calendarId, ownerEmails }
 */
function classifyCalendarEvent(event = {}, options = {}) {
  const normalized = normalizeCalendarEvent(event);
  const ownerEmails = new Set([...(options.ownerEmails || [])].map(normalizeEmail));
  const ignore = reason => ({ decision: BOOKING_DECISION.IGNORED, reason, event: normalized });

  if (!normalized.providerEventId) return ignore('event has no provider id');

  // The booking calendar is the first and strongest filter: a personal calendar
  // or a shared work calendar simply is not the booking source.
  if (options.bookingCalendarId && options.calendarId
    && normalizeEmail(options.calendarId) !== normalizeEmail(options.bookingCalendarId)) {
    return ignore('event is not on the configured booking calendar');
  }

  // Cancellations arrive through incremental sync with status "cancelled" and
  // are usually stripped of detail, so they are judged before the shape checks.
  if (normalized.status === 'cancelled') {
    return { decision: BOOKING_DECISION.CANCELLED, reason: 'the provider marked this event cancelled', event: normalized };
  }

  if (IGNORED_EVENT_TYPES.includes(normalized.eventType)) {
    return ignore(`eventType "${normalized.eventType}" is never a booking`);
  }
  if (normalized.isAllDay || !normalized.startAt) {
    return ignore('not a timed event, so not an appointment booking');
  }
  if (normalized.recurringEventId) {
    return ignore('part of a recurring series, which a booking page does not create');
  }
  // We must be the organizer: a booking through OUR page puts our calendar in
  // that role. An invitation someone else sent us is not a booking.
  if (!normalized.organizerSelf && normalized.organizerEmail
    && ownerEmails.size && !ownerEmails.has(normalized.organizerEmail)) {
    return ignore('we are not the organizer, so this is someone else\'s meeting');
  }
  // THE decisive check. Everything above only rules events out; this is what
  // rules one IN. A manual one-to-one meeting is structurally identical to a
  // booking, so without this the detector cannot tell them apart at all.
  if (!normalized.appointmentScheduleId) {
    return ignore('no appointment-schedule marker — not created through the booking page');
  }
  // Pin to ONE appointment schedule. Verified stable across the booking
  // lifecycle: rescheduling the real booking through Google's flow left
  // goo.createdByAvailId byte-identical (see the reschedule tests below), so it
  // is safe to treat as the schedule's durable identity.
  const configuredSchedule = String(options.appointmentScheduleId || '').trim();
  if (configuredSchedule) {
    if (normalized.appointmentScheduleId !== configuredSchedule) {
      return ignore('booking came from a different appointment schedule');
    }
  } else if (options.requireAppointmentScheduleId) {
    // Strict detection was demanded but nothing was configured. Refusing is the
    // only safe answer: silently accepting every schedule would be exactly the
    // weak behaviour the configuration exists to prevent.
    return ignore('strict detection requires a configured appointment schedule id, and none is set');
  }

  const booker = bookerAttendee(normalized, ownerEmails);
  if (!booker) {
    return ignore((normalized.attendees || []).length
      ? 'no single outside attendee could be identified'
      : 'no attendee, so there is nobody to match to a lead');
  }

  return {
    decision: BOOKING_DECISION.BOOKED,
    reason: 'appointment-schedule booking with one outside attendee',
    event: normalized,
    appointmentScheduleId: normalized.appointmentScheduleId,
    attendeeEmail: booker.email,
    attendeeName: booker.displayName,
    meetingAt: normalized.startAt,
  };
}

// ── IDENTITY ────────────────────────────────────────────────────────────────
/**
 * Attendee → CRM identity. Exact normalized email only: no name matching, no
 * company matching, no domain guessing. Ambiguity fails closed and is surfaced
 * for review rather than creating a lead.
 */
function matchBookingIdentity(attendeeEmail, { coldEmailLeads = [], boardLeads = [] } = {}) {
  const email = normalizeEmail(attendeeEmail);
  if (!email) return { status: 'unmatched', reason: 'the booking carried no attendee email' };

  const ceMatches = coldEmailLeads.filter(lead => normalizeEmail(lead.email) === email);
  const boardMatches = boardLeads.filter(lead => normalizeEmail(lead.email) === email);

  if (ceMatches.length > 1) {
    return { status: 'conflict', reason: `${ceMatches.length} Outreach leads share this address`, email };
  }
  if (boardMatches.length > 1) {
    return { status: 'conflict', reason: `${boardMatches.length} board records share this address`, email };
  }
  if (!ceMatches.length && !boardMatches.length) {
    // A real booking from someone we have never emailed. Never discarded, and
    // never turned into an invented lead — it goes to a human.
    return { status: 'unmatched', reason: 'no Outreach or board lead has this address', email };
  }
  return {
    status: 'matched', email,
    coldEmailLead: ceMatches[0] || null,
    boardLead: boardMatches[0] || null,
    matchedBy: 'attendee_email',
  };
}

// ── LIFECYCLE MAPPING ───────────────────────────────────────────────────────
/**
 * What should the CRM do about this provider event, given what it already knows?
 *
 * Maps onto the EXISTING Step 9 call lifecycle actions — book / reschedule /
 * cancel — and deliberately never produces `complete` or `no_show`: Google can
 * prove a meeting was scheduled and that time passed, but not that anyone
 * turned up. Those stay human decisions.
 *
 * @param classified  output of classifyCalendarEvent
 * @param current     { meetingAt, callStatus, processedEventIds }
 */
/**
 * Did this CRM previously record a booking for this provider event? Booking keys
 * are `gcal:<id>:<meetingAt>`; the cancellation key uses the `cancelled`
 * qualifier, so a prior BOOKING for the id is any other key with that prefix.
 */
function eventWasBooked(processedKeys, providerEventId) {
  const id = String(providerEventId || '');
  if (!id) return false;
  const prefix = `gcal:${id}:`;
  const cancelledKey = providerEventKey(id, 'cancelled');
  for (const key of processedKeys) {
    if (String(key).startsWith(prefix) && key !== cancelledKey) return true;
  }
  return false;
}

function bookingLifecycleAction(classified, current = {}) {
  const processed = current.processedEventIds instanceof Set
    ? current.processedEventIds : new Set(current.processedEventIds || []);
  const event = classified.event || {};
  const key = providerEventKey(event.providerEventId, classified.decision === BOOKING_DECISION.CANCELLED
    ? 'cancelled' : classified.meetingAt);

  if (classified.decision === BOOKING_DECISION.IGNORED) {
    return { action: null, reason: classified.reason, key };
  }

  // Already handled this exact provider state — a repeated sync is a no-op.
  if (processed.has(key)) return { action: null, reason: 'already processed', key, duplicate: true };

  if (classified.decision === BOOKING_DECISION.CANCELLED) {
    if (!current.meetingAt) return { action: null, reason: 'no booking on record to cancel', key };
    // Whether Google preserves the appointment marker on a cancelled event is
    // UNVERIFIED. The seven cancellations on the live calendar all lack it, but
    // none of them was ever an appointment-schedule booking (none carries
    // extendedProperties.shared at all), so they are not evidence either way.
    //
    // So we assume nothing about the cancelled payload. A cancellation is
    // validated against OUR OWN prior record, which works identically whether
    // Google keeps the marker or strips it.
    //
    // So we do not trust the event — we trust our own record. Cancel only an
    // event this CRM previously booked. Otherwise deleting an unrelated manual
    // meeting with someone who happens to have a real booking would wipe out
    // that booking.
    if (!eventWasBooked(processed, event.providerEventId)) {
      return { action: null, reason: 'this CRM never booked this event, so there is nothing of ours to cancel', key };
    }
    return { action: 'cancel', reason: 'the prospect cancelled through the booking page', key };
  }

  const meetingAt = classified.meetingAt;
  if (!current.meetingAt) return { action: 'book', meetingAt, reason: 'new booking', key };

  // Same instant means nothing meaningful changed — a title or description edit
  // must not masquerade as a reschedule.
  if (sameInstant(current.meetingAt, meetingAt)) {
    return { action: null, reason: 'the meeting time is unchanged', key, unchanged: true };
  }
  return { action: 'reschedule', meetingAt, previousMeetingAt: current.meetingAt, reason: 'the booking moved', key };
}

/** Compare two RFC3339 timestamps as instants, not as strings. */
function sameInstant(left, right) {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/** Stable per-provider-state key, so reprocessing cannot duplicate anything. */
function providerEventKey(providerEventId, qualifier) {
  return `gcal:${String(providerEventId || '')}:${String(qualifier || '')}`;
}

// ── SYNC STATE ──────────────────────────────────────────────────────────────
/**
 * Advance the stored sync checkpoint. The token is only ever taken from a
 * COMPLETED page walk: half a page processed must not look like a full sync, or
 * the unprocessed remainder is lost for good.
 */
function nextSyncState(previous = {}, result = {}) {
  if (!result.ok) {
    // A failure leaves the checkpoint exactly where it was, so the same window
    // is retried next run rather than skipped.
    return { ...previous, lastError: String(result.error || 'sync failed'), lastAttemptAt: result.at || null };
  }
  if (result.tokenInvalid) {
    // HTTP 410: the documented recovery is a full resync. Dropping the token is
    // safe because provider event keys make reprocessing a no-op.
    return { syncToken: null, needsFullSync: true, lastError: 'sync token expired (410) — full resync queued', lastAttemptAt: result.at || null };
  }
  if (!result.complete) {
    return { ...previous, lastError: null, lastAttemptAt: result.at || null };
  }
  return {
    syncToken: result.nextSyncToken || previous.syncToken || null,
    needsFullSync: false,
    lastError: null,
    lastAttemptAt: result.at || null,
    lastSyncAt: result.at || null,
  };
}

/**
 * Execute one incremental Calendar sync without owning any CRM business rules.
 * All I/O and mutations are injected by the server adapter, which keeps this
 * orchestration testable and ensures Google remains only an event source.
 *
 * A batch is checkpointed only after every item is safely handled. A failed
 * mutation therefore leaves the previous token untouched and replay retries the
 * same provider state. Provider/activity idempotency makes that replay safe.
 */
async function runGoogleCalendarSync(options = {}) {
  const {
    enabled = false, calendarId = '', appointmentScheduleId: scheduleId = '',
    readState, fetchChanges, loadContext, planBookings, applyPlan, writeState,
    logger = { info() {}, warn() {}, error() {} },
  } = options;

  if (!enabled) return { ok: true, skipped: true, reason: 'feature flag off', mutations: 0 };
  const missing = [];
  if (!String(calendarId || '').trim()) missing.push('GOOGLE_BOOKING_CALENDAR_ID');
  if (!String(scheduleId || '').trim()) missing.push('GOOGLE_BOOKING_APPOINTMENT_SCHEDULE_ID');
  if (missing.length) {
    return { ok: false, skipped: true, reason: `missing configuration: ${missing.join(', ')}`, missing, mutations: 0 };
  }

  for (const [name, fn] of Object.entries({ readState, fetchChanges, loadContext, planBookings, applyPlan, writeState })) {
    if (typeof fn !== 'function') throw new TypeError(`runGoogleCalendarSync requires ${name}()`);
  }

  const previous = await readState();
  let fetched = await fetchChanges({ syncToken: previous.needsFullSync ? null : previous.syncToken, calendarId });
  if (!fetched.ok) {
    logger.error?.(`[Calendar sync] fetch failed: ${fetched.error || 'unknown error'}`);
    return { ok: false, reason: fetched.error || 'calendar fetch failed', mutations: 0, checkpointAdvanced: false };
  }
  // Google documents 410 as "discard the token and perform a full sync". Do
  // that in this run, but do not persist the cleared token unless the full walk
  // and every resulting mutation both succeed.
  if (fetched.tokenInvalid) {
    fetched = await fetchChanges({ syncToken: null, calendarId });
    if (!fetched.ok || fetched.tokenInvalid) {
      return { ok: false, reason: fetched.error || 'full resync after 410 failed', mutations: 0, checkpointAdvanced: false };
    }
  }

  const context = await loadContext();
  const plans = await planBookings(fetched.events || [], context);
  let mutations = 0;
  const review = [];
  const handled = [];
  try {
    for (const item of plans) {
      const eventId = item.classified?.event?.providerEventId || '';
      if (item.outcome === 'unmatched' || item.outcome === 'conflict') {
        review.push({ providerEventId: eventId, outcome: item.outcome, reason: item.reason });
        logger.warn?.(`[Calendar sync] ${eventId || 'unknown event'}: ${item.outcome} — ${item.reason || 'review required'}`);
        handled.push({ providerEventId: eventId, outcome: item.outcome });
        continue;
      }
      if (!item.action) {
        handled.push({ providerEventId: eventId, outcome: item.outcome || 'no_action' });
        continue;
      }
      const result = await applyPlan(item, context);
      if (!result || result.ok !== true) {
        throw new Error(result?.error || `canonical ${item.action} mutation failed`);
      }
      mutations += result.changed === false ? 0 : 1;
      handled.push({ providerEventId: eventId, action: item.action, leadId: result.leadId || item.boardLead?.id || '', changed: result.changed !== false });
      logger.info?.(`[Calendar sync] ${eventId}: ${item.action} -> ${result.leadId || item.boardLead?.id || 'matched lead'}`);
    }
  } catch (error) {
    logger.error?.(`[Calendar sync] batch failed; checkpoint retained: ${error.message}`);
    return { ok: false, reason: error.message, mutations, review, handled, checkpointAdvanced: false };
  }

  const completed = { ...fetched, ok: true, complete: true };
  const next = nextSyncState(previous, completed);
  await writeState(next);
  return { ok: true, mutations, review, handled, checkpointAdvanced: true, syncToken: next.syncToken || null };
}

module.exports = {
  PROVIDER, BOOKING_DECISION, IGNORED_EVENT_TYPES, eventWasBooked,
  APPOINTMENT_SCHEDULE_PROPERTY, APPOINTMENT_CREATED_BY_SET, appointmentScheduleId,
  normalizeCalendarEvent, bookerAttendee, classifyCalendarEvent,
  matchBookingIdentity, bookingLifecycleAction, providerEventKey,
  sameInstant, nextSyncState, runGoogleCalendarSync,
};
