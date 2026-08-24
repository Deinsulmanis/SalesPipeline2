# Roofing survey reply-first workflow

`roofing_survey_reply_first` is an isolated, one-email campaign profile for neutral roofing-industry research. It does not replace or modify the dental campaign profile, and it does not modify the standalone Roofing Survey website.

## Architecture and safety

- The profile reuses the server-side `ANTHROPIC_API_KEY`. A separate key would not create a separate model brain; separation is provided by the profile's deterministic copy, classifier prompt, workflow rules, and routing ID.
- The initial invitation is locked plain text. Claude does not rewrite it.
- The current model defaults to the supported `claude-haiku-4-5` alias. `ANTHROPIC_HAIKU_MODEL` may override that value without changing the dental workflow.
- A lead must have roofing-business evidence before it can be queued with `roofing-survey-v1`.
- The profile has one initial step. It is excluded from the dental follow-up and open-triggered sequences.
- Existing suppression, unsubscribe, bounce, duplicate, daily-limit, and global sending controls remain in force.
- Routine logs contain only the profile, normalized classification, and allowlisted reason code—not the full reply or API key.

## Required configuration

```text
ROOFING_SURVEY_REPLY_FLOW_ENABLED=false
ROOFING_SURVEY_AUTO_REPLY_ENABLED=false
ROOFING_SURVEY_URL=
```

All values fail closed. Keep both flags false and the URL empty during setup. The survey URL must be a final HTTPS URL before a positive response can be drafted or sent.

When the reply flow is disabled, roofing replies are sent to human review. When the flow is enabled but auto-reply is disabled, a clear positive reply creates a reviewable same-thread response in `ReplyDrafts`. Questions, ambiguity, low-confidence results, hostile/privacy/legal concerns, already-completed claims, and malformed model output always require review. Unsubscribes use the existing suppression workflow. Automated and out-of-office messages never receive a survey link.

## Safe pilot

1. Leave production flags false.
2. Import only owned test addresses with lead type `Roofing`; do not queue them yet.
3. Enable only `ROOFING_SURVEY_REPLY_FLOW_ENABLED=true`, restart the service, then choose a delivery-capable inbox and `Roofing survey — reply first` when queuing the owned addresses.
4. Confirm the preview has subject `quick roofing question`, contains no survey link, and uses `Hi there,` for an unusable name. Send a controlled initial message only after confirming the global Gmail safeguards.
5. Reply from an owned address with positive, question, ambiguous, unsubscribe, and out-of-office examples.
6. Confirm positive replies create drafts and no reply is sent.
7. Add the final HTTPS `ROOFING_SURVEY_URL` and verify the exact drafted response.
8. Enable `ROOFING_SURVEY_AUTO_REPLY_ENABLED=true` only after draft review, same-thread verification, suppression verification, and explicit production approval.

Rollback is immediate: set both roofing flags to `false`. This does not disable or change dental outreach.
