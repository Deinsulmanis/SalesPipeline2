'use strict';

const { LEGACY_UNKNOWN, parseMetadata, attributionFromActivity } = require('./campaign-versions');

const SEND_TYPES = new Set(['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent']);
const REPLY_TYPES = new Set(['positive_reply', 'meeting_requested', 'late_reply', 'question_reply', 'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply']);
const STAGE_SEQUENCE_TYPES = new Set(['sequence_enrolled', 'sequence_step_sent', 'sequence_completed', 'sequence_stopped']);
const FUNNEL_STAGES = Object.freeze(['sent', 'replied', 'positive', 'demo', 'hot', 'callBooked', 'callHeld', 'won']);

const normalizeEmail = value => String(value || '').trim().toLowerCase();
const cleanId = value => String(value || '').replace(/^CE-/, '').trim();
const validTime = value => { const ms = new Date(value || '').getTime(); return Number.isFinite(ms) ? ms : null; };
const rate = (numerator, denominator) => denominator ? numerator / denominator * 100 : null;

function activityLeadId(row, leadIds, uniqueEmailLead) {
  const source = cleanId(row.sourceLeadId);
  if (leadIds.has(source)) return source;
  const direct = cleanId(row.leadId);
  if (leadIds.has(direct)) return direct;
  return uniqueEmailLead.get(normalizeEmail(row.email)) || '';
}

function boardLeadId(row, leadIds, uniqueEmailLead) {
  const direct = cleanId(row.id);
  if (String(row.id || '').startsWith('CE-') && leadIds.has(direct)) return direct;
  return uniqueEmailLead.get(normalizeEmail(row.email)) || '';
}

function selectedVersion(value, currentVersion) {
  const raw = String(value || 'current').trim();
  if (raw === 'current') return currentVersion;
  return raw;
}

function versionMatches(version, selected) {
  if (selected === 'lifetime') return true;
  if (selected === 'all_measured') return version && version !== LEGACY_UNKNOWN;
  return version === selected;
}

function sendMatches(attribution, filters) {
  if (!versionMatches(attribution.campaignVersion || LEGACY_UNKNOWN, filters.version)) return false;
  if (filters.family && attribution.campaignFamily !== filters.family) return false;
  if (filters.personalizationLevel !== '' && String(attribution.personalizationLevel ?? '') !== filters.personalizationLevel) return false;
  if (filters.angle && String(attribution.personalizationAngle || '').toLowerCase() !== filters.angle.toLowerCase()) return false;
  if (filters.subjectStrategy && attribution.subjectStrategy !== filters.subjectStrategy) return false;
  if (filters.copyVersion && attribution.copyVersion !== filters.copyVersion) return false;
  if (filters.sequenceId && attribution.sequenceId !== filters.sequenceId) return false;
  return true;
}

function withinCohort(row, filters) {
  const at = validTime(row.occurredAt);
  if (at === null) return filters.from === null && filters.to === null;
  return (filters.from === null || at >= filters.from) && (filters.to === null || at <= filters.to);
}

function categoryForReply(row, fallback = '') {
  const type = String(row.eventType || '');
  const metadata = parseMetadata(row.metadata);
  const classification = String(metadata.classification || fallback || '').toUpperCase();
  if (['positive_reply', 'meeting_requested'].includes(type) || /INTERESTED|MEETING_REQUEST|POSITIVE/.test(classification)) return 'positive';
  if (['negative_reply', 'unsubscribe_reply'].includes(type) || /NOT_INTERESTED|NEGATIVE|UNSUBSCRIBE/.test(classification)) return 'negative';
  if (['question_reply', 'wrong_person_reply', 'needs_human_reply'].includes(type) || /QUESTION|WRONG_PERSON|NEEDS_HUMAN|NEUTRAL/.test(classification)) return 'needs_human';
  return 'unclassified';
}

