/**
 * ModelDownloader
 *
 * Automatically downloads and caches ONNX models at runtime
 * Uses IndexedDB for persistent caching
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
 */

export interface ModelConfig {
  name: string;
  url: string;
  version: string;
  size?: number; // Expected size in bytes
  checksum?: string; // Optional SHA-256 checksum
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

const DB_NAME = 'arcaai-models';
const DB_VERSION = 1;
const STORE_NAME = 'models';

export class ModelDownloader {
  private db: IDBDatabase | null = null;

  /**
   * Initialize IndexedDB for model caching
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(new Error('Failed to open IndexedDB'));

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
          store.createIndex('version', 'version', { unique: false });
          store.createIndex('downloadedAt', 'downloadedAt', { unique: false });
        }
      };
    });
  }

  /**
   * Download model with progress tracking
   *
   * @param config - Model configuration
   * @param onProgress - Progress callback
   * @returns ArrayBuffer of model data
   */
  async downloadModel(config: ModelConfig, onProgress?: (progress: DownloadProgress) => void): Promise<ArrayBuffer> {
    // Check if model exists in cache
    const cached = await this.getCachedModel(config.name, config.version);
    if (cached) {
      console.info(`[ModelDownloader] Using cached model: ${config.name}`);
      return cached;
    }

    console.info(`[ModelDownloader] Downloading model: ${config.name} from ${config.url}`);

    try {
      const response = await fetch(config.url);

      if (!response.ok) {
        throw new Error(`Failed to download model: ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : config.size || 0;

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        loaded += value.length;

        if (onProgress && total > 0) {
          onProgress({
            loaded,
            total,
            percentage: (loaded / total) * 100,
          });
        }
      }

      // Combine chunks into single ArrayBuffer
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }

      const arrayBuffer = result.buffer;

      // Validate model data before caching
      console.info(`[ModelDownloader] Validating downloaded model: ${config.name}`);
      console.info(`[ModelDownloader] Size: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

      if (arrayBuffer.byteLength === 0) {
        throw new Error('Downloaded model is empty');
      }

      const view = new Uint8Array(arrayBuffer);
      const firstByte = view[0];

      if (firstByte !== 0x08) {
        console.error(
          '[ModelDownloader] Invalid model data. First 16 bytes:',
          Array.from(view.slice(0, Math.min(16, view.length)))
            .map((b) => '0x' + b.toString(16).padStart(2, '0'))
            .join(' '),
        );
        throw new Error(
          `Downloaded file is not a valid ONNX model. ` +
            `Expected first byte 0x08, got 0x${firstByte.toString(16).padStart(2, '0')}. ` +
            `The download may have failed or returned an error page.`,
        );
      }

      console.info(`[ModelDownloader] ✅ Model validation passed`);

      // Cache the model
      await this.cacheModel(config.name, config.version, arrayBuffer);

      console.info(`[ModelDownloader] Model downloaded and cached: ${config.name}`);

      return arrayBuffer;
    } catch (error) {
      console.error(`[ModelDownloader] Failed to download model ${config.name}:`, error);
      throw error;
    }
  }

  /**
   * Get cached model from IndexedDB
   *
   * @param name - Model name
   * @param version - Model version
   * @returns Cached model data or null
   */
  private async getCachedModel(name: string, version: string): Promise<ArrayBuffer | null> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(name);

      request.onsuccess = () => {
        const result = request.result;

        if (result && result.version === version) {
          resolve(result.data);
        } else if (result && result.version !== version) {
          // Version mismatch, delete old cache
          console.info(`[ModelDownloader] Version mismatch for ${name}, will re-download`);
          this.deleteCachedModel(name).then(() => resolve(null));
        } else {
          resolve(null);
        }
      };

      request.onerror = () => reject(new Error('Failed to get cached model'));
    });
  }

  /**
   * Cache model in IndexedDB
   *
   * @param name - Model name
   * @param version - Model version
   * @param data - Model data
   */
  private async cacheModel(name: string, version: string, data: ArrayBuffer): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const modelData = {
        name,
        version,
        data,
        downloadedAt: Date.now(),
        size: data.byteLength,
      };

      const request = store.put(modelData);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to cache model'));
    });
  }

  /**
   * Delete cached model
   *
   * @param name - Model name
   */
  private async deleteCachedModel(name: string): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(name);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to delete cached model'));
    });
  }

  /**
   * List all cached models
   *
   * @returns Array of cached model info
   */
  async listCachedModels(): Promise<Array<{ name: string; version: string; size: number; downloadedAt: number }>> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const models = request.result.map((model: any) => ({
          name: model.name,
          version: model.version,
          size: model.size,
          downloadedAt: model.downloadedAt,
        }));
        resolve(models);
      };

      request.onerror = () => reject(new Error('Failed to list cached models'));
    });
  }

  /**
   * Clear all cached models
   */
  async clearCache(): Promise<void> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        console.info('[ModelDownloader] Cache cleared');
        resolve();
      };
      request.onerror = () => reject(new Error('Failed to clear cache'));
    });
  }

  /**
   * Get total cache size
   *
   * @returns Total size in bytes
   */
  async getCacheSize(): Promise<number> {
    const models = await this.listCachedModels();
    return models.reduce((total, model) => total + model.size, 0);
  }
}
