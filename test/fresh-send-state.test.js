'use strict';

// The last-moment send revalidation reads ONE canonical lead, not the corpus.
//
// Production, 2026-09-25: every provider send's revalidation downloaded the whole
// Supabase outreach corpus (2,203 rows, 1.23 MB on the wire) to find one lead.
// The egress meter showed 44 corpus reads in an hour holding two 21-send windows
// (1 run-start read + 21 per-send reads, twice), ~200 reads that day, and the
// project was restricted for exceeding its egress quota. These tests drive the
// real guardProviderSend with the new loader.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { freshLeadFromSnapshot, createFreshSendStateLoader } = require('../integrations/fresh-send-state');
const { guardProviderSend, evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');

const ENV = {
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
};

const makeLead = (i, over = {}) => ({
  id: `lead-${i}`, email: `owner${i}@clinic${i}.test`, company: `Clinic ${i}`, contactName: `Pat ${i}`,
  stage: 'Queued', emailStatus: '', emailStep: '0', notes: 'enriched', leadNiche: 'dental',
  emailTemplateId: 'dental-guarantee-v1', senderInboxId: 'tryscalelabai', ...over,
});

// Canonical Supabase stand-in. Counts every read so the tests can prove what is fetched.
function canonicalStore(leads) {
  const rows = new Map(leads.map(lead => [lead.id, { ...lead }]));
  const calls = { byId: [], corpus: 0, sheets: 0, snapshots: 0 };
  let unreadable = null;
  return {
    rows, calls,
    breakWith(reason) { unreadable = reason; },
    getLeadById: async id => {
      calls.byId.push(id);
      if (unreadable) return { ok: false, lead: null, reason: unreadable };
      const row = rows.get(id);
      return { ok: true, lead: row ? { ...row } : null, reason: 'ok' };
    },
    readCorpus: async () => { calls.corpus += 1; return [...rows.values()].map(row => ({ ...row })); },
  };
}

function loaderFor(store, { suppression = [], sheetRows = null } = {}) {
  return createFreshSendStateLoader({
    loadSnapshot: async () => {
      store.calls.snapshots += 1;
      return { coldEmail: sheetRows, suppression: [['email'], ...suppression.map(email => [email])] };
    },
    readSheetLeads: async rows => { store.calls.sheets += 1; return rows; },
    getLeadById: store.getLeadById,
    suppressedFrom: snapshot => new Set(snapshot.suppression.slice(1).map(row => String(row[0]).toLowerCase())),
  });
}

test('a 21-send window reads each lead once and never re-fetches the corpus', async () => {
  const leads = Array.from({ length: 21 }, (_, i) => makeLead(i));
  const store = canonicalStore(leads);
  const deps = { env: ENV, loadFreshState: loaderFor(store) };
  const verdicts = [];
  for (const lead of leads) verdicts.push(await guardProviderSend(lead, deps, { purpose: 'cold' }));
  assert.equal(verdicts.filter(v => v.allowed).length, 21, 'send totals unchanged');
  assert.equal(store.calls.corpus, 0, 'no per-send corpus download');
  assert.deepEqual(store.calls.byId, leads.map(lead => lead.id), 'exactly one canonical row per send');
  assert.equal(store.calls.sheets, 0, 'no Sheets rows consulted while Supabase is canonical');
});

test('state changed between sends is seen at send time: no stale state authorizes a send', async () => {
  const leads = Array.from({ length: 8 }, (_, i) => makeLead(i));
  const store = canonicalStore(leads);
  const suppression = [];
  const deps = { env: ENV, loadFreshState: loaderFor(store, { suppression }) };
  // Each change lands after the run selected its leads and before that lead's send.
  const changes = {
    'lead-1': () => { store.rows.get('lead-1').notes = '[MANUAL HOLD] enriched'; },
    'lead-2': () => { store.rows.get('lead-2').notes = '[REPLY: Unsubscribed] enriched'; },
    'lead-3': () => { suppression.push('owner3@clinic3.test'); },
    'lead-4': () => { Object.assign(store.rows.get('lead-4'), { stage: 'Replied', emailStatus: 'replied' }); },
    'lead-5': () => { store.rows.delete('lead-5'); },
    'lead-6': () => { store.rows.get('lead-6').email = 'someone-else@clinic6.test'; },
    'lead-7': () => { store.rows.get('lead-7').notes = '[BOUNCED] enriched'; },
  };
  const outcome = {};
  for (const lead of leads) {
    if (changes[lead.id]) changes[lead.id]();
    outcome[lead.id] = (await guardProviderSend(lead, deps, { purpose: 'cold' })).code || 'allowed';
  }
  assert.deepEqual(outcome, {
    'lead-0': 'allowed', 'lead-1': 'manual_hold', 'lead-2': 'unsubscribed', 'lead-3': 'suppressed',
    'lead-4': 'terminal_state', 'lead-5': 'identity_changed', 'lead-6': 'identity_changed', 'lead-7': 'bounced',
  });
  assert.equal(store.calls.corpus, 0);
});

test('an unreadable Supabase fails closed and never falls back to Sheets', async () => {
  const store = canonicalStore([makeLead(1)]);
  store.breakWith('HTTP 402');
  const verdict = await guardProviderSend(makeLead(1), { env: ENV, loadFreshState: loaderFor(store) }, { purpose: 'cold' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'revalidation_unavailable');
  assert.match(verdict.reason, /Supabase is canonical and unreadable \(HTTP 402\)/);
  assert.equal(store.calls.sheets, 0, 'no Sheets fallback');
  await assert.rejects(freshLeadFromSnapshot({ snapshot: { coldEmail: null }, leadId: 'lead-1',
    readSheetLeads: async () => [makeLead(1)], getLeadById: async () => ({ ok: false, reason: 'timeout' }) }), /unreadable \(timeout\)/);
});

test('a board-style CE- id resolves to its outreach lead, exactly as the corpus lookup did', async () => {
  const store = canonicalStore([makeLead(9)]);
  const current = await freshLeadFromSnapshot({ snapshot: { coldEmail: null }, leadId: 'CE-lead-9',
    readSheetLeads: async () => [], getLeadById: store.getLeadById });
  assert.equal(current.id, 'lead-9');
  assert.equal(current.first, 'Pat');
  assert.deepEqual(store.calls.byId, ['CE-lead-9', 'lead-9']);
});

test('when Sheets supplies the rows (Sheets authority / non-primary mode) the Sheets path is unchanged', async () => {
  const store = canonicalStore([makeLead(2)]);
  const sheetRows = [makeLead(2, { notes: '[MANUAL HOLD] from sheets' })];
  const verdict = await guardProviderSend(makeLead(2), { env: ENV, loadFreshState: loaderFor(store, { sheetRows }) }, { purpose: 'cold' });
  assert.equal(verdict.code, 'manual_hold', 'decided from the Sheets rows');
  assert.equal(store.calls.byId.length, 0, 'no Supabase read on the Sheets path');
  assert.equal(store.calls.sheets, 1);
});

test('every gate decision matches the full-corpus lookup it replaces, for every purpose', async () => {
  const states = {
    clean: {}, hold: { notes: '[MANUAL HOLD] x' }, unsub: { notes: '[REPLY: Unsubscribed] x' },
    notInterested: { notes: '[REPLY: Not Interested] x' }, bounced: { notes: '[BOUNCED: Smartlead] x' },
    stageUnsub: { stage: 'Unsub', emailStatus: 'done' }, stageDone: { stage: 'Done', emailStatus: 'done' },
    replied: { stage: 'Replied', emailStatus: 'replied' }, hot: { stage: 'Hot', emailStatus: 'emailed' },
    emailed: { stage: 'Contacted', emailStatus: 'emailed', emailStep: '1' },
    emailChanged: { email: 'moved@elsewhere.test' }, staffingPaused: { leadNiche: 'industrial_staffing', campaign: 'Industrial Staffing Agency' },
  };
  const suppressed = new Set(['listed@clinic.test']);
  for (const purpose of ['cold', 'sequence', 'warm']) {
    for (const [name, over] of [...Object.entries(states), ['onSuppressionList', { email: 'listed@clinic.test' }], ['missing', null]]) {
      const selected = makeLead(0, name === 'onSuppressionList' ? { email: 'listed@clinic.test' } : {});
      const canonicalRow = over === null ? null : { ...selected, ...over };
      const store = canonicalStore(canonicalRow ? [canonicalRow] : []);
      const oldCurrent = (await store.readCorpus()).find(row => row.id === selected.id) || null;
      const before = evaluateFreshSendSafety(selected, oldCurrent, suppressed, { purpose, env: ENV });
      const newCurrent = await freshLeadFromSnapshot({ snapshot: { coldEmail: null }, leadId: selected.id,
        readSheetLeads: async () => [], getLeadById: store.getLeadById });
      const after = evaluateFreshSendSafety(selected, newCurrent, suppressed, { purpose, env: ENV });
      assert.deepEqual([after.allowed, after.code], [before.allowed, before.code], `${purpose}/${name}`);
    }
  }
});

test('the single-row read is reachable only where the corpus read already decides from Supabase', async () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const snapshotFn = agent.slice(agent.indexOf('async function loadAgentSnapshot'), agent.indexOf('function freshSendSafetyDeps()'));
  assert.match(snapshotFn, /const coldEmailFromSupabase = outreachStateMode\(\) === 'primary' && !forceColdEmail;/);
  assert.match(snapshotFn, /\.\.\.\(coldEmailFromSupabase \? \[\] : \[\['coldEmail', READ_RANGE\]\]\)/);
  const deps = agent.slice(agent.indexOf('function freshSendSafetyDeps()'), agent.indexOf('function loadGmailObservationState'));
  assert.match(deps, /forceColdEmail: outreachWriteAuthority\(\) === 'sheets',/);
  // Those two rules, evaluated for every configuration.
  const reachedSupabase = {};
  for (const mode of ['off', 'dual', 'primary']) {
    for (const writes of ['sheets', 'supabase']) {
      const coldEmailFromSupabase = mode === 'primary' && !(writes === 'sheets');
      const store = canonicalStore([makeLead(1)]);
      await freshLeadFromSnapshot({ snapshot: { coldEmail: coldEmailFromSupabase ? null : [makeLead(1)] }, leadId: 'lead-1',
        readSheetLeads: async rows => rows, getLeadById: store.getLeadById });
      reachedSupabase[`${mode}/${writes}`] = store.calls.byId.length > 0;
    }
  }
  assert.deepEqual(reachedSupabase, {
    'off/sheets': false, 'off/supabase': false, 'dual/sheets': false, 'dual/supabase': false,
    'primary/sheets': false, 'primary/supabase': true,
  });
});

test('the agent wires the single-lead loader into every provider-send gate and the warm final gate', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const deps = agent.slice(agent.indexOf('function freshSendSafetyDeps()'), agent.indexOf('function loadGmailObservationState'));
  assert.match(deps, /createFreshSendStateLoader\(\{/);
  assert.match(deps, /getLeadById: id => getOutreachLeadById\(id\)/);
  assert.ok(!/readLeads\(snapshot\.coldEmail\)/.test(deps), 'the per-send gate no longer reads the corpus');
  assert.equal((agent.match(/guardProviderSend\([^)]*freshSendSafetyDeps\(\)/g) || []).length, 3, 'cold, Smartlead and sequence sends share it');
  assert.match(agent, /const current = await freshLeadFromSnapshot\(\{ snapshot: fresh, leadId: lead\.id,/, 'warm final gate');
  // The remaining corpus reads are the ones that need every lead: run start and Agent v2 evidence.
  const corpusReads = agent.match(/readLeads\((?:snapshot|fresh)\.coldEmail\)/g) || [];
  assert.equal(corpusReads.length, 2);
});
