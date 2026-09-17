'use strict';

function parseGoogleServiceAccountJson(raw, envName = 'GOOGLE_SERVICE_ACCOUNT_JSON') {
  if (raw == null || String(raw).trim() === '') {
    throw new Error(`${envName} is missing or empty`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_error) {
    throw new Error(`${envName} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object`);
  }
  return parsed;
}

module.exports = { parseGoogleServiceAccountJson };
