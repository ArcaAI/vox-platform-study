/**
 * @arcaai/room - BaseTextProcessor Tests
 *
 * Comprehensive tests for the abstract BaseTextProcessor class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseTextProcessor, type TextProcessorOptions } from '../processors/BaseTextProcessor.js';
import { ProcessorStatus } from '../processors/types.js';
import { ProcessorEvent } from '../events/ProcessorEvents.js';

// ============================================================================
// Test Implementation
// ============================================================================

/**
 * Concrete implementation of BaseTextProcessor for testing.
 */
class TestTextProcessor extends BaseTextProcessor<string, { result: string }> {
  public onInitCalled = false;
  public onDestroyCalled = false;
  public onEnableCalled = false;
  public onDisableCalled = false;
  public shouldThrowOnInit = false;
  public shouldThrowOnProcess = false;
  public initError: Error | null = null;
  public processError: Error | null = null;
  public lastInput: string | null = null;

  constructor(name = 'test-text-processor') {
    super(name);
  }

  protected async onInit(_options?: TextProcessorOptions): Promise<void> {
    this.onInitCalled = true;
    if (this.shouldThrowOnInit || this.initError) {
      throw this.initError || new Error('Init failed');
    }
  }

  protected async onProcess(input: string): Promise<{ result: string }> {
    this.lastInput = input;
    if (this.shouldThrowOnProcess || this.processError) {
      throw this.processError || new Error('Process failed');
    }
    return { result: `processed: ${input}` };
  }

  protected async onDestroy(): Promise<void> {
    this.onDestroyCalled = true;
  }

  protected override async onEnable(): Promise<void> {
    this.onEnableCalled = true;
  }

  protected override async onDisable(): Promise<void> {
    this.onDisableCalled = true;
  }

  // Expose protected method for testing
  public testEmitData<T>(type: string, data: T): void {
    this.emitData(type, data);
  }

  public testAddTokensProcessed(count: number): void {
    this.addTokensProcessed(count);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseTextProcessor', () => {
  let processor: TestTextProcessor;

  beforeEach(() => {
    processor = new TestTextProcessor();
  });

  describe('constructor', () => {
    it('should set the processor name', () => {
      expect(processor.name).toBe('test-text-processor');
    });

    it('should start in IDLE status', () => {
      expect(processor.getStatus()).toBe(ProcessorStatus.IDLE);
    });

    it('should be enabled by default', () => {
      expect(processor.isEnabled()).toBe(true);
    });

    it('should not be initialized by default', () => {
      expect(processor.isInitialized()).toBe(false);
    });

    it('should accept custom name', () => {
      const customProcessor = new TestTextProcessor('custom-name');
      expect(customProcessor.name).toBe('custom-name');
    });
  });

  describe('init', () => {
    it('should initialize successfully', async () => {
      await processor.init();

      expect(processor.onInitCalled).toBe(true);
      expect(processor.getStatus()).toBe(ProcessorStatus.ENABLED);
      expect(processor.isInitialized()).toBe(true);
    });

    it('should accept options', async () => {
      await processor.init({ config: { key: 'value' } });

      expect(processor.onInitCalled).toBe(true);
      expect(processor.isInitialized()).toBe(true);
    });

    it('should emit Ready event', async () => {
      const readyHandler = vi.fn();
      processor.on(ProcessorEvent.Ready, readyHandler);

      await processor.init();

      expect(readyHandler).toHaveBeenCalled();
    });

    it('should emit Enabled event when enabled', async () => {
      const enabledHandler = vi.fn();
      processor.on(ProcessorEvent.Enabled, enabledHandler);

      await processor.init();

      expect(enabledHandler).toHaveBeenCalled();
    });

    it('should set status to ERROR on failure', async () => {
      processor.shouldThrowOnInit = true;

      await expect(processor.init()).rejects.toThrow('Init failed');

      expect(processor.getStatus()).toBe(ProcessorStatus.ERROR);
    });

    it('should emit Error event on failure', async () => {
      const errorHandler = vi.fn();
      processor.on(ProcessorEvent.Error, errorHandler);
      processor.initError = new Error('Custom init error');

      await expect(processor.init()).rejects.toThrow('Custom init error');

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          recoverable: false,
        })
      );
    });

