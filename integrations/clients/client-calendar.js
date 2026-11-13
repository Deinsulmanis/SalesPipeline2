'use strict';

/**
 * client-calendar.js — a managed client's own Google Calendar as the source of
 * its booked meetings, written into that client's meeting ledger.
 * ─────────────────────────────────────────────────────────────────────────────
 * ScaleLab's booking sync (integrations/google-calendar.js) feeds ScaleLab's
 * board and call lifecycle. This is the managed-client counterpart: it reads
 * the client's calendar (Jole: Jorge's) READ-ONLY and records meetings in the
 * client ledger, which is what the client's Bookings view already shows.
 *
 * WHAT COUNTS
 *   An event counts only when an attendee's address is EXACTLY the email of one
 *   of this client's leads. Every other event — Jorge's internal meetings,
 *   personal appointments — is ignored and never stored or shown.
 *
 *   - Booked through the client's Google booking page (the appointment-schedule
 *     stamp Google puts on the event) and matching one lead → recorded as
 *     BOOKED automatically.
 *   - Anything else that matches a lead — an event Jorge created by hand, an
 *     invite the prospect sent, two leads on one invite, a lead who already has
 *     a meeting at another time — is held for review. An operator confirms or
 *     dismisses it in the Bookings view. Nothing is guessed into the ledger.
 *
 *   Once an event is linked to a ledger meeting, later calendar changes follow
 *   it: a moved event reschedules the meeting, a cancelled event cancels it. A
 *   meeting that has already been held is never changed by the calendar.
 *
 * Planning is pure. The service at the bottom does the I/O through injected
 * functions, so the whole flow runs in tests without Google, Sheets or Supabase.
 */

const { normalizeCalendarEvent, sameInstant, nextSyncState, IGNORED_EVENT_TYPES } = require('../google-calendar');
const { getClient, resolveClientId } = require('./registry');
const { leadsForClient } = require('./ownership');
const ledger = require('./ledger');

const SOURCE = 'google_calendar';
const ACTIVE = new Set([ledger.MEETING_STATUS.BOOKED, ledger.MEETING_STATUS.RESCHEDULED]);
const RESCHEDULABLE = new Set([...ACTIVE, ledger.MEETING_STATUS.CANCELLED, ledger.MEETING_STATUS.NO_SHOW]);
const FINAL = new Set([ledger.MEETING_STATUS.HELD, ledger.MEETING_STATUS.QUALIFIED_HELD, ledger.MEETING_STATUS.DISQUALIFIED_HELD]);
// Bounded so the state stays one small checkpoint cell.
const MAX_REVIEW_ITEMS = 100;
const PRUNE_AFTER_MS = 45 * 86400000;

const text = value => String(value == null ? '' : value).trim();
const norm = value => text(value).toLowerCase();
const domainOf = email => (norm(email).split('@')[1] || '');
const isResource = email => /@resource\.calendar\.google\.com$|@group\.calendar\.google\.com$/.test(norm(email));

// ── CONFIGURATION ───────────────────────────────────────────────────────────

/**
 * The calendar settings a client declares (`booking.calendarSync`), resolved
 * against the environment. Returns a reason instead of a bare false: a silently
 * inert sync is exactly the failure that hides a misconfiguration.
 */
function clientCalendarConfig(clientId, env = process.env) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) return { supported: false, ready: false, reason: resolved.reason };
  const client = getClient(resolved.clientId);
  const spec = client.booking?.calendarSync;
  if (!spec) return { supported: false, ready: false, clientId: client.id, reason: `${client.displayName} has no calendar sync` };
  const calendarId = text(env[spec.calendarIdEnv]);
  const enabled = text(env[spec.enabledEnv]) === 'true';
  const scheduleId = text(env[spec.scheduleIdEnv]);
  const ownerEmails = [calendarId, ...text(env[spec.ownerEmailsEnv]).split(',')].map(norm).filter(Boolean);
  const missing = calendarId ? [] : [spec.calendarIdEnv];
  return {
    supported: true, clientId: client.id, displayName: client.displayName, meetingWith: client.booking.meetingWith || '',
    enabled, calendarId, scheduleId, schedulePinned: Boolean(scheduleId),
    ownerEmails: [...new Set(ownerEmails)],
    // Everyone on the calendar owner's own domain is staff, never a prospect.
    ownDomains: [...new Set(ownerEmails.map(domainOf).filter(Boolean))],
    missing, configured: missing.length === 0, ready: enabled && missing.length === 0,
    env: { enabled: spec.enabledEnv, calendarId: spec.calendarIdEnv, scheduleId: spec.scheduleIdEnv, ownerEmails: spec.ownerEmailsEnv },
    reason: missing.length ? `calendar sync is not configured: ${missing.join(', ')} not set`
      : (enabled ? 'ready' : `${spec.enabledEnv} is off`),
  };
}

