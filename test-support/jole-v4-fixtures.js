'use strict';

// Jole v4 sends only for leads in the reviewed classification
// (clients/data/jole-personalization-v4.json). Tests that drive fixture Jole
// leads through the pipeline classify them here: every unlisted fixture lead
// becomes an `exact` lead naming its stored role and site.
const { setJoleClassificationForTests } = require('../integrations/clients/jole-personalization');
const { readLeadProfile } = require('../integrations/clients/lead-profile');

function classifyFixtureLeadsExact(extra = {}) {
  setJoleClassificationForTests({
    ...extra,
    '*': lead => {
      const personalization = readLeadProfile(lead)?.personalization || {};
      // Checked "now", so the 30-day freshness rule keeps fixture leads exact whenever the suite runs.
      return { mode: 'exact', role: (personalization.roles || [])[0] || null, location: personalization.location || null,
        evidenceCheckedAt: new Date().toISOString(), reason: 'test fixture' };
    },
  });
}

module.exports = { classifyFixtureLeadsExact, setJoleClassificationForTests };
