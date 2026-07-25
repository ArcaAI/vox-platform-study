/**
 * Model Source Manager
 *
 * Handles fetching models from multiple sources:
 * 1. Local static files (public/models/)
 * 2. Remote CDN (Hugging Face, GitHub, Silero)
 * 3. Custom Hugging Face repositories
 * 4. Custom direct URLs
 *
 * Priority: Local > Custom > Default Remote
 */

export interface ModelSourceConfig {
  preferLocal: boolean; // Try local files first
  customSources?: Map<string, string>; // modelId -> custom URL
  huggingFaceToken?: string; // Optional HF token for private repos
}

export interface HuggingFaceRepo {
  repo: string; // e.g., "onnx-community/wespeaker-voxceleb-resnet34"
  filename: string; // e.g., "model.onnx"
  revision?: string; // e.g., "main" or specific commit
}

/**
 * Model Source Manager
 */
export class ModelSourceManager {
  private config: ModelSourceConfig;
  private localCache: Map<string, boolean> = new Map();

  constructor(config: ModelSourceConfig = { preferLocal: true }) {
    this.config = config;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ModelSourceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set custom source for a model
   */
  setCustomSource(modelId: string, url: string): void {
    if (!this.config.customSources) {
      this.config.customSources = new Map();
    }
    this.config.customSources.set(modelId, url);
  }

  /**
   * Remove custom source for a model
   */
  removeCustomSource(modelId: string): void {
    this.config.customSources?.delete(modelId);
  }

  /**
   * Get custom source for a model
   */
  getCustomSource(modelId: string): string | undefined {
    return this.config.customSources?.get(modelId);
  }

  /**
   * Check if model is available locally
   */
  async isLocallyAvailable(localPath: string): Promise<boolean> {
    // Check cache first
    if (this.localCache.has(localPath)) {
      return this.localCache.get(localPath)!;
    }

    try {
      const response = await fetch(localPath, { method: 'HEAD' });
      const available = response.ok;
      this.localCache.set(localPath, available);
      return available;
    } catch {
      this.localCache.set(localPath, false);
      return false;
    }
  }

  /**
   * Build Hugging Face URL from repository info
   */
  buildHuggingFaceUrl(repo: HuggingFaceRepo): string {
    const { repo: repoId, filename, revision = 'main' } = repo;
    return `https://huggingface.co/${repoId}/resolve/${revision}/${filename}`;
  }

  /**
   * Parse Hugging Face repository string
   * Format: "repo/model:filename" or "repo/model:filename@revision"
   */
  parseHuggingFaceRepo(repoString: string): HuggingFaceRepo | null {
    try {
      // Format: "onnx-community/wespeaker-voxceleb-resnet34:model.onnx"
      // or "onnx-community/wespeaker-voxceleb-resnet34:model.onnx@main"
      const [repoPath, fileInfo] = repoString.split(':');
      if (!repoPath || !fileInfo) return null;

      const [filename, revision] = fileInfo.split('@');
      if (!filename) return null;

      return {
        repo: repoPath,
        filename,
        revision: revision || 'main',
      };
    } catch {
      return null;
    }
  }

  /**
   * Get best available source for a model
   *
   * Priority:
   * 1. Local file (if preferLocal and available)
   * 2. Custom source (if set)
   * 3. Default remote URL
   */
  async getBestSource(modelId: string, localPath: string | undefined, defaultRemoteUrl: string): Promise<string> {
    // 1. Try local first if preferred
    if (this.config.preferLocal && localPath) {
      const isLocal = await this.isLocallyAvailable(localPath);
      if (isLocal) {
        console.info(`[ModelSourceManager] Using local source for ${modelId}: ${localPath}`);
        return localPath;
      }
    }

    // 2. Check for custom source
    const customSource = this.getCustomSource(modelId);
    if (customSource) {
      console.info(`[ModelSourceManager] Using custom source for ${modelId}: ${customSource}`);
      return customSource;
    }

    // 3. Fall back to default remote
    console.info(`[ModelSourceManager] Using default remote source for ${modelId}: ${defaultRemoteUrl}`);
    return defaultRemoteUrl;
  }

  /**
   * Validate URL is accessible
   */
  async validateUrl(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Download model from Hugging Face with progress
   * Supports both public and private repositories
   */
  async downloadFromHuggingFace(
    repo: HuggingFaceRepo,
    onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
  ): Promise<ArrayBuffer> {
    const url = this.buildHuggingFaceUrl(repo);

    const headers: HeadersInit = {};
    if (this.config.huggingFaceToken) {
      headers['Authorization'] = `Bearer ${this.config.huggingFaceToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to download from Hugging Face: ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

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

    // Combine chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  }

  /**
   * Clear local cache
   */
  clearCache(): void {
    this.localCache.clear();
  }
}

// Singleton instance
let modelSourceManager: ModelSourceManager | null = null;

/**
 * Get the singleton instance of ModelSourceManager
 */
export function getModelSourceManager(): ModelSourceManager {
  if (!modelSourceManager) {
    modelSourceManager = new ModelSourceManager({ preferLocal: false });
  }
  return modelSourceManager;
}
