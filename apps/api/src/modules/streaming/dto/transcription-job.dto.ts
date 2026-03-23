import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class TranscribeFileRequest {
    @ApiProperty({ description: 'Pipeline ID to use for transcription' })
    @IsString()
    @IsNotEmpty()
    pipelineId!: string;

    @ApiPropertyOptional({ description: 'Associated consultation ID' })
    @IsString()
    @IsOptional()
    consultationId?: string;

    @ApiPropertyOptional({ description: 'Language code (e.g., en, th)' })
    @IsString()
    @IsOptional()
    language?: string;

    @ApiPropertyOptional({ description: 'Enable code switching', example: 'true' })
    @IsString()
    @IsOptional()
    codeSwitching?: string;

    @ApiPropertyOptional({ description: 'Enable speaker diarization', example: 'true' })
    @IsString()
    @IsOptional()
    diarization?: string;
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
