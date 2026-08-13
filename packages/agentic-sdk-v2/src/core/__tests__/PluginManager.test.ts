/**
 * PluginManager Unit Tests
 *
 * Tests for the plugin lifecycle management.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AudioPluginConfig, AudioPluginStates } from '../../types';

// Mock the external modules
vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    restart: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

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

// Local (in-browser) transcription is disabled platform-wide
// default (`LOCAL_TRANSCRIPTION_ENABLED = false` in `../constants`). This
// file exercises PluginManager lifecycle/state-tracking behavior with several
// fixtures that configure `stt` with no backend transport — irrelevant to
// what these tests actually assert — so force the flag back on rather than
// threading an unrelated transport through every fixture. See
// `TranscriptionPipeline.localTranscriptionDisabled.task545.test.ts` for the
// shipped (flag OFF) default.
vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constants')>();
  return { ...actual, LOCAL_TRANSCRIPTION_ENABLED: true };
});

// Mock @arcaai/med-ner
const mockMedNERProcessor = {
  init: vi.fn().mockResolvedValue(undefined),
  extract: vi.fn().mockResolvedValue({
    text: 'test text',
    entities: [{ text: 'diabetes', type: 'CONDITION', score: 0.95, start: 0, end: 8 }],
    processingTime: 100,
    timestamp: Date.now(),
  }),
  isInitialized: vi.fn().mockReturnValue(true),
  destroy: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@arcaai/med-ner', () => ({
  createMedNER: vi.fn(() => mockMedNERProcessor),
}));

// Mock KnowledgePipeline
const mockKnowledgePipeline = {
  init: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    ner: { enabled: true, location: 'browser', triggerMode: 'auto' },
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

    // Reset mock processors
    mockMedNERProcessor.init.mockResolvedValue(undefined);
    mockMedNERProcessor.extract.mockResolvedValue({
      text: 'test text',
      entities: [{ text: 'diabetes', type: 'CONDITION', score: 0.95, start: 0, end: 8 }],
      processingTime: 100,
      timestamp: Date.now(),
    });
    mockMedNERProcessor.isInitialized.mockReturnValue(true);
    mockMedNERProcessor.destroy.mockResolvedValue(undefined);

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
        noiseFilter: { enabled: true, level: 'high' },
        vad: { enabled: true },
        stt: { enabled: false },
      };
      const manager = new PluginManager(config, mockLogger);

      expect(manager.isEnabled('noiseFilter')).toBe(true);
      expect(manager.isEnabled('vad')).toBe(true);
      expect(manager.isEnabled('stt')).toBe(false);
    });

    it('should log creation with plugin states', () => {
      const config: AudioPluginConfig = {
        noiseFilter: true,
        vad: true,
        stt: false,
      };
      new PluginManager(config, mockLogger);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'PluginManager created',
        expect.objectContaining({
          attributes: expect.objectContaining({
            noiseFilterEnabled: true,
            vadEnabled: true,
            sttEnabled: false,
          }),
        }),
      );
    });
  });

  describe('isEnabled', () => {
    it('should return true for enabled plugins (boolean config)', () => {
      const manager = new PluginManager({ noiseFilter: true });
      expect(manager.isEnabled('noiseFilter')).toBe(true);
    });

    it('should return true for enabled plugins (object config)', () => {
      const manager = new PluginManager({
        noiseFilter: { enabled: true, level: 'medium' },
      });
      expect(manager.isEnabled('noiseFilter')).toBe(true);
    });

    it('should return false for disabled plugins', () => {
      const manager = new PluginManager({ noiseFilter: false });
      expect(manager.isEnabled('noiseFilter')).toBe(false);
    });

    it('should return false for undefined plugins', () => {
      const manager = new PluginManager({});
      expect(manager.isEnabled('noiseFilter')).toBe(false);
      expect(manager.isEnabled('vad')).toBe(false);
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
          noiseFilter: true,
          vad: true,
          stt: true,
        },
        mockLogger,
      );

      await manager.initialize(mockTrack, mockAudioContext);

      expect(manager.initialized).toBe(true);
      // Check that some form of initialization complete message was logged
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should not reinitialize if already initialized', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);

      await manager.initialize(mockTrack, mockAudioContext);
      await manager.initialize(mockTrack, mockAudioContext);

      expect(mockLogger.debug).toHaveBeenCalledWith('PluginManager already initialized, skipping', expect.any(Object));
    });

    it('should only initialize enabled plugins', async () => {
      const manager = new PluginManager(
        {
          noiseFilter: true,
          vad: false,
          stt: false,
        },
        mockLogger,
      );

      await manager.initialize(mockTrack, mockAudioContext);

      expect(manager.getProcessor('noiseFilter')).toBeDefined();
      expect(manager.getProcessor('vad')).toBeUndefined();
      expect(manager.getProcessor('stt')).toBeUndefined();
    });
  });

  describe('getProcessor', () => {
    it('should return processor by name', async () => {
      const manager = new PluginManager({ noiseFilter: true });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const processor = manager.getProcessor('noiseFilter');
      expect(processor).toBeDefined();
    });

    it('should return undefined for non-existent processor', () => {
      const manager = new PluginManager({});
      expect(manager.getProcessor('noiseFilter')).toBeUndefined();
    });
  });

  describe('getAllProcessors', () => {
    it('should return all processors', async () => {
      const manager = new PluginManager({
        noiseFilter: true,
        vad: true,
      });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const processors = manager.getAllProcessors();
      expect(processors).toHaveLength(2);
    });

    it('should return empty array when no processors', () => {
      const manager = new PluginManager({});
      expect(manager.getAllProcessors()).toEqual([]);
    });
  });

  describe('getStates', () => {
    it('should return plugin states', async () => {
      const manager = new PluginManager({
        noiseFilter: true,
        vad: true,
        stt: false,
      });
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const states = manager.getStates();

      expect(states.noiseFilter.isSupported).toBe(true);
      expect(states.vad.isSupported).toBe(true);
      expect(states.stt.isSupported).toBe(false);
    });

    it('should return default states when not initialized', () => {
      const manager = new PluginManager({
        noiseFilter: true,
      });

      const states = manager.getStates();

      expect(states.noiseFilter.isActive).toBe(false);
      expect(states.noiseFilter.isSupported).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('should enable processor', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.setEnabled('noiseFilter', true);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Enabling processor'), expect.any(Object));
    });

    it('should disable processor', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.setEnabled('noiseFilter', false);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Disabling processor'), expect.any(Object));
    });

    it('should warn when processor not found', async () => {
      const manager = new PluginManager({}, mockLogger);

      await manager.setEnabled('noiseFilter', true);

      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot set enabled state - processor not found', expect.any(Object));
    });
  });

  describe('toggle', () => {
    it('should toggle processor state', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const newState = await manager.toggle('noiseFilter');

      expect(typeof newState).toBe('boolean');
    });

    it('should return false for non-existent processor', async () => {
      const manager = new PluginManager({}, mockLogger);

      const result = await manager.toggle('noiseFilter');

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('should restart all processors', async () => {
      const manager = new PluginManager({ noiseFilter: true, vad: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const newTrack = {} as MediaStreamTrack;
      const newContext = {} as AudioContext;
      await manager.restart(newTrack, newContext);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Restarting processor'), expect.any(Object));
    });
  });

  describe('destroy', () => {
    it('should destroy all processors', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      await manager.destroy();

      expect(manager.initialized).toBe(false);
      expect(manager.getAllProcessors()).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith('PluginManager destroyed', expect.any(Object));
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);

      manager.updateConfig({ vad: true, stt: true });

      // Note: Config update doesn't affect already-initialized plugins
      expect(manager.isEnabled('vad')).toBe(true);
      expect(manager.isEnabled('stt')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('Updating PluginManager configuration', expect.any(Object));
    });
  });

  // =========================================================================
  // ASR-R-04: sttSocket / pipelineId wiring from config to pipeline
  // =========================================================================

  describe('ASR-R-04: backend STT config wiring', () => {
    it('should pass pipelineId through to transcription pipeline config', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            pipelineId: 'my-pipeline-slug',
          },
        },
        mockLogger,
      );

      // Access the built config via the exposed method
      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.pipelineId).toBe('my-pipeline-slug');
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

    it('should leave sttSocket and pipelineId undefined when not configured', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'local',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.sttSocket).toBeUndefined();
      expect(config.stt.pipelineId).toBeUndefined();
    });

    it('should set location to backend when provider is backend', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            pipelineId: 'default',
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
      expect(config.stt.pipelineId).toBeUndefined();
    });

    it('should handle boolean shorthand stt: true (no sttSocket or pipelineId)', () => {
      const manager = new PluginManager({ stt: true }, mockLogger);

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.enabled).toBe(true);
      expect(config.stt.sttSocket).toBeUndefined();
      expect(config.stt.pipelineId).toBeUndefined();
    });

    it('should handle both pipelineId and sttSocket together', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'backend',
            pipelineId: 'custom-pipe',
            sttSocket: 'wss://custom.host/ws/stt',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.pipelineId).toBe('custom-pipe');
      expect(config.stt.sttSocket).toBe('wss://custom.host/ws/stt');
      expect(config.stt.location).toBe('backend');
      expect(config.stt.provider).toBe('backend');
    });

    it('should set location to browser when provider is local', () => {
      const manager = new PluginManager(
        {
          stt: {
            enabled: true,
            provider: 'local',
          },
        },
        mockLogger,
      );

      const config = manager.getTranscriptionPipelineConfig();
      expect(config.stt.location).toBe('browser');
    });
  });

  describe('NER management', () => {
    describe('setNERConfig', () => {
      it('should set NER config when enabled', () => {
        const manager = new PluginManager({}, mockLogger);
        const nerConfig = {
          enabled: true,
          model: 'biomedical',
          threshold: 0.7,
          entityTypes: ['CONDITION', 'MEDICATION'],
        };

        manager.setNERConfig(nerConfig);

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'NER config updated',
          expect.objectContaining({
            attributes: expect.objectContaining({
              enabled: true,
              model: 'biomedical',
            }),
          }),
        );
      });

      it('should clear NER config when disabled', () => {
        const manager = new PluginManager({}, mockLogger);

        manager.setNERConfig({ enabled: false });

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'NER config updated',
          expect.objectContaining({
            attributes: expect.objectContaining({
              enabled: false,
            }),
          }),
        );
      });

      it('should clear NER config when undefined', () => {
        const manager = new PluginManager({}, mockLogger);

        manager.setNERConfig(undefined);

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'NER config updated',
          expect.objectContaining({
            attributes: expect.objectContaining({
              enabled: false,
            }),
          }),
        );
      });
    });

    describe('initializeNER', () => {
      it('should initialize NER processor when config is enabled', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({
          enabled: true,
          model: 'biomedical',
          threshold: 0.6,
        });

        await manager.initializeNER();

        expect(mockMedNERProcessor.init).toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith(
          'NER processor initialized',
          expect.objectContaining({
            success: true,
          }),
        );
      });

      it('should not initialize NER when config is disabled', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({ enabled: false });

        await manager.initializeNER();

        expect(mockMedNERProcessor.init).not.toHaveBeenCalled();
      });

      it('should not initialize NER when config is not set', async () => {
        const manager = new PluginManager({}, mockLogger);

        await manager.initializeNER();

        expect(mockMedNERProcessor.init).not.toHaveBeenCalled();
      });

      it('should handle NER initialization errors', async () => {
        const manager = new PluginManager({}, mockLogger);
        const onError = vi.fn();
        manager.setCallbacks({ onError });
        manager.setNERConfig({ enabled: true });

        const initError = new Error('NER init failed');
        mockMedNERProcessor.init.mockRejectedValue(initError);

        await manager.initializeNER();

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Failed to initialize NER plugin',
          expect.objectContaining({
            error: initError,
          }),
        );
        expect(onError).toHaveBeenCalledWith(initError, 'ner');
      });

      it('should use default NER config values when not specified', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({ enabled: true });

        await manager.initializeNER();

        expect(mockMedNERProcessor.init).toHaveBeenCalled();
      });
    });

    describe('extractEntities', () => {
      it('should extract entities when NER processor is initialized', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({ enabled: true });
        await manager.initializeNER();

        const result = await manager.extractEntities('Patient has diabetes');

        expect(result).not.toBeNull();
        expect(result?.text).toBe('test text');
        expect(result?.entities).toHaveLength(1);
        expect(result?.entities[0]?.text).toBe('diabetes');
        expect(result?.entities[0]?.type).toBe('CONDITION');
        expect(mockMedNERProcessor.extract).toHaveBeenCalledWith('Patient has diabetes');
      });

      it('should return null when NER processor is not initialized', async () => {
        const manager = new PluginManager({}, mockLogger);

        const result = await manager.extractEntities('Patient has diabetes');

        expect(result).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith('NER processor not initialized', expect.any(Object));
        expect(mockMedNERProcessor.extract).not.toHaveBeenCalled();
      });

      it('should handle extraction errors', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({ enabled: true });
        await manager.initializeNER();

        const extractError = new Error('Extraction failed');
        mockMedNERProcessor.extract.mockRejectedValue(extractError);

        await expect(manager.extractEntities('test')).rejects.toThrow('Extraction failed');
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Entity extraction failed',
          expect.objectContaining({
            error: extractError,
          }),
        );
      });
    });

    describe('isNERAvailable', () => {
      it('should return false when NER processor is not initialized', () => {
        const manager = new PluginManager({}, mockLogger);

        expect(manager.isNERAvailable()).toBe(false);
      });

      it('should return true when NER processor is initialized', async () => {
        const manager = new PluginManager({}, mockLogger);
        manager.setNERConfig({ enabled: true });
        await manager.initializeNER();

        expect(manager.isNERAvailable()).toBe(true);
      });
    });
  });

  describe('getTranscriptionPipeline / getKnowledgePipeline', () => {
    it('should return null for transcription pipeline when not initialized', () => {
      const manager = new PluginManager({}, mockLogger);

      expect(manager.getTranscriptionPipeline()).toBeNull();
    });

    it('should return transcription pipeline after initialization', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
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

    it('should accept partial config override', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initializeKnowledgePipeline({
        ner: { enabled: true, location: 'backend', triggerMode: 'manual' },
      });

      expect(mockKnowledgePipeline.init).toHaveBeenCalled();
    });
  });

  describe('destroy with pipelines', () => {
    it('should destroy transcription pipeline on destroy', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
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

    it('should destroy NER processor on destroy', async () => {
      const manager = new PluginManager({}, mockLogger);
      manager.setNERConfig({ enabled: true });
      await manager.initializeNER();

      await manager.destroy();

      expect(mockMedNERProcessor.destroy).toHaveBeenCalled();
      expect(manager.isNERAvailable()).toBe(false);
    });

    it('should destroy all pipelines and NER processor together', async () => {
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      manager.setNERConfig({ enabled: true });

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);
      await manager.initializeKnowledgePipeline();
      await manager.initializeNER();

      const transcriptionPipeline = manager.getTranscriptionPipeline();
      const transcriptionDestroySpy = vi.spyOn(transcriptionPipeline!, 'destroy');

      await manager.destroy();

      expect(transcriptionDestroySpy).toHaveBeenCalled();
      expect(mockKnowledgePipeline.destroy).toHaveBeenCalled();
      expect(mockMedNERProcessor.destroy).toHaveBeenCalled();
      expect(manager.getTranscriptionPipeline()).toBeNull();
      expect(manager.getKnowledgePipeline()).toBeNull();
      expect(manager.isNERAvailable()).toBe(false);
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
  // REFACTOR-04: NER processor should be properly typed
  // =========================================================================

  describe('REFACTOR-04: typed NER processor', () => {
    it('nerProcessor field should not be typed as unknown', () => {
      const manager = new PluginManager({}, mockLogger);
      // If nerProcessor is properly typed as INERProcessor | null,
      // accessing it should not require inline type casts.
      // We verify the field is null initially (typed, not unknown).
      const processor = (manager as any).nerProcessor;
      expect(processor).toBeNull();
    });

    it('destroy should call nerProcessor.destroy() without inline cast', async () => {
      const manager = new PluginManager({}, mockLogger);
      const mockDestroy = vi.fn().mockResolvedValue(undefined);
      (manager as any).nerProcessor = {
        init: vi.fn(),
        extract: vi.fn(),
        destroy: mockDestroy,
      };

      await manager.destroy();

      expect(mockDestroy).toHaveBeenCalled();
      expect((manager as any).nerProcessor).toBeNull();
    });
  });

  // =========================================================================
  // ENH-04: STT processing state tracking
  // =========================================================================

  describe('ENH-04: STT processing state tracking', () => {
    it('should report isProcessing=true while STT is actively processing', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'auto' } }, mockLogger);

      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      manager.setSttProcessing(true);
      const states = manager.getStates();
      expect(states.stt.isProcessing).toBe(true);
    });

    it('should report isProcessing=false when STT finishes processing', async () => {
      const manager = new PluginManager({ stt: { enabled: true, provider: 'auto' } }, mockLogger);

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
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
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
      const manager = new PluginManager({ noiseFilter: true }, mockLogger);
      await manager.initialize({} as MediaStreamTrack, {} as AudioContext);

      const pipeline = manager.getTranscriptionPipeline();
      expect(() => (pipeline as unknown as { emit(event: string, payload: number): void }).emit('audioDrop', 1)).not.toThrow();
    });
  });
});
