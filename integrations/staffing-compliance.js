'use strict';

// Staffing commercial-email identity and CAN-SPAM/CASL footer.
//
// Official bases:
// - FTC CAN-SPAM Act: A Compliance Guide for Business
//   https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
// - 15 U.S.C. § 7704(a)(3)–(5)
// - Electronic Commerce Protection Regulations (CRTC), SOR-2012-36 s. 2–3
// - CRTC CASL FAQ (computer system in Canada; mailing address + contact)
//
// This module does not invent a postal address. Production must supply a real
// street address, USPS/CMRA box, or CASL-equivalent mailing address via
// COMMERCIAL_MAILING_ADDRESS (preferred) or MAILING_ADDRESS.

const STAFFING_CAMPAIGN_REF = 'SA-48271';
const STAFFING_REF_LINE = `Ref: ${STAFFING_CAMPAIGN_REF}`;
const STAFFING_UNSUBSCRIBE_LINE = 'Not relevant? Reply "unsubscribe" and I won\'t follow up again.';
const STAFFING_COMMERCIAL_NOTICE = 'This is a commercial email.';
const STAFFING_OPT_OUT_LINE = `${STAFFING_COMMERCIAL_NOTICE} ${STAFFING_UNSUBSCRIBE_LINE}`;
const STAFFING_GMAIL_FILTER_QUERY = `"${STAFFING_CAMPAIGN_REF}"`;
const MISSING_COMMERCIAL_MAILING_ADDRESS = 'MISSING_COMMERCIAL_MAILING_ADDRESS';
const TEST_FIXTURE_COMMERCIAL_MAILING_ADDRESS = 'TEST_FIXTURE_COMMERCIAL_MAILING_ADDRESS';

