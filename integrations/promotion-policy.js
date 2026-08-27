'use strict';

const { COLD_CALL_STAGE_IDS, displayStageFor } = require('./cold-call-pipeline');
const { stageTransitionCheck, SUPPRESSION_NOTE_TAGS } = require('./pipeline-state');

const PROMOTION_TRIGGER = Object.freeze({
  POSITIVE_REPLY: 'positive_reply',
  LATE_POSITIVE_REPLY: 'late_positive_reply',
  VERIFIED_DEMO_PAIR: 'verified_demo_pair',
  MEETING_BOOKED: 'meeting_booked',
  MANUAL: 'manual_promotion',
  NEEDS_HUMAN: 'needs_human',
  NEGATIVE_REPLY: 'negative_reply',
  UNCLASSIFIED_REPLY: 'unclassified_reply',
  OPEN: 'email_open',
  WARM: 'warm_opens',
  SEQUENCE_COMPLETE: 'sequence_complete',
  QUEUED: 'queued',
});

const AUTO_STAGE_RANK = Object.freeze({ follow_up: 1, hot: 2, call_booked: 3, closed_won: 4, closed_lost: 4 });

function promotionSuppressionReason(lead = {}, suppressedEmails = new Set()) {
  const notes = String(lead.notes || '');
  for (const tag of SUPPRESSION_NOTE_TAGS) if (notes.toLowerCase().includes(tag.toLowerCase())) return tag;
  if (/\[(?:SUPPRESSED|INVALID RECIPIENT)/i.test(notes)) return 'hard suppression tag';
  if (/^(?:Unsub|Unsubscribed)$/i.test(lead.stage || '')) return 'unsubscribed';
  if (suppressedEmails.has(String(lead.email || '').trim().toLowerCase())) return 'durable suppression';
  return '';
}

function resolvePromotionIdentity(coldEmailLead, boardLeads = [], options = {}) {
  const lead = coldEmailLead || {};
  const ceId = `CE-${String(lead.id || '').replace(/^CE-/, '')}`;
  const email = String(lead.email || '').trim().toLowerCase();
  const idMatches = boardLeads.filter(row => String(row.id || '') === ceId);
  const emailMatches = email ? boardLeads.filter(row => String(row.email || '').trim().toLowerCase() === email) : [];
  if (idMatches.length > 1) return { status: 'conflict', reason: 'multiple board records share the CE foreign key' };
  if (idMatches.length === 1) {
    const otherEmailMatches = emailMatches.filter(row => row !== idMatches[0]);
    if (otherEmailMatches.length) return { status: 'conflict', reason: 'CE foreign key and email point to different board records' };
    return { status: 'matched', matchedBy: 'ce_id', boardLead: idMatches[0] };
  }
  if (Number(options.coldEmailTwinCount || 1) > 1) {
    return { status: 'conflict', reason: 'multiple ColdEmail twins share this board identity' };
  }
  if (emailMatches.length > 1) return { status: 'conflict', reason: 'multiple board records share the normalized email' };
  if (emailMatches.length === 1) return { status: 'matched', matchedBy: 'email', boardLead: emailMatches[0] };
  return { status: 'new', matchedBy: '', boardLead: null };
}

function promotionDecision(input = {}) {
  const trigger = String(input.trigger || '');
  const identity = input.identity || { status: 'new', boardLead: null };
  const coldEmailLead = input.coldEmailLead || {};
  const automatic = trigger !== PROMOTION_TRIGGER.MANUAL;
  if (identity.status === 'conflict') return { shouldPromote: false, safety: 'conflict', trigger, reason: identity.reason || 'ambiguous identity' };
  const suppression = promotionSuppressionReason(coldEmailLead, input.suppressedEmails);
  if (automatic && suppression) return { shouldPromote: false, safety: 'blocked', trigger, reason: `suppressed: ${suppression}` };

  let targetStage = '';
  let reason = '';
  if ([PROMOTION_TRIGGER.POSITIVE_REPLY, PROMOTION_TRIGGER.LATE_POSITIVE_REPLY].includes(trigger)) {
    targetStage = 'hot'; reason = 'canonical positive reply requires human sales follow-up';
  } else if (trigger === PROMOTION_TRIGGER.VERIFIED_DEMO_PAIR && input.verifiedDemoPair === true && input.bookingLinkSent === true) {
    targetStage = 'follow_up'; reason = 'verified demo pair crossed the existing booking-link intent threshold';
  } else if (trigger === PROMOTION_TRIGGER.MEETING_BOOKED) {
    targetStage = 'call_booked'; reason = 'a valid meeting was booked';
  } else if (trigger === PROMOTION_TRIGGER.MANUAL) {
    targetStage = String(input.targetStage || ''); reason = 'explicit manual promotion';
    if (!targetStage) return { shouldPromote: false, safety: 'blocked', trigger, reason: 'target stage is required' };
  } else {
    return { shouldPromote: false, safety: 'review', trigger, reason: 'signal does not meet the automatic promotion threshold' };
  }

  if (!COLD_CALL_STAGE_IDS.has(targetStage)) return { shouldPromote: false, safety: 'blocked', trigger, reason: 'invalid target stage' };
  const gate = stageTransitionCheck(targetStage, { meetingAt: input.meetingAt || '', outcome: input.outcome || '' });
  if (!gate.ok) return { shouldPromote: false, safety: 'blocked', trigger, targetStage, reason: gate.message };

  const existingStage = identity.boardLead ? displayStageFor(identity.boardLead.stage) : '';
  if (automatic && existingStage && (AUTO_STAGE_RANK[existingStage] || 0) >= (AUTO_STAGE_RANK[targetStage] || 0)) {
    return { shouldPromote: true, shouldCreate: false, shouldMove: false, targetStage: existingStage,
      requestedStage: targetStage, safety: 'safe', trigger, reason: `${reason}; existing stage retained by precedence` };
  }
  return { shouldPromote: true, shouldCreate: !identity.boardLead, shouldMove: Boolean(identity.boardLead && existingStage !== targetStage),
    targetStage, requestedStage: targetStage, safety: 'safe', trigger, reason };
}

module.exports = { PROMOTION_TRIGGER, AUTO_STAGE_RANK, promotionSuppressionReason, resolvePromotionIdentity, promotionDecision };
