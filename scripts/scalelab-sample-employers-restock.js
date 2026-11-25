#!/usr/bin/env node
'use strict';
// Weekly sample-employer restock, runnable by hand:
//   node scripts/scalelab-sample-employers-restock.js [--max 300]
// Demand-first: states where Campaign 3 agencies wait on fewer than 5 listable
// employers go first. Tops each state up to 10 employers with 2+ roles from the
// pool, and adds new direct employers from main-city job searches when a state
// with demand runs out below 5. One GetLeads search_jobs
// call at a time (free jobs quota). Writes only sample_employers check fields.
require('dotenv').config();
const { createSampleListStore } = require('../integrations/scalelab-sample-list-store');
const { createGetLeadsJobsClient } = require('../integrations/getleads-jobs');
const { makeRecheck, restockSampleEmployers } = require('../integrations/scalelab-sample-list-flow');

async function runRestock({ env = process.env, maxChecks = 300, log = console.warn } = {}) {
  const now = new Date();
  const jobs = createGetLeadsJobsClient({ env });
  if (!jobs.configured) throw new Error('GETLEADS_API_KEY is not set');
  return restockSampleEmployers({ store: createSampleListStore({ env }), recheck: makeRecheck(jobs, now),
    discover: city => jobs.searchCityEmployers(city, { now }), now, maxChecks, log });
}

if (require.main === module) {
  const at = process.argv.indexOf('--max');
  const maxChecks = at > 0 ? Number(process.argv[at + 1]) || 300 : 300;
  runRestock({ maxChecks }).then(summary => console.log(JSON.stringify(summary)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runRestock };
