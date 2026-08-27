'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFunnelAnalytics, rate } = require('../integrations/funnel-analytics');

const VERSION = 'dental_v1_measured';
const sendMeta = (step = 1, extra = {}) => ({ campaignVersion: VERSION, campaignFamily: 'dental_ai_receptionist', sequenceId: 'dental_ai_receptionist_cold', sequenceStep: step, copyVersion: 'dental_risk_reversal_hp_v1', subjectStrategy: 'service_curiosity_v1', personalizationLevel: 2, personalizationAngle: 'invisalign', ...extra });
const event = (lead, type, at, metadata = {}) => ({ eventId: `${lead}:${type}:${at}`, leadId: `CE-${lead}`, sourceLeadId: lead, email: `${lead}@test.ca`, company: lead, eventType: type, occurredAt: at, subject: '', content: '', metadata: JSON.stringify(metadata) });
const send = (lead, at, step = 1, metadata = sendMeta(step)) => event(lead, step === 1 ? 'initial_email_sent' : 'follow_up_sent', at, metadata);
const reply = (lead, at, category = 'INTERESTED', touch = sendMeta(1)) => event(lead, category === 'INTERESTED' ? 'positive_reply' : category === 'NOT_INTERESTED' ? 'negative_reply' : 'needs_human_reply', at, { classification: category, replyTouch: touch });
const promote = (lead, at, toStage = 'hot') => event(lead, 'pipeline_promoted', at, { toStage, acquisitionCampaignVersion: VERSION, acquisitionCampaignFamily: 'dental_ai_receptionist', acquisitionSourceEventId: `${lead}:send` });

function fixture() {
  const leads = ['l1','l2','l3','legacy','unresolved'].map(id => ({ id, email: `${id}@test.ca`, company: id }));
  const activities = [
    send('l1','2026-08-01T10:00:00Z'), send('l1','2026-08-03T10:00:00Z',2), reply('l1','2026-08-04T10:00:00Z'),
    event('l1','demo_pair_played','2026-08-05T10:00:00Z'), promote('l1','2026-08-05T11:00:00Z'), event('l1','call_booked','2026-08-06T10:00:00Z',{meetingAt:'2026-08-10T18:00:00Z'}), event('l1','meeting_completed','2026-08-10T19:00:00Z',{meetingAt:'2026-08-10T18:00:00Z'}),
    send('l2','2026-08-02T10:00:00Z'), reply('l2','2026-08-03T10:00:00Z','NOT_INTERESTED'), promote('l2','2026-08-04T10:00:00Z'), event('l2','call_booked','2026-08-05T10:00:00Z',{meetingAt:'2026-08-07T18:00:00Z'}), event('l2','meeting_no_show','2026-08-07T19:00:00Z',{meetingAt:'2026-08-07T18:00:00Z'}),
    send('l3','2026-08-03T10:00:00Z'), reply('l3','2026-08-04T10:00:00Z','NEEDS_HUMAN'), promote('l3','2026-08-05T10:00:00Z'), event('l3','call_booked','2026-08-06T10:00:00Z',{meetingAt:'2026-08-09T18:00:00Z'}), event('l3','meeting_cancelled','2026-08-08T10:00:00Z',{meetingAt:'2026-08-09T18:00:00Z'}),
    send('unresolved','2026-08-04T10:00:00Z'), promote('unresolved','2026-08-05T10:00:00Z'), event('unresolved','call_booked','2026-08-06T10:00:00Z',{meetingAt:'2026-08-07T18:00:00Z'}),
    send('legacy','2026-07-01T10:00:00Z',1,{gmailThreadId:'old'}),
    event('l1','sequence_enrolled','2026-08-11T10:00:00Z',{sequenceId:'no_show_recovery_v1'}), event('l1','sequence_step_sent','2026-08-12T10:00:00Z',{sequenceId:'no_show_recovery_v1'}), event('l1','sequence_stopped','2026-08-13T10:00:00Z',{sequenceId:'no_show_recovery_v1',reason:'reply received'}),
  ];
  const replyRecords = [
    {leadId:'l1',category:'positive'},{leadId:'l2',category:'negative'},{leadId:'l3',category:'needs_human'},{leadId:'legacy',category:'unclassified'},
  ];
  const boardLeads = [
    {id:'CE-l1',email:'l1@test.ca',stage:'closed_won',outcome:''},{id:'CE-l2',email:'l2@test.ca',stage:'closed_lost',outcome:'not_interested'},
    {id:'CE-l3',email:'l3@test.ca',stage:'call_booked',meetingAt:'2026-08-09T18:00:00Z'},{id:'CE-unresolved',email:'unresolved@test.ca',stage:'call_booked',meetingAt:'2026-08-07T18:00:00Z'},
  ];
  return { leads, activities, replyRecords, boardLeads, currentVersion: VERSION };
}

