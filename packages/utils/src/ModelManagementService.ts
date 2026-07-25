/**
 * Model Management Service
 *
 * High-level service for managing ML models:
 * - Model registry
 * - Download orchestration
 * - Status tracking
 * - Update management
 * - Storage monitoring
 *
 * @see https://github.com/jakearchibald/idb - IndexedDB best practices
 */

import { ModelDownloader, ModelConfig } from './ModelDownloader';
import {
  ModelMetadata,
  DownloadedModelInfo,
  ModelDownloadProgress,
  ModelStorageInfo,
  ModelUpdateInfo,
  ModelStatus,
  ModelCategory,
  ModelPriority,
} from '@arcaai/types';
import { ALL_MODELS, type ModelRegistryEntry } from './model-registry';
import { getModelSourceManager } from './ModelSourceManager';

/**
 * Model Management Service
 *
 * Extends ModelDownloader with high-level model management capabilities
 */
export class ModelManagementService extends ModelDownloader {
  private modelRegistry: Map<string, ModelMetadata> = new Map();
  private downloadProgress: Map<string, ModelDownloadProgress> = new Map();
  private progressCallbacks: Set<(progress: ModelDownloadProgress) => void> = new Set();
  private sourceManager = getModelSourceManager();

  constructor() {
    super();
    this.initializeRegistry();
  }

  /**
   * Initialize model registry with available models
   */
  private initializeRegistry(): void {
    // Register all models from the centralized registry
    ALL_MODELS.forEach((model) => {
      this.registerModel(model);
    });
  }

  /**
   * Register a model in the registry
   */
  registerModel(metadata: ModelMetadata): void {
    this.modelRegistry.set(metadata.id, metadata);
  }

  /**
   * Get all available models
   */
  async getAvailableModels(): Promise<ModelMetadata[]> {
    return Array.from(this.modelRegistry.values());
  }

  /**
   * Get models by category
   */
  async getModelsByCategory(category: ModelCategory): Promise<ModelMetadata[]> {
    return Array.from(this.modelRegistry.values()).filter((model) => model.category === category);
  }

  /**
   * Get models by priority
   */
  async getModelsByPriority(priority: ModelPriority): Promise<ModelMetadata[]> {
    return Array.from(this.modelRegistry.values()).filter((model) => model.priority === priority);
  }

  /**
   * Get essential models (should be downloaded on first launch)
   */
  async getEssentialModels(): Promise<ModelMetadata[]> {
    return this.getModelsByPriority(ModelPriority.ESSENTIAL);
  }

  /**
   * Get downloaded models with status
   */
  async getDownloadedModels(): Promise<DownloadedModelInfo[]> {
    const cached = await this.listCachedModels();
    const downloaded: DownloadedModelInfo[] = [];

    for (const cachedModel of cached) {
      const metadata = this.modelRegistry.get(cachedModel.name);
      if (metadata) {
        downloaded.push({
          ...metadata,
          status: ModelStatus.DOWNLOADED,
          downloadedAt: cachedModel.downloadedAt,
          localSize: cachedModel.size,
        });
      }
    }

    return downloaded;
  }

  /**
   * Get all models with status
   */
  async getAllModelsWithStatus(): Promise<DownloadedModelInfo[]> {
    const allModels = await this.getAvailableModels();
    const downloaded = await this.getDownloadedModels();
    const downloadedMap = new Map(downloaded.map((m) => [m.id, m]));

    return allModels.map((model) => {
      const downloadedInfo = downloadedMap.get(model.id);
      if (downloadedInfo) {
        return downloadedInfo;
      }

      // Model not downloaded
      return {
        ...model,
        status: ModelStatus.AVAILABLE,
        downloadedAt: 0,
        localSize: 0,
      };
    });
  }

