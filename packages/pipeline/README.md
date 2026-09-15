# @arcaai/pipeline — generic staged-processing infrastructure

`packages/pipeline`, npm package `@arcaai/pipeline` (version 3.5.0). Generic,
framework-agnostic pipeline infrastructure for sequential and parallel stage execution with
typed events, state tracking, and orchestration across multiple pipelines. Pure TypeScript with a
single runtime dependency (`eventemitter3`) and no peer dependencies — no React, no browser APIs,
no other `@arcaai` package.

This package is a standalone utility with no in-repo consumers today. `@arcaai/vox` implements
its own `TranscriptionPipeline` and `KnowledgePipeline` directly in
`packages/agentic-sdk-v2/src/core/` — separate, domain-specific implementations that do not build
on this package. Use `@arcaai/pipeline` when you need general-purpose staged processing with
pause/resume/cancel semantics.

## Layout

| Path | What it holds |
|---|---|
| `src/core/PipelineStage.ts` | Abstract stage base (`onInit`/`onExecute`/`onDestroy`) |
| `src/core/SequentialPipeline.ts` | Ordered stage chain, output feeds next input |
| `src/core/ParallelPipeline.ts` | Concurrent stages, auto/manual triggering |
| `src/core/PipelineOrchestrator.ts` | Registers pipelines, connects data flow between them |
| `src/types/` | `PipelineState`, `PipelineContext`, `StageConfig`, `PipelineEvent` (+ map), `IPipeline`, `IPipelineStage` |
| `e2e/` | Playwright config + spec |

## Commands

Run from this directory, or `pnpm --filter @arcaai/pipeline <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup build (ESM `.mjs` + CJS `.cjs` + types) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright tests (runs `pnpm build` first); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

### Defining a stage

Extend `PipelineStage<TInput, TOutput>` and implement `onExecute` (plus optional
`onInit`/`onDestroy`):

```typescript
import { SequentialPipeline, PipelineStage } from '@arcaai/pipeline';

class TransformStage extends PipelineStage<string, number> {
  constructor() {
    super('transform');
  }

  protected async onExecute(input: string): Promise<number> {
    return parseInt(input, 10);
  }
}

const pipeline = new SequentialPipeline<string, number>('my-pipeline');
pipeline.addStage(new TransformStage(), { priority: 10 });

const result = await pipeline.execute('42'); // 42
```

Stage options (`StageConfig`): `enabled`, `priority` (lower runs earlier), `timeout`, `retry`
(`{ maxRetries, retryDelayMs, ... }`), and free-form `options`.

### Parallel pipeline

Stages run concurrently; each is `required` or optional, and triggers `'auto'` (on `execute`) or
`'manual'` (via `triggerStage`):

```typescript
import { ParallelPipeline } from '@arcaai/pipeline';

const pipeline = new ParallelPipeline<string, unknown>('processing');
pipeline.addStage(nerStage, { required: true, triggerMode: 'auto' });
pipeline.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });

const result = await pipeline.execute(inputText); // runs auto stages
await pipeline.triggerStage('spell-check'); // run an optional stage on demand
const spellOutput = pipeline.getStageResult('spell-check');
```

### Orchestrator

Coordinates multiple pipelines and pipes output from one into another:

```typescript
import { PipelineOrchestrator } from '@arcaai/pipeline';

const orchestrator = new PipelineOrchestrator();
orchestrator.register('transcription', transcriptionPipeline);
orchestrator.register('knowledge', knowledgePipeline);
orchestrator.connect('transcription', 'knowledge', { autoExecute: true });

await orchestrator.init();
const transcript = await orchestrator.execute('transcription', audioData);

const state = orchestrator.getState();
console.log('Safe to close:', orchestrator.canClose());
```

`connect` accepts an optional `transform` function applied to the data before it reaches the
target pipeline.

### Events

All pipelines implement `IPipeline` and emit typed events from the `PipelineEvent` enum:
`Started`, `Completed`, `Error`, `Paused`, `Resumed`, `Cancelled`, `StateChange`, `StageStarted`,
`StageCompleted`, `StageFailed`, `StageSkipped`, `Data`.

```typescript
import { PipelineEvent } from '@arcaai/pipeline';

pipeline.on(PipelineEvent.Started, ({ runId }) => console.log('run', runId));
pipeline.on(PipelineEvent.StageCompleted, ({ stageName, durationMs }) => {
  console.log(`${stageName} finished in ${durationMs}ms`);
});
pipeline.on(PipelineEvent.Error, ({ error, stage }) => console.error(stage, error));
```

### Method summary

| Class | Key methods |
|---|---|
| `PipelineStage<TIn, TOut>` | `init()`, `execute(input, context)`, `destroy()`, `enabled`/`initialized` getters; override `onInit`/`onExecute`/`onDestroy` |
| `SequentialPipeline<TIn, TOut>` | `addStage(stage, config?)`, `removeStage(name)`, `getStage(name)`, `execute(input, context?)`, `pause()`, `resume()`, `cancel()`, `reset()`, `init()`, `destroy()`, `getState()` |
| `ParallelPipeline<TIn, TOut>` | Same lifecycle plus `addStage(stage, { required, triggerMode })`, `triggerStage(name)`, `getStageResult(name)` |
| `PipelineOrchestrator` | `register(name, pipeline)`, `unregister(name)`, `connect(source, target, options?)`, `disconnect(source, target)`, `execute(name, input, context?)`, `init()`, `destroy()`, `pauseAll()`, `resumeAll()`, `cancelAll()`, `getState()`, `canClose()` |

Execution context: every run receives a `PipelineContext` (`runId`, `pipelineName`, `startTime`,
`metadata`, optional `abortSignal` and `logger`) that flows through all stages.

### Runtime requirements

None beyond a modern JavaScript runtime. Works in browsers and Node.js; no workers, WASM, or DOM
APIs. Ships ESM (`.mjs`) and CJS (`.cjs`) builds with type declarations.

## Related

- `packages/agentic-sdk-v2/src/core/` — `@arcaai/vox`'s own `TranscriptionPipeline` and
  `KnowledgePipeline`, which do not build on this package.