// ── CLASSIFICATION (pure) ───────────────────────────────────────────────────

/**
 * What one provider event is, before any lead is consulted.
 * kind: 'cancelled' | 'ignored' | 'candidate'
 */
function classifyClientEvent(raw = {}, { ownerEmails = [], ownDomains = [], scheduleId = '' } = {}) {
  const event = normalizeCalendarEvent(raw);
  event.createdAt = text(raw.created);
  event.htmlLink = text(raw.htmlLink);
  const ignore = reason => ({ kind: 'ignored', reason, event, outside: [] });
  if (!event.providerEventId) return ignore('event has no provider id');
  if (event.status === 'cancelled') return { kind: 'cancelled', reason: 'the event was cancelled or deleted', event, outside: [] };
  if (IGNORED_EVENT_TYPES.includes(event.eventType)) return ignore(`eventType "${event.eventType}" is never a meeting`);
  if (event.isAllDay || !event.startAt) return ignore('not a timed event');
  if (event.recurringEventId) return ignore('part of a recurring series');

  const owners = new Set(ownerEmails.map(norm));
  const domains = new Set(ownDomains.map(norm));
  const people = [...event.attendees];
  // A prospect who sends the invite is the organizer, not an attendee row.
  if (event.organizerEmail && !people.some(a => a.email === event.organizerEmail)) {
    people.push({ email: event.organizerEmail, self: event.organizerSelf, organizer: true, responseStatus: 'accepted', displayName: '' });
  }
  const seen = new Set();
  const outside = people.filter(a => {
    if (!a.email || a.self || owners.has(a.email) || domains.has(domainOf(a.email)) || isResource(a.email) || seen.has(a.email)) return false;
    seen.add(a.email);
    return true;
  });
  if (!outside.length) return ignore('no outside attendee');

  const viaBookingPage = Boolean(event.appointmentScheduleId);
  const scheduleMatches = viaBookingPage && (!scheduleId || event.appointmentScheduleId === scheduleId);
  return { kind: 'candidate', reason: '', event, outside, viaBookingPage, scheduleMatches };
}

// ── PLANNING (pure) ─────────────────────────────────────────────────────────

function leadSummary(lead, email) {
  return { leadId: text(lead.id), email: norm(email || lead.email), name: text(lead.contactName), company: text(lead.company) };
}

function reviewItem(classified, candidates, reason, { now, previous } = {}) {
  const event = classified.event;
  return {
    eventId: event.providerEventId,
    summary: event.summary.slice(0, 140),
    startAt: event.startAt, endAt: event.endAt, createdAt: event.createdAt, htmlLink: event.htmlLink,
    viaBookingPage: Boolean(classified.viaBookingPage),
    candidates, reason,
    firstSeenAt: previous?.firstSeenAt || now,
    updatedAt: now,
  };
}

/**
 * Decide what one event means for the client ledger. Returns
 *   { action, reason, ... }  where action is one of
 *   record | link | reschedule | cancel | review | clear_review | none
 *
 * @param ctx { leads (this client's only), meetings (this client's ledger),
 *              state { links, review }, config, now }
 */
