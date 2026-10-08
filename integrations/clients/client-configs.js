'use strict';

/**
 * Managed-client configuration. Source-controlled on purpose, like the
 * campaign registry: a client's send control, reply policy and billing terms
 * change only through a reviewed commit, never through a request.
 *
 * A "client" is a business ScaleLab runs outreach FOR. It is not a user of this
 * system. `platformAccess: 'none'` is asserted for every non-default client by
 * the registry, so a client-facing login cannot be configured by accident.
 *
 * Adding client #3 is a new entry here plus its campaigns in campaigns.js.
 */

const SCALELAB = Object.freeze({
  id: 'scalelab',
  displayName: 'ScaleLab AI',
  isDefault: true,
  lifecycleStatus: 'active',
  active: true,
  onboarding: null,
  activation: null,
  kind: 'operator',
  platformAccess: 'operator',
  // Dashboard workspaces (integrations/clients/navigation.js catalog).
  workspaces: Object.freeze(['clients', 'pipeline', 'inbox', 'bookings', 'outreach', 'archive', 'campaigns',
    'analytics', 'staffing', 'sequences', 'health', 'settings']),
  defaultWorkspace: 'pipeline',
  terminology: Object.freeze({ lead: 'lead', leads: 'leads', prospect: 'prospect' }),
  // The default client owns every record that asserts no other client. Its
  // legacy campaigns are recognised by the same family keywords
  // campaign-versions.js familyFromText() uses, so ownership and the legacy
  // family resolver can never disagree about what counts as ScaleLab.
  namespace: '',
  legacyFamilyKeywords: Object.freeze(['staffing', 'roof', 'dent']),
  sending: Object.freeze({
    enabled: true,
    // Existing production send authority (SENDING_ENABLED, SEND_AUTHORIZED_*)
    // continues to govern ScaleLab unchanged.
    requiresEnvAuthorization: false,
    // No client-scoped exclusion can exist until the ledger store is enabled
    // (writes need it), so ScaleLab keeps sending while it is unconfigured. A
    // configured store that cannot be read still refuses every client.
    clientSuppressionRequired: false,
  }),
  // Client-level send capacity, beneath the global system ceilings. null means
  // "no client cap": ScaleLab keeps exactly the shared global capacity it has
  // today. reservedDaily / reservedWindow hold back capacity other clients may
  // not consume; 0 until a managed client launches (set them together with
  // that client's caps, before its sending is enabled).
  capacity: Object.freeze({ dailyCap: null, windowCap: null, reservedDaily: 0, reservedWindow: 0 }),
  timezone: 'America/Vancouver',
  representative: null,
  escalation: Object.freeze({ owner: 'scalelab', channel: 'internal' }),
  conversationOwnership: Object.freeze({ owner: 'scalelab', until: 'closed', clarificationWorkflow: false }),
  booking: Object.freeze({ mode: 'google_calendar_sync' }),
  qualification: null,
  billing: Object.freeze({ model: 'none' }),
  reporting: Object.freeze({ ledger: false }),
  campaignDefaults: Object.freeze({}),
  replyPolicy: Object.freeze({
    // The existing reply pipeline, byte-for-byte. Nothing in the client layer
    // reinterprets a ScaleLab reply.
    mode: 'legacy',
    negativeReplySuppressionScope: 'global',
  }),
});

