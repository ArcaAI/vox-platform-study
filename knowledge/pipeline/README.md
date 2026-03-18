# Pipeline (`@arcaai/pipeline`)

Pipeline infrastructure for sequential and parallel processing with state management, event system, and orchestration.

## Overview

`@arcaai/pipeline` provides the processing backbone for [`@arcaai/vox`](../agentic-sdk-v2/README.md). It defines two pipeline types — **SequentialPipeline** for ordered stage execution and **ParallelPipeline** for concurrent processing — along with a **PipelineOrchestrator** that coordinates multiple pipelines and manages data flow between them.

In the Agentic SDK, the transcription pipeline (Audio → NoiseFilter → VAD → STT) is sequential, while the knowledge pipeline (Transcription → NER + SpellCheck + Summarization) is parallel.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    PipelineOrchestrator                        │
│                                                               │
│  ┌──────────────────────────┐  ┌───────────────────────────┐ │
│  │  SequentialPipeline      │  │  ParallelPipeline         │ │
│  │  "transcription"         │  │  "knowledge"              │ │
│  │                          │  │                           │ │
│  │  Stage 1: NoiseFilter    │  │  Stage A: NER (auto)     │ │
│  │      │                   │  │  Stage B: SpellCheck (m.) │ │
│  │  Stage 2: VAD            │──│  Stage C: Summary (m.)   │ │
│  │      │                   │  │                           │ │
│  │  Stage 3: STT            │  │  (auto = runs on input)  │ │
│  │      │                   │  │  (m. = manually triggered)│ │
│  │  Output: Transcription   │  │                           │ │
│  └──────────────────────────┘  └───────────────────────────┘ │
│                                                               │
│  connect('transcription', 'knowledge', { autoExecute: true }) │
└──────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @arcaai/pipeline
```

## API Reference

### PipelineStage

Abstract base class for implementing pipeline stages.

```typescript
import { PipelineStage } from '@arcaai/pipeline';

class TransformStage extends PipelineStage<string, number> {
  constructor() {
    super('transform');
  }

  protected async onExecute(input: string): Promise<number> {
    return parseInt(input, 10);
  }
}
```

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `name` | `string` (readonly) | Stage name |
| `config` | `StageConfig` | Stage configuration |
| `execute(input, context)` | `(TInput, PipelineContext) => Promise<TOutput>` | Execute the stage |
| `canExecute?(input, context)` | `(TInput, PipelineContext) => boolean` | Optional validation |
| `init?()` | `() => Promise<void>` | Optional initialization |
| `destroy?()` | `() => Promise<void>` | Optional cleanup |
| `onEnable?()` | `() => Promise<void>` | Called when enabled |
| `onDisable?()` | `() => Promise<void>` | Called when disabled |

### StageConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Whether the stage is enabled |
| `priority` | `number` | `0` | Execution order (lower = earlier) |
| `timeout` | `number?` | — | Timeout in ms |
| `retry` | `RetryConfig?` | — | Retry configuration |
| `options` | `Record?` | — | Custom stage options |

### RetryConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxRetries` | `number` | — | Maximum retry attempts |
| `retryDelayMs` | `number` | — | Delay between retries (ms) |
| `exponentialBackoff` | `boolean?` | `false` | Use exponential backoff |

---

### SequentialPipeline

Executes stages in order, passing the output of each stage as input to the next.

```typescript
import { SequentialPipeline, PipelineStage } from '@arcaai/pipeline';

const pipeline = new SequentialPipeline<AudioData, string>('transcription');
pipeline.addStage(noiseFilterStage, { priority: 10 });
pipeline.addStage(vadStage, { priority: 20 });
pipeline.addStage(sttStage, { priority: 30 });

const transcription = await pipeline.execute(audioData);
```

| Method | Type | Description |
|--------|------|-------------|
| `addStage(stage, options?)` | `(IPipelineStage, Partial<StageConfig>?) => void` | Add a stage |
| `removeStage(name)` | `(string) => void` | Remove a stage by name |
| `execute(input, context?)` | `(TInput, Partial<PipelineContext>?) => Promise<TOutput>` | Run the pipeline |
| `pause()` | `() => void` | Pause execution |
| `resume()` | `() => void` | Resume execution |
| `cancel()` | `() => void` | Cancel execution |
| `reset()` | `() => void` | Reset to initial state |
| `getState()` | `() => PipelineState` | Get current state |
| `on(event, listener)` | See event system | Subscribe to events |
| `off(event, listener)` | See event system | Unsubscribe |

