/**
 * @arcaai/vox - ModelRegistry
 *
 * Model registry for discovering and selecting ML models with comprehensive logging.
 * Supports public (HuggingFace) and custom organization models.
 */

import type { ModelDefinition, ModelRegistryConfig, ModelLoadProgress, SelectedModels, TenantAudioConfig } from '../types';
import { DEFAULT_MODELS, DEFAULT_TENANT_FEATURES, parseTenantConfig } from '../types';
import { AgenticError } from '../types';
import type { AgenticClient } from './AgenticClient';
import { MY_TENANT_ENDPOINTS, STORAGE_KEYS } from './constants';
import { withRetry } from '../utils/errorUtils';
import type { ISDKLogger } from './logger';

/**
 * Model load progress callback
 */
export type ModelLoadProgressCallback = (progress: ModelLoadProgress) => void;

/**
 * Model registry for discovering and selecting ML models.
 *
 * Supports:
 * - Default public models from HuggingFace
 * - Custom organization models from backend
 * - Model selection per capability (STT, VAD, NER)
 * - Model loading with progress tracking
 *
 * @example
 * ```typescript
 * const registry = new ModelRegistry(
 *   {
 *     custom: [{ id: 'hospital-stt', name: 'Hospital STT', type: 'stt', source: 'backend' }],
 *     selected: { stt: 'hospital-stt' },
 *   },
 *   apiClient
 * );
 *
 * // Load custom models from backend
 * await registry.loadCustomModelsFromBackend();
 *
 * // Select a model
 * registry.selectModel('stt', 'whisper-small');
 *
 * // Get model URL for loading
 * const url = registry.getModelUrl('whisper-small');
 * ```
 */
export class ModelRegistry {
  private config: ModelRegistryConfig;
  private apiClient: AgenticClient;
  private models: Map<string, ModelDefinition> = new Map();
  private selected: SelectedModels = {};
  private loadingModels: Set<string> = new Set();
  private loadProgress: Map<string, number> = new Map();
  private loadedModels: Set<string> = new Set();
  private errors: Map<string, Error> = new Map();
  private logger?: ISDKLogger;
  private tenantConfig: TenantAudioConfig | null = null;

  constructor(config: ModelRegistryConfig, apiClient: AgenticClient, logger?: ISDKLogger) {
    this.config = config;
    this.apiClient = apiClient;
    this.logger = logger;

    // Initialize with default models
    for (const model of DEFAULT_MODELS) {
      this.models.set(model.id, model);
    }

    // Add custom models from config
    if (config.custom) {
      for (const model of config.custom) {
        this.models.set(model.id, model);
      }
      this.logger?.debug('Custom models added from config', {
        operation: 'constructor',
        component: 'ModelRegistry',
        attributes: { customModelCount: config.custom.length },
      });
    }

    // Load selected models from config or local storage
    this.selected = this.loadSelectedFromStorage() || config.selected || {};

    this.logger?.debug('ModelRegistry initialized', {
      operation: 'constructor',
      component: 'ModelRegistry',
      attributes: {
        totalModels: this.models.size,
        defaultModels: DEFAULT_MODELS.length,
        customModels: config.custom?.length || 0,
        selectedModels: Object.keys(this.selected),
      },
    });
  }

  /**
   * Get all available models
   */
  getModels(): ModelDefinition[] {
    return Array.from(this.models.values());
  }

  /**
   * Get models by type
   */
  getModelsByType(type: 'stt' | 'vad' | 'ner'): ModelDefinition[] {
    return this.getModels().filter((m) => m.type === type);
  }

  /**
   * Get a model by ID
   */
  getModel(modelId: string): ModelDefinition | undefined {
    return this.models.get(modelId);
  }

  /**
   * Get selected model for a type
   */
  getSelectedModel(type: 'stt' | 'vad' | 'ner'): ModelDefinition | undefined {
    const id = this.selected[type];
    if (!id) return undefined;
    return this.models.get(id);
  }

  /**
   * Get selected model ID for a type
   */
  getSelectedModelId(type: 'stt' | 'vad' | 'ner'): string | undefined {
    return this.selected[type];
  }

  /**
   * Get all selected model IDs
   */
  getSelected(): SelectedModels {
    return { ...this.selected };
  }

