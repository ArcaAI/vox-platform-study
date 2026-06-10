# TASK-349: `Highlight` Model Missing from Tenant-Scope Allow-List

| Field | Value |
|---|---|
| **Ticket** | TASK-349 |
| **Title** | `Highlight` model missing from `TENANT_SCOPED_MODELS` (drift-guard failure) |
| **Created** | 2026-06-10 |
| **Updated** | 2026-06-10 |
| **Status** | Completed |
| **Type** | bugfix (multi-tenancy hardening) |
| **Origin** | Discovered during TASK-348 Phase 5 verification (pre-existing at HEAD; §5.2 of TASK-348 README) |
| **Related tickets** | TASK-344 (introduced the `Highlight` model), TASK-305 (tenant-scope extension + drift guard) |

---

## 1. Requirement Analysis

### 1.1 Description

The `Highlight` model (added by TASK-344, Manual Doctor Highlighting; schema applied via `db push` 2026-06-09) declares a `tenantId String` scalar in `packages/database/src/prisma/db_main/consultation.prisma:413` but was never added to the `TENANT_SCOPED_MODELS` allow-list in `packages/database/src/extensions/tenant-scope.ts`. The TASK-305 drift-guard test fails exactly as designed:

```
FAIL packages/database/src/extensions/__tests__/tenant-scope.test.ts
  > lists every schema tenantId model in TENANT_SCOPED_MODELS (drift = [])
AssertionError: expected [ 'Highlight' ] to deeply equal []
```

### 1.2 Business Context

The tenant-scope Prisma extension is the second line of the defence-in-depth multi-tenancy posture (behind RLS). While `Highlight` is excluded, its reads/writes do **not** get automatic `tenantId` injection — any repository/service query that forgets a manual tenant filter becomes a cross-tenant exposure on clinician-authored highlight data. This is a security-relevant gap, not a test nuisance.

### 1.3 Acceptance Criteria

1. `Highlight` queries receive automatic tenant injection (or are consciously registered in `INTENTIONALLY_UNSCOPED` with a reviewed justification — not expected).
2. The drift-guard test passes: `missing` diff is `[]`.
3. Existing Highlight repository/service tests still pass (injection must not break current call sites that already pass `tenantId` explicitly).
4. RLS coverage for the `Highlight` table confirmed or tracked (TASK-305 Phase C pattern).

## 2. Current State Evaluation

- `consultation.prisma:413` — `model Highlight` with `tenantId String` (standard field template).
- `tenant-scope.ts:53` — `TENANT_SCOPED_MODELS` lists 6 consultation.prisma models; `Highlight` absent.
- `tenant-scope.test.ts:165` — `INTENTIONALLY_UNSCOPED` is empty ("Add a name here ONLY for a conscious, reviewed exception").
- The drift guard fails at HEAD (verified during TASK-348 Phase 5 with zero local changes under `packages/database`), i.e. this predates the TASK-345/346/347/348 work.

## 3. Implementation Plan

> Gate: requires user approval before code is written.

| Step | Action | Verification |
|---|---|---|
| 1 | RED is already on disk: the drift-guard test fails at HEAD | Captured in TASK-348 §5.2 |
| 2 | Add `'Highlight'` to `TENANT_SCOPED_MODELS` under the consultation.prisma section (update the section count comment) | Drift test green |
| 3 | Audit Highlight repository/service call sites for assumptions broken by injection (e.g. queries that intentionally omit `tenantId`) | `pnpm test:unit --filter @arcaai/database --filter @arcaai/domains --filter @arcaai/applications` green |
| 4 | Confirm RLS policy exists for the `highlight` table per TASK-305 Phase C; if absent, record follow-up | Migration/policy SQL reviewed |

Estimated scope: ~1-line product change + verification; the value is in step 3/4 review.

## 4. Implementation Summary

Completed 2026-06-10. One-line product change + one legitimate test-tripwire bump; zero call-site changes required.

### 4.1 Files changed

| File | Change |
|---|---|
| `packages/database/src/extensions/tenant-scope.ts` | Added `'Highlight'` to `TENANT_SCOPED_MODELS`; section comment `// consultation.prisma (6)` → `(7)`. |
| `packages/database/src/extensions/__tests__/tenant-scope.test.ts` | Count tripwire `expect(TENANT_SCOPED_MODELS.size).toBe(40)` → `41` + test title + history comment, following the documented pattern used for every prior addition (28→29→31→36→38→40). The drift-guard test itself passes **unchanged**. |

### 4.2 RED → GREEN evidence

RED (HEAD, before fix) — `pnpm --filter @arcaai/database exec vitest run src/extensions/__tests__/tenant-scope.test.ts`:

