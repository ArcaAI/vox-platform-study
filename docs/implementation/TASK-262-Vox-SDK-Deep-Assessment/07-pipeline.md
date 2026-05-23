# `@arcaai/pipeline` — Exhaustive Code Review

---

## 1. Architecture

### Component Overview

| Class | File | Role |
|---|---|---|
| `PipelineStage<TInput,TOutput>` | `src/core/PipelineStage.ts` | Abstract template-method base; wraps `onExecute` with timeout + retry |
| `SequentialPipeline<TInput,TOutput>` | `src/core/SequentialPipeline.ts` | Ordered stage chain; output[n] → input[n+1]; pause/resume/cancel |
| `ParallelPipeline<TInput,TOutput>` | `src/core/ParallelPipeline.ts` | Fan-out; all auto-stages get same input; collects `Map<name,result>` |
| `PipelineOrchestrator` | `src/core/PipelineOrchestrator.ts` | Registry + lifecycle for N pipelines; optional `connect()` data-flow wiring |

### Design Pattern Comparison

**vs. RxJS observable pipeline**
RxJS uses a push-based, lazy, composable stream where operators (`map`, `mergeMap`, `catchError`) are pure functions chained without classes. Backpressure is handled via `Subject`/`ReplaySubject` and `throttle`. This library is a pull-based, eager, stateful pipeline: once `execute()` is called it runs to completion. There is no lazy composition, no operator tree, and no built-in backpressure.

**vs. WHATWG `TransformStream`**
`TransformStream` implements the Streams API: chunks flow through a readable side, a writable side, and an internal queue with configurable `highWaterMark`. It is inherently streamable and back-pressure-aware. This library executes one atomic request at a time per pipeline instance (guarded by `ALREADY_RUNNING`), with no notion of streaming chunks or a queue.

**vs. Node.js `stream.pipeline`**
Node's pipeline is for streaming data byte-by-byte with back-pressure; each segment is a Transform. This library works on discrete typed values — one call, one result.

**vs. Redux middleware chain**
Redux middleware composes synchronous or async functions left-to-right, passing a `next` thunk. SequentialPipeline is structurally similar (each stage gets "current output", calls stage, receives new output) but encapsulates lifecycle state and events that Redux middleware does not. The typing model is also weaker here (see §4 below).

**vs. pino's `pipeline`**
pino uses Node streams directly. Not comparable.

**Closest analogue**: the library resembles `p-queue` / `p-waterfall` (sequential) and `Promise.allSettled` (parallel) plus an `EventEmitter` layer — but hand-rolled.

---

## 2. Public API

### `PipelineStage<TInput, TOutput>` (abstract)

```
constructor(name, config?)
readonly name: string
config: StageConfig          // mutable (!)
enabled: boolean             // getter
initialized: boolean         // getter
init(): Promise<void>
destroy(): Promise<void>
enable(): Promise<void>
disable(): Promise<void>
execute(input, context): Promise<TOutput>
updateConfig(Partial<StageConfig>): void
canExecute?(input, context): boolean
// protected abstract
onExecute(input, context): Promise<TOutput>
// protected overridable
onInit() / onDestroy() / onEnable?() / onDisable?()
```

### `SequentialPipeline<TInput, TOutput>`

```
constructor(name)
readonly name: string
getState(): PipelineState          // returns shallow clone
addStage(stage, {priority?}): void
removeStage(name): void
getStage(name): IPipelineStage | undefined
getStages(): IPipelineStage[]
setStageEnabled(name, enabled): Promise<void>
execute(input, context?): Promise<TOutput>
pause() / resume() / cancel() / reset()
init() / destroy()
on(event, listener) / off(event, listener)
```

### `ParallelPipeline<TInput, TOutput>`

```
constructor(name)
addStage(stage, {priority?, required?, triggerMode?}): void
removeStage(name): void
getStage / getStages / setStageEnabled / setTriggerMode
execute(input, context?): Promise<ParallelPipelineResult<TOutput>>
triggerStage(name): Promise<TOutput | null>
getStageResult(name): TOutput | undefined
getStageError(name): Error | undefined
pause() / resume()     // no-ops (!)
cancel() / reset()
init() / destroy()
on / off
```

### `PipelineOrchestrator`

```
constructor({logger?})
getState(): OrchestratorState
register(name, pipeline): void
unregister(name): Promise<void>
connect(src, tgt, {transform?, autoExecute?}): void
disconnect(src, tgt): void
getPipeline<TInput,TOutput>(name): IPipeline | undefined
init(): Promise<void>
execute<TInput,TOutput>(name, input, context?): Promise<TOutput>
pauseAll() / resumeAll() / cancelAll() / resetAll()
destroyPipeline(name): Promise<void>
destroy(): Promise<void>
canClose(): boolean
getPendingOperations(): string[]
on / off
```

