import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Types of events that appear in the consultation timeline.
 */
export enum TimelineEventType {
    ConsultationOpened = 'consultation_opened',
    ContextAdded = 'context_added',
    ContextUpdated = 'context_updated',
    TranscriptionStarted = 'transcription_started',
    TranscriptionCompleted = 'transcription_completed',
    SummaryGenerated = 'summary_generated',
    SummaryUpdated = 'summary_updated',
    NerExtracted = 'ner_extracted',
    PreSummaryGenerated = 'pre_summary_generated',
}

/**
 * A single event in the consultation timeline.
 */
export class TimelineEventResponse {
    @ApiProperty({ description: 'ISO-8601 timestamp of the event' })
    timestamp: string;

    @ApiProperty({ enum: TimelineEventType, description: 'Type of timeline event' })
    type: TimelineEventType;

    @ApiProperty({ description: 'Consultation ID this event belongs to' })
    consultationId: string;

    @ApiPropertyOptional({ description: 'Department name (when available)' })
    department?: string;

    @ApiPropertyOptional({ description: 'Department ID' })
    departmentId?: string;

    @ApiPropertyOptional({ description: 'Doctor display name (when available)' })
    doctor?: string;

    @ApiPropertyOptional({ description: 'Doctor user ID' })
    doctorId?: string;

    @ApiPropertyOptional({ description: 'Context item type (TRANSCRIPT, CASE_NOTE, etc.)' })
    contextType?: string;

    @ApiPropertyOptional({ description: 'Context item ID (for context-related events)' })
    contextItemId?: string;

    @ApiPropertyOptional({ description: 'Word count (for transcription events)' })
    wordCount?: number;

    @ApiPropertyOptional({ description: 'AI model used (for summary/NER events)' })
    aiModel?: string;

    @ApiPropertyOptional({ description: 'Entity count (for NER events)' })
    entityCount?: number;

    @ApiPropertyOptional({ description: 'Current version number (for update events)' })
    versionNumber?: number;
}

/**
 * Timeline query parameters.
 */
export class TimelineQueryDto {
    scope?: 'single' | 'chain';
}

/**
 * Full timeline response for a consultation or chain.
 */
export class ConsultationTimelineResponse {
    @ApiProperty({ description: 'Consultation ID (the one queried)' })
    consultationId: string;

    @ApiProperty({
        enum: ['single', 'chain'],
        description: 'Scope of the timeline: single consultation or full chain + same-day',
    })
    scope: 'single' | 'chain';

    @ApiProperty({
        type: [TimelineEventResponse],
        description: 'Chronologically ordered list of events',
    })
    events: TimelineEventResponse[];

    @ApiProperty({ description: 'Total number of events in the timeline' })
    totalEvents: number;

    @ApiProperty({
        description: 'Source consultations included in this timeline',
        type: 'array',
        items: {
            type: 'object',
            properties: {
                consultationId: { type: 'string' },
                department: { type: 'string' },
                doctor: { type: 'string' },
            },
        },
    })
    sources: Array<{
        consultationId: string;
        department?: string;
        doctor?: string;
    }>;
}
