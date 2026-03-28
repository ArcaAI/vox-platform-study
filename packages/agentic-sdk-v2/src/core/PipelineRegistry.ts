/**
 * @arcaai/vox - PipelineRegistry
 *
 * Discovers and caches backend ASR pipeline configurations and AI models.
 * Fetches from:
 *   - GET /api/v1/pipelines (ASR pipeline configs)
 *   - GET /api/v1/ai-models (AI model catalog)
 *
 * @see SDK-206 Gap Analysis — ASR-R-06
 */

import type { AgenticClient } from './AgenticClient';
import { PIPELINE_ENDPOINTS } from './constants';
import { withRetry } from '../utils/errorUtils';
import type { ISDKLogger } from './logger';
import type { AsrPipelineResponse } from '../types/stt-v2';

/**
 * Configuration options for PipelineRegistry.
 */
export interface PipelineRegistryOptions {
  /**
   * Cache time-to-live in milliseconds.
   * After this duration, the next read operation returns stale data
   * and triggers a background refresh. Set to 0 to disable TTL (cache never expires).
   * Default: 5 minutes (300_000ms).
   */
  cacheTtlMs?: number;
}

/**
 * PipelineRegistry state snapshot
 */
export interface PipelineRegistryState {
  pipelines: AsrPipelineResponse[];
  isLoaded: boolean;
  /** Whether the pipelines cache has expired (stale) */
  isPipelinesStale: boolean;
}

/**
 * Discovers and caches backend ASR pipelines and AI models.
 *
 * Usage:
 * ```typescript
 * const registry = new PipelineRegistry(apiClient, logger);
 * await registry.loadAll();
 *
 * const pipelines = registry.getPipelines();
 * const sttModels = registry.getBackendModelsByTask('AUTOMATIC_SPEECH_RECOGNITION');
 * ```
 */
export class PipelineRegistry {
  private apiClient: AgenticClient;
  private logger?: ISDKLogger;

  private pipelines: AsrPipelineResponse[] = [];
  private pipelinesLoaded = false;

  /** Timestamp of last successful pipeline fetch (ms since epoch) */
  private pipelinesLoadedAt = 0;

  /** Cache TTL in ms. 0 = no expiry. Default 5 min. */
  private readonly cacheTtlMs: number;

  constructor(apiClient: AgenticClient, logger?: ISDKLogger, options?: PipelineRegistryOptions) {
    this.apiClient = apiClient;
    this.logger = logger;
    this.cacheTtlMs = options?.cacheTtlMs ?? 300_000; // 5 minutes default
  }

  // ===========================================================================
  // Pipeline operations
  // ===========================================================================

  /**
   * Fetch ASR pipelines from backend.
   * Gracefully handles errors (logs warning, keeps existing cache).
   */
  async loadPipelines(): Promise<void> {
    const timer = this.logger?.startOperation('loadPipelines', {
      component: 'PipelineRegistry',
    });

    try {
      const result = await withRetry(() => this.apiClient.get<AsrPipelineResponse[]>(PIPELINE_ENDPOINTS.LIST), {
        maxRetries: 2,
        delayMs: 1000,
        onRetry: (attempt, error) => {
          this.logger?.warn(`Retrying loadPipelines (attempt ${attempt})`, {
            operation: 'loadPipelines',
            component: 'PipelineRegistry',
            attributes: { attempt, error: String(error) },
          });
        },
      });

      if (Array.isArray(result)) {
        this.pipelines = result;
        this.pipelinesLoaded = true;
        this.pipelinesLoadedAt = Date.now();

        timer?.end(true, {
          attributes: { count: result.length },
        });
        this.logger?.info('ASR pipelines loaded', {
          operation: 'loadPipelines',
          component: 'PipelineRegistry',
          attributes: {
            count: result.length,
            slugs: result.map((p) => p.slug),
          },
        });
      }
    } catch (error) {
      timer?.error(error as Error);
      this.logger?.warn('Failed to load ASR pipelines (using cache)', {
        operation: 'loadPipelines',
        component: 'PipelineRegistry',
        error: error as Error,
      });
    }
  }

  /**
   * Get all cached pipelines.
   */
  getPipelines(): AsrPipelineResponse[] {
    return [...this.pipelines];
  }

  /**
   * Get a pipeline by ID from cache.
   */
  getPipelineById(id: string): AsrPipelineResponse | undefined {
    return this.pipelines.find((p) => p.id === id);
  }

  /**
   * Get a pipeline by slug from cache.
   */
  getPipelineBySlug(slug: string): AsrPipelineResponse | undefined {
    return this.pipelines.find((p) => p.slug === slug);
  }

  // ===========================================================================
  // Convenience
  // ===========================================================================

  /**
   * Load all pipeline data from backend.
   */
  async loadAll(): Promise<void> {
    await this.loadPipelines();
  }

  // ===========================================================================
  // Cache management
  // ===========================================================================

  /**
   * Check if the pipelines cache has expired.
   * Returns false if TTL is 0 (disabled) or cache was never loaded.
   */
  isPipelinesStale(): boolean {
    if (this.cacheTtlMs === 0 || !this.pipelinesLoaded) return false;
    return Date.now() - this.pipelinesLoadedAt > this.cacheTtlMs;
  }

  /**
   * Invalidate all caches, forcing the next load to fetch fresh data.
   */
  invalidate(): void {
    this.pipelines = [];
    this.pipelinesLoaded = false;
    this.pipelinesLoadedAt = 0;

    this.logger?.debug('PipelineRegistry cache invalidated', {
      operation: 'invalidate',
      component: 'PipelineRegistry',
    });
  }

  /**
   * Invalidate and immediately reload all caches.
   */
  async refresh(): Promise<void> {
    this.invalidate();
    await this.loadAll();
  }

  /**
   * Get full registry state for debugging.
   */
  getState(): PipelineRegistryState {
    return {
      pipelines: this.getPipelines(),
      isLoaded: this.pipelinesLoaded,
      isPipelinesStale: this.isPipelinesStale(),
    };
  }
}