### Exported Types (public surface)

`PipelineStatus`, `PipelineState`, `PipelineContext`, `PipelineLogger`, `StageResult`, `StageConfig`, `RetryConfig`, `PipelineEvent` (enum), `PipelineEventMap`, `IPipeline`, `IPipelineStage`, `PipelineErrorCode` (enum), `PipelineError`, `OrchestratorState`, `OrchestratorEvent`, `OrchestratorEventMap`, `ParallelPipelineResult`, `ParallelTriggerMode`, `PipelineStageFactory`

---

## 3. Strengths

1. **Typed event map** — `on<K extends PipelineEvent>(event: K, listener: (payload: PipelineEventMap[K]) => void)` gives full compile-time event-payload correlation (types/index.ts:223–225).
2. **Structured error hierarchy** — `PipelineError` wraps `code`, `stage`, and `cause`, enabling typed `catch` discrimination (types/index.ts:275–287).
3. **Lifecycle hooks on stages** — `init/destroy/onEnable/onDisable` allow expensive resource management (ML models, network connections) per stage.
4. **AbortController plumbing** — every `execute()` creates an `AbortController`, attaches it to the context as `abortSignal`, and `cancel()` calls `.abort()` — the signal is at least passed to stages that check for it.
5. **Pause/resume** — The `createPausePromise()` / `waitIfPaused()` pattern is elegant and avoids polling (SequentialPipeline.ts:394–408).
6. **`ParallelPipelineResult`** — returning `{results, errors, success}` as a value (not throw) for the parallel case is the right model; callers don't need try/catch for optional-stage failures.
7. **Shallow state clone on read** — `getState()` returns `{ ...this.state }` so external callers cannot accidentally mutate internal state.
8. **Priority sorting** — stages sort on `addStage` not just at execute time, so `getStages()` always reflects execution order.
9. **No external heavy dependencies** — only `eventemitter3` (3 KB gzipped); the package is lean.
10. **Comprehensive unit tests** — all major paths are covered with realistic stage implementations and time-based tests for pause/cancel.

---

## 4. Defects

### CRITICAL

---

**C-1 — Cancellation is not propagated to the currently-executing stage**

`SequentialPipeline.ts:150–153` — The `abortController.signal.aborted` check happens only at the **top of the loop**, between stages:

```151:153:packages/pipeline/src/core/SequentialPipeline.ts
        if (this.abortController.signal.aborted) {
          throw new PipelineError(PipelineErrorCode.CANCELLED, 'Pipeline was cancelled');
        }
```

If a stage itself takes 10 seconds (e.g. an HTTP call), `cancel()` sets `aborted = true` but the loop body is still awaiting `stage.execute(currentOutput, context)`. The promise won't resolve until the stage finishes. The `abortSignal` **is** passed through `context.abortSignal` (SequentialPipeline.ts:130), but there is no contract forcing stages to check it, and `PipelineStage.executeWithTimeout` does not check the signal either.

**Impact**: on a slow stage, cancel takes as long as the stage takes.

**C-2 — `PipelineStage.executeWithTimeout` leaks the underlying promise and cannot be aborted**

`PipelineStage.ts:131–147`:

```131:146:packages/pipeline/src/core/PipelineStage.ts
  private async executeWithTimeout(input: TInput, context: PipelineContext, timeoutMs: number): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Stage '${this.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.onExecute(input, context)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
```

When the timeout fires, `reject` is called but `this.onExecute()` is **still running**. Its promise is floating — the resolved/rejected value is silently dropped. Any side effects (writes, network requests, state mutations) continue executing after the caller has received the rejection. This is a classic "fire and forget" leak.

Additionally, timeout does **not** compose with retry: `execute()` on line 116 checks `timeout` first and returns early — if timeout is set, retry is **silently skipped**.

```115:125:packages/pipeline/src/core/PipelineStage.ts
    if (this.config.timeout) {
      return this.executeWithTimeout(input, context, this.config.timeout);
    }

    // Apply retry if configured
    if (this.config.retry) {
      return this.executeWithRetry(input, context);
    }
```

If a user sets both `timeout` and `retry`, retry is ignored with no warning.

---

### HIGH

---

**H-1 — `ParallelPipeline.cancel()` does not stop in-flight stage promises**

`ParallelPipeline.ts:309–320`:

