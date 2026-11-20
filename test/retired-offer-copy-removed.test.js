'use strict';

// 2026-11-19: ScaleLab only contacts staffing agencies. The retired dental and
// roofing offers' email copy and reply flow were removed; their leads stay
// archived with full history, and the retired-offer guards still recognise them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const agent = read('outreach-agent.js');
const server = read('server.js');
const { retiredOfferFor, retiredOfferBlock } = require('../integrations/lead-archive');
const { templateById } = require('../integrations/campaign-routing');

test('the retired copy modules are gone and nothing loads them', () => {
  for (const file of ['integrations/dental-email.js', 'integrations/dental-subject.js',
    'integrations/dental-personalization.js', 'integrations/roofing-survey-profile.js', 'ROOFING_SURVEY.md']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} was removed`);
  }
  for (const source of [agent, server, read('scripts/audit-gmail-crm-sends.js')]) {
    assert.doesNotMatch(source, /require\([^)]*(?:dental-email|dental-subject|dental-personalization|roofing-survey-profile)/);
  }
});

test('step 1 and follow-ups send only staffing or managed-client copy', () => {
  assert.doesNotMatch(agent, /buildEmail\(|buildPitch\(|generateOpener\(|FOLLOW_UP_SEQUENCE|template\.body\(lead\)/);
  assert.match(agent, /no email copy exists for this lead \(only staffing and managed-client copy can send\)/);
  assert.equal(agent.split('(no follow-up copy exists for this lead)').length - 1, 2);
  // markSent still ends the sequence after the last follow-up.
  assert.match(agent, /const isLastStep = step > FOLLOW_UP_STEP_COUNT;/);
  assert.equal(require('../integrations/sequence-timing').FOLLOW_UP_STEP_COUNT, 2);
});

test('retired leads stay recognised and blocked; their templates stay registered, never ready', () => {
  assert.equal(retiredOfferFor({ leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1' }).offer.id, 'dental');
  assert.equal(retiredOfferBlock({ emailTemplateId: 'roofing-survey-v1', campaign: 'Roofing Survey' }).code, 'offer_retired');
  assert.equal(templateById('dental-guarantee-v1').ready, false);
  assert.equal(templateById('roofing-survey-v1').ready, false);
  assert.match(agent, /if \(RETIRED_EMAIL_TEMPLATE_IDS\.has\(String\(l\.emailTemplateId \|\| ''\)\)\) return false;/);
  // A non-archived roofing-template reply goes to a person, as it did with the flow off.
  assert.match(agent, /if \(lead\.emailTemplateId === RETIRED_ROOFING_TEMPLATE_ID\) \{\s*lead\.emailStatus = 'replied';\s*if \(!DRY_RUN\) await withAuth\(\(\) => handleNeedsHuman\(lead, message\.fromAddr\)\);/);
});

test('the hourly Smartlead check skips retired offers\' campaigns, not live ones', () => {
  const reconcile = server.slice(server.indexOf('async function reconcileSmartlead()'), server.indexOf('const startedAt = new Date().toISOString();', server.indexOf('async function reconcileSmartlead()')));
  assert.match(reconcile, /!retiredOfferFor\(\{ campaign: row\.internalCampaignId \}\)/);
  assert.ok(retiredOfferFor({ campaign: 'Dental Campaign Test' }), 'the failing dental test campaign is skipped');
  for (const live of ['Staffing Outreach Campaign 2', 'Industrial Staffing Agency', 'jole-btx-employer-acquisition']) {
    assert.equal(retiredOfferFor({ campaign: live }), null, `${live} is still reconciled`);
  }
});

test('settings status no longer reports the roofing reply flow', () => {
  const route = server.slice(server.indexOf("app.get('/api/crm/ui-status'"), server.indexOf('// Campaign performance'));
  assert.doesNotMatch(route, /roofingReplyFlow|ROOFING_SURVEY/);
});
