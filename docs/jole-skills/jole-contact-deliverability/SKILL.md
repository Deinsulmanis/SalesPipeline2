---
name: jole-contact-deliverability
description: Jole BTX recipient and email qualification (v1.0.1). Decides whether a specific buyer's email is suitable for outbound - verified identity and current employment, company and domain match, Apollo verification status, catch-all and Proofpoint risk, mail gateway, suppression and DNC, prior bounces and delivery failures, duplicates across clients. Returns CONTACT ACCEPTED FOR REVIEW, ADDITIONAL VERIFICATION REQUIRED, HOLD or REJECT. Use only once a buyer is identified and contact data exists; never sends test emails or spends credits; load it directly, without the orchestrator, when email quality is the only question. Requires the jolesbtxicpskill shared policy.
version: 1.0.1
---

# Jole contact and email deliverability qualification

**Question: is the proposed recipient's email suitable for outbound sending?**

Version 1.0.1, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`).

## Use it when

- A buyer has been identified (`jole-buyer-identification`) and contact data is available, for example after an authorized reveal or from a prior wave.
- Contact waves need QC before import.

Do not run it during company discovery. **A strong opportunity does not override contact-level sending restrictions**, and this skill never changes the company's ICP label or priority.

## Inputs

- **Required:** the person (name, title, company), the email, and where the email came from (Apollo status, prior wave, company site).
- **Optional:** catch-all flag, MX host, employment history, prior delivery events, the dedupe result for the contact.

## Procedure

1. **Identity.** The person works at the company now, with that title (employment history, a recent source). After an acquisition, re-check.
2. **Domain match.**
   - The email domain is the company's domain, or a verified parent, sister or legacy domain: it redirects to the company site, or the company's own site confirms the link.
   - Approve corporate mail domains such as cat.com, uss.com, p66.com and bepc.com.
   - Hold unresolved domains.
   - Reject a domain that belongs to an unrelated company (for example, alloy.com is a fintech), and reject personal domains.
3. **Verification status.** Only Apollo work emails marked **VERIFIED** pass. INVALID is rejected. UNVERIFIED, blank, or "email available" without a status needs more verification. Never guess or pattern-build an email.
4. **Mail gateway and catch-all.**
   - A free MX lookup shows the gateway. Proofpoint shows as `*.pphosted.com` or `*.ppe-hosted.com` (Proofpoint Essentials).
   - Catch-all status comes from the reveal (`email_domain_catch_all`, or `email.domainCatchAll` in the lead profile).
5. **Suppression and duplicates.** Use the contact-level result from `jole-dedupe-suppression`: global and client suppression, DNC, the address already owned by another client, the same person already purchased.
6. **Delivery history.** Any prior hard bounce or failure notice for the address, or unresolved failures on its domain (for example Exchange directory rejections or "mailbox unavailable" notices).

Stop at the first REJECT. Otherwise finish all six checks; they are cheap.

## Jole deliverability safeguards

**Do not bypass safeguards on risky Proofpoint catch-all addresses.** First touches through 2026-11-01, including four failures found later in DSN review:
- Proofpoint catch-all: 15 of 93 failed (16.1%).
- Other catch-alls: 6 of 94 (6.4%).
- Non-catch-all addresses: 2 of 282 (0.7%).

A Proofpoint catch-all contact stays on the sending-quality hold. The live holds are in `integrations/clients/data/jole-deliverability-holds.json` on the production branch, read by `joleDeliverabilityHold`.

- **Other catch-all domains:** keep them, flag `email_domain_catch_all = Y`, and send after non-catch-all contacts.
- **Proofpoint, not catch-all:** acceptable (0 of 41 bounced).
- **Proofpoint gateway, catch-all status unknown** (before a reveal): ADDITIONAL VERIFICATION REQUIRED.

**Do not equate an Apollo email-availability indicator with verified inbox deliverability.** Even VERIFIED is a list-quality signal, not proof of inbox placement. Do not spend credits on validation, and do not send test emails without authorization.

## Decisions

Report the first that applies:

| Label | Rule |
|---|---|
| REJECT | Address suppressed; INVALID; personal or unrelated domain; the person has left; a prior hard bounce or failure on this address; the address already belongs to another client |
| HOLD | Proofpoint catch-all; a delivery deferral or unresolved domain-level failures; another sending-quality hold. The company stays qualified. |
| ADDITIONAL VERIFICATION REQUIRED | No VERIFIED status (blank, UNVERIFIED, availability only); employment or title unconfirmed; domain link unresolved; Proofpoint gateway with unknown catch-all status |
| CONTACT ACCEPTED FOR REVIEW | Identity current, domain matched, Apollo VERIFIED, no Proofpoint catch-all, no suppression, no prior failure, no duplicate. A non-Proofpoint catch-all passes with its flag set. |

Accepted means a person reviews the contact. It is not permission to import or send.

**Confidence:** HIGH when every check used a live or same-day source; MEDIUM when catch-all or employment came from an older record; LOW when the MX lookup or delivery history was unavailable.

## Escalate to the user

- A high-priority company where every reachable contact sits on the Proofpoint catch-all hold: the hold is policy, so only the user can change it.
- An address with delivery failures recorded only in DSN text that the system did not log.

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, subject = the contact, plus:

```json
"details": {"email": "...", "email_status": "VERIFIED | UNVERIFIED | INVALID | none", "identity": "current | uncertain | gone",
  "domain_match": "company | verified_related | unresolved | unrelated | personal", "mx_gateway": "proofpoint | other | unknown",
  "catch_all": "Y | N | unknown", "segment": "proofpoint_catch_all | other_catch_all | non_catch_all | unknown",
  "suppression": "", "prior_delivery": "none | hard_bounce | deferred | domain_failures", "duplicate": ""}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| Plant manager at a Priority A yard; Apollo VERIFIED; MX `mxa-…gslb.pphosted.com`; domain catch-all | HOLD; company stays qualified | Sent because the signal is strong |
| Apollo shows an email is available, no status yet | ADDITIONAL VERIFICATION REQUIRED | Accepted as verified |
| Apollo VERIFIED, non-catch-all Microsoft 365 domain, no history | CONTACT ACCEPTED FOR REVIEW | Held for being Microsoft 365 |
| Same address hard-bounced on a ScaleLab send | REJECT | Accepted for Jole |
| Email on the parent's domain, which the company site names as its parent | Domain matched (verified related) | Held as a mismatch |

## Tests

`python tests/test_contact.py` from this folder. `tests/contact_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.0.1 (2026-11-03).** The description now says to load this skill directly for an email-only question.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, section 9. Added the four outcomes, the six ordered checks, Proofpoint Essentials MX hosts, the unknown-catch-all case and delivery-history checks. The bounce figures come from the 2026-11-01 remediation.