```309:319:packages/pipeline/src/core/ParallelPipeline.ts
  cancel(): void {
    if (this.state.status !== 'RUNNING') {
      return;
    }

    this.abortController?.abort();

    this.emit(PipelineEvent.Cancelled, {
      runId: this.currentRunId!,
      timestamp: Date.now(),
    });
  }
```

`Promise.all(autoStages.map(...))` at line 203 is already launched; aborting the controller only signals the context. None of the stages are obligated to check `context.abortSignal`. The `cancel()` event fires but `await executePromise` in tests still resolves after all stages complete (confirmed by the test at `ParallelPipeline.test.ts:319–333` which correctly observes the result is still returned — the cancel is cosmetic here).

**H-2 — `ParallelPipeline.execute()` has a race condition on `this.results` / `this.errors`**

Both `this.results` and `this.errors` are instance-level maps (ParallelPipeline.ts:74–75). `triggerStage` on line 271 also writes to them. If two parallel calls happen (or `triggerStage` fires while `execute` is awaiting), results from different runs can intermingle. While `ALREADY_RUNNING` guards duplicate `execute()` calls (line 161), nothing prevents `triggerStage()` from running concurrently with `execute()`:

```260:275:packages/pipeline/src/core/ParallelPipeline.ts
  async triggerStage(stageName: string): Promise<TOutput | null> {
    ...
    if (!this.currentInput || !this.currentContext) {
      throw new PipelineError(PipelineErrorCode.NOT_INITIALIZED, 'Pipeline must be executed first to set input context');
    }
    ...
    await this.executeStage(entry, this.currentInput, this.currentContext);
    return this.results.get(stageName) ?? null;
```

`this.currentInput` and `this.currentContext` are retained from the last run, so after `execute()` completes and the pipeline is `COMPLETED`, calling `triggerStage()` concurrently from multiple places writes to the same maps.

**H-3 — `updateState` emits `StateChange` synchronously inside stage loops — O(N²) event bursts**

Every single call to `updateState` calls `this.emit(PipelineEvent.StateChange, this.state)` (SequentialPipeline.ts:369–375, ParallelPipeline.ts:441–447). In `SequentialPipeline.execute()`, per-stage loop iterations call `updateState` twice (lines 171–175, 192–194). For N stages that is `2N` `StateChange` events. In `ParallelPipeline.executeStage`, each stage fires one `StateChange` on success (lines 404–407) plus the `StageCompleted` event. With a `PipelineOrchestrator` registered, every `StateChange` on a child pipeline triggers `handlePipelineStateChange → updateState → emit(StateChange)` on the orchestrator (PipelineOrchestrator.ts:409–412), which in turn calls `updateState → Array.from(this.state.pipelines.values()).map(...)` (lines 459–478) on every state change of every pipeline. For M pipelines each with N stages, the orchestrator broadcasts `O(M × N)` state changes.

**H-4 — `PipelineOrchestrator.handlePipelineCompleted` ignores the actual result — `autoExecute` is broken**

```418:440:packages/pipeline/src/core/PipelineOrchestrator.ts
  private handlePipelineCompleted(pipelineName: string, _payload: PipelineEventMap[PipelineEvent.Completed]): void {
    const flows = this.dataFlows.filter((flow) => flow.source === pipelineName);

    for (const flow of flows) {
      if (flow.autoExecute) {
        const targetPipeline = this.pipelines.get(flow.target);
        if (!targetPipeline) continue;

        // Get the result from the source pipeline (stored in results for parallel pipeline)
        // For sequential pipeline, we need to capture the result from the completion event
        // This is a simplified approach - in practice, you'd want to pass the actual result

        this.emit(OrchestratorEvent.DataFlow, {
          ...
        });

        this.logger?.debug(`Data flow triggered: '${flow.source}' -> '${flow.target}'`);
      }
    }
  }
```

The comment at line 429 openly admits this. `autoExecute: true` never actually calls `targetPipeline.execute(...)`. The target pipeline is never started. The `connect()` / `autoExecute` option is documented in both the README and the JSDoc as a key feature, but it is **not implemented**. The `DataFlow` event fires but the target is never executed. The orchestrator test at `PipelineOrchestrator.test.ts:504–530` only asserts the `DataFlow` event was emitted — it never verifies the target pipeline ran.

**H-5 — `destroy()` then calls `reset()` which calls `cancel()` — double-cancel after stages already cleared**

`SequentialPipeline.ts:331–338`:

