import { ApiProperty } from '@nestjs/swagger';
import {
  LANGUAGE_MODE_SOURCES,
  LANGUAGE_RESOLUTION_REASONS,
  type LanguageModeSource,
  type LanguageResolution,
  type LanguageResolutionReason,
} from './language-mode';

/** The engine-neutral decode fields STT actually applied (`LanguageResolution.params`). */
export class LanguageResolutionParamsResponse {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The language the engine was pinned to; null = unpinned (the engine auto-detects).',
    example: 'ml',
  })
  language!: string | null;

  @ApiProperty({ description: 'Whether the engine ran in its code-switch mode (e.g. Sarvam `codemix`).' })
  codeSwitching!: boolean;

  @ApiProperty({ description: 'Whether an English gloss track ran beside the transcript (Whisper-family pairs).' })
  streamingEnglishGloss!: boolean;

  @ApiProperty({ description: 'Whether a priming prompt was actually sent to the decoder.' })
  primed!: boolean;
}

/**
 * TASK-1004 — the language RECEIPT: what a session or job was asked for, and what its serving
 * engine actually applied. Never a routing input — language does not choose the engine.
 */
export class LanguageResolutionResponse implements LanguageResolution {
  @ApiProperty({ description: 'The mode the precedence resolved (request > consultation > agent > auto).', example: 'ml-en' })
  requestedMode!: string;

  @ApiProperty({ enum: LANGUAGE_MODE_SOURCES, description: 'Which tier declared the mode.' })
  source!: LanguageModeSource;

  @ApiProperty({ description: 'The mode the serving engine applied (`auto` when nothing could be pinned).', example: 'ml-en' })
  appliedMode!: string;

  @ApiProperty({ description: 'The serving engine (`AiModelFormat`).', example: 'SARVAM' })
  engine!: string;

  @ApiProperty({ nullable: true, type: String, description: "The resolved ASR model's provider; null for a self-hosted engine.", example: 'sarvam' })
  provider!: string | null;

  @ApiProperty({ type: LanguageResolutionParamsResponse })
  params!: LanguageResolutionParamsResponse;

  @ApiProperty({ description: 'True when the engine serves the mode only partially — the reason says how. Never silent.' })
  degraded!: boolean;

  @ApiProperty({ enum: LANGUAGE_RESOLUTION_REASONS, nullable: true, description: 'Why the receipt is degraded; null when it is not.' })
  reason!: LanguageResolutionReason | null;
}
