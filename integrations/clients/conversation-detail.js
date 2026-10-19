'use strict';

/**
 * One managed-client conversation, for the Inbox detail drawer. PURE and
 * read-only: it shapes state that already exists (the lead row, its research
 * profile, its activity ledger and the client ledger) and writes nothing.
 *
 * Tenant isolation is the caller's first job and this module's second: the
 * caller passes a lead already scoped to the client, and everything else is
 * filtered again here (activities to this lead, reply evidence to this client,
 * senders to this client's inboxes, ledger rows to this client).
 *
 * Sender: resolveSenderOwnership() is the canonical resolver, the same one the
 * ScaleLab drawer and the send path consult. A sender proven by a delivered
 * message wins over the row's assignment; the assignment is reported beside it
 * only when the two differ. Nothing is guessed: an unproven sender is labelled
 * as such, and an inbox outside this client is named by id only.
 */

const { getClient } = require('./registry');
const { resolveSenderClient } = require('./ownership');
const { clientCampaign } = require('./campaigns');
const { readLeadProfile } = require('./lead-profile');
const { REPLY_EVENT_TYPE } = require('./reply-pipeline');
const { PIPELINE_STAGES, pipelineStageFor } = require('./pipeline');
const { CLARIFICATION_STATUS } = require('./ledger');
const { evaluateScopedSuppression } = require('./suppression');
const { activityBelongsToLead } = require('../lead-activity');
const { resolveSenderOwnership, SENDER_STATE, STATE_LABEL } = require('../sender-visibility');
const { sentSenderEvidence } = require('../gmail-sender-routing');
const { classifySendEvent, providerMessageId } = require('../canonical-sends');
const { nextFollowUp, SEQUENCE_TIMING } = require('../sequence-timing');

const text = value => String(value == null ? '' : value).trim();
const iso = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; };
function meta(row) {
  if (row && typeof row.metadata === 'object' && row.metadata) return row.metadata;
  try { return JSON.parse(row?.metadata || '{}'); } catch (_) { return {}; }
}

const STEP_LABELS = Object.freeze(['Initial outreach', 'Follow-up', 'Final follow-up']);
// reply-pipeline.js stores at most this much of the prospect's own words.
const STORED_REPLY_CHARS = 1500;
const CLOSED_CONVERSATIONS = new Set(['closed_not_interested', 'closed_unsubscribed', 'closed_outside_icp', 'closed_lost', 'closed_won']);

/**
 * "jole_team_jguerrero" + "j.guerrero@jolebtxteam.com" → "Jole Team — J. Guerrero".
 * Formatting of the registry's own id and address, never a lookup table: an id
 * that does not follow the <client>_<brand>_<mailbox> pattern shows its address.
 */
function senderDisplayLabel(senderId, email) {
  const parts = text(senderId).split('_').filter(Boolean);
  const local = text(email).split('@')[0];
  if (parts.length < 3 || !local) return text(email) || text(senderId);
  const title = word => word.charAt(0).toUpperCase() + word.slice(1);
  const brand = parts.slice(0, -1).map(title).join(' ');
  const person = local.split(/[._-]+/).filter(Boolean).map(word => (word.length === 1 ? `${word.toUpperCase()}.` : title(word))).join(' ');
  return `${brand} — ${person}`;
}

/** Only this client's inboxes, reduced to the visible identity. */
function clientSenderIdentities(senders = [], clientId) {
  return (senders || [])
    .filter(sender => { const owner = resolveSenderClient(sender); return owner.ok && owner.clientId === clientId; })
    .map(sender => ({ id: text(sender.id), email: text(sender.email).toLowerCase(), status: text(sender.status) }));
}

function identityOf(senderId, identities) {
  const id = text(senderId);
  if (!id) return null;
  const match = identities.find(item => item.id === id);
  // An id that is not one of this client's inboxes is surfaced by id only: its
  // address belongs to another tenant (or to no configured inbox at all).
  if (!match) return { senderId: id, email: '', label: id, inClient: false };
  return { senderId: id, email: match.email, label: senderDisplayLabel(id, match.email), inClient: true, status: match.status };
}