```331:338:packages/pipeline/src/core/SequentialPipeline.ts
  async destroy(): Promise<void> {
    this.cancel();
    for (const entry of this.stages) {
      await entry.stage.destroy?.();
    }
    this.stages = [];
    this.reset();
  }
```

`reset()` calls `cancel()` again (line 312). The second cancel is a no-op because `status` is already `IDLE`/`ERROR`, but it still fires state checks. More importantly, after `this.stages = []`, `reset()` calls `updateState({ totalStages: this.stages.length })` — updating `totalStages` to 0, which is correct. However, this means `StateChange` events fire after the stage array is already cleared, which can confuse observers.

---

### MEDIUM

---

**M-1 — `StageConfig.config` is mutable public — encapsulation violated**

`IPipelineStage.config: StageConfig` is exposed as a mutable public field (types/index.ts:239). Any caller can directly do `stage.config.enabled = false` without triggering `onDisable()`. `setStageEnabled` on both pipelines bypasses `PipelineStage.disable()` entirely:

```100:109:packages/pipeline/src/core/SequentialPipeline.ts
  async setStageEnabled(stageName: string, enabled: boolean): Promise<void> {
    const entry = this.stages.find((e) => e.stage.name === stageName);
    if (!entry) return;

    if (enabled) {
      await entry.stage.onEnable?.();
    } else {
      await entry.stage.onDisable?.();
    }
    entry.stage.config.enabled = enabled;
  }
```

This bypasses `PipelineStage.enable()`/`disable()` which have the "already in this state" guard. If `onEnable`/`onDisable` is not idempotent on the stage, this will call the hook even if the state is unchanged.

**M-2 — `SequentialPipeline` progress calculation counts enabled-only stages but uses total enabled count, skips don't adjust**

```171:174:packages/pipeline/src/core/SequentialPipeline.ts
        this.updateState({
          currentStage: stage.name,
          progress: Math.round((i / enabledStages.length) * 100),
        });
```

When a stage is skipped via `canExecute`, `i` advances (the `continue` moves to `i+1`) and `completedStages` does not update. So after a skipped stage, `completedStages` lags behind `i`. The final `progress: 100` is only set if execution reaches the success path (line 218) — if an error occurs, progress stays at the last value. States can show e.g. progress=67 with status=ERROR.

**M-3 — `DEFAULT_PIPELINE_STATE` has a static `lastUpdated: Date.now()` baked in at module load**

```39:45:packages/pipeline/src/types/index.ts
export const DEFAULT_PIPELINE_STATE: PipelineState = {
  status: 'IDLE',
  progress: 0,
  lastUpdated: Date.now(),
  completedStages: 0,
  totalStages: 0,
};
```

This is evaluated once when the module is imported. Every pipeline that spreads it (`{ ...DEFAULT_PIPELINE_STATE }`) gets the same stale timestamp. A pipeline created 10 seconds after import will show `lastUpdated` as 10 seconds ago on the initial state. Should be a function: `createDefaultPipelineState(): PipelineState`.

**M-4 — `generateRunId` uses `Date.now()` + short random — collision risk**

```387:389:packages/pipeline/src/core/SequentialPipeline.ts
  private generateRunId(): string {
    return `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
```

`Math.random()` is not cryptographically unique and `Date.now()` has millisecond resolution. In Node.js 18+ (the stated target) `crypto.randomUUID()` is available synchronously and would be better. Under high-frequency calls (e.g., automated orchestration), collisions, while rare, are possible.

**M-5 — `ParallelPipeline.executeStage` progress denominator uses `this.stages.size` (total), not active stage count**

```405:406:packages/pipeline/src/core/ParallelPipeline.ts
        progress: Math.round(((this.results.size + this.errors.size) / this.stages.size) * 100),
```

When stages are disabled or set to `triggerMode: 'manual'`, `autoStages` is a subset of `this.stages`. Progress will never reach 100% if there are disabled/manual stages, because the denominator includes all registered stages.

**M-6 — `ParallelPipeline.cancel()` emits `Cancelled` even if cancellation has no effect**

`cancel()` calls `abortController?.abort()` and immediately emits `PipelineEvent.Cancelled`. Since the in-flight `Promise.all` is not interrupted, all stages will still complete, and the pipeline will end with `status: COMPLETED` — contradicting the `Cancelled` event. Observers may see `Cancelled` then `Completed`.

**M-7 — `OrchestratorState.pipelines` is a `Map` in both stored state and returned state — deep clone inconsistency**

```125:129:packages/pipeline/src/core/PipelineOrchestrator.ts
  getState(): OrchestratorState {
    return {
      ...this.state,
      pipelines: new Map(this.state.pipelines),
    };
  }
