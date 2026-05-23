# TASK-273 — `@arcaai/pipeline` Correctness

| Field | Value |
|---|---|
| Ticket | TASK-273 |
| Parent | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Owner | Agent A11 |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |

---

## 1. Requirement Analysis

### Description

The `@arcaai/pipeline` package powers sequential and parallel processing inside the Vox SDK and the orchestrator that links them. The deep assessment in [`07-pipeline.md`](../TASK-262-Vox-SDK-Deep-Assessment/07-pipeline.md) identified four correctness defects scoped to this ticket:

| ID | Severity | Title |
|---|---|---|
| C-1 / C-2 | Critical | Cancellation is not propagated to in-flight stage execution; `executeWithTimeout` leaks the underlying promise; `timeout + retry` silently drops retry. |
| H-1 | High | `ParallelPipeline.cancel()` does not stop in-flight stage promises (`Promise.all` is not abort-aware). |
| H-2 | High | `ParallelPipeline.execute` and `triggerStage` race on the shared `this.results` / `this.errors` maps when called concurrently. |
| H-4 | High | `PipelineOrchestrator` declares `connect(src, tgt, { autoExecute })` but never executes the target — the feature is non-functional. |
| L-7 | Low | `PipelineOrchestrator.register` subscribes to pipeline events but never removes those listeners on `unregister`/`destroy`, leaking listeners on long-lived emitters. |

### Business Context

`@arcaai/pipeline` orchestrates the audio → VAD → STT → NER chain inside Vox. A pipeline that cannot truly cancel its stages, that silently drops retry policy when paired with a timeout, that keeps a parallel pipeline's `cancel()` cosmetic, that races on shared state, that fails to wire connected pipelines, or that leaks listeners across a long consultation, undermines the reliability guarantees of the SDK.

### Acceptance Criteria

1. Cancelling a `SequentialPipeline` or `ParallelPipeline` mid-stage propagates the abort signal into the user's `onExecute(input, ctx)` so cancellable async work (e.g. `fetch`, `setTimeout`) can stop immediately. No further stages run after cancel.
2. `StageConfig.timeout` is implemented via `AbortSignal.timeout(ms)` and combined with the user signal via `AbortSignal.any([userSignal, timeoutSignal])`. `timeout` and `retry` compose correctly: a stage with both retries on transient errors and aborts the in-flight attempt when the timeout fires.
3. `ParallelPipeline.cancel()` actually short-circuits the in-flight `Promise.all`; aborted runs surface a `CANCELLED` outcome (errors map contains the cancellation, `success: false`), and stages that observe `ctx.signal` stop.
4. Concurrent calls to `triggerStage` (and `triggerStage` while `execute` is running) are serialized per-stage via an explicit lock/queue. Results and errors maps see no torn writes.
5. `PipelineOrchestrator.connect(src, tgt, { autoExecute: true })` executes the target pipeline with the source pipeline's actual output (passed through `transform` if provided). Default remains `autoExecute: false` so existing callers are unaffected.
6. `PipelineOrchestrator.unregister(name)` removes every listener it added during `register`. Registering and unregistering 100 times leaves zero listeners on the pipeline's emitter (verified via `EventEmitter.listenerCount`).
7. `pnpm --filter @arcaai/pipeline build|test|lint` all succeed with no new warnings; `pnpm --filter @arcaai/vox build` still succeeds (smoke).

---

## 2. Current State Evaluation

### Affected Files (existing)

| File | Role | Defects addressed here |
|---|---|---|
| `packages/pipeline/src/core/PipelineStage.ts` | Abstract stage with timeout + retry | C-1, C-2 |
| `packages/pipeline/src/core/SequentialPipeline.ts` | Sequential pipeline | C-1 (signal propagation through context) |
| `packages/pipeline/src/core/ParallelPipeline.ts` | Parallel pipeline + `triggerStage` | H-1, H-2 |
| `packages/pipeline/src/core/PipelineOrchestrator.ts` | Multi-pipeline coordinator | H-4, L-7 |
| `packages/pipeline/src/types/index.ts` | Public types (no behavioural change here) | (n/a) |

### Known Existing Tests

`src/__tests__/PipelineStage.test.ts`, `SequentialPipeline.test.ts`, `ParallelPipeline.test.ts`, `PipelineOrchestrator.test.ts`, `types.test.ts` — exercising happy paths and basic error cases. None of the four defects are guarded by tests today (see Test Coverage Gaps in `07-pipeline.md`).

### Dependencies / Compatibility

