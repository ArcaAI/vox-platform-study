import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNumber, IsObject, Min, Max } from 'class-validator';
import { TranscriptionJobStatus } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';

export class UpdateJobStatusRequest {
    @ApiProperty({
        description: 'New job status',
        enum: TranscriptionJobStatus,
        example: TranscriptionJobStatus.PROCESSING
    })
    @IsEnum(TranscriptionJobStatus)
    status: TranscriptionJobStatus;

    @ApiPropertyOptional({
        description: 'Error message (for FAILED status)',
        example: 'Audio file is corrupted'
    })
    @IsString()
    @IsOptional()
    errorMessage?: string;

    @ApiPropertyOptional({
        description: 'Error code (for FAILED status)',
        example: 'AUDIO_CORRUPT'
    })
    @IsString()
    @IsOptional()
    errorCode?: string;

    @ApiPropertyOptional({
        description: 'Worker ID processing this job',
        example: 'worker-001'
    })
    @IsString()
    @IsOptional()
    workerId?: string;
}

export class UpdateJobProgressRequest {
    @ApiProperty({
        description: 'Job progress (0-100)',
        example: 50,
        minimum: 0,
        maximum: 100
    })
    @IsNumber()
    @Min(0)
    @Max(100)
    progress: number;
}

export class CompleteJobRequest {
    @ApiProperty({
        description: 'Transcription result text'
    })
    @IsString()
    resultText: string;

    @ApiPropertyOptional({
        description: 'Result metadata (word timestamps, confidence scores, etc.)'
    })
    @IsObject()
    @IsOptional()
    resultMetadata?: JsonValue;

    @ApiPropertyOptional({
        description: 'Context item ID (if transcript was saved as context item)',
        example: '01234567-89ab-cdef-0123-456789abcdef'
    })
    @IsString()
    @IsOptional()
    contextItemId?: string;
}