```

The `PipelineState` values inside the map are **not** cloned — callers get shared references. If a `PipelineState` object is mutated externally, it mutates the internal state. Compare this to `SequentialPipeline.getState()` which does `{ ...this.state }` (a proper shallow clone), but the orchestrator only clones the Map itself, not its values.

**M-8 — `PipelineOrchestrator.execute` mutates `this.state.pendingOperations` directly**

```274:275:packages/pipeline/src/core/PipelineOrchestrator.ts
      this.state.pendingOperations.push(`${pipelineName}:execute`);
```

Then removes using `filter`:

```282:283:packages/pipeline/src/core/PipelineOrchestrator.ts
      this.state.pendingOperations = this.state.pendingOperations.filter((op) => op !== `${pipelineName}:execute`);
```

The push is a mutation on the internal array. The filter creates a new array. If two concurrent calls to `orchestrator.execute('same-pipeline', ...)` occur (prevented by the `ALREADY_RUNNING` guard on the pipeline, but the orchestrator itself has no concurrency guard), filter would remove **all** entries for that pipeline name, not just one.

**M-9 — `PipelineError.cause` shadows ES2022 `Error.cause` but is typed differently**

```275:287:packages/pipeline/src/types/index.ts
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly stage?: string;
  readonly cause?: Error;
```

The native `Error.cause` (ES2022) is set by passing `{ cause }` to `super(message, { cause })`. Here, `cause` is set as a custom property without calling `super(message, { cause })`. This means `error.cause` on a `PipelineError` will work, but `error instanceof Error` checks won't propagate cause through native tooling, and some stack-trace formatters (e.g., Node.js's built-in `util.inspect`) won't follow the chain.

---

### LOW

---

**L-1 — `IPipeline.pause()` and `IPipeline.resume()` return `void` — callers cannot know if pause succeeded**

```218:219:packages/pipeline/src/types/index.ts
  pause(): void;
  resume(): void;
```

`ParallelPipeline` silently no-ops both. There is no way for a caller to know if pause was ignored. The interface should return `boolean` or throw.

**L-2 — `StageResult<TOutput>` is defined but never used**

`types/index.ts:87–96` defines `StageResult` but no stage, pipeline, or orchestrator returns it. It is dead interface code that misleads about the actual return shape of `execute()`.

**L-3 — `PipelineEvent.Data` is defined but never emitted**

```165:166:packages/pipeline/src/types/index.ts
  /** Data output from pipeline */
  Data = 'data',
```

The corresponding `PipelineEventMap[PipelineEvent.Data]` type exists (line 197) but no pipeline or stage ever calls `this.emit(PipelineEvent.Data, ...)`. Dead event.

**L-4 — `IPipeline` is generic over `TInput, TOutput` but `PipelineOrchestrator` stores `IPipeline<unknown, unknown>`**

```105:106:packages/pipeline/src/core/PipelineOrchestrator.ts
  private pipelines: Map<string, IPipeline<unknown, unknown>> = new Map();
```

Every `register()` call downcasts to `unknown, unknown` (line 140). `getPipeline<TInput, TOutput>` re-casts:

```228:230:packages/pipeline/src/core/PipelineOrchestrator.ts
  getPipeline<TInput, TOutput>(name: string): IPipeline<TInput, TOutput> | undefined {
    return this.pipelines.get(name) as IPipeline<TInput, TOutput> | undefined;
  }
```

This is an unsafe cast — there is no runtime verification that the type parameters match what was registered. A caller can do `orchestrator.getPipeline<string, number>('my-number-pipeline')` when it was registered as `IPipeline<AudioBuffer, Transcript>`.

**L-5 — `PipelineStage.canExecute` is declared both on the interface and as an optional method on the abstract class, creating ambiguity**

`IPipelineStage` (types/index.ts:243) declares `canExecute?` as optional. `PipelineStage` (PipelineStage.ts:238) implements it as an optional method with a default return of `true`. The execute method then checks `if (this.canExecute && !this.canExecute(...))` (PipelineStage.ts:111). However, because the base class always defines the method (even if a stub), `this.canExecute` is always truthy — the short-circuit guard `if (this.canExecute && ...)` is always entered. The optionality is misleading.

**L-6 — `SequentialPipeline.init()` initializes stages sequentially even though they could be parallelized**

```322:326:packages/pipeline/src/core/SequentialPipeline.ts
  async init(): Promise<void> {
    for (const entry of this.stages) {
      await entry.stage.init?.();
    }
  }
