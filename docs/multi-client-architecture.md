# Multi-client architecture (managed clients)

SalesPipeline2 is an **internal ScaleLab operator platform**. A "client" is a
managed client whose outreach ScaleLab runs. Clients never log in, never see
this system and have no permissions in it. There is no client-facing surface.

- `scalelab` — ScaleLab AI. The default client. Every record that existed
  before this change belongs to it.
- `jole` — Jole Enterprise. First external managed client. **Onboarding
  pending: not active, sending disabled, capacity 0.**

### Client lifecycle

`lifecycleStatus` ∈ `onboarding_pending`, `active`, `paused`, `offboarded`.
`active` must equal `lifecycleStatus === 'active'`; nothing is inferred from a
config existing. A managed client can only be `active` when every onboarding
item is true (`agreementSigned`, `onboardingFormReturned`, `setupBalancePaid`)
**and** `activation.activatedBy` / `activatedAt` record the operator who
activated it — the registry refuses anything else at load. `sending.enabled`
requires `active`; a client that is not active must have zero caps and zero
reservations.

While not active: every send path refuses with `client_inactive` (final gate,
capacity layer and the Gmail provider boundary itself), and no fulfillment
record (opportunity, meeting, clarification, invoice) can be written
(`client_not_active`). The internal workspace can be read, and client
suppression entries can be recorded (they only ever block).

Jole on 2026-09-29: agreement not signed, onboarding form not returned, $175
setup balance unpaid → `onboarding_pending`.

**Activating a client** (after onboarding is complete) is one reviewed commit
to `client-configs.js`: set the onboarding items true, `activation`
(`activatedBy`, ISO `activatedAt`), `lifecycleStatus: 'active'`, `active: true`.
Enabling sending is a separate, later commit (`sending.enabled`, caps,
reservations) plus `CLIENT_SENDING_AUTHORIZED` on the service.

## 1. Baseline audit (2026-09-29, before any edit)

Branch `feat/multi-client-jole` was cut from `origin/main` 901c062.

### Concurrent work (not touched)

| Ref | What | State on 2026-09-29 |
|---|---|---|
| `fix/capacity-weighted-sender-assignment` e06e538 (worktree `wt-balance`) | Fills every inbox's daily cap before the 15% buffer (`sender-balance.js`, `outreach-queue.js`, `server.js`) | Pushed to the production branch; **not in `main`** |
| `codex/staffing-salvage-deploy` de8c426 | Personalization fallback for staffing leads (`staffing-*.js`, `outreach-queue.js`) | Under e06e538 on the production branch; not in `main` |
| Primary checkout (`feat/deniels-gmail-sender`) | Uncommitted edits to queue/readiness/personalization/send-authorization tests | Left exactly as found |

### How ownership works today

| Concern | Where | Ownership today |
|---|---|---|
| Leads | Supabase `outreach_leads` (canonical, `primary` + `supabase` writes); Sheets `ColdEmail` A:X mirror | 24 text columns mirrored verbatim; no tenant column. Global unique index on `email_normalized`. |
| Campaigns | `integrations/campaign-versions.js` (source-controlled, immutable ids) | Implicitly ScaleLab (dental, roofing, staffing families) |
| Templates / lead types | `integrations/campaign-routing.js` `EMAIL_TEMPLATES`, `LEAD_TYPES` | Implicitly ScaleLab |
| Senders | `gmail-inbox-registry.js` defaults + `GMAIL_INBOX_REGISTRY_JSON` + runtime overlay; `gmail-sender-routing.js configuredSenders()` | Implicitly ScaleLab. `allowedForLead` admits **any** send-eligible sender for dental leads and routes unknown niches to `primary`. |
| Queue / auto-assignment | `outreach-queue.js`, `sender-balance.js` → `validateRoute` + `allowedForLead` | Niche-based only |
| Final gate | `send-safety-revalidate.js guardProviderSend` | No sender argument; no tenant check |
| Reservations | `send-lock.js` / `outbound_send_reservations` (separate Postgres) keyed by `gmail-cold:<lead>:step:<n>` | A reservation inherits the lead |
| Suppression | Sheets `Suppression` tab (email, column A) + sticky note tags | One global list |
| Replies | Agent check pass + Gmail observers; observers match **all** leads per inbox; `suppressionForCanonical` writes `not_interested` to the global list | Client-blind |
| Meetings | Google Calendar sync → Pipeline stages | ScaleLab only; no billing ledger |

