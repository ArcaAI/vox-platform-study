/**
 * Meeting-related types
 */

import type { Timestamp, UUID } from './common';
import type { TranscriptionSegment } from './transcription';
import type { LLMSummary } from './llm';

/**
 * Meeting metadata
 */
export interface Meeting {
  id: UUID;
  title: string;
  description?: string;
  startTime: Timestamp;
  endTime?: Timestamp;
  duration?: number; // in seconds
  participants?: string[];
  tags?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Meeting status
 */
export type MeetingStatus = 'scheduled' | 'in-progress' | 'completed' | 'cancelled';

/**
 * Complete meeting data including transcription and summary
 */
export interface MeetingData {
  meeting: Meeting;
  status: MeetingStatus;
  transcription?: TranscriptionSegment[];
  summary?: LLMSummary;
  audioFileUrl?: string;
}

/**
 * Meeting creation input
 */
export interface CreateMeetingInput {
  title: string;
  description?: string;
  participants?: string[];
  tags?: string[];
}

/**
 * Meeting update input
 */
export interface UpdateMeetingInput {
  title?: string;
  description?: string;
  participants?: string[];
  tags?: string[];
}
