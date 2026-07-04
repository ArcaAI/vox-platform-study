# TASK-362 — Preferred Prompt Template Threading Is Incomplete Across Generation Paths

| Field | Value |
|---|---|
| **Ticket** | TASK-362 |
| **Short name** | Preferred-Prompt-Threading-Completeness |
| **Type** | bugfix (TASK-356 Phase 5 follow-up) |
| **Severity** | **Medium** |
| **Status** | Completed |
| **Created** | 2026-06-15 |
| **Updated** | 2026-06-16 |
| **Discovered by** | TASK-356 audit (2026-06-15) — flagged in the Phase-5 plan; see [`phase-5-realtime-cascade-plan.md:274`](../TASK-356-Admin-Managed-Models-Workflows/phase-5-realtime-cascade-plan.md) |
| **Owner** | TBD |

---

## 1. Requirement Analysis

### Description

TASK-356 README **§2.5** and the Phase-5 summary **§8D** claim the doctor-preferred prompt id
(`UserProfile.preferredPromptTemplateId`) is now threaded on **ALL** generation paths. That claim is
**overstated**: the preferred template is threaded only on the **summary** processor path (plus the
sync REST `summary.service.ts` from TASK-329 and the harness assemble path). It is **not** threaded
on the **pre-summary** or **comprehensive-summary** processors — so on those two paths the doctor's
personally-preferred template is **ignored**, and prompt resolution falls back to the
department/tenant/system default.

The Phase-5 plan itself flagged these two paths (plus `chain-summary`) as **consistency follow-ups**
that were defaulted **OUT** of Phase 5, so this is a known, scoped gap rather than a regression — but
it contradicts the "ALL paths" wording now in the committed TASK-356 README (corrected separately in
the TASK-356 audit; this ticket tracks the actual threading work).

### Business context

The doctor self-service preferred-template feature (TASK-356 Phase 6 / AC-6) lets a clinician pick a
personal prompt template. If that preference is silently dropped on the pre-summary and
comprehensive-summary paths, the doctor gets inconsistent output depending on **which** generation
path runs — undermining the feature and confusing users who set a preference that is only sometimes
honoured.

### Acceptance criteria

- [x] The doctor's `preferredPromptTemplateId` is **honoured on the pre-summary path**
  (`pre-summary.processor.ts`), mirroring `summary.processor.ts`. ✅ threaded into `resolve(...)` + `assemble(...)`.
- [x] The doctor's `preferredPromptTemplateId` is **honoured on the comprehensive-summary path**
  (`comprehensive-summary.processor.ts`). ✅ **Threaded** (not documented-out): the artifact is written
  to the **requesting** consultation, whose `doctorId` is unambiguous, so the "multi-consultation
  ambiguity" the Phase-5 plan flagged does not apply to the *requesting* doctor's preference. The sync
  **chain-summary** REST path (`chain-summary.service.ts`) was threaded for the same reason.
- [x] New/updated tests assert the preferred id reaches `promptResolutionService.resolve(...)` (and
  `promptAssemblyService.assemble(...)` where applicable) on the in-scope paths. ✅ 5 new tests; 94 passing across the 3 suites.
- [x] No regression on the already-threaded `summary.processor.ts` / sync REST / harness paths. ✅ unchanged + green; full-package `typecheck` exit 0.

---

## 2. Current State Evaluation

### Evidence (file:line)

**Threaded correctly (reference implementation):**

- `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts:93` —
  resolves `preferredPromptTemplateId` via `this.configResolver.resolvePreferredPromptTemplateId(consultation.doctorId ?? null)`.
- `:103` — passes it into `promptResolutionService.resolve({ …, preferredPromptTemplateId })`.
- `:152` — passes it into `promptAssemblyService.assemble({ …, preferredPromptTemplateId })`.

**Absent (the gap):**

- `packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts:78–81` —
  resolves via `this.promptResolutionService.resolve({ departmentId, promptType: 'pre-summary' })`
  with **no** `preferredPromptTemplateId` (and no `ConfigResolver` lookup). The doctor preference is
  dropped here.
