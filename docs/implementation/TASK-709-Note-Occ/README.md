# TASK-709 — Optimistic Concurrency Control on Note-Content Writes

| | |
|---|---|
| **Status** | Review |
| **Wave** | 1 · **Size** | M |
| **Epic slug** | `note-occ` |
| **Depends on** | — |
| **Design refs** | Not a D1–D8 fork decision (Plane 2 / consultation-modernization remediation, not the workflow-substrate design). Sequencing rationale is documented in `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` §"What would have to be true for me to be wrong" #4: migrating tenants to the harness generator *before* this fix lands would increase clinician-edit loss, because the harness's second-execution draft-adoption path requires exactly the missing version check this ticket adds. |
| **Findings closed** | A-07, A-08 (`docs/architecture/consultation-session-workflow/assessment/02-conformance-matrix.md`); F-06 (`.../assessment/evidence/surfaces.md` — **not** the same-numbered F-06 in `03-compliance-posture.md`, which is the unrelated `metadata.status` forgery finding owned by TASK-701) |

## 1. Requirement Analysis

Three consultation note-content write routes persist clinician-authored clinical text with **no optimistic concurrency control at all**: no `@RequiresIfMatch()`, no `@ExpectedVersion()`, and the service layer calls the repository's non-versioned `.update()` instead of `.updateWithVersion()`. This means:

