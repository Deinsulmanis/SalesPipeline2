'use strict';

// The managed-client import WRITE (POST /api/clients/:clientId/leads/import):
// scope, validation reuse, suppression, isolation, idempotency, and that every
// written lead is an inert Jole Import lead. Plus the Jole copy renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { registerClientRoutes } = require('../integrations/clients/routes');
const { importClientLeads } = require('../integrations/clients/lead-import');
const { resolveLeadClient } = require('../integrations/clients/ownership');
const { routedLeadReady } = require('../integrations/campaign-routing');
const { clientCampaign, clientTemplate, campaignSendable } = require('../integrations/clients/campaigns');
const { clientSendState } = require('../integrations/clients/send-policy');
const { getClient } = require('../integrations/clients/registry');
const { renderJoleEmployerStep, JOLE_INDUSTRIAL_EMPLOYER_COPY } = require('../integrations/clients/jole-copy');

const CAMPAIGN = 'jole-btx-employer-acquisition';
const ADDRESS = '1200 Industrial Pkwy, Suite 4, Houston, TX 77002';
const row = (n, extra = {}) => ({
  company: `Gulf Fab ${n}`, contactName: `Pat Lee${n}`, email: `pat${n}@gulffab${n}.com`,
  city: 'Houston, TX', website: `https://gulffab${n}.com`, tradeType: 'Industrial fabrication / machinery',
  evidence: `Gulf Fab ${n} posted Welder at Houston, TX`, ...extra,
});
const scalelabLead = { id: 's1', company: 'Smile Dental', email: 'office@smiledental.com', stage: 'Contacted',
  emailStatus: 'emailed', emailStep: '1', leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1',
  intendedCampaignVersion: 'dental_v3_pay_per_booking', campaign: 'Ontario List', senderInboxId: 'primary', clientId: 'scalelab' };

// In-memory storage with the same contract server.js provides.
function memoryStorage({ leads = [], suppressed = [], clientEntries = { available: true, entries: [] }, failCorpus = false, failAppendAfter = null } = {}) {
  const state = { leads: leads.map(lead => ({ ...lead })), appends: 0, mirrored: 0 };
  let id = 0;
  return {
    state,
    importLeads: options => importClientLeads({
      ...options,
      readCorpus: async () => {
        if (failCorpus) throw Object.assign(new Error('Sheets unreachable'), { code: 'corpus_unavailable' });
        return { leads: state.leads.map(lead => ({ ...lead })), suppressedEmails: new Set(suppressed) };
      },
      readClientSuppressions: async () => clientEntries,
      appendLeads: async written => {
        state.appends += 1;
        if (failAppendAfter !== null) {
          // The write lands, then the response is lost — the retry case.
          state.leads.push(...written.slice(0, failAppendAfter).map(lead => ({ ...lead })));
          throw new Error('socket hang up');
        }
        state.leads.push(...written.map(lead => ({ ...lead })));
      },
      mirrorLeads: async written => { state.mirrored += written.length; return { enabled: true, mirrored: written.length, failed: 0 }; },
      newId: () => `jl${++id}`,
      env: {},
    }),
  };
}

async function withServer(storage, run) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const requireAuth = (req, res, next) => (req.headers.authorization === 'Basic test' ? next() : res.status(401).json({ error: 'auth' }));
  registerClientRoutes(app, {
    requireAuth, loadDataset: async () => ({ leads: storage.state.leads, suppressedEmails: new Set() }),
    getStore: () => null, senders: () => [], routedLeadReady, env: {}, log: { log() {}, error() {} },
    importLeads: storage.importLeads,
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, auth = true) => {
    const res = await fetch(base + path, { method: 'POST', headers: { ...(auth ? { authorization: 'Basic test' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try { await run(post); } finally { await new Promise(resolve => server.close(resolve)); }
}
const importBody = (rows, extra = {}) => ({ confirmClientId: 'jole', campaignId: CAMPAIGN, rows, ...extra });
const URL_JOLE = '/api/clients/jole/leads/import';

test('import: requires operator auth', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    assert.equal((await post(URL_JOLE, importBody([row(1)]), false)).status, 401);
    assert.equal(storage.state.appends, 0);
  });
});

test('import: requires explicit Jole scope in the body; the stale jole-btx id fails closed', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const missing = await post(URL_JOLE, { campaignId: CAMPAIGN, rows: [row(1)] });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.code, 'client_scope_required');
    assert.equal((await post(URL_JOLE, importBody([row(1)], { confirmClientId: 'jole-btx' }))).body.code, 'client_scope_required');
    const stale = await post('/api/clients/jole-btx/leads/import', importBody([row(1)], { confirmClientId: 'jole-btx' }));
    assert.equal(stale.status, 404);
    assert.equal(stale.body.code, 'client_unknown');
    assert.equal((await post('/api/clients/acme/leads/import', importBody([row(1)], { confirmClientId: 'acme' }))).status, 404);
    assert.equal(storage.state.appends, 0);
  });
});