---

### ParallelPipeline

Executes stages concurrently. Stages can be auto-triggered or manually triggered.

```typescript
import { ParallelPipeline } from '@arcaai/pipeline';

const pipeline = new ParallelPipeline<string, unknown>('knowledge');

pipeline.addStage(nerStage, { required: true, triggerMode: 'auto' });
pipeline.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });
pipeline.addStage(summarizationStage, { required: false, triggerMode: 'manual' });

const result = await pipeline.execute(transcription);

await pipeline.triggerStage('spell-check');
const spellResult = pipeline.getStageResult('spell-check');
```

| Method | Type | Description |
|--------|------|-------------|
| `addStage(stage, options?)` | `(IPipelineStage, { required?, triggerMode? }?) => void` | Add a stage |
| `execute(input)` | `(TInput) => Promise<TOutput>` | Run all auto-triggered stages |
| `triggerStage(name)` | `(string) => Promise<unknown>` | Manually trigger a stage |
| `getStageResult(name)` | `(string) => unknown` | Get result from a completed stage |
| `getState()` | `() => PipelineState` | Get current state |

---

### PipelineOrchestrator

Coordinates multiple pipelines, connects them for data flow, and provides unified state.

```typescript
import { PipelineOrchestrator } from '@arcaai/pipeline';

const orchestrator = new PipelineOrchestrator();

orchestrator.register('transcription', transcriptionPipeline);
orchestrator.register('knowledge', knowledgePipeline);

orchestrator.connect('transcription', 'knowledge', { autoExecute: true });

await orchestrator.init();
await orchestrator.execute('transcription', audioData);

const state = orchestrator.getState();
console.log('Can close:', state.canClose);
```

| Method | Type | Description |
|--------|------|-------------|
| `register(name, pipeline)` | `(string, IPipeline) => void` | Register a pipeline |
| `connect(source, target, options?)` | `(string, string, { autoExecute? }?) => void` | Connect pipeline output to input |
| `init()` | `() => Promise<void>` | Initialize all pipelines |
| `execute(pipeline, input)` | `(string, unknown) => Promise<unknown>` | Execute a pipeline by name |
| `pauseAll()` | `() => void` | Pause all pipelines |
| `canClose()` | `() => boolean` | Whether all pipelines are idle |
| `getState()` | `() => OrchestratorState` | Get unified state |

---

### PipelineState

| Property | Type | Description |
|----------|------|-------------|
| `status` | `PipelineStatus` | `'IDLE' \| 'RUNNING' \| 'PAUSED' \| 'ERROR' \| 'COMPLETED'` |
| `currentStage` | `string?` | Name of the active stage |
| `progress` | `number` | 0–100 progress |
| `error` | `Error?` | Error if status is `ERROR` |
| `lastUpdated` | `number` | Timestamp of last state change |
| `completedStages` | `number` | Number of completed stages |
| `totalStages` | `number` | Total number of stages |

### PipelineContext

Shared context passed through pipeline stages.

| Property | Type | Description |
|----------|------|-------------|
| `runId` | `string` | Unique run identifier |
| `pipelineName` | `string` | Pipeline name |
| `startTime` | `number` | Timestamp |
| `metadata` | `Record<string, unknown>` | Custom metadata |
| `abortSignal` | `AbortSignal?` | Cancellation signal |
| `logger` | `PipelineLogger?` | Logger instance |

### StageResult

| Property | Type | Description |
|----------|------|-------------|
| `output` | `TOutput` | Stage output |
| `durationMs` | `number` | Execution time (ms) |
| `skipped` | `boolean` | Whether the stage was skipped |
| `metadata` | `Record?` | Optional metadata |

---

## Event System

All pipelines emit typed events via the `PipelineEvent` enum.

### PipelineEvent

