/**
 * @arcaai/pipeline - PipelineOrchestrator Tests
 *
 * Unit tests for the PipelineOrchestrator class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PipelineOrchestrator,
  OrchestratorEvent,
} from '../core/PipelineOrchestrator.js';
import { SequentialPipeline } from '../core/SequentialPipeline.js';
import { ParallelPipeline } from '../core/ParallelPipeline.js';
import { PipelineStage } from '../core/PipelineStage.js';
import type { PipelineLogger, StageConfig } from '../types/index.js';

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

class FailingStage extends PipelineStage<number, number> {
  protected async onExecute(): Promise<number> {
    throw new Error('Stage failed');
  }
}

describe('PipelineOrchestrator', () => {
  let orchestrator: PipelineOrchestrator;
  let mockLogger: PipelineLogger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    orchestrator = new PipelineOrchestrator({ logger: mockLogger });
  });

  describe('constructor', () => {
    it('should create orchestrator', () => {
      expect(orchestrator).toBeDefined();
    });

    it('should have initial state', () => {
      const state = orchestrator.getState();
      expect(state.initialized).toBe(false);
      expect(state.status).toBe('IDLE');
      expect(state.canClose).toBe(true);
      expect(state.pipelines.size).toBe(0);
    });

    it('should accept logger option', () => {
      const loggerOrchestrator = new PipelineOrchestrator({ logger: mockLogger });
      expect(loggerOrchestrator).toBeDefined();
    });
  });

  describe('register', () => {
    it('should register pipeline', () => {
      const pipeline = new SequentialPipeline<number, number>('test');

      orchestrator.register('test', pipeline);

      expect(orchestrator.getPipeline('test')).toBe(pipeline);
      expect(orchestrator.getState().pipelines.size).toBe(1);
    });

    it('should emit PipelineRegistered event', () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.PipelineRegistered, handler);

      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineName: 'test',
          timestamp: expect.any(Number),
        })
      );
    });

    it('should throw if pipeline already registered', () => {
      const pipeline1 = new SequentialPipeline<number, number>('test');
      const pipeline2 = new SequentialPipeline<number, number>('test');

      orchestrator.register('test', pipeline1);

      expect(() => orchestrator.register('test', pipeline2)).toThrow('already registered');
    });

    it('should log registration', () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("'test' registered"),
        expect.any(Object)
      );
    });
  });

  describe('unregister', () => {
    it('should unregister pipeline', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);

      await orchestrator.unregister('test');

      expect(orchestrator.getPipeline('test')).toBeUndefined();
    });

    it('should emit PipelineUnregistered event', async () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.PipelineUnregistered, handler);

      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);
      await orchestrator.unregister('test');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineName: 'test',
          timestamp: expect.any(Number),
        })
      );
    });

    it('should handle unregistering non-existent pipeline', async () => {
      await orchestrator.unregister('nonexistent');
      // Should not throw
    });
  });

  describe('getPipeline', () => {
    it('should return registered pipeline', () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);

      expect(orchestrator.getPipeline('test')).toBe(pipeline);
    });

    it('should return undefined for non-existent pipeline', () => {
      expect(orchestrator.getPipeline('nonexistent')).toBeUndefined();
    });
  });

  describe('connect', () => {
    it('should connect two pipelines', () => {
      const pipeline1 = new SequentialPipeline<number, number>('source');
      const pipeline2 = new SequentialPipeline<number, number>('target');

      orchestrator.register('source', pipeline1);
      orchestrator.register('target', pipeline2);

      orchestrator.connect('source', 'target');

      // Should not throw
    });

    it('should throw if source pipeline not found', () => {
      const pipeline = new SequentialPipeline<number, number>('target');
      orchestrator.register('target', pipeline);

      expect(() => orchestrator.connect('source', 'target')).toThrow('not found');
    });

    it('should throw if target pipeline not found', () => {
      const pipeline = new SequentialPipeline<number, number>('source');
      orchestrator.register('source', pipeline);

      expect(() => orchestrator.connect('source', 'target')).toThrow('not found');
    });
  });

  describe('disconnect', () => {
    it('should disconnect pipelines', () => {
      const pipeline1 = new SequentialPipeline<number, number>('source');
      const pipeline2 = new SequentialPipeline<number, number>('target');

      orchestrator.register('source', pipeline1);
      orchestrator.register('target', pipeline2);
      orchestrator.connect('source', 'target');

      orchestrator.disconnect('source', 'target');

      // Should not throw
    });
  });

  describe('init', () => {
    it('should initialize all pipelines', async () => {
      const pipeline1 = new SequentialPipeline<number, number>('test1');
      const pipeline2 = new SequentialPipeline<number, number>('test2');

      pipeline1.addStage(new AddStage('add1', 1));
      pipeline2.addStage(new AddStage('add2', 2));

      orchestrator.register('test1', pipeline1);
      orchestrator.register('test2', pipeline2);

      await orchestrator.init();

      expect(orchestrator.getState().initialized).toBe(true);
    });

    it('should emit Initialized event', async () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.Initialized, handler);

      await orchestrator.init();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Number),
        })
      );
    });

    it('should not initialize twice', async () => {
      await orchestrator.init();
      await orchestrator.init();

      expect(mockLogger.info).toHaveBeenCalledTimes(2); // Once for init, once for completed
    });
  });

  describe('execute', () => {
    it('should execute pipeline', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new AddStage('add', 5));

      orchestrator.register('test', pipeline);

      const result = await orchestrator.execute('test', 10);

      expect(result).toBe(15);
    });

    it('should throw if pipeline not found', async () => {
      await expect(orchestrator.execute('nonexistent', 10)).rejects.toThrow('not found');
    });

    it('should track pending operations', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new SlowStage('slow', 100));

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      // Check pending operations during execution
      await new Promise((r) => setTimeout(r, 10));
      expect(orchestrator.getPendingOperations()).toContain('test:execute');

      await executePromise;

      expect(orchestrator.getPendingOperations()).not.toContain('test:execute');
    });

    it('should pass context to pipeline', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      const contextCapture: any[] = [];

      class CapturingStage extends PipelineStage<number, number> {
        protected async onExecute(input: number, context: any): Promise<number> {
          contextCapture.push(context);
          return input;
        }
      }

      pipeline.addStage(new CapturingStage('capture'));
      orchestrator.register('test', pipeline);

      await orchestrator.execute('test', 10, { metadata: { key: 'value' } });

      expect(contextCapture[0].metadata.key).toBe('value');
    });
  });

  describe('pauseAll', () => {
    it('should pause all running pipelines', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new SlowStage('slow', 200));

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      await new Promise((r) => setTimeout(r, 50));
      orchestrator.pauseAll();

      expect(pipeline.getState().status).toBe('PAUSED');

      // Resume to complete
      orchestrator.resumeAll();
      await executePromise;
    });
  });

  describe('resumeAll', () => {
    it('should resume all paused pipelines', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new SlowStage('slow', 200));

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      await new Promise((r) => setTimeout(r, 50));
      orchestrator.pauseAll();
      orchestrator.resumeAll();

      expect(pipeline.getState().status).toBe('RUNNING');

      await executePromise;
    });
  });

  describe('cancelAll', () => {
    it('should cancel all running pipelines', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      // Use multiple slow stages to ensure we can cancel mid-execution
      pipeline.addStage(new SlowStage('slow1', 200), { priority: 10 });
      pipeline.addStage(new SlowStage('slow2', 200), { priority: 20 });
      pipeline.addStage(new SlowStage('slow3', 200), { priority: 30 });

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      await new Promise((r) => setTimeout(r, 50));
      orchestrator.cancelAll();

      await expect(executePromise).rejects.toThrow('cancelled');
    });
  });

  describe('resetAll', () => {
    it('should reset all pipelines', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new AddStage('add', 5));

      orchestrator.register('test', pipeline);
      await orchestrator.execute('test', 10);

      orchestrator.resetAll();

      expect(pipeline.getState().status).toBe('IDLE');
    });
  });

  describe('destroy', () => {
    it('should destroy all pipelines', async () => {
      const pipeline1 = new SequentialPipeline<number, number>('test1');
      const pipeline2 = new SequentialPipeline<number, number>('test2');

      orchestrator.register('test1', pipeline1);
      orchestrator.register('test2', pipeline2);

      await orchestrator.destroy();

      expect(orchestrator.getState().initialized).toBe(false);
      expect(orchestrator.getState().pipelines.size).toBe(0);
    });
  });

  describe('canClose', () => {
    it('should return true when no operations pending', () => {
      expect(orchestrator.canClose()).toBe(true);
    });

    it('should return false when operations pending', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new SlowStage('slow', 200));

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      await new Promise((r) => setTimeout(r, 50));
      expect(orchestrator.canClose()).toBe(false);

      // Let it complete
      await executePromise;
      expect(orchestrator.canClose()).toBe(true);
    });
  });

  describe('state management', () => {
    it('should update overall status to RUNNING when pipeline runs', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new SlowStage('slow', 100));

      orchestrator.register('test', pipeline);

      const executePromise = orchestrator.execute('test', 10);

      await new Promise((r) => setTimeout(r, 10));
      expect(orchestrator.getState().status).toBe('RUNNING');

      await executePromise;
    });

    it('should update overall status to ERROR when pipeline fails', async () => {
      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new FailingStage('fail'));

      orchestrator.register('test', pipeline);

      await expect(orchestrator.execute('test', 10)).rejects.toThrow();

      expect(orchestrator.getState().status).toBe('ERROR');
    });
  });

  describe('events', () => {
    it('should emit StateChange on state updates', async () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.StateChange, handler);

      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new AddStage('add', 5));

      orchestrator.register('test', pipeline);
      await orchestrator.execute('test', 10);

      expect(handler).toHaveBeenCalled();
    });

    it('should emit Error when pipeline errors', async () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.Error, handler);

      const pipeline = new SequentialPipeline<number, number>('test');
      pipeline.addStage(new FailingStage('fail'));

      orchestrator.register('test', pipeline);

      await expect(orchestrator.execute('test', 10)).rejects.toThrow();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          pipeline: 'test',
          timestamp: expect.any(Number),
        })
      );
    });

    it('should allow unsubscribing from events', async () => {
      const handler = vi.fn();

      orchestrator.on(OrchestratorEvent.PipelineRegistered, handler);
      orchestrator.off(OrchestratorEvent.PipelineRegistered, handler);

      const pipeline = new SequentialPipeline<number, number>('test');
      orchestrator.register('test', pipeline);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('data flow', () => {
    it('should emit DataFlow event when connected pipelines complete', async () => {
      const handler = vi.fn();
      orchestrator.on(OrchestratorEvent.DataFlow, handler);

      const pipeline1 = new SequentialPipeline<number, number>('source');
      const pipeline2 = new SequentialPipeline<number, number>('target');

      pipeline1.addStage(new AddStage('add', 5));
      pipeline2.addStage(new MultiplyStage('mul', 2));

      orchestrator.register('source', pipeline1);
      orchestrator.register('target', pipeline2);
      orchestrator.connect('source', 'target', { autoExecute: true });

      await orchestrator.execute('source', 10);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePipeline: 'source',
          targetPipeline: 'target',
          dataType: 'completion',
          timestamp: expect.any(Number),
        })
      );
    });
  });
});
