'use strict';

/**
 * Client-aware navigation for the internal operator dashboard.
 *
 * ONE catalog of workspaces, shared by every client. A client's config names
 * the workspaces it has (`workspaces`) and where it lands (`defaultWorkspace`);
 * the sidebar is the catalog filtered by that list, in catalog order, grouped
 * into the catalog's sections. Adding a client never means writing another
 * sidebar.
 *
 * Navigation is a convenience, never a security boundary: every client-scoped
 * API still resolves the client and filters on the server.
 */

const SECTIONS = Object.freeze([
  Object.freeze({ id: 'clients', label: 'Clients' }),
  Object.freeze({ id: 'sales', label: 'Sales' }),
  Object.freeze({ id: 'growth', label: 'Growth' }),
  Object.freeze({ id: 'system', label: 'System' }),
]);

// `managedContext` is the header line when a managed client is selected.
const WORKSPACE_CATALOG = Object.freeze([
  Object.freeze({ id: 'clients', label: 'Client Ops', section: 'clients', managedContext: 'Client overview: status, leads, sending, replies, meetings and billing' }),
  Object.freeze({ id: 'pipeline', label: 'Pipeline', section: 'sales', managedContext: 'Employer prospects by stage, from import to qualified meeting' }),
  Object.freeze({ id: 'inbox', label: 'Inbox', section: 'sales', managedContext: 'Replies, qualification and questions awaiting the client' }),
  Object.freeze({ id: 'bookings', label: 'Bookings', section: 'sales', managedContext: 'Meeting ledger: booked, held, qualified and billable' }),
  Object.freeze({ id: 'outreach', label: 'Outreach', section: 'growth', managedContext: 'Prospect directory' }),
  Object.freeze({ id: 'archive', label: 'Archive', section: 'growth', managedContext: 'Archived leads and their full history' }),
  Object.freeze({ id: 'campaigns', label: 'Campaigns', section: 'growth', managedContext: 'Campaigns, readiness and performance' }),
  Object.freeze({ id: 'analytics', label: 'Analytics', section: 'growth', managedContext: 'Funnel, campaign, meeting and billing performance' }),
  Object.freeze({ id: 'staffing', label: 'Staffing Funnel', section: 'growth', managedContext: 'Tracked link funnel' }),
  Object.freeze({ id: 'sequences', label: 'Sequences', section: 'growth', managedContext: 'Stage sequences' }),
  Object.freeze({ id: 'health', label: 'CRM Health', section: 'system', managedContext: 'System status' }),
  Object.freeze({ id: 'settings', label: 'Settings', section: 'system', managedContext: 'Client status, send capacity and sending inboxes' }),
]);

const WORKSPACE_IDS = Object.freeze(WORKSPACE_CATALOG.map(item => item.id));

function validateWorkspaces(config) {
  const list = config.workspaces;
  if (!Array.isArray(list) || !list.length) throw new Error(`Client config ${config.id}: workspaces must be a non-empty list`);
  const unknown = list.filter(id => !WORKSPACE_IDS.includes(id));
  if (unknown.length) throw new Error(`Client config ${config.id}: unknown workspace(s) ${unknown.join(', ')}`);
  if (new Set(list).size !== list.length) throw new Error(`Client config ${config.id}: duplicate workspace`);
  if (!list.includes(config.defaultWorkspace)) throw new Error(`Client config ${config.id}: defaultWorkspace must be one of its workspaces`);
  return true;
}

/** { defaultWorkspace, workspaces, sections: [{ id, label, items: [{ id, label, managedContext }] }] } */
function navigationFor(config) {
  const enabled = new Set(config.workspaces || []);
  const sections = SECTIONS.map(section => ({
    id: section.id, label: section.label,
    items: WORKSPACE_CATALOG.filter(item => item.section === section.id && enabled.has(item.id))
      .map(item => ({ id: item.id, label: item.label, managedContext: item.managedContext })),
  })).filter(section => section.items.length);
  return {
    defaultWorkspace: config.defaultWorkspace,
    workspaces: sections.flatMap(section => section.items.map(item => item.id)),
    sections,
  };
}

/** The workspace to show for a client: the requested one if it has it, else its default. */
function resolveWorkspace(config, requested) {
  return (config.workspaces || []).includes(requested) ? requested : config.defaultWorkspace;
}

module.exports = { SECTIONS, WORKSPACE_CATALOG, WORKSPACE_IDS, validateWorkspaces, navigationFor, resolveWorkspace };