function planClientEvent(raw, ctx) {
  const { leads = [], meetings = [], state = {}, config = {}, now = new Date().toISOString() } = ctx;
  const links = state.links || {};
  const review = state.review || {};
  const classified = classifyClientEvent(raw, config);
  const event = classified.event;
  const eventId = event.providerEventId;
  const base = { eventId, classified };
  const inReview = Boolean(eventId && review[eventId]);
  const meetingById = new Map(meetings.map(row => [row.meeting_id, row]));

  // 1. An event already linked to a ledger meeting: follow it.
  if (eventId && links[eventId]) {
    const meeting = meetingById.get(links[eventId]);
    if (!meeting) return { ...base, action: 'none', reason: 'linked meeting is no longer in the ledger' };
    if (FINAL.has(meeting.meeting_status)) return { ...base, action: 'none', meetingId: meeting.meeting_id, reason: 'meeting already held; calendar changes no longer apply' };
    if (classified.kind === 'cancelled') {
      return ACTIVE.has(meeting.meeting_status)
        ? { ...base, action: 'cancel', meetingId: meeting.meeting_id, reason: 'the calendar event was cancelled' }
        : { ...base, action: 'none', meetingId: meeting.meeting_id, reason: `meeting is already ${meeting.meeting_status}` };
    }
    if (classified.kind === 'ignored') return { ...base, action: 'none', meetingId: meeting.meeting_id, reason: classified.reason };
    if (sameInstant(meeting.scheduled_for, event.startAt) && meeting.meeting_status !== ledger.MEETING_STATUS.CANCELLED) {
      return { ...base, action: 'none', meetingId: meeting.meeting_id, reason: 'no change' };
    }
    if (!RESCHEDULABLE.has(meeting.meeting_status)) return { ...base, action: 'none', meetingId: meeting.meeting_id, reason: `a ${meeting.meeting_status} meeting cannot be rescheduled` };
    return { ...base, action: 'reschedule', meetingId: meeting.meeting_id, scheduledFor: event.startAt, previousScheduledFor: meeting.scheduled_for, reason: 'the calendar event moved' };
  }

  // 2. Not linked. An operator already said this event is not a lead meeting.
  if (eventId && state.dismissed?.[eventId]) return { ...base, action: 'none', reason: 'dismissed by an operator' };

  // 3. Anything that is not a live lead meeting clears review.
  const clear = reason => (inReview ? { ...base, action: 'clear_review', reason } : { ...base, action: 'none', reason });
  if (classified.kind !== 'candidate') return clear(classified.reason);

  const byEmail = new Map();
  for (const lead of leads) {
    const email = norm(lead.email);
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(lead);
  }
  const matches = [];
  for (const attendee of classified.outside) {
    for (const lead of byEmail.get(attendee.email) || []) matches.push({ lead, attendee });
  }
  // Deliberately no detail: an event with no lead on it is someone's private
  // calendar entry and is neither stored nor described.
  if (!matches.length) return clear('no attendee is a lead of this client');

  const candidates = matches.map(({ lead, attendee }) => leadSummary(lead, attendee.email));
  const toReview = reason => ({ ...base, action: 'review', reason, item: reviewItem(classified, candidates, reason, { now, previous: review[eventId] }) });
  if (matches.length > 1) {
    const sameEmail = new Set(candidates.map(c => c.email)).size === 1;
    return toReview(sameEmail ? 'this address belongs to more than one lead' : 'more than one lead is on this event');
  }

  const { lead, attendee } = matches[0];
  const linkedMeetingIds = new Set(Object.values(links));
  const leadMeetings = meetings.filter(row => String(row.lead_id) === String(lead.id));
  const active = leadMeetings.filter(row => ACTIVE.has(row.meeting_status));
  const sameTime = active.find(row => sameInstant(row.scheduled_for, event.startAt) && !linkedMeetingIds.has(row.meeting_id));
  if (sameTime) return { ...base, action: 'link', meetingId: sameTime.meeting_id, lead, reason: 'the ledger already has this meeting' };
  if (active.length) {
    const when = active[0].scheduled_for || 'an unscheduled time';
    return toReview(`this lead already has a ${active[0].meeting_status.toLowerCase()} meeting (${when})`);
  }
  if (classified.viaBookingPage && !classified.scheduleMatches) return toReview('booked through a different booking page');
  if (!classified.viaBookingPage) return toReview('added to the calendar by hand or sent as an invite, not booked through the booking page');
  return {
    ...base, action: 'record', lead, attendee,
    bookedAt: event.createdAt || event.updatedAt || now, scheduledFor: event.startAt,
    reason: 'booked through the booking page by a lead',
  };
}

/** The next state after one handled plan. Pure. */
function applyPlanToState(state, plan, { meetingId } = {}) {
  const next = { ...state, links: { ...(state.links || {}) }, review: { ...(state.review || {}) } };
  const id = plan.eventId;
  if (!id) return next;
  if (['record', 'link'].includes(plan.action) && (meetingId || plan.meetingId)) {
    next.links[id] = meetingId || plan.meetingId;
    delete next.review[id];
  }
  if (plan.action === 'review') next.review[id] = plan.item;
  if (plan.action === 'clear_review') delete next.review[id];
  return next;
}

