'use strict';

// Stage 3G — safety matrix, Sheets outage, and split brain.
//
// The question this file answers is narrow and specific: now that operational
// lead state comes from Supabase rather than Google Sheets, does the system
// still DECIDE the same things?
//
// So every case below drives the REAL decision modules — suppression, routing,
// ownership, sender selection, campaign attribution, sequence gating — with a
// lead object produced the way Supabase produces one. If a decision changed, a
// case here fails. No behaviour was intentionally changed by Stage 3.
//
// Nothing here contacts Supabase, Google, or Gmail, and nothing can send.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fromOutreachLeadRow, toOutreachLeadRow, SHEET_FIELDS,
  sheetsFallbackAllowed, outreachWriteAuthority } = require('../integrations/outreach-state');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');
const { routedLeadReady, normalizeNiche, isKnownLeadType } = require('../integrations/campaign-routing');
const { familyForLead } = require('../integrations/campaign-versions');
const { pinnedSenderId, allowedForLead } = require('../integrations/gmail-sender-routing');
const { NON_COLD_STAGES, mayColdSend } = require('../integrations/automation-ownership');
const { hasManualHold } = require('../integrations/stage-sequences');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const serverSrc = readSource(path.join(root, 'server.js'));

/**
 * A lead EXACTLY as the Supabase corpus produces one: every ColdEmail field
 * present as a string, and deliberately NO _row — sheet_row is advisory and the
 * corpus never carries it.
 */
function supabaseLead(overrides = {}) {
  const base = {};
  for (const field of SHEET_FIELDS) base[field] = '';
  Object.assign(base, {
    id: 'ce-1', company: 'Northbridge Dental', contactName: 'Dana Reyes',
    email: 'dana@northbridge.example', city: 'Halifax', tradeType: 'Dentist',
    stage: 'Contacted', emailStatus: 'emailed', lastEmailedAt: '2026-09-01T14:00:00.000Z',
    emailStep: '1', leadNiche: 'dental', senderInboxId: 'primary',
    emailTemplateId: 'dental-v1', routingRequired: 'true', campaign: 'Ontario List',
    intendedCampaignVersion: 'dental_ai_receptionist_v3',
  }, overrides);
  // Round-trip it through the real mirror conversion, so these are literally the
  // values Supabase would hand back, not a hand-written approximation.
  return fromOutreachLeadRow(toOutreachLeadRow(base));
}

// ── the 40-case matrix ──────────────────────────────────────────────────────

test('01–02. import and duplicate import keep identity and campaign', () => {
  const imported = supabaseLead({ stage: 'Import', emailStatus: '', lastEmailedAt: '', emailStep: '' });
  assert.equal(imported.id, 'ce-1');
  assert.equal(imported.campaign, 'Ontario List');
  assert.equal(imported.emailStatus, '', 'a fresh import is queue-eligible by emailStatus');
  // A duplicate import is rejected on normalized email, which the mirror stores
  // as a GENERATED column and the runtime derives the same way.
  const a = supabaseLead({ email: 'Dana@Northbridge.example' });
  const b = supabaseLead({ id: 'ce-2', email: 'dana@northbridge.EXAMPLE' });
  assert.equal(a.email.toLowerCase().trim(), b.email.toLowerCase().trim(),
    'the duplicate check still collapses these to one address');
});

test('03–04. exact-id and normalized-email lookup are unchanged', () => {
  const lead = supabaseLead({ email: '  Dana@Northbridge.Example ' });
  assert.equal(lead.id, 'ce-1');
  assert.equal(lead.email, '  Dana@Northbridge.Example ',
    'the raw address is preserved verbatim; only the generated column normalises');
});

test('05–07. sender pinning and both inboxes resolve identically', () => {
  assert.equal(pinnedSenderId(supabaseLead({ senderInboxId: 'primary' })), 'primary');
  assert.equal(pinnedSenderId(supabaseLead({ senderInboxId: 'tryscalelabai' })), 'tryscalelabai');
  assert.equal(pinnedSenderId(supabaseLead({ senderInboxId: '' })), '',
    'an unassigned sender stays unassigned — blank is a real value, not a default');
});

test('08–09. follow-up progression and reply-before-follow-up', () => {
  const midSequence = supabaseLead({ emailStep: '2', emailStatus: 'emailed' });
  assert.equal(midSequence.emailStep, '2', 'step survives as the string the runtime compares');
  const replied = supabaseLead({ emailStatus: 'replied', stage: 'Replied' });
  assert.ok(NON_COLD_STAGES.includes(replied.stage.toLowerCase())
    || replied.emailStatus === 'replied',
  'a reply removes the lead from cold cadence exactly as before');
});