function sendStep(row) {
  if (text(row.eventType) === 'initial_email_sent') return 1;
  const data = meta(row);
  const step = Number(data.sequenceStep ?? data.step ?? row.sequenceStep);
  return Number.isInteger(step) ? step : null;
}

function buildSender({ client, lead, activities, identities, confirmedSends }) {
  const ownership = resolveSenderOwnership({
    lead, activities, senders: identities.map(item => ({ id: item.id, email: item.email })),
  });
  const assigned = identityOf(lead.senderInboxId, identities);
  // The inboxes that actually sent (delivered-message evidence only). Exactly
  // one is the sender, whatever the row now says; the row is reported beside
  // it. Two that both sent is a real conflict.
  const sentIds = sentSenderEvidence(lead, activities);
  if (sentIds.length > 1 || (!sentIds.length && ownership.state === 'conflict')) {
    return {
      state: 'conflict', stateLabel: ownership.stateLabel, detail: ownership.detail, source: 'conflict',
      senderId: '', email: '', label: '',
      candidates: ownership.candidates.map(item => identityOf(item.senderId, identities)),
      assigned,
    };
  }
  if (ownership.state === 'unknown') {
    return { state: 'unknown', stateLabel: ownership.stateLabel, detail: ownership.detail, source: 'none', senderId: '', email: '', label: '', assigned: null };
  }
  const confirmed = sentIds.length === 1;
  const owner = identityOf(confirmed ? sentIds[0] : ownership.senderId, identities);
  const proof = confirmed
    ? confirmedSends.filter(send => send.senderId === owner.senderId).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))[0] || null
    : null;
  const assignmentDiffers = Boolean(assigned && assigned.senderId !== owner.senderId);
  return {
    state: confirmed ? SENDER_STATE.CONFIRMED : ownership.state,
    stateLabel: confirmed ? STATE_LABEL[SENDER_STATE.CONFIRMED] : ownership.stateLabel,
    detail: !owner.inClient ? `Sender ${owner.senderId} is not a ${client.displayName} inbox — review required.`
      : confirmed ? `Sent from ${owner.email || owner.senderId}.` : ownership.detail,
    source: confirmed ? 'send_history' : 'assignment',
    senderId: owner.senderId, email: owner.email, label: owner.label, inClient: owner.inClient,
    proof: proof ? { eventType: proof.eventType, step: proof.step, sentAt: proof.sentAt, providerMessageId: proof.providerMessageId } : null,
    // A row that now names another inbox is what the send path calls a sender
    // conflict: shown, never resolved here.
    assigned, assignmentDiffers, assignmentConflict: assignmentDiffers && ownership.state === 'conflict',
  };
}