test('unique-lead funnel deduplicates repeated sends and replies', () => {
  const result = buildFunnelAnalytics(fixture(), {version:'current'});
  assert.equal(result.counts.sent,4); assert.equal(result.eventCounts.emailsSent,5);
  assert.equal(result.counts.replied,3); assert.equal(result.counts.positive,1);
});
test('reply categories partition the canonical replied leads', () => {
  const c = buildFunnelAnalytics(fixture(), {version:VERSION}).counts;
  assert.deepEqual({positive:c.positive,negative:c.negative,needsHuman:c.needsHuman,unclassified:c.unclassified},{positive:1,negative:1,needsHuman:1,unclassified:0});
});
test('meaningful demo is unique and ordinary opens are absent from the model', () => assert.equal(buildFunnelAnalytics(fixture(), {version:VERSION}).counts.demo,1));
test('Hot and downstream stages require matching immutable acquisition attribution', () => {
  const c = buildFunnelAnalytics(fixture(), {version:VERSION}).counts;
  assert.equal(c.hot,4); assert.equal(c.callBooked,4); assert.equal(c.callHeld,1);
});
test('past unresolved and no-show meetings are never counted as held', () => {
  const c = buildFunnelAnalytics(fixture(), {version:VERSION}).counts;
  assert.equal(c.callHeld,1); assert.equal(c.noShow,1); assert.equal(c.cancelled,1); assert.equal(c.callBooked,4);
});
test('won, lost, win rate and show rate use only resolved denominators', () => {
  const result = buildFunnelAnalytics(fixture(), {version:VERSION});
  assert.equal(result.counts.won,1); assert.equal(result.counts.lost,1);
  assert.equal(result.conversions.winRate,50); assert.equal(result.conversions.showRate,50);
});
test('legacy and measured cohorts remain separate while Lifetime includes both', () => {
  assert.equal(buildFunnelAnalytics(fixture(), {version:LEGACY}).counts.sent,2);
  assert.equal(buildFunnelAnalytics(fixture(), {version:VERSION}).counts.sent,4);
  assert.equal(buildFunnelAnalytics(fixture(), {version:'lifetime'}).counts.sent,5);
});
test('historical ColdEmail send state enters only legacy/Lifetime, never measured', () => {
  const input={leads:[{id:'old',email:'old@test.ca',emailStatus:'replied',lastEmailedAt:'2026-07-01T00:00:00Z'}],replyRecords:[{leadId:'old',category:'positive'}],activities:[],boardLeads:[],currentVersion:VERSION};
  assert.equal(buildFunnelAnalytics(input,{version:VERSION}).counts.sent,0);
  const legacy=buildFunnelAnalytics(input,{version:LEGACY}); assert.equal(legacy.counts.sent,1); assert.equal(legacy.counts.positive,1); assert.equal(legacy.eventCounts.historicalSendStates,1);
});
const LEGACY = 'legacy_unknown';
test('personalization, angle, subject and copy filters compose', () => {
  const input = fixture();
  assert.equal(buildFunnelAnalytics(input,{version:VERSION,personalizationLevel:'2',angle:'invisalign',subjectStrategy:'service_curiosity_v1',copyVersion:'dental_risk_reversal_hp_v1'}).counts.sent,4);
  assert.equal(buildFunnelAnalytics(input,{version:VERSION,personalizationLevel:'3'}).counts.sent,0);
});
test('date range cohorts on qualifying send and retains later outcomes', () => {
  const result = buildFunnelAnalytics(fixture(), {version:VERSION,from:'2026-08-01',to:'2026-08-01'});
  assert.equal(result.counts.sent,1); assert.equal(result.counts.won,1);
});
test('stage sequence attribution cannot overwrite acquisition funnel', () => {
  const input=fixture(); input.activities.push(send('l1','2026-08-14T10:00:00Z',1,{campaignVersion:VERSION,sequenceId:'no_show_recovery_v1',sequenceStep:1,copyVersion:'no_show_recovery_v1',subjectStrategy:'conversation_thread_v1'}));
  assert.equal(buildFunnelAnalytics(input,{version:VERSION}).counts.won,1);
});
test('reply-touch report remains tactical and names sequence step', () => {
  const rows=buildFunnelAnalytics(fixture(),{version:VERSION}).replyTouch;
  assert.ok(rows.some(row=>row.sequenceId==='dental_ai_receptionist_cold'&&row.step===1&&row.replies===3));
});
test('recovery sequence performance is separate from acquisition funnel', () => {
  const rows=buildFunnelAnalytics(fixture(),{version:VERSION}).sequencePerformance;
  assert.deepEqual(rows.find(row=>row.sequenceId==='no_show_recovery_v1'),{sequenceId:'no_show_recovery_v1',enrolled:1,sends:1,replies:1,positive:1,rebookings:0,completed:0,stoppedByReply:1,stoppedByBooking:0});
});
test('zero denominator is safe null, never NaN or Infinity', () => { assert.equal(rate(0,0),null); assert.equal(buildFunnelAnalytics({currentVersion:VERSION},{version:VERSION}).conversions.winRate,null); });
test('clickable stage IDs exactly reconcile with their counts', () => {
  const result=buildFunnelAnalytics(fixture(),{version:VERSION});
  for(const [key,ids] of Object.entries(result.stageLeadIds)) assert.equal(ids.length,result.counts[key]);
});
test('server endpoint uses the shared snapshot and returns bounded drill-downs', () => {
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const body=server.slice(server.indexOf("app.get('/api/coldemail/funnel'"),server.indexOf('// The DemoPlays header'));
  assert.match(body,/getOutreachDataset/); assert.match(body,/slice\(offset, offset \+ requested\)/); assert.doesNotMatch(body,/spreadsheets\.values\.get|sendEmail/);
});
test('Outreach keeps operational cards and renders a responsive campaign funnel', () => {
  const ui=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  assert.match(ui,/id="ce-stat-total"/); assert.match(ui,/id="ce-funnel-analytics"/); assert.match(ui,/@media\(max-width:600px\)[\s\S]*funnel-flow/); assert.match(ui,/openCeDetail/);
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 13 — gaps found while auditing the partial implementation.
// ─────────────────────────────────────────────────────────────────────────────

test('many replies from one lead count once at the unique-replying stage', () => {
  const input = fixture();
  // Same lead replies three more times, across categories.
  input.activities.push(
    reply('l1', '2026-08-04T11:00:00Z'),
    reply('l1', '2026-08-04T12:00:00Z'),
    reply('l1', '2026-08-04T13:00:00Z'),
  );
  const result = buildFunnelAnalytics(input, { version: VERSION });
  assert.equal(result.counts.replied, 3, 'unique replying leads is unchanged');
  assert.equal(result.counts.positive, 1);
  // The raw message counter still sees every message.
  assert.ok(result.eventCounts.replyMessages >= 6);
});

test('reply-touch attribution may differ from acquisition attribution', () => {
  const input = fixture();
  // A recovery-sequence message triggers the reply, but acquisition is the
  // original cold campaign and must not move.
  const recoveryTouch = { ...sendMeta(1), sequenceId: 'no_show_recovery_v1', copyVersion: 'no_show_recovery_v1' };
  input.activities.push(reply('l1', '2026-08-15T10:00:00Z', 'INTERESTED', recoveryTouch));
  const result = buildFunnelAnalytics(input, { version: VERSION });
  const touches = result.replyTouch.map(row => row.sequenceId);
  assert.ok(touches.includes('no_show_recovery_v1'), 'the recovery touch is reported');
  assert.ok(touches.includes('dental_ai_receptionist_cold'), 'the acquisition touch is still reported');
  // Acquisition-anchored outcomes are untouched by the later touch.
  assert.equal(result.counts.won, 1);
});

test('a rescheduled meeting never becomes a second booked opportunity', () => {
  const input = fixture();
  input.activities.push(
    event('l1', 'meeting_rescheduled', '2026-08-07T10:00:00Z', { meetingAt: '2026-08-12T18:00:00Z', previousMeetingAt: '2026-08-10T18:00:00Z' }),
    event('l1', 'meeting_rescheduled', '2026-08-08T10:00:00Z', { meetingAt: '2026-08-14T18:00:00Z', previousMeetingAt: '2026-08-12T18:00:00Z' }),
  );
  const result = buildFunnelAnalytics(input, { version: VERSION });
  assert.equal(result.counts.callBooked, 4, 'still one booked opportunity per lead');
  assert.equal(result.eventCounts.meetingsRescheduled, 2, 'the reschedules are still visible as events');
});

test('Closed Won stays tied to acquisition, not to a later campaign', () => {
  const input = fixture();
  // A later send stamped with a DIFFERENT version must not move the win.
  input.activities.push(send('l1', '2026-08-20T10:00:00Z', 1, { ...sendMeta(1), campaignVersion: 'dental_v2_other' }));
  assert.equal(buildFunnelAnalytics(input, { version: VERSION }).counts.won, 1, 'the original campaign keeps the win');
  assert.equal(buildFunnelAnalytics(input, { version: 'dental_v2_other' }).counts.won, 0, 'the later campaign never inherits it');
});

test('a terminal stage alone is not evidence a lead ever reached Hot', () => {
  // Production holds board rows marked lost with no activity whatsoever.
  // Counting those as Hot would invent a funnel step that never happened.
  const input = {
    leads: [{ id: 'x', email: 'x@test.ca', emailStatus: 'emailed', lastEmailedAt: '2026-07-01T00:00:00Z' }],
    boardLeads: [{ id: 'CE-x', email: 'x@test.ca', stage: 'lost' }],
    activities: [], replyRecords: [], currentVersion: VERSION,
  };
  const result = buildFunnelAnalytics(input, { version: 'lifetime' });
  assert.equal(result.counts.lost, 1);
  assert.equal(result.counts.hot, 0, 'lost does not imply Hot');

  // An explicit recorded transition IS evidence.
  const withEvidence = { ...input, activities: [event('x', 'stage_changed', '2026-07-02T00:00:00Z', { toStage: 'hot' })] };
  assert.equal(buildFunnelAnalytics(withEvidence, { version: 'lifetime' }).counts.hot, 1);
});

test('board leads outside the outreach funnel are disclosed, never silently dropped', () => {
  const input = fixture();
  // A win acquired through another channel: no ColdEmail lead backs it.
  input.boardLeads.push({ id: 'referral-1', email: 'referral@elsewhere.ca', stage: 'closed_won' });
  const result = buildFunnelAnalytics(input, { version: VERSION });
  assert.equal(result.counts.won, 1, 'it never inflates the cold-outreach funnel');
  const outside = result.reconciliation.outsideFunnel;
  assert.ok(outside.total >= 1);
  assert.equal(outside.byStage.closed_won, 1, 'and it is reported rather than vanishing');
  assert.equal(result.reconciliation.boardLeadsTotal, input.boardLeads.length);
});

test('every stage count reconciles exactly with its drill-down lead set', () => {
  const result = buildFunnelAnalytics(fixture(), { version: 'lifetime' });
  assert.ok(result.reconciliation.stagesMatchLeadIds);
  for (const [key, ids] of Object.entries(result.stageLeadIds)) {
    assert.equal(ids.length, result.counts[key], `${key} must be auditable`);
    assert.equal(new Set(ids).size, ids.length, `${key} must not contain a lead twice`);
  }
});

test('the funnel module contains no write or send path whatsoever', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'funnel-analytics.js'), 'utf8');
  for (const forbidden of [
    'values.update', 'values.append', 'batchUpdate', 'sendEmail', 'sendMail',
    'appendActivity', 'spreadsheets', 'googleapis', 'fetch(', 'axios',
  ]) {
    assert.ok(!src.includes(forbidden), `funnel analytics must never reference ${forbidden}`);
  }
  // Pure: it accepts data and returns data.
  assert.ok(!/require\(['"](?!\.\/campaign-versions)/.test(src.replace(/^'use strict';\n/, '')),
    'the only dependency is the attribution module');
});

test('the drill-down ships only displayed fields, never whole ColdEmail rows', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = server.slice(server.indexOf("app.get('/api/coldemail/funnel'"), server.indexOf('// The DemoPlays header'));
  // Bounded page.
  assert.match(body, /Math\.min\(200,/);
  assert.match(body, /slice\(offset, offset \+ requested\)/);
  // Projected, so notes/siteContext blobs never reach the browser.
  assert.match(body, /id: row\.id, company: row\.company/);
  for (const heavy of ['notes', 'siteContext', 'campaign_notes']) {
    assert.ok(!new RegExp(`row\.${heavy}`).test(body), `${heavy} must not be shipped in the drill-down`);
  }
  // The full id list is never returned with the aggregate.
  assert.match(body, /delete analytics\.stageLeadIds/);
  // One cached snapshot read, no direct sheet access, no send path.
  assert.match(body, /getOutreachDataset/);
  assert.doesNotMatch(body, /spreadsheets\.values\.(get|update|append)|sendEmail|appendActivity/);
});