### Production data evidence (read-only SQL, 2026-09-29)

`outreach_leads`: 2,349 rows. `lead_niche` ∈ {'' (1,026), dental (649),
industrial_staffing (500), roofing (174)}. `sender_inbox_id` ∈ {'' , primary,
tryscalelabai, scalelabaiteam, deniels, deniels_tryscalelabai}.
`email_template_id` ∈ {'', dental-guarantee-v1, industrial-staffing-employer-v1,
roofing-survey-v1}. `intended_campaign_version` ∈ {'', dental_v3_pay_per_booking,
industrial_staffing_employer_acquisition_v1}. **Zero** rows mention `jole` in any
ownership column. Every historical row therefore resolves to `scalelab` under
the rules below, with no backfill write.

## 2. Design

### Client registry (`integrations/clients/`)

| Module | Role |
|---|---|
| `client-configs.js` | Source-controlled client configuration (identity, namespace, send control, timezone, escalation, booking, qualification, billing, reporting, campaign defaults, reply policy). Adding client #3 is a new entry here plus its campaigns. |
| `registry.js` | `getClient`, `listClients`, `resolveClientId` (unknown ids rejected), `DEFAULT_CLIENT_ID`. Validates every config at load. |
| `campaigns.js` | Client campaign registry. Jole campaigns (`JOLE_DC_MISSION_CRITICAL`, placeholders `JOLE_GULF_INDUSTRIAL`, `JOLE_SHIPYARD`), their lead types and templates. ScaleLab campaigns are the existing `CAMPAIGN_VERSIONS`, owned by `scalelab`. |
| `ownership.js` | Resolves the client of a lead, sender, campaign and template, and the one consistency check every route, queue, reservation and send uses. |
| `send-policy.js` | Client-level send control. |
| `suppression.js` | Suppression scopes: global → client. |
| `reply-policy.js` | Client-aware reply workflow states and reply context resolution. |
| `ledger.js`, `ledger-store.js` | Opportunity / meeting / clarification ledger, billing derivation, Supabase + in-memory stores. |
| `reporting.js` | Server-side client-scoped metrics. |
| `reply-pipeline.js` | Handling of replies for clients with a managed (non-legacy) reply policy. |
| `routes.js` | Internal `/api/clients/*` endpoints (Basic-auth, operator only). |
| `email-scope.js` | Tenant-scoped email identity and the uniqueness interlock. |
| `capacity.js` | Client daily / window caps and reservations. |
| `ownership-backfill.js` | Plans the Sheets column Y backfill and refuses on any split brain. |

### Lead ownership is explicit

`lead.clientId` is the canonical owner: `outreach_leads.client_id` (NOT NULL,
foreign key to `clients`) and ColdEmail column **Y**. It is the 25th canonical
field, mirrored and parity-checked like the other 24.

- **Primary:** an explicit `clientId` must name a registered client, and the
  lead's routing fields (`leadNiche`, `emailTemplateId`,
  `intendedCampaignVersion`, `campaign`, `tradeType`) must not name a different
  one. A contradiction is `client_ownership_conflict`.
- **Fallback (legacy rows only):** a blank `clientId` is inferred from those
  routing fields; no signal means `scalelab`. This only covers rows mirrored
  before the backfill; every write path now stamps an explicit owner (legacy
  ScaleLab imports stamp `scalelab`, managed imports stamp their client).
- A blank owner is never written to Supabase: inserts take the column default,
  updates keep the stored owner, and a patch cannot clear it. The legacy
  full-row PUT writes A:X only and can never change column Y.