function buildSequence({ lead, activities, confirmedSends, failedSteps, replies }) {
  const status = text(lead.emailStatus).toLowerCase();
  const rowStep = parseInt(lead.emailStep || '0', 10) || 0;
  const terminatingReply = replies.find(reply => reply.workflowState !== 'automated') || null;
  const stoppedByReply = Boolean(terminatingReply) && ['replied', 'done'].includes(status);
  const firstByStep = new Map();
  for (const send of confirmedSends) {
    if (send.step && !firstByStep.has(send.step)) firstByStep.set(send.step, send);
  }
  const follow = status === 'emailed' && !stoppedByReply ? nextFollowUp(lead, { activities }) : null;
  const nextDue = follow && !follow.alreadySent && !follow.blockedBy ? follow : null;
  const steps = [];
  for (let step = 1; step <= SEQUENCE_TIMING.touchCount; step += 1) {
    const send = firstByStep.get(step);
    let state;
    if (send) state = 'sent';
    // The row says it was sent but the ledger holds no confirmed message:
    // shown as sent on the row's word, and labelled so.
    else if (step <= rowStep) state = 'sent_unproven';
    else if (failedSteps.has(step)) state = 'failed';
    else if (stoppedByReply) state = 'stopped';
    else if (status === 'done') state = 'not_sent';
    else if (nextDue && nextDue.nextStep === step) state = 'current';
    else if (step === 1 && text(lead.stage) === 'Queued') state = 'current';
    else state = 'pending';
    steps.push({
      step, label: STEP_LABELS[step - 1] || `Step ${step}`, state,
      sentAt: send ? send.sentAt : (state === 'sent_unproven' && step === rowStep ? iso(lead.lastEmailedAt) : ''),
      senderId: send ? send.senderId : '',
      dueAt: state === 'current' && nextDue ? nextDue.dueAtIso : '',
    });
  }
  const sentCount = steps.filter(item => item.state === 'sent' || item.state === 'sent_unproven').length;
  const summary = stoppedByReply ? `Stopped by reply after Step ${sentCount}`
    : status === 'done' ? (sentCount >= SEQUENCE_TIMING.touchCount ? 'Sequence complete' : `Sequence ended after Step ${sentCount}`)
      : status === 'emailed' ? `In sequence — Step ${sentCount} sent`
        : text(lead.stage) === 'Queued' ? 'Queued for Step 1'
          : 'Not started';
  return {
    steps, summary, stoppedByReply, emailStatus: status, emailStep: rowStep,
    nextFollowUpAt: nextDue ? nextDue.dueAtIso : '', nextFollowUpStep: nextDue ? nextDue.nextStep : null,
    followUpBlocked: follow && follow.blockedBy ? String(follow.blockedBy.reason || follow.blockedBy.code || 'blocked') : '',
  };
}

function buildCampaign(lead, profile) {
  const campaignId = text(lead.intendedCampaignVersion) || text(lead.campaign);
  const campaign = campaignId ? clientCampaign(campaignId) : null;
  const roles = (profile?.hiring?.roles || []).map(role => ({ raw: text(role.raw), clean: text(role.clean), status: text(role.status) }));
  const hiring = profile?.hiring || {};
  return {
    id: campaignId, label: campaign ? text(campaign.label) : '',
    primaryRole: roles[0] || null, secondaryRole: roles[1] || null,
    location: text(hiring.site), siteTie: text(hiring.siteTie),
    evidenceUrl: /^https?:\/\//i.test(text(hiring.evidenceUrl)) ? text(hiring.evidenceUrl) : '',
    postingDate: text(hiring.postingDate), verifiedAt: text(hiring.verifiedAt),
    context: text(hiring.context),
    relevantRoles30d: Number.isFinite(hiring.relevantRoles30d) ? hiring.relevantRoles30d : null,
    coreTradeRoles30d: Number.isFinite(hiring.coreTradeRoles30d) ? hiring.coreTradeRoles30d : null,
    personalizationStatus: text(profile?.personalization?.status),
    sector: text(profile?.company?.sector), tier: text(profile?.company?.tier),
  };
}

