# Multi-client architecture (managed clients)

SalesPipeline2 is an **internal ScaleLab operator platform**. A "client" is a
managed client whose outreach ScaleLab runs. Clients never log in, never see
this system and have no permissions in it. There is no client-facing surface.

- `scalelab` — ScaleLab AI. The default client. Every record that existed
  before this change belongs to it.
- `jole` — Jole Enterprise. First external managed client. Active, **sending
  disabled**.

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

### Lead ownership is derived, not stored

Adding a tenant column to `ColdEmail` would move ~30 A:X read/write sites in
`server.js` and `outreach-agent.js` (the concurrent session's files) and add a
column that can drift from the routing fields that actually decide a send.
Instead a lead's client is a pure function of fields both stores already carry
verbatim — `leadNiche`, `emailTemplateId`, `intendedCampaignVersion`,
`campaign`, `tradeType`, `senderInboxId`:

- each field yields zero or one client signal (registry lookup, a client's
  namespace prefix such as `jole_`, or a legacy ScaleLab family keyword such as
  `dent` / `roof` / `staffing`);
- no signal ⇒ `scalelab` (the legacy default, backed by the data above);
- one client ⇒ that client;
- two clients ⇒ `client_ownership_conflict`, which blocks routing, queueing,
  reservation and sending. Nothing is repaired or guessed at send time.

Because Sheets and Supabase hold identical strings for those fields, a lead
cannot be `jole` in one store and `scalelab` in the other: there is no split
brain to reconcile. `scripts/client-ownership-audit.js` reports the
distribution and any conflicts read-only.

The legacy default is **one-directional**: absence of ownership resolves to
`scalelab`; a non-default client must be asserted explicitly by every entity
(lead signals, registered sender, registered campaign, registered template).
A Jole lead with an unregistered or ScaleLab sender is therefore a conflict,
never a fallback.

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
refuses Jole with `client_sending_disabled` even when every other gate passes.

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

## 3. Known limits

- One lead row per email address across all clients (global unique index,
  email-based reply matching). A cross-client collision is refused at import
  validation.
- The global send ceilings (per day / per window) are shared by all senders.
  A per-client ceiling should be added before Jole launches.
- Legacy workspaces (Pipeline, Inbox, Analytics, Staffing Funnel) are ScaleLab
  views. When Jole is selected the dashboard shows the Client Operations
  workspace instead.

## 4. Enabling in production (in order)

1. Deploy this branch **only after** it has been reconciled onto a `main` that
   contains the sending-logic repair (see section 6).
2. Deploy with `CLIENT_LEDGER_ENABLED` unset. Behaviour for ScaleLab is
   unchanged: every production lead resolves to `scalelab` (audit below), the
   client suppression list is inert, and Jole refuses with
   `client_sending_disabled`.
3. Apply `supabase/migrations/20260930000000_client_ledger.sql` (additive).
4. Set `CLIENT_LEDGER_ENABLED=true`. From then on each send also reads the
   client suppression list for that one lead; if that read fails, the send is
   refused for every client (fail closed).
5. `node -r dotenv/config scripts/client-ownership-audit.js` must report
   `conflicts: 0, senderMismatches: 0`.

Production audit on 2026-09-29 (read-only): 2,349 leads, all `scalelab`,
0 conflicts, 0 sender mismatches.

## 5. Before Jole Campaign #1 can send

1. Jole sending domain(s) purchased, with SPF/DKIM/DMARC.
2. Inboxes created and warmed.
3. Gmail OAuth tokens (`GMAIL_JOLE_<NAME>_TOKEN_JSON`) and registry entries in
   `GMAIL_INBOX_REGISTRY_JSON` with `"clientId": "jole"`; identity verified.
4. A per-client daily ceiling, so Jole senders do not draw on ScaleLab's shared
   200/day and 21/window ceilings.
5. Final campaign copy approved, template `jole-dc-mission-critical-v1` built
   and marked `ready`, campaign status moved to `approved`.
6. Leads researched, validated with
   `POST /api/clients/jole/leads/import-validate`, then imported.
7. Leads routed and queued to Jole senders only.
8. Sender status moved to `active` behind the healthy-observer gate.
9. Timezone and booking details confirmed with Jorge.
10. Explicit enablement: `sending.enabled: true` for `jole` in a reviewed commit
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
