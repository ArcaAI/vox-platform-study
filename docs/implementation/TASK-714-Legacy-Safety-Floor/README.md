# TASK-714 — Legacy Generator Safety Floor (Deliberately Capped, Deleted by TASK-732)

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 1 · **Size** | S |
| **Epic slug** | `legacy-safety-floor` |
| **Depends on** | TASK-704 (`generator-entry-point-seam`) |
| **Design refs** | D1 — Generator end-state: **Staged migration** — "entry-point seam now → capped legacy floor during infra hardening → harness-only, legacy deleted." This ticket IS phase 2 of D1's three-phase plan (`docs/architecture/agentic-workflow-platform/design.md` decision log). |
| **Findings closed** | Narrows (does not fully close — see §1 Out of Scope) A-25 (`02-conformance-matrix.md`, GATED-OFF risk: sign-before-assurance) by making `signedBeforeAssurance` non-vacuous on the legacy path. Does not close A-09 (clinical safety sensors) — dosage parity is a partial, capped mitigation only. |

## 1. Requirement Analysis

`SummaryService.approveSummary`'s assurance guard is silently vacuous on the legacy (default, non-harness) generation path:

```ts
// summary.service.ts:867
const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
```

`draftMeta` comes from `summaryMetaRepository.findByContextItem(contextItemId)` (:866). The legacy generator (`summary.processor.ts`) **never writes a `SummaryMeta` row at all** — so `draftMeta` is always `null` for a legacy-generated note, `!!draftMeta` is `false`, and the guard that is supposed to catch "signing before assurance completed" simply never fires. This is not a bug in the guard's logic; it's a guard with no input on the path that needs it most, because `pipeline.harnessEnabled` code-defaults `false` (`config-resolver.service.ts:80`) and is the platform default for every tenant that hasn't explicitly opted in.

This ticket raises a **deliberately minimal, explicitly capped** floor on the legacy branch — write a `SummaryMeta` row (with `assuranceCompletedAt` set) so the existing guard becomes non-vacuous, add a cheap dosage-parity check, and run the groundedness check that already runs on the live SSE path. It explicitly does **not** port the harness's full sensor suite, the multi-stage gate, or WORM generation events beyond one minimal append — per D1 and `04-target-architecture.md` §"Wave 2 — Generator consolidation", this code is **throwaway, sized to the exposure window, and deleted by the same epic that retires legacy** (TASK-732, `legacy-migration-deletion`, per the backlog's dependency graph: `T730 --> T732` and Wave 4's `legacy-migration-deletion`). Every line this ticket adds must be trivially removable in one PR when that day comes — no shared abstraction that the harness path also grows to depend on.