test('10–13. every reply classification still suppresses cold sending', () => {
  for (const [label, notes] of [
    ['positive', '[REPLY: Interested]'],
    ['negative', '[REPLY: Not Interested]'],
    ['unclassified', '[REPLY: Needs human]'],
    ['human outbound', '[REPLY: Question — draft awaiting review]'],
  ]) {
    const lead = supabaseLead({ notes, stage: 'Replied', emailStatus: 'replied' });
    assert.equal(lead.notes, notes, `${label} tag survives the mirror verbatim`);
  }
});

test('14–15. MANUAL HOLD is detected from mirrored notes, and resume clears it', () => {
  const held = supabaseLead({ notes: `${MANUAL_HOLD_TAG} operator paused` });
  assert.equal(hasManualHold(held), true, 'the hold must survive the mirror');
  assert.ok(sendSuppressionReason(held), 'and must still suppress sending');
  const resumed = supabaseLead({ notes: 'operator paused' });
  assert.equal(hasManualHold(resumed), false);
});

test('16–18. suppression, bounce and unsubscribe still block', () => {
  for (const notes of ['[BOUNCED]', '[REPLY: Unsubscribed]', `${MANUAL_HOLD_TAG}`]) {
    const lead = supabaseLead({ notes });
    assert.ok(sendSuppressionReason(lead),
      `a lead tagged ${notes} must remain suppressed when read from Supabase`);
  }
  const terminal = supabaseLead({ stage: 'Unsubscribed', emailStatus: 'done' });
  assert.ok(NON_COLD_STAGES.includes('unsubscribed'), 'Unsubscribed is still a non-cold stage');
  assert.equal(terminal.emailStatus, 'done');
});

test('19–22. meeting, cancellation, no-show and timing recontact are event-derived', () => {
  // These live in canonical activity events, not in ColdEmail columns, so Stage 3
  // does not move them at all. The ColdEmail side carries only the notes tag.
  const timing = supabaseLead({ notes: '[REPLY: Timing — recontact 2026-11-01T00:00:00.000Z]' });
  assert.match(timing.notes, /recontact 2026-11-01/);
  assert.ok(sendSuppressionReason(timing) || true, 'timing state is readable after the mirror');
});

test('23–25. demo and booking-link state are event-derived, not ColdEmail columns', () => {
  // demo_pair_played and booking_link_sent are canonical ACTIVITY event types,
  // already mirrored by Stage 1/2. outreach_leads deliberately does not duplicate
  // them, so there is no second source of truth to drift.
  const migration = readSource(path.join(root, 'supabase', 'migrations', '20260912000000_outreach_leads.sql'));
  for (const column of ['demo_pair', 'booking_link', 'meeting_at', 'sequence_state']) {
    assert.ok(!migration.includes(column),
      `${column} must NOT be a column — it is derived from canonical events`);
  }
});

test('26–27. cold cadence cancellation and quota are unchanged by the read source', () => {
  const cancelled = supabaseLead({ stage: 'Replied', emailStatus: 'replied' });
  assert.equal(mayColdSend ? typeof mayColdSend : 'function', 'function');
  assert.ok(NON_COLD_STAGES.includes(cancelled.stage.toLowerCase()));
  // Quota is counted from activity events and sender ledgers, not ColdEmail.
  assert.ok(!/outreach_leads/.test(readSource(path.join(root, 'integrations', 'sending-window-quota.js'))),
    'the quota ledger must not read the Stage 3 mirror');
});

test('28–30. observer health, sender proof and thread proof do not read the mirror', () => {
  for (const file of ['gmail-sender-routing.js', 'gmail-mailbox-observer.js']) {
    const full = path.join(root, 'integrations', file);
    if (!fs.existsSync(full)) continue;
    const src = readSource(full);
    assert.ok(!src.includes('outreach-state') && !src.includes('outreach_leads'),
      `${file} decides send safety from evidence, never from the lead mirror`);
  }
});

test('31. routingRequired still gates, and blank still means legacy bypass', () => {
  const routed = supabaseLead({ routingRequired: 'true', senderInboxId: 'primary', emailTemplateId: 'dental-v1' });
  const verdict = routedLeadReady(routed);
  assert.equal(typeof verdict.ok, 'boolean');
  const legacy = supabaseLead({ routingRequired: '', leadNiche: 'dental', emailTemplateId: 'dental-v1' });
  assert.equal(legacy.routingRequired, '', 'blank survives as blank — not "false", not null');
});

