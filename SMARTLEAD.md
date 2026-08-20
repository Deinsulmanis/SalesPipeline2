# Smartlead integration

## Architecture

The existing Google Sheets workbook remains the database and source of truth. Gmail remains the default provider for every historical/unmapped campaign. A campaign opts into Smartlead through an additive mapping; approved leads are added to an existing Smartlead campaign rather than emailed directly. Smartlead events flow back into `ColdEmail`, `Suppression`, and additive audit tabs.

The integration creates these tabs on first use; deleting them rolls back the integration without changing historical Gmail rows:

- `CampaignIntegrations`: provider and external campaign mapping.
- `ProviderLeadMappings`: composite campaign/lead links and normalized/raw status.
- `ProviderEvents`: idempotent webhook state and allowlisted audit summaries.
- `ProviderCampaignStats`: normalized reconciled statistics.
- `IntegrationHealth`: last API call, webhook, reconciliation, and sanitized error.

## Environment

Copy the Smartlead entries from `.env.example`. `SMARTLEAD_INTEGRATION_ENABLED=true` permits API reads. Leave `SMARTLEAD_LIVE_MUTATIONS_ENABLED=false` through mapping and webhook tests. Pilot writes require that flag plus `SMARTLEAD_PILOT_MODE=true`, the external campaign ID in `SMARTLEAD_APPROVED_CAMPAIGN_IDS`, and every normalized recipient in `SMARTLEAD_TEST_RECIPIENT_ALLOWLIST`. Empty allowlists fail closed. Outside pilot mode, an approved campaign ID remains mandatory. The API key stays server-side and is sent as Smartlead's documented `api_key` query parameter.

## Event and mapping safety

Idempotency uses `smartlead:request:<X-Request-Id>` when the header exists and otherwise `smartlead:payload:<SHA-256(raw body)>`. Events move through `received → processing → processed`; failures become `failed` and can be retried. Unknown events end as `ignored`. A keyed in-process lock serializes duplicate deliveries on one instance.

`ProviderEvents` stores only event/campaign/lead identifiers, normalized email, timestamp, category/status, a short plain-text subject/reply preview, delivery code, and indicators that omitted sensitive structures existed. It never stores full HTML, conversation history, authentication values, or webhook query parameters.

Provider mapping identity is `smartlead:<externalCampaignId>:<externalLeadId-or-normalizedEmail>`. Historical mappings in different campaigns remain separate. Timestamp-aware transitions prevent delayed sent events from regressing reply or terminal states.

## Setup

1. In Smartlead, create a draft/test campaign manually, configure its sequence and approved mailbox, but do not activate it.
2. Generate an API key in Smartlead and store it as `SMARTLEAD_API_KEY` in Railway/server environment.
3. Generate a high-entropy signing secret and store the same value as `SMARTLEAD_WEBHOOK_SECRET`.
4. In the dashboard Campaigns tab, choose **Smartlead**, enter the numeric Smartlead campaign ID, save, then use **Test Mapping**. This performs only a GET.
5. Configure a campaign- or user-level webhook in Smartlead at `https://YOUR_HOST/api/webhooks/smartlead` with `EMAIL_SENT`, `FIRST_EMAIL_SENT`, `EMAIL_REPLY`, `EMAIL_BOUNCE`, `LEAD_UNSUBSCRIBED`, `LEAD_CATEGORY_UPDATED`, and `CAMPAIGN_STATUS_CHANGED`.
6. Test a signed fixture locally or Smartlead's webhook test. Confirm one `ProviderEvents` row and that resending the same `X-Request-Id` returns `already_processed`.

When Smartlead supplies `X-Smartlead-Signature`, verification calculates `sha256=` plus the HMAC-SHA256 hex digest over the exact raw body and uses a timing-safe comparison. Because the current Smartlead UI may not expose a signing-secret field, the endpoint also supports `?token=SMARTLEAD_WEBHOOK_SECRET` using the same timing-safe comparison. Treat the complete webhook URL as a credential and never log or share it.

## Safe first campaign