const PLACEHOLDER = /your company|your city, province|change-me|placeholder/i;
const STREET_OR_BOX = /(?:p\.?\s*o\.?\s*box\b|po box\b|\bbox\s+\d+|\brr\.?\s*\d+|\brural route\b|\bgeneral delivery\b|\b\d{1,6}\s+[A-Za-z0-9.'/-]+)/i;
// The test-support fixture that was copied into Railway and rendered live.
const TEST_FIXTURE_MAILING_ADDRESS = /1\s+harbour\s+street/i;

function looksLikeTestFixtureMailingAddress(value) {
  return TEST_FIXTURE_MAILING_ADDRESS.test(String(value || ''));
}

function isValidCommercialMailingAddress(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length < 12) return false;
  if (PLACEHOLDER.test(text)) return false;
  if (!STREET_OR_BOX.test(text)) return false;
  // Locality must be separable from the street/box token (comma or newline).
  return /[,\n]/.test(String(value || '').trim());
}

function resolveCommercialMailingAddress(env = process.env, explicit) {
  const fromExplicit = explicit !== undefined;
  const raw = fromExplicit
    ? String(explicit || '').trim()
    : String(env.COMMERCIAL_MAILING_ADDRESS || env.MAILING_ADDRESS || '').trim();
  // The Harbour Street value is a test-support fixture that was copied into
  // Railway. Env-sourced production identity must not render it. Explicit
  // overrides remain available so existing tests can keep using the fixture.
  if (!fromExplicit && looksLikeTestFixtureMailingAddress(raw)) {
    const error = new Error(
      'staffing commercial mailing address is the Harbour Street test fixture; set COMMERCIAL_MAILING_ADDRESS to the real mailing address',
    );
    error.code = TEST_FIXTURE_COMMERCIAL_MAILING_ADDRESS;
    throw error;
  }
  if (!isValidCommercialMailingAddress(raw)) {
    const error = new Error(
      'staffing commercial mailing address is missing or is not a valid physical postal address',
    );
    error.code = MISSING_COMMERCIAL_MAILING_ADDRESS;
    throw error;
  }
  return raw;
}

function staffingSenderIdentity(env = process.env, overrides = {}) {
  return {
    companyName: String(overrides.companyName || env.SIGNATURE_COMPANY || 'ScaleLabAi').trim() || 'ScaleLabAi',
    website: String(overrides.website || env.SIGNATURE_SITE || 'scalelabai.ca').trim() || 'scalelabai.ca',
    mailingAddress: resolveCommercialMailingAddress(env, overrides.mailingAddress),
  };
}

function formatStaffingComplianceFooter(identity) {
  const company = String(identity.companyName || '').trim();
  const address = String(identity.mailingAddress || '').trim();
  const website = String(identity.website || '').trim();
  const lines = [company, address, website].filter(Boolean);
  return `${lines.join('\n')}\n\n${STAFFING_OPT_OUT_LINE}\n\n${STAFFING_REF_LINE}`;
}

function appendStaffingComplianceFooter(body, identity) {
  const core = String(body || '').replace(/\s+$/, '');
  const footer = formatStaffingComplianceFooter(identity);
  if (core.includes(STAFFING_REF_LINE) || core.includes(STAFFING_UNSUBSCRIBE_LINE)) {
    throw new Error('staffing body already contains a compliance footer');
  }
  return `${core}\n\n${footer}`;
}

function staffingComplianceError(body, { leadId } = {}) {
  const text = String(body || '');
  if (!text.includes(STAFFING_UNSUBSCRIBE_LINE)) return 'staffing body is missing the unsubscribe footer';
  if (!text.includes(STAFFING_COMMERCIAL_NOTICE)) return 'staffing body is missing commercial-email identification';
  const refCount = text.split(STAFFING_REF_LINE).length - 1;
  if (refCount !== 1) return `staffing body must contain ${STAFFING_REF_LINE} exactly once`;
  if ((text.match(/SA-48271/g) || []).length !== 1) return 'staffing campaign reference must appear exactly once';
  const unsubAt = text.indexOf(STAFFING_UNSUBSCRIBE_LINE);
  const refAt = text.indexOf(STAFFING_REF_LINE);
  if (!(unsubAt >= 0 && refAt > unsubAt)) return 'staffing reference line must appear after the unsubscribe text';
  if (!text.trim().endsWith(STAFFING_REF_LINE)) return 'staffing reference line must be the final campaign line';
  if (leadId && String(leadId).trim() && text.includes(String(leadId).trim())) {
    return 'staffing footer must not expose an internal lead id';
  }
  if (/\bRef: SL-/i.test(text) || /\bCE-[A-Za-z0-9_-]+/.test(text)) {
    return 'staffing footer must not expose internal identifiers';
  }
  return null;
}

// Industrial Staffing V2 (locked 2026-10-20): Touch 1 ends with its own short
// business footer (brand, the same COMMERCIAL_MAILING_ADDRESS on one line,
// website, reply-to-unsubscribe line); Touches 2–3 end at the sign-off. The
// reply "unsubscribe" handling and List-Unsubscribe headers are the existing
// ones. V1's footer above is unchanged.
const STAFFING_V2_BRAND = 'ScaleLabAI';
const STAFFING_V2_UNSUBSCRIBE_LINE = 'To unsubscribe, reply “unsubscribe”';
const STAFFING_V2_FOOTER = new RegExp(`\\n\\n${STAFFING_V2_BRAND}\\n[^\\n]+\\n[^\\n]+\\n${STAFFING_V2_UNSUBSCRIBE_LINE}$`);

function formatStaffingV2Footer(identity) {
  const address = String(identity.mailingAddress || '').split('\n').map(line => line.trim()).filter(Boolean).join(', ');
  const website = String(identity.website || '').trim();
  return [STAFFING_V2_BRAND, address, website, STAFFING_V2_UNSUBSCRIBE_LINE].join('\n');
}

function appendStaffingV2Footer(body, identity) {
  const core = String(body || '').replace(/\s+$/, '');
  if (core.includes(STAFFING_V2_UNSUBSCRIBE_LINE) || core.includes(STAFFING_UNSUBSCRIBE_LINE)) {
    throw new Error('staffing body already contains a compliance footer');
  }
  return `${core}\n\n${formatStaffingV2Footer(identity)}`;
}

function staffingV2ComplianceError(body, step, { leadId } = {}) {
  const text = String(body || '');
  if (text.includes(STAFFING_UNSUBSCRIBE_LINE) || text.includes(STAFFING_COMMERCIAL_NOTICE) || text.includes(STAFFING_CAMPAIGN_REF)) {
    return 'staffing V2 body must not carry the V1 compliance footer';
  }
  const unsubscribeLines = text.split(STAFFING_V2_UNSUBSCRIBE_LINE).length - 1;
  if (step === 1) {
    if (unsubscribeLines !== 1 || !STAFFING_V2_FOOTER.test(text)) return 'staffing V2 Touch 1 must end with its business footer';
  } else if (unsubscribeLines || text.includes(`\n\n${STAFFING_V2_BRAND}\n`)) {
    return `staffing V2 Touch ${step} must not carry a footer`;
  }
  if (leadId && String(leadId).trim() && text.includes(String(leadId).trim())) {
    return 'staffing footer must not expose an internal lead id';
  }
  if (/\bRef: SL-/i.test(text) || /\bCE-[A-Za-z0-9_-]+/.test(text)) {
    return 'staffing footer must not expose internal identifiers';
  }
  return null;
}

module.exports = {
  STAFFING_CAMPAIGN_REF,
  STAFFING_REF_LINE,
  STAFFING_UNSUBSCRIBE_LINE,
  STAFFING_COMMERCIAL_NOTICE,
  STAFFING_OPT_OUT_LINE,
  STAFFING_GMAIL_FILTER_QUERY,
  MISSING_COMMERCIAL_MAILING_ADDRESS,
  TEST_FIXTURE_COMMERCIAL_MAILING_ADDRESS,
  isValidCommercialMailingAddress,
  looksLikeTestFixtureMailingAddress,
  resolveCommercialMailingAddress,
  staffingSenderIdentity,
  formatStaffingComplianceFooter,
  appendStaffingComplianceFooter,
  staffingComplianceError,
  STAFFING_V2_BRAND,
  STAFFING_V2_UNSUBSCRIBE_LINE,
  formatStaffingV2Footer,
  appendStaffingV2Footer,
  staffingV2ComplianceError,
};
