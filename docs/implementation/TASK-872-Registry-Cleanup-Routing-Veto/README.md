# TASK-872 — Settings-registry cleanup and routing-policy veto alignment

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor |
| **Program** | [TASK-870 — Configuration Governance](../TASK-870-Configuration-Governance-Program/README.md), wave 1 lane B |
| **Branch** | `task-872-registry-cleanup-routing-veto` |
| **Base** | `f3c91ca0c` (off `dev-2.2`) |
| **Merge target** | `dev-2.2` (merged by the orchestrator, not by this lane) |

## Requirement Analysis

Three independent pieces of work, all owned by the settings-registry / routing-policy surface.

1. **`globalOnly` flips (owner decisions #3, #7 + the graphExecutor amendment).** Six keys are
   catalogued as tenant-editable but, under the 2026-09-05 target model, are platform-only:
   guardrail is built-in and platform-only (no tenant admin manages any guardrail setting), and
   TEXT's per-tenant moderation posture is part of that guardrail plane. The realtime
   graph-executor gate is a platform ROLLOUT switch, so it stays `maxScope: 'tenant'` (a super
   admin rolls it out per tenant) but is not a tenant-editable key.
2. **The routing-policy veto.** `AiProviderConnection`'s three-state rule (absent = no opinion →
   SYSTEM; enabled = the tenant wins; disabled = a VETO in both tiers) is the platform's
   resolution contract, and `apps/guardrail` already implements it
   (`TenantSelectionVetoedError`). `AiRoutingPolicyService.resolveDefault` did not: a tenant's
   own elected row that had been parked (`enabled: false` or `resourceStatus: DISABLED`) was
   invisible to `findCandidates`, so the tenant tier read EMPTY and the resolver widened to
   SYSTEM with `source: 'system'` — serving the platform's model to a tenant that had explicitly
   switched its own selection off.
3. **Dead-descriptor removal.** The TASK-870 review established a set of registry descriptors
   that nothing reads. Removing them is behaviour-neutral by construction and shrinks the
   surface an admin console, a catalog endpoint and a governance test all have to carry.

## Current State Evaluation

_Filled in during implementation; see Implementation Summary._

## Implementation Plan

1. Part 1 — the six `globalOnly` flips + the tests that assert the old posture.
2. Part 2 — TDD the veto: `findCandidates({ includeParked })`, veto decided in
   `resolveDefault`, propagated by the `AiTaskDefaultService` facade, every caller checked.
3. Part 3 — the removals, one commit per descriptor family, each with the grep that proves the
   key has no remaining reference.
4. Regenerate the env artifacts (`pnpm env:python-surface`, `pnpm env:sync`) — descriptors of
   tier `env`/`vault-kv` feed `.env.sample` and `turbo.json#globalEnv`, and `env:sync --check`
   is a CI gate.

## Implementation Summary

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded. |