  /**
   * Select a model for a type
   */
  selectModel(type: 'stt' | 'vad' | 'ner', modelId: string): void {
    const model = this.models.get(modelId);
    if (!model) {
      this.logger?.error('Model not found for selection', {
        operation: 'selectModel',
        component: 'ModelRegistry',
        error: { code: 'NOT_FOUND', name: 'AgenticError' },
        attributes: { modelId, type },
      });
      throw new AgenticError('NOT_FOUND', `Model ${modelId} not found`);
    }
    if (model.type !== type) {
      this.logger?.error('Model type mismatch', {
        operation: 'selectModel',
        component: 'ModelRegistry',
        error: { code: 'VALIDATION_ERROR', name: 'AgenticError' },
        attributes: { modelId, expectedType: type, actualType: model.type },
      });
      throw new AgenticError('VALIDATION_ERROR', `Model ${modelId} is not a ${type} model`);
    }

    const previousModel = this.selected[type];
    this.selected[type] = modelId;
    this.saveSelectedToStorage();

    this.logger?.info('Model selected', {
      operation: 'selectModel',
      component: 'ModelRegistry',
      attributes: {
        type,
        modelId,
        modelName: model.name,
        previousModelId: previousModel,
        source: model.source,
      },
    });
  }

  /**
   * Clear selection for a type
   */
  clearSelection(type: 'stt' | 'vad' | 'ner'): void {
    const previousModel = this.selected[type];
    delete this.selected[type];
    this.saveSelectedToStorage();

    this.logger?.debug('Model selection cleared', {
      operation: 'clearSelection',
      component: 'ModelRegistry',
      attributes: { type, previousModelId: previousModel },
    });
  }

  /**
   * Add custom models
   */
  addCustomModels(models: ModelDefinition[]): void {
    for (const model of models) {
      this.models.set(model.id, model);
    }
    this.logger?.debug('Custom models added', {
      operation: 'addCustomModels',
      component: 'ModelRegistry',
      attributes: {
        addedModels: models.map((m) => ({ id: m.id, type: m.type, source: m.source })),
        totalModels: this.models.size,
      },
    });
  }

  /**
   * Load tenant configuration from the auth-based endpoint and apply model selections.
   *
   * Fetches `GET /tenant/me/config` (the server resolves the tenant from the
   * JWT token), parses the flat key-value settings into a structured
   * `TenantAudioConfig`, and auto-selects the default STT model if the slug
   * matches a built-in model.
   */
  async loadTenantConfig(): Promise<TenantAudioConfig> {
    const timer = this.logger?.startOperation('loadTenantConfig', {
      component: 'ModelRegistry',
    });

    try {
      const raw = await withRetry(
        () =>
          this.apiClient.get<
            { data: Array<{ key: string; value: unknown; namespace?: string }> } | Array<{ key: string; value: unknown; namespace?: string }>
          >(MY_TENANT_ENDPOINTS.CONFIG),
        {
          maxRetries: 2,
          delayMs: 1000,
          onRetry: (attempt, error) => {
            this.logger?.warn(`Retrying loadTenantConfig (attempt ${attempt})`, {
              operation: 'loadTenantConfig',
              component: 'ModelRegistry',
              attributes: { attempt, error: String(error) },
            });
          },
        },
      );

      const settings = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      const parsed = parseTenantConfig(settings);
      this.tenantConfig = parsed;

      if (parsed.defaultSttModel) {
        const match = this.findModelByIdOrName(parsed.defaultSttModel, 'stt');
        if (match && !this.selected.stt) {
          this.selected.stt = match.id;
          this.saveSelectedToStorage();
        }
      }

      timer?.end(true, {
        attributes: {
          defaultSttModel: parsed.defaultSttModel,
          features: parsed.features,
        },
      });
      this.logger?.info('Tenant config loaded', {
        operation: 'loadTenantConfig',
        component: 'ModelRegistry',
        attributes: {
          defaultSttModel: parsed.defaultSttModel,
          vadSensitivity: parsed.vadSensitivity,
        },
      });

      return parsed;
    } catch (error) {
      timer?.error(error as Error);
      this.logger?.warn('Failed to load tenant config (using defaults)', {
        operation: 'loadTenantConfig',
        component: 'ModelRegistry',
        error: error as Error,
      });

      const fallback: TenantAudioConfig = { features: { ...DEFAULT_TENANT_FEATURES } };
      this.tenantConfig = fallback;
      return fallback;
    }
  }

  /**
   * Get the cached tenant configuration (populated by `loadTenantConfig`).
   */
  getTenantConfig(): TenantAudioConfig | null {
    return this.tenantConfig;
  }

  /**
   * Find a built-in model by ID or name substring for a given type.
   */
  private findModelByIdOrName(slug: string, type: 'stt' | 'vad' | 'ner'): ModelDefinition | undefined {
    const byId = this.models.get(slug);
    if (byId && byId.type === type) return byId;

    for (const model of this.models.values()) {
      if (model.type === type && model.id === slug) return model;
    }
    return undefined;
  }

  /**
   * Get model URL for loading
   */
  getModelUrl(modelId: string): string | undefined {
    const model = this.models.get(modelId);
    if (!model) return undefined;

    // For HuggingFace models, return the model path
    if (model.source === 'huggingface') {
      return this.getHuggingFaceUrl(model);
    }

    // For backend/custom models, return the configured URL
    return model.url;
  }