test('import: ScaleLab cannot use the managed-client write; it keeps its own import', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const res = await post('/api/clients/scalelab/leads/import', importBody([row(1)], { confirmClientId: 'scalelab' }));
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'use_legacy_import');
    assert.equal(storage.state.appends, 0);
  });
});

test('import: only the employer-acquisition campaign accepts Jole leads', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    for (const campaignId of ['JOLE_GULF_INDUSTRIAL', 'JOLE_SHIPYARD', 'JOLE_DC_MISSION_CRITICAL']) {
      const res = await post(URL_JOLE, importBody([row(1)], { campaignId }));
      assert.equal(res.body.code, 'campaign_not_importable', campaignId);
    }
    assert.equal((await post(URL_JOLE, importBody([row(1)], { campaignId: 'dental_v3_pay_per_booking' }))).status, 409);
    assert.equal((await post(URL_JOLE, importBody([row(1)], { campaignId: '' }))).status, 409);
    assert.equal(storage.state.appends, 0);
  });
});

test('import: every written lead is an inert Jole Import lead in the employer campaign', async () => {
  const storage = memoryStorage({ leads: [scalelabLead] });
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1), row(2), row(3)]));
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.accepted, res.body.rejected, res.body.written, res.body.duplicates], [3, 0, 3, 0]);
    assert.equal(res.body.mirror.mirrored, 3);
    const jole = storage.state.leads.filter(lead => lead.clientId === 'jole');
    assert.equal(jole.length, 3);
    for (const lead of jole) {
      assert.equal(lead.stage, 'Import');
      assert.equal(lead.campaign, CAMPAIGN);
      assert.equal(lead.intendedCampaignVersion, CAMPAIGN);
      assert.equal(lead.emailTemplateId, 'jole-industrial-employer-v1');
      assert.equal(lead.leadNiche, 'jole_employer');
      for (const field of ['senderInboxId', 'emailStatus', 'emailStep', 'lastEmailedAt', 'campaign_notes', 'notes']) assert.equal(lead[field], '', field);
      assert.ok(lead.id);
      const owner = resolveLeadClient(lead);
      assert.deepEqual([owner.ok, owner.clientId, owner.source, owner.legacyDefault], [true, 'jole', 'explicit', false]);
    }
    // The ScaleLab lead is untouched and still ScaleLab's.
    assert.deepEqual(storage.state.leads.find(lead => lead.id === 's1'), scalelabLead);
  });
});

test('import: malformed rows are refused and never written', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1), row(2, { company: '' }), row(3, { email: 'not-an-email' }), row(4, { email: '' })]));
    assert.equal(res.body.written, 1);
    assert.equal(res.body.refusalsByCode.invalid, 3);
    assert.deepEqual(res.body.refusals.map(r => r.index).sort(), [1, 2, 3]);
    assert.equal(storage.state.leads.length, 1);
  });
});

test('import: duplicates in the batch and existing Jole leads are refused, not rewritten', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const first = await post(URL_JOLE, importBody([row(1), row(1, { company: 'Other' }), row(2)]));
    assert.equal(first.body.written, 2);
    assert.equal(first.body.duplicates, 1);
    const again = await post(URL_JOLE, importBody([row(1), row(2)]));
    assert.deepEqual([again.body.written, again.body.duplicates, again.body.accepted], [0, 2, 0]);
    assert.equal(storage.state.appends, 1);
    assert.equal(storage.state.leads.length, 2);
  });
});

test('import: a ScaleLab address is refused as a cross-client collision; ScaleLab is never reassigned', async () => {
  const storage = memoryStorage({ leads: [scalelabLead] });
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1, { email: 'OFFICE@smiledental.com' })]));
    assert.equal(res.body.written, 0);
    assert.equal(res.body.refusals[0].code, 'cross_client_collision');
    assert.deepEqual(storage.state.leads, [scalelabLead]);
  });
});