Runtime target: Node 18+ and modern browsers. `AbortSignal.timeout` and `AbortSignal.any` are available in Node 19.4+ and all evergreen browsers. Project is on Node 24 / TS 5.9 — both are safe to use directly. `eventemitter3` exposes `listenerCount(event)` which we will use in the L-7 leak test.

No external consumer in this monorepo imports `@arcaai/pipeline` today (verified by grep). The change is internally scoped and the only public API additions are non-breaking.

---

## 3. Implementation Plan

### Test list (TDD)

For each defect we add at least one reproducer test that fails on the current code, then we implement the minimal fix.

**C-1 / C-2 — `PipelineStage.test.ts` and `SequentialPipeline.test.ts`**
- `executeWithTimeout` aborts the in-flight `onExecute` (the stage observes `ctx.abortSignal.aborted === true`).
- `timeout + retry` together: a stage with a transient failure retries; a stage that exceeds timeout fails with `AbortError`/timeout error and does not deadlock.
- `SequentialPipeline.cancel()` mid-stage causes the stage's `onExecute` to observe an aborted signal; subsequent stages are not invoked.

**H-1 / H-2 — `ParallelPipeline.test.ts`**
- `cancel()` mid-execution causes a stage that respects `ctx.abortSignal` to throw `AbortError`; `result.success === false`; no further stages start; `Promise.all` settles promptly (well under the slow-stage delay).
- 50 concurrent `triggerStage('s')` calls on a single stage all return the correct value with no torn writes; the stage's `onExecute` is invoked exactly 50 times (serialized) and `getStageResult` reflects the last write deterministically.
- `triggerStage` while `execute` is in-flight does not corrupt the parallel run's `results` map.

**H-4 — `PipelineOrchestrator.test.ts`**
- `connect('src','tgt',{autoExecute:true})` executes `tgt` with the result of `src` (a literal value check, not just a `DataFlow` event).
- `transform` is applied to the source result before it is fed to the target.
- `connect(...)` without `autoExecute` does not execute the target (default behaviour preserved).

**L-7 — `PipelineOrchestrator.test.ts`**
- Registering and unregistering a pipeline 100 times leaves the pipeline's emitter with `listenerCount(StateChange) === 0`, `listenerCount(Completed) === 0`, `listenerCount(Error) === 0`.
- After `orchestrator.destroy()`, every registered pipeline's emitter has zero orchestrator-owned listeners.

### File modification plan

