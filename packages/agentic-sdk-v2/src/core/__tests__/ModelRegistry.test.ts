/**
 * ModelRegistry Unit Tests
 *
 * Tests for the ML model registry.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelRegistry } from '../ModelRegistry';
import { AgenticClient } from '../AgenticClient';
import { AgenticError, DEFAULT_MODELS } from '../../types';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';

// Shared storage object
const registryStorageData: Record<string, string> = {};

describe('ModelRegistry', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    // Clear storage data
    Object.keys(registryStorageData).forEach((key) => delete registryStorageData[key]);

    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'key' }, mockLogger);

    // Mock window and localStorage for Node.js environment
    const localStorageMock = {
      getItem: (key: string) => registryStorageData[key] || null,
      setItem: (key: string, value: string) => {
        registryStorageData[key] = value;
      },
      removeItem: (key: string) => {
        delete registryStorageData[key];
      },
      clear: () => {
        Object.keys(registryStorageData).forEach((k) => delete registryStorageData[k]);
      },
      length: 0,
      key: (_index: number) => null,
    };
    (global as any).window = {};
    (global as any).localStorage = localStorageMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as any).window;
    delete (global as any).localStorage;
  });

  describe('constructor', () => {
    it('should initialize with default models', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      const models = registry.getModels();
      expect(models.length).toBeGreaterThanOrEqual(DEFAULT_MODELS.length);
    });

    it('should add custom models from config', () => {
      const customModel = {
        id: 'custom-stt',
        name: 'Custom STT',
        type: 'stt' as const,
        source: 'backend' as const,
      };

      const registry = new ModelRegistry({ custom: [customModel] }, mockApiClient, mockLogger);

      expect(registry.getModel('custom-stt')).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Custom models added from config', expect.any(Object));
    });

    it('should load selected models from config', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny' } }, mockApiClient);

      expect(registry.getSelectedModelId('stt')).toBe('whisper-tiny');
    });

    it('should load selected models from localStorage', () => {
      // A registry with no namespace fail-closes to
      // `pre-login`, never the bare global key.
      registryStorageData['arcaai-selected-models/pre-login'] = JSON.stringify({ vad: 'silero-vad-v5' });

      const registry = new ModelRegistry({}, mockApiClient);

      expect(registry.getSelectedModelId('vad')).toBe('silero-vad-v5');
    });
  });

  describe('getModels', () => {
    it('should return all models', () => {
      const registry = new ModelRegistry({}, mockApiClient);
      const models = registry.getModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('getModelsByType', () => {
    it('should filter models by type', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      const sttModels = registry.getModelsByType('stt');
      const vadModels = registry.getModelsByType('vad');

      expect(sttModels.every((m) => m.type === 'stt')).toBe(true);
      expect(vadModels.every((m) => m.type === 'vad')).toBe(true);
    });
  });

  describe('getModel', () => {
    it('should return model by ID', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      const model = registry.getModel('whisper-tiny');
      expect(model).toBeDefined();
      expect(model?.id).toBe('whisper-tiny');
    });

    it('should return undefined for non-existent model', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      expect(registry.getModel('non-existent')).toBeUndefined();
    });
  });

  describe('selectModel', () => {
    it('should select model', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      registry.selectModel('stt', 'whisper-tiny');

      expect(registry.getSelectedModelId('stt')).toBe('whisper-tiny');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Model selected',
        expect.objectContaining({
          attributes: expect.objectContaining({
            type: 'stt',
            modelId: 'whisper-tiny',
          }),
        }),
      );
    });

    it('should save selection to localStorage', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      registry.selectModel('stt', 'whisper-tiny');

      const stored = registryStorageData['arcaai-selected-models/pre-login'];
      expect(stored).toBeDefined();
      expect(stored).toContain('whisper-tiny');
    });

    it('should throw for non-existent model', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      expect(() => registry.selectModel('stt', 'non-existent')).toThrow(AgenticError);
      expect(mockLogger.error).toHaveBeenCalledWith('Model not found for selection', expect.any(Object));
    });

    it('should throw for type mismatch', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      // Trying to select a VAD model as STT
      expect(() => registry.selectModel('stt', 'silero-vad-v5')).toThrow(AgenticError);
      expect(mockLogger.error).toHaveBeenCalledWith('Model type mismatch', expect.any(Object));
    });
  });

  describe('getSelectedModel', () => {
    it('should return selected model definition', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny' } }, mockApiClient);

      const model = registry.getSelectedModel('stt');
      expect(model).toBeDefined();
      expect(model?.id).toBe('whisper-tiny');
    });

    it('should return undefined when no selection', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      expect(registry.getSelectedModel('stt')).toBeUndefined();
    });
  });

  describe('getSelected', () => {
    it('should return all selected model IDs', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny', vad: 'silero-vad-v5' } }, mockApiClient);

      const selected = registry.getSelected();
      expect(selected.stt).toBe('whisper-tiny');
      expect(selected.vad).toBe('silero-vad-v5');
    });

    it('should return copy', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny' } }, mockApiClient);

      const selected1 = registry.getSelected();
      const selected2 = registry.getSelected();

      expect(selected1).not.toBe(selected2);
    });
  });

  describe('clearSelection', () => {
    it('should clear selection for type', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny', vad: 'silero-vad-v5' } }, mockApiClient, mockLogger);

      registry.clearSelection('stt');

      expect(registry.getSelectedModelId('stt')).toBeUndefined();
      expect(registry.getSelectedModelId('vad')).toBe('silero-vad-v5');
    });
  });

  describe('addCustomModels', () => {
    it('should add models to registry', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      registry.addCustomModels([
        { id: 'custom-1', name: 'Custom 1', type: 'stt', source: 'backend' },
        { id: 'custom-2', name: 'Custom 2', type: 'vad', source: 'backend' },
      ]);

      expect(registry.getModel('custom-1')).toBeDefined();
      expect(registry.getModel('custom-2')).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Custom models added', expect.any(Object));
    });
  });

  describe('loadTenantConfig', () => {
    function makeTenantSettings(overrides: Record<string, string> = {}) {
      const defaults: Record<string, { value: string; namespace: string }> = {
        'default-stt-model': { value: 'whisper-large-v3', namespace: 'stt' },
        'vad-sensitivity': { value: '0.7', namespace: 'stt' },
        'default-smr-provider': { value: 'ollama', namespace: 'smr' },
        'default-smr-model': { value: 'llama3.1:8b', namespace: 'smr' },
        'default-language': { value: 'en', namespace: 'general' },
        'enable-real-time-transcription': { value: 'true', namespace: 'feature-flags' },
        'enable-ner-extraction': { value: 'true', namespace: 'feature-flags' },
        'enable-code-switching': { value: 'false', namespace: 'feature-flags' },
        'enable-dna-style': { value: 'true', namespace: 'feature-flags' },
        'enable-cross-chain-summary': { value: 'false', namespace: 'feature-flags' },
      };

      return Object.entries(defaults).map(([key, def]) => ({
        id: `setting-${key}`,
        key,
        value: overrides[key] ?? def.value,
        namespace: def.namespace,
        name: key,
      }));
    }

    function wrapPaginated<T>(data: T[]) {
      return { data, count: data.length, limit: 100, page: 1 };
    }

    it('should fetch tenant config without requiring a tenantId argument', async () => {
      const settings = makeTenantSettings();
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(settings)));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      const config = await registry.loadTenantConfig();

      expect(config.defaultSttModel).toBe('whisper-large-v3');
      expect(config.vadSensitivity).toBe(0.7);
      expect(config.defaultSmrProvider).toBe('ollama');
      expect(config.defaultSmrModel).toBe('llama3.1:8b');
      expect(config.defaultLanguage).toBe('en');
    });

    it('should parse feature flags from tenant config', async () => {
      const settings = makeTenantSettings({
        'enable-code-switching': 'true',
        'enable-cross-chain-summary': 'true',
      });
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(settings)));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      const config = await registry.loadTenantConfig();

      expect(config.features.realTimeTranscription).toBe(true);
      expect(config.features.nerExtraction).toBe(true);
      expect(config.features.codeSwitching).toBe(true);
      expect(config.features.dnaStyle).toBe(true);
      expect(config.features.crossChainSummary).toBe(true);
    });

    it('should auto-select STT model from built-in catalog when slug matches', async () => {
      const settings = makeTenantSettings({ 'default-stt-model': 'whisper-small' });
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(settings)));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      await registry.loadTenantConfig();

      expect(registry.getSelectedModelId('stt')).toBe('whisper-small');
    });

    it('should not override STT selection when slug does not match any built-in model', async () => {
      const settings = makeTenantSettings({ 'default-stt-model': 'unknown-backend-model' });
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(settings)));

      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny' } }, mockApiClient, mockLogger);
      await registry.loadTenantConfig();

      expect(registry.getSelectedModelId('stt')).toBe('whisper-tiny');
    });

    it('should call the auth-based tenant config endpoint (no tenantId in URL)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(makeTenantSettings())));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      await registry.loadTenantConfig();

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/tenant/me/config'), expect.any(Object));
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('/admin/'), expect.any(Object));
    });

    it('should handle backend failure gracefully and return default config', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      const config = await registry.loadTenantConfig();

      expect(config.features.realTimeTranscription).toBe(true);
      expect(config.defaultSttModel).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Failed to load tenant config (using defaults)', expect.any(Object));
    });

    it('should handle empty settings array', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated([])));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      const config = await registry.loadTenantConfig();

      expect(config.defaultSttModel).toBeUndefined();
      expect(config.features.realTimeTranscription).toBe(true);
      expect(config.features.codeSwitching).toBe(false);
    });

    it('should store tenant config for later retrieval via getTenantConfig()', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(wrapPaginated(makeTenantSettings())));

      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      await registry.loadTenantConfig();

      const stored = registry.getTenantConfig();
      expect(stored).not.toBeNull();
      expect(stored?.defaultSttModel).toBe('whisper-large-v3');
    });
  });

  describe('getModelUrl', () => {
    it('should return URL for HuggingFace models', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      const url = registry.getModelUrl('whisper-tiny');
      expect(url).toBe('onnx-community/whisper-tiny');
    });

    it('should return URL for custom models', () => {
      const customModel = {
        id: 'custom-stt',
        name: 'Custom',
        type: 'stt' as const,
        source: 'backend' as const,
        url: 'https://models.example.com/custom-stt',
      };

      const registry = new ModelRegistry({ custom: [customModel] }, mockApiClient);

      expect(registry.getModelUrl('custom-stt')).toBe('https://models.example.com/custom-stt');
    });

    it('should return undefined for non-existent model', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      expect(registry.getModelUrl('non-existent')).toBeUndefined();
    });
  });

  describe('loading state', () => {
    it('should track loading state', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);

      expect(registry.isModelLoading('whisper-tiny')).toBe(false);
      expect(registry.isModelLoaded('whisper-tiny')).toBe(false);

      registry.markLoading('whisper-tiny');
      expect(registry.isModelLoading('whisper-tiny')).toBe(true);
      expect(registry.getLoadProgress('whisper-tiny')).toBe(0);

      registry.updateProgress('whisper-tiny', 50);
      expect(registry.getLoadProgress('whisper-tiny')).toBe(50);

      registry.markLoaded('whisper-tiny');
      expect(registry.isModelLoading('whisper-tiny')).toBe(false);
      expect(registry.isModelLoaded('whisper-tiny')).toBe(true);
      expect(registry.getLoadProgress('whisper-tiny')).toBe(100);
    });

    it('should track loading errors', () => {
      const registry = new ModelRegistry({}, mockApiClient, mockLogger);
      const error = new Error('Load failed');

      registry.markLoading('whisper-tiny');
      registry.markFailed('whisper-tiny', error);

      expect(registry.isModelLoading('whisper-tiny')).toBe(false);
      expect(registry.getLoadError('whisper-tiny')).toBe(error);
      expect(mockLogger.error).toHaveBeenCalledWith('Model load failed', expect.any(Object));
    });

    it('should return loading models list', () => {
      const registry = new ModelRegistry({}, mockApiClient);

      registry.markLoading('whisper-tiny');
      registry.markLoading('whisper-base');

      expect(registry.getLoadingModels()).toContain('whisper-tiny');
      expect(registry.getLoadingModels()).toContain('whisper-base');
    });
  });

  describe('getState', () => {
    it('should return complete registry state', () => {
      const registry = new ModelRegistry({ selected: { stt: 'whisper-tiny' } }, mockApiClient);

      registry.markLoading('whisper-base');
      registry.markLoaded('whisper-tiny');
      registry.markFailed('whisper-small', new Error('Failed'));

      const state = registry.getState();

      expect(state.models.length).toBeGreaterThan(0);
      expect(state.selected.stt).toBe('whisper-tiny');
      expect(state.loading).toContain('whisper-base');
      expect(state.loaded).toContain('whisper-tiny');
      expect(state.errors['whisper-small']).toBe('Failed');
    });
  });

  // =========================================================================
  // REFACTOR-07: destroy() clears all internal maps
  // =========================================================================

  describe('REFACTOR-07: destroy()', () => {
    it('should clear all internal state maps', () => {
      const reg = new ModelRegistry({ custom: [], selected: {} }, mockApiClient, mockLogger);

      reg.selectModel('stt', 'whisper-tiny');
      reg.markLoading('whisper-base');
      reg.markLoaded('whisper-tiny');
      reg.markFailed('whisper-small', new Error('Failed'));

      reg.destroy();

      const state = reg.getState();
      expect(state.models).toEqual([]);
      expect(state.selected).toEqual({});
      expect(state.loading).toEqual([]);
      expect(state.loaded).toEqual([]);
      expect(state.errors).toEqual({});
    });
  });
});