test('import: a trade type ScaleLab resolvers would claim is refused, never stamped ScaleLab', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1, { tradeType: 'staffing' })]));
    assert.equal(res.body.written, 0);
    assert.equal(res.body.refusals[0].code, 'ownership_conflict');
    assert.equal(storage.state.leads.filter(lead => lead.clientId === 'scalelab').length, 0);
  });
});

test('import: global suppression and Jole client suppression are preserved', async () => {
  const storage = memoryStorage({
    suppressed: ['pat1@gulffab1.com'],
    clientEntries: { available: true, entries: [
      { client_id: 'jole', match_type: 'domain', match_value: 'gulffab2.com', active: true },
      // Another client's entry never applies to Jole.
      { client_id: 'scalelab', match_type: 'domain', match_value: 'gulffab3.com', active: true },
    ] },
  });
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1), row(2), row(3)]));
    assert.deepEqual(res.body.refusals.map(r => [r.email, r.code]).sort(), [
      ['pat1@gulffab1.com', 'globally_suppressed'], ['pat2@gulffab2.com', 'client_suppressed'],
    ]);
    assert.deepEqual(storage.state.leads.map(lead => lead.email), ['pat3@gulffab3.com']);
  });
});

test('import: fails closed — unreadable client suppression or corpus writes nothing', async () => {
  for (const options of [{ clientEntries: { available: false, reason: 'client ledger is disabled' } }, { clientEntries: { error: 'timeout' } }, { failCorpus: true }]) {
    const storage = memoryStorage(options);
    await withServer(storage, async post => {
      const res = await post(URL_JOLE, importBody([row(1)]));
      assert.ok(res.status >= 400, JSON.stringify(options));
      assert.equal(storage.state.appends, 0);
    });
  }
});

test('import: dryRun runs every check and writes nothing', async () => {
  const storage = memoryStorage();
  await withServer(storage, async post => {
    const res = await post(URL_JOLE, importBody([row(1), row(2)], { dryRun: true }));
    assert.deepEqual([res.body.dryRun, res.body.accepted, res.body.written], [true, 2, 0]);
    assert.equal(storage.state.appends, 0);
  });
});

test('import: a lost response is safe to retry — only unwritten rows are written', async () => {
  const storage = memoryStorage({ failAppendAfter: 2 });
  await withServer(storage, async post => {
    const failed = await post(URL_JOLE, importBody([row(1), row(2), row(3)]));
    assert.equal(failed.status, 500);
  });
  assert.equal(storage.state.leads.length, 2);
  // Same storage, the write path now healthy.
  const healthy = memoryStorage({ leads: storage.state.leads });
  await withServer(healthy, async post => {
    const retry = await post(URL_JOLE, importBody([row(1), row(2), row(3)]));
    assert.deepEqual([retry.body.written, retry.body.duplicates], [1, 2]);
    assert.deepEqual(healthy.state.leads.map(lead => lead.email).sort(), ['pat1@gulffab1.com', 'pat2@gulffab2.com', 'pat3@gulffab3.com']);
  });
});

test('import: one import per client at a time', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const storage = memoryStorage();
  const slow = { state: storage.state, importLeads: async options => { await gate; return storage.importLeads(options); } };
  await withServer(slow, async post => {
    const first = post(URL_JOLE, importBody([row(1)]));
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await post(URL_JOLE, importBody([row(2)]));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'import_in_progress');
    release();
    assert.equal((await first).body.written, 1);
  });
});

