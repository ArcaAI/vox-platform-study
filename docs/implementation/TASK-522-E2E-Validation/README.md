# TASK-522 — Phase 7 E2E validation (gateway spec artifacts)

**Status:** Review — specs authored + typechecked; live execution owner-deferred
**Type:** test
**Parent program:** TASK-508 Phase 7 (E2E)

> **Owner-run boundary.** Live execution (`pnpm test:api:up` in one terminal, then
> `pnpm test:e2e`) and the GPU / engine-matrix suites are **owner-run** and out of
> this ticket's scope. This ticket delivers the Phase 7 **spec artifacts** the owner
> will run later against a live, seeded stack — authored to the existing e2e
> conventions and typechecked, but never executed here (no stack booted, no services
> started).

## Requirement Analysis

Author the four Phase 7 gateway e2e spec files that lock the TASK-508 agentic
control-plane contracts at the HTTP wire, following the reference pattern in
`apps/api/tests/e2e/task-506-ai-task-defaults-cross-tenant.spec.ts`:

1. `task-509-generation-stats.spec.ts` — the AD-1 GenerationStats surface.
2. `task-510-trajectory-admin.spec.ts` — the agent-trajectory admin read plane
   (cross-tenant 404 + pagination + step shape).
3. `task-511-agentic-policy.spec.ts` — agentic policy governance (If-Match
   428/412; GLOBAL_ADMIN write → tenant-admin 403; DRAFT-prompt resolution skip).
4. `task-516-mcp-admin.spec.ts` — MCP registry CRUD (secret/`authRef` never
   echoed; GLOBAL_ADMIN 403; cross-tenant 404; If-Match OCC).

Every spec must mirror the **real** controller routes / DTOs / status codes
(discovered from source before writing) — no guessed field names, query params, or
status codes — and must fabricate no endpoints.

## Current State Evaluation (what already shipped, Phases 0–6)

- Phases 0–6 are complete and unit/integration-green (see the TASK-508 TRACKER).
- The gateway surfaces these specs probe already exist and are unit-tested:
  - `AgentTrajectoryController` — `GET /api/v1/admin/agent-trajectory/sessions`
    and `.../sessions/:sessionId/steps` (class-gated `@CanManage('HarnessPolicy')`,
    keyset step pagination, cross-tenant 404, `payloadRef` never projected).
  - `HarnessAdminController` — `PATCH /api/v1/admin/harness/policy` (loop-knob OCC)
    and `PATCH .../policy/global` (GLOBAL_ADMIN-only, `assertPlatform` → 403).
  - `PromptManagementController` — `POST /api/v1/admin/prompt-templates/:id/approve`
    (TASK-511, GLOBAL_ADMIN-only, `@RequiresIfMatch()`; DRAFT → APPROVED).
  - `AgenticAdminController` — `GET /api/v1/admin/agentic/instructions` (the
    effective-instruction resolution/read plane exposing the resolved prompt tier).
  - `McpAdminController` — `/api/v1/admin/mcp-servers` CRUD (GLOBAL_ADMIN writes,
    If-Match OCC, cross-tenant 404, `authRef` = Vault path only).
- **TASK-509 route reality:** the GenerationStats headline fields (`stopReason`,
  `ttftMs`, `tokensPerSecond`) are **persisted onto `SummaryMeta`** (migration
  `20260719000000_task_509_summary_meta_generation_stats`) but are **NOT exposed as
  first-class fields on any gateway read**. `SummaryProvenanceResponse`
  (`GET /consultations/:id/summary/:contextItemId/provenance`) surfaces `modelName`
  + sensor scores + `citationsMap` only. The **real** gateway contract carrying
  GenerationStats is the trajectory step `stats` JSON blob
  (`AgentTrajectoryStepResponse.stats`, "AD-1 GenerationStats on LLM_CALL steps"),
  which the console AI-Operations Metrics screen composes (sessions → steps).

## Implementation Plan

1. Read the reference spec + `tests/helpers` barrel to lock the exact imports/auth
   helpers (`loginUser`, `SEEDED_USERS`, `DEFAULT_TENANT_KEY`) and idioms
   (`optimistic-locking.spec.ts`, `task-348-harness-progress-cross-tenant.spec.ts`).
2. For each ticket, read the actual controller + its DTOs + unit tests to mirror
   real routes, query params, and status codes.
3. Author the four spec files (additive only; no source changes).
4. Typecheck (no-emit) the four files; fix any type errors attributable to them.
5. Document; hand live execution to the owner.

## Implementation Summary

Four additive spec files under `apps/api/tests/e2e/` (task-506 header/auth/OCC
conventions; each has a top-of-file JSDoc listing the locked contracts, a
`test.describe`, a `test.beforeAll` logging in the two tokens
[GLOBAL_ADMIN via `SEEDED_USERS.superAdmin`; tenant admin via `SEEDED_USERS.admin`
+ `DEFAULT_TENANT_KEY`], and focused cases; caller-scoped rows are re-read for the
CURRENT version before each If-Match write — only the deliberate stale validator is
hardcoded `"999"`):

