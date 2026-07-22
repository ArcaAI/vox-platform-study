/**
 * @arcaai/pipeline - ParallelPipeline Tests
 *
 * Unit tests for the ParallelPipeline class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParallelPipeline } from '../core/ParallelPipeline.js';
import { PipelineStage } from '../core/PipelineStage.js';
import { PipelineEvent } from '../types/index.js';
import type { PipelineContext, StageConfig } from '../types/index.js';

// Test stage implementations
class ProcessorStage extends PipelineStage<string, string> {
  private suffix: string;
  private delayMs: number;

  constructor(name: string, suffix: string, delayMs = 0, config?: Partial<StageConfig>) {
    super(name, config);
    this.suffix = suffix;
    this.delayMs = delayMs;
  }

  protected async onExecute(input: string): Promise<string> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return input + this.suffix;
  }
}

class FailingStage extends PipelineStage<string, string> {
  constructor(name = 'failing', config?: Partial<StageConfig>) {
    super(name, config);
  }

  protected async onExecute(): Promise<string> {
    throw new Error('Stage failed intentionally');
  }
}

class ConditionalStage extends PipelineStage<string, string> {
  constructor(name = 'conditional') {
    super(name);
  }

  protected async onExecute(input: string): Promise<string> {
    return input.toUpperCase();
  }

  canExecute(input: string): boolean {
    return input.length > 0;
  }
}

describe('ParallelPipeline', () => {
  let pipeline: ParallelPipeline<string, string>;

  beforeEach(() => {
    pipeline = new ParallelPipeline('test-parallel');
  });

  describe('constructor', () => {
    it('should create pipeline with name', () => {
      expect(pipeline.name).toBe('test-parallel');
    });

    it('should have initial IDLE state', () => {
      const state = pipeline.getState();
      expect(state.status).toBe('IDLE');
      expect(state.progress).toBe(0);
    });
  });

  describe('addStage', () => {
    it('should add stage to pipeline', () => {
      const stage = new ProcessorStage('proc', '-processed');
      pipeline.addStage(stage);

      expect(pipeline.getStages()).toHaveLength(1);
      expect(pipeline.getState().totalStages).toBe(1);
    });

    it('should set default options', () => {
      const stage = new ProcessorStage('proc', '-processed');
      pipeline.addStage(stage);

      // Default: required=true, triggerMode='auto'
      expect(stage.config.enabled).toBe(true);
    });

    it('should accept custom options', () => {
      const stage = new ProcessorStage('proc', '-processed');
      pipeline.addStage(stage, {
        required: false,
        triggerMode: 'manual',
        priority: 10,
      });

      expect(pipeline.getStages()).toHaveLength(1);
    });
  });

  describe('removeStage', () => {
    it('should remove stage by name', () => {
      pipeline.addStage(new ProcessorStage('proc1', '-1'));
      pipeline.addStage(new ProcessorStage('proc2', '-2'));

      pipeline.removeStage('proc1');

      expect(pipeline.getStages()).toHaveLength(1);
      expect(pipeline.getStages()[0].name).toBe('proc2');
    });
  });

  describe('getStage', () => {
    it('should return stage by name', () => {
      const stage = new ProcessorStage('proc', '-processed');
      pipeline.addStage(stage);

      expect(pipeline.getStage('proc')).toBe(stage);
    });

    it('should return undefined for non-existent stage', () => {
      expect(pipeline.getStage('nonexistent')).toBeUndefined();
    });
  });

  describe('setTriggerMode', () => {
    it('should update trigger mode for stage', () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));

      pipeline.setTriggerMode('proc', 'manual');

      // Verify internally via execute behavior
    });
  });

  describe('execute', () => {
    it('should execute single stage', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));

      const result = await pipeline.execute('input');

      expect(result.success).toBe(true);
      expect(result.results.size).toBe(1);
      expect(result.results.get('proc')).toBe('input-processed');
    });

    it('should execute multiple stages in parallel', async () => {
      pipeline.addStage(new ProcessorStage('proc1', '-1', 50));
      pipeline.addStage(new ProcessorStage('proc2', '-2', 50));
      pipeline.addStage(new ProcessorStage('proc3', '-3', 50));

      const startTime = Date.now();
      const result = await pipeline.execute('input');
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(result.results.size).toBe(3);
      expect(result.results.get('proc1')).toBe('input-1');
      expect(result.results.get('proc2')).toBe('input-2');
      expect(result.results.get('proc3')).toBe('input-3');

      // Parallel execution should be faster than sequential (150ms)
      expect(duration).toBeLessThan(150);
    });

    it('should skip disabled stages', async () => {
      pipeline.addStage(new ProcessorStage('proc1', '-1'));
      pipeline.addStage(new ProcessorStage('proc2', '-2'));

      await pipeline.setStageEnabled('proc1', false);

      const result = await pipeline.execute('input');

      expect(result.results.size).toBe(1);
      expect(result.results.has('proc1')).toBe(false);
      expect(result.results.get('proc2')).toBe('input-2');
    });

    it('should only execute auto-triggered stages', async () => {
      pipeline.addStage(new ProcessorStage('auto', '-auto'), { triggerMode: 'auto' });
      pipeline.addStage(new ProcessorStage('manual', '-manual'), { triggerMode: 'manual' });

      const result = await pipeline.execute('input');

      expect(result.results.size).toBe(1);
      expect(result.results.get('auto')).toBe('input-auto');
      expect(result.results.has('manual')).toBe(false);
    });

    it('should skip stages when canExecute returns false', async () => {
      const skippedHandler = vi.fn();
      pipeline.on(PipelineEvent.StageSkipped, skippedHandler);

      pipeline.addStage(new ConditionalStage('conditional'));

      const result = await pipeline.execute('');

      expect(result.results.has('conditional')).toBe(false);
      expect(skippedHandler).toHaveBeenCalledWith({ stageName: 'conditional' });
    });

    it('should throw when already running', async () => {
      pipeline.addStage(new ProcessorStage('slow', '-slow', 100));

      const promise1 = pipeline.execute('input1');

      await expect(pipeline.execute('input2')).rejects.toThrow('already running');

      await promise1;
    });
  });

  describe('execute error handling', () => {
    it('should collect errors from failed stages', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));
      pipeline.addStage(new FailingStage('failing'), { required: false });

      const result = await pipeline.execute('input');

      expect(result.results.get('proc')).toBe('input-processed');
      expect(result.errors.has('failing')).toBe(true);
      expect(result.errors.get('failing')?.message).toContain('intentionally');
    });

    it('should fail if required stage fails', async () => {
      pipeline.addStage(new FailingStage('required-failing'), { required: true });

      const result = await pipeline.execute('input');

      expect(result.success).toBe(false);
      expect(result.errors.has('required-failing')).toBe(true);
    });

    it('should succeed if optional stage fails', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));
      pipeline.addStage(new FailingStage('optional-failing'), { required: false });

      const result = await pipeline.execute('input');

      expect(result.success).toBe(true);
      expect(result.results.get('proc')).toBe('input-processed');
      expect(result.errors.has('optional-failing')).toBe(true);
    });
  });

  describe('triggerStage', () => {
    it('should manually trigger a stage', async () => {
      pipeline.addStage(new ProcessorStage('auto', '-auto'), { triggerMode: 'auto' });
      pipeline.addStage(new ProcessorStage('manual', '-manual'), { triggerMode: 'manual' });

      // First execute to set input
      await pipeline.execute('input');

      // Manually trigger
      const result = await pipeline.triggerStage('manual');

      expect(result).toBe('input-manual');
    });

    it('should throw if stage not found', async () => {
      await expect(pipeline.triggerStage('nonexistent')).rejects.toThrow('not found');
    });

    it('should throw if execute not called first', async () => {
      pipeline.addStage(new ProcessorStage('manual', '-manual'), { triggerMode: 'manual' });

      await expect(pipeline.triggerStage('manual')).rejects.toThrow(
        'Pipeline must be executed first'
      );
    });

    it('should throw if stage is disabled', async () => {
      pipeline.addStage(new ProcessorStage('manual', '-manual'), { triggerMode: 'manual' });

      await pipeline.execute('input');
      await pipeline.setStageEnabled('manual', false);

      await expect(pipeline.triggerStage('manual')).rejects.toThrow('disabled');
    });
  });

  describe('getStageResult', () => {
    it('should return result from executed stage', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));

      await pipeline.execute('input');

      expect(pipeline.getStageResult('proc')).toBe('input-processed');
    });

    it('should return undefined for non-executed stage', () => {
      expect(pipeline.getStageResult('nonexistent')).toBeUndefined();
    });
  });

  describe('getStageError', () => {
    it('should return error from failed stage', async () => {
      pipeline.addStage(new FailingStage('failing'), { required: false });

      await pipeline.execute('input');

      expect(pipeline.getStageError('failing')).toBeDefined();
    });

    it('should return undefined for successful stage', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));

      await pipeline.execute('input');

      expect(pipeline.getStageError('proc')).toBeUndefined();
    });
  });

  describe('cancel', () => {
    it('should cancel running pipeline', async () => {
      const cancelledHandler = vi.fn();
      pipeline.on(PipelineEvent.Cancelled, cancelledHandler);

      pipeline.addStage(new ProcessorStage('slow', '-slow', 200));

      const executePromise = pipeline.execute('input');

      await new Promise((r) => setTimeout(r, 50));
      pipeline.cancel();

      // Wait for completion
      await executePromise;

      expect(cancelledHandler).toHaveBeenCalled();
    });

    it('should not cancel when not running', () => {
      const cancelledHandler = vi.fn();
      pipeline.on(PipelineEvent.Cancelled, cancelledHandler);

      pipeline.cancel();

      expect(cancelledHandler).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Cancel must short-circuit in-flight stages.
    // -----------------------------------------------------------------------

    it('should short-circuit in-flight stages on cancel even when stage ignores ctx.abortSignal', async () => {
      class IgnoresAbortStage extends PipelineStage<string, string> {
        protected async onExecute(input: string): Promise<string> {
          await new Promise((r) => setTimeout(r, 5000));
          return `${input}-ignored`;
        }
      }

      pipeline.addStage(new IgnoresAbortStage('ignores'));

      const start = Date.now();
      const promise = pipeline.execute('input');
      setTimeout(() => pipeline.cancel(), 30);

      const result = await promise;
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      expect(result.results.has('ignores')).toBe(false);
      // Pipeline must NOT wait for the 5s timer — race against the abort
      // signal must surface the cancel promptly.
      expect(elapsed).toBeLessThan(500);
    });
  });

  // =========================================================================
  // Per-stage serialization on shared results / errors maps.
  // =========================================================================

  describe('triggerStage concurrency', () => {
    it('should serialize concurrent triggerStage calls on the same stage', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      let totalCalls = 0;

      class CountingStage extends PipelineStage<string, string> {
        protected async onExecute(input: string): Promise<string> {
          totalCalls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return `${input}:${totalCalls}`;
        }
      }

      const counting = new CountingStage('counting');
      pipeline.addStage(counting, { triggerMode: 'manual' });

      // Bootstrap input/context.
      pipeline.addStage(new ProcessorStage('boot', '-boot'), { triggerMode: 'auto' });
      await pipeline.execute('input');

      const N = 50;
      const triggers = Array.from({ length: N }, () => pipeline.triggerStage('counting'));
      const results = await Promise.all(triggers);

      expect(totalCalls).toBe(N);
      expect(maxInFlight).toBe(1);
      expect(results.every((r) => typeof r === 'string' && r!.startsWith('input:'))).toBe(true);
    });

    it('should not corrupt results map when triggerStage runs while execute is in-flight', async () => {
      class FastStage extends PipelineStage<string, string> {
        protected async onExecute(input: string): Promise<string> {
          await new Promise((r) => setTimeout(r, 30));
          return `${input}-fast`;
        }
      }

      class ManualStage extends PipelineStage<string, string> {
        protected async onExecute(input: string): Promise<string> {
          await new Promise((r) => setTimeout(r, 5));
          return `${input}-manual`;
        }
      }

      pipeline.addStage(new FastStage('fast'), { triggerMode: 'auto' });
      pipeline.addStage(new ManualStage('manual'), { triggerMode: 'manual' });

      // Seed input via a first short execute so triggerStage is callable.
      await pipeline.execute('seed');

      const exec = pipeline.execute('payload');
      // Fire a triggerStage during the parallel run — it must not race with
      // execute()'s clearing/setting of the shared maps.
      const triggered = pipeline.triggerStage('manual');

      const [execResult, manualResult] = await Promise.all([exec, triggered]);

      expect(execResult.success).toBe(true);
      expect(execResult.results.get('fast')).toBe('payload-fast');
      expect(manualResult).toBe('payload-manual');
    });
  });

  describe('reset', () => {
    it('should reset pipeline and clear results', async () => {
      pipeline.addStage(new ProcessorStage('proc', '-processed'));

      await pipeline.execute('input');

      pipeline.reset();

      expect(pipeline.getStageResult('proc')).toBeUndefined();
      expect(pipeline.getState().status).toBe('IDLE');
    });
  });

  describe('init and destroy', () => {
    it('should initialize all stages', async () => {
      const stage1 = new ProcessorStage('proc1', '-1');
      const stage2 = new ProcessorStage('proc2', '-2');

      const initSpy1 = vi.spyOn(stage1, 'init');
      const initSpy2 = vi.spyOn(stage2, 'init');

      pipeline.addStage(stage1);
      pipeline.addStage(stage2);

      await pipeline.init();

      expect(initSpy1).toHaveBeenCalled();
      expect(initSpy2).toHaveBeenCalled();
    });

    it('should destroy all stages', async () => {
      const stage1 = new ProcessorStage('proc1', '-1');
      const stage2 = new ProcessorStage('proc2', '-2');

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

      pipeline.addStage(new ProcessorStage('proc', '-processed'));
      await pipeline.execute('input');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          timestamp: expect.any(Number),
        })
      );
    });

    it('should emit Completed event', async () => {
      const handler = vi.fn();
      pipeline.on(PipelineEvent.Completed, handler);

      pipeline.addStage(new ProcessorStage('proc', '-processed'));
      await pipeline.execute('input');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          durationMs: expect.any(Number),
          timestamp: expect.any(Number),
        })
      );
    });

    it('should emit StageCompleted for each successful stage', async () => {
      const handler = vi.fn();
      pipeline.on(PipelineEvent.StageCompleted, handler);

      pipeline.addStage(new ProcessorStage('proc1', '-1'));
      pipeline.addStage(new ProcessorStage('proc2', '-2'));

      await pipeline.execute('input');

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should emit StageFailed for failed stages', async () => {
      const handler = vi.fn();
      pipeline.on(PipelineEvent.StageFailed, handler);

      pipeline.addStage(new FailingStage('failing'), { required: false });

      await pipeline.execute('input');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          stageName: 'failing',
          error: expect.any(Error),
        })
      );
    });
  });
});