test('import: without a bound importer the route is unavailable, not a silent no-op', async () => {
  const app = express();
  app.use(express.json());
  registerClientRoutes(app, { requireAuth: (_q, _s, next) => next(), loadDataset: async () => ({ leads: [] }), getStore: () => null, senders: () => [], routedLeadReady, env: {}, log: { log() {}, error() {} } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${URL_JOLE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(importBody([row(1)])) });
    assert.equal(res.status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('import does not enable anything: copy approved, but Jole sending disabled and capacity 0', () => {
  const campaign = clientCampaign(CAMPAIGN);
  assert.equal(campaign.id, CAMPAIGN);
  assert.equal(campaign.clientId, 'jole');
  assert.equal(campaign.status, 'approved');
  assert.equal(campaign.label, 'Jole BTX — Industrial Employers | MFG + Heavy Industry');
  assert.equal(campaignSendable(campaign).ok, true);
  assert.equal(clientTemplate(campaign.emailTemplateId).ready, true);
  assert.equal(require('../integrations/clients/send-policy').clientSendBlock('jole', {}).code, 'client_sending_disabled');
  assert.equal(clientSendState('jole', {}).sendingEnabled, false);
  assert.deepEqual(getClient('jole').capacity, { dailyCap: 0, windowCap: 0, reservedDaily: 0, reservedWindow: 0 });
  assert.deepEqual(getClient('jole').senderPolicy.allowedCampaignIds, [CAMPAIGN]);
});

// ── Jole copy ───────────────────────────────────────────────────────────────
const LEAD = { firstName: 'Theodore', company: '110 Metalworks', roles: ['Tig Welder'], location: 'Liverpool, NY', landingPageUrl: 'https://jole-landing.netlify.app/', mailingAddress: ADDRESS };

test('copy: touch 1 renders the approved one-role, two-role and reviewed-fallback openers', () => {
  const one = renderJoleEmployerStep({ ...LEAD, step: 1 });
  assert.equal(one.subject, 'Tig Welder');
  assert.equal(one.coreBody, 'Hi Theodore,\n\nSaw 110 Metalworks is hiring Tig Welder in Liverpool, NY.\n\nCurious — are you already covered on that, or still open to additional staffing support?\n\nJorge');
  assert.match(one.body, /Jorge Guerrero\nCEO\nJole BTX LLC\n1200 Industrial Pkwy/);
  assert.match(one.body, /This is a commercial email\. Not relevant\? Reply "unsubscribe"/);
  const two = renderJoleEmployerStep({ ...LEAD, step: 1, roles: ['Welder', 'Machinist'] });
  assert.equal(two.variant, 'two_roles');
  assert.match(two.coreBody, /hiring Welder and Machinist in Liverpool, NY\.\n\nCurious — are you already covered on those/);
  const fallback = renderJoleEmployerStep({ ...LEAD, step: 1, roles: [], location: '' });
  assert.equal(fallback.subject, 'skilled trades');
  assert.doesNotMatch(fallback.coreBody, /is hiring/);
});

test('copy: only touch 2 carries a link, and only the approved HTTPS Jole landing page', () => {
  const t2 = renderJoleEmployerStep({ ...LEAD, step: 2 });
  assert.equal(t2.subject, null);
  assert.equal((t2.body.match(/https?:\/\//g) || []).length, 1);
  assert.match(t2.coreBody, /Worth a conversation if Tig Welder is still a priority\?/);
  for (const url of ['', 'http://jole-landing.netlify.app', 'https://scalelabai.ca/staffing', 'https://example.com', '{{jole_landing_page_url}}']) {
    assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 2, landingPageUrl: url }), /landing page/, url);
  }
  const t3 = renderJoleEmployerStep({ ...LEAD, step: 3 });
  assert.match(t3.coreBody, /Should I keep Jole in mind if 110 Metalworks needs additional skilled-trade labor/);
  assert.doesNotMatch(t3.body, /https?:\/\//);
});

test('copy: missing or unsafe variables and a missing Jole address refuse to render', () => {
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 1, firstName: '' }), /first_name/);
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 1, company: 'Acme\nBcc: x@y.com' }), /company/);
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 1, roles: ['{{role}}'] }), /role/);
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 1, location: '' }), /location/);
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 1, mailingAddress: '' }), /mailing address/);
  assert.throws(() => renderJoleEmployerStep({ ...LEAD, step: 4 }), /invalid Jole step/);
  // Offline review without the footer still renders the approved core copy.
  assert.equal(renderJoleEmployerStep({ ...LEAD, step: 1, mailingAddress: '' }, { withFooter: false }).body,
    renderJoleEmployerStep({ ...LEAD, step: 1 }).coreBody);
});

test('copy: the template carries the final Jole copy and never ScaleLab\'s staffing-agency offer', () => {
  const template = clientTemplate('jole-industrial-employer-v1');
  assert.equal(template.clientId, 'jole');
  assert.equal(template.copy, JOLE_INDUSTRIAL_EMPLOYER_COPY);
  assert.equal(template.copyVersion, 'jole_industrial_employer_v1');
  assert.equal(template.copy.steps.length, template.sequenceSteps);
  assert.deepEqual(template.copy.steps.map(step => step.sendAfterBusinessDays), [0, 3, 4]);
  const all = JSON.stringify(template.copy);
  assert.doesNotMatch(all, /scalelab|employer accounts|SA-48271|meeting fee|receptionist/i);
  assert.doesNotMatch(all, /jole-btx['"]/);
});
