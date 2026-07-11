# TASK-466 — apps/api Consumption of Harness Idempotency/Escalation (TASK-458 receiver half, C1-03 + C1-05)

- **Status**: Completed — adversarial review APPROVE (no Critical/Important): WORM/hash-chained escalation, idempotency across all 5 writers (distinct SLA ticks NOT falsely suppressed), 404-over-403 tenant safety, meaningful tests. Migration idempotent-additive + deploy-ready; harness→api e2e deferred (live Temporal, skip per owner). Only the owner's push/PR remains.
- **Type**: bugfix (reliability, observability) + cross-service coordination
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 follow-up (pairs with [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md))
- **Origin**: TASK-458 fixed the **harness (sender) half** of C1-03/C1-04/C1-05. Three receiver-side consumption gaps remained — the harness now sends the right signals, but apps/api / apps/smr didn't consume them yet.
- **Severity**: Med
- **Branch**: `fix/task-466-harness-receiver`
- **Size**: M

## Scope (narrowed at execution)

This ticket now covers the **apps/api receiver half only** — **C1-03** (WORM/draft callback dedup on the harness `Idempotency-Key`) and **C1-05** (the `/escalation` endpoint). The **SMR idempotency half (C1-04, AC-3)** is **split out to TASK-469**, so `apps/smr` and the harness SMR client are untouched here. AC-4 accordingly narrows to `pnpm --filter @arcaai/api test` + the applications/domains suites (no `py:smr-v2:test` in this ticket).

## Requirement Analysis

TASK-458 (landed on the harness side) now emits:
1. **An escalation record** — `POST {internal}/consultations/{id}/escalation` (body `tenantId/reason/escalationCount/terminal/jobId`). **This apps/api route does not exist yet** — the harness activity's fail-safe swallows the 404, so an SLA breach still notifies no one until the endpoint lands. It also carries the terminal `gate_sla_abandoned` signal (C1-02's abandon).
2. **An `Idempotency-Key` header** on the five WORM/draft callbacks (`persist_draft`, `finalize_assurance`, `record_gate_decision`, `report_progress`, `report_assurance_event`). **apps/api must consume it to actually dedup** the WORM/draft writes — otherwise a retried callback still double-writes.
3. **SMR generate**: TASK-458 closed the in-process re-send and the activity-observable retry, but a pure worker **crash** mid-`generate` (activity dies without raising) can still re-invoke SMR. **Fully closing needs SMR-side idempotency** — an idempotency key the `apps/smr` `/api/v1/generate` service honors.

### Acceptance criteria

- [ ] **AC-1 (C1-05 endpoint — apps/api)**: add `POST /api/v1/internal/consultations/:id/escalation` (behind the harness service-token guard) that persists/notifies the gate SLA breach (and the terminal `gate_sla_abandoned`). Verify the harness→api hop end-to-end (the 404-swallow becomes a real record).
- [ ] **AC-2 (C1-03 dedup — apps/api)**: the WORM/draft callback handlers read `Idempotency-Key` and dedup (a retried callback with the same key is a no-op that returns the prior result). Cover with a test: same key twice → one write.
- [ ] **AC-3 (C1-04 SMR idempotency — apps/smr)**: **SPLIT OUT to TASK-469** — out of scope for this ticket. `apps/smr` `/api/v1/generate` + the harness SMR client stay untouched here.
- [ ] **AC-4**: `pnpm --filter @arcaai/api test` + `pnpm --filter @arcaai/applications build test` + `pnpm --filter @arcaai/domains build test` green; the api↔harness callback contract is covered by unit tests.

### Non-goals

- The harness side (done in TASK-458). The escalation NOTIFICATION channel (email/pager) beyond persisting the record — scope at prioritization.

## Current State Evaluation (from TASK-458's implementer, 2026-07-09)