| File | Contracts probed |
|---|---|
| `task-509-generation-stats.spec.ts` | GenerationStats surfaces via the **trajectory step `stats`** blob (`GET /admin/agent-trajectory/sessions/:id/steps`) — the real gateway contract; step items always declare `stats` (nullable JSON) and never `payloadRef`; populated LLM_CALL `stats` is an object whose AD-1 headline keys (`stopReason`/`ttftMs`/`tokensPerSecond`) carry locked primitive types when present; the plane is HarnessPolicy-gated (doctor → 403). **Fallback documented in-file** (see below). |
| `task-510-trajectory-admin.spec.ts` | RBAC (doctor → 403 on sessions + steps); `GET sessions` → `{ items, total }` with the locked row shape and no `payloadRef`; offset pagination bounds the page (`?limit=1`); step keyset pagination echoes `limit` and advances by `cursor` (`seq asc`, no overlap); unknown/cross-tenant `sessionId` → 404 (never 403, no tenant leak); tenant admin foreign `?tenantId=` → `[403,404]`, never 200. |
| `task-511-agentic-policy.spec.ts` | HarnessPolicy loop-knob OCC (`PATCH /admin/harness/policy`: missing If-Match → 428; stale `"999"` → 412; current version → 200 + version bump); GLOBAL_ADMIN-only global default (`PATCH /admin/harness/policy/global` as tenant admin → 403, valid If-Match supplied so 403 is the privilege verdict); prompt approval (`POST /admin/prompt-templates/:id/approve`: tenant admin → 403; missing If-Match → 428; stale → 412; GLOBAL_ADMIN + current If-Match → `status: APPROVED`); DRAFT-prompt **resolution skip** (`GET /admin/agentic/instructions` → a freshly-created DRAFT is never `promptTier.promptId`). |
| `task-516-mcp-admin.spec.ts` | Registry CRUD (POST creates a dormant SYSTEM row `enabled:false`; GET/LIST `{ items, total }`; PATCH under OCC; DELETE soft-delete under OCC); **secret hygiene** (`authRef` echoed as the Vault path verbatim; no `secret`/`token`/`password`/`credential`/`apiKey` value key on any projection); GLOBAL_ADMIN-only writes (tenant admin CREATE/PATCH/DELETE → 403, valid If-Match on PATCH/DELETE so 403 is the privilege verdict); unknown/cross-tenant id → 404 (no tenant leak); tenant admin foreign `?tenantId=` → `[403,404]`; OCC (missing If-Match → 428; stale `"999"` → 412; current version → 200 + version bump). |

### TASK-509 fallback (real contract asserted instead of a fabricated route)

No gateway route returns `stopReason` / `ttftMs` / `tokensPerSecond` as first-class
fields. Routes probed:

- `GET /consultations/:id/summary/:contextItemId/provenance` → `SummaryProvenanceResponse`
  **omits** the generation-stats headline fields (by design).
- `GET /admin/agent-trajectory/sessions/:sessionId/steps` → `AgentTrajectoryStepResponse.stats`
  (`JsonValue | null`) **is** the surface that carries AD-1 GenerationStats, and the
  console AI-Ops Metrics screen composes exactly this.

`task-509-generation-stats.spec.ts` therefore asserts the trajectory step `stats`
contract (the closest **real** existing contract) rather than inventing an endpoint;
the file's top-of-file comment documents which routes were probed and why. This
matches the TASK-512 follow-up gap already recorded in the TRACKER (no dedicated
aggregate generation-metrics endpoint; Metrics is client-side-derived from
trajectory GenerationStats).

### Typecheck evidence (no-emit; specs NOT executed)

Method: a throwaway `apps/api/tsconfig.e2e-typecheck.json` extending
`@arcaai/config-ts/nestjs.json` (`noEmit`, the repo's compiler settings) `include`-ing
only the four new files, run from `apps/api`:

```
npx tsc -p tsconfig.e2e-typecheck.json --noEmit
```

Result — **zero type errors attributable to the four new files** (filtering the
output for `task-(509|510|511|516)` returns `NONE`). The compile surfaces 6
pre-existing errors, all in the shared `tests/helpers` barrel transitively imported
by every e2e spec:

```
../../tests/helpers/api.helper.ts(122,68): error TS2339: Property 'status' does not exist on type 'never'.
../../tests/helpers/api.helper.ts(135,68): error TS2339: Property 'status' does not exist on type 'never'.
../../tests/helpers/auth.helper.ts(52,5): error TS2322: Type 'string' is not assignable to type 'number | StringValue'.
../../tests/helpers/db.helper.ts(24,27): error TS2307: Cannot find module '@arcaai/database' or its corresponding type declarations.
../../tests/helpers/db.helper.ts(217,24): error TS2347: Untyped function calls may not accept type arguments.
../../tests/helpers/e2e.helper.ts(188,5): error TS2554: Expected 0-1 arguments, but got 2.
```

Proven pre-existing by a control compile of the **existing** `task-506` spec (not
authored here), which emits the **identical** 6 errors. The repo's own `tsc` never
type-checks e2e specs (`apps/api/tsconfig.json` excludes `**/*.spec.ts`; Playwright
transpiles them via esbuild), so these helper-barrel errors do not gate the suite.
Both throwaway tsconfigs were removed after the check — the change set is
additive-only (the four spec files + these docs).

## Owner action (not automated here)

- Boot the stack: `pnpm test:api:up` (terminal 1), ensure the DB is seeded.
- Run the suite: `pnpm test:e2e` (runs all `apps/api/tests/e2e/*.spec.ts`).
- Run the GPU / engine-matrix live-engine suites (env-gated) separately.
- Presence-guarded assertions (populated LLM_CALL `stats` in 509; multi-step session
  cursor-advance in 510) only fire when the seed carries that data — a warning is
  logged and the envelope contract still holds when it does not.

## Change History

- 2026-07-19 — Authored the four Phase 7 gateway e2e spec files
  (`task-509`/`510`/`511`/`516`) under `apps/api/tests/e2e/`, mirroring real
  controller routes/DTOs/status codes (discovered from source). Typechecked no-emit:
  zero errors attributable to the new files (6 pre-existing `tests/helpers` errors
  isolated + proven via a `task-506` control compile). 509 falls back to the real
  trajectory-step `stats` contract (no gateway route returns the headline fields
  first-class). Additive files only; no source changed; no git writes. Status set to
  **Review** — live execution + GPU/engine suites owner-run.
