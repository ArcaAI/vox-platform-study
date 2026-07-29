/**
 * Speaker Mapping Types
 *
 * Type definitions for speaker recognition and mapping system
 */

import type { VoiceEmbedding } from './voice-recognition';

/**
 * Audio segment with buffer for speaker recognition
 * Combines diarization segment info with audio data
 */
export interface SpeakerAudioSegment {
  speakerLabel: string; // "Speaker_01", "Speaker_02", etc.
  startTime: number; // seconds
  endTime: number; // seconds
  duration: number; // seconds
  audioData: Float32Array; // Audio samples
  sampleRate: number; // Sample rate in Hz
}

/**
 * Similarity between segment and profile
 */
export interface ProfileSimilarity {
  profileId: string;
  personName: string;
  similarity: number; // 0.0 to 1.0 (cosine similarity)
  maxSimilarity: number;
  minSimilarity: number;
  contextBonus?: number; // Bonus from meeting context
}

/**
 * Recognition result for a single segment
 */
export interface SegmentRecognitionResult {
  embedding: VoiceEmbedding;
  similarities: ProfileSimilarity[];
  bestMatch: ProfileSimilarity | null;
}

/**
 * Aggregated recognition result for a speaker
 */
export interface AggregatedRecognitionResult {
  speakerLabel: string;
  segmentCount: number;
  totalDuration: number; // seconds
  profileSimilarities: ProfileSimilarity[];
  bestMatch: ProfileSimilarity | null;
}

/**
 * Final speaker recognition result
 */
export interface SpeakerRecognitionResult {
  speakerLabel: string; // "Speaker_01"
  personId: string | null; // Profile ID or null for unknown
  personName: string | null; // "John Doe" or null for unknown
  confidence: number; // 0.0 to 1.0
  similarityScore: number; // Raw cosine similarity
  contextBonus: number; // Bonus from meeting context
  segmentCount: number; // Number of segments for this speaker
  totalDuration: number; // Total duration in seconds
}

/**
 * Meeting context for recognition
 */
export interface MeetingContext {
  meetingId: string;
  title?: string;
  expectedAttendees?: string[]; // Profile IDs of expected attendees
  startTime: number;
  endTime?: number;
}

/**
 * Speaker mapping for a meeting
 */
export interface SpeakerMapping {
  id: string;
  meetingId: string;
  mappings: SpeakerRecognitionResult[];
  unmappedSpeakers: string[]; // Speaker labels with no match
  confidence: number; // Overall mapping confidence (0.0 to 1.0)
  manualCorrections: ManualCorrection[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Manual correction by user
 */
export interface ManualCorrection {
  speakerLabel: string;
  originalPersonId: string | null;
  correctedPersonId: string | null;
  correctedPersonName: string;
  timestamp: number;
  reason?: string;
}

/**
 * Mapping metadata for listing
 */
export interface SpeakerMappingMetadata {
  id: string;
  meetingId: string;
  speakerCount: number;
  mappedCount: number;
  unmappedCount: number;
  averageConfidence: number;
  hasCorrections: boolean;
  createdAt: number;
}

/**
 * Recognition configuration
 */
export interface RecognitionConfig {
  confidenceThreshold: number; // Default: 0.75
  contextBonus: number; // Default: 0.05 (5%)
  minSegmentDuration: number; // Default: 3 seconds
  maxSegmentDuration: number; // Default: 30 seconds
  aggregationMethod: 'average' | 'weighted' | 'max';
}

/**
 * Default recognition configuration
 */
export const DEFAULT_RECOGNITION_CONFIG: RecognitionConfig = {
  confidenceThreshold: 0.5, // Balanced threshold for accuracy (with margin check for additional validation)
  contextBonus: 0.05,
  minSegmentDuration: 3,
  maxSegmentDuration: 30,
  aggregationMethod: 'weighted',
};

/**
 * Confidence level classification
 */
export enum ConfidenceLevel {
  VERY_LOW = 'very_low', // 0.0 - 0.49
  LOW = 'low', // 0.50 - 0.69
  MEDIUM = 'medium', // 0.70 - 0.84
  HIGH = 'high', // 0.85 - 1.0
}

/**
 * Get confidence level from score
 */
export function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence < 0.5) return ConfidenceLevel.VERY_LOW;
  if (confidence < 0.7) return ConfidenceLevel.LOW;
  if (confidence < 0.85) return ConfidenceLevel.MEDIUM;
  return ConfidenceLevel.HIGH;
}

/**
 * Error codes for speaker mapping
 */
export enum SpeakerMappingErrorCode {
  NO_PROFILES = 'NO_PROFILES',
  NO_SEGMENTS = 'NO_SEGMENTS',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  COMPARISON_FAILED = 'COMPARISON_FAILED',
  AGGREGATION_FAILED = 'AGGREGATION_FAILED',
  MAPPING_NOT_FOUND = 'MAPPING_NOT_FOUND',
  STORAGE_ERROR = 'STORAGE_ERROR',
  INVALID_CORRECTION = 'INVALID_CORRECTION',
  INVALID_CONFIG = 'INVALID_CONFIG',
}

/**
 * Error messages for speaker mapping
 */
export const SPEAKER_MAPPING_ERROR_MESSAGES: Record<SpeakerMappingErrorCode, string> = {
  [SpeakerMappingErrorCode.NO_PROFILES]: 'No voice profiles found. Please enroll at least one profile.',
  [SpeakerMappingErrorCode.NO_SEGMENTS]: 'No speaker segments found in diarization result.',
  [SpeakerMappingErrorCode.EXTRACTION_FAILED]: 'Failed to extract voice embedding from segment.',
  [SpeakerMappingErrorCode.COMPARISON_FAILED]: 'Failed to compare embeddings.',
  [SpeakerMappingErrorCode.AGGREGATION_FAILED]: 'Failed to aggregate segment results.',
  [SpeakerMappingErrorCode.MAPPING_NOT_FOUND]: 'Speaker mapping not found.',
  [SpeakerMappingErrorCode.STORAGE_ERROR]: 'Failed to store speaker mapping.',
  [SpeakerMappingErrorCode.INVALID_CORRECTION]: 'Invalid manual correction data.',
  [SpeakerMappingErrorCode.INVALID_CONFIG]: 'Invalid recognition configuration.',
};
