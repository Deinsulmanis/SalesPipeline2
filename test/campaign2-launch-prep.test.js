'use strict';

// The Campaign 2 preparation decides eligibility from the sourcing row only and
// writes nothing but company (when blank) and campaign_notes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { eligibility, patchFor } = require('../scripts/campaign2-launch-prep');
const { staffingReviewStatus, staffingNoPersonalizationAllowed, STAFFING_CAMPAIGN_2 } = require('../integrations/staffing-campaign');
const { staffingHoldStatus, staffingHoldInconsistencies, hasStaffingHoldMarker } = require('../integrations/staffing-hold');

const row = (extra = {}) => ({ email: 'nancy@labormasters.com', company_name: 'Labor Masters', company_domain: 'labormasters.com',
  vertical: 'INDUSTRIAL', title: 'President', ...extra });
const lead = (extra = {}) => ({ id: 'c2', company: '', stage: 'Import', campaign: STAFFING_CAMPAIGN_2.name, campaign_notes: '', ...extra });

test('a clearly industrial US buyer is cleared with the reviewed generic Email 1', () => {
  assert.deepEqual(eligibility(row()), []);
  const patch = patchFor(lead(), row(), []);
  assert.deepEqual(Object.keys(patch).sort(), ['campaign_notes', 'company']);
  assert.equal(patch.company, 'Labor Masters');
  assert.deepEqual(staffingReviewStatus(patch), { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true });
  assert.equal(staffingNoPersonalizationAllowed(patch), true);
  assert.equal(patchFor(lead({ company: 'Existing Name' }), row(), []).company, undefined, 'a present company is never rewritten');
});

test('every hold reason produces a consistent, unsendable hold record', () => {
  const cases = [
    [row({ email: 'a@x.co.uk', company_domain: 'x.co.uk' }), 'ICP_REJECT'],
    [row({ vertical: 'ACCOUNTING_FINANCE' }), 'NON_INDUSTRIAL_STAFFING'],
    [row({ vertical: 'ADMIN_OFFICE' }), 'NON_INDUSTRIAL_STAFFING'],
    [row({ company_domain: 'labormasters.net' }), 'ICP_CONFLICT'],
    [row({ vertical: 'GENERALIST_COMMERCIAL' }), 'ICP_UNCONFIRMED'],
    [row({ vertical: '' }), 'ICP_UNCONFIRMED'],
    [row({ title: 'Manager' }), 'REVIEW_REQUIRED'],
  ];
  for (const [source, reason] of cases) {
    const reasons = eligibility(source);
    assert.equal(reasons[0].hold, reason, source.email + source.vertical + source.title);
    const held = { ...lead(), ...patchFor(lead(), source, reasons) };
    assert.equal(hasStaffingHoldMarker(held), true);
    assert.equal(staffingHoldStatus(held).reason, reason);
    assert.deepEqual(staffingHoldInconsistencies(held), []);
    assert.equal(staffingReviewStatus(held).routingReady, false);
    assert.equal(staffingNoPersonalizationAllowed(held), false);
  }
});
