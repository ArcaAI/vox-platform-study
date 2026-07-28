/**
 * Model Management Types
 *
 * Type definitions for the Model Management system
 */

/**
 * Model category
 */
export enum ModelCategory {
  VAD = 'vad',
  TRANSCRIPTION = 'transcription',
  DIARIZATION = 'diarization',
  SPEAKER_RECOGNITION = 'speaker-recognition',
}

/**
 * Model priority
 */
export enum ModelPriority {
  ESSENTIAL = 'essential',
  RECOMMENDED = 'recommended',
  OPTIONAL = 'optional',
}

/**
 * Model status
 */
export enum ModelStatus {
  AVAILABLE = 'available',
  DOWNLOADING = 'downloading',
  DOWNLOADED = 'downloaded',
  UPDATING = 'updating',
  ERROR = 'error',
  PAUSED = 'paused',
}

/**
 * Model metadata
 */
export interface ModelMetadata {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: ModelCategory;
  priority: ModelPriority;
  version: string;
  size: number; // in bytes
  url: string;
  task?: string; // Transformers.js pipeline task (e.g., 'automatic-speech-recognition')
  checksum?: string; // SHA-256 hash
  dependencies?: string[]; // Other model IDs
  managedBy?: 'transformers.js' | 'manual'; // Indicates if model is auto-managed by a library
  compatibility?: {
    minBrowserVersion?: Record<string, string>;
    features?: string[]; // Required browser features
    performanceNotes?: string;
  };
  changelog?: string;
  lastUpdated?: number; // timestamp
}

/**
 * Downloaded model info
 */
export interface DownloadedModelInfo extends ModelMetadata {
  status: ModelStatus;
  downloadedAt: number;
  lastUsed?: number;
  usageCount?: number;
  localSize: number; // Actual size in storage
  error?: string;
}

/**
 * Download progress info
 */
export interface ModelDownloadProgress {
  modelId: string;
  status: ModelStatus;
  loaded: number;
  total: number;
  percentage: number;
  speed?: number; // bytes per second
  eta?: number; // seconds remaining
  error?: string;
}

/**
 * Storage info
 */
export interface ModelStorageInfo {
  totalSize: number;
  usedSize: number;
  availableSize?: number; // If quota API available
  modelCount: number;
  models: DownloadedModelInfo[];
}

/**
 * Model update info
 */
export interface ModelUpdateInfo {
  modelId: string;
  currentVersion: string;
  latestVersion: string;
  changelog?: string;
  size: number;
  releaseDate?: number;
}

/**
 * Model loading options for services
 */
export interface ServiceModelOptions {
  /** Model ID from registry (preferred) */
  modelId?: string;

  /** Custom model URL (overrides registry) */
  modelUrl?: string;

  /** Custom local path (overrides registry) */
  modelPath?: string;

  /** Progress callback for download */
  onProgress?: (progress: ModelDownloadProgress) => void;

  /** Force re-download even if cached */
  forceDownload?: boolean;
}
