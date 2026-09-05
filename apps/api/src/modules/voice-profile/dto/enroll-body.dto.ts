import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class EnrollBodyDto {
  @ApiProperty({ description: 'Optional label for this voice profile', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({
    description:
      'TASK-887 — the SPEECH_TO_TEXT agent this enrollment is for. Diarization is a declared agent option, so the ' +
      'agent names the SPEAKER_EMBEDDING model that embeds the samples and the profile is stored in that model’s ' +
      'space. Omit to enroll for the tenant’s assigned ASR agent (the AgentAssignment cascade) — which is what a ' +
      'session with no explicit agent will run.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  agentSlug?: string;
}
