import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export const AUDIO_BUCKET = 'hope-audio';
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export const ALLOWED_AUDIO_MIMES = new Set([
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/ogg',
    'audio/flac',
    'audio/x-flac',
    'audio/webm',
    'audio/aac',
]);

export class TranscribeFileRequest {
    @ApiProperty({ description: 'Pipeline ID to use for transcription' })
    @IsString()
    @IsNotEmpty()
    pipelineId!: string;

    @ApiPropertyOptional({ description: 'Associated consultation ID' })
    @IsUUID()
    @IsOptional()
    consultationId?: string;

    @ApiPropertyOptional({ description: 'Language code (e.g., en, th)' })
    @IsString()
    @IsOptional()
    language?: string;

    @ApiPropertyOptional({ description: 'Enable code switching', example: 'true' })
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    @IsOptional()
    codeSwitching?: boolean;

    @ApiPropertyOptional({ description: 'Enable speaker diarization', example: 'true' })
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    @IsOptional()
    diarization?: boolean;
}

export class CreateStreamSessionRequest {
    @ApiProperty({ description: 'Pipeline ID to use for streaming' })
    @IsString()
    @IsNotEmpty()
    pipelineId!: string;

    @ApiPropertyOptional({ description: 'Associated consultation ID' })
    @IsString()
    @IsOptional()
    consultationId?: string;

    @ApiPropertyOptional({ description: 'Audio sample rate in Hz', default: 16000 })
    @IsNumber()
    @IsOptional()
    sampleRate?: number;

    @ApiPropertyOptional({ description: 'Language code' })
    @IsString()
    @IsOptional()
    language?: string;

    @ApiPropertyOptional({ description: 'Enable code switching' })
    @IsBoolean()
    @IsOptional()
    codeSwitching?: boolean;

    @ApiPropertyOptional({ description: 'Enable speaker diarization' })
    @IsBoolean()
    @IsOptional()
    diarization?: boolean;
}

export class StreamSessionResponse {
    @ApiProperty({ description: 'Session ID' })
    sessionId!: string;

    @ApiProperty({ description: 'Session status' })
    status!: string;

    @ApiProperty({ description: 'WebSocket URL for streaming' })
    wsUrl!: string;

    @ApiProperty({ description: 'Maximum concurrent sessions allowed' })
    maxConcurrent!: number;

    @ApiProperty({ description: 'Currently active sessions' })
    currentActive!: number;
}

export class BatchTranscribeResponse {
    @ApiProperty({ description: 'Transcription job ID' })
    id!: string;

    @ApiProperty({ description: 'Current job status' })
    status!: string;

    @ApiProperty({ description: 'SSE stream URL for real-time updates' })
    sseUrl!: string;

    @ApiProperty({ description: 'Audio file URI in storage' })
    audioUri!: string;
}