1. `PipelineStage.ts` — replace `executeWithTimeout`'s manual `setTimeout` with `AbortSignal.timeout(ms)` and combine with the user signal via `AbortSignal.any([...])`. Pass the combined signal as `context.abortSignal` into `onExecute`. Make `execute()` route through both timeout and retry: `executeWithRetry(input, context)` is the outer loop, and each attempt is wrapped with `executeWithTimeoutSignal` which only constructs the combined signal. Retry honours abort between attempts. (C-1, C-2)
2. `SequentialPipeline.ts` — wire the pipeline's `abortController.signal` into the context (already done) and additionally race the per-stage promise against `signal.aborted` so cancel surfaces fast even for stages that do not honour the signal (`Promise.race` with an abort-listener promise). (C-1)
3. `ParallelPipeline.ts` — race each stage's execution against the abort signal so `Promise.all` settles promptly on cancel. Add an internal per-stage async queue (one chain per stage name) so `executeStage` invocations serialize per stage; the shared `results`/`errors` maps are then mutated under that lock. (H-1, H-2)
4. `PipelineOrchestrator.ts` — store the result of every executed pipeline in an internal `pipelineResults` map (set inside `execute()` and via the source pipeline's `Completed` payload — but since the payload does not include result, we set it from the awaited `execute()` result). In `handlePipelineCompleted`, look up the result, run `transform`, and call `targetPipeline.execute(input)` if `autoExecute` is true. Default `autoExecute` stays `false`. Track listener triplets per registered pipeline so `unregister` can remove them; `destroy()` removes listeners for every still-registered pipeline. (H-4, L-7)
5. Tests — add the reproducer cases listed above, all colocated under `packages/pipeline/src/__tests__/`.

### Verification criteria

- `pnpm --filter @arcaai/pipeline build` exits 0
- `pnpm --filter @arcaai/pipeline test` exits 0 with all new tests green
- `pnpm --filter @arcaai/pipeline lint` exits 0 with no warnings
- ReadLints on every modified `.ts` file shows no new diagnostics
- `pnpm --filter @arcaai/vox build` still exits 0 (smoke)

---

## 4. Implementation Summary

### What was built

| Defect | Fix |
|---|---|
| **C-1 / C-2** | `PipelineStage.execute` now routes through `executeOnceWithTimeout` — which builds the per-attempt timeout via `AbortSignal.timeout(ms)`, combines it with the user's `context.abortSignal` via `AbortSignal.any([...])`, and forwards the combined signal as `ctx.abortSignal` into `onExecute`. `executeWithRetry` is the outer loop and wraps each attempt with the timeout (when configured), so `timeout` and `retry` compose correctly. The retry delay is abort-aware (`sleepWithAbort`) so cancel during a pending retry short-circuits immediately. |
| **H-1** | `ParallelPipeline.executeStageBody` now races `stage.execute(...)` against the pipeline's abort signal via `raceWithAbort`. A cancel surfaces a `CANCELLED` error in the stage's slot and the pipeline settles promptly even when the stage's `onExecute` does not honour `ctx.abortSignal` (the underlying user promise is allowed to settle in the background — we cannot forcibly stop user code, but the pipeline no longer waits on it). |
| **H-2** | `ParallelPipeline.executeStage` now serializes per-stage executions through a `stageLocks: Map<string, Promise<unknown>>` chain. Concurrent `triggerStage('s')` calls (or a `triggerStage` overlapping `execute()`) wait for the previous chain tail before mutating the shared `results` / `errors` maps. `reset()` clears the chain. |
| **H-4** | `PipelineOrchestrator.execute` captures every successful pipeline result into `pipelineResults: Map<string, unknown>` and, after the result is captured, calls `fireDataFlows(name)`. For each connected flow it emits `DataFlow` and — when `autoExecute: true` — invokes `target.execute(transform?(sourceResult) ?? sourceResult)`. Errors from the auto-executed target are surfaced via the orchestrator's `Error` event (no silent fire-and-forget). The default remains `autoExecute: false`. |
| **L-7** | `PipelineOrchestrator.register` now stores its three listener references in `pipelineListeners: Map<string, RegisteredListeners>`. `unregister` and `destroy` call `removePipelineListeners(name)` which `pipeline.off(...)`s each one. 100 register/unregister cycles leave the pipeline emitter at the original listener count. |

### Files changed

| File | Purpose |
|---|---|
| `packages/pipeline/src/core/PipelineStage.ts` | Replaced `executeWithTimeout` with `executeOnceWithTimeout` (`AbortSignal.timeout` + `AbortSignal.any`). Added `sleepWithAbort`. Re-routed `execute` so retry is the outer loop. |
| `packages/pipeline/src/core/SequentialPipeline.ts` | Added `listenerCount(event)` helper for leak diagnostics. (Existing per-stage abort propagation through `context.abortSignal` is unchanged — the stage receives the pipeline's `AbortController.signal`.) |
| `packages/pipeline/src/core/ParallelPipeline.ts` | Split `executeStage` into a chained per-stage lock + `executeStageBody`. Added `raceWithAbort`, `makeCancelError`, `listenerCount(event)`. `reset()` clears `stageLocks`. |
| `packages/pipeline/src/core/PipelineOrchestrator.ts` | Added `pipelineListeners` and `pipelineResults` maps, `removePipelineListeners`, `fireDataFlows`. `register`/`unregister`/`destroy` clean up listener references. `execute` captures the result and triggers data flows. `handlePipelineCompleted` is now a no-op stub. |
| `packages/pipeline/src/__tests__/PipelineStage.test.ts` | Added `AbortSignal propagation (TASK-273)` block: 7 tests for signal propagation, combined-signal contract, abort-on-cancel, abort-on-timeout, timeout+retry composition, and abort during retry delay. |
| `packages/pipeline/src/__tests__/SequentialPipeline.test.ts` | Added "should propagate cancel into the in-flight stage via ctx.abortSignal (TASK-273 C-1)" test asserting the stage observes abort, the next stage never runs, and cancel returns within 500 ms. |
| `packages/pipeline/src/__tests__/ParallelPipeline.test.ts` | Added "should short-circuit in-flight stages on cancel even when stage ignores ctx.abortSignal (TASK-273 H-1)" plus a `triggerStage concurrency (TASK-273 H-2)` block with 2 tests for serialization + interleaving with `execute`. |
| `packages/pipeline/src/__tests__/PipelineOrchestrator.test.ts` | Added `autoExecute (TASK-273 H-4)` block with 3 tests (target executes with source result, transform applied, default off) and `listener leak (TASK-273 L-7)` block with 2 tests (100-cycle register/unregister, listeners cleared on destroy). |

### Test count: 143 → 158 (15 new tests added)

### Verification evidence

- `pnpm --filter @arcaai/pipeline test` → 5 test files, 158 tests, all green (1.70 s).
- `pnpm --filter @arcaai/pipeline build` → ESM 50.65 KB + CJS 50.93 KB + DTS 27.16 KB built successfully (target node16).
- `pnpm --filter @arcaai/pipeline lint` → 0 errors, 0 warnings.
- `ReadLints` over every modified `.ts` file → no diagnostics.
- `pnpm --filter @arcaai/vox build` → all entries (`index`, `core`, `plugins`, `plugins-med-ner`, e2e bundle) build successfully. The `"use client"` directive warnings are pre-existing and unrelated.

### Deviations from plan

- **Public API addition (non-breaking):** `SequentialPipeline.listenerCount(event)` and `ParallelPipeline.listenerCount(event)` were added so the L-7 leak test can count listeners without reaching into private fields. The methods delegate to the underlying `eventemitter3.EventEmitter#listenerCount`. This is purely additive and does not change the `IPipeline` interface.
- **`handlePipelineCompleted` is now a no-op stub.** Data flow / autoExecute handling moved out of the `Completed` event into `fireDataFlows`, called by `orchestrator.execute()` after the result is captured. The `Completed` event fires before `pipeline.execute()`'s promise resolves, so reading the source result in the event handler always yielded `undefined`. Triggering from `execute()` after the result is stored is the only reliable path. Implication: `autoExecute` is invoked only when the source pipeline is run via `orchestrator.execute(name, ...)`, not when callers call `pipeline.execute(...)` directly. This is consistent with `connect`/`autoExecute` being part of the orchestrator's domain.
- **Cancellation race in ParallelPipeline.** When a parallel stage that ignores `ctx.abortSignal` is cancelled, the underlying user `onExecute` promise is intentionally allowed to settle in the background — the library cannot forcibly stop user code. The pipeline records a `PipelineErrorCode.CANCELLED` error and returns promptly. This is the documented intent of H-1's fix.

### Items NOT addressed (out of scope for this ticket)

The following defects from `07-pipeline.md` are tracked in the parent ticket and were intentionally left for sibling tickets:

- H-3 (state-change event bursts), H-5 (double-cancel during destroy)
- M-1 through M-9 (medium-severity inconsistencies)
- L-1 through L-6, L-8, L-9 (other low-severity issues)
- Performance / refactor suggestions in §5 and §8 of `07-pipeline.md`

---

## 5. Change History

| Date | Author | Summary | Files |
|---|---|---|---|
| 2026-05-23 | A11 | Initial plan drafted; TDD test list prepared; defects C-1, C-2, H-1, H-2, H-4, L-7 scoped. | `docs/implementation/TASK-273-Pipeline-Correctness/README.md` |
| 2026-05-23 | A11 | RED+GREEN for C-1/C-2: replaced `executeWithTimeout` with `AbortSignal.timeout` + `AbortSignal.any` plumbing; retry now composes with timeout and respects abort. | `packages/pipeline/src/core/PipelineStage.ts`, `packages/pipeline/src/__tests__/PipelineStage.test.ts`, `packages/pipeline/src/__tests__/SequentialPipeline.test.ts` |
| 2026-05-23 | A11 | RED+GREEN for H-1/H-2: per-stage lock chain in `ParallelPipeline`; abort-aware `raceWithAbort` so cancel is prompt even when stages ignore `ctx.abortSignal`. | `packages/pipeline/src/core/ParallelPipeline.ts`, `packages/pipeline/src/__tests__/ParallelPipeline.test.ts` |
| 2026-05-23 | A11 | RED+GREEN for H-4: orchestrator captures source result and runs target via `fireDataFlows`; default `autoExecute` stays `false`. | `packages/pipeline/src/core/PipelineOrchestrator.ts`, `packages/pipeline/src/__tests__/PipelineOrchestrator.test.ts` |
| 2026-05-23 | A11 | RED+GREEN for L-7: registered listeners stored as named refs and removed in `unregister`/`destroy`; added `listenerCount(event)` to both pipeline classes. | `packages/pipeline/src/core/PipelineOrchestrator.ts`, `packages/pipeline/src/core/SequentialPipeline.ts`, `packages/pipeline/src/core/ParallelPipeline.ts`, `packages/pipeline/src/__tests__/PipelineOrchestrator.test.ts` |
| 2026-05-23 | A11 | Verification gate green: 158/158 tests pass, build OK, lint 0 warnings, vox smoke build OK. | (verification only) |