// Jole Enterprise — employer outreach for skilled-trades staffing.
const JOLE = Object.freeze({
  id: 'jole',
  displayName: 'Jole BTX LLC',
  isDefault: false,
  // ACTIVE CLIENT, NOT SENDING. Taken out of onboarding on 2026-10-05 by
  // explicit ScaleLab operator instruction. The three onboarding items are
  // recorded as attested by that instruction; they were not independently
  // verified inside SalesPipeline2. Client-active means the workspace, ledger,
  // campaign configuration and sender management are live. It grants NO send
  // authority: sending.enabled stays false, CLIENT_SENDING_AUTHORIZED does not
  // name Jole, client capacity stays 0 and every Jole sender starts paused.
  lifecycleStatus: 'active',
  active: true,
  onboarding: Object.freeze({
    agreementSigned: true,
    onboardingFormReturned: true,
    setupBalancePaid: true,
    setupBalanceDueCents: 0,
    currency: 'USD',
  }),
  activation: Object.freeze({ activatedBy: 'scalelab-operator (instruction 2026-10-05)', activatedAt: '2026-10-06T04:30:00.000Z' }),
  kind: 'managed_client',
  // The internal ScaleLab workspace for operating Jole. Navigation only — every
  // view is still scoped to Jole on the server.
  // Outreach is the shared lead directory ScaleLab already uses. Jole lands
  // there so Import / Queued sit in the same table, filters and cards.
  workspaces: Object.freeze(['clients', 'pipeline', 'inbox', 'bookings', 'outreach', 'campaigns', 'analytics', 'settings']),
  defaultWorkspace: 'outreach',
  terminology: Object.freeze({ lead: 'employer lead', leads: 'employer leads', prospect: 'employer' }),
  // Jole never operates SalesPipeline2. There is no login, account or
  // permission for it anywhere in this system.
  platformAccess: 'none',
  namespace: 'jole',
  legacyFamilyKeywords: Object.freeze([]),
  sending: Object.freeze({
    // DISABLED. Activation is a later, explicit instruction: flip this in a
    // reviewed commit AND name the client in CLIENT_SENDING_AUTHORIZED.
    enabled: false,
    requiresEnvAuthorization: true,
    clientSuppressionRequired: true,
  }),
  // Safe until launch: zero capacity. Real numbers are a launch decision and
  // are set in the same reviewed commit that enables sending.
  capacity: Object.freeze({ dailyCap: 0, windowCap: 0, reservedDaily: 0, reservedWindow: 0 }),
  // Who may send for Jole, and how much. Enforced by clients/sender-policy.js
  // at registry load and at every client-consistency check, so a mis-entered
  // registry row can never widen it.
  //  - Only mailboxes on the dedicated outbound domains. The corporate domain
  //    jolebtx.com is protected: never a cold sender, and no other client may
  //    use any of these domains either.
  //  - A Jole sender serves exactly the employer-acquisition campaign.
  //  - 20 cold emails per inbox per day is a HARD ceiling (higher configured
  //    values are clamped). Smartlead warmup mail is not counted here.
  //  - The launch ramp (8-10, then 12-15, then up to 20 per inbox per day after
  //    healthy placement) is an operator decision; nothing ramps automatically.
  senderPolicy: Object.freeze({
    outboundDomains: Object.freeze(['jolebtxteam.com', 'jolebtxgroup.com', 'joleindustrial.com']),
    protectedDomains: Object.freeze(['jolebtx.com']),
    allowedCampaignIds: Object.freeze(['jole-btx-employer-acquisition']),
    maxDailyPerInbox: 20,
  }),
  // Assumed; confirm with Jorge before launch (send windows are still the
  // shared Pacific windows until per-client windows exist).
  timezone: 'America/Chicago',
  timezoneConfirmed: false,
  representative: Object.freeze({
    name: 'Jorge Guerrero',
    role: 'Primary representative',
    operatesPlatform: false,
  }),
  // Who Jole's cold email is from. Every Jole sender uses this display name;
  // it never falls back to ScaleLab's FROM_NAME.
  senderIdentity: Object.freeze({ fromName: 'Jorge Guerrero', title: 'CEO', company: 'Jole BTX LLC' }),
  // Where Jole's copy reads its landing page and CAN-SPAM postal address.
  // Jole-only variables: neither falls back to ScaleLab's values.
  copyEnv: Object.freeze({ landingPageUrl: 'JOLE_LANDING_PAGE_URL', mailingAddress: 'JOLE_COMMERCIAL_MAILING_ADDRESS' }),
  escalation: Object.freeze({
    owner: 'scalelab',
    contactName: 'Jorge Guerrero',
    channel: 'external',
    note: 'ScaleLab asks Jorge outside SalesPipeline2, records the answer, and continues the employer conversation.',
  }),
  conversationOwnership: Object.freeze({
    owner: 'scalelab',
    until: 'meeting_booked',
    clarificationWorkflow: true,
    // A positive reply is qualified by ScaleLab, not forwarded to Jorge.
    handOffOnPositiveReply: false,
  }),
  booking: Object.freeze({
    // Meetings are recorded by a ScaleLab operator into the ledger. Jole's
    // calendar is not connected to this system.
    mode: 'operator_recorded',
    meetingWith: 'Jorge Guerrero',
    calendarConnected: false,
  }),
  qualification: Object.freeze({
    requireIcpFit: true,
    requireDecisionMaker: true,
    decisionMakerAreas: Object.freeze([
      'staffing', 'hiring', 'workforce', 'operations', 'hr', 'procurement',
      'vendor_selection', 'labor',
    ]),
    // Any legitimate staffing use case qualifies; an open requisition on the
    // meeting date is not required, and neither is a purchase.
    acceptedUseCases: Object.freeze(['current', 'upcoming', 'recurring', 'project_based']),
    openRequisitionRequired: false,
    purchaseRequired: false,
  }),
  billing: Object.freeze({
    model: 'per_qualified_held_meeting',
    performanceFeeCents: 35000,
    currency: 'USD',
    // The setup fee is billed outside this operational ledger.
    setupFee: 'tracked_outside_ledger',
  }),
  reporting: Object.freeze({ ledger: true }),
  campaignDefaults: Object.freeze({ leadType: 'jole_employer', sequenceSteps: 3 }),
  replyPolicy: Object.freeze({
    mode: 'managed',
    // "No thanks" to Jole is not "no thanks" to ScaleLab.
    negativeReplySuppressionScope: 'client',
    // Questions only Jole can answer. A match opens a clarification instead of
    // an answer being improvised.
    clarificationTopics: Object.freeze([
      Object.freeze({ id: 'rates', pattern: /\b(rates?|pricing|price|cost|markup|mark-up|bill rate|pay rate|fees?|how much)\b/i }),
      Object.freeze({ id: 'worker_supply', pattern: /\b(how many (workers|people|guys|men|electricians|welders|pipefitters)|headcount|crew size|availability|available workers?|bench)\b/i }),
      Object.freeze({ id: 'credentials', pattern: /\b(certif\w*|licen[cs]\w*|osha|journeyman|nccer|twic|credential\w*|background check|drug (test|screen)\w*)\b/i }),
      Object.freeze({ id: 'insurance', pattern: /\b(insurance|insured|workers'? comp\w*|liability|bond(ed|ing)?|coi)\b/i }),
      Object.freeze({ id: 'coverage', pattern: /\b(which states|what states|locations?|travel|per diem|relocat\w*|mobiliz\w*)\b/i }),
      Object.freeze({ id: 'timing', pattern: /\b(how (soon|fast|quickly)|lead time|start date|turnaround|mobilization time)\b/i }),
      Object.freeze({ id: 'terms', pattern: /\b(contract terms?|guarantee|replacement policy|minimum|conversion fee|temp[- ]to[- ]hire)\b/i }),
    ]),
    outsideIcpPatterns: Object.freeze([
      /\bwe (don'?t|do not) (do|have|hire|employ|use) (any )?(field|craft|union|electric\w*|mechanical|pip\w*|weld\w*|trades?)\b/i,
      /\bwe'?re (not|n'?t) a (contractor|construction company)\b/i,
      /\b(we are|we're) (an? )?(software|consulting|design|engineering only|staffing|recruiting) (firm|company|agency)\b/i,
      /\bno (data ?cent(er|re)|mission[- ]critical) (work|projects?)\b/i,
      /\bwe (only )?use (a )?union hall\b/i,
    ]),
    futureNeedPatterns: Object.freeze([
      /\b(next|upcoming|later this|early next|q[1-4]|spring|summer|fall|winter)\b.*\b(project|job|need|ramp|award|bid)/i,
      /\b(not right now|not at the moment|maybe later|keep (me|us) in mind|down the road|in the future|circle back)\b/i,
    ]),
  }),
});

const CLIENT_CONFIGS = Object.freeze([SCALELAB, JOLE]);

module.exports = { CLIENT_CONFIGS, SCALELAB, JOLE };