**Explicitly out of scope (cite `design.md`'s YAGNI ledger and `04-target-architecture.md` §"What we are NOT doing"):**
- Porting `numeric_dose.py`'s full sensor, the harness's entity-faithfulness/groundedness-NLI sensor suite, the multi-stage gate, or MCP terminology validation — Python-only, Temporal-bound, and explicitly named as NOT to be duplicated ("Bring the legacy branch of that seam to a floor... Explicitly NOT the sensor suite, NOT the gate").
- Building a second, parallel assurance implementation that could drift from the harness's — the floor reuses exactly two things the codebase already has in TypeScript (the groundedness tool, the WORM append service) rather than re-implementing anything Python-side.
- Any change to `pipeline.harnessEnabled`'s default, or to which tenants use which generator — that's TASK-732/Wave 4.
- The generator-entry-point seam itself (routing all generation calls through one `NoteGenerationService`) — that is TASK-704's scope; this ticket assumes the seam exists and adds the floor to its legacy branch. If TASK-704 has not landed when this ticket executes, Task 1 below must locate the current legacy entry point directly (`summary.processor.ts`) rather than inventing seam code that duplicates TASK-704's work.

## 2. Current State Evaluation

Re-verified against the live tree on `feat/loop` (2026-08-16).

**The vacuous guard**, `summary.service.ts` (`approveSummary`, full method :824-1027):
```ts
// :866-878
const draftMeta = await this.summaryMetaRepository.findByContextItem(contextItemId);
const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
const overridingSafetyFlag = !!draftMeta && SummaryService.hasSafetyFlag(draftMeta);
```
At :959, `signedBeforeAssurance` only appends a `SIGNED_BEFORE_ASSURANCE` WORM annotation — it does **not** block signing (the actual hard block is `overridingSafetyFlag` at :869-873, throwing `ConflictException` unless `options?.overrideSafetyFlag`). So even once this ticket makes `signedBeforeAssurance` non-vacuous, it remains an **audit annotation**, not a hard gate — that split is the existing, correct design (an unverified-but-not-flagged note can still be signed with a WORM breadcrumb saying so; a *flagged* note is hard-blocked). This ticket does not change that split — it only ensures the annotation fires accurately on the legacy path instead of never firing at all.

**`SummaryMeta` model** — `packages/database/src/prisma/db_main/consultation.prisma:248-367`. Relevant fields for the floor: `contextItemId String @unique` (:265-266), `aiModelId`/`aiModelVersion`/`promptVersion` (:269-271), `generatedAt DateTime?` (:301), sensor-score columns `entityFaithfulnessScore`/`coverageScore`/`ragTriadScore Float?` (:322-324 — **no dedicated `groundednessScore` column**; groundedness rides in `ragTriadScore` or `guardrailDecisions` JSON), `gateDecision String?` ('PASS'|'REGEN'|'FLAG') and **`assuranceCompletedAt DateTime?`** (:335-336 — comment at :331-334 states the guard's exact contract: "reads `assuranceCompletedAt` (must be set) + `guardrailDecisions.safety` (must not FLAG)"). No `degraded`/`reducedAssurance` boolean column exists — reduced assurance is inferred from the `gateDecision`/`assuranceCompletedAt` combination, not a dedicated flag.

**Legacy generator writes no `SummaryMeta` today**, `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` (389 lines): SMR call at `callSmrService` (invoked :182, POST to `${smrServiceUrl}/api/v1/generate` at :316); `ContextItem` (RAW_SUMMARY) created at :199/:209. A `summaryMeta` object IS built at :215-220 (`aiModelId`, `processingTimeMs`, `inputTokens`, `outputTokens`) but it is only embedded in the in-memory `SummaryJobResult` used for the `SummaryGenerated` event payload (:238) — **confirmed zero `summaryMetaRepository`/`SummaryMetaFactory` references anywhere in the file**. No `SummaryMeta` row is ever persisted on this path. **Also confirmed: no `consultation.status = ...` assignment anywhere in this file** — the legacy path leaves `Consultation.status` at whatever it was before generation (typically `OPEN`/`RECORDING`); it never transitions to `PENDING_REVIEW` the way the harness path does. This is a second, smaller gap in scope for this ticket (see Task 3).

**The harness pattern to copy a reduced version of**, `harness-internal.service.ts` `persistDraft` (:719): `SummaryMetaFactory.CreateSummaryMeta({...})` at :837-867 builds the full row (sensor scores, citations map, gate decision, `assuranceCompletedAt: isEarly ? null : new Date()`); persisted via `summaryMetaRepository.findByContextItem` → `.updateWithVersion`/`.create` (:872-888, both `encryptBestEffort`-wrapped); status flip at :890-896 — `consultation.status = isEarly ? ConsultationStatus.DRAFT_PENDING_SENSORS : ConsultationStatus.PENDING_REVIEW`. The legacy floor's minimal write is a **reduced subset** of this exact call shape (`tenantId, contextItemId, aiModelId, generatedAt, assuranceCompletedAt: new Date()`, plus whatever floor sensor scores Task 2 computes), landing straight on `PENDING_REVIEW` (legacy has no early/optimistic delivery phase, so it should go straight there — mirroring the non-early branch here, never `DRAFT_PENDING_SENSORS`).

**`ConsultationStatus` enum** — `packages/database/src/prisma/db_main/enums.prisma:278-288`: `OPEN, RECORDING, DRAFT_PENDING_SENSORS, PENDING_REVIEW, SIGNED, CLOSED, REOPENED`. Both members this ticket needs already exist.

**Dosage-sensor parity is not directly portable — it must be a native TS reimplementation, not a cross-language call.** `apps/harness/src/harness/sensors/computational/numeric_dose.py` (118 lines): `NumericDoseSensor.run()` (:68) is pure Python regex/string matching (`_NUM_UNIT` pattern at :32, extracts `(value, unit)` tokens from note vs. transcript, flags any note token absent from the transcript). It is **not** a Temporal `@activity.defn` in its own right — it's invoked only through `apps/harness/src/harness/sensors/registry.py`, itself only reachable from `apps/harness/src/harness/temporal/{activities,workflows,worker}.py`. No standalone HTTP endpoint exposes it; the only harness HTTP surface that touches evaluation is `/eval/run` (`apps/harness/src/harness/api/endpoints/eval.py:114-165`), which is a synchronous golden-set/judge-scored gate (TASK-713's territory) — heavyweight and semantically wrong for a per-generation dosage check. `apps/nlp` has no dosage-related code at all. **Conclusion: "dosage-sensor parity where cheap" means porting a simplified numeric-dose regex check natively into TypeScript** (mirroring `numeric_dose.py`'s `_NUM_UNIT` matching logic, :32-53), run in-process inside the legacy path — not an HTTP or Temporal call into Python. This is exactly the kind of narrow, capped addition D1's "floor, not parity" language calls for.

**Groundedness is already TS-callable and reusable without going through Python/Temporal.** `live-documentation.service.ts:1202-1207` calls `this.toolRegistry.guardrail().execute(...)`. `GuardrailGroundednessTool` (`packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts`, class :262, `execute()` :272) POSTs to `${guardrailServiceUrl}/api/guardrail/ground` via plain `HttpService.axiosRef.post` (:277-285) with `X-Service-Token` (:276), fail-closed on any error/timeout/malformed body (returns `{ verdict: 'unverified' }`, never `grounded` — :286-303, `mapGroundednessResponse` :314-360). Its dependency shape, `GroundednessToolDeps` (:242-250), is `{ httpService, guardrailServiceUrl, logger, secretsService?, timeoutMs, maxRetries, retryBackoffMs }` — no live-documentation-specific state. `summary.processor.ts` already injects `HttpService` and `SecretsService` (optional) (constructor :29-51) — so `GuardrailGroundednessTool` (or a thin wrapper around it) is **directly constructible and reusable** from the legacy processor without touching Temporal or duplicating the HTTP client.

**WORM append is already a plain NestJS service, no Temporal dependency.** `packages/applications/src/services/harness-audit/harness-audit.service.ts`, `HarnessAuditService` class :55, `async append(input: AppendHarnessAuditInput)` :76 — constructor deps are `HarnessAuditEventRepository` + optional `SecretsService` (:58-63), a plain `@Injectable()`. Confirms the legacy path can append a minimal generation WORM event from TS directly, following the same call pattern `summary.service.ts` already uses at :925/:942/:960.

**`harnessEnabled` default** — `config-resolver.service.ts:80`, `harnessEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DEPARTMENT }`; `codeDefaultResult()` reads it at :316. Confirms legacy is the platform default this ticket is capping exposure on.

## 3. Knowledge & Best Practices

- **D1 (design.md) governs this ticket's shape directly**: "capped legacy floor during infra hardening" is phase 2 of a three-phase, explicitly-staged plan; this ticket's scope must not creep toward phase-1 parity.
- `04-target-architecture.md` §"Options, honestly" (b): explicitly warns against the floor becoming "a second permanent assurance implementation in a second language that must be kept in step with the first" — this ticket avoids that by reusing the TS-native groundedness tool and WORM service rather than reimplementing anything the harness already does in Python, and by capping scope to exactly what's named (SummaryMeta write, dosage parity, groundedness advisory).
- `.claude/rules/04-application-services.md` §Canonical CRUD Flows / Transactions: use `runInTransaction`/`baseClient.$transaction(callback)` if the floor's SummaryMeta write and status flip need to be atomic with the ContextItem creation this ticket doesn't otherwise touch — check TASK-704's seam shape once it lands to see where the natural transaction boundary sits.
- `.claude/rules/03-domain-layer.md`: use `SummaryMetaFactory.CreateSummaryMeta(...)`, never `new SummaryMetaEntity()`; the mapper must carry `FIELDS_NOT_WRITABLE = ['version']` per the OCC rules already established for this model (confirm `SummaryMetaEntityMapper` already does this — it should, since `SummaryMeta` is OCC-written by the harness path via `updateWithVersion` at `harness-internal.service.ts:876`).
- `01-development-workflow.md` §TDD: write the failing "legacy note cannot be signed while a FLAG is unresolved" / "legacy note's `signedBeforeAssurance` WORM annotation fires correctly" tests before the SummaryMeta write lands.
- Pitfall: do not accidentally make the floor's dosage check or groundedness call **block** signing the way the harness's full sensor suite does — per D1's explicit scope, this is a **floor**, not parity; a groundedness/dosage failure on the legacy path should produce a `FLAG`-equivalent `gateDecision`/annotation (feeding the *existing* `overridingSafetyFlag` hard-block, which already exists and already works — this ticket only needs to populate `SummaryMeta` correctly, not build a new blocking mechanism).
- Pitfall: this code is deleted by TASK-732 in the same epic that retires legacy. Do not build it as a shared library both paths import — keep it inside `summary.processor.ts` (or wherever TASK-704's seam lands the legacy branch), so the deletion diff is contained and obviously safe to review.

## 4. Implementation Plan

### Task 1 — Confirm/locate the legacy branch after TASK-704
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (investigation)
- **Approach:** If TASK-704 (`generator-entry-point-seam`) has landed by execution time, locate its `NoteGenerationService` legacy branch and treat that as the insertion point for Tasks 2-4 instead of `summary.processor.ts` directly. If it has not landed, proceed against `summary.processor.ts` as verified in §2, and flag in this ticket's Implementation Summary that the floor was built pre-seam and may need a follow-up move once TASK-704 lands (do not block on TASK-704 landing first if it's not ready — the floor's exposure-reduction value doesn't depend on the seam existing, only its long-term maintainability does).
- **Verify:** Documented decision in §7.

### Task 2 — Failing tests: legacy note gets `SummaryMeta` + assurance annotation
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/processors/__tests__/summary.processor.summary-meta-floor.test.ts` (new)
- **Approach:** Assert that after `SummaryProcessor.process()` runs, a `SummaryMeta` row exists for the created `ContextItem` with `assuranceCompletedAt` set; assert `Consultation.status` transitions to `PENDING_REVIEW`. Also assert `SummaryService.approveSummary`'s `signedBeforeAssurance` guard now correctly evaluates `false` (not vacuously `false` via `!!draftMeta` short-circuit) for a legacy-generated note whose assurance genuinely completed, and correctly participates in `overridingSafetyFlag`'s block when the floor's dosage/groundedness check flags an issue.
- **Verify:** `pnpm --filter @arcaai/applications test -- summary-meta-floor` — fails red (no SummaryMeta write exists yet).

### Task 3 — Minimal `SummaryMeta` write + status flip
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`
- **Approach:** After the `ContextItem` (RAW_SUMMARY) is created (:199-209), inject `SummaryMetaRepository` and `SummaryMetaFactory` and call `SummaryMetaFactory.CreateSummaryMeta({ tenantId, contextItemId, aiModelId, promptVersion, generatedAt: new Date(), assuranceCompletedAt: new Date(), ...Task 4/5's sensor fields })`, then `summaryMetaRepository.create(entity)` — a plain create, no `updateWithVersion` needed since this is the row's first write on this path (the harness path's `findByContextItem` → update-or-create branch exists because *it* can run twice; the legacy processor runs once per job). Immediately after, set `consultation.status = ConsultationStatus.PENDING_REVIEW` and persist via the existing `consultationRepository` (already injected) — mirroring `harness-internal.service.ts:890-896`'s non-early branch, never `DRAFT_PENDING_SENSORS` (legacy has no optimistic-delivery phase). Wrap the ContextItem create + SummaryMeta create + status update in one `this.databaseService.baseClient.$transaction(callback)` if TASK-704's seam doesn't already provide a transaction boundary — a partial write here (ContextItem created, SummaryMeta missing) would recreate exactly the vacuous-guard bug this ticket fixes.
- **Verify:** Task 2's SummaryMeta/status assertions turn green.

### Task 4 — Dosage-parity check (native TS)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/processors/legacy-dosage-check.util.ts` (new, colocated with the processor per the "keep it contained, trivially deletable" note in §3)
- **Approach:** Port `numeric_dose.py`'s `_NUM_UNIT` regex-matching approach (extract `(value, unit)` tokens from the generated note and from the source transcript; flag any note token with no matching transcript token) into a small, pure TypeScript function taking `(noteText: string, transcriptText: string) => { flagged: boolean; unmatchedTokens: string[] }`. This is deliberately a simplified port, not a byte-for-byte translation — degrade-not-pass on missing/empty transcript input, matching the Python sensor's documented behavior. Call it from Task 3's insertion point; on `flagged: true`, set `SummaryMeta.gateDecision = 'FLAG'` (feeding the existing `overridingSafetyFlag` hard-block in `approveSummary` — no new blocking mechanism needed) and note the unmatched tokens in whatever `guardrailDecisions`/citations JSON field is cheapest to extend without a schema migration (check `encryptedGuardrailDecisions` shape first before adding a new column).
- **Verify:** Unit test with a fixture note containing a dose absent from the transcript → `flagged: true`; a fixture where all doses appear in the transcript → `flagged: false`. `pnpm --filter @arcaai/applications test`.

### Task 5 — Groundedness advisory
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`
- **Approach:** Inject `GuardrailGroundednessTool` (or construct it inline from the already-injected `HttpService`/`SecretsService`/`ConfigService`, following `live-tool-registry.ts:262`'s constructor shape) and call `.execute({ summary: generatedNoteText, sourceText: transcriptText })` after generation, before the `SummaryMeta` write lands (Task 3). Store the verdict in `SummaryMeta` the same way the harness path does (check which field `harness-internal.service.ts:837-867` uses for its groundedness signal — likely `ragTriadScore` or the `guardrailDecisions` JSON blob — and reuse the same field so downstream readers of `SummaryMeta` don't need a legacy-path special case). Per §3's pitfall, an `unverified` groundedness verdict is **advisory** here (annotate, don't hard-block) — only wire it into `gateDecision = 'FLAG'` if Task 0/design intent explicitly wants it blocking; the ticket brief says "groundedness advisory," so default to annotation-only unless review says otherwise.
- **Verify:** Unit test: a mocked `unverified` groundedness response results in a `SummaryMeta` row carrying that signal but does not by itself throw/block generation. `pnpm --filter @arcaai/applications test`.

### Task 6 — Minimal WORM generation event
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`
- **Approach:** Inject `HarnessAuditService` and append one generation-event row (following the existing action taxonomy used elsewhere for `summary.service.ts`'s `:925/:942/:960` appends — do not invent a new `HarnessAuditAction` member without checking whether an existing one fits, e.g. a generic `GENERATE` action) after the SummaryMeta write succeeds. Best-effort per the codebase's established pattern for non-critical audit appends (`encryptBestEffort`-style try/catch that logs but doesn't fail the job) — matching how `harness-internal.service.ts` treats its own audit appends as best-effort where noted.
- **Verify:** Unit test confirms one WORM row is appended per legacy generation. `pnpm --filter @arcaai/applications test`.

## 5. Acceptance Criteria

- [ ] `pnpm --filter @arcaai/applications test` green, including the new floor tests
- [ ] `pnpm --filter @arcaai/applications build` green
- [ ] A legacy-generated note now produces a `SummaryMeta` row with `assuranceCompletedAt` set — `signedBeforeAssurance` is no longer vacuously false
- [ ] Legacy generation flips `Consultation.status` to `PENDING_REVIEW` (previously left unset)
- [ ] Dosage-parity check flags a note whose dose is absent from the transcript, feeding the existing `overridingSafetyFlag` block (no new blocking mechanism built)
- [ ] Groundedness check runs advisory (annotates `SummaryMeta`, does not hard-block) on the legacy path
- [ ] One WORM generation event appended per legacy generation
- [ ] No harness/Temporal/Python code touched or duplicated — confirm via diff review that every changed file is TypeScript inside `packages/applications/src/services/consultation/jobs/processors/`
- [ ] `pnpm lint` clean (including `only-warn` warnings in `packages/applications`)
- [ ] Paste actual command output for each of the above before marking Complete
- [ ] Implementation Summary explicitly notes this code's deletion is owned by TASK-732 (`legacy-migration-deletion`) — restate the D1 staging so a future reader doesn't mistake this floor for a permanent feature

## 6. Risks & Open Questions

- Depends on TASK-704 landing first for the ideal insertion point (the seam); Task 1 provides a fallback (build against `summary.processor.ts` directly) so this ticket is not hard-blocked, but the fallback creates a small future-rework cost when TASK-704 does land — acceptable per D1's staging, flag it rather than hide it.
- The dosage-parity port (Task 4) is a **simplified reimplementation**, not the harness's actual sensor — false negatives/positives relative to the Python original are expected and acceptable for a floor, but should be noted plainly in the Implementation Summary so nobody later assumes parity with `numeric_dose.py`.
- `SummaryMeta` has no dedicated `groundednessScore` column (§2) — Task 5 must reuse whichever existing field the harness path already uses for its groundedness signal rather than adding a new column, to avoid a schema migration for what is explicitly throwaway code; confirm the exact field during Task 5's execution, not assumed here.
- Risk that this floor, once shipped, becomes comfortable enough that the pressure to close TASK-730 (`harness-infra-productionization`) and migrate off legacy (TASK-732) weakens — this is the exact risk `04-target-architecture.md` names explicitly ("the classic one — the 'temporary floor' becomes the permanent product because it is the one that works"). Not an engineering risk this ticket can mitigate in code; worth restating for whoever tracks the Wave 4 gate.

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
