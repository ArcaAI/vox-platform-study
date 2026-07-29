/**
 * @arcaai/pipeline - SequentialPipeline Tests
 *
 * Unit tests for the SequentialPipeline class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SequentialPipeline } from '../core/SequentialPipeline.js';
import { PipelineStage } from '../core/PipelineStage.js';
import { PipelineEvent, PipelineErrorCode } from '../types/index.js';
import type { PipelineContext, StageConfig } from '../types/index.js';

// Test stage implementations
class AddStage extends PipelineStage<number, number> {
  private addValue: number;

  constructor(name: string, addValue: number, config?: Partial<StageConfig>) {
    super(name, config);
    this.addValue = addValue;
  }

  protected async onExecute(input: number): Promise<number> {
    return input + this.addValue;
  }
}

class MultiplyStage extends PipelineStage<number, number> {
  private multiplier: number;

  constructor(name: string, multiplier: number, config?: Partial<StageConfig>) {
    super(name, config);
    this.multiplier = multiplier;
  }

  protected async onExecute(input: number): Promise<number> {
    return input * this.multiplier;
  }
}

class StringToNumberStage extends PipelineStage<string, number> {
  constructor(name = 'string-to-number') {
    super(name);
  }

  protected async onExecute(input: string): Promise<number> {
    return parseInt(input, 10);
  }
}

class FailingStage extends PipelineStage<number, number> {
  constructor(name = 'failing') {
    super(name);
  }

  protected async onExecute(): Promise<number> {
    throw new Error('Stage failed intentionally');
  }
}

class SlowStage extends PipelineStage<number, number> {
  private delayMs: number;

  constructor(name: string, delayMs: number) {
    super(name);
    this.delayMs = delayMs;
  }

  protected async onExecute(input: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return input;
  }
}

class ConditionalStage extends PipelineStage<number, number> {
  constructor(name = 'conditional') {
    super(name);
  }

  protected async onExecute(input: number): Promise<number> {
    return input * 2;
  }

  canExecute(input: number): boolean {
    return input > 0;
  }
}

describe('SequentialPipeline', () => {
  let pipeline: SequentialPipeline<number, number>;

  beforeEach(() => {
    pipeline = new SequentialPipeline('test-pipeline');
  });

  describe('constructor', () => {
    it('should create pipeline with name', () => {
      expect(pipeline.name).toBe('test-pipeline');
    });

    it('should have initial IDLE state', () => {
      const state = pipeline.getState();
      expect(state.status).toBe('IDLE');
      expect(state.progress).toBe(0);
      expect(state.totalStages).toBe(0);
    });
  });

  describe('addStage', () => {
    it('should add stage to pipeline', () => {
      const stage = new AddStage('add', 5);
      pipeline.addStage(stage);

      expect(pipeline.getStages()).toHaveLength(1);
      expect(pipeline.getState().totalStages).toBe(1);
    });

    it('should add multiple stages', () => {
      pipeline.addStage(new AddStage('add1', 1));
      pipeline.addStage(new MultiplyStage('mul', 2));
      pipeline.addStage(new AddStage('add2', 3));

      expect(pipeline.getStages()).toHaveLength(3);
    });

    it('should sort stages by priority', () => {
      pipeline.addStage(new AddStage('low', 1), { priority: 30 });
      pipeline.addStage(new AddStage('high', 2), { priority: 10 });
      pipeline.addStage(new AddStage('medium', 3), { priority: 20 });

      const stages = pipeline.getStages();
      expect(stages[0].name).toBe('high');
      expect(stages[1].name).toBe('medium');
      expect(stages[2].name).toBe('low');
    });
  });

  describe('removeStage', () => {
    it('should remove stage by name', () => {
      pipeline.addStage(new AddStage('add1', 1));
      pipeline.addStage(new AddStage('add2', 2));

      pipeline.removeStage('add1');

      expect(pipeline.getStages()).toHaveLength(1);
      expect(pipeline.getStages()[0].name).toBe('add2');
    });

    it('should handle removing non-existent stage', () => {
      pipeline.addStage(new AddStage('add', 1));
      pipeline.removeStage('nonexistent');
      expect(pipeline.getStages()).toHaveLength(1);
    });
  });

  describe('getStage', () => {
    it('should return stage by name', () => {
      const stage = new AddStage('add', 5);
      pipeline.addStage(stage);

      expect(pipeline.getStage('add')).toBe(stage);
    });

    it('should return undefined for non-existent stage', () => {
      expect(pipeline.getStage('nonexistent')).toBeUndefined();
    });
  });

  describe('setStageEnabled', () => {
    it('should enable stage', async () => {
      const stage = new AddStage('add', 5, { enabled: false });
      pipeline.addStage(stage);

      await pipeline.setStageEnabled('add', true);

      expect(stage.config.enabled).toBe(true);
    });

    it('should disable stage', async () => {
      const stage = new AddStage('add', 5);
      pipeline.addStage(stage);

      await pipeline.setStageEnabled('add', false);

      expect(stage.config.enabled).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute single stage', async () => {
      pipeline.addStage(new AddStage('add', 5));

      const result = await pipeline.execute(10);

      expect(result).toBe(15);
    });

    it('should execute stages sequentially', async () => {
      pipeline.addStage(new AddStage('add', 5), { priority: 10 });
      pipeline.addStage(new MultiplyStage('multiply', 2), { priority: 20 });

      const result = await pipeline.execute(10);

      // (10 + 5) * 2 = 30
      expect(result).toBe(30);
    });

    it('should pass context to stages', async () => {
      const contextReceived: PipelineContext[] = [];

      class ContextCapturingStage extends PipelineStage<number, number> {
        protected async onExecute(input: number, context: PipelineContext): Promise<number> {
          contextReceived.push(context);
          return input;
        }
      }

      pipeline.addStage(new ContextCapturingStage('capture'));

      await pipeline.execute(10, { metadata: { testKey: 'testValue' } });

      expect(contextReceived).toHaveLength(1);
      expect(contextReceived[0].pipelineName).toBe('test-pipeline');
      expect(contextReceived[0].metadata.testKey).toBe('testValue');
    });

    it('should skip disabled stages', async () => {
      pipeline.addStage(new AddStage('add1', 5), { priority: 10 });
      pipeline.addStage(new AddStage('add2', 10), { priority: 20 });
      await pipeline.setStageEnabled('add1', false);

      const result = await pipeline.execute(10);

      // Only add2 runs: 10 + 10 = 20
      expect(result).toBe(20);
    });

    it('should skip stages when canExecute returns false', async () => {
      const skippedHandler = vi.fn();
      pipeline.on(PipelineEvent.StageSkipped, skippedHandler);

      pipeline.addStage(new ConditionalStage('conditional'), { priority: 10 });
      pipeline.addStage(new AddStage('add', 5), { priority: 20 });

      const result = await pipeline.execute(-5);

      // Conditional skipped (input <= 0), add runs: -5 + 5 = 0
      expect(result).toBe(0);
      expect(skippedHandler).toHaveBeenCalledWith({ stageName: 'conditional' });
    });

    it('should throw when pipeline is already running', async () => {
      pipeline.addStage(new SlowStage('slow', 100));

      const promise1 = pipeline.execute(10);

      await expect(pipeline.execute(20)).rejects.toThrow('already running');

      await promise1;
    });

    it('should update state during execution', async () => {
      const states: string[] = [];
      pipeline.on(PipelineEvent.StateChange, (state) => {
        states.push(state.status);
      });

      pipeline.addStage(new AddStage('add', 5));

      await pipeline.execute(10);

      expect(states).toContain('RUNNING');
      expect(states).toContain('COMPLETED');
    });
  });

  describe('execute error handling', () => {
    it('should handle stage failure', async () => {
      const errorHandler = vi.fn();
      pipeline.on(PipelineEvent.Error, errorHandler);

      pipeline.addStage(new FailingStage());

      await expect(pipeline.execute(10)).rejects.toThrow();
      expect(errorHandler).toHaveBeenCalled();
      expect(pipeline.getState().status).toBe('ERROR');
    });

    it('should emit StageFailed event', async () => {
      const stageFailedHandler = vi.fn();
      pipeline.on(PipelineEvent.StageFailed, stageFailedHandler);

      pipeline.addStage(new FailingStage('failing'));

      await expect(pipeline.execute(10)).rejects.toThrow();

      expect(stageFailedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          stageName: 'failing',
          error: expect.any(Error),
        }),
      );
    });
  });

  describe('pause and resume', () => {
    it('should pause running pipeline', async () => {
      pipeline.addStage(new SlowStage('slow1', 50), { priority: 10 });
      pipeline.addStage(new SlowStage('slow2', 50), { priority: 20 });

      const executePromise = pipeline.execute(10);

      await new Promise((r) => setTimeout(r, 25));
      pipeline.pause();

      expect(pipeline.getState().status).toBe('PAUSED');

      pipeline.resume();
      await executePromise;
    });

    it('should not pause when not running', () => {
      pipeline.pause();
      expect(pipeline.getState().status).toBe('IDLE');
    });

    it('should emit Paused and Resumed events', async () => {
      const pausedHandler = vi.fn();
      const resumedHandler = vi.fn();

      pipeline.on(PipelineEvent.Paused, pausedHandler);
      pipeline.on(PipelineEvent.Resumed, resumedHandler);

      pipeline.addStage(new SlowStage('slow', 100));

      const executePromise = pipeline.execute(10);

      await new Promise((r) => setTimeout(r, 25));
      pipeline.pause();
      expect(pausedHandler).toHaveBeenCalled();

      pipeline.resume();
      expect(resumedHandler).toHaveBeenCalled();

      await executePromise;
    });
  });

  describe('cancel', () => {
    it('should cancel running pipeline', async () => {
      const cancelledHandler = vi.fn();
      pipeline.on(PipelineEvent.Cancelled, cancelledHandler);

      // Use multiple slow stages to ensure we can cancel mid-execution
      pipeline.addStage(new SlowStage('slow1', 100), { priority: 10 });
      pipeline.addStage(new SlowStage('slow2', 100), { priority: 20 });
      pipeline.addStage(new SlowStage('slow3', 100), { priority: 30 });

      const executePromise = pipeline.execute(10);

      // Wait for first stage to start, then cancel
      await new Promise((r) => setTimeout(r, 50));
      pipeline.cancel();

      await expect(executePromise).rejects.toThrow('cancelled');
      expect(cancelledHandler).toHaveBeenCalled();
    });

    it('should cancel paused pipeline', async () => {
      // Use multiple slow stages
      pipeline.addStage(new SlowStage('slow1', 100), { priority: 10 });
      pipeline.addStage(new SlowStage('slow2', 100), { priority: 20 });

      const executePromise = pipeline.execute(10);

      await new Promise((r) => setTimeout(r, 50));
      pipeline.pause();
      pipeline.cancel();

      await expect(executePromise).rejects.toThrow('cancelled');
    });

    it('should not cancel when not running', () => {
      pipeline.cancel();
      expect(pipeline.getState().status).toBe('IDLE');
    });

    // -----------------------------------------------------------------------
    // Cancellation propagates into onExecute, no further
    // stages run, cancel returns promptly.
    // -----------------------------------------------------------------------

    it('should propagate cancel into the in-flight stage via ctx.abortSignal', async () => {
      const aborted = vi.fn();
      const stage2OnExecute = vi.fn();

      class CancellableStage extends PipelineStage<number, number> {
        protected async onExecute(input: number, ctx: PipelineContext): Promise<number> {
          return new Promise<number>((resolve, reject) => {
            const id = setTimeout(() => resolve(input), 5000);
            ctx.abortSignal?.addEventListener('abort', () => {
              clearTimeout(id);
              aborted();
              reject(new Error('cancelled inside onExecute'));
            });
          });
        }
      }

      class NeverRunStage extends PipelineStage<number, number> {
        protected async onExecute(input: number, ctx: PipelineContext): Promise<number> {
          stage2OnExecute(input, ctx);
          return input;
        }
      }

      pipeline.addStage(new CancellableStage('cancellable'), { priority: 10 });
      pipeline.addStage(new NeverRunStage('after'), { priority: 20 });

      const start = Date.now();
      const promise = pipeline.execute(1);

      setTimeout(() => pipeline.cancel(), 30);

      await expect(promise).rejects.toThrow();
      const elapsed = Date.now() - start;

      expect(aborted).toHaveBeenCalled();
      expect(stage2OnExecute).not.toHaveBeenCalled();
      // Cancel should be prompt — well under the 5s the stage would otherwise wait for.
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('reset', () => {
    it('should reset pipeline to initial state', async () => {
      pipeline.addStage(new AddStage('add', 5));
      await pipeline.execute(10);

      pipeline.reset();

      const state = pipeline.getState();
      expect(state.status).toBe('IDLE');
      expect(state.progress).toBe(0);
      expect(state.completedStages).toBe(0);
    });
  });

  describe('init and destroy', () => {
    it('should initialize all stages', async () => {
      const stage1 = new AddStage('add1', 1);
      const stage2 = new AddStage('add2', 2);

      const initSpy1 = vi.spyOn(stage1, 'init');
      const initSpy2 = vi.spyOn(stage2, 'init');

      pipeline.addStage(stage1);
      pipeline.addStage(stage2);

      await pipeline.init();

      expect(initSpy1).toHaveBeenCalled();
      expect(initSpy2).toHaveBeenCalled();
    });

    it('should destroy all stages', async () => {
      const stage1 = new AddStage('add1', 1);
      const stage2 = new AddStage('add2', 2);

      const destroySpy1 = vi.spyOn(stage1, 'destroy');
      const destroySpy2 = vi.spyOn(stage2, 'destroy');

      pipeline.addStage(stage1);
      pipeline.addStage(stage2);

      await pipeline.destroy();

      expect(destroySpy1).toHaveBeenCalled();
      expect(destroySpy2).toHaveBeenCalled();
      expect(pipeline.getStages()).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('should emit Started event', async () => {
      const handler = vi.fn();
      pipeline.on(PipelineEvent.Started, handler);

      pipeline.addStage(new AddStage('add', 5));
      await pipeline.execute(10);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          timestamp: expect.any(Number),
        }),
      );
    });

    it('should emit Completed event', async () => {
      const handler = vi.fn();
      pipeline.on(PipelineEvent.Completed, handler);

      pipeline.addStage(new AddStage('add', 5));
      await pipeline.execute(10);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          durationMs: expect.any(Number),
          timestamp: expect.any(Number),
        }),
      );
    });

    it('should emit StageStarted and StageCompleted events', async () => {
      const startedHandler = vi.fn();
      const completedHandler = vi.fn();

      pipeline.on(PipelineEvent.StageStarted, startedHandler);
      pipeline.on(PipelineEvent.StageCompleted, completedHandler);

      pipeline.addStage(new AddStage('add', 5));
      await pipeline.execute(10);

      expect(startedHandler).toHaveBeenCalledWith({ stageName: 'add' });
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          stageName: 'add',
          durationMs: expect.any(Number),
          result: 15,
        }),
      );
    });

    it('should allow unsubscribing from events', async () => {
      const handler = vi.fn();

      pipeline.on(PipelineEvent.Started, handler);
      pipeline.off(PipelineEvent.Started, handler);

      pipeline.addStage(new AddStage('add', 5));
      await pipeline.execute(10);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
