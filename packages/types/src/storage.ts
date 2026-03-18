/**
 * Storage-related types for Arcaai application
 */

/**
 * Storage configuration
 */
export interface StorageConfig {
  databaseName: string;
  version: number;
  debug?: boolean;
}

/**
 * Default storage configuration
 */
export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  databaseName: 'arcaai-db',
  version: 1,
  debug: false,
};

/**
 * Storage usage information
 */
export interface StorageInfo {
  quota: number; // Total quota in bytes
  usage: number; // Current usage in bytes
  available: number; // Available space in bytes
  percentage: number; // Usage percentage (0-100)
  itemCounts: {
    meetings: number;
    audioFiles: number;
    transcriptions: number;
    summaries: number;
  };
}

/**
 * Query options for list operations
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Date range query options
 */
export interface DateRangeQuery extends QueryOptions {
  startDate: Date;
  endDate: Date;
}

/**
 * Search query options
 */
export interface SearchQuery extends QueryOptions {
  query: string;
  fields?: string[];
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

/**
 * Export data structure
 */
export interface ExportData {
  version: string;
  exportedAt: string;
  data: {
    meetings: any[];
    transcriptions: Record<string, any[]>;
    summaries: Record<string, any>;
    settings: Record<string, any>;
  };
  metadata: {
    totalMeetings: number;
    totalSize: number;
  };
}

/**
 * Import options
 */
export interface ImportOptions {
  overwrite?: boolean;
  skipExisting?: boolean;
  validateData?: boolean;
}

/**
 * Import result
 */
export interface ImportResult {
  success: boolean;
  imported: {
    meetings: number;
    transcriptions: number;
    summaries: number;
    settings: number;
  };
  skipped: number;
  errors: string[];
}

/**
 * Storage operation result
 */
export interface StorageOperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Database status
 */
export type DatabaseStatus = 'initializing' | 'ready' | 'error' | 'closed';

/**
 * Audio file metadata stored in IndexedDB
 */
export interface AudioFileMetadata {
  meetingId: string;
  size: number;
  format: string;
  duration: number;
  sampleRate: number;
  channelCount: number;
  createdAt: string;
  source?: string; // Audio source type (system_audio, microphone, mixed)
  // New fields for ME-011
  keepForever?: boolean; // Prevent automatic deletion
  lastAccessedAt?: string; // ISO timestamp
  downloadCount?: number; // Track downloads
  notes?: string; // User notes
}

/**
 * Audio file record in IndexedDB
 */
export interface AudioFileRecord {
  meetingId: string; // Primary key
  blob: Blob;
  metadata: AudioFileMetadata;
}

/**
 * Settings record in IndexedDB
 */
export interface SettingsRecord {
  key: string; // Primary key
  value: any;
  updatedAt: string;
}

/**
 * Cleanup settings for automatic recording deletion
 */
export interface CleanupSettings {
  enabled: boolean;
  retentionDays: number; // 7, 14, 30, 90, or -1 (never)
  lastCleanupAt?: string; // ISO timestamp
  cleanupOnStartup: boolean;
  keepForeverLimit: number; // Max recordings to keep forever
}

/**
 * Default cleanup settings
 */
export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  enabled: true,
  retentionDays: 7,
  cleanupOnStartup: true,
  keepForeverLimit: 10,
};

/**
 * Cleanup operation result
 */
export interface CleanupResult {
  deleted: number;
  skipped: number;
  errors: number;
  deletedIds?: string[];
  errorMessages?: string[];
}

/**
 * Recording with meeting information
 */
export interface RecordingWithMeeting {
  audio: AudioFileRecord;
  meeting: any; // Will be typed as Meeting when imported
}

/**
 * Storage error codes
 */
export enum StorageErrorCode {
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  CORRUPTION_ERROR = 'CORRUPTION_ERROR',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  UNSUPPORTED_ERROR = 'UNSUPPORTED_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Backup metadata
 */
export interface BackupMetadata {
  version: string;
  createdAt: string;
  appVersion: string;
  dataTypes: string[];
  totalSize: number;
  itemCounts: {
    meetings: number;
    audioFiles: number;
    transcriptions: number;
    summaries: number;
    voiceProfiles: number;
    speakerMappings: number;
  };
  checksum?: string;
}

/**
 * Backup options
 */
export interface BackupOptions {
  includeAudio?: boolean;
  includeVoiceProfiles?: boolean;
  includeSpeakerMappings?: boolean;
  dateRange?: {
    start: Date;
    end: Date;
  };
  compression?: boolean;
  onProgress?: (progress: BackupProgress) => void;
}

/**
 * Restore options
 */
export interface RestoreOptions {
  overwrite?: boolean;
  skipExisting?: boolean;
  merge?: boolean;
  onProgress?: (progress: RestoreProgress) => void;
  onConflict?: (conflict: DataConflict) => ConflictResolution;
}

/**
 * Backup progress
 */
export interface BackupProgress {
  phase: 'preparing' | 'exporting' | 'compressing' | 'complete';
  current: number;
  total: number;
  currentItem?: string;
  percentage: number;
  estimatedTimeRemaining?: number; // seconds
}

/**
 * Restore progress
 */
export interface RestoreProgress {
  phase: 'validating' | 'importing' | 'complete';
  current: number;
  total: number;
  currentItem?: string;
  percentage: number;
  estimatedTimeRemaining?: number; // seconds
}

/**
 * Data conflict information
 */
export interface DataConflict {
  type: 'meeting' | 'audio' | 'transcription' | 'summary' | 'voiceProfile' | 'speakerMapping';
  id: string;
  existingData: any;
  newData: any;
}

/**
 * Conflict resolution strategy
 */
export type ConflictResolution = 'skip' | 'overwrite' | 'merge';

/**
 * Backup result
 */
export interface BackupResult {
  success: boolean;
  blob?: Blob;
  metadata: BackupMetadata;
  errors: string[];
}

/**
 * Restore result
 */
export interface RestoreResult {
  success: boolean;
  imported: {
    meetings: number;
    audioFiles: number;
    transcriptions: number;
    summaries: number;
    voiceProfiles: number;
    speakerMappings: number;
    settings: number;
  };
  skipped: number;
  errors: string[];
}

/**
 * Enhanced export data with audio and voice profiles
 */
export interface EnhancedExportData extends ExportData {
  data: {
    meetings: any[];
    transcriptions: Record<string, any[]>;
    summaries: Record<string, any>;
    settings: Record<string, any>;
    speakerMappings?: any[];
    voiceProfiles?: string[]; // Base64 encoded encrypted profiles
  };
  audioFiles?: {
    [meetingId: string]: {
      filename: string;
      size: number;
      format: string;
    };
  };
}

/**
 * Export options for enhanced export
 */
export interface ExportOptions {
  includeAudio?: boolean;
  includeVoiceProfiles?: boolean;
  includeSpeakerMappings?: boolean;
  dateRange?: {
    start: Date;
    end: Date;
  };
  onProgress?: (progress: BackupProgress) => void;
}

/**
 * Audio export options
 */
export interface AudioExportOptions {
  format?: 'zip';
  dateRange?: {
    start: Date;
    end: Date;
  };
  tags?: string[];
  onProgress?: (progress: { current: number; total: number }) => void;
}

/**
 * Audio import options
 */
export interface AudioImportOptions {
  overwrite?: boolean;
  skipExisting?: boolean;
  validateAudio?: boolean;
  onProgress?: (progress: { current: number; total: number }) => void;
}

