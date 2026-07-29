/**
 * Transcription-related types
 */

import type { Timestamp } from './common';

/**
 * Transcription segment with timestamp
 */
export interface TranscriptionSegment {
  id: string;
  text: string;
  startTime: number; // seconds from start
  endTime: number; // seconds from start
  confidence?: number; // 0-1
  speaker?: string;
  language?: string;
  words?: Word[]; // Optional word-level timestamps
}

/**
 * Word-level timestamp
 */
export interface Word {
  word: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

/**
 * Speaker information for diarization
 */
export interface Speaker {
  id: string;
  name?: string;
  segments: number[]; // indices of segments spoken by this speaker
}

/**
 * Complete transcription result
 */
export interface TranscriptionResult {
  segments: TranscriptionSegment[];
  speakers?: Speaker[];
  language: string;
  duration: number;
  modelId: string; // Model used for transcription
  createdAt: Timestamp;
  metadata?: AudioMetadata;
}

/**
 * Audio metadata
 */
export interface AudioMetadata {
  sampleRate: number;
  channels: number;
  originalFormat: string;
  duration: number; // seconds
  size: number; // bytes
}

/**
 * Transcription options
 */
export interface TranscriptionOptions {
  language?: string; // ISO 639-1 code (e.g., 'en', 'es')
  modelId?: string; // Override default model
  task?: 'transcribe' | 'translate'; // Transcribe or translate to English
  returnTimestamps?: boolean; // Default: true
  returnWordTimestamps?: boolean; // Default: false
  chunkLengthSeconds?: number; // Default: 30
  onProgress?: (progress: TranscriptionProgress) => void;

  // Legacy options (for backward compatibility)
  enableDiarization?: boolean; // speaker separation (future feature)
  enableTimestamps?: boolean; // deprecated, use returnTimestamps
  enableWordTimestamps?: boolean; // deprecated, use returnWordTimestamps
  model?: string; // deprecated, use modelId
}

/**
 * Transcription initialization options
 */
export interface TranscriptionInitOptions {
  defaultModel?: string; // Default: "Xenova/whisper-base"
  cacheModels?: boolean; // Default: true
  useGPU?: boolean; // Default: false (WebGPU if available)
}

/**
 * Progress tracking for transcription
 */
export interface TranscriptionProgress {
  stage: 'downloading' | 'loading' | 'processing' | 'complete';
  progress: number; // 0-100
  message: string;
  estimatedTimeRemaining?: number; // seconds
  currentChunk?: number;
  totalChunks?: number;
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  size: number; // bytes
  speed: string; // e.g., "4-5x RT"
  accuracy: string; // "Good", "Better", "Best"
  languages: string[]; // ["en"] or ["multilingual"]
  description: string;
}

/**
 * Audio conversion options
 */
export interface AudioConversionOptions {
  targetSampleRate?: number; // Default: 16000 (Whisper requirement)
  targetChannels?: number; // Default: 1 (mono)
  format?: 'float32' | 'int16'; // Default: 'float32'
}

/**
 * Transcription status
 */
export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Transcription job
 */
export interface TranscriptionJob {
  id: string;
  status: TranscriptionStatus;
  progress?: number; // 0-100
  result?: TranscriptionResult;
  error?: string;
  createdAt: Timestamp;
  completedAt?: Timestamp;
}
