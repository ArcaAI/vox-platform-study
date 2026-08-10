# TASK-646 — `resolveForTenant` failures must not 500 the clinical path

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` |
| **Created** | 2026-08-09 |
| **Raised from** | TASK-643's `assertMeterQuota` fail-open work — the same asymmetry, one layer up |
| **Owner decision on file** | "Track it as its own ticket" (2026-08-09) |
| **Related** | TASK-643 §0.1 (the meter fail-open), TASK-615 (entitlements plane), TASK-638 |

---

## 1. Requirement Analysis

Billing must never take down the clinical path. TASK-643 established that asymmetry for
the *metering* read; the *entitlement resolution* read underneath it is still unguarded.

**This is latent today and becomes live the moment `entitlements.enabled` is turned on** —
which TASK-643's OD-6 requires. It should be closed before that flip, not after.

## 2. Current State Evaluation

All four enforcement methods on `EntitlementsService`
(`packages/applications/src/services/entitlements/entitlements.service.ts`) call
`resolveForTenant(tenantId)` and let its failures propagate:

- `assertQuantityQuota` — users, departments, prompt templates, ASR pipelines, API keys
- `assertMeterQuota` — consultations, summaries, LLM tokens, TTS characters, transcription minutes
- `assertConcurrencyQuota` — concurrent sessions
- `evaluateStorageSoftWarn` — storage (never throws on quota, but the resolve can still throw)

`resolveForTenant` reads `Tenant`, `PlanEntitlement` and `TenantEntitlement`.

**The distinction that makes this a real exposure, not a redundant one.** The counter-argument
is "if the database is down the request is doomed anyway, so failing open buys nothing." That
holds for `Tenant` — the clinical path needs it regardless. It does **not** hold for
`PlanEntitlement` / `TenantEntitlement`, which are **billing-only tables the clinical path never
otherwise touches**. A failure isolated to those two — schema drift, a bad migration, a
corrupted row, a lock — would reject a consultation for a reason that has nothing to do with
whether the consultation can be served.

That failure mode is not hypothetical here: TASK-644 found the live `PlanEntitlement` /
`TenantEntitlement` tables were **missing five columns** the schema declared. It degraded
safely only because `findByPlan`/`findByTenant` happen to swallow that error internally
(try/catch → `null`) — an accident of those two repository methods, not a designed posture.
`PlanEntitlementRepository.findAll()` has no such guard, which is why
`GET /api/v1/admin/entitlements/plans` was already broken.

## 3. Implementation Plan

TDD per `.claude/rules/01-development-workflow.md` — RED first.

1. **Test (RED):** with `resolveForTenant` throwing, each of the four `assert*` methods
   completes without rejecting, and the caller's operation proceeds.
2. **Test (RED):** the skip is observable — logged at ERROR with tenant, capability and error
   class, and counted on a metric.
3. **Change:** apply the shape TASK-643 already established for the meter read. Reuse
   `recordSkippedMeterCheck`'s pattern — likely generalised to
   `recordSkippedCheck(reason, capability)` rather than duplicated — and the
   `ENTITLEMENTS_*_SKIPPED_METRIC` convention. Do not invent a second mechanism.
4. **Decide and justify** whether the guard wraps `resolveForTenant` at each call site or
   sits inside it. Note `getTenantRateLimitPolicy` **already** wraps it in its own try/catch
   and falls back to global tiers — that is the existing precedent, and the reason the
   throttler never had this bug. Prefer consistency with it.
5. **Decide and justify** whether a `Tenant`-not-found failure should be treated differently
   from a `PlanEntitlement`/`TenantEntitlement` read failure. They are different situations:
   the first is arguably a genuine 404, the second is a billing-plane outage. Collapsing them
   loses information.
6. **Verify:** `pnpm --filter @arcaai/applications build test`, `pnpm lint`.

## 4. Implementation Summary

_Not started._

## 5. Open Decisions (owner)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| OD-1 | Does `getCapabilities` (`entitlements.service.ts:161`) also degrade? | It still has an unguarded `getCurrentUsage`. It is a GLOBAL_ADMIN display endpoint, so failing open means showing **zeros** to the person deciding quotas — arguably worse than an error. Deliberately left as-is by TASK-643 |
| OD-2 | Should a fail-open on entitlement resolution alert, or only count? | A silent no-enforcement window is a commercial exposure, not just an operational one. Alert delivery currently reaches nobody (TASK-636), so an alert rule may be theatre until that is fixed |

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Ticket created from TASK-643's fail-open work. No code written. |
