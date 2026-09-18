'use strict';

const crypto = require('crypto');
const { isStaffingCampaign, STAFFING_CAMPAIGN } = require('./staffing-campaign');
const { familyForLead } = require('./campaign-versions');
const { LEGACY_REPLY_EVENT_TYPES } = require('./canonical-reply');
const { EVENT_TYPE } = require('./staffing-agent-schema');

const LANDING_PAGE = 'https://scalelabai.ca/staffing/';
const THREAD_SNIPPET = 240;
const REPLY_SNIPPET = 1200;
const REPLY_EVENT_SET = new Set(LEGACY_REPLY_EVENT_TYPES);
const OUTBOUND_EVENT_SET = new Set(['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'human_response_sent']);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function notesHas(notes, pattern) {
  return pattern.test(String(notes || ''));
}

function firstNameOf(lead = {}) {
  return String(lead.firstName || lead.first || String(lead.contactName || '').split(/\s+/)[0] || '').trim();
}

function noteMarkers(notes) {
  return [...String(notes || '').matchAll(/\[([^\]]+)\]/g)].map(match => match[1].trim()).slice(0, 12);
}

function storedResearch(lead = {}, activities = []) {
  const facts = [];
  const opening = String(lead.hyperPersonalizedOpening || lead.siteContext || '').trim().slice(0, 240);
  let icpFit = '';
  for (const row of activities) {
    const meta = parseMetadata(row.metadata);
    const personalization = meta.personalization || meta.personalizationMetadata || {};
    if (personalization.icpFit && !icpFit) icpFit = String(personalization.icpFit);
    for (const fact of personalization.facts || personalization.validatedFacts || []) {
      if (fact && fact.kind && fact.value && facts.length < 8) {
        facts.push({ kind: String(fact.kind), value: clip(fact.value, 80) });
      }
    }
  }
  const high = String(lead.notes || '').match(/\[STAFFING\s+(HIGH|MEDIUM|LOW)\]/i);
  return {
    opening: opening || '',
    icpFit: icpFit || (high ? 'STORED' : ''),
    confidenceTag: high ? high[1].toUpperCase() : '',
    facts,
  };
}

function previousReplyAction(lead = {}, activities = []) {
  for (const row of [...activities].reverse()) {
    if (row.eventType === EVENT_TYPE) continue;
    if (REPLY_EVENT_SET.has(String(row.eventType || ''))) {
      const meta = parseMetadata(row.metadata);
      return String(meta.classification || row.eventType || '');
    }
  }
  const tag = String(lead.notes || '').match(/\[REPLY:\s*([^\]]+)\]/i);
  return tag ? tag[1].trim() : '';
}

function recentThread(activities = []) {
  return activities
    .filter(row => REPLY_EVENT_SET.has(row.eventType) || OUTBOUND_EVENT_SET.has(row.eventType))
    .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')))
    .slice(-4)
    .map(row => ({
      direction: OUTBOUND_EVENT_SET.has(row.eventType) ? 'outbound' : 'inbound',
      eventType: String(row.eventType || ''),
      at: String(row.occurredAt || ''),
      snippet: clip(row.content || row.subject || '', THREAD_SNIPPET),
    }));
}

function conversationState(lead = {}, activities = []) {
  const notes = String(lead.notes || '');
  const joined = activities.map(row => `${row.eventType}\n${row.content || ''}\n${row.metadata || ''}`).join('\n');
  const blob = `${notes}\n${joined}`;
  return {
    qualificationAsked: notesHas(notes, /\[STAFFING QUALIFICATION ASKED\]/i) || /qualification asked/i.test(blob),
    infoSent: notesHas(notes, /\[STAFFING INFO SENT\]/i) || blob.includes(LANDING_PAGE),
    qualificationReceived: notesHas(notes, /\[STAFFING QUALIFICATION RECEIVED\]/i),
    markedQualified: notesHas(notes, /\[STAFFING QUALIFIED\]/i),
    bookingLinkSent: activities.some(row => row.eventType === 'booking_link_sent')
      || notesHas(notes, /booking link sent/i),
  };
}

function buildStaffingAgentContext({ lead = {}, message = {}, replyText = '', activities = [] } = {}) {
  const inboundMessageId = String(message.messageId || message.id || '').trim();
  const threadId = String(message.threadId || parseMetadata(message.metadata).gmailThreadId || '').trim();
  const latestInboundReply = clip(replyText || message.body || message.snippet || '', REPLY_SNIPPET);
  const state = conversationState(lead, activities);
  const research = storedResearch(lead, activities);
  let campaignFamily = '';
  try { campaignFamily = familyForLead(lead); } catch (_) { campaignFamily = ''; }
  const context = {
    inboundMessageId,
    threadId,
    latestInboundReply,
    recentThread: recentThread(activities),
    lead: {
      id: String(lead.id || ''),
      email: String(lead.email || ''),
      firstName: firstNameOf(lead),
      contactName: String(lead.contactName || ''),
      company: String(lead.company || ''),
      title: String(lead.title || lead.jobTitle || ''),
      stage: String(lead.stage || ''),
      emailStatus: String(lead.emailStatus || ''),
      noteMarkers: noteMarkers(lead.notes),
    },
    campaign: {
      family: campaignFamily,
      offerId: isStaffingCampaign(lead) ? STAFFING_CAMPAIGN.id : '',
      name: String(lead.campaign || STAFFING_CAMPAIGN.name),
    },
    state: {
      ...state,
      previousReplyAction: previousReplyAction(lead, activities),
    },
    research,
  };
  const contextHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      inboundMessageId, threadId, latestInboundReply, leadId: context.lead.id,
      state, opening: research.opening,
    }))
    .digest('hex')
    .slice(0, 16);
  return Object.freeze({ ...context, contextHash });
}

function compactAgentUserPayload(context) {
  return {
    inboundMessageId: context.inboundMessageId,
    threadId: context.threadId,
    latestInboundReply: context.latestInboundReply,
    recentThread: context.recentThread,
    lead: context.lead,
    campaign: context.campaign,
    state: context.state,
    research: {
      opening: context.research.opening,
      icpFit: context.research.icpFit,
      facts: context.research.facts,
    },
  };
}

module.exports = {
  LANDING_PAGE, buildStaffingAgentContext, compactAgentUserPayload, conversationState,
};