/** Drop review items and finished links that can no longer matter. Pure. */
function pruneState(state, meetings = null, now = new Date().toISOString()) {
  const cutoff = Date.parse(now) - PRUNE_AFTER_MS;
  const byId = new Map(meetings.map(row => [row.meeting_id, row]));
  let links = { ...(state.links || {}) };
  // Without a readable ledger nothing is known about the meetings: keep every link.
  if (Array.isArray(meetings)) {
    links = {};
    for (const [eventId, meetingId] of Object.entries(state.links || {})) {
      const meeting = byId.get(meetingId);
      const old = meeting && Date.parse(meeting.scheduled_for || 0) < cutoff;
      if (meeting && !(old && FINAL.has(meeting.meeting_status))) links[eventId] = meetingId;
    }
  }
  const dismissed = Object.fromEntries(Object.entries(state.dismissed || {})
    .filter(([, row]) => Date.parse(row?.at || 0) >= cutoff)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, MAX_REVIEW_ITEMS * 2));
  const review = Object.values(state.review || {})
    .filter(item => !item.startAt || Date.parse(item.startAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, MAX_REVIEW_ITEMS);
  return { ...state, links, dismissed, review: Object.fromEntries(review.map(item => [item.eventId, item])) };
}

// ── SERVICE (I/O through injected functions) ────────────────────────────────

/**
 * @param deps {
 *   clientId, env,
 *   fetchChanges({ syncToken, calendarId }) → { ok, events, nextSyncToken, tokenInvalid, error },
 *   readState() → state object ({} when none), writeState(state),
 *   loadLeads() → all dataset leads (scoped here), getStore() → ledger store,
 *   now(), log }
 */
