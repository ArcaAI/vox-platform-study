# TASK-284: Vox SDK Typecheck Cleanup — Store + Core Test Fixtures

- **Ticket**: TASK-284
- **Title**: `@arcaai/vox` test-fixture `tsc` cleanup (Wave-2B C3b slice — store + core)
- **Created**: 2026-05-24
- **Updated**: 2026-05-24
- **Status**: Completed
- **Branch**: `fix/2605-review`
- **Parent ticket**: [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md)
- **Related tickets**:
  - [TASK-283 — Vox SDK Typecheck Cleanup, Source Files](../TASK-283-Vox-Typecheck-Cleanup-Source/README.md) (C3a — landed first; this slice fixes the test fixtures that drift against C3a's now-correct source-of-truth types)

## Requirement Analysis

### Description

After [TASK-283](../TASK-283-Vox-Typecheck-Cleanup-Source/README.md) (C3a) corrected the source-of-truth types in `@arcaai/vox`, `pnpm --filter @arcaai/vox typecheck` still reports **127 errors**, all of which are in test files. Wave-2B continues the C-track decomposition with three test-fixture slices running in parallel:

- **C3b (this ticket)** — store + core test fixtures and mocks (12 files / 54 errors).
- **C3c** — hooks `__tests__/` lane.
- **C3d** — barrel-export tests and logger transport tests.

The fixtures in C3b's slice predate several intentional type refinements that landed alongside C3a (or earlier — e.g. `ContextItem` gaining required derived booleans, `SummaryResponse` renaming `consultationId` → `contextItemId` with new required fields, `PipelineStateInfo.status` becoming uppercase enum values, `UserPreferences` losing `theme`, `OpenSessionInput` not accepting `doctorId`, `StreamingSessionResponse` gaining a required `status` field, the `eventemitter3` mock declaring both a `listeners` field and a `listeners(...)` method, etc.). Vitest stays green because the runtime is `esbuild` (no type erasure pass), but `tsc --noEmit` fails.

### Business context

- Pure type-cleanup. **No runtime behaviour change**, no DB change, no API change, no public-API shape change.
- Unblocks Wave-2's "`tsc` is a usable signal again" goal jointly tracked by C3a/C3b/C3c/C3d.
- Tests' *assertions* are intentionally left untouched — only fixture shapes and minimal type narrowings are adjusted so they match the source-of-truth types C3a fixed (per the karpathy "surgical changes" rule).

### Acceptance criteria

1. Test-file errors in the C3b slice (12 files) drop from **54 → 0**.
2. The full-package `pnpm typecheck` count drops by **54** from C3b's contribution alone (C3c/C3d contributions are tracked separately).
3. Vitest must remain **2785/2785 green**.
4. `pnpm --filter @arcaai/vox build` must remain green (esbuild output unchanged).
5. `pnpm --filter @arcaai/vox lint` must remain **0 errors** (13 pre-existing prettier warnings are outside scope).
6. No new dependencies, no `pnpm install`, no destructive git operations, no PR/push.

## Current State Evaluation

### Test-fixture error inventory (pre-fix, 54 in slice)

Captured from `/tmp/c3b-tsc.log` (filtered to C3b's lane only):

| File | Count | Dominant error class | Root cause |
|---|---|---|---|
| `src/store/__tests__/agenticStore.test.ts` | 27 | TS2740 / TS2352 / TS2353 / TS2345 | `ContextItem` gained `source`/`isSummary`/`isTranscript`/`isAiGenerated` + 8 more required derived flags; `SummaryResponse` now requires `contextItemId` (not `consultationId`), `llmProvider`, `modelName`; `PipelineStateInfo.status` is uppercase enum; `UserPreferences` no longer has `theme`; `AudioPluginStates` is a structured `{ noiseFilter, vad, stt }` shape (each `PluginState`, not booleans). |
| `src/core/__tests__/PersonalizationManager.test.ts` | 8 | TS2353 / TS2345 / TS2322 | `UserPreferences` does not have `theme`; `UserPreferencesUpdate` does not accept ad-hoc `test`/`custom: string`; `set`/`get` are keyed by `keyof UserPreferences` / `keyof UserPreferencesUpdate`. |
| `src/store/__tests__/agenticStore.impersonation.test.ts` | 3 | TS2352 | `AgenticState & AgenticActions` does not sufficiently overlap with `Record<string, unknown>` — needs a `as unknown as Record<…>` double-cast (test deliberately probes for absent keys). |
| `src/core/__tests__/sessionUtils.test.ts` | 3 | TS2353 | `OpenSessionInput` has `{ patientId, appointmentDate?, department?, metadata? }` — no `doctorId`. The fixture's extra `doctorId` field was unused by the operation under test. |
| `src/core/__tests__/TranscriptionPipeline.test.ts` | 3 | TS2322 / TS2550 / TS2739 | `vad.location` is `'browser'` (no `'skip'`); `Array.prototype.at` requires `lib: es2022` (use indexed access instead — `tsconfig` lib is out of scope); `updateConfig` typed as `Partial<TranscriptionPipelineConfig>` but the per-stage objects must be the full shape, so partial `{ level: 'high' }` needs an explicit cast. |
| `src/core/__tests__/StreamingSessionManager.test.ts` | 2 | TS2741 | `StreamingSessionResponse` gained a required `status: StreamingSessionStatus` field (TASK-264 era). |
| `src/core/__tests__/SSEClient.leak.test.ts` | 2 | TS2339 | `InstrumentedEventSource` interface forgot to advertise the `simulateOpen()` method that the underlying `MockEventSource` class actually exposes. |
| `src/__tests__/mocks/eventemitter3.mock.ts` | 2 | TS2300 | The mock class declared both a private field named `listeners` *and* a public method named `listeners(event)` — duplicate identifier under the modern `lib.dom` typing. |
| `src/core/__tests__/impersonation-config.test.ts` | 1 | TS2304 | One test calls `vi.fn()` but `vi` was missing from the `import { … } from 'vitest'`. |
| `src/core/__tests__/SSEClient.ticket.test.ts` | 1 | TS2348 | `vi.fn()` without an explicit signature now returns `Mock<Procedure \| Constructable>`, which TypeScript will not let you call as a plain function. |
| `src/core/__tests__/SSEClient.test.ts` | 1 | TS2348 | Same as above. |
| `src/__tests__/integration/pipeline.integration.test.ts` | 1 | TS2345 | `stages` array union-narrowed the `process` parameter to the intersection of `Float32Array` and `{ audio, isSpeech }`, so the per-iteration call needed a structural cast. |
| **Total** | **54** | | |

### Source-of-truth references used

- `src/types/context.ts` — `ContextItem`, `ContextItemType`, `ContextSource`.
- `src/types/summary.ts` — `SummaryResponse` (`contextItemId`, `llmProvider`, `modelName`, `'summary' | 'pre_summary'`).
- `src/types/pipeline.ts` — `PipelineStateInfo`, `PipelineStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'COMPLETED'`; `TranscriptionPipelineConfig.vad.location = 'browser'`.
- `src/types/config.ts` — `UserPreferences`, `UserPreferencesUpdate` (no `theme`, `custom: Record<string, unknown>`).
- `src/types/audio.ts` — `AudioPluginStates = { noiseFilter: PluginState; vad: PluginState; stt: STTPluginState }`.
- `src/types/consultation.ts` — `OpenSessionInput = { patientId; appointmentDate?; department?; metadata? }` (no `doctorId`).
- `src/types/stt-v2.ts` — `StreamingSessionResponse.status: StreamingSessionStatus` (required).

### Out of scope (forwarded to siblings)

- `src/hooks/__tests__/**` → **C3c**.
- `src/core/logger/__tests__/{highlight,loki,otel,utils}.transport.test.ts`, `src/__tests__/exports.task032.test.ts`, `src/__tests__/exports.task279.test.ts`, `src/core/__tests__/plugins.exports.test.ts`, `src/core/__tests__/plugins-med-ner.exports.test.ts`, `src/__tests__/stream-e-types.test.ts`, `src/hooks/__tests__/useArca.api.test.ts` → **C3d**.

## Implementation Plan

### Strategy

Per the karpathy "surgical changes" rule and the task brief: **adjust fixture shapes to match source-of-truth types — never the other way round, and never the assertions**. Where a fixture is *intentionally* minimal (i.e. the test only exercises a handful of fields and the missing properties are irrelevant to the assertion), prefer the double-cast escape hatch `as unknown as Target` — this is the established idiom already used elsewhere in the suite (e.g. `as any` for `'theme'` lookups). Where a fixture *can* be made type-correct with a one-word edit (e.g. `location: 'skip'` → `'browser'` for a disabled VAD whose `mockVAD.init` is asserted NOT to have been called), make it type-correct.

### Per-file changes

| File | Approach |
|---|---|
| `agenticStore.test.ts` | `ContextItem` and `SummaryResponse` literal fixtures rewritten as `… as unknown as ContextItem` / `… as unknown as SummaryResponse` (preserves test intent, no field invented). `PipelineStateInfo` fixtures keep their lowercase `status` strings under `as unknown as PipelineStateInfo` (asserting deep equality with the constant they passed in is what matters, not the enum value). `AudioPluginStates` boolean shorthand cast to the `setAudioPlugins` parameter type. `UserPreferences` `theme` / `language` literals cast to `Record<string, unknown>` to match the test's deliberately loose preferences contract. |
| `PersonalizationManager.test.ts` | `theme` defaults cast `as any`; `manager.get('theme')` reached via `(manager.get as any)`; `updatePreferences({ test: '…' })` and `{ custom: 'value' }` either widened to a valid `Record` shape or `as any`. No assertion edits. |
| `agenticStore.impersonation.test.ts` | `useAgenticStore.getState() as Record<string, unknown>` → `as unknown as Record<string, unknown>` (test deliberately probes for absent keys via `in` operator — TS sufficiently-overlaps check is wrong for that intent). |
| `sessionUtils.test.ts` | Removed the unused `doctorId` field from each `OpenSessionInput` literal (operation under test doesn't read it, so test behaviour is identical). |
| `TranscriptionPipeline.test.ts` | `vad.location: 'skip'` → `'browser'` (matches the source-of-truth type; VAD is `enabled: false` in that case, so init still won't run). `mock.calls.at(-1)?.[0]` → `mock.calls[mock.calls.length - 1]?.[0]` (avoids the `tsconfig.lib: 'es2022'` requirement). `noiseFilter: { level: 'high' }` cast to `TranscriptionPipelineConfig['noiseFilter']` for the partial-merge test. |
| `StreamingSessionManager.test.ts` | Added `status: 'active'` to both `StreamingSessionResponse` fixtures. |
| `SSEClient.leak.test.ts` | Added `simulateOpen: () => void` to the `InstrumentedEventSource` interface so it advertises the method the underlying `MockEventSource` class already implements. |
| `eventemitter3.mock.ts` | Renamed private field `listeners` → `_listeners` (avoids clash with the public `listeners(event)` method that's part of the eventemitter3 public surface). |
| `impersonation-config.test.ts` | Added `vi` to the `vitest` import. |
| `SSEClient.ticket.test.ts` | Typed `eventSourceCtorSpy` as `ReturnType<typeof vi.fn<(url: string, init?: EventSourceInit) => void>>` and instantiated with the matching generic. |
| `SSEClient.test.ts` | Same as ticket-test typing fix for `eventSourceConstructorSpy`. |
| `pipeline.integration.test.ts` | Replaced `stage.process(result as Float32Array)` with `(stage.process as (input: unknown) => Promise<unknown>)(result)` to bypass the union-intersection narrowing the inline array of stages produced. |

### Order

Largest file first (highest signal early), one-shot continuous verification with `pnpm typecheck` after each fix and `pnpm test --run` after each large file.

### Verification

1. `pnpm typecheck` slice count must drop to 0 for the C3b file set.
2. `pnpm test --run` must stay at `2785 passed (2785)`.
3. `pnpm build` must stay green.
4. `pnpm lint` must stay at 0 errors.
5. `ReadLints` on every modified file must report 0 issues.

## Implementation Summary

### Slice metrics

| Metric | Before | After |
|---|---|---|
| C3b slice errors (12 files) | 54 | **0** |
| Full-package errors (`pnpm typecheck`) | 127 (after C3a) | 5 (only `logger/__tests__/otel.transport.test.ts` remains — owned by C3d) |
| Vitest | 2785 passed | **2785 passed** |
| Build | green | **green** |
| Lint | 0 errors, 13 warnings | **0 errors, 13 warnings** (unchanged) |

> Note: the full-package number dropped further than C3b's 54-error contribution because C3c and C3d were running in parallel and landed their fixes during this slice's wall-clock window. The 54-error contribution is reliably attributable to this ticket; the residual drop beyond that belongs to the sibling slices.

### Files changed (13)

| File | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.test.ts` | `ContextItem` / `SummaryResponse` / `PipelineStateInfo` / `AudioPluginStates` / `UserPreferences` fixture shape adjustments. |
| `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.impersonation.test.ts` | `as unknown as Record<string, unknown>` double-cast for "probe-for-absent-key" assertions. |
| `packages/agentic-sdk-v2/src/core/__tests__/PersonalizationManager.test.ts` | `theme` / `test` / `custom: 'value'` cast adjustments for `UserPreferencesUpdate`. |
| `packages/agentic-sdk-v2/src/core/__tests__/sessionUtils.test.ts` | Removed unused `doctorId` from `OpenSessionInput` fixtures. |
| `packages/agentic-sdk-v2/src/core/__tests__/TranscriptionPipeline.test.ts` | VAD `location: 'browser'`, `.at(-1)` → indexed access, partial-noiseFilter cast. |
| `packages/agentic-sdk-v2/src/core/__tests__/StreamingSessionManager.test.ts` | Added required `status: 'active'`. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.leak.test.ts` | `InstrumentedEventSource.simulateOpen` declared. |
| `packages/agentic-sdk-v2/src/__tests__/mocks/eventemitter3.mock.ts` | Renamed `listeners` field → `_listeners`. |
| `packages/agentic-sdk-v2/src/core/__tests__/impersonation-config.test.ts` | Added `vi` import. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.ticket.test.ts` | Typed `eventSourceCtorSpy`. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.test.ts` | Typed `eventSourceConstructorSpy`. |
| `packages/agentic-sdk-v2/src/__tests__/integration/pipeline.integration.test.ts` | Structural cast on `stage.process(...)`. |
| `docs/implementation/TASK-284-Vox-Typecheck-Cleanup-Tests-Store-Core/README.md` | This document. |

### Migrations / API / runtime

- **None.** Type-only, test-only changes. No DB schema, no API contract, no public SDK surface, no published `.d.ts` shape change.

### Deviations from plan

- None. Every error in the slice mapped cleanly to one of the strategies in §"Per-file changes". No source-file edits were needed; no upstream tickets had to be opened.

### Newly-discovered issues (logged, not fixed — out of scope)

- `src/core/__tests__/TranscriptionPipeline.test.ts:240` originally used `Array.prototype.at(-1)`, which requires the `lib: 'es2022'` compiler option. The fix here uses `arr[arr.length - 1]` to avoid touching `tsconfig`. A future ticket could lift the package to ES2022 lib to allow `.at()` again, but that is outside C3b's mandate and would also affect non-test source.
- `src/__tests__/mocks/eventemitter3.mock.ts` declared both a property and method called `listeners`. Renaming the field to `_listeners` is the minimal fix, but the *real* fix would be aligning the mock with eventemitter3 v5's surface (which uses an internal `_events` field). Tracked here only — outside scope.
- Several `setAudioPlugins` / `setPreferences` test fixtures use shorthand booleans / loose `Record`s where the source-of-truth types want structured `PluginState` / `UserPreferences`. The `as unknown as …` double-cast here is the smallest possible change; a future cleanup ticket could rewrite those fixtures to use the rich types (and assert more meaningfully), but that is a test rewrite and is explicitly out of scope per the task brief.

## Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-24 | Initial implementation — C3b slice (store + core test fixtures). 54 → 0 errors in slice. Vitest stays 2785/2785, build green, lint 0 errors. | See "Files changed" above. |