function acquisitionFor(rows) {
  const promotions = rows.filter(row => row.eventType === 'pipeline_promoted')
    .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
  for (const row of promotions) {
    const metadata = parseMetadata(row.metadata);
    if (metadata.acquisitionCampaignVersion) return {
      version: metadata.acquisitionCampaignVersion,
      family: metadata.acquisitionCampaignFamily || '',
      eventId: metadata.acquisitionSourceEventId || '',
    };
  }
  return { version: LEGACY_UNKNOWN, family: '', eventId: '' };
}

function buildFunnelAnalytics(input = {}, query = {}) {
  const leads = input.leads || [];
  const boardLeads = input.boardLeads || [];
  const activities = input.activities || [];
  const replyRecords = input.replyRecords || [];
  const currentVersion = input.currentVersion || '';
  const version = selectedVersion(query.version, currentVersion);
  const from = query.from ? validTime(query.from) : null;
  const toRaw = query.to ? validTime(query.to) : null;
  const filters = {
    version, from, to: toRaw === null ? null : toRaw + (String(query.to).length <= 10 ? 86399999 : 0),
    family: String(query.family || ''), personalizationLevel: query.personalizationLevel === undefined ? '' : String(query.personalizationLevel),
    angle: String(query.angle || ''), subjectStrategy: String(query.subjectStrategy || ''),
    copyVersion: String(query.copyVersion || ''), sequenceId: String(query.sequenceId || ''),
  };

  const leadIds = new Set(leads.map(row => String(row.id || '')).filter(Boolean));
  const emails = new Map();
  for (const lead of leads) {
    const email = normalizeEmail(lead.email); if (!email) continue;
    const ids = emails.get(email) || []; ids.push(lead.id); emails.set(email, ids);
  }
  const uniqueEmailLead = new Map([...emails].filter(([, ids]) => ids.length === 1).map(([email, ids]) => [email, ids[0]]));
  const activitiesByLead = new Map();
  for (const row of activities) {
    const id = activityLeadId(row, leadIds, uniqueEmailLead); if (!id) continue;
    const rows = activitiesByLead.get(id) || []; rows.push(row); activitiesByLead.set(id, rows);
  }
  for (const rows of activitiesByLead.values()) rows.sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));

  const qualifyingSends = new Map();
  const allSends = new Map();
  const facets = { versions: new Set(), families: new Set(), personalizationLevels: new Set(), angles: new Set(), subjectStrategies: new Set(), copyVersions: new Set(), sequences: new Set() };
  for (const [id, rows] of activitiesByLead) {
    for (const row of rows.filter(item => SEND_TYPES.has(String(item.eventType || '')))) {
      const attribution = attributionFromActivity(row);
      const actualVersion = attribution.campaignVersion || LEGACY_UNKNOWN;
      facets.versions.add(actualVersion);
      if (attribution.campaignFamily) facets.families.add(attribution.campaignFamily);
      if (attribution.personalizationLevel !== null && attribution.personalizationLevel !== undefined) facets.personalizationLevels.add(String(attribution.personalizationLevel));
      if (attribution.personalizationAngle) facets.angles.add(attribution.personalizationAngle);
      if (attribution.subjectStrategy) facets.subjectStrategies.add(attribution.subjectStrategy);
      if (attribution.copyVersion) facets.copyVersions.add(attribution.copyVersion);
      if (attribution.sequenceId) facets.sequences.add(attribution.sequenceId);
      const sends = allSends.get(id) || []; sends.push({ row, attribution }); allSends.set(id, sends);
      if (!sendMatches(attribution, filters) || !withinCohort(row, filters)) continue;
      const matches = qualifyingSends.get(id) || []; matches.push({ row, attribution }); qualifyingSends.set(id, matches);
    }
  }
  // Activity storage was introduced after the original campaign. A ColdEmail
  // row with a real send state is truthful proof that the lead was contacted,
  // but not proof of copy/version; it therefore belongs only to Lifetime or
  // legacy_unknown. Measured cohorts remain activity-attribution-only.
  let historicalSendStates = 0;
  if (['lifetime', LEGACY_UNKNOWN].includes(version)
    && !filters.family && filters.personalizationLevel === '' && !filters.angle
    && !filters.subjectStrategy && !filters.copyVersion && !filters.sequenceId) {
    for (const lead of leads) {
      if (allSends.has(lead.id)) continue;
      const status = String(lead.emailStatus || '').toLowerCase();
      const sentEvidence = Boolean(lead.lastEmailedAt) || Number(lead.emailStep || 0) > 0 || ['emailed', 'replied', 'done'].includes(status);
      if (!sentEvidence) continue;
      const row = { eventType: 'historical_send_state', occurredAt: String(lead.lastEmailedAt || '') };
      if (!withinCohort(row, filters)) continue;
      const attribution = { campaignVersion: LEGACY_UNKNOWN, campaignFamily: '', sequenceId: 'historical_unknown', sequenceStep: null, copyVersion: '', subjectStrategy: '' };
      allSends.set(lead.id, [{ row, attribution }]); qualifyingSends.set(lead.id, [{ row, attribution }]); historicalSendStates++;
      facets.versions.add(LEGACY_UNKNOWN);
    }
  }

  // `unknown` and `automatedReply` are first-class buckets, not leftovers.
  // A lead with no reply evidence must land somewhere nameable rather than
  // being quietly folded into "unclassified" or, worse, "negative".
  const stageSets = Object.fromEntries([...FUNNEL_STAGES, 'negative', 'needsHuman', 'unclassified',
    'unknown', 'automatedReply', 'contactChangeReview',
    'noShow', 'cancelled', 'lost', 'pending'].map(key => [key, new Set()]));
  // Categories that mean "a real person wrote back". Autoresponders and
  // evidence-free rows are deliberately excluded so they cannot inflate the
  // reply rate or the positive rate.
  const GENUINE_REPLY_CATEGORIES = ['positive', 'negative', 'needs_human', 'unclassified'];
  const bucketFor = category => (
    category === 'needs_human' ? 'needsHuman'
      : category === 'automated_reply' ? 'automatedReply'
        : category === 'contact_change_review' ? 'contactChangeReview'
          : stageSets[category] ? category : 'unknown');
  const replyTouch = new Map();
  const replyMessages = [];
  const categoryByLead = new Map(replyRecords.map(row => [String(row.leadId || ''), row.category]));
  const acquisitionByLead = new Map();
  const boardByLead = new Map();
  for (const board of boardLeads) {
    const id = boardLeadId(board, leadIds, uniqueEmailLead); if (!id || boardByLead.has(id)) continue;
    boardByLead.set(id, board);
  }

  for (const [id, sends] of qualifyingSends) {
    stageSets.sent.add(id);
    const rows = activitiesByLead.get(id) || [];
    const replies = rows.filter(row => REPLY_TYPES.has(String(row.eventType || '')));
    let attributedReply = false;
    let attributedFallbackCategory = '';
    for (const reply of replies) {
      const metadata = parseMetadata(reply.metadata);
      const touch = metadata.replyTouch || {};
      const touchVersion = touch.campaignVersion || LEGACY_UNKNOWN;
      if (version !== 'lifetime' && !versionMatches(touchVersion, version)) continue;
      replyMessages.push(reply);
      const category = categoryForReply(reply, categoryByLead.get(id));
      attributedReply = true; attributedFallbackCategory = category;
      const key = `${touch.sequenceId || 'unknown'}:${touch.sequenceStep || 'unknown'}`;
      const value = replyTouch.get(key) || { sequenceId: touch.sequenceId || 'unknown', step: touch.sequenceStep || null, replies: new Set(), positive: new Set() };
      value.replies.add(id); if (category === 'positive') value.positive.add(id); replyTouch.set(key, value);
    }
    if (attributedReply) {
      const category = categoryByLead.get(id) || attributedFallbackCategory || 'unclassified';
      stageSets[bucketFor(category)].add(id);
      // Only a genuine human reply counts toward the reply funnel stage.
      if (GENUINE_REPLY_CATEGORIES.includes(category)) stageSets.replied.add(id);
    }
    // Historical Lifetime/legacy rows can truthfully establish that a reply
    // happened even when the old activity omitted thread attribution.
    if (!stageSets.replied.has(id) && categoryByLead.has(id) && ['lifetime', LEGACY_UNKNOWN].includes(version)) {
      const category = categoryByLead.get(id) || 'unclassified';
      stageSets[bucketFor(category)].add(id);
      if (GENUINE_REPLY_CATEGORIES.includes(category)) stageSets.replied.add(id);
    }

    const demoEvents = rows.filter(row => row.eventType === 'demo_pair_played');
    if (demoEvents.some(demo => {
      const demoAt = validTime(demo.occurredAt) || Infinity;
      return sends.some(send => (validTime(send.row.occurredAt) || 0) <= demoAt);
    })) stageSets.demo.add(id);

    const acquisition = acquisitionFor(rows);
    acquisitionByLead.set(id, acquisition);
    const acquisitionMatches = version === 'lifetime' || versionMatches(acquisition.version, version);
    const board = boardByLead.get(id);
    const promotions = rows.filter(row => row.eventType === 'pipeline_promoted');
    if (acquisitionMatches && promotions.some(row => String(parseMetadata(row.metadata).toStage || '').toLowerCase() === 'hot')) stageSets.hot.add(id);
    if (acquisitionMatches && rows.some(row => row.eventType === 'call_booked')) stageSets.callBooked.add(id);
    if (acquisitionMatches && rows.some(row => row.eventType === 'meeting_completed')) stageSets.callHeld.add(id);
    if (acquisitionMatches && rows.some(row => row.eventType === 'meeting_no_show')) stageSets.noShow.add(id);
    if (acquisitionMatches && rows.some(row => row.eventType === 'meeting_cancelled')) stageSets.cancelled.add(id);
    if (board && acquisitionMatches) {
      const stage = String(board.stage || '').toLowerCase();
      if (stage === 'closed_won') stageSets.won.add(id);
      if (['closed_lost', 'closed', 'lost'].includes(stage)) stageSets.lost.add(id);
      if (!['closed_won', 'closed_lost', 'closed', 'lost'].includes(stage)) stageSets.pending.add(id);
      // Legacy rows predate promotion activity. Current board state is truthful
      // enough for Lifetime/legacy diagnostics, but never enters a measured cohort.
      //
      // A TERMINAL stage is deliberately NOT evidence of having reached Hot. A
      // lead can be marked lost from any stage, and production contains lost
      // leads with no activity at all — counting those as Hot would invent a
      // funnel step that never happened. Hot therefore needs either a stage
      // that IS Hot-or-beyond, or an explicit transition recorded in activity.
      if (['lifetime', LEGACY_UNKNOWN].includes(version)) {
        const reachedHotByStage = ['hot', 'call_booked', 'closed_won'].includes(stage);
        const reachedHotByEvent = rows.some(row => row.eventType === 'stage_changed'
          && String(parseMetadata(row.metadata).toStage || '').toLowerCase() === 'hot');
        if (reachedHotByStage || reachedHotByEvent) stageSets.hot.add(id);
        if (['call_booked', 'closed_won', 'closed_lost', 'closed', 'lost'].includes(stage) && board.meetingAt) stageSets.callBooked.add(id);
      }
    }
  }

  const counts = Object.fromEntries(Object.entries(stageSets).map(([key, set]) => [key, set.size]));
  const eventCounts = {
    emailsSent: [...qualifyingSends.values()].flat().filter(item => SEND_TYPES.has(String(item.row.eventType || ''))).length,
    replyMessages: replyMessages.length,
    demoPlays: [...stageSets.demo].length,
    meetingsBooked: [...qualifyingSends.keys()].reduce((sum, id) => sum + (activitiesByLead.get(id) || []).filter(row => row.eventType === 'call_booked').length, 0),
    meetingsRescheduled: [...qualifyingSends.keys()].reduce((sum, id) => sum + (activitiesByLead.get(id) || []).filter(row => row.eventType === 'meeting_rescheduled').length, 0),
    stageSequenceSends: [...qualifyingSends.values()].flat().filter(item => item.row.eventType === 'sequence_step_sent').length,
    historicalSendStates,
  };
  const conversions = {
    sentToReply: rate(counts.replied, counts.sent), sentToPositive: rate(counts.positive, counts.sent),
    replyToPositive: rate(counts.positive, counts.replied), sentToDemo: rate(counts.demo, counts.sent),
    positiveToHot: rate(counts.hot, counts.positive), hotToCallBooked: rate(counts.callBooked, counts.hot),
    callBookedToHeld: rate(counts.callHeld, counts.callBooked), callHeldToWon: rate(counts.won, counts.callHeld),
    sentToWon: rate(counts.won, counts.sent), showRate: rate(counts.callHeld, counts.callHeld + counts.noShow),
    winRate: rate(counts.won, counts.won + counts.lost),
  };

  const groupRows = key => {
    const groups = new Map();
    for (const [id, sends] of qualifyingSends) {
      const value = String(sends[0]?.attribution?.[key] ?? ''); if (!value) continue;
      const group = groups.get(value) || { value, sent: new Set(), replied: new Set(), positive: new Set(), demo: new Set(), callBooked: new Set(), won: new Set() };
      group.sent.add(id);
      for (const metric of ['replied', 'positive', 'demo', 'callBooked', 'won']) if (stageSets[metric].has(id)) group[metric].add(id);
      groups.set(value, group);
    }
    return [...groups.values()].map(group => ({ value: group.value, sent: group.sent.size, replied: group.replied.size,
      positive: group.positive.size, positiveRate: rate(group.positive.size, group.sent.size), demo: group.demo.size,
      callsBooked: group.callBooked.size, won: group.won.size })).sort((a, b) => b.sent - a.sent || a.value.localeCompare(b.value));
  };

  const sequenceGroups = new Map();
  for (const [id, rows] of activitiesByLead) for (const row of rows.filter(item => STAGE_SEQUENCE_TYPES.has(String(item.eventType || '')))) {
    const metadata = parseMetadata(row.metadata); const sequenceId = String(metadata.sequenceId || 'unknown');
    const group = sequenceGroups.get(sequenceId) || { sequenceId, enrolled: new Set(), sends: 0, replies: new Set(), positive: new Set(), rebookings: new Set(), completed: new Set(), stoppedByReply: new Set(), stoppedByBooking: new Set() };
    if (row.eventType === 'sequence_enrolled') group.enrolled.add(id);
    if (row.eventType === 'sequence_step_sent') group.sends++;
    if (row.eventType === 'sequence_completed') group.completed.add(id);
    if (row.eventType === 'sequence_stopped') {
      if (/reply/i.test(metadata.reason || metadata.stopReason || '')) group.stoppedByReply.add(id);
      if (/book/i.test(metadata.reason || metadata.stopReason || '')) group.stoppedByBooking.add(id);
    }
    sequenceGroups.set(sequenceId, group);
  }
  const sequencePerformance = [...sequenceGroups.values()].map(group => ({ sequenceId: group.sequenceId, enrolled: group.enrolled.size, sends: group.sends,
    replies: group.stoppedByReply.size, positive: [...group.stoppedByReply].filter(id => stageSets.positive.has(id)).length, rebookings: group.stoppedByBooking.size, completed: group.completed.size,
    stoppedByReply: group.stoppedByReply.size, stoppedByBooking: group.stoppedByBooking.size }));

  const funnel = FUNNEL_STAGES.map((key, index) => {
    const previous = index ? stageSets[FUNNEL_STAGES[index - 1]] : null;
    const continued = previous ? [...stageSets[key]].filter(id => previous.has(id)).length : 0;
    return { key, count: counts[key], fromPrevious: previous ? rate(continued, previous.size) : null, fromSent: key === 'sent' ? 100 : rate(counts[key], counts.sent) };
  });
  const leaks = {
    sentNoReply: counts.sent - counts.replied, repliedNotPositive: counts.replied - counts.positive,
    positiveNotHot: Math.max(0, counts.positive - counts.hot), hotNoCall: Math.max(0, counts.hot - counts.callBooked),
    callUnresolved: Math.max(0, counts.callBooked - counts.callHeld - counts.noShow - counts.cancelled),
    heldNoOutcome: Math.max(0, counts.callHeld - counts.won - counts.lost),
  };
  const stageLeadIds = Object.fromEntries(Object.entries(stageSets).map(([key, set]) => [key, [...set]]));

  // Board records that never enter this funnel at all. The funnel is anchored on
  // cold-outreach sends, so a lead acquired through another channel (or one whose
  // board row cannot be tied to a ColdEmail lead) legitimately has no place in
  // it — but it must not vanish silently. Production currently holds closed_won
  // rows in exactly this state, so reporting "Closed Won: 0" without this
  // counter would read as a fact when it is really a limit of attribution.
  const outsideFunnel = { total: 0, unmappedToOutreach: 0, mappedButNoQualifyingSend: 0, byStage: {} };
  for (const board of boardLeads) {
    const id = boardLeadId(board, leadIds, uniqueEmailLead);
    if (id && qualifyingSends.has(id)) continue;
    const stage = String(board.stage || '(blank)').toLowerCase();
    outsideFunnel.total++;
    outsideFunnel.byStage[stage] = (outsideFunnel.byStage[stage] || 0) + 1;
    if (id) outsideFunnel.mappedButNoQualifyingSend++; else outsideFunnel.unmappedToOutreach++;
  }
  const lossReasons = {};
  for (const id of stageSets.lost) { const reason = String(boardByLead.get(id)?.outcome || 'unknown') || 'unknown'; lossReasons[reason] = (lossReasons[reason] || 0) + 1; }

  return {
    filters: { ...filters, from: query.from || '', to: query.to || '' }, counts, funnel, conversions, eventCounts, leaks, lossReasons,
    breakdowns: { personalizationLevel: groupRows('personalizationLevel'), angle: groupRows('personalizationAngle'), subjectStrategy: groupRows('subjectStrategy'), copyVersion: groupRows('copyVersion') },
    replyTouch: [...replyTouch.values()].map(row => ({ sequenceId: row.sequenceId, step: row.step, replies: row.replies.size, positive: row.positive.size })),
    sequencePerformance, stageLeadIds,
    facets: Object.fromEntries(Object.entries(facets).map(([key, set]) => [key, [...set].sort()])),
    reconciliation: {
      repliesPartition: counts.replied === counts.positive + counts.negative + counts.needsHuman + counts.unclassified,
      // Inbound messages of every kind, genuine or not. Reported separately so
      // autoresponders stay visible operationally without touching reply rate.
      inboundMessageLeads: counts.replied + counts.automatedReply + counts.contactChangeReview + counts.unknown,
      // Every stage count must be exactly the length of its drill-down list, or
      // a displayed number is not auditable.
      stagesMatchLeadIds: Object.entries(stageSets).every(([key, set]) => set.size === counts[key]),
      boardLeadsTotal: boardLeads.length,
      outsideFunnel,
    },
  };
}

module.exports = { FUNNEL_STAGES, buildFunnelAnalytics, rate };
