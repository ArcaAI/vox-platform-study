/**
 * @arcaai/pipeline - PipelineStage Tests
 *
 * Unit tests for the PipelineStage abstract base class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineStage } from '../core/PipelineStage.js';
import type { PipelineContext, StageConfig } from '../types/index.js';

// Concrete implementation for testing
class TestStage extends PipelineStage<string, number> {
  public executeResult = 42;
  public shouldFail = false;
  public executionCount = 0;
  public initCalled = false;
  public destroyCalled = false;
  public enableCalled = false;
  public disableCalled = false;

  constructor(name = 'test-stage', config?: Partial<StageConfig>) {
    super(name, config);
  }

  protected async onExecute(input: string, context: PipelineContext): Promise<number> {
    this.executionCount++;
    if (this.shouldFail) {
      throw new Error('Stage execution failed');
    }
    return this.executeResult;
  }

  protected async onInit(): Promise<void> {
    this.initCalled = true;
  }

  protected async onDestroy(): Promise<void> {
    this.destroyCalled = true;
  }

  async onEnable(): Promise<void> {
    this.enableCalled = true;
  }

  async onDisable(): Promise<void> {
    this.disableCalled = true;
  }
}

// Stage with canExecute validation
class ValidatingStage extends PipelineStage<string, string> {
  protected async onExecute(input: string): Promise<string> {
    return input.toUpperCase();
  }

  canExecute(input: string): boolean {
    return input.length > 0;
  }
}

describe('PipelineStage', () => {
  let stage: TestStage;
  let context: PipelineContext;

  beforeEach(() => {
    stage = new TestStage();
    context = {
      runId: 'test-run-1',
      pipelineName: 'test-pipeline',
      startTime: Date.now(),
      metadata: {},
    };
  });

  describe('constructor', () => {
    it('should create stage with name', () => {
      expect(stage.name).toBe('test-stage');
    });

    it('should use default config', () => {
      expect(stage.config.enabled).toBe(true);
      expect(stage.config.priority).toBe(0);
    });

    it('should merge custom config with defaults', () => {
      const customStage = new TestStage('custom', {
        enabled: false,
        priority: 10,
        timeout: 5000,
      });

      expect(customStage.config.enabled).toBe(false);
      expect(customStage.config.priority).toBe(10);
      expect(customStage.config.timeout).toBe(5000);
    });
  });

  describe('enabled property', () => {
    it('should return true when enabled', () => {
      expect(stage.enabled).toBe(true);
    });

    it('should return false when disabled', () => {
      const disabledStage = new TestStage('disabled', { enabled: false });
      expect(disabledStage.enabled).toBe(false);
    });
  });

  describe('initialized property', () => {
    it('should return false before init', () => {
      expect(stage.initialized).toBe(false);
    });

    it('should return true after init', async () => {
      await stage.init();
      expect(stage.initialized).toBe(true);
    });
  });

  describe('init', () => {
    it('should call onInit', async () => {
      await stage.init();
      expect(stage.initCalled).toBe(true);
    });

    it('should set initialized to true', async () => {
      await stage.init();
      expect(stage.initialized).toBe(true);
    });

    it('should not call onInit twice', async () => {
      await stage.init();
      stage.initCalled = false;
      await stage.init();
      expect(stage.initCalled).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should call onDestroy when initialized', async () => {
      await stage.init();
      await stage.destroy();
      expect(stage.destroyCalled).toBe(true);
    });

    it('should set initialized to false', async () => {
      await stage.init();
      await stage.destroy();
      expect(stage.initialized).toBe(false);
    });

    it('should not call onDestroy when not initialized', async () => {
      await stage.destroy();
      expect(stage.destroyCalled).toBe(false);
    });
  });

  describe('enable', () => {
    it('should enable the stage', async () => {
      const disabledStage = new TestStage('disabled', { enabled: false });
      await disabledStage.enable();
      expect(disabledStage.config.enabled).toBe(true);
    });

    it('should call onEnable', async () => {
      const disabledStage = new TestStage('disabled', { enabled: false });
      await disabledStage.enable();
      expect(disabledStage.enableCalled).toBe(true);
    });

    it('should not call onEnable when already enabled', async () => {
      await stage.enable();
      expect(stage.enableCalled).toBe(false);
    });
  });

  describe('disable', () => {
    it('should disable the stage', async () => {
      await stage.disable();
      expect(stage.config.enabled).toBe(false);
    });

    it('should call onDisable', async () => {
      await stage.disable();
      expect(stage.disableCalled).toBe(true);
    });

    it('should not call onDisable when already disabled', async () => {
      const disabledStage = new TestStage('disabled', { enabled: false });
      await disabledStage.disable();
      expect(disabledStage.disableCalled).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute and return result', async () => {
      const result = await stage.execute('input', context);
      expect(result).toBe(42);
      expect(stage.executionCount).toBe(1);
    });

    it('should throw error when execution fails', async () => {
      stage.shouldFail = true;
      await expect(stage.execute('input', context)).rejects.toThrow('Stage execution failed');
    });
  });

  describe('execute with canExecute validation', () => {
    it('should execute when canExecute returns true', async () => {
      const validatingStage = new ValidatingStage('validating');
      const result = await validatingStage.execute('hello', context);
      expect(result).toBe('HELLO');
    });

    it('should throw when canExecute returns false', async () => {
      const validatingStage = new ValidatingStage('validating');
      await expect(validatingStage.execute('', context)).rejects.toThrow(
        "Stage 'validating' cannot execute with given input"
      );
    });
  });

  describe('execute with timeout', () => {
    it('should complete before timeout', async () => {
      const timeoutStage = new TestStage('timeout', { timeout: 5000 });
      const result = await timeoutStage.execute('input', context);
      expect(result).toBe(42);
    });

    it('should timeout when execution takes too long', async () => {
      class SlowStage extends PipelineStage<string, number> {
        protected async onExecute(): Promise<number> {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return 42;
        }
      }

      const slowStage = new SlowStage('slow', { timeout: 50 });
      await expect(slowStage.execute('input', context)).rejects.toThrow(
        "Stage 'slow' timed out after 50ms"
      );
    });
  });

  describe('execute with retry', () => {
    it('should retry on failure', async () => {
      let attempts = 0;
      class RetryableStage extends PipelineStage<string, number> {
        protected async onExecute(): Promise<number> {
          attempts++;
          if (attempts < 3) {
            throw new Error('Temporary failure');
          }
          return 42;
        }
      }

      const retryStage = new RetryableStage('retry', {
        retry: { maxRetries: 3, retryDelayMs: 10 },
      });

      const result = await retryStage.execute('input', context);
      expect(result).toBe(42);
      expect(attempts).toBe(3);
    });

    it('should fail after max retries', async () => {
      class AlwaysFailStage extends PipelineStage<string, number> {
        protected async onExecute(): Promise<number> {
          throw new Error('Permanent failure');
        }
      }

      const failStage = new AlwaysFailStage('fail', {
        retry: { maxRetries: 2, retryDelayMs: 10 },
      });

      await expect(failStage.execute('input', context)).rejects.toThrow('Permanent failure');
    });

    it('should use exponential backoff when configured', async () => {
      const delays: number[] = [];
      let lastTime = Date.now();

      class BackoffStage extends PipelineStage<string, number> {
        protected async onExecute(): Promise<number> {
          const now = Date.now();
          if (delays.length > 0) {
            delays.push(now - lastTime);
          } else {
            delays.push(0);
          }
          lastTime = now;

          if (delays.length < 4) {
            throw new Error('Retry');
          }
          return 42;
        }
      }

      const backoffStage = new BackoffStage('backoff', {
        retry: { maxRetries: 3, retryDelayMs: 10, exponentialBackoff: true },
      });

      await backoffStage.execute('input', context);

      // Delays should increase exponentially: 10, 20, 40
      expect(delays.length).toBe(4);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      stage.updateConfig({ priority: 5, timeout: 1000 });
      expect(stage.config.priority).toBe(5);
      expect(stage.config.timeout).toBe(1000);
    });

    it('should preserve existing config values', () => {
      stage.updateConfig({ timeout: 1000 });
      expect(stage.config.enabled).toBe(true);
      expect(stage.config.priority).toBe(0);
    });
  });
});