- Parity compares the **effective** owner, so a Sheets cell not yet backfilled
  agrees with a stored `scalelab`, while `jole` in one store and `scalelab` in
  the other is a critical mismatch.

At operational boundaries lead ↔ campaign ↔ template ↔ sender must agree, as
before; the lead side is now its explicit owner.

### Email identity is tenant-scoped

One lead per `(client_id, normalized email)`. The same address may be a
prospect of two clients; inside one client it is exactly one lead, so no client
can mail a person twice. Every email → lead lookup happens inside one client's
scope (`integrations/clients/email-scope.js`), and an ambiguous match fails
safe:

| Path | Scope |
|---|---|
| Gmail observers, legacy human-outbound scan | the inbox's client (`leadsInEmailScope`). Unscoped, the observer throws on an ambiguous identity and would stall. |
| Google Calendar booking match | clients whose booking mode is Calendar sync (ScaleLab). Unscoped, a duplicate is a conflict, and a failed Calendar sync blocks all automation. |
| Pipeline board twins, stage-sequence twins, board ↔ lead joins | ScaleLab only (the board is ScaleLab's) |
| Queue identity | one lead per address inside the lead's client |
| CRM Health / analytics duplicate checks | grouped per client |
| `getOutreachLeadByEmail` | takes `clientId`; refuses to pick one of two clients' leads |
| Imports | dedupe inside the importing client once tenant-scoped (below) |

Conflicted leads (no single owner) stay visible to every scope for protective
handling (opt-outs, bounces) unless their address collides with an in-scope
lead. Global suppression (the Suppression list) still blocks an address for
every client; client suppression stays client-specific.

**Interlock.** `20260930010000` adds `client_id` and the per-client unique
index *alongside* the global one. `20260930020000` drops the global index and
is applied only after this code is live. `OUTREACH_EMAIL_UNIQUENESS=client` is
then set; until it is, imports refuse an address that exists under any client
(otherwise the Sheets append would succeed and the Supabase mirror fail).

### Client send capacity

`GLOBAL SYSTEM CAP → CLIENT CAP → CAMPAIGN CAP → SENDER CAP → WINDOW CAP`.
`integrations/clients/capacity.js` decides the first two; the rest are the
existing checks, unchanged. Per client: `dailyCap`, `windowCap` (null = none)
and `reservedDaily`, `reservedWindow` (capacity other clients may not consume).
Effective remaining = min(global remaining − other *sending* clients' unused
reservations, the client's cap − its sends). A client that cannot send has
zero capacity and reserves nothing. ScaleLab: no caps, no reservation (its
behaviour is exactly the global numbers). Jole: 0 / 0 until launch. The agent
checks it before every sender choice and records each provider success
(`[client-cap]` log line per send pass).

### Where isolation is enforced

| Layer | Check |
|---|---|
| `validateRoute` (queue dialog, auto-assignment, rebalance) | lead ↔ sender ↔ template ↔ campaign clients agree |
| `routedLeadReady` (selection) | lead ownership resolves without conflict; non-default clients need a registered, ready campaign and template |
| `allowedForLead` (every sender choice: pinned, assigned, dynamic) | sender client = lead client; no cross-client fallback |
| `guardProviderSend` / `evaluateFreshSendSafety` (final gate) | ownership of the fresh row + the sender about to send; client active; client sending enabled; global then client suppression |
| `withOutboundReservation` | an action carrying ownership must agree before a row is reserved |
| Gmail observers | an inbox only matches leads of its own client (conflicted leads stay visible so protective handling still runs) |
| Reply pipeline | sender client = lead client = campaign client, else the reply is recorded as isolation-blocked and not applied |
| Ledger | composite `(opportunity_id, client_id)` foreign keys make a meeting or clarification of another client's opportunity impossible in the database |

### Client send control

`sending.enabled` in the client config **and**, for non-default clients,
`CLIENT_SENDING_AUTHORIZED` (comma list) naming the client. Jole ships with
`sending.enabled: false` and is not in any env allow-list, so the send engine
refuses Jole with `client_inactive` (it is not an active client) even when every
other gate passes; once activated it would still refuse with
`client_sending_disabled` until sending is enabled.

### Suppression order

1. Global: the existing `Suppression` tab and sticky note tags — unchanged,
   applies to every client (unsubscribe, bounce, compliance).
2. Client: `client_suppressions` (email, domain or company key) for one client.
3. Campaign / recipient safeguards, then the existing gates.

Unsubscribes and bounces stay global. A **negative** reply is global for
`scalelab` (unchanged) and client-scoped for `jole`.

### Ledger

`supabase/migrations/20260930000000_client_ledger.sql` adds `clients`,
`client_opportunities`, `client_meetings`, `client_clarifications`,
`client_suppressions` and `client_ledger_events`. Additive only. Supabase is the
only store for these rows (no Sheets mirror), so there is nothing to split.

Meeting states: `BOOKED`, `RESCHEDULED`, `CANCELLED`, `NO_SHOW`, `HELD`,
`QUALIFIED_HELD`, `DISQUALIFIED_HELD`. Billable only from `QUALIFIED_HELD`,
which requires a held timestamp, an in-ICP employer, a decision-maker attendee
and a staffing use case (current, upcoming, recurring or project-based). The
fee is snapshotted from the client's billing config when the meeting is
qualified, so a later price change never rewrites history.

## 3. Known limits and pre-launch gaps

### Migration validation (real PostgreSQL)

`scripts/validate-client-migrations.js` runs all three migrations against a
real PostgreSQL 17.9 server (UTF-8), each in a transaction as Supabase applies
them, on the production baseline with production-shaped ScaleLab rows.
2026-09-29: **46/46 checks passed** — clean application; RLS on all ledger
tables; composite FKs refuse cross-client meetings/clarifications; the billing
check constraint; `client_id` NOT NULL DEFAULT `scalelab`, FK, per-client
unique index; every existing row backfilled and byte-for-byte unchanged; all
three migrations re-run safely; the managed-client guard refuses and rolls back
completely; wrong order is refused (ledger missing → rollback; tenant migration
before `client_id` → refused, global index untouched); rolling back the tenant
migration restores the global index; cross-client duplicates allowed only after
the tenant migration; same-client duplicates always refused (case and spaces
normalized); the only destructive change anywhere is the intended drop of
`outreach_leads_email_normalized_key`.

### Gaps assessed for deployment (Jole inactive, sending off, capacity 0)

| Gap | Can it send or break isolation now? | Status |
|---|---|---|
| A. Sheets-mode dashboard reads (`A:O` + `Q:X`) do not read column Y | No. Production reads the dashboard dataset from Supabase (`client_id` present); the queue reads A:Y or Supabase; the final gate reads fresh via the agent (A:Y or Supabase). Only the Supabase-unavailable fallback and non-primary mode infer the owner, and mis-scoping needs a Jole lead whose only Jole signal is column Y — no Jole lead can exist (no managed import path; the legacy import refuses managed owners). | **Not a deployment blocker. Mandatory before the first Jole lead import:** read column Y in the Sheets-mode dashboard reads. |
| B. Demo-intent pass not metered by client capacity within one pass | No. The intent pass sends only through `deliverHardenedWarmReply` → final gate (`purpose: 'warm'`, which enforces the client switch) → `sendEmail` → `withGmailProviderSend`, which now also refuses a lead whose client may not send. A Jole lead is refused at two layers. | **Not a deployment blocker. Mandatory before Jole sending is enabled:** meter warm/intent sends against client capacity (or restrict the intent pass to ScaleLab leads). |

### Other limits

- The dashboard's Sheets-mode split reads (`A:O` + `Q:X`, used only when
  Supabase is not canonical) do not read column Y; such rows fall back to
  inferred ownership.
- The demo-intent pass (ScaleLab warm sends) is not metered by the client
  layer within a pass; it is counted from the activity ledger on the next pass,
  and a managed client can never send through it (final gate).
- Legacy workspaces (Pipeline, Inbox, Analytics, Staffing Funnel) are ScaleLab
  views. When Jole is selected the dashboard shows the Client Operations
  workspace instead.

## 4. Enabling in production (in order)

**Migrations 1 and 2 go in BEFORE the code deploy.** ScaleLab writes never
send `client_id` (the column default supplies it), so ScaleLab cannot break if
the order slips, but a managed client's lead writes `client_id` explicitly and
needs the column. Both migrations are safe under the current production code:
it never writes `client_id` (the default fills it) and ignores the extra column
on read.

1. Apply `20260930000000_client_ledger.sql` (new tables only).
2. Apply `20260930010000_outreach_leads_client_id.sql`: adds `client_id` with
   the `scalelab` default (that default is the backfill of all existing rows)
   and the per-client unique index; aborts if any row already names a managed
   client. Verify with `scripts/client-ownership-audit.js`.
3. Deploy the code (outside send windows) with `CLIENT_LEDGER_ENABLED` and
   `OUTREACH_EMAIL_UNIQUENESS` unset. ScaleLab behaviour is unchanged: every lead
   resolves to `scalelab`, client capacity equals the global numbers, Jole
   refuses with `client_inactive`. On first boot the server extends the
   ColdEmail header with `clientId` (Y1), its existing header-repair behaviour.
4. `node scripts/client-id-backfill.js` (dry run) must report
   `mismatch: 0, conflict: 0, notInStore: 0`; then `--apply` writes column Y in
   one update. Read-only simulation on 2026-09-29: 2,349 fills, 0 blocking.
5. Set `CLIENT_LEDGER_ENABLED=true`.
6. Before any managed client imports an address ScaleLab already has: apply
   `20260930020000_outreach_leads_tenant_scoped_email.sql`, then set
   `OUTREACH_EMAIL_UNIQUENESS=client`.

## 5. Before Jole Campaign #1 can send

1. Jole sending domain(s) purchased, with SPF/DKIM/DMARC.
2. Inboxes created and warmed.
3. Gmail OAuth tokens (`GMAIL_JOLE_<NAME>_TOKEN_JSON`) and registry entries in
   `GMAIL_INBOX_REGISTRY_JSON` with `"clientId": "jole"`; identity verified.
4. Jole capacity (`dailyCap`, `windowCap`) and ScaleLab's reservation
   (`reservedDaily`, `reservedWindow`) set in the same reviewed commit that
   enables Jole, so Jole cannot draw on ScaleLab's share of 200/day, 21/window.
5. Final campaign copy approved, template `jole-dc-mission-critical-v1` built
   and marked `ready`, campaign status moved to `approved`.
6. Leads researched, validated with
   `POST /api/clients/jole/leads/import-validate`, then imported.
7. Leads routed and queued to Jole senders only.
8. Sender status moved to `active` behind the healthy-observer gate.
9. Timezone and booking details confirmed with Jorge.
10. Onboarding complete (agreement signed, onboarding form returned, $175 setup
    balance paid) and the activation commit made (see Client lifecycle).
11. Gap A and gap B above closed.
12. Explicit enablement: `sending.enabled: true` for `jole` in a reviewed commit
    **and** `CLIENT_SENDING_AUTHORIZED=jole` on the service.

## 6. Reconciling with the sending-logic repair

This branch changes these shared files: `campaign-routing.js`,
`gmail-sender-routing.js`, `gmail-inbox-registry.js`, `send-lock.js`,
`send-safety-revalidate.js`, `outreach-agent.js`, `server.js`,
`test/send-authorization.test.js`. The concurrent repair
(`fix/capacity-weighted-sender-assignment`, `codex/staffing-salvage-deploy`)
touches `sender-balance.js`, `outreach-queue.js`, `staffing-*.js` and
`server.js` (`senderBalanceView` only). There is no textual overlap as of
2026-09-29. The one semantic dependency: `sender-balance.js senderCompatible()`
must keep calling `validateRoute()` and `allowedForLead()`, which is where
client isolation for automatic assignment lives. Merge the new `main` in, keep
the repair's version of every file it owns, then rerun the full suite and the
`client-*` suites.
