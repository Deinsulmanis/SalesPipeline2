# Code map — outreach safety

Where each guarantee lives. Paths are relative to the repo root. Verify a symbol
with `grep` before relying on it; this map describes structure, not line numbers.

## Processes

| Process | Entry | Role |
|---|---|---|
| Web server | `server.js` | Dashboard API, cron scheduler, Calendar sync, landing collector, egress meter. Spawns the agent. |
| Outreach agent | `outreach-agent.js` | One pass per spawn: send window (:00/:30), check-only (:15/:45: replies, bounces, observers), intent-only (backstop). Reads the canonical corpus once at run start (`readLeads(snapshot.coldEmail)` in `run()`). |

Only one agent pass runs at a time (`launchAutomationAfterCalendar` reserves the
slot synchronously). `/api/agent/status` shows `running`.

## Send path (in order)

| Step | Where |
|---|---|
| Selection / cadence | `outreach-agent.js` (`selectQueued`, follow-up selection), `integrations/outreach-queue.js` |
| Ownership verdict | `integrations/automation-ownership.js` → `deriveAutomationOwnership` (OWNER / BLOCKED_BY) |
| Suppression verdict | `integrations/pipeline-state.js` → `sendSuppressionReason`, `SEND_SUPPRESSION_TAGS`, `manualHoldReleased` (`[RESUME: <ISO>]`) |
| Process authorization | `integrations/send-authorization.js` (`SENDING_ENABLED` + `SEND_AUTHORIZED_ENV` must match the runtime) |
| Final fresh gate | `integrations/send-safety-revalidate.js` → `guardProviderSend` → `revalidateFreshSendSafety` → `evaluateFreshSendSafety` (codes: `revalidation_unavailable`, `identity_changed`, `manual_hold`, `unsubscribed`, `not_interested`, `bounced`, `suppressed`, `terminal_state`, `staffing_launch_paused`) |
| Fresh single-lead read | `integrations/fresh-send-state.js` → `createFreshSendStateLoader` / `freshLeadFromSnapshot` (Supabase `getOutreachLeadById` in primary+supabase mode; Sheets rows otherwise). Wired in `outreach-agent.js` `freshSendSafetyDeps()` and the warm-reply final gate. |
| Reservation | `integrations/send-lock.js`, `send-reservation-rules.js` (STATUS, takeover rules), `send-reservation-store.js` (table `outbound_send_reservations`), `outbound-action-id.js` (deterministic ids) |
| Uncertain-send handling | `integrations/send-reconciliation.js` (operator actions; never a resend), `provider-delivery-error.js` |
| Threading / sender ownership | `integrations/gmail-threading.js`, `provider-ownership.js`, `gmail-followup-safety.js`, `gmail-sender-routing.js` |
| Caps / windows | `integrations/gmail-sender-capacity.js`, `sending-window-quota.js`, `gmail-inbox-registry.js` (+ runtime overlay sheet). The boot log's cap summary is computed before the overlay loads — trust the per-window `remaining` line and `[cap] N/<ceiling>`. |

## Canonical state

| Concern | Where |
|---|---|
| Reads / writes of `outreach_leads` | `integrations/outreach-state.js` — `readOutreachCorpus` (full corpus; run-start only), `getOutreachLeadById`, `getOutreachLeadByEmail`, `applyLeadChange` (CAS on `revision` + Sheets mirror) |
| Mirror-fallback policy | `outreach-state.js` → `sheetsFallbackAllowed(purpose, env)` |
| Sticky markers | `outreach-state.js` → `SAFETY_NOTE_MARKERS`, `RELEASABLE_NOTE_MARKERS`, `preserveSafetyMarkers`, `mergeNotesPatch` (`releaseMarkers`, `optOutCorrection`) |
| Activity ledger | Sheets `ColdCallActivity` mirrored to Supabase (`supabase-mirror.js`); events carry stable ids (`stableActivityId`) |
| Pipeline board | Sheets `Leads` (card id `CE-<leadId>`); new rows only via `integrations/leads-sheet-append.js` → `appendLeadsRow` (appendCells, never `values.append`, which can land in the wrong column block) |
| Suppression list | Sheets `Suppression` (loaded by the snapshot; `[Suppression] loaded N` in logs) |

