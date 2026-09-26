'use strict';

/**
 * Staffing Landing Funnel: the read model behind the dashboard workspace.
 *
 * Every behavioural judgement is made in SQL: tier timestamps come from
 * landing_refresh_session, per-session flags from landing_session_facts, and
 * booking labels from landing_booking_attribution. This module only filters
 * and counts those rows.
 *
 * Grains are kept apart. Links, leads and sessions are different
 * denominators, and every rate carries its grain.
 *
 * Nothing sensitive can leave: every query names its columns, and none of them
 * is a token, token hash, action id, IP address, user agent or cookie. Lead
 * details (company, contact, email) are fetched only for the leads on screen,
 * never for the whole outreach corpus.
 */

const { mirrorConfig } = require('./supabase-mirror');
const { FLAG, flagEnabled, testEmailDomains } = require('./landing-attribution-config');

const RANGE_DAYS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90 });
const SOURCES = Object.freeze(['followup_2', 'positive_reply']);
const ASSIST_LABELS = Object.freeze(['page_assisted', 'visited_before_booking', 'link_sent_no_visit', 'no_link_issued']);
const ASSISTED = new Set(['page_assisted', 'visited_before_booking']);
const TIERS = Object.freeze(['intent', 'interacted', 'engaged', 'visible', 'raw']);
const MAX_CUSTOM_DAYS = 400;
const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;
const ID_CHUNK = 80;
const LEAD_ROWS = 250;
const BOOKING_ROWS = 100;
const TIMEOUT_MS = 8000;

const ISSUANCE_COLUMNS = 'issuance_id,lead_id,source,trigger_action,campaign_id,campaign_version,template_id,template_version,sender_inbox_id,is_test,status,sent_at';
const SESSION_COLUMNS = 'issuance_id,started_at,last_seen_at,visible_at,engaged_at,interacted_at,intent_at,is_internal,is_debug,webdriver,ua_headless,ua_declared_bot,seconds_after_send,visible_ms,video_playing,video_25,video_50,video_75,video_complete,meeting_section_visible,booking_cta_click,booking_dialog_open,scroll_jump';
const BOOKING_COLUMNS = 'lead_id,booked_at,meeting_at,attributed_issuance_id,attributed_source,assist_label';
const LEAD_COLUMNS = 'lead_id,company,contact_name,email';
const MONITOR_COLUMNS = 'is_internal,is_debug,resolution';

const DIMENSION = /^[A-Za-z0-9._:@ -]{1,160}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const truthy = value => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
const dimension = value => (DIMENSION.test(String(value || '')) ? String(value) : '');