// What happens next, read off the client's existing stage and conversation
// status (pipeline.js / reply-policy.js). No second workflow: one sentence per
// state that already exists.
function nextActionFor({ stage, conversationStatus, sequence, suppression, meeting, clarifications }) {
  if (suppression && suppression.scope === 'global' && conversationStatus === 'closed_unsubscribed') {
    return { label: 'None — the contact opted out', owner: 'none', detail: 'Unsubscribed and globally suppressed. Never contact again.' };
  }
  if (stage === 'closed') return { label: 'None — conversation closed', owner: 'none', detail: conversationStatus ? conversationStatus.replace(/_/g, ' ') : 'Closed by reply or suppression.' };
  if (stage === 'qualified_held') return { label: 'None — qualified meeting held', owner: 'none', detail: 'Billable history.' };
  if (stage === 'meeting_held') return { label: 'Record the qualification verdict', owner: 'operator', detail: 'The meeting was held; qualification is pending or not met.' };
  if (stage === 'meeting_booked') return { label: 'Meeting booked', owner: 'operator', dueAt: meeting?.scheduledFor || '', detail: 'Hold the meeting, then record the outcome.' };
  if (stage === 'awaiting_clarification') return { label: 'Waiting on the client to answer', owner: 'client', detail: clarifications.map(item => item.question).filter(Boolean).join(' · ') };
  if (conversationStatus === 'needs_review' || conversationStatus === 'wrong_contact') return { label: 'Operator review of the reply', owner: 'operator', detail: conversationStatus.replace(/_/g, ' ') };
  if (stage === 'qualifying') return { label: 'Continue the conversation by hand', owner: 'operator', detail: conversationStatus ? conversationStatus.replace(/_/g, ' ') : '' };
  if (stage === 'replied') return { label: 'Review the reply', owner: 'operator', detail: '' };
  if (stage === 'contacted') {
    if (sequence.nextFollowUpAt) return { label: `Step ${sequence.nextFollowUpStep} — ${STEP_LABELS[sequence.nextFollowUpStep - 1] || 'follow-up'}`, owner: 'automation', dueAt: sequence.nextFollowUpAt, detail: 'Sends in the client’s next send window once due, subject to send authorization.' };
    if (sequence.followUpBlocked) return { label: 'Follow-up blocked', owner: 'operator', detail: sequence.followUpBlocked };
    return { label: 'Waiting for a reply', owner: 'none', detail: 'No further step is scheduled.' };
  }
  if (stage === 'queued') return { label: 'Step 1 — waiting for a send window', owner: 'automation', detail: '' };
  return { label: 'Not in outreach yet', owner: 'operator', detail: '' };
}

/**
 * @param lead         ONE lead, already scoped to the client by the caller
 * @param activities   activity rows (any; filtered here to this lead)
 * @param ledger       { available, opportunities, meetings, clarifications } for this client
 * @param senders      configured senders (any; filtered here to this client)
 * @param suppression  { suppressedEmails, clientEntries } — read-only inputs to evaluateScopedSuppression
 */