```

Stage initialization is independent. Using `Promise.all` would be faster.

**L-7 — `PipelineOrchestrator.register` subscribes to `StateChange` and `Completed` events but never removes those listeners**

```142:155:packages/pipeline/src/core/PipelineOrchestrator.ts
    pipeline.on(PipelineEvent.StateChange, (state) => {
      this.handlePipelineStateChange(name, state);
    });

    pipeline.on(PipelineEvent.Completed, (payload) => {
      this.handlePipelineCompleted(name, payload);
    });

    pipeline.on(PipelineEvent.Error, (payload) => {
      this.handlePipelineError(name, payload);
    });
```

All three listeners are anonymous arrow functions. There is no reference stored to them. When `unregister()` is called (line 172), it calls `destroyPipeline` → `pipeline.destroy()`, which for `SequentialPipeline` clears stages but **does not call `emitter.removeAllListeners()`**. The listeners on the pipeline's EventEmitter remain. If the pipeline object is retained elsewhere after unregistration, these listeners will still fire and call `this.handlePipelineStateChange` on a partially-destroyed orchestrator.

**L-8 — `ParallelPipeline.executeStage` swallows errors from optional stages silently**

```425:427:packages/pipeline/src/core/ParallelPipeline.ts
      if (entry.required) {
        throw error;
      }
```

For non-required stages, the error is placed in `this.errors` but the `executeStage` function returns `void`. The caller (`Promise.all(autoStages.map(...))`) never sees the rejection. This is intentional but combined with the catch block in `execute()` (line 230), if a required stage throws, `execute()` returns `{success: false}` rather than re-throwing — meaning the caller **cannot distinguish** a hard failure from a graceful partial failure unless they check `result.success`.

**L-9 — `PipelineStage.executeWithRetry` does not check `context.abortSignal` between retries**

```152:175:packages/pipeline/src/core/PipelineStage.ts
  private async executeWithRetry(input: TInput, context: PipelineContext): Promise<TOutput> {
    const { maxRetries, retryDelayMs, exponentialBackoff } = this.config.retry!;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.onExecute(input, context);
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = ...;
          await this.sleep(delay);
        }
      }
    }
    throw lastError;
  }
