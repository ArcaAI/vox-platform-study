# TASK-998 — Realtime Cloud ASR & Transcript Coherence

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |

---

> **This file did not exist on the branch lane S6 was cut from.** Sections 1–5
> are owned by the orchestrator and by the other lanes; S6 created the skeleton
> only so it had a §6/§7 to append to, and deliberately left them empty rather
> than guessing at another lane's content. Expect an add/add merge here and keep
> the orchestrator's 1–5.

## 1. Requirement Analysis

_Owned by the orchestrator._

## 2. Current State Evaluation

_Owned by the orchestrator._

## 3. Owner Decisions

_Owned by the orchestrator._

## 4. Implementation Plan

_Owned by the orchestrator._

## 5. Verification

_Owned by the orchestrator._

## 6. Implementation Summary

### Lane S6 — per-provider cloud-ASR capacity quotas (OD-4)

> **OD-4, 2026-09-21 (verbatim):** *"platform admin will set minute volume by
> enabled provider globally OR specific by tenant that has Pro plan and above"*

Two capacity dimensions per cloud STT provider, a platform default, an optional
per-tenant allocation, and the "Pro and above" eligibility bound — all inside the
EXISTING entitlements plane rather than a parallel one.

| Dimension | Protects | Enforced at |
|---|---|---|
| `requestsPerMinute` | the vendor's sync-REST per-minute cap (Sarvam 60/100/4000 by account tier) — still binds, because BATCH transcription stays on REST | batch transcription-job create |
| `maxConcurrentStreams` | the vendor's concurrent-WebSocket cap (Sarvam 20/100/100) — the ceiling that binds for LIVE work, now that a consultation is ONE persistent socket rather than N requests | streaming-session open |

Providers are exactly `CLOUD_BYO_PROVIDERS.stt`
(`packages/applications/src/services/ai-provider-connection/constants.ts`),
READ at the write path rather than copied. There is no second list anywhere —
not in the schema, not in the DTOs, not in the console.

#### Schema — three additive columns, no new model

| Column | Model | Meaning |
|---|---|---|
| `sttProviderQuotas Json? @db.JsonB` | `PlanEntitlement` | the PLATFORM DEFAULT, per provider, per dimension |
| `sttProviderQuotas Json? @db.JsonB` | `TenantEntitlement` | the tenant's OWN allocation |
| `featureProviderQuotaAllocation Boolean @default(false)` | `PlanEntitlement` | the "Pro and above" eligibility BOUND |

A JSONB map rather than one scalar column per provider because the provider list
lives in code and moves — this very ticket adds a Sarvam duplex lane. A column
set would be a second hardcoded list needing a migration across two tables, four
domain files, two DTOs and the console per provider, and drifting silently when
someone forgot one. No new Prisma model: `PlanEntitlement`/`TenantEntitlement`
already ARE the two tiers, already carry OCC, already have a super-admin-only
CRUD surface and a shipped console screen.

Migration: `20260921163644_task_998_provider_capacity_quotas` (additive only;
`ADD COLUMN` × 3, no index, no backfill, no destructive DDL).

#### Resolution — tenant → platform default, per DIMENSION

`resolveProviderQuotas` (`entitlements/provider-quotas.ts`, pure) merges the
tenant map over the plan map for each dimension independently, over the union of
both tiers' providers. So a tenant allocated only `maxConcurrentStreams` keeps
inheriting the platform `requestsPerMinute`. Unresolved at both tiers = `null` =
unlimited (not enforced), which is what every plan seeds as. `0` is a real,
enforceable allocation and the merge uses `??`, never `||`.

`50000000-…` ("Global") appears nowhere; a null-plan tenant resolves
`providerQuotas: {}` (unbounded) along with the rest of `UNGATED_ENTITLEMENTS`.

#### "Pro and above" BOUNDS, it never SUPPLIES

`featureProviderQuotaAllocation` is `false` on STARTER, `true` on
TRIAL/PRO/ENTERPRISE, and is consulted at exactly one place — the WRITE, in
`EntitlementsService.assertMayHoldProviderQuotas` (403). `resolveProviderQuotas`
never reads it. The consequence is the one that matters: a tenant below Pro
resolves the PLATFORM DEFAULT, and a PRO→STARTER downgrade returns a tenant to
the platform default rather than stranding it at zero on the path that starts a
consultation recording. Clearing an allocation (`null` / `{}`) is always allowed,
so a downgrade can be tidied up. Pinned by
`entitlements/__tests__/provider-quotas.test.ts`.

There is deliberately no `TenantEntitlement` tri-state override of the bound: a
per-tenant override of an eligibility bound is vacuous, because the only caller
the bound applies to is the super admin who would flip it.

#### Enforcement — the counter is Redis, and it does not leak

`packages/applications/src/services/provider-capacity/` — a SECOND limiter, and
the comment on `provider-capacity.constants.ts` says why beside
`TieredThrottlerGuard`: that one bounds INBOUND requests by what the platform
will serve a tenant, this one bounds OUTBOUND calls by what the vendor's account
will accept. Different direction, different owner of the number, different key.