| Event | Payload | Description |
|-------|---------|-------------|
| `Started` | `{ runId, timestamp }` | Pipeline execution started |
| `Completed` | `{ runId, durationMs, timestamp }` | Pipeline completed |
| `Error` | `{ runId, error, stage?, timestamp }` | Pipeline error |
| `Paused` | `{ runId, timestamp }` | Pipeline paused |
| `Resumed` | `{ runId, timestamp }` | Pipeline resumed |
| `Cancelled` | `{ runId, timestamp }` | Pipeline cancelled |
| `StateChange` | `PipelineState` | State changed |
| `StageStarted` | `{ stageName, durationMs? }` | Stage started |
| `StageCompleted` | `{ stageName, durationMs, result? }` | Stage completed |
| `StageFailed` | `{ stageName, durationMs?, error }` | Stage failed |
| `StageSkipped` | `{ stageName }` | Stage skipped |
| `Data` | `{ type, data, timestamp }` | Data output |

```typescript
import { PipelineEvent } from '@arcaai/pipeline';

pipeline.on(PipelineEvent.Started, ({ runId }) => {
  console.log('Pipeline started:', runId);
});

pipeline.on(PipelineEvent.StageCompleted, ({ stageName, durationMs }) => {
  console.log(`${stageName} completed in ${durationMs}ms`);
});

pipeline.on(PipelineEvent.Error, ({ error, stage }) => {
  console.error(`Error in ${stage}:`, error);
});

pipeline.on(PipelineEvent.StateChange, (state) => {
  console.log('Progress:', state.progress, '%');
});
```

---

## Error Handling

### PipelineErrorCode

| Code | Description |
|------|-------------|
| `STAGE_FAILED` | A stage threw an error |
| `TIMEOUT` | Stage exceeded its timeout |
| `CANCELLED` | Pipeline was cancelled |
| `INVALID_INPUT` | Invalid input to the pipeline |
| `CONFIGURATION_ERROR` | Invalid pipeline configuration |
| `INITIALIZATION_ERROR` | Failed to initialize |
| `NOT_INITIALIZED` | Pipeline not initialized |
| `ALREADY_RUNNING` | Pipeline is already executing |

```typescript
import { PipelineError, PipelineErrorCode } from '@arcaai/pipeline';

try {
  await pipeline.execute(input);
} catch (err) {
  if (err instanceof PipelineError) {
    console.log('Code:', err.code);
    console.log('Stage:', err.stage);
    console.log('Cause:', err.cause);
  }
}
```

## Usage Examples

### Transcription Pipeline (as used by @arcaai/vox)

```typescript
import { SequentialPipeline } from '@arcaai/pipeline';

const transcription = new SequentialPipeline('transcription');

transcription.addStage(noiseFilterStage, { priority: 10 });
transcription.addStage(vadStage, { priority: 20 });
transcription.addStage(sttStage, { priority: 30 });

transcription.on(PipelineEvent.StageCompleted, ({ stageName, durationMs }) => {
  console.log(`${stageName}: ${durationMs}ms`);
});

const text = await transcription.execute(audioData);
```

### Knowledge Pipeline with Manual Triggers

```typescript
import { ParallelPipeline } from '@arcaai/pipeline';

const knowledge = new ParallelPipeline('knowledge');

knowledge.addStage(nerStage, { required: true, triggerMode: 'auto' });
knowledge.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });
knowledge.addStage(summarizationStage, { required: false, triggerMode: 'manual' });

const result = await knowledge.execute(transcription);

await knowledge.triggerStage('spell-check');
await knowledge.triggerStage('summarization');
```

### Orchestrated Pipeline Flow

```typescript
import { PipelineOrchestrator, SequentialPipeline, ParallelPipeline } from '@arcaai/pipeline';

const orchestrator = new PipelineOrchestrator();

orchestrator.register('transcription', transcriptionPipeline);
orchestrator.register('knowledge', knowledgePipeline);
orchestrator.connect('transcription', 'knowledge', { autoExecute: true });

await orchestrator.init();

const transcript = await orchestrator.execute('transcription', audioData);

if (!orchestrator.canClose()) {
  console.log('Waiting for pipelines to complete...');
}
```