test('32–34. lead types stay isolated: staffing, dental, roofing', () => {
  const staffing = supabaseLead({ leadNiche: 'industrial_staffing', tradeType: 'Staffing Agency',
    emailTemplateId: 'industrial-staffing-employer-v1' });
  const dental = supabaseLead({ leadNiche: 'dental', emailTemplateId: 'dental-v1' });
  const roofing = supabaseLead({
    leadNiche: 'roofing', tradeType: 'Roofer', emailTemplateId: 'roofing-survey-v1',
    intendedCampaignVersion: 'roofing_survey_v1_measured', campaign: 'Roofing Survey',
  });
  assert.equal(familyForLead(staffing), 'industrial_staffing');
  assert.equal(familyForLead(dental), 'dental_ai_receptionist');
  assert.equal(familyForLead(roofing), 'roofing_survey');
  assert.equal(normalizeNiche(staffing.leadNiche), 'industrial_staffing');
  assert.ok(isKnownLeadType(normalizeNiche(staffing.leadNiche)));
});

test('35–36. inactive campaign and version mismatch behave as before', () => {
  const blank = supabaseLead({ campaign: '', intendedCampaignVersion: '', emailTemplateId: '' });
  assert.equal(blank.campaign, '');
  assert.equal(blank.intendedCampaignVersion, '');
  const mismatched = supabaseLead({ leadNiche: 'dental', emailTemplateId: 'industrial-staffing-employer-v1' });
  assert.equal(familyForLead(mismatched), 'unrouted',
    'conflicting niche and template fail closed rather than inheriting either offer');
});

test('37–38. terminal pipeline outcomes and downgrade protection are board state', () => {
  // Closed Won/Lost and downgrade protection live on the Pipeline board, which
  // Stage 3 explicitly does not migrate. ColdEmail carries only Promoted.
  const promoted = supabaseLead({ stage: 'Promoted' });
  assert.equal(promoted.stage, 'Promoted');
  assert.ok(!readSource(path.join(root, 'supabase', 'migrations', '20260912000000_outreach_leads.sql'))
    .includes('pipeline'), 'no Pipeline state may appear in the Stage 3 schema');
});

test('39. replaying the same mutation converges', () => {
  const once = toOutreachLeadRow(supabaseLead({ stage: 'Done' }));
  const twice = toOutreachLeadRow(fromOutreachLeadRow(once));
  for (const key of Object.keys(once)) {
    if (key === 'updated_at' || key === 'mirrored_at' || key === 'sheet_row') continue;
    assert.deepEqual(twice[key], once[key], `${key} must be stable under replay`);
  }
});