Harness sends: escalation POST (route missing in apps/api), `Idempotency-Key` header on 5 callbacks (apps/api ignores it), and the SMR key on generate retries (apps/smr doesn't honor it). See TASK-458 §STOP-and-report.

## Implementation Plan

Strict TDD, layer order Database → Domain → Services → API.

### PART A — Escalation endpoint (C1-05)

1. **Audit enum + migration**: add `GATE_ESCALATED` + `GATE_ABANDONED` to `HarnessAuditAction` (`packages/database/src/prisma/db_main/harness.prisma`). Migration `task_466_gate_escalation_audit_actions` — additive `ALTER TYPE … ADD VALUE IF NOT EXISTS` only. `db:generate` + regenerate the domain layer (`gen:model|entity|mapper|repository|factory`).
2. **DTO** (`harness/dto/harness-internal.dto.ts`): `HarnessEscalationRequest` (`tenantId` req; `reason` req `@IsIn(['gate_sla_breached','gate_sla_abandoned'])`; `jobId?`) + `HarnessEscalationResponse { recorded }`. The wire body is exactly `{tenantId, reason, jobId?}` — verified against the harness `escalate_gate` activity (its only caller passes no `escalationCount`/`terminal`, so `_prune` drops them).
3. **Service** `recordEscalation(id, dto)`: re-establish CLS, load consultation, `assertEqualTenants` (cross-tenant/missing → `NotFoundException`, 404-over-403), map `reason` → `GATE_ABANDONED` when `gate_sla_abandoned` else `GATE_ESCALATED`, append the WORM audit, return `{recorded:true}`.
4. **Controller**: `@Post('consultations/:id/escalation')` → `recordEscalation`.

### PART B — Idempotency-Key dedup (C1-03)

The 4 WORM/state-mutating callbacks that re-append on Temporal retry: `persistEntities`, `persistDraft`, `finalizeAssurance`, `recordGateDecision`. (Ephemeral `progress`/`assurance-event` are best-effort acks — no WORM, no dedup.)

1. Controller: `@Headers('Idempotency-Key')` on those 4 routes, forwarded to the service.
2. Service: inject `@Optional() @Inject(IRedisCacheService)` as a **trailing** ctor arg (preserves positional unit fixtures). Wrap each of the 4 in a get-then-setex guard (prefix `idempotency:`, 24h TTL) that **caches-and-replays the prior response body** (record AFTER success; Temporal retries are sequential). Cache miss / Redis throw → fall through (best-effort, mirrors TASK-299 D-10).
3. Import `RedisCacheModule.register()` into `HarnessInternalServiceModule`.

### Tests (RED first, Vitest)

- Service: recordEscalation reason→action mapping + `{recorded:true}`; cross-tenant → `NotFoundException`; same key twice → one effect + identical replay; different/absent key → not suppressed; Redis throw → falls through.
- Controller: `/escalation` → `recordEscalation`; the 4 dedup routes forward the header.
- DTO: rejects missing tenantId / unknown reason; accepts `{tenantId, reason, jobId}`.

## Implementation Summary

Implemented api-only (C1-03 + C1-05) on branch `fix/task-466-harness-receiver` (off `fix/2605-review`). SMR half (C1-04) split to TASK-469.

### Files changed

| File | Change |
|---|---|
| 2026-07-11 | **Closed (Status → Completed).** Adversarial review = APPROVE, no Critical/Important: WORM+hash-chained escalation (GATE_ESCALATED/GATE_ABANDONED; DB REVOKEs UPDATE/DELETE), idempotency across all 5 writers with distinct SLA ticks NOT falsely suppressed (verified by Map-backed Redis tests), 404-over-403 tenant safety (assertEqualTenants → NotFoundException), zero diff outside manifest. Migration is `ADD VALUE IF NOT EXISTS` with the enums already in the committed generated client (deploy-ready); harness→api e2e deferred (no live Temporal worker — skipped per owner). The stale CH note re: persistEntities/recordGateDecision tenant assertions was resolved by cc250bd47. C1-04 SMR idempotency split to TASK-469 (Completed). No external work remains — only the owner's push/PR. |
| `packages/database/src/prisma/db_main/harness.prisma` | `HarnessAuditAction` += `GATE_ESCALATED`, `GATE_ABANDONED` |
| `packages/database/.../migrations/20260710000000_task_466_gate_escalation_audit_actions/migration.sql` | Additive `ALTER TYPE … ADD VALUE IF NOT EXISTS` (both members) |
| `packages/domains/src/enums/generated/HarnessAuditAction.ts` | Regenerated enum (the only generated file this change touches) |
| `packages/applications/.../harness/dto/harness-internal.dto.ts` | `HARNESS_ESCALATION_REASONS`, `HarnessEscalationRequest`, `HarnessEscalationResponse` |
| `packages/applications/.../harness/harness-internal.service.ts` | `recordEscalation()`; `@Optional()` trailing `IRedisCacheService`; `withHarnessIdempotency()` guard wrapping the 4 WORM/draft callbacks (+`idempotencyKey?` params) |
| `packages/applications/.../harness/harness-internal.service.module.ts` | `RedisCacheModule.register()` import |
| `apps/api/src/modules/consultation/harness-internal.controller.ts` | `@Post('consultations/:id/escalation')`; `@Headers('Idempotency-Key')` forwarded on the 4 dedup routes |
| `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` | Registered the harness service test (now carries the 404-over-403 escalation test) in `SERVICE_COVERAGE` |
| `+ 3 test files` | DTO / service / controller unit tests (RED→GREEN) |

### Migration SQL

```sql
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'GATE_ESCALATED';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'GATE_ABANDONED';
```

Hand-written (not `prisma migrate dev`): the shared dev DB has heavy pre-existing drift (federated-learning tables) so `migrate dev` demanded a destructive reset — the repo convention for the push-managed dev DB (see the TASK-355 Phase D migration header) is the idempotent hand-written additive form. NOT applied to the shared dev DB (additive + safe; applies at deploy via the `db-migrate` PreSync job / `migrate:deploy`).

### Design notes / decisions

- **All 5 harness→api WORM/draft writes are idempotent** — dedup covers `persistEntities`, `persistDraft`, `finalizeAssurance`, `recordGateDecision`, AND `recordEscalation`. The escalation route was added in the adversarial-review delta: the harness ships + unit-tests an `Idempotency-Key` on the escalation POST (`activities.py:799 idempotency_key=_idempotency_key()`, `test_record_escalation_attaches_idempotency_key_header`), so a re-delivered `escalate_gate` (worker restart/deploy mid-SLA-wait, or a start_to_close timeout racing a slow-but-successful POST) would otherwise permanently double-append the hash-chained `GATE_ESCALATED` / terminal `GATE_ABANDONED` WORM row. The key `{run_id}:{activity_id}` is stable across retries but unique per distinct escalation tick, so dedup suppresses retries WITHOUT collapsing legitimate distinct escalations.
- **Escalation DTO carries no `userId`** — an SLA timeout is workflow-initiated (no clinician); the wire body is exactly `{tenantId, reason, jobId?}` (verified: `escalate_gate` passes no `escalationCount`/`terminal`, so the harness `_prune` drops them). `createWorkerSession` falls back to the `system-harness-internal` sentinel; the WORM `createdBy` is null.
- **Idempotency key** = harness `{run_id}:{activity_id}`; Redis key `idempotency:harness:{operation}:{tenantId}:{key}`, 24h TTL, get-then-setex (Temporal retries are sequential). Best-effort: absent key / no Redis / Redis throw → normal processing (mirrors TASK-299 D-10).

### Verification evidence

- `pnpm db:generate` — drift-clean (`prisma generate` OK); the enum regeneration is idempotent (re-running the generators reproduces exactly the 2 added members and nothing else).
- **Pre-existing generator drift (flagged)**: `gen:model`/`gen:entity`/`gen:factory` succeed but reproduce drift on 5 UNRELATED committed model files (`UserModel` missing the TASK-400 `PasswordResetTokens` relation, etc.) — the base branch's generated domain layer is already stale, independent of this change; reverted so the diff stays surgical (only `HarnessAuditAction.ts`). **`gen:mapper` + `gen:repository` FAIL** on the base with a pre-existing tooling bug (`Cannot read properties of undefined (reading 'fields')`) — also unrelated to an enum-value add (no `generate-mapper-check`/`generate-repository-check` CI gate exists).
- `pnpm --filter @arcaai/domains build test` — build clean; **1300 passed**, 2 skipped, 9 todo (107 files).
- `pnpm --filter @arcaai/applications build test` — build clean; **5925 passed**, 4 skipped (273 files). Includes 5 new DTO tests, 13 new service tests (9 + 4 recordEscalation dedup), and the `SERVICE_COVERAGE` registration.
- `pnpm build:api` — 8/8 turbo tasks OK.
- `pnpm --filter @arcaai/api test` — **2035 passed**, 4 skipped (124 files). Includes 7 new/updated harness controller tests (incl. escalation header forwarding).
- Lint: api package clean (exit 0, hard errors); my applications source files clean (0 warnings — the 94 `only-warn` prettier warnings are pre-existing in unrelated files).
- **harness→api e2e NOT run** — no live harness/Temporal worker in this environment; the api↔harness callback contract is covered by unit tests (controller delegation + service behavior). Flagged for a live-stack pass.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-458's three STOP-and-report coordination items (escalation endpoint, WORM dedup, SMR idempotency). Harness sender half done; this is the apps/api + apps/smr receiver half. Awaiting prioritization. |
| 2026-07-10 | Scope narrowed to **apps/api only** (C1-03 + C1-05); SMR half (C1-04 / AC-3) split to **TASK-469**. Implemented on `fix/task-466-harness-receiver`: `GATE_ESCALATED`/`GATE_ABANDONED` audit enum + migration `20260710000000_task_466_gate_escalation_audit_actions`, `POST /internal/harness/consultations/:id/escalation` (`recordEscalation`, 404-over-403), and `Idempotency-Key` dedup on the 4 WORM/draft callbacks (`persistEntities`/`persistDraft`/`finalizeAssurance`/`recordGateDecision`) via a best-effort Redis get-then-setex guard. TDD RED→GREEN; domains/applications/api build+test+lint green. Flagged: pre-existing generated-layer drift + `gen:mapper`/`gen:repository` tooling failure on the base branch; harness→api e2e deferred (no live stack). |
| 2026-07-10 | **Adversarial-review delta** (1 Important, no Critical): closed the escalation-dedup gap — `recordEscalation` now honors the `Idempotency-Key` too (controller `@Headers` forwarding + service `withHarnessIdempotency('recordEscalation', …)` wrap), so **all 5** harness→api WORM/draft writes are idempotent. A re-delivered `escalate_gate` (which the harness ships + tests an idempotency key for) no longer double-appends the hash-chained `GATE_ESCALATED`/`GATE_ABANDONED`. Added 4 service dedup tests (same key → one append + replay; different/absent key → not suppressed; Redis throw → falls through) + escalation controller header-forwarding tests. Gates re-run green: applications **5925**, api **2035**, `build:api` 8/8, domains build OK, lint clean. (Out of scope, flagged separately by the orchestrator: `persistEntities`/`recordGateDecision` lack the consultation tenant assertion — pre-existing since TASK-330.) |
