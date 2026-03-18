# @arcaai/pipeline

Pipeline infrastructure for sequential and parallel processing with state management.

## Features

- **Sequential Pipeline**: Execute stages in order, passing output from one stage to the next
- **Parallel Pipeline**: Execute stages concurrently with manual or automatic triggering
- **Pipeline Orchestrator**: Coordinate multiple pipelines with unified state management
- **Stage Management**: Enable/disable stages, configure timeouts and retries
- **Event System**: Subscribe to pipeline and stage lifecycle events
- **Pause/Resume/Cancel**: Full control over pipeline execution

## Installation

```bash
pnpm add @arcaai/pipeline
```

## Usage

### Sequential Pipeline

```typescript
import { SequentialPipeline, PipelineStage } from '@arcaai/pipeline';

// Create a custom stage
class TransformStage extends PipelineStage<string, number> {
  constructor() {
    super('transform');
  }

  protected async onExecute(input: string): Promise<number> {
    return parseInt(input, 10);
  }
}

// Create pipeline
const pipeline = new SequentialPipeline<string, number>('my-pipeline');
pipeline.addStage(new TransformStage(), { priority: 10 });

// Execute
const result = await pipeline.execute('42');
console.log(result); // 42
```

### Parallel Pipeline

```typescript
import { ParallelPipeline } from '@arcaai/pipeline';

const pipeline = new ParallelPipeline<string, unknown>('processing');

// Add stages with different trigger modes
pipeline.addStage(nerStage, { required: true, triggerMode: 'auto' });
pipeline.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });

// Execute auto stages
const result = await pipeline.execute(inputText);

// Manually trigger optional stages
await pipeline.triggerStage('spell-check');
```

### Pipeline Orchestrator

```typescript
import { PipelineOrchestrator, SequentialPipeline, ParallelPipeline } from '@arcaai/pipeline';

const orchestrator = new PipelineOrchestrator();

// Register pipelines
orchestrator.register('transcription', transcriptionPipeline);
orchestrator.register('knowledge', knowledgePipeline);

// Connect for data flow
orchestrator.connect('transcription', 'knowledge', { autoExecute: true });

// Initialize all
await orchestrator.init();

// Execute
await orchestrator.execute('transcription', audioData);

// Check state
const state = orchestrator.getState();
console.log('Can close:', state.canClose);
```

## Events

```typescript
import { PipelineEvent } from '@arcaai/pipeline';

pipeline.on(PipelineEvent.Started, ({ runId }) => {
  console.log('Pipeline started:', runId);
});

pipeline.on(PipelineEvent.StageCompleted, ({ stageName, durationMs }) => {
  console.log(`Stage ${stageName} completed in ${durationMs}ms`);
});

pipeline.on(PipelineEvent.Error, ({ error, stage }) => {
  console.error(`Error in ${stage}:`, error);
});
```

## API Reference

### PipelineStage

Base class for implementing pipeline stages.

### SequentialPipeline

Executes stages in sequence.

| Method | Description |
|--------|-------------|
| `addStage(stage, options?)` | Add a stage to the pipeline |
| `removeStage(name)` | Remove a stage |
| `execute(input, context?)` | Execute the pipeline |
| `pause()` | Pause execution |
| `resume()` | Resume execution |
| `cancel()` | Cancel execution |
| `reset()` | Reset to initial state |

### ParallelPipeline

Executes stages concurrently.

| Method | Description |
|--------|-------------|
| `addStage(stage, options?)` | Add a stage (with triggerMode) |
| `execute(input)` | Execute auto-triggered stages |
| `triggerStage(name)` | Manually trigger a stage |
| `getStageResult(name)` | Get result from a stage |

### PipelineOrchestrator

Coordinates multiple pipelines.

| Method | Description |
|--------|-------------|
| `register(name, pipeline)` | Register a pipeline |
| `connect(source, target, options?)` | Connect pipelines for data flow |
| `execute(pipeline, input)` | Execute a pipeline |
| `pauseAll()` | Pause all pipelines |
| `canClose()` | Check if safe to close |

## License

MIT