## Replies

| Concern | Where |
|---|---|
| Prospect-owned text | `integrations/mailbox-observation-events.js` → `ownReplyText` (plain → HTML cut at quote → snippet); `humanReplyText` (our own outbound: text/plain only) |
| Quote stripping | `integrations/reply-reconciliation.js` → `stripQuotedReply` (HTML-aware; line and mid-line attribution markers; scrubs our own outbound copy) |
| MIME helpers | `integrations/gmail-mailbox-observer.js` → `firstPlainText`, `firstHtmlText` |
| Classification | `integrations/reply-classifier.js`, `canonical-reply.js`, `reply-decision.js` |
| Replay of stored verdicts | `integrations/inbound-reply-guard.js` → `recordedTerminalReply`; `late-reply.js` |
| Human overrides | `integrations/reply-overrides.js`; `POST /api/leads/:id/reply-override` (+ `/reverse`) |
| False opt-out correction | `integrations/false-opt-out-correction.js` → `applyFalseOptOutCorrection`; `POST /api/coldemail/:id/false-opt-out-correction` |

## Observers

| Concern | Where |
|---|---|
| Gmail history observation | `integrations/gmail-mailbox-observer.js` → `observeMailbox`, `listChangedIds` (cursor adopted only after all pages; bounded pages; identity check; quota backoff) |
| Health | `integrations/gmail-observer-health.js`; surfaced by `GET /api/integrations/gmail-inboxes` (also shows caps; costs one server corpus read) |
| Sent-mail detection | `integrations/human-outbound.js` (observer owns it; the legacy scan logs `skipped … observer_owns_sent`) |

## Calendar

| Concern | Where |
|---|---|
| Sync | `integrations/google-calendar.js` → `runGoogleCalendarSync` (zero events ⇒ no CRM load; any failed plan item throws ⇒ checkpoint not advanced) |
| Launch gate | `server.js` → `observeCalendarBeforeAutomation`, `launchAutomationAfterCalendar` (`[Calendar safety] … blocked` in logs) |
| Booking → promotion | `server.js` `applyCalendarPlanItem`; `integrations/promotion-policy.js` (`promotionSuppressionReason` blocks automatic promotion of suppressed leads) |

## Managed clients

| Concern | Where |
|---|---|
| Client registry / config | `integrations/clients/registry.js`, `client-configs.js` (Jole: sending disabled, no platform access) |
| Ownership (lead/sender/campaign/template) | `integrations/clients/ownership.js` → `checkClientConsistency`; enforced in `validateRoute`, `routedLeadReady`, `allowedForLead`, `evaluateFreshSendSafety`, `withOutboundReservation`, observers, reply loop |
| Client send switch | `integrations/clients/send-policy.js` (`sending.enabled` + `CLIENT_SENDING_AUTHORIZED`) |
| Suppression scopes | `integrations/clients/suppression.js` (global → client), `ledger-store.js` `client_suppressions` |
| Managed replies / clarifications / meetings | `reply-policy.js`, `reply-pipeline.js`, `ledger.js` |
| Design + launch checklist | `docs/multi-client-architecture.md` |

## Read-only production endpoints (Basic auth)

`/api/agent/status`, `/api/send-lock/health`, `/api/send-lock/reservations`,
`/api/integrations/gmail-inboxes`, `/api/landing/collector-health`,
`/api/landing/funnel` (`status.trackingEnabled`), `/api/leads`,
`/api/integrations/google-calendar/dry-run`, `/api/crm/health`.

## Logs worth grepping (Railway)

`[egress-meter] last hour: corpusReads server=X agent=Y` · `[outreach-read] automation corpus from Supabase: N` ·
`[GmailObserver:<inbox>] history_incremental_ok` · `[Calendar sync] complete` ·
`[Calendar safety] … blocked` · `[cap] N/<ceiling>` · `[FATAL]` · `402`.
