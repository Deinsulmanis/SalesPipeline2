'use strict';

/**
 * Shared workspace UI helpers. Used by the dashboard (browser) and by
 * frontend tests (Node). Pure: no fetches, no DOM, no writes.
 *
 * One workspace UI system, parameterized by the selected client. Do not add
 * client-name branches here — gate extras on public client fields
 * (billing.model, isDefault, navigation).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkspaceShared = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const STATUS_FILTERS = Object.freeze([
    Object.freeze({ id: 'all', label: 'All Leads' }),
    Object.freeze({ id: 'Import', label: 'Imported' }),
    Object.freeze({ id: 'Queued', label: 'Queued' }),
    Object.freeze({ id: 'Contacted', label: 'Contacted' }),
    Object.freeze({ id: 'Replied', label: 'Replied' }),
    Object.freeze({ id: 'Review', label: 'Review / Held' }),
    Object.freeze({ id: 'Unsubscribed', label: 'Unsubscribed / DNC' }),
    Object.freeze({ id: 'Bounced', label: 'Bounced' }),
    Object.freeze({ id: 'Done', label: 'Done' }),
  ]);

  const SHARED_WORKSPACES = Object.freeze(['outreach', 'campaigns', 'analytics', 'settings']);
  const GENUINE_REPLY = Object.freeze(['positive', 'negative', 'needs_human', 'unclassified', 'question']);

  function text(value) { return String(value == null ? '' : value).trim(); }
  function stageOf(lead) { return text(lead && lead.stage) || 'Import'; }
  function isUnsubscribed(lead) {
    const stage = stageOf(lead);
    const category = text(lead && lead.replyCategory).toLowerCase();
    const notes = text(lead && lead.notes);
    return stage === 'Unsub' || stage === 'Unsubscribed' || category === 'unsubscribe'
      || notes.includes('[REPLY: Unsubscribed]') || notes.includes('[DO NOT CONTACT]');
  }
  function everSent(lead) {
    if (!lead) return false;
    if (text(lead.lastEmailedAt)) return true;
    const step = Number(lead.emailStep);
    if (Number.isFinite(step) && step >= 1) return true;
    return ['emailed', 'replied'].includes(text(lead.emailStatus).toLowerCase());
  }
  function matchesStatusFilter(lead, filterId) {
    if (!filterId || filterId === 'all') return true;
    const stage = stageOf(lead);
    if (filterId === 'Import') return stage === 'Import';
    if (filterId === 'Queued') return stage === 'Queued';
    if (filterId === 'Contacted') return stage === 'Contacted';
    if (filterId === 'Replied') {
      return stage === 'Replied' || GENUINE_REPLY.includes(text(lead && lead.replyCategory).toLowerCase());
    }
    if (filterId === 'Review') return stage === 'Review' || Boolean(lead && lead.manualHold);
    if (filterId === 'Unsubscribed') return isUnsubscribed(lead);
    if (filterId === 'Bounced') return lead && lead.bounced === true;
    if (filterId === 'Done') return stage === 'Done';
    return stage === filterId;
  }
  function leadStatusCounts(leads) {
    const list = Array.isArray(leads) ? leads : [];
    const counts = { all: list.length, Import: 0, Queued: 0, Contacted: 0, Replied: 0, Review: 0, Unsubscribed: 0, Bounced: 0, Done: 0 };
    for (const lead of list) {
      for (const key of Object.keys(counts)) {
        if (key !== 'all' && matchesStatusFilter(lead, key)) counts[key] += 1;
      }
    }
    return counts;
  }
  function usesSharedWorkspace(name) {
    return SHARED_WORKSPACES.includes(name);
  }
  function shouldShowRevenuePanel(client) {
    return Boolean(client && !client.isDefault && client.billing && client.billing.model === 'per_qualified_held_meeting');
  }
  function serverStageForFilter(filterId) {
    if (!filterId || filterId === 'all') return 'all';
    if (filterId === 'Bounced' || filterId === 'Review') return null;
    return filterId;
  }
  function importVisibility(lead, extra) {
    const pers = extra && extra.personalization || {};
    const ready = pers.status === 'ready' || pers.status === 'NONE_REQUIRED';
    const blockers = [];
    if (lead && lead.manualHold) blockers.push('manual hold');
    if (lead && lead.suppressed) blockers.push('suppressed');
    if (lead && lead.bounced) blockers.push('bounced');
    if (pers.status && pers.status !== 'ready' && pers.status !== 'NONE_REQUIRED') blockers.push(pers.reason || pers.status);
    if (extra && extra.routingReady === false) blockers.push('routing not ready');
    if (!(lead && text(lead.senderInboxId))) blockers.push('no sender');
    return {
      personalized: Boolean(ready || text(lead && (lead.hyperPersonalizedOpening || lead.siteContext))),
      personalizationStatus: pers.status || '',
      sender: text(lead && lead.senderInboxId) || 'unassigned',
      sent: everSent(lead),
      blockers,
    };
  }
  function queuedVisibility(lead, extra) {
    return {
      sender: text(lead && (lead.senderEmail || lead.senderInboxId)) || 'unassigned',
      campaign: text(lead && (lead.campaign || lead.intendedCampaignVersion)) || '—',
      step: text(lead && lead.emailStep) || '1',
      sent: everSent(lead),
      provider: text(extra && extra.provider) || '',
      blocker: text(extra && extra.blocker) || (lead && lead.manualHold ? 'manual hold' : ''),
    };
  }
  function revenueFromMeetings(meetings, billing, client) {
    const rows = Array.isArray(meetings) ? meetings : [];
    const fee = Number(billing && billing.configuredFeeCents);
    const configuredFee = Number.isInteger(fee) && fee > 0
      ? fee
      : (Number.isInteger(client && client.billing && client.billing.performanceFeeCents) && client.billing.performanceFeeCents > 0
        ? client.billing.performanceFeeCents : null);
    const currency = (billing && billing.currency) || (client && client.billing && client.billing.currency) || null;
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const qualified = rows.filter(row => row.billable || row.meeting_status === 'QUALIFIED_HELD' || row.qualification_status === 'qualified');
    const thisMonth = rows.filter(row => String(row.scheduled_for || row.held_at || '').slice(0, 7) === monthKey);
    const paid = rows.filter(row => row.invoice_status === 'paid');
    const invoiced = rows.filter(row => row.invoice_status === 'invoiced' || row.invoice_status === 'paid');
    const outstanding = qualified.filter(row => row.invoice_status !== 'paid' && row.invoice_status !== 'void' && row.invoice_status !== 'not_billable');
    const sumFee = list => list.reduce((sum, row) => sum + (Number(row.performance_fee_cents) || configuredFee || 0), 0);
    const byCampaign = {};
    for (const row of rows) {
      const key = text(row.campaign_id) || 'unassigned';
      byCampaign[key] = (byCampaign[key] || 0) + 1;
    }
    return {
      totalMeetings: rows.length,
      qualifiedMeetings: qualified.length,
      meetingsThisMonth: thisMonth.length,
      meetingsByCampaign: byCampaign,
      feePerMeetingCents: configuredFee,
      feeConfigured: configuredFee != null,
      currency,
      earnedCents: billing && Number.isFinite(billing.accruedCents) ? billing.accruedCents : sumFee(qualified),
      invoicedCents: billing && Number.isFinite(billing.invoicedCents) ? billing.invoicedCents : sumFee(invoiced),
      paidCents: sumFee(paid),
      outstandingCents: sumFee(outstanding.filter(row => row.invoice_status !== 'invoiced')),
      missingFee: configuredFee == null,
    };
  }
  function partitionCampaigns(active, archived) {
    return {
      active: Array.isArray(active) ? active.filter(item => !item.archivedAt) : [],
      archived: Array.isArray(archived) ? archived : [],
    };
  }
  // The client catalog (GET /api/clients/:id) is the one source of campaign
  // display names. Leads, meetings and replies store the internal id (or the
  // campaign version), never the label, so a rename is one catalog edit.
  // Without a catalog (the default client) every value passes through as-is.
  function campaignEntry(value, catalog) {
    const key = text(value).toLowerCase();
    if (!key || !catalog) return null;
    const live = Array.isArray(catalog.campaigns) ? catalog.campaigns : [];
    const archived = Array.isArray(catalog.archivedCampaigns) ? catalog.archivedCampaigns : [];
    for (const item of live.concat(archived.map(entry => Object.assign({}, entry, { archivedAt: entry.archivedAt || true })))) {
      if (text(item.id).toLowerCase() === key || (item.campaignVersion && text(item.campaignVersion).toLowerCase() === key)) {
        return { id: item.id, label: text(item.label) || item.id, archived: Boolean(item.archivedAt) };
      }
    }
    return null;
  }
  function campaignDisplayName(value, catalog) {
    const entry = campaignEntry(value, catalog);
    return entry ? entry.label : text(value);
  }
  function isArchivedCampaign(value, catalog) {
    const entry = campaignEntry(value, catalog);
    return Boolean(entry && entry.archived);
  }

  return {
    STATUS_FILTERS, SHARED_WORKSPACES, GENUINE_REPLY,
    text, stageOf, isUnsubscribed, everSent, matchesStatusFilter, leadStatusCounts,
    usesSharedWorkspace, shouldShowRevenuePanel, serverStageForFilter,
    importVisibility, queuedVisibility, revenueFromMeetings, partitionCampaigns,
    campaignDisplayName, isArchivedCampaign,
  };
}));
