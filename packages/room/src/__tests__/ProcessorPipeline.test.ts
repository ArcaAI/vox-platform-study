/**
 * @arcaai/room - ProcessorPipeline Tests
 *
 * Comprehensive tests for the processor pipeline functionality.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessorPipeline } from '../core/ProcessorPipeline.js';
import type { TrackProcessor, AudioProcessorOptions } from '../processors/types.js';

// ============================================================================
// Mock Processor Factory
// ============================================================================

function createMockProcessor(name: string): TrackProcessor {
  const processor: TrackProcessor = {
    name,
    processedTrack: undefined,
    init: vi.fn().mockImplementation(async (opts: AudioProcessorOptions) => {
      processor.processedTrack = opts.track;
    }),
    restart: vi.fn().mockImplementation(async (opts: AudioProcessorOptions) => {
      await processor.destroy();
      await processor.init(opts);
    }),
    destroy: vi.fn().mockImplementation(async () => {
      processor.processedTrack = undefined;
    }),
    onAttach: vi.fn().mockResolvedValue(undefined),
    onDetach: vi.fn().mockResolvedValue(undefined),
  };
  return processor;
}

function createMockTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    id: 'mock-track-id',
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock Audio Track',
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue({}),
    getConstraints: vi.fn().mockReturnValue({}),
    getCapabilities: vi.fn().mockReturnValue({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

function createMockAudioContext(): AudioContext {
  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn(),
    createGain: vi.fn(),
    createMediaStreamSource: vi.fn(),
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('ProcessorPipeline', () => {
  let pipeline: ProcessorPipeline;
  let mockTrack: MediaStreamTrack;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    pipeline = new ProcessorPipeline();
    mockTrack = createMockTrack();
    mockAudioContext = createMockAudioContext();
  });

  describe('constructor', () => {
    it('should create an empty pipeline', () => {
      expect(pipeline.getProcessors()).toHaveLength(0);
      expect(pipeline.name).toBe('processor-pipeline');
    });

    it('should accept initial processors as array', () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      const pipelineWithProcessors = new ProcessorPipeline([proc1, proc2]);

      expect(pipelineWithProcessors.getProcessors()).toHaveLength(2);
    });

    it('should accept initial processors with priority config', () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      const pipelineWithProcessors = new ProcessorPipeline([
        { processor: proc1, priority: 20 },
        { processor: proc2, priority: 10 },
      ]);

      const processors = pipelineWithProcessors.getProcessors();
      expect(processors).toHaveLength(2);
      // Should be sorted by priority (lower first)
      expect(processors[0]?.processor.name).toBe('proc-2');
      expect(processors[1]?.processor.name).toBe('proc-1');
    });
  });

  describe('add', () => {
    it('should add a processor to the pipeline', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      expect(pipeline.getProcessors()).toHaveLength(1);
      expect(pipeline.getProcessors()[0]?.processor).toBe(proc);
    });

    it('should add processor with default priority', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      expect(pipeline.getProcessors()[0]?.priority).toBe(0);
    });

    it('should add processor with custom priority', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { priority: 50 });

      expect(pipeline.getProcessors()[0]?.priority).toBe(50);
    });

    it('should add processor as enabled by default', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      expect(pipeline.getProcessors()[0]?.enabled).toBe(true);
    });

    it('should add processor as disabled when specified', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: false });

      expect(pipeline.getProcessors()[0]?.enabled).toBe(false);
    });

    it('should sort processors by priority after adding', () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');
      const proc3 = createMockProcessor('proc-3');

      pipeline.add(proc1, { priority: 30 });
      pipeline.add(proc2, { priority: 10 });
      pipeline.add(proc3, { priority: 20 });

      const processors = pipeline.getProcessors();
      expect(processors[0]?.processor.name).toBe('proc-2');
      expect(processors[1]?.processor.name).toBe('proc-3');
      expect(processors[2]?.processor.name).toBe('proc-1');
    });
  });

  describe('remove', () => {
    it('should remove a processor by instance', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      await pipeline.remove(proc);

      expect(pipeline.getProcessors()).toHaveLength(0);
      expect(proc.destroy).toHaveBeenCalled();
    });

    it('should remove a processor by name', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      await pipeline.remove('test-proc');

      expect(pipeline.getProcessors()).toHaveLength(0);
    });

    it('should do nothing when removing non-existent processor', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc);

      await pipeline.remove('non-existent');

      expect(pipeline.getProcessors()).toHaveLength(1);
    });
  });

  describe('setEnabled', () => {
    it('should enable a processor', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: false });

      await pipeline.setEnabled('test-proc', true);

      expect(pipeline.isProcessorEnabled('test-proc')).toBe(true);
    });

    it('should disable a processor', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: true });

      await pipeline.setEnabled('test-proc', false);

      expect(pipeline.isProcessorEnabled('test-proc')).toBe(false);
    });

    it('should do nothing if state is unchanged', async () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: true });

      await pipeline.setEnabled('test-proc', true);

      expect(pipeline.isProcessorEnabled('test-proc')).toBe(true);
    });

    it('should do nothing for non-existent processor', async () => {
      await pipeline.setEnabled('non-existent', true);
      // Should not throw
      expect(pipeline.isProcessorEnabled('non-existent')).toBe(false);
    });
  });

  describe('isProcessorEnabled', () => {
    it('should return true for enabled processor', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: true });

      expect(pipeline.isProcessorEnabled('test-proc')).toBe(true);
    });

    it('should return false for disabled processor', () => {
      const proc = createMockProcessor('test-proc');
      pipeline.add(proc, { enabled: false });

      expect(pipeline.isProcessorEnabled('test-proc')).toBe(false);
    });

    it('should return false for non-existent processor', () => {
      expect(pipeline.isProcessorEnabled('non-existent')).toBe(false);
    });
  });

  describe('getEnabledProcessors', () => {
    it('should return only enabled processors', () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');
      const proc3 = createMockProcessor('proc-3');

      pipeline.add(proc1, { enabled: true });
      pipeline.add(proc2, { enabled: false });
      pipeline.add(proc3, { enabled: true });

      const enabled = pipeline.getEnabledProcessors();
      expect(enabled).toHaveLength(2);
      expect(enabled).toContain(proc1);
      expect(enabled).toContain(proc3);
      expect(enabled).not.toContain(proc2);
    });

    it('should return empty array when all processors are disabled', () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { enabled: false });
      pipeline.add(proc2, { enabled: false });

      expect(pipeline.getEnabledProcessors()).toHaveLength(0);
    });

    it('should return empty array for empty pipeline', () => {
      expect(pipeline.getEnabledProcessors()).toHaveLength(0);
    });
  });

  describe('init', () => {
    it('should initialize all enabled processors in order', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { priority: 10 });
      pipeline.add(proc2, { priority: 20 });

      const opts: AudioProcessorOptions = {
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      };

      await pipeline.init(opts);

      expect(proc1.init).toHaveBeenCalled();
      expect(proc2.init).toHaveBeenCalled();

      // Verify order - proc1 should be called first (lower priority)
      const proc1CallOrder = (proc1.init as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const proc2CallOrder = (proc2.init as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(proc1CallOrder).toBeLessThan(proc2CallOrder!);
    });

    it('should skip disabled processors', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { enabled: true });
      pipeline.add(proc2, { enabled: false });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(proc1.init).toHaveBeenCalled();
      expect(proc2.init).not.toHaveBeenCalled();
    });

    it('should chain processor outputs', async () => {
      const proc1Track = createMockTrack();
      const proc2Track = createMockTrack();

      const proc1 = createMockProcessor('proc-1');
      (proc1.init as ReturnType<typeof vi.fn>).mockImplementation(async (opts: AudioProcessorOptions) => {
        proc1.processedTrack = proc1Track;
      });

      const proc2 = createMockProcessor('proc-2');
      (proc2.init as ReturnType<typeof vi.fn>).mockImplementation(async (opts: AudioProcessorOptions) => {
        // Should receive proc1's output track
        expect(opts.track).toBe(proc1Track);
        proc2.processedTrack = proc2Track;
      });

      pipeline.add(proc1, { priority: 10 });
      pipeline.add(proc2, { priority: 20 });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      // Final processed track should be from the last processor
      expect(pipeline.processedTrack).toBe(proc2Track);
    });

    it('should pass through original track when no processors are enabled', async () => {
      const proc = createMockProcessor('proc-1');
      pipeline.add(proc, { enabled: false });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(pipeline.processedTrack).toBe(mockTrack);
    });

    it('should pass through original track for empty pipeline', async () => {
      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(pipeline.processedTrack).toBe(mockTrack);
    });
  });

  describe('restart', () => {
    it('should destroy and reinitialize all processors', async () => {
      const proc = createMockProcessor('proc-1');
      pipeline.add(proc);

      const opts: AudioProcessorOptions = {
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      };

      await pipeline.init(opts);
      await pipeline.restart(opts);

      // destroy is called once during restart
      expect(proc.destroy).toHaveBeenCalled();
      // init is called twice (once during init, once during restart)
      expect(proc.init).toHaveBeenCalledTimes(2);
    });
  });

  describe('destroy', () => {
    it('should destroy all processors', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1);
      pipeline.add(proc2);

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await pipeline.destroy();

      expect(proc1.destroy).toHaveBeenCalled();
      expect(proc2.destroy).toHaveBeenCalled();
      expect(pipeline.processedTrack).toBeUndefined();
    });

    it('should handle processor destroy errors gracefully', async () => {
      const proc = createMockProcessor('proc-1');
      (proc.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Destroy failed'));

      pipeline.add(proc);

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      // Should not throw
      await expect(pipeline.destroy()).resolves.toBeUndefined();
    });
  });

  describe('onAttach', () => {
    it('should call onAttach on all enabled processors', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { enabled: true });
      pipeline.add(proc2, { enabled: false });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await pipeline.onAttach();

      expect(proc1.onAttach).toHaveBeenCalled();
      expect(proc2.onAttach).not.toHaveBeenCalled();
    });
  });

  describe('onDetach', () => {
    it('should call onDetach on all processors', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { enabled: true });
      pipeline.add(proc2, { enabled: false });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await pipeline.onDetach();

      // onDetach is called on all processors, regardless of enabled state
      expect(proc1.onDetach).toHaveBeenCalled();
      expect(proc2.onDetach).toHaveBeenCalled();
    });
  });

  describe('dynamic pipeline modification', () => {
    it('should rebuild pipeline when processor is removed after init', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { priority: 10 });
      pipeline.add(proc2, { priority: 20 });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      // Clear mock calls
      vi.clearAllMocks();

      await pipeline.remove('proc-1');

      // proc2 should be reinitialized
      expect(proc2.init).toHaveBeenCalled();
    });

    it('should rebuild pipeline when processor is enabled/disabled after init', async () => {
      const proc1 = createMockProcessor('proc-1');
      const proc2 = createMockProcessor('proc-2');

      pipeline.add(proc1, { enabled: true });
      pipeline.add(proc2, { enabled: false });

      await pipeline.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      // Clear mock calls
      vi.clearAllMocks();

      await pipeline.setEnabled('proc-2', true);

      // Both processors should be reinitialized
      expect(proc1.init).toHaveBeenCalled();
      expect(proc2.init).toHaveBeenCalled();
    });
  });
});