- `packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts:143–146` —
  resolves via `this.promptResolutionService.resolve({ departmentId, explicitTemplate })` with **no**
  `preferredPromptTemplateId`. Same gap.

**Already flagged by the Phase-5 plan:**

- `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/phase-5-realtime-cascade-plan.md:274` —
  "(pending §12 Q4) consistency follow-ups — `pre-summary.processor.ts`, `comprehensive-summary.processor.ts`,
  `chain-summary.service.ts`. Recommend including `pre-summary.processor.ts` (single-doctor);
  `comprehensive`/`chain` are multi-consultation so 'doctor-preferred' is ambiguous → default OUT
  unless Q4 says otherwise."

### Dependencies & impact areas

| Area | Path | Impact |
|---|---|---|
| Pre-summary processor | `…/consultation/jobs/processors/pre-summary.processor.ts` | Needs `ConfigResolver` + preferred-id threading (single-doctor — clear win) |
| Comprehensive processor | `…/consultation/jobs/processors/comprehensive-summary.processor.ts` | Multi-consultation — decide scope (thread vs document-out) |
| Chain summary (related) | `…/consultation/summary/chain-summary.service.ts` | Same multi-consultation ambiguity (Phase-5 plan defaulted OUT) |
| Resolver | `…/services/config-resolver/config-resolver.service.ts` (`resolvePreferredPromptTemplateId`) | Already exists; reuse |
| Module wiring | `…/consultation/jobs/consultation-job.service.module.ts` | May need `ConfigResolverModule` available to the two processors |

---

## 3. Implementation Plan (APPROVED 2026-06-16 — scope: thread all three paths)

> Per [`01-development-workflow.mdc`](../../../.cursor/rules/01-development-workflow.mdc), the plan
> gate must be **approved before any implementation**.
>
> **Approved scope:** thread the requesting doctor's preferred id on **all three** paths
> (pre-summary + comprehensive + chain), keyed off each path's requesting `consultation.doctorId`.
> Executed as **three parallel agents** (one per path). See §4 for the implementation summary.