Both dimensions are single atomic Lua calls against the shared Redis, never an
in-process counter (which would multiply the vendor's ceiling by the replica
count) and never a read-then-write pair (which lets N concurrent opens all
observe `active = limit − 1`).

* **rate** — fixed minute window, `CHECK-then-INCR` so a refused call does not
  consume the vendor budget it never reached.
* **concurrency** — a sorted set scored by "last seen", swept by the TTL cutoff
  before it is counted. A slot held by a replica that was SIGKILLed is reclaimed
  by the next acquire after the window, with nothing to notice the death and
  nothing to clean up by hand; an INCR/DECR pair would leak one slot per crash,
  permanently. Re-acquiring the same `sessionId` is idempotent, so a resume is
  never refused by the slot it already owns. Teardown releases immediately, by
  `sessionId` alone, through a reverse index the limiter writes at acquire —
  most teardown paths never saw the resolved ASR spec.

#### Fail posture — declared, not improvised

Infrastructure failure FAILS OPEN; an explicit over-limit verdict FAILS CLOSED.
Redis unreachable, no Redis wired, or a failed entitlement resolve ⇒ the call
proceeds, logged at WARN and counted on
`provider_capacity_check_skipped_total{dimension}`. This is a clinical-safety
judgement stated on `IProviderCapacityService`: refusing to start a consultation
because a quota counter is down is worse than briefly over-running a vendor cap
that the vendor will itself rate-limit, visibly and retryably. An actual
over-limit verdict is the opposite case — the call is known to be refusable
upstream — so it raises `QuotaExceededException`.

Both capability strings (`sttProviderRequestsPerMinute`,
`sttProviderMaxConcurrentStreams`) were added to `QUOTA_RATE_CAPABILITIES` in
`apps/api/src/interceptors/exception.interceptor.ts` so they map to **429**, not
the default 409: a vendor window rolls over and a live stream ends, so this is
retry-later, never a permanent conflict.

`apps/stt` gained NO database read and was not touched: enforcement is in the
gateway, which is where the tenant, the plan and the resolved spec already are.

#### Files

| Path | Change |
|---|---|
| `packages/database/src/prisma/db_main/entitlement.prisma` | +3 columns |
| `packages/database/src/prisma/db_main/migrations/20260921163644_task_998_provider_capacity_quotas/migration.sql` | new |
| `packages/database/src/prisma/db_main/seed/15-entitlements.ts` | `featureProviderQuotaAllocation` per plan; `sttProviderQuotas` deliberately unseeded |
| `packages/domains/src/{models,entities,factories}/generated/core/{Plan,Tenant}Entitlement*.ts` | hand-authored column surfacing (`gen:*` creates no files) |
| `packages/applications/src/services/entitlements/provider-quotas.ts` | new — shape, per-dimension merge, write validation |
| `packages/applications/src/services/entitlements/{resolve-entitlements,entitlements.constants,entitlements.service}.ts`, `dto/*` | resolution, the plan bound, the 400/403 write gates, DTOs |
| `packages/applications/src/services/provider-capacity/**` | new — the limiter (interface, constants + Lua, service, module) |
| `packages/applications/src/services/stt/asr-provider.ts` | new — the one reader of `models.asr.provider` |
| `packages/applications/src/services/stt/{job,streaming}/**` | the two enforcement call sites + release/heartbeat |
| `apps/api/src/interceptors/exception.interceptor.ts` | the two capabilities → 429 |
| `apps/admin-console/src/features/entitlements/**` | plan JSON editor + table column, tenant override key, feature label |

#### Known gap, handed on

`heartbeatStreamSlot` exists and is called opportunistically from
`StreamingSessionService.getSessionStatus`, but its intended steady-state caller
is `SttWsGateway.scheduleHeartbeat` (the ~20 s tick that already republishes the
socket registry). Wiring it there belongs to the lane that owns the gateway and
shortens the crash-reclaim window from `PROVIDER_STREAM_SLOT_TTL_SECONDS` (2 h)
to seconds. Until then the 2 h window is the backstop for the crash case only —
ordinary teardown, and a failed session open, both release immediately.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-21 | **Lane S6** — per-provider cloud-ASR capacity quotas (OD-4). Added `PlanEntitlement.sttProviderQuotas` (platform default), `TenantEntitlement.sttProviderQuotas` (tenant allocation) and `PlanEntitlement.featureProviderQuotaAllocation` (the "Pro and above" bound), migration `20260921163644_task_998_provider_capacity_quotas`. New `ProviderCapacityService` enforces both dimensions on a shared Redis counter at batch-job create and streaming-session open; fail-open on limiter infrastructure, fail-closed on an over-limit verdict, both capabilities mapped to 429. `apps/stt` unchanged — no DB read added to the agent path. |
