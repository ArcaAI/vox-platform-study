/**
 * Transformers.js Cache Utilities
 *
 * Utilities for checking and managing Transformers.js model cache in browser Cache Storage.
 * Transformers.js stores downloaded models in Cache Storage API.
 */

export interface TransformersCacheInfo {
  isCached: boolean;
  cacheSize?: number;
  files?: string[];
  lastModified?: number;
}

/**
 * Check if a Transformers.js model is cached
 */
export async function isTransformersModelCached(modelId: string): Promise<boolean> {
  try {
    if (!('caches' in window)) {
      return false;
    }

    // Transformers.js uses cache name pattern: 'transformers-cache'
    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      // Check if any cached URL contains the model ID
      for (const request of requests) {
        if (request.url.includes(modelId)) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error('Error checking Transformers.js cache:', error);
    return false;
  }
}

/**
 * Get detailed cache information for a Transformers.js model
 */
export async function getTransformersCacheInfo(modelId: string): Promise<TransformersCacheInfo> {
  try {
    if (!('caches' in window)) {
      return { isCached: false };
    }

    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    let totalSize = 0;
    const files: string[] = [];
    let lastModified: number | undefined;

    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        if (request.url.includes(modelId)) {
          files.push(request.url);

          // Get response to calculate size
          const response = await cache.match(request);
          if (response) {
            const blob = await response.blob();
            totalSize += blob.size;

            // Get last modified date from headers
            const lastModifiedHeader = response.headers.get('last-modified');
            if (lastModifiedHeader) {
              const date = new Date(lastModifiedHeader).getTime();
              if (!lastModified || date > lastModified) {
                lastModified = date;
              }
            }
          }
        }
      }
    }

    return {
      isCached: files.length > 0,
      cacheSize: totalSize > 0 ? totalSize : undefined,
      files: files.length > 0 ? files : undefined,
      lastModified,
    };
  } catch (error) {
    console.error('Error getting Transformers.js cache info:', error);
    return { isCached: false };
  }
}

/**
 * Clear Transformers.js cache for a specific model
 */
export async function clearTransformersModelCache(modelId: string): Promise<boolean> {
  try {
    if (!('caches' in window)) {
      return false;
    }

    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    let deletedAny = false;

    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        if (request.url.includes(modelId)) {
          await cache.delete(request);
          deletedAny = true;
        }
      }
    }

    return deletedAny;
  } catch (error) {
    console.error('Error clearing Transformers.js cache:', error);
    return false;
  }
}

/**
 * Get all cached Transformers.js models
 */
export async function getAllCachedTransformersModels(): Promise<string[]> {
  try {
    if (!('caches' in window)) {
      return [];
    }

    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    const modelIds = new Set<string>();

    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        // Extract model ID from URL
        // Typical URL: https://huggingface.co/onnx-community/whisper-base/resolve/main/...
        const match = request.url.match(/huggingface\.co\/([^\/]+\/[^\/]+)\//);
        if (match) {
          modelIds.add(match[1]);
        }
      }
    }

    return Array.from(modelIds);
  } catch (error) {
    console.error('Error getting all cached models:', error);
    return [];
  }
}

/**
 * Get total size of all Transformers.js cached models
 */
export async function getTotalTransformersCacheSize(): Promise<number> {
  try {
    if (!('caches' in window)) {
      return 0;
    }

    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    let totalSize = 0;

    for (const cacheName of transformersCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          const blob = await response.blob();
          totalSize += blob.size;
        }
      }
    }

    return totalSize;
  } catch (error) {
    console.error('Error getting total cache size:', error);
    return 0;
  }
}

/**
 * Clear all Transformers.js cache
 */
export async function clearAllTransformersCache(): Promise<boolean> {
  try {
    if (!('caches' in window)) {
      return false;
    }

    const cacheNames = await caches.keys();
    const transformersCaches = cacheNames.filter((name) => name.includes('transformers') || name.includes('huggingface'));

    for (const cacheName of transformersCaches) {
      await caches.delete(cacheName);
    }

    return true;
  } catch (error) {
    console.error('Error clearing all Transformers.js cache:', error);
    return false;
  }
}
