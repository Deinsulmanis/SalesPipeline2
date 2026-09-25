# Agent v2 constrained wording

Phase 4 is a pure renderer. It takes Phase 1 state, the completed Agent v2
shadow record, and the Phase 3 permission result. It recalculates Phase 3 and
requires the supplied permission to match. Only `ALLOW` can yield wording.
`DENY` and `HANDOFF` yield `NO_WORDING` with `wording: null`.

The renderer uses versioned, preapproved phrases for the current
`industrial_staffing_offer_v1` catalog. It groups the selected prospecting,
outreach, and qualification facts into one sentence, and uses the Phase 1
inbound classification to add a brief question response cue. Qualification
uses the existing validated slot questions. Booking coordination uses a fixed
phrase with no link or availability claim. No wording model or external API is
used in Phase 4.

The output is `{ version: 'agent_v2_wording_v1', status, reasonCode,
decisionId, actionId, catalogVersion, wording, executionAuthorized: false,
authority }`. `status` is `RENDERED`, `NO_WORDING`, or `HANDOFF`.
It never grants send, draft, Calendar, CRM, sender, suppression, sequence, or
booking authority.

`renderAgentV2Wording` accepts an optional candidate shaped exactly as
`{ wording: string }` for validating a proposed rewrite. It rejects malformed,
empty, long, linked, priced, or proof/results text. Most importantly, it
requires an exact match to the approved deterministic rendering. This finite
allowlist rejects unselected facts, extra qualification fields, altered offer
terms, and contradictions even when a keyword filter would miss them. A
rejection returns internal `HANDOFF` with `wording: null`; it never returns the
unsafe candidate. The underlying structured decision is not modified.

The allowed actions are `SUGGEST_QUALIFICATION`, `SUGGEST_INFO`,
`SUGGEST_FACT_ANSWER`, and `SUGGEST_BOOKING_COORDINATION`. Phase 3 currently
hands off objection and referral suggestions and denies `NO_ACTION`; those
actions cannot render. Any later wording variation must be added as an
explicitly approved catalog phrase and tested before it can pass validation.
