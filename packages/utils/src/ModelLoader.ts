/**
 * ModelLoader
 *
 * Shared utility for loading ONNX models across all services.
 * Provides consistent interface and progress tracking.
 *
 * @see https://onnxruntime.ai/docs/tutorials/web/ - ONNX Runtime Web
 */

import { getModelManagementService } from './ModelManagementService';
import type { ModelDownloadProgress } from '@arcaai/types';
import { ModelStatus } from '@arcaai/types';

/**
 * Options for loading models
 */
export interface ModelLoadOptions {
  /** Model ID from registry (preferred) */
  modelId?: string;

  /** Custom model URL (overrides registry) */
  customUrl?: string;

  /** Custom local path (overrides registry) */
  customPath?: string;

  /** Progress callback for download */
  onProgress?: (progress: ModelDownloadProgress) => void;

  /** Force re-download even if cached */
  forceDownload?: boolean;
}

/**
 * ModelLoader
 *
 * Provides a unified interface for loading ONNX models across all services.
 * Handles model download, caching, and progress tracking.
 *
 * @example
 * ```typescript
 * const loader = getModelLoader();
 *
 * // Load from registry
 * const modelData = await loader.loadModel({
 *   modelId: 'silero-vad',
 *   onProgress: (progress) => console.log(`${progress.percentage}%`)
 * });
 *
 * // Load from custom URL
 * const customModel = await loader.loadModel({
 *   customUrl: 'https://example.com/model.onnx'
 * });
 * ```
 */
export class ModelLoader {
  private modelManagement = getModelManagementService();

  /**
   * Load model for service use
   *
   * Priority:
   * 1. Custom URL (if provided)
   * 2. Custom local path (if provided)
   * 3. Model from registry (if modelId provided)
   *
   * @param options - Model load options
   * @returns Model data as ArrayBuffer
   * @throws {Error} If no valid model source is provided
   * @throws {Error} If model loading fails
   */
  async loadModel(options: ModelLoadOptions): Promise<ArrayBuffer> {
    // Option 1: Custom URL (bypass registry)
    if (options.customUrl) {
      return await this.loadFromUrl(options.customUrl, options.onProgress);
    }

    // Option 2: Custom local path
    if (options.customPath) {
      return await this.loadFromPath(options.customPath);
    }

    // Option 3: Model from registry
    if (options.modelId) {
      return await this.loadFromRegistry(
        options.modelId,
        options.onProgress,
        options.forceDownload
      );
    }

    throw new Error('Must provide modelId, customUrl, or customPath');
  }

  /**
   * Load model from registry
   *
   * @param modelId - Model ID from registry
   * @param onProgress - Progress callback
   * @param forceDownload - Force re-download
   * @returns Model data as ArrayBuffer
   * @private
   */
  private async loadFromRegistry(
    modelId: string,
    onProgress?: (progress: ModelDownloadProgress) => void,
    forceDownload?: boolean
  ): Promise<ArrayBuffer> {
    console.warn(`[ModelLoader] Loading model from registry: ${modelId}`);

    // Check if model exists in registry
    const models = await this.modelManagement.getAllModelsWithStatus();
    const model = models.find((m) => m.id === modelId);

    if (!model) {
      console.error(`[ModelLoader] Model not found in registry: ${modelId}`);
      throw new Error(`Model not found in registry: ${modelId}`);
    }

    console.warn(`[ModelLoader] Model found. Status: ${model.status}`);

    // Download if not cached or force download
    if (model.status !== ModelStatus.DOWNLOADED || forceDownload) {
      console.warn(`[ModelLoader] Model not cached. Downloading...`);
      await this.modelManagement.downloadModelById(modelId, onProgress);
    } else {
      console.warn(`[ModelLoader] Model already cached. Loading from IndexedDB...`);
    }

    // Load from cache
    return await this.modelManagement.getModelData(modelId);
  }

  /**
   * Load model from custom URL
   *
   * Downloads model from URL with progress tracking.
   * Does not cache the model.
   *
   * @param url - Model URL
   * @param onProgress - Progress callback
   * @returns Model data as ArrayBuffer
   * @private
   */
  private async loadFromUrl(
    url: string,
    onProgress?: (progress: ModelDownloadProgress) => void
  ): Promise<ArrayBuffer> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch model from ${url}: ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      if (onProgress && contentLength > 0) {
        onProgress({
          modelId: url,
          status: ModelStatus.DOWNLOADING,
          loaded: receivedLength,
          total: contentLength,
          percentage: (receivedLength / contentLength) * 100,
        });
      }
    }

    // Concatenate chunks
    const modelData = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      modelData.set(chunk, position);
      position += chunk.length;
    }

    return modelData.buffer;
  }

  /**
   * Load model from local path
   *
   * Loads model from local file system (e.g., /models/vad.onnx).
   *
   * @param path - Local file path
   * @returns Model data as ArrayBuffer
   * @private
   */
  private async loadFromPath(path: string): Promise<ArrayBuffer> {
    const response = await fetch(path);

    if (!response.ok) {
      throw new Error(`Failed to load model from ${path}: ${response.statusText}`);
    }

    return await response.arrayBuffer();
  }

  /**
   * Check if model is available (downloaded or can be loaded)
   *
   * @param modelId - Model ID from registry
   * @returns True if model is downloaded and available
   */
  async isModelAvailable(modelId: string): Promise<boolean> {
    const models = await this.modelManagement.getAllModelsWithStatus();
    const model = models.find((m) => m.id === modelId);
    return model?.status === ModelStatus.DOWNLOADED;
  }

  /**
   * Get model metadata from registry
   *
   * @param modelId - Model ID
   * @returns Model metadata or undefined if not found
   */
  async getModelMetadata(modelId: string) {
    const models = await this.modelManagement.getAvailableModels();
    return models.find((m) => m.id === modelId);
  }

  /**
   * Get all available models from registry
   *
   * @returns Array of model metadata
   */
  async getAvailableModels() {
    return await this.modelManagement.getAvailableModels();
  }

  /**
   * Get models by category
   *
   * @param category - Model category
   * @returns Array of model metadata
   */
  async getModelsByCategory(category: string) {
    const models = await this.modelManagement.getAvailableModels();
    return models.filter((m) => m.category === category);
  }
}

// Singleton instance
let modelLoader: ModelLoader | null = null;

/**
 * Get singleton ModelLoader instance
 *
 * @returns ModelLoader instance
 */
export function getModelLoader(): ModelLoader {
  if (!modelLoader) {
    modelLoader = new ModelLoader();
  }
  return modelLoader;
}