// Minutes to add to UTC to get Vancouver wall time at this instant (−420 or −480).
function vancouverOffsetMs(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Vancouver', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a Vancouver calendar day starts. */
function vancouverMidnight(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Two passes: the offset at noon can differ from the offset at midnight on DST days.
  const guess = utcMidnight - vancouverOffsetMs(new Date(utcMidnight + 12 * 3600 * 1000));
  return new Date(utcMidnight - vancouverOffsetMs(new Date(guess)));
}

/** Query string → validated filters. Anything unexpected falls back to the default. */
function parseFunnelFilters(query = {}, now = new Date()) {
  let range = Object.hasOwn(RANGE_DAYS, query.range) || query.range === 'custom' ? query.range : '30d';
  let from;
  let to;
  if (range === 'custom') {
    const fromDay = String(query.from || '');
    const toDay = String(query.to || '');
    if (DATE.test(fromDay) && DATE.test(toDay)) {
      from = vancouverMidnight(fromDay);
      const end = vancouverMidnight(toDay);
      to = new Date(vancouverMidnight(new Date(end.getTime() + 36 * 3600 * 1000).toISOString().slice(0, 10)));
      const days = (to - from) / 86400000;
      if (!(days > 0) || days > MAX_CUSTOM_DAYS || Number.isNaN(from.getTime())) range = '30d';
    } else {
      range = '30d';
    }
  }
  if (range !== 'custom') {
    to = new Date(now.getTime());
    from = new Date(now.getTime() - RANGE_DAYS[range] * 86400000);
  }
  return {
    range, from: from.toISOString(), to: to.toISOString(),
    fromDay: range === 'custom' ? String(query.from) : '', toDay: range === 'custom' ? String(query.to) : '',
    source: SOURCES.includes(query.source) ? query.source : '',
    campaign: dimension(query.campaign), sender: dimension(query.sender), template: dimension(query.template),
    includeTest: truthy(query.includeTest), includeInternal: truthy(query.includeInternal),
  };
}

const rate = (key, label, numerator, denominator, grain) => ({
  key, label, numerator, denominator, grain, value: denominator ? numerator / denominator : null,
});
const intersectionSize = (a, b) => [...a].filter(value => b.has(value)).length;
const tierOf = session => (session.intent_at ? 'intent' : session.interacted_at ? 'interacted'
  : session.engaged_at ? 'engaged' : session.visible_at ? 'visible' : 'raw');
const videoOf = session => (session.video_complete ? 'complete' : session.video_75 ? '75' : session.video_50 ? '50'
  : session.video_25 ? '25' : session.video_playing ? 'playing' : null);
const VIDEO_RANK = { playing: 1, 25: 2, 50: 3, 75: 4, complete: 5 };
const TIER_RANK = { none: 0, raw: 1, visible: 2, engaged: 3, interacted: 4, intent: 5 };
const later = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

/**
 * Pure aggregation over rows already fetched.
 * issuances: links SENT in the period (test links already dropped unless includeTest).
 * sessions:  sessions of those links (internal and debug already dropped; dropped again here).
 * bookings:  landing_booking_attribution rows booked on or after the period start.
 */
function buildStaffingFunnel({ filters, issuances = [], sessions = [], bookings = [], leads = [], monitor = null, env = process.env, now = new Date(), truncated = false }) {
  const testDomains = testEmailDomains(env);
  const leadInfo = new Map(leads.map(lead => [lead.lead_id, lead]));
  const isTestLead = id => {
    const domain = String(leadInfo.get(id)?.email || '').toLowerCase().split('@')[1] || '';
    return Boolean(domain) && testDomains.includes(domain);
  };

  const distinct = key => [...new Set(issuances.map(row => row[key]).filter(Boolean))].sort();
  const options = {
    sources: SOURCES.filter(source => issuances.some(row => row.source === source)),
    campaigns: distinct('campaign_id'), senders: distinct('sender_inbox_id'), templates: distinct('template_version'),
  };

  const links = issuances.filter(row => (!filters.source || row.source === filters.source)
    && (!filters.campaign || row.campaign_id === filters.campaign)
    && (!filters.sender || row.sender_inbox_id === filters.sender)
    && (!filters.template || row.template_version === filters.template)
    && (filters.includeTest || !row.is_test));
  const linkById = new Map(links.map(row => [row.issuance_id, row]));
  const scopedSessions = sessions.filter(row => linkById.has(row.issuance_id) && !row.is_internal && !row.is_debug);
  const cohortBookings = bookings.filter(row => row.attributed_issuance_id && linkById.has(row.attributed_issuance_id));

  function summarize(linkRows, sessionRows, bookingRows) {
    const byLink = new Map();
    for (const session of sessionRows) {
      if (!byLink.has(session.issuance_id)) byLink.set(session.issuance_id, []);
      byLink.get(session.issuance_id).push(session);
    }
    const count = test => sessionRows.filter(test).length;
    const leadOf = session => linkById.get(session.issuance_id)?.lead_id;
    const leadsWhere = test => new Set(sessionRows.filter(test).map(leadOf));
    const leadsReached = new Set(linkRows.map(row => row.lead_id));
    const engagedLeads = leadsWhere(row => row.engaged_at);
    const ctaLeads = leadsWhere(row => row.booking_cta_click);
    const assisted = bookingRows.filter(row => ASSISTED.has(row.assist_label));
    const assistedLeads = new Set(assisted.map(row => row.lead_id));
    const pageAssistedLeads = new Set(bookingRows.filter(row => row.assist_label === 'page_assisted').map(row => row.lead_id));
    const bookedLeads = new Set(bookingRows.map(row => row.lead_id));
    const linksWithVisit = linkRows.filter(row => (byLink.get(row.issuance_id) || []).length > 0).length;
    const linksEngaged = linkRows.filter(row => (byLink.get(row.issuance_id) || []).some(session => session.engaged_at)).length;
    const counts = {
      linksSent: linkRows.length, leadsReached: leadsReached.size,
      rawSessions: sessionRows.length, visibleSessions: count(row => row.visible_at), engagedSessions: count(row => row.engaged_at),
      interactedSessions: count(row => row.interacted_at), intentSessions: count(row => row.intent_at),
      videoPlays: count(row => row.video_playing), video25: count(row => row.video_25), video50: count(row => row.video_50),
      video75: count(row => row.video_75), videoCompletes: count(row => row.video_complete),
      meetingSectionViews: count(row => row.meeting_section_visible),
      bookingCtaClicks: count(row => row.booking_cta_click), bookingDialogsOpened: count(row => row.booking_dialog_open),
      assistedBookings: assisted.length,
      bookingsByLabel: Object.fromEntries(ASSIST_LABELS.map(label => [label, bookingRows.filter(row => row.assist_label === label).length])),
      linksWithVisit, linksEngaged, leadsEngaged: engagedLeads.size, leadsBooked: bookedLeads.size,
    };
    const rates = [
      rate('link_to_visit', 'Links sent → link opened', linksWithVisit, linkRows.length, 'links'),
      rate('link_to_engaged', 'Links sent → link with an engaged session', linksEngaged, linkRows.length, 'links'),
      rate('raw_to_engaged', 'Raw sessions → engaged', counts.engagedSessions, counts.rawSessions, 'sessions'),
      rate('engaged_to_video', 'Engaged sessions → video played', count(row => row.engaged_at && row.video_playing), counts.engagedSessions, 'sessions'),
      rate('video_to_half', 'Video plays → 50% watched', count(row => row.video_playing && row.video_50), counts.videoPlays, 'sessions'),
      rate('half_to_cta', '50% watched → booking button clicked', count(row => row.video_50 && row.booking_cta_click), counts.video50, 'sessions'),
      rate('cta_to_booking', 'Leads who clicked booking → page-assisted booking', intersectionSize(ctaLeads, pageAssistedLeads), ctaLeads.size, 'leads'),
      rate('engaged_to_booking', 'Leads with an engaged visit → assisted booking', intersectionSize(engagedLeads, assistedLeads), engagedLeads.size, 'leads'),
      rate('link_to_booking', 'Leads sent a link → booked after it', bookedLeads.size, leadsReached.size, 'leads'),
    ];
    return { counts, rates };
  }

  const overall = summarize(links, scopedSessions, cohortBookings);
  const bySource = SOURCES.map(source => {
    const sourceLinks = links.filter(row => row.source === source);
    const ids = new Set(sourceLinks.map(row => row.issuance_id));
    return {
      source, ...summarize(sourceLinks, scopedSessions.filter(row => ids.has(row.issuance_id)),
        cohortBookings.filter(row => ids.has(row.attributed_issuance_id))),
    };
  });

  const tiers = Object.fromEntries(TIERS.map(tier => [tier, 0]));
  for (const session of scopedSessions) tiers[tierOf(session)] += 1;
  const quality = {
    tiers,
    signals: {
      webdriver: scopedSessions.filter(row => row.webdriver).length,
      headless: scopedSessions.filter(row => row.ua_headless).length,
      declaredBot: scopedSessions.filter(row => row.ua_declared_bot).length,
      openedWithinMinuteOfSend: scopedSessions.filter(row => Number.isFinite(row.seconds_after_send) && row.seconds_after_send < 60).length,
      instantScrollJump: scopedSessions.filter(row => row.scroll_jump).length,
      neverVisible: scopedSessions.filter(row => !row.visible_at).length,
    },
  };

  // One row per lead sent a link in the period, most recent activity first.
  const latestBooking = new Map();
  for (const booking of bookings) {
    const current = latestBooking.get(booking.lead_id);
    if (!current || booking.booked_at > current.booked_at) latestBooking.set(booking.lead_id, booking);
  }
  const perLead = new Map();
  for (const link of links) {
    const row = perLead.get(link.lead_id) || {
      leadId: link.lead_id, source: link.source, linkSentAt: null, links: 0, latestVisitAt: null,
      highestTier: 'none', videoFurthest: null, bookingCtaClicked: false, bookingDialogOpened: false, isTest: false,
    };
    row.links += 1;
    if (!row.linkSentAt || link.sent_at > row.linkSentAt) { row.linkSentAt = link.sent_at; row.source = link.source; }
    row.isTest = row.isTest || Boolean(link.is_test);
    perLead.set(link.lead_id, row);
  }
  for (const session of scopedSessions) {
    const row = perLead.get(linkById.get(session.issuance_id).lead_id);
    row.latestVisitAt = later(row.latestVisitAt, session.last_seen_at || session.started_at);
    const tier = tierOf(session);
    if (TIER_RANK[tier] > TIER_RANK[row.highestTier]) row.highestTier = tier;
    const video = videoOf(session);
    if (video && (!row.videoFurthest || VIDEO_RANK[video] > VIDEO_RANK[row.videoFurthest])) row.videoFurthest = video;
    row.bookingCtaClicked = row.bookingCtaClicked || Boolean(session.booking_cta_click);
    row.bookingDialogOpened = row.bookingDialogOpened || Boolean(session.booking_dialog_open);
  }
  const leadRows = [...perLead.values()].map(row => {
    const info = leadInfo.get(row.leadId) || {};
    const booking = latestBooking.get(row.leadId);
    return {
      ...row, company: info.company || '', contact: info.contact_name || '', email: info.email || '',
      booking: booking && booking.booked_at >= row.linkSentAt
        ? { bookedAt: booking.booked_at, meetingAt: booking.meeting_at || null, assistLabel: booking.assist_label } : null,
    };
  }).sort((a, b) => String(b.latestVisitAt || b.linkSentAt).localeCompare(String(a.latestVisitAt || a.linkSentAt)));

  const periodBookings = bookings.filter(row => row.booked_at >= filters.from && row.booked_at < filters.to
    && (filters.includeTest || !isTestLead(row.lead_id)));
  const bookingPanel = {
    byLabel: Object.fromEntries(ASSIST_LABELS.map(label => [label, periodBookings.filter(row => row.assist_label === label).length])),
    total: periodBookings.length,
    rows: periodBookings.slice(0, BOOKING_ROWS).map(row => ({
      leadId: row.lead_id, company: leadInfo.get(row.lead_id)?.company || '', bookedAt: row.booked_at,
      meetingAt: row.meeting_at || null, assistLabel: row.assist_label, source: row.attributed_source || null,
    })),
  };

  return {
    generatedAt: now.toISOString(),
    filters, options,
    status: { trackingEnabled: flagEnabled(FLAG.TRACKING, env), collectorEnabled: flagEnabled(FLAG.COLLECTOR, env) },
    summary: overall.counts, rates: overall.rates,
    bySource: bySource.map(entry => ({ source: entry.source, counts: entry.counts, rates: entry.rates })),
    quality, bookings: bookingPanel,
    leads: { total: leadRows.length, rows: leadRows.slice(0, LEAD_ROWS) },
    monitor: filters.includeInternal && monitor ? {
      internalSessions: monitor.filter(row => row.is_internal).length,
      debugSessions: monitor.filter(row => row.is_debug).length,
      unresolvedSessions: monitor.filter(row => row.resolution === 'pending').length,
    } : null,
    truncated: Boolean(truncated),
  };
}

// ── Reading from Supabase (server-side secret key, explicit columns) ──────────

const inList = ids => encodeURIComponent(`in.(${ids.map(id => `"${String(id).replace(/["\\]/g, '')}"`).join(',')})`);
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

