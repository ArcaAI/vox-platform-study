# TASK-714 — Legacy Generator Safety Floor (Deliberately Capped, DELETED by TASK-732)

> **⚠ READ THIS FIRST — the mechanism described below is NO LONGER LIVE.**
> TASK-732 deleted `summary.processor.ts` (and with it `applyLegacySafetyFloor()`,
> `legacy-dosage-check.util.ts` and their tests) on schedule, together with the legacy
> signable generator the floor existed to cap. **That deletion is this ticket completing,
> not this ticket regressing** — §1 and §7 both stated up front that every line was
> throwaway, sized to the exposure window, and owned by TASK-732's diff.
> The rest of this document is written in the present tense as it was during
> implementation; read it as a historical record. What is live TODAY:
> `SummaryService.approveSummary`'s `signedBeforeAssurance` guard reads `SummaryMeta`
> rows written by the **harness** path only (`harness-internal.service.ts::persistDraft`),
> because the legacy path that used to write them no longer exists.
> Permanence is enforced by
> `packages/applications/src/services/consultation/__tests__/legacy-generator-absent.grep-gate.test.ts`
> assertion #5, which fails if `legacy-dosage-check` / `checkDosageParity` /
> `applyLegacySafetyFloor` ever reappear in live code.

| | |
|---|---|
| **Status** | Completed (superseded) — the floor shipped as designed, served its exposure window, and was DELETED by TASK-732 exactly as D1 planned. Nothing in this ticket is live code today; it is kept as the record of why the floor existed and why its removal is a completion rather than a regression. |
| **Wave** | 1 · **Size** | S |
| **Epic slug** | `legacy-safety-floor` |
| **Depends on** | TASK-704 (`generator-entry-point-seam`) |
| **Design refs** | D1 — Generator end-state: **Staged migration** — "entry-point seam now → capped legacy floor during infra hardening → harness-only, legacy deleted." This ticket IS phase 2 of D1's three-phase plan (`docs/programs/agentic-workflow-platform/design.md` decision log). |
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

*(All were met at implementation time and verified with the output in §7. They are written in
the present tense as of that date; every one of them describes code TASK-732 has since deleted —
see the banner at the top of this file. Do not read a checked box here as a statement about the
tree today.)*

