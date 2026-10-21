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
      return { mode: 'exact', role: (personalization.roles || [])[0] || null, location: personalization.location || null, reason: 'test fixture' };
    },
  });
}

module.exports = { classifyFixtureLeadsExact, setJoleClassificationForTests };