```
FAIL src/extensions/__tests__/tenant-scope.test.ts
  > TENANT_SCOPED_MODELS stays in sync with the Prisma schema
  > lists every schema tenantId model in TENANT_SCOPED_MODELS (drift = [])
AssertionError: expected [ 'Highlight' ] to deeply equal []
Tests  1 failed | 64 passed (65)
```

GREEN (after fix), same command: `Tests 65 passed (65)`.

Full scoped suites — `pnpm --filter @arcaai/database --filter @arcaai/domains --filter @arcaai/applications test` (each package's vitest config excludes `integration/**`):

```
@arcaai/database      Test Files  20 passed (20)            Tests   803 passed (803)
@arcaai/domains       Test Files  90 passed | 2 skipped     Tests  1186 passed | 2 skipped | 9 todo
@arcaai/applications  Test Files 213 passed | 1 skipped     Tests  5002 passed | 4 skipped
```

ReadLints on both modified files: no linter errors.

### 4.3 Call-site audit (AC-3) — no breakage, zero changes

Every Highlight query path routes through the shared `Repository` base (`packages/domains/src/common/repository.ts`) against the extended client — the same path every other tenant-scoped model already takes, so injection composes identically:

| Call site | Path | Why injection is safe |
|---|---|---|
| `HighlightService.createHighlight` (`packages/applications/src/services/consultation/highlight/highlight.service.ts`) | `HighlightFactory.CreateHighlight({ tenantId: this.tenantId, … })` → `repository.create` | Factory sets `data.tenantId` from the same CLS context the extension reads; the create handler's equality assert passes. |
| `HighlightService.getHighlights` → `HighlightRepository.findByConsultation` | `findMany({ where: { consultationId } })` | Injection adds `tenantId` to `where` — exactly the intended hardening; service already guards via `assertParentInScope(consultationRepository, …)`. |
| `HighlightService.deleteHighlight` | `assertParentInScope(highlightRepository, …)` → `findById` (`findUnique({ where: { id } })`), then `softDelete` (`update({ where: { id } })`) | Extended-where-unique merge; the row is asserted in-tenant before the update, so the injected filter still matches. Identical to the Consultation/ContextItem paths in production. |
| `HarnessInternalService.assemble` (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:160`) | `highlightRepository.findByConsultation` | Runs inside `cls.run()` with `cls.set('tenantId', dto.tenantId)` (line 113–115) — tenant context present. |

Non-matches confirmed unrelated: `baseServices/logging/transports/highlight.transport.ts` + `apps/api/.../stream-ticket.service.ts` (Highlight.io observability vendor), `live-documentation.service.ts:448` (comment prose), seed `07-prompt-template.ts` (prompt copy). No direct `prisma.highlight.*` usage exists anywhere outside `HighlightRepository`. Seed/CLI paths run with no provider registered → documented super-admin pass-through, unaffected. Unit tests in domains/applications mock repositories, so none touch the extension.

### 4.4 RLS finding (AC-4) — documented follow-up, not implemented here

- **No RLS policy covers `core."Highlight"`** — and none covers any other table either: grep for `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` across all 17 migrations in `packages/database/src/prisma/db_main/migrations/` returns nothing (matches exist only in docs/research/e2e prose).
- This is consistent with TASK-305's README: **Phase C (RLS) was deferred to TASK-302** (depends on the `hope_tenant_user`/`hope_platform_admin` role split + PgBouncer decision). DB-level RLS is repo-wide absent by recorded decision, not a Highlight-specific omission.
- **Follow-up**: when TASK-302/Phase C lands, `core."Highlight"` must be included in the RLS policy set (clinician-authored marks over transcripts — PHI-adjacent; the Phase C.2 list of 7 PHI tables predates this model).
- Correction to §2: TASK-344 *does* have a migration on disk (`20260609203500_task_344_add_highlight/migration.sql` — purely additive, no RLS statements); the "applied via `db push`" note in the TASK-344 README describes how the ops apply happened, not a missing migration file.

Until then, Highlight tenant isolation rests on the two application layers, both now in place: service guards (`assertParentInScope`, TASK-344) + tenant-scope extension injection (this ticket).

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Ticket opened from TASK-348 Phase 5 findings (pre-existing root-suite failure characterized; security-relevant). | This README |
| 2026-06-10 | Fix implemented: `Highlight` added to `TENANT_SCOPED_MODELS` (consultation.prisma section 6→7); count tripwire 40→41. Drift guard green; database/domains/applications unit suites green (803 / 1186 / 5002). Call-site audit found zero breakages (no code changes outside the extension + its test). RLS audit: no policies exist repo-wide (TASK-305 Phase C deferred to TASK-302); Highlight recorded as a required table for that rollout. Status → Completed. | `packages/database/src/extensions/tenant-scope.ts`, `packages/database/src/extensions/__tests__/tenant-scope.test.ts`, this README |