1. **Confirm scope (single-doctor vs multi-consultation).** Pre-summary is single-doctor → thread it.
   Decide whether comprehensive-summary (and chain-summary) thread the preferred id or are explicitly
   documented as out-of-scope (the Phase-5 plan leaned OUT for the multi-consultation paths because
   "doctor-preferred" is ambiguous when multiple doctors' consultations are combined).
2. **Thread `preferredPromptTemplateId`** into the in-scope processor(s), mirroring
   `summary.processor.ts`: resolve once via `ConfigResolver.resolvePreferredPromptTemplateId(consultation.doctorId)`
   and pass into `promptResolutionService.resolve(...)` (and `promptAssemblyService.assemble(...)`
   where that path assembles).
3. **Module wiring:** ensure `ConfigResolverModule` is imported where the processors are provided.
4. **TDD:** RED tests asserting the preferred id reaches resolution/assembly on the in-scope paths;
   GREEN minimal threading; REFACTOR. Keep `summary.processor.ts` and the harness/REST paths green.

### Verification criteria (to be refined at plan-gate)

- `pnpm --filter @arcaai/applications vitest run` for the affected processor suites — preferred id
  asserted present on the in-scope paths, absent regressions elsewhere.
- TASK-356 README §2.5/§8D wording matches the final scope (the audit already softened "ALL paths";
  this ticket either makes "all" true or pins the documented exceptions).

---

## 4. Implementation Summary

> **Implemented & verified 2026-06-16** via strict TDD (RED → GREEN), dispatched as **three parallel
> agents** (one per generation path). **Final scope:** the requesting doctor's `preferredPromptTemplateId`
> is now threaded on **all** generation paths — making the TASK-356 §2.5/§8D "ALL paths" claim literally
> true. **No DB / schema / migration / API / DTO changes** — the existing
> `ConfigResolver.resolvePreferredPromptTemplateId` and the `resolve`/`assemble` `preferredPromptTemplateId`
> params were reused as-is.

### What was built

All three paths mirror the reference `summary.processor.ts`: inject `ConfigResolver` as a **trailing
`@Optional()`** constructor parameter, resolve the requesting consultation's preferred id once via
`ConfigResolver.resolvePreferredPromptTemplateId(consultation.doctorId ?? null)`, then pass
`preferredPromptTemplateId: … ?? undefined` into prompt resolution and/or assembly (null-safe; a no-op
when the resolver is unwired).

| Path | Threading point(s) | Module wiring |
|---|---|---|
| **Pre-summary** (`pre-summary.processor.ts`) | `promptResolutionService.resolve(...)` **and** `promptAssemblyService.assemble(...)` | none — `consultation-job.service.module.ts` already imports `ConfigResolverModule` |
| **Comprehensive** (`comprehensive-summary.processor.ts`) | `resolve(...)` (when no explicit template) **and** `assemble(...)` (threaded through `callSmrService(...)`) | none — same module already wired |
| **Chain summary** (`chain-summary.service.ts`, sync REST) | `assemble(...)` only (threaded through `composeSmrInput(...)`; this path has no `resolve(...)` call) | **added** `ConfigResolverModule` to `chain-summary.service.module.ts` |

### Files changed

**Source (4):**
- `packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts`
- `packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts`
- `packages/applications/src/services/consultation/summary/chain-summary.service.ts`
- `packages/applications/src/services/consultation/summary/chain-summary.service.module.ts` (added `ConfigResolverModule`)

**Tests (3) — new RED→GREEN assertions that the preferred id reaches `resolve`/`assemble`:**
- `…/consultation/jobs/__tests__/pre-summary.processor.test.ts`
- `…/consultation/jobs/__tests__/comprehensive-summary.processor.test.ts`
- `…/consultation/summary/__tests__/chain-summary.service.test.ts`

### Verification (evidence)

- Combined suites: `pnpm --filter @arcaai/applications exec vitest run` on the 3 suites → **3 files, 94 tests passed** (5 new).
- Typecheck: `pnpm --filter @arcaai/applications typecheck` (`tsc --noEmit`) → **exit 0**.
- Lints on the 4 edited source files → **no errors**.
- No regression on `summary.processor.ts` / sync REST / harness paths (untouched + still green).

### Deviations / notes

- **Scope decision:** comprehensive + chain were **threaded** (not documented-out). The Phase-5 plan
  leaned OUT for these because they are multi-consultation, but each aggregated artifact is written to
  the **requesting** consultation, whose `doctorId` is unambiguous — so the *requesting* doctor's
  preference is well-defined per path.
- Module wiring was only needed for **chain-summary** (`ConsultationJobServiceModule` already imported
  `ConfigResolverModule` for the two BullMQ processors).

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-15 | Ticket opened from the TASK-356 audit. Documented (file:line) that `preferredPromptTemplateId` is threaded only on `summary.processor.ts:93,103,152` and is **absent** from `pre-summary.processor.ts:78–81` and `comprehensive-summary.processor.ts:143–146`, contradicting the TASK-356 README §2.5/§8D "ALL paths" claim; cross-referenced the Phase-5 plan's own consistency-follow-up flag (`phase-5-realtime-cascade-plan.md:274`). Proposed DRAFT threading plan (needs approval). No code changed. | _(docs only)_ |
| 2026-06-16 | **Completed via 3 parallel agents (strict TDD).** Threaded the requesting doctor's `preferredPromptTemplateId` on all three remaining paths — `pre-summary.processor.ts` (resolve + assemble), `comprehensive-summary.processor.ts` (resolve + assemble via `callSmrService`), and the sync `chain-summary.service.ts` (assemble via `composeSmrInput`); added `ConfigResolverModule` to `chain-summary.service.module.ts`. All mirror `summary.processor.ts` (trailing `@Optional()` `ConfigResolver`). Verified: **94 tests passed** across the 3 suites, `typecheck` exit 0, lints clean, no regressions. Corrected the TASK-356 README §2.5 / §8D / Decision-2 / Open-follow-ups wording to record the gap is now closed. | `pre-summary.processor.ts`, `comprehensive-summary.processor.ts`, `chain-summary.service.ts`, `chain-summary.service.module.ts`, + 3 test files; TASK-356 `README.md` |