  /**
   * Get HuggingFace model URL
   */
  private getHuggingFaceUrl(model: ModelDefinition): string {
    // Map model IDs to HuggingFace model paths
    const huggingFaceModels: Record<string, string> = {
      'whisper-tiny': 'onnx-community/whisper-tiny',
      'whisper-base': 'onnx-community/whisper-base',
      'whisper-small': 'onnx-community/whisper-small',
      'whisper-medium': 'onnx-community/whisper-medium',
      'silero-vad-v5': 'snakers4/silero-vad',
      'silero-vad-v4': 'snakers4/silero-vad',
    };

    return huggingFaceModels[model.id] || model.id;
  }

  /**
   * Check if a model is loaded
   */
  isModelLoaded(modelId: string): boolean {
    return this.loadedModels.has(modelId);
  }

  /**
   * Check if a model is loading
   */
  isModelLoading(modelId: string): boolean {
    return this.loadingModels.has(modelId);
  }

  /**
   * Get model load progress (0-100)
   */
  getLoadProgress(modelId: string): number {
    return this.loadProgress.get(modelId) ?? 0;
  }

  /**
   * Get model load error
   */
  getLoadError(modelId: string): Error | undefined {
    return this.errors.get(modelId);
  }

  /**
   * Mark model as loading
   */
  markLoading(modelId: string): void {
    this.loadingModels.add(modelId);
    this.loadProgress.set(modelId, 0);
    this.errors.delete(modelId);

    const model = this.models.get(modelId);
    this.logger?.info('Model loading started', {
      operation: 'markLoading',
      component: 'ModelRegistry',
      attributes: {
        modelId,
        modelName: model?.name,
        type: model?.type,
        source: model?.source,
      },
    });
  }

  /**
   * Update load progress
   */
  updateProgress(modelId: string, progress: number): void {
    this.loadProgress.set(modelId, progress);

    // Only log at certain thresholds to avoid log spam
    if (progress === 25 || progress === 50 || progress === 75 || progress === 100) {
      this.logger?.debug('Model load progress', {
        operation: 'updateProgress',
        component: 'ModelRegistry',
        attributes: { modelId, progress },
      });
    }
  }

  /**
   * Mark model as loaded
   */
  markLoaded(modelId: string): void {
    this.loadingModels.delete(modelId);
    this.loadProgress.set(modelId, 100);
    this.loadedModels.add(modelId);

    const model = this.models.get(modelId);
    this.logger?.info('Model loaded successfully', {
      operation: 'markLoaded',
      component: 'ModelRegistry',
      success: true,
      attributes: {
        modelId,
        modelName: model?.name,
        type: model?.type,
        totalLoadedModels: this.loadedModels.size,
      },
    });
  }

  /**
   * Mark model load as failed
   */
  markFailed(modelId: string, error: Error): void {
    this.loadingModels.delete(modelId);
    this.errors.set(modelId, error);

    const model = this.models.get(modelId);
    this.logger?.error('Model load failed', {
      operation: 'markFailed',
      component: 'ModelRegistry',
      success: false,
      error: error,
      attributes: {
        modelId,
        modelName: model?.name,
        type: model?.type,
        source: model?.source,
      },
    });
  }

  /**
   * Get all loading models
   */
  getLoadingModels(): string[] {
    return Array.from(this.loadingModels);
  }

  /**
   * Load selected models from local storage
   */
  private loadSelectedFromStorage(): SelectedModels | null {
    if (typeof window === 'undefined') return null;

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SELECTED_MODELS);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  /**
   * Save selected models to local storage
   */
  private saveSelectedToStorage(): void {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_MODELS, JSON.stringify(this.selected));
      this.logger?.trace('Selected models saved to storage', {
        operation: 'saveSelectedToStorage',
        component: 'ModelRegistry',
        attributes: { selected: this.selected },
      });
    } catch (error) {
      this.logger?.warn('Failed to save selected models to storage', {
        operation: 'saveSelectedToStorage',
        component: 'ModelRegistry',
        error: error as Error,
      });
    }
  }

  /**
   * Destroy the registry and release all internal state.
   */
  destroy(): void {
    this.models.clear();
    this.selected = {};
    this.loadingModels.clear();
    this.loadProgress.clear();
    this.loadedModels.clear();
    this.errors.clear();
    this.tenantConfig = null;

    this.logger?.debug('ModelRegistry destroyed', {
      operation: 'destroy',
      component: 'ModelRegistry',
    });
  }

  /**
   * Get registry state for debugging
   */
  getState(): {
    models: ModelDefinition[];
    selected: SelectedModels;
    loading: string[];
    loaded: string[];
    errors: Record<string, string>;
  } {
    return {
      models: this.getModels(),
      selected: this.getSelected(),
      loading: this.getLoadingModels(),
      loaded: Array.from(this.loadedModels),
      errors: Object.fromEntries(Array.from(this.errors.entries()).map(([k, v]) => [k, v.message])),
    };
  }
}
