/**
 * PipelineRegistry Unit Tests — ASR-R-06
 *
 * TDD tests for backend ASR pipeline discovery.
 * Backend AI model fetching was removed — models now come from tenant config
 * via ModelRegistry.loadTenantConfig().
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineRegistry } from '../PipelineRegistry';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';
import { AgenticClient } from '../AgenticClient';
import { PIPELINE_ENDPOINTS } from '../constants';
import type {
  AsrPipelineResponse,
} from '../../types/stt-v2';
import { ResourceStatus } from '../../types/stt-v2';

// ===========================================================================
// Fixtures
// ===========================================================================

function createMockPipeline(overrides: Partial<AsrPipelineResponse> = {}): AsrPipelineResponse {
  return {
    id: 'pipeline-001',
    name: 'Default Whisper Pipeline',
    slug: 'default-whisper',
    description: 'Default STT pipeline using Whisper',
    configYaml: 'stages:\n  - whisper-base',
    resourceStatus: ResourceStatus.ENABLED,
    tags: ['stt', 'whisper'],
    tenantId: 'tenant-001',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('PipelineRegistry', () => {
  let registry: PipelineRegistry;
  let apiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    apiClient = new AgenticClient(
      { baseUrl: 'https://api.example.com', apiKey: 'test-key' },
      mockLogger,
    );
    registry = new PipelineRegistry(apiClient, mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(registry).toBeDefined();
    });

    it('should start with empty pipelines', () => {
      expect(registry.getPipelines()).toEqual([]);
    });
  });

  // =========================================================================
  // loadPipelines
  // =========================================================================

  describe('loadPipelines', () => {
    it('should fetch pipelines from backend', async () => {
      const pipelines = [
        createMockPipeline({ id: 'p1', name: 'Pipeline 1' }),
        createMockPipeline({ id: 'p2', name: 'Pipeline 2' }),
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(pipelines));

      await registry.loadPipelines();

      expect(registry.getPipelines()).toHaveLength(2);
      expect(registry.getPipelines()[0].name).toBe('Pipeline 1');
    });

    it('should call the correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await registry.loadPipelines();

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(PIPELINE_ENDPOINTS.LIST);
    });

    it('should replace existing pipelines on reload', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();
      expect(registry.getPipelines()).toHaveLength(1);

      const newPipelines = [
        createMockPipeline({ id: 'p-new-1' }),
        createMockPipeline({ id: 'p-new-2' }),
        createMockPipeline({ id: 'p-new-3' }),
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(newPipelines));
      await registry.loadPipelines();
      expect(registry.getPipelines()).toHaveLength(3);
    });

    it('should not throw on API error (graceful fallback)', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

      await expect(registry.loadPipelines()).resolves.not.toThrow();
      expect(registry.getPipelines()).toEqual([]);
    });

    it('should preserve existing cache when reload fails', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([createMockPipeline({ id: 'cached-pipe' })])
      );
      await registry.loadPipelines();
      expect(registry.getPipelines()).toHaveLength(1);

      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Fail'));
      await registry.loadPipelines();

      expect(registry.getPipelines()).toHaveLength(1);
      expect(registry.getPipelines()[0].id).toBe('cached-pipe');
    });

    it('should handle non-array response gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ pipelines: [] })
      );

      await expect(registry.loadPipelines()).resolves.not.toThrow();
      expect(registry.getPipelines()).toEqual([]);
    });

    it('should handle empty array response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));
      await registry.loadPipelines();

      expect(registry.getPipelines()).toEqual([]);
      expect(registry.getState().isLoaded).toBe(true);
    });
  });

  // =========================================================================
  // getPipelineById / getPipelineBySlug
  // =========================================================================

  describe('getPipelineById', () => {
    it('should return a pipeline by ID from cache', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([createMockPipeline({ id: 'p-abc' })])
      );
      await registry.loadPipelines();

      const pipeline = registry.getPipelineById('p-abc');
      expect(pipeline).toBeDefined();
      expect(pipeline!.id).toBe('p-abc');
    });

    it('should return undefined for unknown ID', () => {
      expect(registry.getPipelineById('unknown')).toBeUndefined();
    });

    it('should return undefined for empty string id', () => {
      expect(registry.getPipelineById('')).toBeUndefined();
    });
  });

  describe('getPipelineBySlug', () => {
    it('should return a pipeline by slug from cache', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([createMockPipeline({ slug: 'my-pipe' })])
      );
      await registry.loadPipelines();

      const pipeline = registry.getPipelineBySlug('my-pipe');
      expect(pipeline).toBeDefined();
      expect(pipeline!.slug).toBe('my-pipe');
    });

    it('should return undefined for unknown slug', () => {
      expect(registry.getPipelineBySlug('nope')).toBeUndefined();
    });

    it('should return undefined for empty string slug', () => {
      expect(registry.getPipelineBySlug('')).toBeUndefined();
    });
  });

  describe('getPipelines returns a copy', () => {
    it('should return a new array each call (not a mutable reference)', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([createMockPipeline()])
      );
      await registry.loadPipelines();

      const first = registry.getPipelines();
      const second = registry.getPipelines();

      expect(first).toEqual(second);
      expect(first).not.toBe(second);

      first.length = 0;
      expect(registry.getPipelines()).toHaveLength(1);
    });
  });

  // =========================================================================
  // loadAll (convenience — now pipelines only)
  // =========================================================================

  describe('loadAll', () => {
    it('should load pipelines', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));

      await registry.loadAll();

      expect(registry.getPipelines()).toHaveLength(1);
    });

    it('should not throw when pipeline load fails', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Fail'));

      await expect(registry.loadAll()).resolves.not.toThrow();
      expect(registry.getPipelines()).toEqual([]);
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('should return full registry state', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));

      await registry.loadAll();
      const state = registry.getState();

      expect(state.pipelines).toHaveLength(1);
      expect(state.isLoaded).toBe(true);
    });

    it('should show isLoaded as false before loading', () => {
      expect(registry.getState().isLoaded).toBe(false);
    });

    it('should include staleness field in state', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));

      await registry.loadAll();
      const state = registry.getState();

      expect(state).toHaveProperty('isPipelinesStale');
      expect(state.isPipelinesStale).toBe(false);
    });
  });

  // =========================================================================
  // Cache TTL and Staleness
  // =========================================================================

  describe('cache TTL (default 5min)', () => {
    it('should not be stale immediately after load', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();

      expect(registry.isPipelinesStale()).toBe(false);
    });

    it('should become stale after TTL elapses', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();
      expect(registry.isPipelinesStale()).toBe(false);

      vi.advanceTimersByTime(300_001);
      expect(registry.isPipelinesStale()).toBe(true);

      vi.useRealTimers();
    });

    it('should not be stale before TTL elapses', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();

      vi.advanceTimersByTime(299_999);
      expect(registry.isPipelinesStale()).toBe(false);

      vi.useRealTimers();
    });

    it('should not be stale when never loaded', () => {
      expect(registry.isPipelinesStale()).toBe(false);
    });

    it('should report staleness in getState()', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadAll();

      vi.advanceTimersByTime(300_001);

      const state = registry.getState();
      expect(state.isPipelinesStale).toBe(true);

      vi.useRealTimers();
    });

    it('should reset staleness after reload', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();

      vi.advanceTimersByTime(300_001);
      expect(registry.isPipelinesStale()).toBe(true);

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();
      expect(registry.isPipelinesStale()).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('custom cache TTL', () => {
    it('should respect custom cacheTtlMs', async () => {
      vi.useFakeTimers();

      const shortTtlRegistry = new PipelineRegistry(apiClient, mockLogger, { cacheTtlMs: 10_000 });
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await shortTtlRegistry.loadPipelines();

      vi.advanceTimersByTime(10_001);
      expect(shortTtlRegistry.isPipelinesStale()).toBe(true);

      vi.useRealTimers();
    });

    it('should never be stale when cacheTtlMs is 0 (disabled)', async () => {
      vi.useFakeTimers();

      const noTtlRegistry = new PipelineRegistry(apiClient, mockLogger, { cacheTtlMs: 0 });
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await noTtlRegistry.loadPipelines();

      vi.advanceTimersByTime(999_999_999);
      expect(noTtlRegistry.isPipelinesStale()).toBe(false);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // invalidate
  // =========================================================================

  describe('invalidate', () => {
    it('should clear all cached pipelines', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadAll();

      expect(registry.getPipelines()).toHaveLength(1);

      registry.invalidate();

      expect(registry.getPipelines()).toEqual([]);
    });

    it('should reset isLoaded to false', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadAll();
      expect(registry.getState().isLoaded).toBe(true);

      registry.invalidate();
      expect(registry.getState().isLoaded).toBe(false);
    });

    it('should reset staleness tracking', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadPipelines();
      vi.advanceTimersByTime(300_001);
      expect(registry.isPipelinesStale()).toBe(true);

      registry.invalidate();
      expect(registry.isPipelinesStale()).toBe(false);

      vi.useRealTimers();
    });

    it('should be safe to call when nothing is loaded', () => {
      expect(() => registry.invalidate()).not.toThrow();
      expect(registry.getState().isLoaded).toBe(false);
    });
  });

  // =========================================================================
  // refresh
  // =========================================================================

  describe('refresh', () => {
    it('should invalidate and reload all data', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline({ id: 'old-pipe' })]));
      await registry.loadAll();
      expect(registry.getPipelineById('old-pipe')).toBeDefined();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline({ id: 'new-pipe' })]));
      await registry.refresh();

      expect(registry.getPipelineById('old-pipe')).toBeUndefined();
      expect(registry.getPipelineById('new-pipe')).toBeDefined();
    });

    it('should reset staleness after refresh', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadAll();

      vi.advanceTimersByTime(300_001);
      expect(registry.isPipelinesStale()).toBe(true);

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.refresh();
      expect(registry.isPipelinesStale()).toBe(false);

      vi.useRealTimers();
    });

    it('should keep isLoaded true after refresh', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.loadAll();

      mockFetch.mockResolvedValueOnce(createMockResponse([createMockPipeline()]));
      await registry.refresh();

      expect(registry.getState().isLoaded).toBe(true);
    });
  });

  // =========================================================================
  // Edge: concurrent loadPipelines calls
  // =========================================================================

  describe('concurrent loads', () => {
    it('should not corrupt state when loadPipelines is called twice concurrently', async () => {
      const p1 = [createMockPipeline({ id: 'batch-1-pipe', name: 'Batch 1' })];
      const p2 = [createMockPipeline({ id: 'batch-2-pipe', name: 'Batch 2' })];

      mockFetch
        .mockResolvedValueOnce(createMockResponse(p1))
        .mockResolvedValueOnce(createMockResponse(p2));

      await Promise.all([registry.loadPipelines(), registry.loadPipelines()]);

      const pipelines = registry.getPipelines();
      expect(pipelines).toHaveLength(1);
      expect(['batch-1-pipe', 'batch-2-pipe']).toContain(pipelines[0].id);
    });
  });

  // =========================================================================
  // Edge: loadAll when pipeline load fails
  // =========================================================================

  describe('failure in loadAll', () => {
    it('should not throw and should keep empty cache when request fails', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Pipeline failure'));

      await expect(registry.loadAll()).resolves.not.toThrow();

      expect(registry.getPipelines()).toEqual([]);
      expect(registry.getState().isLoaded).toBe(false);
    });
  });
});