1. Keep `SMARTLEAD_LIVE_MUTATIONS_ENABLED=false`.
2. Map one draft dental test campaign and test the connection.
3. Deliver signed webhook fixtures for sent, reply, bounce, unsubscribe, category, and unknown events; verify dashboard and Suppression behavior.
4. Run `npm test`, then trigger `POST /api/integrations/smartlead/reconcile` while the campaign contains no real prospects.
5. Add only recipient addresses and one mailbox explicitly approved by the owner.
6. After reviewing the exact campaign, mailbox, schedule, and recipients, enable live mutations. Add one approved test lead through the provider endpoint.
7. Activate the Smartlead campaign manually only after confirming its sequence and stop-on-reply behavior. Monitor event health, suppression, and counts before any expansion.

No code path creates or activates a Smartlead campaign or sends an immediate Smartlead email.

## Reconciliation and statistics

Webhooks are primary. On Railway, reconciliation runs hourly at `:12` and can also be invoked manually with `POST /api/integrations/smartlead/reconcile`. It reads all lead pages at up to 100 records per page, guards against repeated/non-advancing pages, and applies the same transition rules as webhooks. Interested and meeting counts come from unique local mappings. Reply rate is replies/sent; interested rate is interested/replies. Gmail statistics remain unchanged. Health distinguishes complete, partial, and failed reconciliation.

The authenticated Campaigns view lists failed/stuck events and can retry only previously authenticated stored events through the same processor.

## Gmail coexistence and rollback

Unmapped campaigns resolve to Gmail. The original Gmail send, reply, bounce, scoring, and history paths are unchanged apart from the small provider adapter. A lead with an active provider mapping cannot be added to another provider campaign, and local Suppression is checked before Smartlead import.

To roll back one campaign, change its provider to Gmail in Campaigns. To disable all Smartlead mutations, set `SMARTLEAD_LIVE_MUTATIONS_ENABLED=false`; to disable reads/reconciliation too, set `SMARTLEAD_INTEGRATION_ENABLED=false`. Do not delete `Suppression`. The additive integration tabs may be retained for audit or archived manually.

## Troubleshooting and limitations

- `401` mapping test: verify the API key and that integration reads are enabled.
- Webhook `401`: verify the signing secret and ensure no proxy rewrites the request body.
- Duplicate delivery: request IDs are preferred; identical bodies without one use a stable payload hash.
- `5xx` webhook response: a Sheets write failed temporarily and Smartlead should retry. `4xx` indicates a permanent malformed/signature failure.
- Lead skipped: inspect sanitized provider metadata for duplicate/block/unsubscribe reasons and keep local suppression authoritative.
- Google Sheets provides no cross-instance transactional event lock. True cross-instance atomicity would require a transactional ledger such as Railway Postgres, which is not required for this owned-recipient pilot. Sheet scans will slow as event volume grows.
- Reply text is kept only as a short local preview; full HTML bodies are redacted from event audit payloads.
- Smartlead webhook examples do not consistently include `lead_id` on reply/sent events, so matching falls back to normalized email plus campaign. Capture and compare a real approved test payload before production rollout.
- If the complete tokenized webhook URL is exposed, rotate `SMARTLEAD_WEBHOOK_SECRET` and replace the webhook URL without sharing either value.

Official references used: Smartlead's Add Leads to Campaign, Get Campaign Leads, Campaign Analytics, Pause/Resume/Unsubscribe, Message History, Category Update, and Webhook Integration/Event documentation at `https://api.smartlead.ai`.

Verified client routes (August 2026 documentation): `GET /campaigns`, `GET /campaigns/:id`, `POST/GET /campaigns/:id/leads`, `GET /campaigns/:id/analytics`, `POST /campaigns/:id/leads/:leadId/pause`, `POST /campaigns/:id/leads/:leadId/resume`, `POST /leads/:leadId/unsubscribe`, `GET /campaigns/:id/leads/:leadId/message-history`, and `POST /campaigns/:id/leads/:leadId/category`. Mutations are tested only with mocked HTTP clients.
