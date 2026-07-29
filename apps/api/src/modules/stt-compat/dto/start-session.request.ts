import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

class AudioSettingsDto {
  @ApiProperty({
    description: 'Sample rate in Hz',
    example: 44100,
  })
  @IsNumber()
  sampleRate: number;

  @ApiProperty({
    description: 'Audio format',
    example: 'pcm',
    enum: ['pcm', 'wav', 'mp3'],
  })
  @IsIn(['pcm', 'wav', 'mp3'])
  format: 'pcm' | 'wav' | 'mp3';

  @ApiProperty({
    description: 'Number of audio channels',
    example: 1,
    enum: [1, 2],
  })
  @IsIn([1, 2])
  channels: 1 | 2;

  @ApiProperty({
    description: 'Bit depth',
    example: 16,
    enum: [8, 16, 24, 32],
  })
  @IsIn([8, 16, 24, 32])
  bitDepth: 8 | 16 | 24 | 32;

  @ApiProperty({
    description: 'Chunk size for real-time processing',
    example: 1024,
  })
  @IsNumber()
  chunkSize: number;

  @ApiProperty({
    description: 'Enable noise suppression',
    example: true,
  })
  @IsBoolean()
  noiseSuppression: boolean;

  @ApiProperty({
    description: 'Enable echo cancellation',
    example: true,
  })
  @IsBoolean()
  echoCancellation: boolean;

  @ApiProperty({
    description: 'Enable automatic gain control',
    example: false,
  })
  @IsBoolean()
  autoGainControl: boolean;
}

export class StartSessionRequest {
  @ApiProperty({
    description: 'Unique session identifier',
    example: 'session_123456789',
  })
  @IsString()
  session_id: string;

  @ApiPropertyOptional({
    description: 'Language code for transcription',
    example: 'en-US',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  language?: string | null;

  @ApiProperty({
    description: 'Audio processing settings',
    type: AudioSettingsDto,
  })
  @IsObject()
  audioSettings: AudioSettingsDto;

  @ApiPropertyOptional({
    description: 'STT provider',
    example: 'azure',
    default: 'azure',
    enum: ['azure', 'whisper', 'sarvam'],
  })
  @IsOptional()
  @IsIn(['azure', 'whisper', 'sarvam'])
  provider?: 'azure' | 'whisper' | 'sarvam';
}
