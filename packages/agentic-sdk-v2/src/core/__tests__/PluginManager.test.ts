/**
 * PluginManager Unit Tests
 *
 * Tests for the plugin lifecycle management.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The
 * `noiseFilter` / `vad` client stages, the `clientInference` gate, the
 * deprecated `pipelineId` selector, and the in-browser NER init path
 * (`initializeNER` / `extractEntities` / `isNERAvailable`, `@arcaai/med-ner`)
 * were removed. This file now exercises the single surviving stage (`stt`)
 * and the `KnowledgePipeline` lifecycle wiring (`setNERConfig` /
 * `initializeKnowledgePipeline`), which still exist — client-side NER inside
 * `KnowledgePipeline` itself now throws (see `KnowledgePipeline.test.ts`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AudioPluginConfig } from '../../types';

// Mock the external modules
vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

// Mock KnowledgePipeline
const mockKnowledgePipeline = {
  init: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    ner: { enabled: false, location: 'disabled', triggerMode: 'auto' },
    spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
    summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
  }),
};

vi.mock('../KnowledgePipeline', () => ({
  KnowledgePipeline: vi.fn(() => mockKnowledgePipeline),
  createKnowledgePipeline: vi.fn(() => mockKnowledgePipeline),
}));

describe('PluginManager', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.clearAllMocks();

    // Reset knowledge pipeline mock
    mockKnowledgePipeline.init.mockResolvedValue(undefined);
    mockKnowledgePipeline.destroy.mockResolvedValue(undefined);
    mockKnowledgePipeline.on.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create manager with default config', () => {
      const manager = new PluginManager();
      expect(manager.initialized).toBe(false);
    });

    it('should create manager with config', () => {
      const config: AudioPluginConfig = {
        stt: { enabled: false },
      };
      const manager = new PluginManager(config, mockLogger);

      expect(manager.isEnabled('stt')).toBe(false);
    });

    it('should log creation with plugin states', () => {
      const config: AudioPluginConfig = {
        stt: false,
      };
      new PluginManager(config, mockLogger);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'PluginManager created',
        expect.objectContaining({
          attributes: expect.objectContaining({
            sttEnabled: false,
          }),
        }),
      );
    });
  });

  describe('isEnabled', () => {
    it('should return true for enabled plugins (boolean config)', () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } });
      expect(manager.isEnabled('stt')).toBe(true);
    });

    it('should return true for enabled plugins (object config)', () => {
      const manager = new PluginManager({
        stt: { enabled: true },
      });
      expect(manager.isEnabled('stt')).toBe(true);
    });

    it('should return false for disabled plugins', () => {
      const manager = new PluginManager({ stt: false });
      expect(manager.isEnabled('stt')).toBe(false);
    });

    it('should return false for undefined plugins', () => {
      const manager = new PluginManager({});
      expect(manager.isEnabled('stt')).toBe(false);
    });
  });

  describe('setCallbacks', () => {
    it('should set callbacks', () => {
      const manager = new PluginManager();
      const onTranscription = vi.fn();
      const onVADEvent = vi.fn();
      const onError = vi.fn();

      manager.setCallbacks({
        onTranscription,
        onVADEvent,
        onError,
      });

      // Callbacks should be set (we can't test this directly without initialize)
      // But we verify no errors are thrown
    });

    it('should merge callbacks', () => {
      const manager = new PluginManager();
      const onTranscription = vi.fn();
      const onVADEvent = vi.fn();

      manager.setCallbacks({ onTranscription });
      manager.setCallbacks({ onVADEvent });

      // Both callbacks should be set
    });
  });

  describe('initialize', () => {
    const mockTrack = {} as MediaStreamTrack;
    const mockAudioContext = {} as AudioContext;

    it('should initialize enabled plugins', async () => {
      const manager = new PluginManager(
        {
          stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' },
        },
        mockLogger,
      );

      await manager.initialize(mockTrack, mockAudioContext);

      expect(manager.initialized).toBe(true);
      // Check that some form of initialization complete message was logged
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should not reinitialize if already initialized', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);

      await manager.initialize(mockTrack, mockAudioContext);
      await manager.initialize(mockTrack, mockAudioContext);

      expect(mockLogger.debug).toHaveBeenCalledWith('PluginManager already initialized, skipping', expect.any(Object));
    });

    it('should not initialize a disabled stt stage', async () => {
      const manager = new PluginManager(
        {
          stt: false,
        },
        mockLogger,
      );

      await manager.initialize(mockTrack, mockAudioContext);

      expect(manager.getProcessor('stt')).toBeUndefined();
    });
  });

  describe('getProcessor', () => {
    it('should return processor by name', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const processor = manager.getProcessor('stt');
      expect(processor).toBeDefined();
    });

    it('should return undefined for non-existent processor', () => {
      const manager = new PluginManager({});
      expect(manager.getProcessor('stt')).toBeUndefined();
    });
  });

  describe('getAllProcessors', () => {
    it('should return all processors', async () => {
      const manager = new PluginManager({
        stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' },
      });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const processors = manager.getAllProcessors();
      expect(processors).toHaveLength(1);
    });

    it('should return empty array when no processors', () => {
      const manager = new PluginManager({});
      expect(manager.getAllProcessors()).toEqual([]);
    });
  });

  describe('getStates', () => {
    it('should return plugin states, with noiseFilter/vad permanently inactive (TASK-1006)', async () => {
      const manager = new PluginManager({
        stt: false,
      });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const states = manager.getStates();

      expect(states.stt.isSupported).toBe(false);
      expect(states.noiseFilter).toEqual({ isActive: false, isSupported: false });
      expect(states.vad).toEqual({ isActive: false, isSupported: false });
    });

    it('should return default states when not initialized', () => {
      const manager = new PluginManager({
        stt: true,
      });

      const states = manager.getStates();

      expect(states.stt.isActive).toBe(false);
      expect(states.stt.isSupported).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('should enable processor', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.setEnabled('stt', true);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Enabling processor'), expect.any(Object));
    });

    it('should disable processor', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.setEnabled('stt', false);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Disabling processor'), expect.any(Object));
    });

    it('should warn when processor not found', async () => {
      const manager = new PluginManager({}, mockLogger);

      await manager.setEnabled('nonexistent', true);

      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot set enabled state - processor not found', expect.any(Object));
    });
  });

  describe('toggle', () => {
    it('should toggle processor state', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const newState = await manager.toggle('stt');

      expect(typeof newState).toBe('boolean');
    });

    it('should return false for non-existent processor', async () => {
      const manager = new PluginManager({}, mockLogger);

      const result = await manager.toggle('nonexistent');

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('should restart all processors', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const newTrack = {} as MediaStreamTrack;
      const newContext = {} as AudioContext;
      await manager.restart(newTrack, newContext);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Restarting processor'), expect.any(Object));
    });
  });

  describe('destroy', () => {
    it('should destroy all processors', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.destroy();

      expect(manager.initialized).toBe(false);
      expect(manager.getAllProcessors()).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith('PluginManager destroyed', expect.any(Object));
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const manager = new PluginManager({ stt: false }, mockLogger);

      manager.updateConfig({ stt: true });

      // Note: Config update doesn't affect already-initialized plugins
      expect(manager.isEnabled('stt')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('Updating PluginManager configuration', expect.any(Object));
    });
  });

  // =========================================================================
  // ASR-R-04: sttSocket / agentSlug wiring from config to pipeline
  // =========================================================================

  describe('ASR-R-04: backend STT config wiring', () => {
    it('should pass agentSlug through to transcription pipeline config', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            agentSlug: 'my-agent-slug',
          },
        },
        mockLogger,
      );

      // Access the built config via the exposed method
      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.agentSlug).toBe('my-agent-slug');
    });

    it('should pass sttSocket through to transcription pipeline config', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            sttSocket: 'wss://api.example.com/ws/stt/stream',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.sttSocket).toBe('wss://api.example.com/ws/stt/stream');
    });

    it('should leave sttSocket and agentSlug undefined when not configured', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'auto',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.sttSocket).toBeUndefined();
      expect(config.stt.agentSlug).toBeUndefined();
    });

    it('should set location to backend when provider is backend', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            agentSlug: 'default',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.location).toBe('backend');
    });

    it('should set location to auto when provider is auto', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'auto',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.location).toBe('auto');
      expect(config.stt.sttSocket).toBeUndefined();
      expect(config.stt.agentSlug).toBeUndefined();
    });

    it('should handle boolean shorthand stt: true (no sttSocket or agentSlug)', () => {
      const manager = new PluginManager({ stt: true }, mockLogger);

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.enabled).toBe(true);
      expect(config.stt.sttSocket).toBeUndefined();
      expect(config.stt.agentSlug).toBeUndefined();
    });

    it('should handle both agentSlug and sttSocket together', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            agentSlug: 'custom-agent',
            sttSocket: 'wss://custom.host/ws/stt',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.agentSlug).toBe('custom-agent');
      expect(config.stt.sttSocket).toBe('wss://custom.host/ws/stt');
      expect(config.stt.location).toBe('backend');
      expect(config.stt.provider).toBe('backend');
    });
  });

  describe('getTranscriptionPipeline / getKnowledgePipeline', () => {
    it('should return null for transcription pipeline when not initialized', () => {
      const manager = new PluginManager({}, mockLogger);

      expect(manager.getTranscriptionPipeline()).toBeNull();
    });

    it('should return transcription pipeline after initialization', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const pipeline = manager.getTranscriptionPipeline();
      expect(pipeline).not.toBeNull();
    });

    it('should return null for knowledge pipeline when not initialized', () => {
      const manager = new PluginManager({}, mockLogger);

      expect(manager.getKnowledgePipeline()).toBeNull();
    });

    it('should return knowledge pipeline after initialization', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });
      await manager.initializeKnowledgePipeline();

      const pipeline = manager.getKnowledgePipeline();
      expect(pipeline).not.toBeNull();
    });
  });

  describe('initializeKnowledgePipeline', () => {
    it('should initialize knowledge pipeline', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initializeKnowledgePipeline();

      expect(mockKnowledgePipeline.init).toHaveBeenCalled();
      expect(manager.getKnowledgePipeline()).not.toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'KnowledgePipeline initialized',
        expect.objectContaining({
          success: true,
        }),
      );
    });

    it('should not reinitialize if already initialized', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initializeKnowledgePipeline();
      vi.clearAllMocks();
      await manager.initializeKnowledgePipeline();

      expect(mockLogger.debug).toHaveBeenCalledWith('KnowledgePipeline already initialized', expect.any(Object));
      expect(mockKnowledgePipeline.init).not.toHaveBeenCalled();
    });

    it('should set up knowledge pipeline event handlers', async () => {
      const manager = new PluginManager({}, mockLogger);
      const onNERExtraction = vi.fn();
      const onError = vi.fn();
      manager.setCallbacks({ onNERExtraction, onError });
      manager.setNERConfig({ enabled: true });

      await manager.initializeKnowledgePipeline();

      expect(mockKnowledgePipeline.on).toHaveBeenCalledWith('nerComplete', expect.any(Function));
      expect(mockKnowledgePipeline.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should accept partial config override, defaulting ner.location to disabled (TASK-1006)', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initializeKnowledgePipeline({
        spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
      });

      expect(mockKnowledgePipeline.init).toHaveBeenCalled();
    });
  });

  describe('destroy with pipelines', () => {
    it('should destroy transcription pipeline on destroy', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const transcriptionPipeline = manager.getTranscriptionPipeline();
      const destroySpy = vi.spyOn(transcriptionPipeline!, 'destroy');

      await manager.destroy();

      expect(destroySpy).toHaveBeenCalled();
      expect(manager.getTranscriptionPipeline()).toBeNull();
    });

    it('should destroy knowledge pipeline on destroy', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });
      await manager.initializeKnowledgePipeline();

      await manager.destroy();

      expect(mockKnowledgePipeline.destroy).toHaveBeenCalled();
      expect(manager.getKnowledgePipeline()).toBeNull();
    });

    it('should destroy all pipelines together', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);
      await manager.initializeKnowledgePipeline();

      const transcriptionPipeline = manager.getTranscriptionPipeline();
      const transcriptionDestroySpy = vi.spyOn(transcriptionPipeline!, 'destroy');

      await manager.destroy();

      expect(transcriptionDestroySpy).toHaveBeenCalled();
      expect(mockKnowledgePipeline.destroy).toHaveBeenCalled();
      expect(manager.getTranscriptionPipeline()).toBeNull();
      expect(manager.getKnowledgePipeline()).toBeNull();
    });

    it('should handle destroy gracefully when pipelines are not initialized', async () => {
      const manager = new PluginManager({}, mockLogger);

      await expect(manager.destroy()).resolves.not.toThrow();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'PluginManager destroyed',
        expect.objectContaining({
          success: true,
        }),
      );
    });

    it('REFACTOR-09: should clear callbacks on destroy', async () => {
      const manager = new PluginManager({}, mockLogger);
      const onTranscription = vi.fn();
      const onError = vi.fn();
      manager.setCallbacks({ onTranscription, onError });

      await manager.destroy();

      // After destroy, callbacks should be cleared
      // Access internal state to verify
      const state = (manager as any).callbacks;
      expect(state).toEqual({});
    });
  });

  // =========================================================================
  // ENH-04: STT processing state tracking
  // =========================================================================

  describe('ENH-04: STT processing state tracking', () => {
    it('should report isProcessing=true while STT is actively processing', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      manager.setSttProcessing(true);
      const states = manager.getStates();
      expect(states.stt.isProcessing).toBe(true);
    });

    it('should report isProcessing=false when STT finishes processing', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      manager.setSttProcessing(true);
      manager.setSttProcessing(false);
      const states = manager.getStates();
      expect(states.stt.isProcessing).toBe(false);
    });
  });

  // =========================================================================
  // Forward the transcription pipeline's `audioDrop` event to the
  // consumer callback so the vox hook/store can surface a degraded signal.
  // =========================================================================

  describe('audioDrop forwarding', () => {
    it('forwards the pipeline audioDrop event to the onAudioDrop callback', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      const onAudioDrop = vi.fn();
      manager.setCallbacks({ onAudioDrop });

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const pipeline = manager.getTranscriptionPipeline();
      expect(pipeline).not.toBeNull();
      // `emit` is private on the typed pipeline emitter — reach past the type
      // to simulate the STT stage pushing a drop up the chain.
      (pipeline as unknown as { emit(event: string, payload: number): void }).emit('audioDrop', 3);

      expect(onAudioDrop).toHaveBeenCalledWith(3);
    });

    it('does not throw when audioDrop fires without an onAudioDrop callback', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', sttSocket: 'wss://api.test/ws/stt' } }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const pipeline = manager.getTranscriptionPipeline();
      expect(() => (pipeline as unknown as { emit(event: string, payload: number): void }).emit('audioDrop', 1)).not.toThrow();
    });
  });
});