  /**
   * Download a model by ID
   *
   * Automatically selects best source:
   * 1. Local file (if available)
   * 2. Custom source (if set)
   * 3. Default remote URL
   */
  async downloadModelById(modelId: string, onProgress?: (progress: ModelDownloadProgress) => void): Promise<void> {
    const metadata = this.modelRegistry.get(modelId);
    if (!metadata) {
      throw new Error(`Model not found: ${modelId}`);
    }

    // Update status to downloading
    this.updateDownloadProgress({
      modelId,
      status: ModelStatus.DOWNLOADING,
      loaded: 0,
      total: metadata.size,
      percentage: 0,
    });

    try {
      // Get best available source
      const registryEntry = metadata as ModelRegistryEntry;
      const localPath = registryEntry.sources?.local;
      const remoteUrl = registryEntry.sources?.remote || metadata.url;

      const bestUrl = await this.sourceManager.getBestSource(modelId, localPath, remoteUrl);

      const config: ModelConfig = {
        name: metadata.name,
        url: bestUrl,
        version: metadata.version,
        size: metadata.size,
        checksum: metadata.checksum,
      };

      await this.downloadModel(config, (progress) => {
        const downloadProgress: ModelDownloadProgress = {
          modelId,
          status: ModelStatus.DOWNLOADING,
          loaded: progress.loaded,
          total: progress.total,
          percentage: progress.percentage,
        };

        this.updateDownloadProgress(downloadProgress);

        if (onProgress) {
          onProgress(downloadProgress);
        }
      });

      // Update status to downloaded
      this.updateDownloadProgress({
        modelId,
        status: ModelStatus.DOWNLOADED,
        loaded: metadata.size,
        total: metadata.size,
        percentage: 100,
      });
    } catch (error) {
      // Update status to error
      this.updateDownloadProgress({
        modelId,
        status: ModelStatus.ERROR,
        loaded: 0,
        total: metadata.size,
        percentage: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Set custom source URL for a model
   */
  setCustomModelSource(modelId: string, url: string): void {
    this.sourceManager.setCustomSource(modelId, url);
  }

  /**
   * Set custom Hugging Face repository for a model
   *
   * @param modelId - Model ID
   * @param repoString - Format: "repo/model:filename" or "repo/model:filename@revision"
   * @example setCustomHuggingFaceRepo('silero-vad', 'snakers4/silero-vad:silero_vad.onnx@master')
   */
  setCustomHuggingFaceRepo(modelId: string, repoString: string): void {
    const repo = this.sourceManager.parseHuggingFaceRepo(repoString);
    if (!repo) {
      throw new Error(`Invalid Hugging Face repository format: ${repoString}`);
    }

    const url = this.sourceManager.buildHuggingFaceUrl(repo);
    this.sourceManager.setCustomSource(modelId, url);
  }

  /**
   * Remove custom source for a model (revert to default)
   */
  removeCustomModelSource(modelId: string): void {
    this.sourceManager.removeCustomSource(modelId);
  }

  /**
   * Get custom source for a model
   */
  getCustomModelSource(modelId: string): string | undefined {
    return this.sourceManager.getCustomSource(modelId);
  }

  /**
   * Check if model is available locally
   */
  async isModelAvailableLocally(modelId: string): Promise<boolean> {
    const metadata = this.modelRegistry.get(modelId) as ModelRegistryEntry;
    if (!metadata?.sources?.local) {
      return false;
    }

    return this.sourceManager.isLocallyAvailable(metadata.sources.local);
  }

  /**
   * Set Hugging Face token for private repositories
   */
  setHuggingFaceToken(token: string): void {
    this.sourceManager.updateConfig({ huggingFaceToken: token });
  }

  /**
   * Enable/disable local file preference
   */
  setPreferLocal(prefer: boolean): void {
    this.sourceManager.updateConfig({ preferLocal: prefer });
  }

  /**
   * Delete a model by ID
   */
  async deleteModelById(modelId: string): Promise<void> {
    const metadata = this.modelRegistry.get(modelId);
    if (!metadata) {
      throw new Error(`Model not found: ${modelId}`);
    }

    await this.deleteModel(metadata.name);
  }

  /**
   * Check for model updates
   */
  async checkForUpdates(): Promise<ModelUpdateInfo[]> {
    // In a real implementation, this would fetch latest versions from a registry API
    // For now, we'll just compare with hardcoded versions
    const downloaded = await this.getDownloadedModels();
    const updates: ModelUpdateInfo[] = [];

    for (const model of downloaded) {
      const latestMetadata = this.modelRegistry.get(model.id);
      if (latestMetadata && latestMetadata.version !== model.version) {
        updates.push({
          modelId: model.id,
          currentVersion: model.version,
          latestVersion: latestMetadata.version,
          size: latestMetadata.size,
          changelog: latestMetadata.changelog,
          releaseDate: latestMetadata.lastUpdated,
        });
      }
    }

    return updates;
  }

  /**
   * Update a model to latest version
   */
  async updateModelById(modelId: string, onProgress?: (progress: ModelDownloadProgress) => void): Promise<void> {
    // Delete old version
    await this.deleteModelById(modelId);

    // Download new version
    await this.downloadModelById(modelId, onProgress);
  }

  /**
   * Get storage information
   */
  async getStorageInfo(): Promise<ModelStorageInfo> {
    const downloaded = await this.getDownloadedModels();
    const totalSize = await this.getCacheSize();

    // Try to get storage quota (if available)
    let availableSize: number | undefined;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota && estimate.usage) {
          availableSize = estimate.quota - estimate.usage;
        }
      } catch (error) {
        console.warn('Failed to get storage estimate:', error);
      }
    }

    return {
      totalSize,
      usedSize: totalSize,
      availableSize,
      modelCount: downloaded.length,
      models: downloaded,
    };
  }

  /**
   * Download essential models (for first-time setup)
   */
  async downloadEssentialModels(onProgress?: (modelId: string, progress: ModelDownloadProgress) => void): Promise<void> {
    const essentialModels = await this.getEssentialModels();

    for (const model of essentialModels) {
      await this.downloadModelById(model.id, (progress) => {
        if (onProgress) {
          onProgress(model.id, progress);
        }
      });
    }
  }

  /**
   * Subscribe to download progress updates
   */
  onDownloadProgress(callback: (progress: ModelDownloadProgress) => void): () => void {
    this.progressCallbacks.add(callback);

    // Return unsubscribe function
    return () => {
      this.progressCallbacks.delete(callback);
    };
  }

  /**
   * Update download progress and notify subscribers
   */
  private updateDownloadProgress(progress: ModelDownloadProgress): void {
    this.downloadProgress.set(progress.modelId, progress);

    // Notify all subscribers
    this.progressCallbacks.forEach((callback) => {
      callback(progress);
    });
  }

  /**
   * Get current download progress for a model
   */
  getDownloadProgress(modelId: string): ModelDownloadProgress | undefined {
    return this.downloadProgress.get(modelId);
  }

  /**
   * Get model data from cache
   *
   * @param modelId - Model ID from registry
   * @returns Model data as ArrayBuffer
   * @throws {Error} If model not found in registry
   * @throws {Error} If model not found in cache
   */
  async getModelData(modelId: string): Promise<ArrayBuffer> {
    const metadata = this.modelRegistry.get(modelId);
    if (!metadata) {
      throw new Error(`Model not found in registry: ${modelId}`);
    }

    console.info(`[ModelManagement] Loading model: ${modelId} (name: ${metadata.name})`);

    // Ensure database is initialized
    await this.initialize();

    // Load from IndexedDB
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('arcaai-models', 1);

      request.onerror = () => {
        console.error('[ModelManagement] Failed to open IndexedDB');
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['models'], 'readonly');
        const store = transaction.objectStore('models');
        const getRequest = store.get(metadata.name);

        getRequest.onsuccess = () => {
          if (!getRequest.result) {
            db.close();
            console.error(`[ModelManagement] Model not found in IndexedDB: ${metadata.name}`);
            console.error(`[ModelManagement] Please download the model from Settings page first.`);
            reject(new Error(`Model not found in cache: ${modelId}. Please download it from Settings → Model Management.`));
            return;
          }

          const cachedModel = getRequest.result;
          const modelData = cachedModel.data;

          // Validate data exists
          if (!modelData) {
            db.close();
            console.error('[ModelManagement] Model data is null');
            reject(new Error(`Model data is null. Please re-download the model from Settings.`));
            return;
          }

          // Validate data type
          if (!(modelData instanceof ArrayBuffer)) {
            db.close();
            console.error('[ModelManagement] Model data is not ArrayBuffer:', typeof modelData);
            reject(new Error(`Model data is corrupted (not ArrayBuffer). Please re-download the model from Settings.`));
            return;
          }

          // Validate data size
          if (modelData.byteLength === 0) {
            db.close();
            console.error('[ModelManagement] Model data is empty');
            reject(new Error(`Model data is empty. Please re-download the model from Settings.`));
            return;
          }

          // Validate ONNX format (check protobuf magic byte)
          const view = new Uint8Array(modelData);
          const firstByte = view[0];

          if (firstByte !== 0x08) {
            db.close();
            console.error('[ModelManagement] Invalid ONNX model. First byte:', '0x' + firstByte.toString(16).padStart(2, '0'));
            console.error('[ModelManagement] Expected: 0x08 (ONNX protobuf magic byte)');
            reject(new Error(`Model is corrupted (invalid ONNX format). Please re-download the model from Settings.`));
            return;
          }

          console.info(`[ModelManagement] ✅ Model loaded successfully from IndexedDB`);
          console.info(`[ModelManagement] Model size: ${(modelData.byteLength / 1024 / 1024).toFixed(2)} MB`);

          db.close();
          resolve(modelData);
        };

        getRequest.onerror = () => {
          db.close();
          console.error('[ModelManagement] Failed to load model from IndexedDB');
          reject(new Error('Failed to load model from cache'));
        };
      };
    });
  }

  /**
   * Delete a model (private method for internal use)
   */
  private async deleteModel(modelName: string): Promise<void> {
    // Ensure database is initialized
    await this.initialize();

    return new Promise((resolve, reject) => {
      const request = indexedDB.open('arcaai-models', 1);

      request.onerror = () => reject(new Error('Failed to open IndexedDB'));

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['models'], 'readwrite');
        const store = transaction.objectStore('models');
        const deleteRequest = store.delete(modelName);

        deleteRequest.onsuccess = () => {
          db.close();
          resolve();
        };
        deleteRequest.onerror = () => {
          db.close();
          reject(new Error('Failed to delete model'));
        };
      };
    });
  }
}

// Singleton instance
let modelManagementService: ModelManagementService | null = null;

/**
 * Get the singleton instance of ModelManagementService
 */
export function getModelManagementService(): ModelManagementService {
  if (!modelManagementService) {
    modelManagementService = new ModelManagementService();
  }
  return modelManagementService;
}
