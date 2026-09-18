'use strict';

const { parseMetadata } = require('./campaign-versions');
const { ACTION } = require('./reply-response-policy');

const STAFFING_FUNNEL = Object.freeze({
  EMAIL_1_SENT: 'staffing_email_1_sent',
  EMAIL_2_SENT: 'staffing_email_2_sent',
  EMAIL_3_SENT: 'staffing_email_3_sent',
  LANDING_PAGE_SENT: 'staffing_landing_page_sent',
  INTERESTED_RECEIVED: 'staffing_interested_received',
  QUALIFICATION_ASKED: 'staffing_qualification_asked',
  QUALIFICATION_RECEIVED: 'staffing_qualification_received',
  QUALIFIED: 'staffing_qualified',
  SEND_INFO: 'staffing_send_info',
  BOOKING_LINK_SENT: 'staffing_booking_link_sent',
  MEETING_BOOKED: 'staffing_meeting_booked',
  NOT_NOW: 'staffing_not_now',
  NOT_INTERESTED: 'staffing_not_interested',
  UNSUBSCRIBE: 'staffing_unsubscribe',
  WRONG_PERSON: 'staffing_wrong_person',
  ALREADY_HANDLED: 'staffing_already_handled',
});

function staffingFunnelFromSend({ step, family, body = '' } = {}) {
  if (family !== 'industrial_staffing') return '';
  const n = Number(step);
  if (n === 1) return STAFFING_FUNNEL.EMAIL_1_SENT;
  if (n === 2) return STAFFING_FUNNEL.EMAIL_2_SENT;
  if (n === 3) return STAFFING_FUNNEL.EMAIL_3_SENT;
  if (String(body).includes('scalelabai.ca/staffing')) return STAFFING_FUNNEL.LANDING_PAGE_SENT;
  return '';
}

function staffingFunnelFromReply({ classification = '', action = '', family = '' } = {}) {
  if (family !== 'industrial_staffing') return '';
  const kind = String(classification || '').toUpperCase();
  if (kind === 'UNSUBSCRIBE') return STAFFING_FUNNEL.UNSUBSCRIBE;
  if (kind === 'NOT_INTERESTED') return STAFFING_FUNNEL.NOT_INTERESTED;
  if (kind === 'WRONG_PERSON') return STAFFING_FUNNEL.WRONG_PERSON;
  if (kind === 'ALREADY_HANDLED') return STAFFING_FUNNEL.ALREADY_HANDLED;
  if (kind === 'SEND_INFO') return STAFFING_FUNNEL.SEND_INFO;
  if (kind === 'INTERESTED') return STAFFING_FUNNEL.INTERESTED_RECEIVED;
  if (kind === 'STAFFING_QUALIFICATION') return STAFFING_FUNNEL.QUALIFICATION_RECEIVED;
  if (action === ACTION.AUTO_STAFFING_QUALIFY_QUESTION) return STAFFING_FUNNEL.QUALIFICATION_ASKED;
  if (action === ACTION.AUTO_STAFFING_QUALIFIED) return STAFFING_FUNNEL.QUALIFIED;
  if (action === ACTION.AUTO_STAFFING_SEND_INFO) return STAFFING_FUNNEL.SEND_INFO;
  if (action === ACTION.AUTO_TIMING_RECONTACT) return STAFFING_FUNNEL.NOT_NOW;
  return '';
}

function staffingFunnelFromWarmDelivery({ action = '', body = '', family = '' } = {}) {
  if (family !== 'industrial_staffing') return '';
  const tags = [];
  if (action === ACTION.AUTO_STAFFING_QUALIFY_QUESTION) tags.push(STAFFING_FUNNEL.QUALIFICATION_ASKED);
  if (action === ACTION.AUTO_STAFFING_SEND_INFO) tags.push(STAFFING_FUNNEL.LANDING_PAGE_SENT, STAFFING_FUNNEL.SEND_INFO);
  if (action === ACTION.AUTO_STAFFING_QUALIFIED) {
    tags.push(STAFFING_FUNNEL.QUALIFIED, STAFFING_FUNNEL.LANDING_PAGE_SENT, STAFFING_FUNNEL.BOOKING_LINK_SENT);
  }
  if (String(body).includes('scalelabai.ca/staffing') && !tags.includes(STAFFING_FUNNEL.LANDING_PAGE_SENT)) {
    tags.push(STAFFING_FUNNEL.LANDING_PAGE_SENT);
  }
  return tags;
}

function countStaffingFunnel(activities = []) {
  const counts = Object.fromEntries(Object.values(STAFFING_FUNNEL).map(key => [key, 0]));
  for (const row of activities) {
    const meta = parseMetadata(row.metadata);
    const keys = [].concat(meta.staffingFunnel || [], meta.staffingFunnelEvents || []).filter(Boolean);
    if (String(row.eventType) === 'call_booked' && meta.campaignFamily === 'industrial_staffing') {
      keys.push(STAFFING_FUNNEL.MEETING_BOOKED);
    }
    for (const key of keys) {
      if (counts[key] !== undefined) counts[key] += 1;
    }
  }
  return counts;
}

module.exports = {
  STAFFING_FUNNEL, staffingFunnelFromSend, staffingFunnelFromReply,
  staffingFunnelFromWarmDelivery, countStaffingFunnel,
};