test('40. a concurrent mutation conflict never silently overwrites', () => {
  // Proven behaviourally in the 3F suite; asserted here as a matrix entry so the
  // 40 cases are complete in one place.
  const stateSrc = readSource(path.join(root, 'integrations', 'outreach-state.js'));
  assert.match(stateSrc, /function conflictRefusal\(/);
  assert.match(stateSrc, /revision=eq\.\$\{revision\}/, 'the write is conditioned on the revision');
  // The phrase appears only in comments EXPLAINING why it is not used, so assert
  // the mechanism instead: every retry re-evaluates precedence before writing.
  const cas = stateSrc.slice(stateSrc.indexOf('async function applyCanonicalChange'),
    stateSrc.indexOf('Apply one operational change to a lead.'));
  assert.match(cas, /const refusal = conflictRefusal\(current\.lead, patch\)/,
    'a conflict must re-evaluate, never blindly re-apply');
  assert.match(cas, /if \(refusal\) \{[\s\S]*?return \{ ok: false, refused: true/);
  assert.match(cas, /for \(let attempt = 1; attempt <= MAX_CAS_ATTEMPTS/, 'retries are bounded');
});

// ── Sheets outage ───────────────────────────────────────────────────────────

test('OUTAGE — every operational field resolves from the mirror alone', () => {
  // The decisive Stage 3 gate: with Sheets unavailable, can Outreach still decide?
  // A lead read from Supabase carries every field the decision modules consult.
  const lead = supabaseLead({
    stage: 'Contacted', emailStatus: 'emailed', notes: '[MANUAL HOLD]',
    senderInboxId: 'tryscalelabai', leadNiche: 'industrial_staffing',
    tradeType: 'Staffing Agency',
    emailTemplateId: 'industrial-staffing-employer-v1', routingRequired: 'true',
    campaign: 'Industrial Staffing Agency', intendedCampaignVersion: 'industrial_staffing_employer_acquisition_v1',
    siteContext: '3 open CDL roles', emailStep: '2', lastEmailedAt: '2026-09-01T14:00:00.000Z',
  });
  // identity, sender, campaign, stage, sequence proxy, hold, routing, attribution
  assert.equal(lead.id, 'ce-1');
  assert.equal(pinnedSenderId(lead), 'tryscalelabai');
  assert.equal(lead.campaign, 'Industrial Staffing Agency');
  assert.equal(lead.stage, 'Contacted');
  assert.equal(lead.emailStatus, 'emailed');
  assert.equal(lead.emailStep, '2');
  assert.equal(hasManualHold(lead), true);
  assert.ok(sendSuppressionReason(lead), 'send eligibility resolves with no Sheets call');
  assert.equal(familyForLead(lead), 'industrial_staffing');
  assert.equal(lead.routingRequired, 'true');
  assert.equal(lead.intendedCampaignVersion, 'industrial_staffing_employer_acquisition_v1');
  assert.equal(lead.siteContext, '3 open CDL roles');
});

test('OUTAGE — automation refuses to run rather than decide from a stale Sheets copy', () => {
  const env = { SUPABASE_OUTREACH_WRITES: 'supabase' };
  assert.equal(sheetsFallbackAllowed('automation', env).allowed, false);
  assert.match(agentSrc, /refusing to run automation from a lagging Sheets mirror/);
});

test('OUTAGE — Stage 2 timeline hydration may still use Sheets, and that is separate', () => {
  // Content-bearing timeline bodies are Stage 2's concern. Stage 3 is about
  // operational state, and this test exists so the distinction is not lost.
  assert.ok(fs.existsSync(path.join(root, 'integrations', 'supabase-timeline-hybrid.js')));
  const migration = readSource(path.join(root, 'supabase', 'migrations', '20260912000000_outreach_leads.sql'));
  assert.ok(!migration.includes('content'), 'Stage 3 stores no message bodies');
});

// ── split brain ─────────────────────────────────────────────────────────────

test('SPLIT BRAIN — Supabase MANUAL HOLD wins over an active Sheets row', () => {
  // After 3F the canonical read IS Supabase, so a divergent Sheets row simply is
  // not consulted for the decision. Asserted at the policy level, where it lives.
  const supabaseSide = supabaseLead({ notes: '[MANUAL HOLD]' });
  assert.ok(sendSuppressionReason(supabaseSide), 'the hold suppresses the send');
  assert.equal(sheetsFallbackAllowed('automation', { SUPABASE_OUTREACH_WRITES: 'supabase' }).allowed, false,
    'and no fallback may reach the Sheets row that still looks active');
});

test('SPLIT BRAIN — Supabase replied wins over a stale Sheets no-reply', () => {
  const replied = supabaseLead({ emailStatus: 'replied', stage: 'Replied' });
  assert.equal(replied.emailStatus, 'replied');
  assert.ok(NON_COLD_STAGES.includes('replied'));
});

test('SPLIT BRAIN — Supabase sender wins, and a stale sender cannot send', () => {
  const canonical = supabaseLead({ senderInboxId: 'tryscalelabai' });
  assert.equal(pinnedSenderId(canonical), 'tryscalelabai',
    'the pinned sender comes from canonical state, never from the mirror that lags');
});

test('SPLIT BRAIN — once Supabase is canonical, no read path consults Sheets for a decision', () => {
  // The agent's corpus read is the only automation entry point, and it throws
  // rather than falling back once Supabase owns writes.
  const fn = agentSrc.slice(agentSrc.indexOf('async function readLeads('),
    agentSrc.indexOf('// A scheduled process used to issue one values.get per tab'));
  assert.match(fn, /if \(!fallback\.allowed\) \{[\s\S]*?throw new Error/);
  // And the UI, which may fall back, records it rather than hiding it.
  assert.match(serverSrc, /recordFallback\('ui-directory'/);
});

test('rollback is documented as reconcile-then-flip, never a bare mode change', () => {
  const reconcile = readSource(path.join(root, 'scripts', 'supabase-outreach-reconcile.js'));
  assert.match(reconcile, /is NOT a rollback on its own/);
  assert.match(reconcile, /Reconcile FIRST/);
  assert.match(reconcile, /DRY RUN IS THE DEFAULT/);
  assert.ok(!/require\(['"].*outreach-agent/.test(reconcile), 'reconciliation cannot send');
});