- [x] `pnpm --filter @arcaai/applications test` green, including the new floor tests — 483 files / 9040 tests passed, 4 skipped
- [x] `pnpm --filter @arcaai/applications build` green — clean, no output
- [x] A legacy-generated note now produces a `SummaryMeta` row with `assuranceCompletedAt` set — `signedBeforeAssurance` is no longer vacuously false — unit-tested
- [x] Legacy generation flips `Consultation.status` to `PENDING_REVIEW` (previously left unset) — unit-tested
- [x] Dosage-parity check flags a note whose dose is absent from the transcript, feeding the existing hard-block field (`guardrailDecisions.safety`, which is what `SummaryService.hasSafetyFlag`/`overridingSafetyFlag` actually reads — see §7 for the correction against the ticket's `gateDecision` text) — no new blocking mechanism built; unit-tested
- [x] Groundedness check runs advisory (annotates `SummaryMeta.guardrailDecisions.groundedness`, does not hard-block) on the legacy path — unit-tested
- [x] One WORM generation event appended per legacy generation — unit-tested
- [x] No harness/Temporal/Python code touched or duplicated — `git diff --stat` confirms every changed/added file is TypeScript under `packages/applications/src/services/consultation/jobs/` (one file, `consultation-job.service.module.ts`, is in `jobs/` rather than `jobs/processors/` — DI wiring only, still TypeScript, still this ticket's scope)
- [x] `pnpm --filter @arcaai/applications lint` clean (package-scoped per this session's HARD RULES, not the repo-root `pnpm lint` aggregate) — 0 errors, 183 pre-existing warnings in untouched files, 0 warnings on any file this ticket changed
- [x] Actual command output pasted for each of the above — see §7 Verification
- [x] Implementation Summary explicitly notes this code's deletion is owned by TASK-732 (`legacy-migration-deletion`) — restate the D1 staging so a future reader doesn't mistake this floor for a permanent feature — see §7 opening line

## 6. Risks & Open Questions

- Depends on TASK-704 landing first for the ideal insertion point (the seam); Task 1 provides a fallback (build against `summary.processor.ts` directly) so this ticket is not hard-blocked, but the fallback creates a small future-rework cost when TASK-704 does land — acceptable per D1's staging, flag it rather than hide it.
- The dosage-parity port (Task 4) is a **simplified reimplementation**, not the harness's actual sensor — false negatives/positives relative to the Python original are expected and acceptable for a floor, but should be noted plainly in the Implementation Summary so nobody later assumes parity with `numeric_dose.py`.
- `SummaryMeta` has no dedicated `groundednessScore` column (§2) — Task 5 must reuse whichever existing field the harness path already uses for its groundedness signal rather than adding a new column, to avoid a schema migration for what is explicitly throwaway code; confirm the exact field during Task 5's execution, not assumed here.
- Risk that this floor, once shipped, becomes comfortable enough that the pressure to close TASK-730 (`harness-infra-productionization`) and migrate off legacy (TASK-732) weakens — this is the exact risk `04-target-architecture.md` names explicitly ("the classic one — the 'temporary floor' becomes the permanent product because it is the one that works"). Not an engineering risk this ticket can mitigate in code; worth restating for whoever tracks the Wave 4 gate.

## 7. Implementation Summary

**⚠ This code WAS throwaway and HAS BEEN deleted by TASK-732 (`legacy-migration-deletion`), in the same epic that retired the legacy generator (D1, `design.md`) — exactly as planned.** Everything described in this section existed between its implementation date and TASK-732's deletion; none of it is in the tree today. The §6 "the classic risk" note (that a temporary floor becomes the permanent product) did NOT materialise: the floor was removed on schedule. The description below is preserved verbatim as the record of what the floor did while it was live.

**Task 1 (insertion point).** TASK-704 had already landed by execution time (commit `fc463b6f9` and the wave-0 commit precede this ticket). `NoteGenerationService.generate()` (`packages/applications/src/services/consultation/note-generation/note-generation.service.ts`) is a pure **decision** seam — on `{generator: 'legacy'}` it returns without side effects and `SummaryProcessor.process()` falls through to run its own body starting at line ~126 (post-seam-check). That fall-through body — after the `ContextItem` (RAW_SUMMARY) is created — is exactly the "legacy branch" this ticket targets, confirming §2's Task-1 fallback prediction was unnecessary: the seam and the insertion point are the same code today.

**Tasks 2-6 (the floor itself).** All landed in `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`, inside one new private method `applyLegacySafetyFloor()` called once, right after the `ContextItem` is persisted:
- **SummaryMeta write** — `SummaryMetaFactory.CreateSummaryMeta({ ..., assuranceCompletedAt: new Date() })` → `summaryMetaRepository.create()` (a plain create — the legacy processor runs once per job, so no update-or-create branch was needed, per the ticket's own reasoning). `SummaryService.approveSummary`'s `signedBeforeAssurance` guard (`summary.service.ts:938-939`) now reads a real, non-vacuous `false` for a legacy-generated note instead of the pre-ticket vacuous `false` from `draftMeta === null`.
- **Status flip** — `Consultation.status = ConsultationStatus.PENDING_REVIEW` (never `DRAFT_PENDING_SENSORS` — legacy has no optimistic-delivery phase), mirroring `harness-internal.service.ts:893`'s non-early branch.
- **Dosage-parity check** — new file `legacy-dosage-check.util.ts`, a native-TS, simplified port of `numeric_dose.py`'s `_NUM_UNIT` regex matching (same unit list, same unitless-vs-unit matching rule, same single-digit-integer ignore rule, same "degrade to flagged, never silent-pass" behavior on an empty transcript). Exports `checkDosageParity(noteText, transcriptText) => { flagged, unmatchedTokens }`. **On investigation, the ticket's own Task 4 text ("set `gateDecision = 'FLAG'` to feed `overridingSafetyFlag`") was imprecise against the live code**: `SummaryService.approveSummary`'s hard block reads `SummaryService.hasSafetyFlag(draftMeta)`, which inspects `draftMeta.guardrailDecisions.safety` (or `.SAFETY`), NOT `gateDecision` (`summary.service.ts:940`, `:1127-1133`). The implementation therefore sets `guardrailDecisions.safety = 'FLAG'` (the field the hard block actually reads) on a dosage flag, and ALSO sets `gateDecision = 'FLAG'|'PASS'` for downstream-reader consistency with the harness path — but the wiring into the existing hard block is via `guardrailDecisions.safety`, verified against the real guard logic, not assumed from the ticket text.
- **Groundedness advisory** — `GuardrailGroundednessTool` (`live-tool-registry.ts`) reused directly, not re-implemented: a private `getGroundednessTool()` lazily constructs one from the processor's own already-injected `httpService`/`secretsService` (mirrors `LiveDocumentationService`'s constructor wiring of the same class) when no test double is supplied. `SummaryMeta` has no dedicated `groundednessScore` column (confirmed in §2), so the verdict is stored at `guardrailDecisions.groundedness = { verdict, checkedAt }` — a sibling key to `.safety`, never touching it, so an `unverified`/`ungrounded` verdict is annotation-only and cannot itself trip the hard block (unit-tested).
- **WORM event** — `HarnessAuditService.append({ action: HarnessAuditAction.GENERATE, ... })`, wrapped in try/catch (best-effort — an audit failure never fails an already-succeeded generation job, matching the codebase's established best-effort audit pattern).
- **Module wiring** — `HarnessAuditServiceModule` added to `ConsultationJobServiceModule`'s imports (`consultation-job.service.module.ts`); `SummaryMetaRepository` needed no new wiring — it is already exported by the already-imported `CoreDatabaseModule`. Both are injected into `SummaryProcessor` as trailing `@Optional() @Inject(...)` params (existing file convention), so pre-ticket test fixtures that construct `SummaryProcessor` with fewer positional args keep compiling and simply skip the floor.

**Deliberately NOT done / deferred, stated plainly:**
- **No DB transaction wrapping** the `ContextItem` create + `SummaryMeta` create + status update, despite §4 Task 3's conditional suggestion. Rationale: (a) local infra is down — a transaction boundary added here could not be exercised against a live Prisma client in this session; (b) the rest of this processor's pre-existing writes (e.g. the `ContextItem` create itself) are already non-transactional against the job's other side effects, so this floor is not introducing a NEW atomicity gap relative to the file's existing posture, only failing to close a pre-existing one; (c) this is throwaway code (TASK-732 deletes it) sized to the exposure window, not a permanent atomicity guarantee. **Flagging, not hiding**: a crash between the `ContextItem` create and the `SummaryMeta` create would still reproduce a (rarer, crash-window-only) version of the original vacuous-guard bug. Worth a follow-up only if TASK-732 slips significantly.
- **Dosage-parity is a simplified reimplementation, not parity** with `numeric_dose.py` — same acknowledged in §6. Notable divergence found during implementation: the Python original's captured unit text is NOT plural-normalized (a note's "30 days" and a transcript's "30 day" would mismatch on unit even though a human reads them as equivalent) — the TS port reproduces this exactly rather than "fixing" it, since fixing it would be non-parity in the OTHER direction and isn't in scope.
- Per §1 out of scope: no harness sensor suite, no multi-stage gate, no MCP terminology validation, no change to `pipeline.harnessEnabled`'s default. Confirmed via `git diff --stat` that every changed/added file is TypeScript under `packages/applications/src/services/consultation/jobs/processors/` or its module — no harness/Temporal/Python file was touched.

**Files changed:**
- `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` (modified — +175/-1)
- `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` (modified — +4, imports `HarnessAuditServiceModule`)
- `packages/applications/src/services/consultation/jobs/processors/legacy-dosage-check.util.ts` (new)
- `packages/applications/src/services/consultation/jobs/processors/__tests__/legacy-dosage-check.util.test.ts` (new)
- `packages/applications/src/services/consultation/jobs/processors/__tests__/summary.processor.summary-meta-floor.test.ts` (new)

**Verification — actual command output:**

TDD RED (confirmed before implementation), dosage util:
```
$ pnpm --filter @arcaai/applications test -- legacy-dosage-check
Error: Cannot find module '../legacy-dosage-check.util' imported from .../legacy-dosage-check.util.test.ts
 Test Files  1 failed | 480 passed | 1 skipped (482)
```

TDD RED (confirmed before implementation), processor floor:
```
$ pnpm --filter @arcaai/applications test -- summary-meta-floor
6 failed (TypeError: Cannot read properties of undefined (reading '0') / AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times)
 Test Files  1 failed | 481 passed | 1 skipped (483)
```

GREEN after implementation:
```
$ pnpm --filter @arcaai/applications test
 Test Files  483 passed | 1 skipped (484)
      Tests  9040 passed | 4 skipped (9044)
```

Build:
```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(no output — clean)
```

Typecheck:
```
$ pnpm --filter @arcaai/applications typecheck
> tsc --noEmit
(no output — clean)
```

Lint (scoped to touched files):
```
$ pnpm --filter @arcaai/applications lint
✖ 183 problems (0 errors, 183 warnings)
```
All 183 warnings are pre-existing, in files this ticket never touched (`eslint-comments/require-description` on unrelated services). Grepping the lint output for every file this ticket changed (`summary.processor.ts`, `legacy-dosage-check.util.ts`, `summary-meta-floor.test.ts`, `legacy-dosage-check.util.test.ts`, `consultation-job.service.module.ts`) returns zero matches — no new warnings or errors introduced.

**Gated (not run, per the task's HARD RULES — local infra is down):**
- No live-DB integration test exercising `SummaryMetaRepository.create`/`ConsultationRepository.update`/`HarnessAuditService.append` against a real Postgres instance — all verification above is unit-level with mocked repositories/services.
- No live call to a running Guardrail service to exercise `GuardrailGroundednessTool`'s real HTTP path — verified only via a mocked tool double; the tool's own fail-closed behavior (never throws, degrades to `unverified`) is pre-existing and untouched by this ticket.
- No migrations were needed (`SummaryMeta`'s existing columns cover everything this floor writes — `guardrailDecisions` JSON absorbs both the dosage flag and the groundedness verdict, per §2/§6's confirmation that no new column was needed), so the shadow-DB migration-authoring workflow in `02-database-prisma.md` does not apply here.
- `pnpm api:build` / `apps/api` e2e were not run — out of this ticket's package scope (`@arcaai/applications` only); no `apps/api` file was touched.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-17 | **Closed out as superseded.** Recorded that TASK-732 DELETED this floor BY DESIGN — `summary.processor.ts` (with `applyLegacySafetyFloor()`), `legacy-dosage-check.util.ts` and both test files are gone from the tree, along with the legacy signable generator they capped. That is D1 phase 3 completing, not a regression: §1/§7 always designated this code throwaway and named TASK-732 as its owner. Verified on the live tree: `packages/applications/src/services/consultation/jobs/processors/` contains neither `summary.processor.ts` nor `legacy-dosage-check.util.ts`, and `legacy-generator-absent.grep-gate.test.ts` assertion #5 now fails the build if `legacy-dosage-check` / `checkDosageParity` / `applyLegacySafetyFloor` reappear in live code. Added a top-of-file banner and re-tensed the §5/§7 wording that read as though the mechanism were still live (it is not — `signedBeforeAssurance` is now fed only by the harness path's `SummaryMeta` write). Status: Review → Completed (superseded). No code changed by this entry. | Claude (TASK-710/714 session) |
| 2026-08-16 | Implemented: SummaryMeta write + status flip + dosage-parity check (native TS, `legacy-dosage-check.util.ts`) + groundedness advisory (reused `GuardrailGroundednessTool`) + WORM `GENERATE` event, all inside `SummaryProcessor.applyLegacySafetyFloor()`. TDD RED confirmed for both the dosage util and the processor floor before implementation; full `@arcaai/applications` suite green after (483 files / 9040 tests). Build, typecheck, lint all clean with zero new warnings. DB transaction wrapping deliberately deferred — see §7 "Deliberately NOT done". Status → Review. | Claude (T2 execution session) |
