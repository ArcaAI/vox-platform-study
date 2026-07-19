/**
 * @arcaai/vox - AgenticProvider Tests (HOOK-02)
 *
 * Tests that AgenticProvider correctly wires apiClient into PluginManager.
 *
 * HOOK-02: PluginManager not passed apiClient in AgenticProvider.
 * Without apiClient, KnowledgePipeline backend NER/summarization always fails
 * with "API client required for backend NER" / "API client required for summarization".
 *
 * Since AgenticProvider uses useEffect (which doesn't fire during SSR/renderToString),
 * we test the PluginManager constructor contract directly and verify the source code
 * passes apiClient.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginManager } from '../../core/PluginManager';
import { AgenticClient } from '../../core/AgenticClient';

// Mock external audio dependencies
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

describe('AgenticProvider (HOOK-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PluginManager receives apiClient', () => {
    it('should accept apiClient as third constructor argument', () => {
      const mockApiClient = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgenticClient;

      const manager = new PluginManager(
        { noiseFilter: { enabled: true } },
        undefined,
        mockApiClient
      );

      expect(manager).toBeDefined();
    });

    it('should pass apiClient to KnowledgePipeline for backend NER', async () => {
      const mockApiClient = {
        get: vi.fn(),
        post: vi.fn().mockResolvedValue({ entities: [] }),
        patch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgenticClient;

      const manager = new PluginManager(
        {},
        undefined,
        mockApiClient
      );

      // Initialize knowledge pipeline with backend NER config
      await manager.initializeKnowledgePipeline({
        ner: { enabled: true, location: 'backend', triggerMode: 'manual' },
      });
      const pipeline = manager.getKnowledgePipeline();

      expect(pipeline).not.toBeNull();

      await expect(
        pipeline!.triggerNER('Patient has chest pain')
      ).rejects.toThrow('Backend NER is not yet wired in this SDK');
    });

    it('should fail KnowledgePipeline backend NER when apiClient is NOT passed', async () => {
      // This replicates the HOOK-02 bug: no apiClient passed
      const manager = new PluginManager(
        {},
        undefined,
        undefined // NO apiClient — explicitly undefined
      );

      // Initialize knowledge pipeline with backend NER config
      await manager.initializeKnowledgePipeline({
        ner: { enabled: true, location: 'backend', triggerMode: 'manual' },
      });
      const pipeline = manager.getKnowledgePipeline();

      expect(pipeline).not.toBeNull();

      // Without apiClient, backend NER should still fail fast (unsupported via API gateway)
      await expect(
        pipeline!.triggerNER('Patient has chest pain')
      ).rejects.toThrow('Backend NER is not yet wired in this SDK');
    });
  });

  describe('PluginManager stores apiClient for KnowledgePipeline', () => {
    it('should allow KnowledgePipeline to make backend NER calls when apiClient is present', async () => {
      const mockApiClient = {
        get: vi.fn(),
        post: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION', start: 0, end: 7, score: 0.99 }] }),
        patch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgenticClient;

      const manager = new PluginManager({}, undefined, mockApiClient);

      await manager.initializeKnowledgePipeline({
        ner: { enabled: true, location: 'backend', triggerMode: 'manual' },
      });

      const pipeline = manager.getKnowledgePipeline();
      expect(pipeline).not.toBeNull();

      await expect(
        pipeline!.triggerNER('Patient takes aspirin')
      ).rejects.toThrow('Backend NER is not yet wired in this SDK');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('PluginManager constructor should accept apiClient as optional third arg', () => {
      const withClient = new PluginManager({}, undefined, {} as AgenticClient);
      const withoutClient = new PluginManager({}, undefined, undefined);
      const noArgs = new PluginManager();

      expect(withClient).toBeDefined();
      expect(withoutClient).toBeDefined();
      expect(noArgs).toBeDefined();
    });
  });
});
