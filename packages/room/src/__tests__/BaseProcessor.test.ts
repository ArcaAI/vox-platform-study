/**
 * @arcaai/room - BaseProcessor Tests
 *
 * Comprehensive tests for the abstract BaseProcessor class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseProcessor } from '../processors/BaseProcessor.js';
import { ProcessorStatus, type AudioProcessorOptions } from '../processors/types.js';
import { ProcessorEvent } from '../events/ProcessorEvents.js';

// ============================================================================
// Test Implementation
// ============================================================================

/**
 * Concrete implementation of BaseProcessor for testing.
 */
class TestProcessor extends BaseProcessor {
  public onInitCalled = false;
  public onDestroyCalled = false;
  public onEnableCalled = false;
  public onDisableCalled = false;
  public shouldThrowOnInit = false;
  public initError: Error | null = null;

  constructor(name = 'test-processor') {
    super(name);
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    this.onInitCalled = true;
    if (this.shouldThrowOnInit || this.initError) {
      throw this.initError || new Error('Init failed');
    }
    // Create a mock processed track
    this.processedTrack = opts.track;
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

  // Expose protected methods for testing
  public testCreateProcessedTrack(audioNode: AudioNode): MediaStreamTrack {
    return this.createProcessedTrack(audioNode);
  }

  public testCreateSourceNode(): MediaStreamAudioSourceNode {
    return this.createSourceNode();
  }

  public testEmitData<T>(type: string, data: T): void {
    this.emitData(type, data);
  }
}

// ============================================================================
// Mock Factories
// ============================================================================

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
  const mockDestinationTrack = createMockTrack();
  const mockMediaStreamDestination = {
    stream: {
      getAudioTracks: () => [mockDestinationTrack],
    },
  };

  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn(),
    createGain: vi.fn(),
    createMediaStreamSource: vi.fn().mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createMediaStreamDestination: vi.fn().mockReturnValue(mockMediaStreamDestination),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseProcessor', () => {
  let processor: TestProcessor;
  let mockTrack: MediaStreamTrack;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    processor = new TestProcessor();
    mockTrack = createMockTrack();
    mockAudioContext = createMockAudioContext();
  });

  describe('constructor', () => {
    it('should set the processor name', () => {
      expect(processor.name).toBe('test-processor');
    });

    it('should start in IDLE status', () => {
      expect(processor.getStatus()).toBe(ProcessorStatus.IDLE);
    });

    it('should be enabled by default', () => {
      expect(processor.isEnabled()).toBe(true);
    });

    it('should have no processed track initially', () => {
      expect(processor.processedTrack).toBeUndefined();
    });
  });

  describe('init', () => {
    it('should initialize successfully', async () => {
      const opts: AudioProcessorOptions = {
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      };

      await processor.init(opts);

      expect(processor.onInitCalled).toBe(true);
      expect(processor.getStatus()).toBe(ProcessorStatus.ENABLED);
    });

    it('should set audioContext and sourceTrack', async () => {
      const opts: AudioProcessorOptions = {
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      };

      await processor.init(opts);

      expect(processor.processedTrack).toBe(mockTrack);
    });

    it('should emit Ready event', async () => {
      const readyHandler = vi.fn();
      processor.on(ProcessorEvent.Ready, readyHandler);

      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(readyHandler).toHaveBeenCalled();
    });

    it('should emit Enabled event when enabled', async () => {
      const enabledHandler = vi.fn();
      processor.on(ProcessorEvent.Enabled, enabledHandler);

      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(enabledHandler).toHaveBeenCalled();
    });

    it('should set status to ERROR on failure', async () => {
      processor.shouldThrowOnInit = true;

      await expect(
        processor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        }),
      ).rejects.toThrow('Init failed');

      expect(processor.getStatus()).toBe(ProcessorStatus.ERROR);
    });

    it('should emit Error event on failure', async () => {
      const errorHandler = vi.fn();
      processor.on(ProcessorEvent.Error, errorHandler);
      processor.initError = new Error('Custom init error');

      await expect(
        processor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        }),
      ).rejects.toThrow('Custom init error');

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          recoverable: false,
        }),
      );
    });

    it('should throw if already initialized', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await expect(
        processor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        }),
      ).rejects.toThrow(/Cannot initialize processor in state/);
    });
  });

  describe('restart', () => {
    it('should destroy and reinitialize', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.restart({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(processor.onDestroyCalled).toBe(true);
      expect(processor.getStatus()).toBe(ProcessorStatus.ENABLED);
    });
  });

  describe('destroy', () => {
    it('should call onDestroy', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      expect(processor.onDestroyCalled).toBe(true);
    });

    it('should set status to DESTROYED', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      expect(processor.getStatus()).toBe(ProcessorStatus.DESTROYED);
    });

    it('should emit Destroyed event', async () => {
      const destroyedHandler = vi.fn();
      processor.on(ProcessorEvent.Destroyed, destroyedHandler);

      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      expect(destroyedHandler).toHaveBeenCalled();
    });

    it('should stop processed track', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      expect(mockTrack.stop).toHaveBeenCalled();
      expect(processor.processedTrack).toBeUndefined();
    });

    it('should be idempotent', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();
      await processor.destroy();

      // Should not throw
      expect(processor.getStatus()).toBe(ProcessorStatus.DESTROYED);
    });
  });

  describe('enable/disable', () => {
    beforeEach(async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });
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
  });

  describe('onAttach/onDetach', () => {
    it('should have default onAttach implementation', async () => {
      await expect(processor.onAttach()).resolves.toBeUndefined();
    });

    it('should have default onDetach implementation', async () => {
      await expect(processor.onDetach()).resolves.toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('should return true by default', () => {
      expect(processor.isSupported()).toBe(true);
    });
  });

  describe('helper methods', () => {
    describe('createProcessedTrack', () => {
      it('should create track from audio node', async () => {
        await processor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        });

        const mockAudioNode = {
          connect: vi.fn(),
        } as unknown as AudioNode;

        const track = processor.testCreateProcessedTrack(mockAudioNode);

        expect(mockAudioContext.createMediaStreamDestination).toHaveBeenCalled();
        expect(mockAudioNode.connect).toHaveBeenCalled();
        expect(track).toBeDefined();
      });

      it('should throw if AudioContext not available', () => {
        expect(() => {
          processor.testCreateProcessedTrack({} as AudioNode);
        }).toThrow('AudioContext not available');
      });
    });

    describe('createSourceNode', () => {
      it('should create source node from track', async () => {
        // Mock MediaStream globally for this test using a class
        class MockMediaStream {
          private tracks: MediaStreamTrack[];
          constructor(tracks: MediaStreamTrack[]) {
            this.tracks = tracks;
          }
          getAudioTracks() {
            return this.tracks;
          }
          getTracks() {
            return this.tracks;
          }
        }
        vi.stubGlobal('MediaStream', MockMediaStream);

        await processor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        });

        processor.testCreateSourceNode();

        expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalled();

        vi.unstubAllGlobals();
      });

      it('should throw if AudioContext not available', () => {
        expect(() => {
          processor.testCreateSourceNode();
        }).toThrow('AudioContext or source track not available');
      });
    });

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
          }),
        );
      });
    });
  });
});