function buildClientConversationDetail({
  clientId, lead, activities = [], ledger = { available: false }, senders = [],
  suppression: suppressionInputs = {}, routedLeadReady = () => ({ ok: false }), env = process.env,
}) {
  const client = getClient(clientId);
  const mine = (activities || []).filter(row => activityBelongsToLead(row, lead));
  const identities = clientSenderIdentities(senders, client.id);
  const profile = readLeadProfile(lead);

  // Replies: this client's classified evidence only, newest first. The stored
  // body is the prospect's own words; the classification is kept beside it.
  const replies = mine
    .filter(row => text(row.eventType) === REPLY_EVENT_TYPE)
    .map(row => ({ row, data: meta(row) }))
    .filter(({ data }) => !data.clientId || data.clientId === client.id)
    .map(({ row, data }) => {
      const body = String(row.content == null ? '' : row.content);
      return {
        receivedAt: iso(row.occurredAt), subject: text(row.subject), body, bodyMayBeTruncated: body.length >= STORED_REPLY_CHARS,
        workflowState: text(data.workflowState), sentiment: text(data.sentiment), conversationStatus: text(data.conversationStatus),
        suppressionScope: text(data.suppressionScope),
        classifier: data.canonical ? { state: text(data.canonical.state), reason: text(data.canonical.reason), confidence: text(data.canonical.confidence) } : null,
        clarification: data.clarification && data.clarification.question ? { question: text(data.clarification.question) } : null,
        receivedOn: identityOf(data.senderInboxId, identities),
      };
    })
    .sort((a, b) => Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0));

  const confirmedSends = mine
    .filter(row => classifySendEvent(row) === 'confirmed')
    .map(row => ({
      eventType: text(row.eventType), step: sendStep(row), sentAt: iso(row.occurredAt),
      senderId: text(meta(row).senderInboxId), providerMessageId: providerMessageId(row),
    }))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const failedSteps = new Set(mine.filter(row => classifySendEvent(row) === 'failed').map(sendStep).filter(Boolean));

  const sender = buildSender({ client, lead, activities: mine, identities, confirmedSends });
  const sequence = buildSequence({ lead, activities: mine, confirmedSends, failedSteps, replies });

  const scoped = rows => (rows || []).filter(row => row.client_id === client.id && String(row.lead_id) === String(lead.id));
  const opportunity = scoped(ledger.opportunities)[0] || null;
  const meetings = scoped(ledger.meetings).sort((a, b) => Date.parse(b.scheduled_for || 0) - Date.parse(a.scheduled_for || 0));
  const clarifications = scoped(ledger.clarifications).filter(row => row.status === CLARIFICATION_STATUS.OPEN)
    .map(row => ({ question: text(row.question), topics: row.topics || [], openedAt: iso(row.created_at) }));
  const stage = pipelineStageFor(lead, {
    opportunity, meetings, openClarification: clarifications.length > 0, routingReady: routedLeadReady(lead, env).ok,
  });
  const stageDef = PIPELINE_STAGES.find(item => item.id === stage) || { label: stage, rule: '' };
  const conversationStatus = text(opportunity?.conversation_status) || (replies[0] ? replies[0].conversationStatus : '');
  const meeting = meetings[0] ? {
    status: text(meetings[0].meeting_status), scheduledFor: iso(meetings[0].scheduled_for), bookedAt: iso(meetings[0].booked_at),
  } : null;
  const suppressionVerdict = evaluateScopedSuppression(lead, {
    clientId: client.id, suppressedEmails: suppressionInputs.suppressedEmails || new Set(), clientEntries: suppressionInputs.clientEntries || null,
  });
  const closed = stage === 'closed' || CLOSED_CONVERSATIONS.has(conversationStatus);

  const contact = profile?.contact || {};
  const company = profile?.company || {};
  return {
    clientId: client.id, leadId: text(lead.id),
    contact: {
      name: text(lead.contactName) || [text(contact.firstName), text(contact.lastName)].filter(Boolean).join(' '),
      firstName: text(contact.firstName), lastName: text(contact.lastName),
      email: text(lead.email), title: text(contact.title), company: text(lead.company),
      city: text(contact.city), state: text(contact.state),
      linkedinUrl: /^https?:\/\//i.test(text(contact.linkedinUrl)) ? text(contact.linkedinUrl) : '',
      companyDomain: text(company.domain), companySize: text(company.size), buyerType: text(contact.buyerType),
    },
    replies: replies.slice(0, 10),
    sender,
    sequence,
    campaign: buildCampaign(lead, profile),
    pipeline: {
      stage, stageLabel: stageDef.label, stageRule: stageDef.rule,
      conversationStatus, qualificationStatus: text(opportunity?.qualification_status),
      clarificationRequired: clarifications.length > 0, clarifications,
      closed,
      suppression: suppressionVerdict ? { scope: suppressionVerdict.scope, code: suppressionVerdict.code, reason: text(suppressionVerdict.reason) } : null,
      ledgerAvailable: Boolean(ledger.available),
      nextAction: nextActionFor({ stage, conversationStatus, sequence, suppression: suppressionVerdict, meeting, clarifications }),
    },
    timestamps: {
      firstOutreachAt: confirmedSends[0]?.sentAt || '',
      lastOutreachAt: confirmedSends[confirmedSends.length - 1]?.sentAt || iso(lead.lastEmailedAt),
      replyReceivedAt: replies[0]?.receivedAt || '',
      nextFollowUpAt: sequence.nextFollowUpAt,
      meetingAt: meeting?.scheduledFor || '',
    },
    meeting,
  };
}

module.exports = { STEP_LABELS, senderDisplayLabel, clientSenderIdentities, buildClientConversationDetail };