async function selectRows(table, query, { env, fetchImpl, maxRows = MAX_ROWS, timeoutMs = TIMEOUT_MS }) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, error: 'supabase not configured' };
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += PAGE_SIZE) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.url}/rest/v1/${table}?${query}&limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const page = await response.json();
      if (!Array.isArray(page)) return { ok: false, error: 'unexpected response' };
      rows.push(...page);
      if (page.length < PAGE_SIZE) return { ok: true, rows, truncated: false };
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, rows, truncated: true };
}

async function selectByIds(table, columns, key, ids, extra, options) {
  const rows = [];
  let truncated = false;
  for (const chunk of chunks([...new Set(ids)].filter(Boolean), ID_CHUNK)) {
    const result = await selectRows(table, `select=${columns}&${key}=${inList(chunk)}${extra}`, options);
    if (!result.ok) return result;
    rows.push(...result.rows);
    truncated = truncated || result.truncated;
  }
  return { ok: true, rows, truncated };
}

async function loadStaffingFunnel({ query = {}, env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const filters = parseFunnelFilters(query, now);
  const options = { env, fetchImpl };
  const from = encodeURIComponent(filters.from);
  const to = encodeURIComponent(filters.to);

  const issuances = await selectRows('landing_link_issuances',
    `select=${ISSUANCE_COLUMNS}&sent_at=gte.${from}&sent_at=lt.${to}${filters.includeTest ? '' : '&is_test=is.false'}&order=sent_at.desc`, options);
  if (!issuances.ok) return { ok: false, error: issuances.error };
  const sessions = await selectByIds('landing_session_facts', SESSION_COLUMNS, 'issuance_id',
    issuances.rows.map(row => row.issuance_id), '&is_internal=is.false&is_debug=is.false', options);
  if (!sessions.ok) return { ok: false, error: sessions.error };
  const bookings = await selectRows('landing_booking_attribution', `select=${BOOKING_COLUMNS}&booked_at=gte.${from}&order=booked_at.desc`, options);
  if (!bookings.ok) return { ok: false, error: bookings.error };
  let monitor = null;
  if (filters.includeInternal) {
    const monitored = await selectRows('landing_sessions',
      `select=${MONITOR_COLUMNS}&started_at=gte.${from}&started_at=lt.${to}&or=(is_internal.is.true,is_debug.is.true,resolution.eq.pending)`, options);
    if (!monitored.ok) return { ok: false, error: monitored.error };
    monitor = monitored.rows;
  }
  const leads = await selectByIds('outreach_leads', LEAD_COLUMNS, 'lead_id',
    [...issuances.rows.map(row => row.lead_id), ...bookings.rows.map(row => row.lead_id)], '', options);
  if (!leads.ok) return { ok: false, error: leads.error };

  return {
    ok: true,
    data: buildStaffingFunnel({
      filters, issuances: issuances.rows, sessions: sessions.rows, bookings: bookings.rows, leads: leads.rows, monitor, env, now,
      truncated: issuances.truncated || sessions.truncated || bookings.truncated || leads.truncated,
    }),
  };
}

module.exports = {
  SOURCES, ASSIST_LABELS, TIERS,
  ISSUANCE_COLUMNS, SESSION_COLUMNS, BOOKING_COLUMNS, LEAD_COLUMNS,
  parseFunnelFilters, buildStaffingFunnel, loadStaffingFunnel, vancouverMidnight,
};