function createClientCalendarSync(deps) {
  const {
    clientId, env = process.env, fetchChanges, readState, writeState, loadLeads, getStore,
    now = () => new Date().toISOString(), log = console,
  } = deps;
  let chain = Promise.resolve();
  // Sync, confirm and dismiss all read-modify-write one checkpoint: serialise.
  const exclusive = task => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  const config = () => clientCalendarConfig(clientId, env);
  const store = () => {
    const s = getStore();
    if (!s?.enabled) throw Object.assign(new Error(`client ledger is disabled: ${s?.reason || ''}`.trim()), { code: 'ledger_unavailable' });
    return s;
  };

  async function context(cfg) {
    const s = store();
    const [allLeads, meetings] = await Promise.all([loadLeads(), s.listMeetings(cfg.clientId)]);
    return { store: s, leads: leadsForClient(allLeads || [], cfg.clientId), meetings: meetings || [] };
  }

  const noteFor = (eventId, how) => `Google Calendar event ${eventId} — ${how}.`;

  async function recordMeeting(s, cfg, { lead, attendee, bookedAt, scheduledFor, eventId, how, by }) {
    const meetingId = ledger.ids.meeting(cfg.clientId, lead.id, bookedAt);
    const existing = await s.getMeeting(cfg.clientId, meetingId);
    if (existing) return { meetingId, changed: false };
    const meeting = await ledger.recordMeetingBooked(s, {
      clientId: cfg.clientId, lead, bookedAt, scheduledFor,
      attendee: { attendee_name: attendee?.displayName || lead.contactName || '', attendee_email: attendee?.email || lead.email || '' },
      notes: noteFor(eventId, how), by,
    });
    return { meetingId: meeting.meeting_id, changed: true };
  }

  async function apply(s, cfg, plan, by = SOURCE) {
    if (plan.action === 'record') {
      return recordMeeting(s, cfg, { ...plan, how: 'booked through the booking page', by });
    }
    if (plan.action === 'reschedule') {
      await ledger.updateMeeting(s, { clientId: cfg.clientId, meetingId: plan.meetingId, toStatus: 'RESCHEDULED', patch: { scheduled_for: plan.scheduledFor }, by });
      return { meetingId: plan.meetingId, changed: true };
    }
    if (plan.action === 'cancel') {
      await ledger.updateMeeting(s, { clientId: cfg.clientId, meetingId: plan.meetingId, toStatus: 'CANCELLED', patch: { cancelled_at: plan.classified.event.updatedAt || undefined }, by });
      return { meetingId: plan.meetingId, changed: true };
    }
    return { meetingId: plan.meetingId || '', changed: false };
  }

  const describe = plan => ({
    eventId: plan.eventId, action: plan.action, reason: plan.reason,
    meetingId: plan.meetingId || null, leadId: plan.lead ? text(plan.lead.id) : null,
    scheduledFor: plan.scheduledFor || plan.classified?.event?.startAt || null,
  });

  async function fetchAll(state, cfg) {
    let fetched = await fetchChanges({ syncToken: state.needsFullSync ? null : state.syncToken || null, calendarId: cfg.calendarId });
    if (fetched.ok && fetched.tokenInvalid) fetched = await fetchChanges({ syncToken: null, calendarId: cfg.calendarId });
    return fetched;
  }

  /** One sync pass. apply=false is a dry run: nothing is written, not even the checkpoint. */
  function run({ apply: write = true, force = false } = {}) {
    return exclusive(async () => {
      const cfg = config();
      if (!cfg.supported) return { ok: false, skipped: true, reason: cfg.reason };
      if (write && !cfg.enabled && !force) return { ok: true, skipped: true, reason: cfg.reason };
      if (!cfg.configured) return { ok: false, skipped: true, reason: cfg.reason, missing: cfg.missing };
      const previous = (await readState()) || {};
      const fetched = await fetchAll(previous, cfg);
      if (!fetched.ok || fetched.tokenInvalid) {
        const reason = fetched.error || 'calendar fetch failed';
        log.error?.(`[Client calendar:${cfg.clientId}] fetch failed: ${reason}`);
        if (write && previous.lastError !== reason) {
          await writeState(nextSyncState(previous, { ok: false, error: reason, at: now() })).catch(() => {});
        }
        return { ok: false, reason, mutations: 0, checkpointAdvanced: false };
      }
      const events = fetched.events || [];
      let state = { links: {}, review: {}, ...previous };
      const handled = [];
      let mutations = 0;
      let ctx = null;
      if (events.length) {
        ctx = await context(cfg);
        try {
          for (const raw of events) {
            const plan = planClientEvent(raw, { ...ctx, state, config: cfg, now: now() });
            if (write) {
              const result = await apply(ctx.store, cfg, plan);
              if (result.changed) {
                mutations += 1;
                ctx.meetings = await ctx.store.listMeetings(cfg.clientId);
                log.info?.(`[Client calendar:${cfg.clientId}] ${plan.eventId}: ${plan.action} -> ${result.meetingId}`);
              }
              state = applyPlanToState(state, plan, result);
            } else {
              state = applyPlanToState(state, plan, { meetingId: plan.meetingId || (plan.action === 'record' ? `(would record for ${plan.lead.id})` : '') });
            }
            if (plan.action !== 'none' || write === false) handled.push(describe(plan));
          }
        } catch (error) {
          log.error?.(`[Client calendar:${cfg.clientId}] batch failed; checkpoint retained: ${error.message}`);
          return { ok: false, reason: error.message, mutations, handled, checkpointAdvanced: false };
        }
      }
      if (!write) {
        return { ok: true, dryRun: true, events: events.length, handled, counts: countBy(handled), tokenInvalid: Boolean(fetched.tokenInvalid) };
      }
      const checkpoint = nextSyncState(previous, { ...fetched, ok: true, complete: true, at: now() });
      state = pruneState({ ...state, ...checkpoint }, ctx ? ctx.meetings : await safeMeetings(cfg), now());
      if (JSON.stringify(stableState(state)) !== JSON.stringify(stableState(previous)) || events.length) await writeState(state);
      return { ok: true, events: events.length, mutations, handled, review: Object.keys(state.review).length, checkpointAdvanced: true };
    });
  }

  async function safeMeetings(cfg) {
    try { return await store().listMeetings(cfg.clientId); } catch (_) { return null; }
  }

  /** Status and the review queue, for the Bookings view. Reads state only. */
  async function status() {
    const cfg = config();
    const state = cfg.supported ? ((await readState()) || {}) : {};
    const review = Object.values(state.review || {}).sort((a, b) => Date.parse(a.startAt || 0) - Date.parse(b.startAt || 0));
    return {
      clientId: cfg.clientId || clientId, supported: cfg.supported, enabled: Boolean(cfg.enabled), configured: Boolean(cfg.configured),
      ready: Boolean(cfg.ready), reason: cfg.reason, calendarId: cfg.calendarId || '', meetingWith: cfg.meetingWith || '',
      schedulePinned: Boolean(cfg.schedulePinned), lastSyncAt: state.lastSyncAt || null, lastError: state.lastError || null,
      linkedEvents: Object.keys(state.links || {}).length, review,
    };
  }

  /** Operator confirms a review item: it becomes (or links to) a ledger meeting. */
  function confirm(eventId, { leadId = '', by = 'operator' } = {}) {
    return exclusive(async () => {
      const cfg = config();
      if (!cfg.supported) throw Object.assign(new Error(cfg.reason), { code: 'calendar_not_supported' });
      const state = (await readState()) || {};
      const item = state.review?.[eventId];
      if (!item) throw Object.assign(new Error(`calendar event ${eventId} is not waiting for review`), { code: 'review_item_not_found' });
      const ids = [...new Set(item.candidates.map(c => c.leadId))];
      const chosen = text(leadId) || (ids.length === 1 ? ids[0] : '');
      if (!chosen) throw Object.assign(new Error('more than one lead is on this event; choose which lead the meeting is with'), { code: 'lead_choice_required' });
      if (!ids.includes(chosen)) throw Object.assign(new Error(`lead ${chosen} is not on this calendar event`), { code: 'lead_not_on_event' });
      if (!item.startAt) throw Object.assign(new Error('the calendar event has no start time'), { code: 'scheduled_for_required' });
      const ctx = await context(cfg);
      const lead = ctx.leads.find(row => String(row.id) === chosen);
      if (!lead) throw Object.assign(new Error(`lead ${chosen} does not belong to ${cfg.displayName}`), { code: 'client_isolation_violation' });
      const candidate = item.candidates.find(c => c.leadId === chosen);
      const active = ctx.meetings.find(row => String(row.lead_id) === chosen && ACTIVE.has(row.meeting_status)
        && !Object.values(state.links || {}).includes(row.meeting_id));
      let result;
      if (active) {
        // The lead's open meeting IS this event: link it and take the calendar's time.
        if (!sameInstant(active.scheduled_for, item.startAt)) {
          await ledger.updateMeeting(ctx.store, { clientId: cfg.clientId, meetingId: active.meeting_id, toStatus: 'RESCHEDULED', patch: { scheduled_for: item.startAt }, by });
        }
        result = { meetingId: active.meeting_id, changed: true, linked: true };
      } else {
        result = await recordMeeting(ctx.store, cfg, {
          lead, attendee: { email: candidate?.email, displayName: candidate?.name }, eventId,
          bookedAt: item.createdAt || now(), scheduledFor: item.startAt, how: `confirmed from the calendar by ${by}`, by,
        });
      }
      const next = applyPlanToState(state, { eventId, action: 'link', meetingId: result.meetingId });
      await writeState(next);
      return { ok: true, eventId, ...result };
    });
  }

  /** Operator says a review item is not a lead meeting. It never comes back for this event. */
  function dismiss(eventId, { by = 'operator' } = {}) {
    return exclusive(async () => {
      const state = (await readState()) || {};
      if (!state.review?.[eventId]) throw Object.assign(new Error(`calendar event ${eventId} is not waiting for review`), { code: 'review_item_not_found' });
      const next = applyPlanToState(state, { eventId, action: 'clear_review' });
      next.dismissed = { ...(state.dismissed || {}), [eventId]: { by, at: now() } };
      await writeState(next);
      return { ok: true, eventId, dismissed: true };
    });
  }

  return { config, run, status, confirm, dismiss };
}

function stableState(state = {}) {
  const { lastSyncAt, lastAttemptAt, ...rest } = state;
  return rest;
}

function countBy(rows) {
  return rows.reduce((acc, row) => ({ ...acc, [row.action]: (acc[row.action] || 0) + 1 }), {});
}

module.exports = {
  SOURCE, MAX_REVIEW_ITEMS,
  clientCalendarConfig, classifyClientEvent, planClientEvent, applyPlanToState, pruneState,
  createClientCalendarSync,
};