    it('should throw if already initialized', async () => {
      await processor.init();

      await expect(processor.init()).rejects.toThrow(/Cannot initialize processor in state/);
    });

    it('should set stats.isActive to true after init', async () => {
      await processor.init();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(true);
    });
  });

  describe('process', () => {
    beforeEach(async () => {
      await processor.init();
    });

    it('should process input and return result', async () => {
      const result = await processor.process('hello');

      expect(result).toEqual({ result: 'processed: hello' });
      expect(processor.lastInput).toBe('hello');
    });

    it('should update stats after processing', async () => {
      await processor.process('test input');

      const stats = processor.getStats();
      expect(stats.framesProcessed).toBe(1);
      expect(stats.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(stats.tokensProcessed).toBe('test input'.length);
    });

    it('should calculate average latency correctly', async () => {
      await processor.process('input1');
      await processor.process('input2');
      await processor.process('input3');

      const stats = processor.getStats();
      expect(stats.framesProcessed).toBe(3);
      expect(stats.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw if not initialized', async () => {
      const uninitProcessor = new TestTextProcessor();

      await expect(uninitProcessor.process('test')).rejects.toThrow(
        'Processor not initialized'
      );
    });

    it('should throw if disabled', async () => {
      await processor.disable();

      await expect(processor.process('test')).rejects.toThrow('Processor is disabled');
    });

    it('should emit Error event on process failure', async () => {
      const errorHandler = vi.fn();
      processor.on(ProcessorEvent.Error, errorHandler);
      processor.processError = new Error('Process error');

      await expect(processor.process('test')).rejects.toThrow('Process error');

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          recoverable: true,
        })
      );
    });
  });

  describe('destroy', () => {
    it('should call onDestroy', async () => {
      await processor.init();
      await processor.destroy();

      expect(processor.onDestroyCalled).toBe(true);
    });

    it('should set status to DESTROYED', async () => {
      await processor.init();
      await processor.destroy();

      expect(processor.getStatus()).toBe(ProcessorStatus.DESTROYED);
    });

    it('should emit Destroyed event', async () => {
      const destroyedHandler = vi.fn();
      processor.on(ProcessorEvent.Destroyed, destroyedHandler);

      await processor.init();
      await processor.destroy();

      expect(destroyedHandler).toHaveBeenCalled();
    });

    it('should set stats.isActive to false', async () => {
      await processor.init();
      await processor.destroy();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(false);
    });

    it('should be idempotent', async () => {
      await processor.init();
      await processor.destroy();
      await processor.destroy();

      expect(processor.getStatus()).toBe(ProcessorStatus.DESTROYED);
    });
  });

  describe('enable/disable', () => {
    beforeEach(async () => {
      await processor.init();
    });

    it('should enable processor', async () => {
      await processor.disable();
      await processor.enable();

      expect(processor.isEnabled()).toBe(true);
      expect(processor.onEnableCalled).toBe(true);
      expect(processor.getStatus()).toBe(ProcessorStatus.ENABLED);
    });

    it('should disable processor', async () => {
      await processor.disable();

      expect(processor.isEnabled()).toBe(false);
      expect(processor.onDisableCalled).toBe(true);
      expect(processor.getStatus()).toBe(ProcessorStatus.DISABLED);
    });

    it('should emit Enabled event', async () => {
      const enabledHandler = vi.fn();
      processor.on(ProcessorEvent.Enabled, enabledHandler);

      await processor.disable();
      enabledHandler.mockClear();

      await processor.enable();

      expect(enabledHandler).toHaveBeenCalled();
    });

    it('should emit Disabled event', async () => {
      const disabledHandler = vi.fn();
      processor.on(ProcessorEvent.Disabled, disabledHandler);

      await processor.disable();

      expect(disabledHandler).toHaveBeenCalled();
    });

    it('should not re-enable if already enabled', async () => {
      processor.onEnableCalled = false;

      await processor.enable();

      expect(processor.onEnableCalled).toBe(false);
    });

    it('should not re-disable if already disabled', async () => {
      await processor.disable();
      processor.onDisableCalled = false;

      await processor.disable();

      expect(processor.onDisableCalled).toBe(false);
    });

    it('should update stats.isActive on enable/disable', async () => {
      await processor.disable();
      expect(processor.getStats().isActive).toBe(false);

      await processor.enable();
      expect(processor.getStats().isActive).toBe(true);
    });
  });

  describe('isSupported', () => {
    it('should return true by default', () => {
      expect(processor.isSupported()).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = processor.getStats();

      expect(stats).toEqual(
        expect.objectContaining({
          isActive: false,
          framesProcessed: 0,
          processingTimeMs: 0,
          tokensProcessed: 0,
          averageLatencyMs: 0,
        })
      );
    });

    it('should include timestamp', () => {
      const before = Date.now();
      const stats = processor.getStats();
      const after = Date.now();

      expect(stats.timestamp).toBeGreaterThanOrEqual(before);
      expect(stats.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('resetStats', () => {
    beforeEach(async () => {
      await processor.init();
    });

    it('should reset all stats', async () => {
      await processor.process('input1');
      await processor.process('input2');

      processor.resetStats();

      const stats = processor.getStats();
      expect(stats.framesProcessed).toBe(0);
      expect(stats.processingTimeMs).toBe(0);
      expect(stats.tokensProcessed).toBe(0);
      expect(stats.averageLatencyMs).toBe(0);
    });

    it('should preserve isActive state', async () => {
      processor.resetStats();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(true);
    });
  });

  describe('helper methods', () => {
    describe('emitData', () => {
      it('should emit Data event with correct payload', () => {
        const dataHandler = vi.fn();
        processor.on(ProcessorEvent.Data, dataHandler);

        processor.testEmitData('test-type', { value: 42 });

        expect(dataHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'test-type',
            data: { value: 42 },
            timestamp: expect.any(Number),
          })
        );
      });
    });

    describe('addTokensProcessed', () => {
      beforeEach(async () => {
        await processor.init();
      });

      it('should add to token count', async () => {
        processor.testAddTokensProcessed(100);
        processor.testAddTokensProcessed(50);

        const stats = processor.getStats();
        expect(stats.tokensProcessed).toBe(150);
      });
    });
  });

  describe('isInitialized', () => {
    it('should return false when IDLE', () => {
      expect(processor.isInitialized()).toBe(false);
    });

    it('should return true when ENABLED', async () => {
      await processor.init();
      expect(processor.isInitialized()).toBe(true);
    });

    it('should return true when DISABLED', async () => {
      await processor.init();
      await processor.disable();
      expect(processor.isInitialized()).toBe(true);
    });

    it('should return false when DESTROYED', async () => {
      await processor.init();
      await processor.destroy();
      expect(processor.isInitialized()).toBe(false);
    });

    it('should return false when ERROR', async () => {
      processor.shouldThrowOnInit = true;
      try {
        await processor.init();
      } catch {
        // Expected
      }
      expect(processor.isInitialized()).toBe(false);
    });
  });

  describe('reinitialize after destroy', () => {
    it('should allow reinitialization after destroy', async () => {
      await processor.init();
      await processor.destroy();

      processor.onInitCalled = false;
      await processor.init();

      expect(processor.onInitCalled).toBe(true);
      expect(processor.isInitialized()).toBe(true);
    });
  });
});