```

If the pipeline is cancelled mid-retry (`abortController.signal.aborted = true`), `executeWithRetry` will happily sleep and retry. The stage is not cancelable mid-retry loop.

---

## 5. Performance

### GC Pressure

- **`updateState` on every stage iteration**: Each call does `this.state = { ...this.state, ...updates, lastUpdated: Date.now() }` (SequentialPipeline.ts:369–374). With N stages, this allocates N+1 new `PipelineState` objects and immediately discards the previous ones. The orchestrator then does the same. For 10 stages with 1 orchestrator: ~20+ object allocations per pipeline run, each triggering an event object allocation for `StateChange`.

- **`emit` per stage**: Each `StageStarted`, `StageCompleted`, `StateChange` etc. allocates a payload object. For a 10-stage sequential pipeline: `Started(1) + StateChange(1) + StageStarted(10) + StateChange(10) + StageCompleted(10) + StateChange(10) + Completed(1) + StateChange(1)` = 44 event emissions with 44 payload objects, per execution.

- **`getStages()` allocates a new array every call** (SequentialPipeline.ts:93–95): `return this.stages.map((e) => e.stage)`. If called in a loop (e.g., orchestrator polling state), this is wasteful. Should be cached or use an iterator.

- **`Array.from(this.stages.values()).map(...)` in `ParallelPipeline`** (lines 129, 199): Two allocations per call.

### Allocations per item

Per `execute()` call on a pipeline with N stages:
- 1 `AbortController` + 1 `AbortSignal`
- 1 `PipelineContext` object
- ~2N+3 `PipelineState` objects (spread-reallocated)
- ~3N+4 event payload objects
- N pause-check no-ops (just an `if` check, cheap)

For `SequentialPipeline` processing high-frequency items (e.g., audio frames), this could be significant. A stateless function composition would allocate 0.

### Sync vs async overhead

All stage execution uses `await`, which always yields to the microtask queue even for synchronous stages. A 5-stage pipeline that does synchronous math (`parseInt`, multiply) still has 5 `await` points, meaning 5 microtask yields. In a tight inner loop this adds latency compared to a synchronous `reduce`.

`performance.now()` is called twice per stage (start + end). This is a trivial syscall but in hot paths can accumulate.

The `sleep()` utility in retry uses `setTimeout` which is macro-task and accurate only to ~4ms in browsers; in Node.js it can be shorter but is still not high-precision.

---

## 6. Test Coverage Gaps

| Area | Gap |
|---|---|
| **Cancellation mid-stage** | No test verifies that a slow stage actually stops (is interrupted) when `cancel()` is called. The existing cancel test (SequentialPipeline.test.ts:349–366) only tests that cancellation is detected **between** stages. |
| **Timeout + retry interaction** | No test for a stage with both `timeout` and `retry` configured — which silently drops retry (C-2 above). |
| **`autoExecute` data flow** | `PipelineOrchestrator.test.ts:504–530` asserts only that the `DataFlow` event fires, not that the target pipeline was actually executed. The feature is broken (H-4) and the test doesn't catch it. |
| **Concurrent `triggerStage` calls** | No test for two concurrent `triggerStage` calls on the same stage writing to `this.results` simultaneously. |
| **Observer cleanup / listener leak** | No test verifies that `unregister()` removes the orchestrator's listeners from the pipeline's emitter. |
| **`ParallelPipeline` cancel semantics** | No test asserts the pipeline state after cancel; the existing test (ParallelPipeline.test.ts:319–333) only checks `cancelledHandler` was called, not that execution actually stopped. |
| **`DEFAULT_PIPELINE_STATE` timestamp staleness** | No test verifies that each pipeline instance gets a fresh `lastUpdated`. |
| **Error state progress** | No test verifies that `progress` is reset or clamped when status becomes `ERROR`. |
| **Retry with abort signal** | No test for retrying a stage while the pipeline is being cancelled. |
| **`PipelineOrchestrator.destroy` emitter state** | No test verifies the orchestrator's emitter has no listeners after `destroy()`. |
| **`init` called twice on orchestrator after re-register** | `initialized` flag (line 257) is never reset to `false` unless `destroy()` is called. No test for the re-init path after unregister + re-register. |
| **`StageResult` usage** | `StageResult` type is never used or tested. |
| **`PipelineEvent.Data` emission** | Never tested because it is never emitted. |

---

## 7. Conformance to Best Practices

### WHATWG Streams / `TransformStream`

Not used. This library does not implement the Streams API. For a healthcare AI pipeline processing audio frames (the actual use case, per `src/index.ts` jsdoc), `TransformStream` would naturally handle backpressure: when STT is slower than VAD output, the readable side buffers with a configurable `highWaterMark`. With the current design, there is no mechanism to slow down the producer — the caller just awaits `execute()` synchronously, which means if this is used in a streaming loop, the caller must manually rate-limit.

### `AbortSignal` everywhere

Partial. `abortSignal` is threaded into `PipelineContext` correctly. However:
- `executeWithTimeout` ignores it entirely — it uses `setTimeout` and does not abort via the signal.
- `executeWithRetry` does not check it between retries.
- No stage base-class helper to check `context.abortSignal?.aborted` before calling `onExecute`.
- `ParallelPipeline`'s in-flight `Promise.all` is not abort-aware.

### Async iterables

Not used. The `IPipeline.execute()` returns a single `Promise<TOutput>`. There is no `AsyncIterable` or `ReadableStream` variant. For streaming use cases (e.g., streaming partial STT results), the current design requires either polling events or waiting for the final output.

### Result type instead of throw

Partial:
- `ParallelPipeline` returns `ParallelPipelineResult<TOutput>` with `success: boolean` — good.
- `SequentialPipeline` throws on any stage failure — not a Result type. Callers need try/catch.
- `PipelineOrchestrator.execute` re-throws — callers need try/catch.
- Inconsistency: parallel failure is a value, sequential failure is an exception.

Recommended: adopt a `Result<T, E>` pattern uniformly or at least document the asymmetry.

### Error wrapping

`PipelineError.cause` is set as a custom property rather than using the ES2022 `super(message, { cause })` constructor option (L-9). This means native cause-chaining (`Error.cause`) is not present in environments that support it.

---

## 8. Refactor / Improvement Suggestions

### 8.1 — Propagate `AbortSignal` into `executeWithTimeout`

```typescript
// PipelineStage.ts
private async executeWithTimeout(
  input: TInput,
  context: PipelineContext,
  timeoutMs: number,
): Promise<TOutput> {
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort('timeout'), timeoutMs);
  // Propagate parent signal to our local controller
  context.abortSignal?.addEventListener('abort', () => ac.abort('cancelled'));

  try {
    return await this.onExecute(input, {
      ...context,
      abortSignal: ac.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
```

Also use `AbortSignal.timeout(ms)` (Node 17+, all modern browsers) to eliminate the manual `setTimeout` entirely:

```typescript
const signal = AbortSignal.any([
  AbortSignal.timeout(timeoutMs),
  ...(context.abortSignal ? [context.abortSignal] : []),
]);
```

### 8.2 — Fix `autoExecute` in orchestrator

`handlePipelineCompleted` needs to capture the actual result and pass it to the target:

```typescript
// PipelineOrchestrator.ts — store results per pipeline
private pipelineResults: Map<string, unknown> = new Map();

// In execute():
const result = await pipeline.execute(input, context);
this.pipelineResults.set(pipelineName, result);
return result as TOutput;

// In handlePipelineCompleted():
for (const flow of flows) {
  if (flow.autoExecute) {
    const target = this.pipelines.get(flow.target);
    if (!target) continue;
    const result = this.pipelineResults.get(flow.source);
    const input = flow.transform ? flow.transform(result) : result;
    this.execute(flow.target, input).catch(...);
  }
}
```

### 8.3 — Fix listener leak in `register`

Store named handler references:

```typescript
private pipelineListeners: Map<string, { stateChange: Function; completed: Function; error: Function }> = new Map();

register(name, pipeline) {
  const stateChange = (state: PipelineState) => this.handlePipelineStateChange(name, state);
  const completed = (p: ...) => this.handlePipelineCompleted(name, p);
  const error = (p: ...) => this.handlePipelineError(name, p);
  this.pipelineListeners.set(name, { stateChange, completed, error });
  pipeline.on(PipelineEvent.StateChange, stateChange);
  ...
}

async unregister(name) {
  const listeners = this.pipelineListeners.get(name);
  if (listeners) {
    const pipeline = this.pipelines.get(name)!;
    pipeline.off(PipelineEvent.StateChange, listeners.stateChange);
    pipeline.off(PipelineEvent.Completed, listeners.completed);
    pipeline.off(PipelineEvent.Error, listeners.error);
    this.pipelineListeners.delete(name);
  }
  ...
}
```

### 8.4 — Replace `DEFAULT_PIPELINE_STATE` constant with a factory

```typescript
// types/index.ts
export const createDefaultPipelineState = (): PipelineState => ({
  status: 'IDLE',
  progress: 0,
  lastUpdated: Date.now(),
  completedStages: 0,
  totalStages: 0,
});
```

### 8.5 — Debounce or batch `StateChange` emissions

For the orchestrator, batch state updates using a microtask flush:

```typescript
private stateChangePending = false;
private scheduleStateUpdate() {
  if (this.stateChangePending) return;
  this.stateChangePending = true;
  queueMicrotask(() => {
    this.stateChangePending = false;
    this.flushState();
  });
}
```

This reduces `O(M×N)` orchestrator events to 1 per microtask batch.

### 8.6 — Use `crypto.randomUUID()` for run IDs

```typescript
private generateRunId(): string {
  return `${this.name}-${crypto.randomUUID()}`;
}
```

### 8.7 — Add `concurrency` option to `ParallelPipeline`

Currently `Promise.all` launches all stages simultaneously. For resource-constrained environments (rate-limited APIs, GPU memory), a `maxConcurrency` option using a semaphore (`p-limit` or hand-rolled) would be valuable:

```typescript
addStage(stage, { ..., concurrencyGroup?: string })
// or
constructor(name, { maxConcurrency?: number })
```

### 8.8 — Make `SequentialPipeline` support async iterables for streaming

```typescript
async *stream(input: TInput, context?: Partial<PipelineContext>): AsyncIterable<unknown> {
  // yield after each stage
  for (const stage of enabledStages) {
    currentOutput = await stage.execute(currentOutput, context);
    yield { stage: stage.name, output: currentOutput };
  }
}
```

### 8.9 — Fix `PipelineError` to use native cause chaining

```typescript
constructor(code: PipelineErrorCode, message: string, options?: { stage?: string; cause?: Error }) {
  super(message, { cause: options?.cause }); // ES2022 native cause
  this.name = 'PipelineError';
  this.code = code;
  this.stage = options?.stage;
  // Remove custom this.cause — use native Error.cause instead
}
```

### 8.10 — Type-safe orchestrator `execute` via registration tokens

To avoid the unsafe `as IPipeline<TInput, TOutput>` cast, use a branded registry pattern:

```typescript
type PipelineToken<TInput, TOutput> = { name: string; __in?: TInput; __out?: TOutput };

register<TInput, TOutput>(token: PipelineToken<TInput, TOutput>, pipeline: IPipeline<TInput, TOutput>): void
execute<TInput, TOutput>(token: PipelineToken<TInput, TOutput>, input: TInput): Promise<TOutput>
```

---