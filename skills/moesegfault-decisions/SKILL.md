---
name: moesegfault-decisions
description: Integrate first-party services with moeSegFault Decisions to email confirmed choices or forms and consume private response callbacks. Use for Decisions onboarding and delivery behavior, not general authentication or public form hosting.
---

# moeSegFault Decisions

Use Decisions for an expiring emailed response link, an explicit confirmation,
and durable delivery back to the owning service. The business service still owns
authorization, pending operations, and the effect of the answer.

## Read only what this task needs

| Task | Reference |
| --- | --- |
| Create a decision, choose fields/deadlines, recover a lost response | [Create and forms](references/create-and-forms.md) |
| Register a service and implement its receiver | [Private callbacks](references/private-callbacks.md) |
| Verify the real journey or diagnose delivery | [Operations and acceptance](references/operations-and-acceptance.md) |

## Integration invariants

- Call the named `DecisionsApi` through a deployment-owned service binding; the
  public Decisions domain is not a creation API. Pair staging and production.
- Onboard the callback on **both** sides before using it. Only registered private
  bindings and exact paths are supported, never arbitrary Internet callback URLs.
- Persist one operation key and request before sending. Retry that same request;
  omitted expiry defaults once to seven days, not seven days after every retry.
- Treat the URL as a bearer capability, not proof of Identity login, identity, or
  recent authentication. High-risk effects require the business service's own
  authorization and step-up policy.
- GET never decides; choosing/typing never submits. Keep explicit confirmation.
- A callback is at least once. Commit its receipt and local effect atomically;
  acknowledge only committed work or an already committed identical replay.
- Distinguish creation acceptance, notification acceptance, provider acceptance,
  inbox receipt, and confirmed callback delivery. Do not report one as another.

This folder is portable: all integration details are bundled below. Source links
in the references are for maintainers, not prerequisites or permission to deploy.