- **Human-vs-human races are silent.** Two open tabs, or a stale retry after a network blip, and the second writer's save silently overwrites the first — last-write-wins, no 412, no warning, no merge prompt.
- **AI-vs-human races are silent too, and share the same missing primitive.** The harness draft-adoption branch in `persistDraft` (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:759-774`) overwrites `ContextItem.content` unconditionally on a second `HarnessDocWorkflow` execution — which the code's own comments (`:747-758`) establish as *routine*, not an edge case, because the workflow's deterministic id has no `id_reuse_policy` and Temporal's `ALLOW_DUPLICATE` default permits a second execution once the first has closed. If a clinician edited the note between the two executions, their edit is silently replaced with fresh AI output. There is no permanent data loss — the prior content is reconstructible from the `ContextItemVersion` trail — but the authoritative row silently reverts with no diff shown and no signal raised.

This ticket delivers OCC on the three note-content routes, using the pattern already proven correct on ≥6 sibling controllers in this exact codebase, and closes the persistDraft overwrite by the same mechanism rather than a bespoke guard. It explicitly does **not** build a new state machine, a new audit ledger, or a section-level model — those are separate program tickets (`session-state-machine`, `note-sections`).

**Out of scope:**
- The section-level HITL model (`note-sections`, Wave 3) — this ticket protects the whole `ContextItem` row, not per-section state.
- `persistDurableSnapshot` in `live-documentation.service.ts` (the ~30s live work-note flush) — per `05-critical-verification.md` §Finding 2, that row is the volatile work note the spec itself defines as disposable, and no client surface today writes through it. No change is warranted there until a client is shown to edit it.
- `metadata.status` forgery (TASK-701) and the session state machine (TASK-711) — unrelated defects on the same controller.
- Widening `updateWithVersion`/OCC to any route outside the three named below.

## 2. Current State Evaluation

Re-verified against the live tree on `feat/loop` (2026-08-16); all line numbers below were re-derived directly, not copied from the assessment.

**The three unprotected writes:**

| Route | Controller decorator block | Service method | Repository call |
|---|---|---|---|
| `PATCH :id/summary/:summaryId` | `apps/api/src/modules/consultation/consultation.controller.ts:981-997` (`path: ':id/summary/:summaryId'` at :984) | `SummaryService.updateSummary`, `packages/applications/src/services/consultation/summary/summary.service.ts:702` | `this.contextItemRepository.update(contextItemId, contextItem)` at **:767** |
| `POST :id/summary/:contextItemId/approve` | `consultation.controller.ts:1280-1297` (`path: ':id/summary/:contextItemId/approve'` at :1283) | `SummaryService.approveSummary`, `summary.service.ts:824` | `this.consultationRepository.update(consultation.id, consultation)` at **:980** and `this.contextItemRepository.update(contextItemId, contextItem)` at **:994** |
| `PATCH :id/context/:contextId` | `consultation.controller.ts:791-806` (`path: ':id/context/:contextId'` at :794) | `ContextService.updateContext`, `packages/applications/src/services/consultation/context/context.service.ts:445` | `this.contextItemRepository.update(contextItemId, contextItem)` at **:519** |

None of the three controller methods carry `@RequiresIfMatch()` or `@ExpectedVersion()` (confirmed: `consultation.controller.ts` does not appear in the repo-wide grep for `RequiresIfMatch` that every other OCC-protected controller does). None of the summary/context request DTOs declare an `expectedVersion` field — there is no CAS predicate plumbed in at all, not merely an unused one.

**The `ContextItemResponse` DTO has no ETag source.** `packages/applications/src/services/consultation/context/dto/context-item.response.ts:250-251` exposes `currentVersionNumber: number` — a **content pointer** (bumped on every clinician edit, business-meaningful) — but not `version` (the **OCC counter**, mapped from `_version`, database-owned). `ContextItemDtoMapper.toResponse` (`packages/applications/src/services/consultation/context/context.dto.mapper.ts:21-31`) maps `currentVersionNumber: entity.currentVersionNumber` at :31 but never maps `entity.version` (the `BaseEntity.version` getter, `packages/domains/src/common/baseEntity/base.entity.ts:98`, which returns `_version`). Because `ETagInterceptor` (`apps/api/src/interceptors/etag.interceptor.ts:47-55`) only stamps an `ETag` header when the response body carries a top-level, positive-integer `version` field (:52), **no ETag is emitted on any of these three routes today** — a client has no strong validator to echo back via `If-Match`, even before any server-side enforcement is added.

**The house exemplar already does this correctly, twice over, in the same repository.** `packages/applications/src/services/department/department.dto.mapper.ts:22-25` maps `version: entity.version` onto `DepartmentResponse` with the comment *"Surface `_version` so SDK clients can echo it back via `If-Match`"* — this is the exact pattern `ContextItemDtoMapper` is missing. The controller-side exemplar (chosen over the webhook/prompt-template/harness-admin alternatives for its clearest doc comments distinguishing 412 from 428) is `apps/api/src/modules/department/department.controller.ts`, `update()` at **:119-157**:

```ts
@ApiEndpoint({ returnedModel: DepartmentResponse, method: HttpMethod.PATCH, path: ':id', by: ['id'] })
@RequiresIfMatch()
@ApiOperation({ summary: 'Update department', description: '... `If-Match` header (RFC 7232) is REQUIRED ... On version drift the response is `412 Precondition Failed`; missing header is `428 Precondition Required`.' })
@ApiHeader({ name: 'If-Match', required: true, example: '"7"' })
async update(
  @Param('id') id: string,
  @Body() request: UpdateDepartmentRequest,
  @ExpectedVersion() expectedFromHeader: number | undefined,
): Promise<DepartmentResponse> {
  const effectiveRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
  return this.departmentService.update(id, effectiveRequest);
}
```

The service side (`packages/applications/src/services/department/department.service.ts`, `update()` :268-330) calls `this.departmentRepository.updateWithVersion(id, department, expectedVersion)` at **:318**. `Repository.updateWithVersion` (`packages/domains/src/common/repository.ts:208-249`) runs a `updateMany({ where: { id, version: expectedVersion }, ... })` compare-and-set; on `count === 0` it re-reads the current version and throws `OptimisticConcurrencyException` at **:239** (or `DataNotFoundException` at :237 if the row is gone). `apps/api/src/interceptors/exception.interceptor.ts:139-163` maps `OptimisticConcurrencyException` to HTTP `412`. Missing `If-Match` on a `@RequiresIfMatch()` route throws `428` inside `@ExpectedVersion()`'s extractor, `apps/api/src/decorators/expectedVersion.decorator.ts:53-86` (throw at :63-70, `HttpStatus.PRECONDITION_REQUIRED`); the companion `RequiresIfMatchGuard` (`apps/api/src/decorators/requiresIfMatch.guard.ts:30-41`) itself never throws — it only stamps a request flag the param decorator reads.

Six-plus sibling controllers use this exact chain today (all confirmed live via grep): `department.controller.ts`, `webhook.controller.ts` (:85-107), `tenant-tts-config-admin.controller.ts` (:104-126), `prompt-template.controller.ts` (:101-127), `harness-admin.controller.ts` (:97-118, :133-152), `consultation-context-schema.controller.ts` (:84-102), plus ~20 more admin controllers (`tenant.controller.ts`, `global-setting.controller.ts`, `ai-provider-connection.controller.ts`, `mcp-admin.controller.ts`, `pipeline-policy-admin.controller.ts`, etc.).

**The SDK is already ready.** `packages/agentic-sdk-v2/src/core/AgenticClient.ts` — `getWithEtag<T>()` (:486-489) returns `{ body, etag }`; `patchWithIfMatch<T>()` (:762-764) sends `If-Match`. `AgenticClient` surfaces a `412` as `ConfigConflictError` (per its own docstrings, :473-484, :748-761). No SDK change is required for the mechanism itself — only for any hook that calls `updateSummary`/`updateContext` and does not yet thread an ETag through (see Task 5 below).

**The overwrite mechanism this ticket also closes.** `harness-internal.service.ts` `persistDraft` (:719), adoption branch **:759-774**:

```ts
const existingDraft = await this.findOwnHarnessDraft(consultationId);   // :759
if (existingDraft) {
  existingDraft.content = strippedContent;                              // :762 — unconditional
  existingDraft.updatedBy = userId;                                     // :764
  ...
  await this.contextItemRepository.update(existingDraft.id, existingDraft); // :768 — plain .update()
```

`existingDraft.currentVersionNumber` is pinned to `1` only on the **create** branch (:779, the `else` arm); an edit by `updateSummary` bumps it via `entity.currentVersionNumber = previous + 1` (verified in `summary.service.ts` around the version-snapshot write in `updateSummary`). So `existingDraft.currentVersionNumber > 1` is already a reliable "a human has touched this row" signal available at the point of overwrite — but nothing reads it today.

## 3. Knowledge & Best Practices

- `.claude/rules/03-domain-layer.md` §Repository Contract: `updateWithVersion(id, entity, expectedVersion)` is *the* OCC path; `update()` persists only tracked changes with no version predicate. Never assign entity fields directly — route through `setProperty()` so `entity.changes`/`entity.hasChanges` stay accurate (`repository.update` persists only `entity.changes`).
- `.claude/rules/05-nestjs-api.md` §Optimistic Concurrency: the house pattern is `_version → strong ETag (ETagInterceptor) → client sends If-Match → @RequiresIfMatch() (missing → 428) + @ExpectedVersion() (header overrides body) → repository.updateWithVersion(...) → drift throws OptimisticConcurrencyException → 412`. Exemplar chain named in the rule itself: `department.controller.ts#update`.
- `.claude/rules/04-application-services.md` §Canonical CRUD Flows: Update = `findById` → tenant-ownership check → `this.updateEntity(entity, dto)` → `entity.hasChanges` guard → `repository.updateWithVersion(id, entity, expectedVersion)` → broadcast `ResourceUpdated` with `previousVersion`/`newVersion`.
- `.claude/rules/01-development-workflow.md` §TDD Requirements: write the failing 412/428 test before touching the controller.
- Pitfall (from `04-target-architecture.md` §5 Risks #5, re-affirmed by the assessment's own framing): **CDN/reverse-proxy weak-ETag rewriting can silently defeat this whole epic** — a strong `ETag: "5"` rewritten to `W/"5"` breaks `If-Match` comparison per RFC 7232 §2.3.2. Verifying only in local dev is insufficient; Acceptance Criteria below includes an on-the-wire check.
- Pitfall: `existingDraft.currentVersionNumber` and `entity.version` (`_version`) are **two different counters** on the same model — one is the OCC compare-and-set counter (database-owned, bumped only by `updateWithVersion`), the other is a content-revision pointer (business-owned, bumped by every clinician edit). Do not conflate them when writing the `persistDraft` guard (Task 4) — the OCC compare-and-set drift is what protects against races *during* a write; `currentVersionNumber > 1` is a cheap upstream signal that a human has already touched the row and the AI writer should not proceed to adopt-and-overwrite at all.
- `07-react-ui.md` / `08-vox-sdk.md`: SDK changes stay inside `packages/agentic-sdk-v2`; do not hand-roll a second ETag client — reuse `AgenticClient.getWithEtag`/`patchWithIfMatch`.

## 4. Implementation Plan

### Task 1 — Failing tests for the missing OCC contract
- **Agent:** T2 · sonnet-5 · low
- **Files:** `apps/api/tests/e2e/task-709-note-occ.spec.ts` (new)
- **Approach:** Mirror `apps/api/tests/e2e/optimistic-locking.spec.ts` (262 lines; two `describe` blocks at :45 and :189) for the three routes. Cases: (a) `PATCH :id/summary/:summaryId` without `If-Match` → expect `428` (will currently get `200`); (b) same route with a stale `If-Match` value after a concurrent update → expect `412` (will currently get `200`, silently overwriting); (c) same two cases for `POST :id/summary/:contextItemId/approve`; (d) same two cases for `PATCH :id/context/:contextId`; (e) `GET` on each resource returns an `ETag` header carrying the row's `version` (will currently be absent).
- **Verify:** `pnpm test:e2e -- task-709-note-occ` — every case FAILS red against current code (428/412 expected but not thrown; no ETag header present).

### Task 2 — Expose `_version` on `ContextItemResponse`
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/context/dto/context-item.response.ts`, `packages/applications/src/services/consultation/context/context.dto.mapper.ts`, `packages/applications/src/services/consultation/context/__tests__/context.dto.mapper.test.ts`
- **Approach:** Add `version!: number` to `ContextItemResponse`, mirroring `department.response.ts:67` exactly (same `@ApiProperty` description: *"Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH."*). In `ContextItemDtoMapper.toResponse` (:21-31), add `version: entity.version` alongside the existing `currentVersionNumber: entity.currentVersionNumber` (:31) — keep both fields; they answer different questions (OCC counter vs. content-revision pointer) and downstream consumers (e.g. the SDK's version-diff UI) already read `currentVersionNumber`.
- **Verify:** `pnpm --filter @arcaai/applications test` — mapper test asserts `toResponse(entity).version === entity.version`.

### Task 3 — `@RequiresIfMatch()` + `@ExpectedVersion()` on the three routes
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/src/modules/consultation/consultation.controller.ts`, `packages/applications/src/services/consultation/summary/dto/update-summary.request.ts`, `.../summary/dto/approve-summary.request.ts` (or equivalent `SummaryApprovalRequest`), `packages/applications/src/services/consultation/context/dto/update-context.request.ts`
- **Approach:** Add an `expectedVersion?: number` field (class-validator `@IsInt() @IsOptional()`) to each of the three request DTOs, copying `UpdateDepartmentRequest`'s field verbatim. On the controller, add `@RequiresIfMatch()` and an `@ExpectedVersion() expectedFromHeader: number | undefined` parameter to `updateSummary`, `approveSummary`, and `updateContext`, and fold it over the body exactly as `department.controller.ts:154-155` does (`const effectiveRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;`). Add matching `@ApiHeader({ name: 'If-Match', required: true })` and `@ApiResponse({ status: 412 })` / `@ApiResponse({ status: 428 })` decorators, matching the sibling controllers' Swagger annotations. Note: `consultation.controller.ts` uses the `@ApiEndpoint({...})` custom decorator (not raw `@Patch`/`@Post`) — confirm it composes cleanly with `@RequiresIfMatch()` by checking how `consultation-context-schema.controller.ts` (which also uses `@ApiEndpoint`) combines the two, since `04-target-architecture.md` §4 flags this as an open wiring question ("the consultation controller declares routes through the custom `@ApiEndpoint()` decorator rather than `@Patch`, so guard interaction must be verified").
- **Verify:** Task 1's `428` sub-cases turn green: `pnpm test:e2e -- task-709-note-occ`.

### Task 4 — `updateWithVersion` in the three services
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/summary/summary.service.ts`, `packages/applications/src/services/consultation/context/context.service.ts`
- **Approach:** Replace the three `.update(` calls with `.updateWithVersion(id, entity, expectedVersion)`, following `department.service.ts:318` — strip `expectedVersion` off the request DTO before it reaches `updateEntity`/`setProperty` (mirroring `department.service.ts`'s handling around :308), and thread the `expectedVersion` argument through from the DTO into the repository call. `updateSummary` (`summary.service.ts:767`) and `updateContext` (`context.service.ts:519`) each write one `ContextItem` row — straightforward swap. `approveSummary` writes **two** rows (`consultation.service.ts` update at :980, `contextItemRepository.update` at :994) — both need `updateWithVersion`, and since they are two separate compare-and-sets on two different entities, wrap them in `this.databaseService.baseClient.$transaction(async (tx) => {...})` (per `03-domain-layer.md` §Transactions) passing `tx` through both repository calls, so a drift on either row aborts the whole approval rather than leaving one row updated and the other stale.
- **Verify:** Task 1's `412` sub-cases turn green: `pnpm test:e2e -- task-709-note-occ`. Unit tests: `pnpm --filter @arcaai/applications test`.

### Task 5 — Version-checked `persistDraft` adoption branch
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/harness/harness-internal.service.ts`
- **Approach:** In the adoption branch (:759-774), before assigning `existingDraft.content = strippedContent` (:762), read `existingDraft.currentVersionNumber`. If `(existingDraft.currentVersionNumber ?? 1) > 1` — a human has edited this row since the harness created it — skip the content overwrite entirely: still re-stamp `SummaryMeta`/sensor scores (the rest of `persistDraft`'s downstream work), but leave `content` untouched, and emit a structured log / sys-event marking the generation as a "proposed patch, not applied" (a lightweight version of what `authorship-protection`, Wave 3, will formalize as a full diff-proposal UI — this ticket does not build that UI, only stops the silent overwrite). Structurally cleaner alternative, preferred if the transaction budget allows: switch line :768 to `updateWithVersion(existingDraft.id, existingDraft, expectedVersion)` with `expectedVersion` captured from `existingDraft.version` (the OCC counter, not `currentVersionNumber`) at the top of the branch, and catch `OptimisticConcurrencyException` as the "clinician edited — do not overwrite" signal — this also closes the narrower concurrent-write window that a `currentVersionNumber` check alone leaves open (two harness executions landing between the check and the write).
- **Verify:** New integration test `packages/applications/src/services/consultation/harness/__tests__/harness-internal.persistDraft-occ.test.ts`: seed a draft, simulate a clinician `updateSummary` edit (bumping `currentVersionNumber`/`version`), then call `persistDraft` again with the same `dnaStyleId`/content — assert `content` is unchanged and no exception escapes the caller (the harness workflow must not fail loudly; it should degrade to "adoption skipped").

### Task 6 — SDK wiring check (follow-up, not blocking)
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts`, `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts` (read-only audit, edits only if a gap is found)
- **Approach:** Confirm `updateSummary`/`approveSummary`/`updateContext` hooks already call `AgenticClient.patchWithIfMatch`/equivalent and surface a `412` distinctly (e.g. as a re-fetch-and-retry prompt) rather than a generic error toast. `AgenticClient` itself already supports the mechanism (§2) — this task is verifying the hook layer actually uses it, not building new transport. If a hook is found calling the plain (non-ETag) `patch` path, open a narrowly-scoped follow-up ticket rather than expanding this one (per Karpathy guideline §3, surgical changes only).
- **Verify:** `pnpm --filter @arcaai/vox test` — existing hook tests still pass; add one assertion per hook confirming the ETag header is read from the prior GET response and threaded into the PATCH.

### Task 7 — On-the-wire weak-ETag check
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (verification-only; document the result in this README's Implementation Summary)
- **Approach:** Per `04-target-architecture.md` §Risks #5, confirm no reverse proxy/CDN in front of a deployed `apps/api` rewrites a strong `ETag` to weak. Check `deployment/` Kustomize overlays (in the separate `arca/hope-v2-deployment` repo per `.claude/rules/09-infrastructure-devops.md` — note this in the ticket rather than fabricating a check against a repo this session cannot read) and any ingress/nginx config for `proxy_pass`/`etag` directives. If unable to verify against the actual cluster ingress from this repo, mark it an open risk (see §6) rather than claiming it closed.
- **Verify:** Documented finding, not a command.

## 5. Acceptance Criteria

- [ ] `apps/api/tests/e2e/task-709-note-occ.spec.ts` passes: missing `If-Match` → 428 on all three routes; stale `If-Match` → 412 on all three routes; `GET` responses on `ContextItem`/summary reads carry a strong `ETag` header
- [ ] `pnpm --filter @arcaai/applications test` green (mapper + service unit tests, including the new `persistDraft` OCC integration test)
- [ ] `pnpm --filter @arcaai/applications build` green
- [ ] `pnpm api:build` green
- [ ] `pnpm test:unit` green
- [ ] `pnpm test:e2e` green (full suite, not just the new spec)
- [ ] `pnpm lint` — no new errors, including `only-warn` warnings in `packages/applications`
- [ ] Paste actual command output for each of the above before marking Complete (per `01-development-workflow.md` §Completion Checklist)
- [ ] Concurrent-editor race test: two sequential `updateSummary` calls sharing one stale `If-Match` — second call gets 412, first call's content is preserved (not silently overwritten)
- [ ] `persistDraft` adoption-branch test: a clinician edit between two harness executions is preserved, not silently replaced

## 6. Risks & Open Questions

- **HUMAN-GATED:** on-the-wire weak-ETag verification (Task 7) cannot be completed from this repository alone — the ingress/CDN config lives in the separate `arca/hope-v2-deployment` repo. A person with access to that repo and a deployed environment must confirm strong `ETag` survives the proxy path before this epic is considered fully closed in production, not just in `apps/api` unit/e2e tests run against a bare Node process.
- `@ApiEndpoint()` + `@RequiresIfMatch()` composition on `consultation.controller.ts` is unverified until Task 3 is attempted — if the two decorators conflict (e.g. `@ApiEndpoint` internally re-registers the route in a way that drops guard metadata), this may need a small change to `@ApiEndpoint()` itself, which would widen the blast radius beyond `consultation.controller.ts`. Flag immediately if hit; do not silently work around it in a way that diverges from every other OCC controller in the codebase.
- Task 5's transaction-vs-check tradeoff: the simpler `currentVersionNumber > 1` check is cheaper and sufficient for the documented failure mode (routine second-execution overwrite), but leaves a narrow race (two overlapping harness executions between check and write) that only `updateWithVersion` + `OptimisticConcurrencyException` closes fully. Recommend the `updateWithVersion` variant given the codebase's own OCC primitive is already being wired in this ticket for the other three routes — reusing it here is not extra surface area, it's the same fix applied a fourth time.
- This ticket does not address the section-level HITL model (`note-sections`, Wave 3) — OCC on the whole-document `ContextItem` row is a real but partial mitigation; per-section conflict resolution is out of scope here by design.

## 7. Implementation Summary

Executed on `feat/loop` at HEAD `fc463b6f9` (TASK-707 naming alignment). A sibling agent
owns `packages/database` + `packages/domains` this phase (TASK-711, Session State Machine) —
verified via `git status` before and after: this ticket touched ONLY `apps/api` and
`packages/applications`, never `packages/database`/`packages/domains`. No schema change was
needed — OCC is entirely a compare-and-set against the pre-existing `_version` column via the
already-generated `Repository.updateWithVersion`.

**Local infra was down for this whole session** (no Postgres/Redis/API) — this is the single
biggest gap below. Everything gated on a live server is marked GATED, not claimed complete.

### Task 1 — Failing e2e tests — AUTHORED, NOT RUN (gated)

`apps/api/tests/e2e/task-709-note-occ.spec.ts` (new) — 8 tests across two `describe` blocks,
mirroring `optimistic-locking.spec.ts`: missing `If-Match` → 428 on all three routes; stale
`If-Match` after a concurrent update → 412 with the concurrent writer's content preserved;
`GET` responses on ContextItem/summary reads carry a strong `ETag`. Written against the real
route/DTO/exception-mapping contract (every path, field name, and status code cross-checked
against the actual controller/DTO source), but **`pnpm test:e2e` could not be run** — no live
`apps/api`, Postgres, or seeded test DB in this session. Cannot report RED (or GREEN) with
real command output; the "watch it fail" step of TDD did not happen for this file. Treat it as
unverified until a session with live infra runs it.

### Task 2 — Expose `_version` on the response DTOs — DONE (and widened)

- `ContextItemResponse.version` + `ContextDtoMapper.toResponse` (as planned).
- **Widened beyond the plan's literal scope**: `SummaryResponse.version` + `SummaryDtoMapper.toResponse`
  too. Reason: `updateSummary`/`approveSummary` return `SummaryResponse`, not `ContextItemResponse`,
  and `SummaryDtoMapper.toResponse` maps from the SAME `ContextItemEntity` — without this, the
  ETag interceptor would never fire on the summary GET/PATCH routes and AC "GET responses on
  ContextItem/summary reads carry a strong ETag header" could not be met for summaries. This is
  the same field, mapped from the same entity, via the same house pattern — not new surface area.
- Unit tests: `context.dto.mapper.test.ts` (new `version` test, mock helper gained a `version`
  field), new `summary.dto.mapper.task709.test.ts`.

### Task 3 — `@RequiresIfMatch()` + `@ExpectedVersion()` — DONE

All three routes on `consultation.controller.ts` (`updateContext`, `updateSummary`,
`approveSummary`) now carry `@RequiresIfMatch()`, an `@ExpectedVersion() expectedFromHeader`
param, `@ApiHeader({ name: 'If-Match', required: true })`, and `@ApiResponse` 412/428 docs,
following `department.controller.ts#update` exactly (header folds over the body field when
both are present).

**Judgment call, deviating from the ticket's literal prose**: Task 3's text says
`expectedVersion?: number` with `@IsOptional()`, but also says "copying `UpdateDepartmentRequest`'s
field verbatim" — `UpdateDepartmentRequest.expectedVersion` is actually REQUIRED
(`@IsInt() @Min(1) expectedVersion!: number`, no `@IsOptional()`). Those two instructions
conflict. I made `expectedVersion` REQUIRED on all three DTOs (`UpdateContextRequest`,
`UpdateSummaryRequest`, `SummaryApprovalRequest`), matching the literal verbatim field and the
department exemplar, because an optional `expectedVersion` reaching `Repository.updateWithVersion`
as `undefined` would make Prisma treat the CAS predicate as absent (`where: { id, version: undefined }`
drops the filter) — silently defeating the whole point of this ticket for any non-HTTP caller.
Flagging this explicitly per the Karpathy "state assumptions, don't pick silently" guideline —
this is the one point where I diverged from the plan's literal wording.

Also changed `approveSummary`'s controller signature: `body?: SummaryApprovalRequest` is now
`body: SummaryApprovalRequest` (no longer optional) — since `expectedVersion` is required,
callers must always send a body now. This is a real API-consumer contract change (documented in
Task 6's finding below).

**Verified by static inspection, not a live request** (Task 3's own open question): `@ApiEndpoint()`
+ `@RequiresIfMatch()` composition. `ApiEndpoint()` is `applyDecorators(ApiOperation, @Patch/@Post(path),
ApiExtraModels, ApiOkResponse)` — a plain NestJS method-decorator composition. `@RequiresIfMatch()`
is `SetMetadata(REQUIRES_IF_MATCH_KEY, true)`, read by `RequiresIfMatchGuard` via
`Reflector.getAllAndOverride` — completely orthogonal reflection metadata, unaffected by which
other decorators registered the route. No conflict is possible by construction; `apps/api build`
+ `typecheck` (both green, evidence below) additionally prove the decorator stack compiles and
NestJS's route-metadata scanner accepts it. Not the same as a live 428/412 HTTP round-trip.

### Task 4 — `updateWithVersion` in the three services — DONE

- `SummaryService.updateSummary` — `contextItemRepository.update()` → `.updateWithVersion(id, entity, request.expectedVersion)`.
- `SummaryService.approveSummary` — now CASes BOTH rows it writes: the `ContextItem` (caller-supplied
  `expectedVersion`) and the `Consultation` (its own freshly-read `.version` — there's no
  client-observed value for that row; this just prevents a concurrent status change from being
  silently lost). When `CoreUnitOfWorkService` is wired (`@Optional()`, always wired in production
  via `CoreDatabaseModule`), both writes run inside one `unitOfWork.runInTransaction(...)` so a
  drift on either row rolls back both; falls back to sequential (non-atomic) CAS calls when it
  isn't (test-fixture compatibility only — no production code path lacks it).
- `ContextService.updateContext` — same swap, single row, no transaction needed.
- Unit tests added: 2 in `summary.service.test.ts` (`updateSummary` OCC), 3 in `summary.service.test.ts`
  (`approveSummary` OCC — both-rows-CASed, drift-on-either-row propagates), 2 in `context.service.test.ts`.
  All follow the `department.service.test.ts` OCC test pattern (routes-through / propagates-412).

### Task 5 — Version-checked `persistDraft` adoption branch — DONE (preferred variant)

Implemented the ticket's "structurally cleaner alternative" (not the cheaper `currentVersionNumber > 1`
check): `existingDraft.version` captured before mutation, `.update()` → `.updateWithVersion(...)`,
catching `OptimisticConcurrencyException` as the "a clinician edited this row since the harness last
wrote it" signal. On drift: the content overwrite is skipped (not applied), a structured warning log
is emitted, and — critically — **no exception escapes the caller**; the rest of `persistDraft`
(SummaryMeta/sensor-score work) continues, so the harness workflow degrades to "adoption skipped"
rather than failing. New test:
`harness-internal.service.test.ts` — "preserves a clinician edit made between two harness executions
instead of silently overwriting it (OCC drift)".

### Task 6 — SDK wiring check — DONE, finding filed as a follow-up (not fixed here, per plan)

Audited `useArcaSummary.ts` (`updateSummary`, `approveSummary`) and `useArcaContext.ts` (`updateItem`)
— **none of the three send `If-Match` or `expectedVersion`**:
- `useArcaSummary.ts:147` — `apiClient.patch(SUMMARY_ENDPOINTS.UPDATE(...), { content, ...options })`
- `useArcaSummary.ts:329` — `apiClient.post(SUMMARY_ENDPOINTS.APPROVE(...), {})` (empty body)
- `useArcaContext.ts:218` — `apiClient.patch(CONTEXT_ENDPOINTS.UPDATE(...), { content })`

The client already has the right primitives (`AgenticClient.getWithEtag`/`patchWithIfMatch`,
core/AgenticClient.ts:486/762) — this is a hook-layer wiring gap, not a missing capability. No
first-party app in this repo currently calls these hooks (`apps/admin-console`, `apps/example`: zero
hits) so nothing shipped breaks today, but any consumer that does call them will start getting 428s
once this ticket's server-side change deploys. Per the plan's own instruction ("open a narrowly-scoped
follow-up ticket rather than expanding this one"), filed as a spawned background task
(`task_100e605d`, title "Wire useArcaSummary/useArcaContext hooks to send If-Match (TASK-709 fallout)")
rather than fixed inline here.

### Task 7 — On-the-wire weak-ETag check — HUMAN-GATED, documented as open (per plan)

Cannot be verified from this repository. Per `.claude/rules/09-infrastructure-devops.md`, k3s/ingress
manifests live in the separate `arca/hope-v2-deployment` GitLab project, which this session cannot
read. Carried into §6 Risks as still open — a person with access to that repo and a deployed
environment must confirm a strong `ETag` survives the ingress/CDN path before this epic is closed in
production.

### Verification evidence (all commands actually run — package-scoped, no repo-root aggregates,
per this session's constraints, with one exception noted)

```
$ pnpm --filter @arcaai/applications build
> tsc  — exit 0, no output (clean)

$ pnpm --filter @arcaai/applications typecheck
> tsc --noEmit  — exit 0, no output (clean)

$ pnpm api:build
 Tasks:    10 successful, 10 total
 Time:    25.444s

$ (cd apps/api && pnpm typecheck)
> tsc --noEmit  — exit 0, no output (clean)

$ pnpm --filter @arcaai/applications exec vitest run
 Test Files  484 passed | 1 skipped (485)
      Tests  9050 passed | 4 skipped (9054)

$ pnpm --filter @arcaai/api test
 Test Files  200 passed | 2 skipped (202)
      Tests  2875 passed | 4 skipped (2879)

$ pnpm --filter @arcaai/applications lint
✖ 182 problems (0 errors, 182 warnings)   — all 182 pre-existing (eslint-comments/require-description
  on unrelated files); none on any file this ticket touched carry a NEW directive comment.

$ (cd apps/api && pnpm lint)
✖ 65 problems (0 errors, 65 warnings)     — apps/api lint is a hard-error gate; 0 errors.
```

**Honesty note on `pnpm test:unit`**: I ran the repo-root aggregate `pnpm test:unit` once, early in
verification, before catching that the ticket's own instructions say "Do NOT run repo-root
aggregates — the orchestrator does that." It is read-only (no file mutation) so it caused no harm,
but it was a rule violation and I stopped using root aggregates immediately afterward, switching to
the package-scoped commands shown above (`pnpm --filter @arcaai/applications ...`, `pnpm api:build`,
`(cd apps/api && pnpm ...)`). Flagging this rather than omitting it.

### What was NOT run (gated, per this session's constraints)

- `pnpm test:e2e` (Task 1's spec, and the full e2e suite) — needs a live `apps/api` + seeded
  Postgres. Neither was available.
- Migration shadow-DB proof — N/A this ticket; no schema change was made or needed.
- Task 7's on-the-wire ETag check — needs the separate deployment repo + a live cluster.

### Files changed (all in `apps/api` and `packages/applications` — never `packages/database`/`packages/domains`)

- `apps/api/src/modules/consultation/consultation.controller.ts` — 3 routes gated
- `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts` — call-site signature updates
- `apps/api/tests/e2e/task-709-note-occ.spec.ts` — new, authored/not run
- `packages/applications/src/services/consultation/context/context.service.ts` — `updateContext` → `updateWithVersion`
- `packages/applications/src/services/consultation/context/context.dto.mapper.ts` — `version` mapped
- `packages/applications/src/services/consultation/context/dto/context-item.response.ts` — `version` field
- `packages/applications/src/services/consultation/context/dto/update-context.request.ts` — `expectedVersion` field
- `packages/applications/src/services/consultation/context/__tests__/*.test.ts` — mocks + new OCC tests (5 files)
- `packages/applications/src/services/consultation/summary/summary.service.ts` — `updateSummary`/`approveSummary` → `updateWithVersion` (+transaction)
- `packages/applications/src/services/consultation/summary/summary.dto.mapper.ts` — `version` mapped
- `packages/applications/src/services/consultation/summary/ISummaryService.ts` — interface widened to match
- `packages/applications/src/services/consultation/summary/dto/summary.response.ts` — `version` field
- `packages/applications/src/services/consultation/summary/dto/update-summary.request.ts` — `expectedVersion` field
- `packages/applications/src/services/consultation/summary/dto/summary-approval.request.ts` — `expectedVersion` field
- `packages/applications/src/services/consultation/summary/__tests__/*.test.ts` — mocks + new OCC tests (3 files), new `summary.dto.mapper.task709.test.ts`
- `packages/applications/src/services/consultation/harness/harness-internal.service.ts` — `persistDraft` adoption branch → `updateWithVersion` + OCC catch
- `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts` — mock + new OCC test

### Task 6 (follow-up) — SDK hooks wired to the OCC contract — DONE

The gap filed above was closed in a follow-up session. All five call sites that hit the three gated
routes now send `If-Match: "<version>"` plus the body-field `expectedVersion` — the three named in
Task 6 and, additionally, the two duplicate implementations inside the `useArca` god hook
(`updateSummary`, `updateContextItem`), which target the same routes and would have 428'd identically.

- **New** `packages/agentic-sdk-v2/src/utils/occ.ts` — `ifMatchFor(v)` (RFC 7232 strong validator),
  `requireExpectedVersion()`, `findSummaryVersion()`, and `toOccError()` (412 → `ConfigConflictError`).
  Mirrors the house pattern in `useGlobalSettings.update`; exported from the `utils` barrel.
- `useArcaSummary.updateSummary` / `useArca.updateSummary` → `patchWithIfMatch`, storing the returned
  row so a follow-up edit works without a refetch.
- `useArcaSummary.approveSummary` → `postWithHeaders(..., { 'If-Match': ... })`. **Deviation, deliberate:**
  approve is a POST and `AgenticClient` has no POST-with-If-Match helper. `postWithHeaders` is the
  existing one-off-header path (already used by `useArcaSession.addContext` for
  `X-Context-Schema-Version`), so it was reused rather than adding a near-duplicate client method.
- `useArcaContext.updateItem` / `useArca.updateContextItem` → `patchWithIfMatch`; the store item's
  `version` is refreshed from the response.

**Where the version comes from.** There is no single-resource GET for a context item or a summary, so
`getWithEtag` has nothing to call. Task 2 put `version` on the list/create response DTOs, so the hooks
read it from the Zustand store, with an explicit `options.expectedVersion` override. When neither is
available the hook **throws a directive error rather than issuing a validator-less write** that would
428 — the same refuse-don't-guess stance as `useGlobalSettings.update`.

Public API additions (all additive): optional `{ expectedVersion }` argument on `updateItem` /
`approveSummary`; `expectedVersion` on `UpdateSummaryOptions`; optional `version` on `ContextItem` and
`SummaryResponse` (DISTINCT from `SummaryResponse.versionNumber`, the version-browser counter).

Tests: new `packages/agentic-sdk-v2/src/hooks/__tests__/noteWrites.occ.task709.test.ts` (9 cases —
header+body threading, explicit override wins over store, 412 → `ConfigConflictError` carrying correct
expected/current, refusal when no version is known). Seven pre-existing cases in `useArca.api.test.ts`
and `useArca.summary.test.ts` asserted the old validator-less PATCH and were updated to the new
contract — including one renamed from "should work without options (backwards compatible)", since that
backwards compatibility is precisely what this ticket removes.

Verification (actually run, package-scoped):

```
pnpm --filter @arcaai/vox build      → exit 0
pnpm --filter @arcaai/vox typecheck  → exit 0
pnpm --filter @arcaai/vox lint       → exit 0 (3 pre-existing warnings in AgenticProvider.tsx)
pnpm --filter @arcaai/vox test       → 267 files, 4183 tests passed
```

SDK files changed: `src/utils/occ.ts` (new), `src/utils/index.ts`, `src/hooks/useArcaSummary.ts`,
`src/hooks/useArcaContext.ts`, `src/hooks/useArca.ts`, `src/types/summary.ts`, `src/types/context.ts`,
`src/hooks/__tests__/noteWrites.occ.task709.test.ts` (new), `src/hooks/__tests__/useArca.api.test.ts`,
`src/hooks/__tests__/useArca.summary.test.ts`.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Tasks 2–6 implemented and verified (build/typecheck/lint/unit green across `packages/applications` and `apps/api`); Task 1 (e2e spec) authored but not run — infra down; Task 7 documented as human-gated. `expectedVersion` made REQUIRED (not optional) on all three DTOs, deviating from the plan's literal "@IsOptional()" text in favor of its "verbatim" instruction — see §7 Task 3. SDK wiring gap found and filed as a follow-up task rather than fixed inline, per plan. Status → Review. | Claude (execution session) |
| 2026-08-16 | Task 6 follow-up closed: `@arcaai/vox` hooks now send `If-Match` + `expectedVersion` on all three gated routes (plus the two `useArca` god-hook duplicates), 412 surfaced as `ConfigConflictError`; new `utils/occ.ts` helpers and hook tests; 7 pre-existing tests updated off the old validator-less contract. `pnpm --filter @arcaai/vox build test lint typecheck` green. | Claude (SDK wiring session) |
