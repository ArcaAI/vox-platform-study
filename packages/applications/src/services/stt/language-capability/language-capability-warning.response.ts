import { ApiProperty } from '@nestjs/swagger';
import type { LanguageCapabilityWarning } from './asr-language-capability.service';

/**
 * TASK-1004 §4.5 — one configuration-time language warning: a catalog mode the ASR agent's PRIMARY
 * engine serves only partially (`degraded`) or not at all (`unsupported`). Advisory — the write it
 * rides on has already succeeded, and nothing is re-routed (language never chooses the engine).
 */
export class LanguageCapabilityWarningResponse implements LanguageCapabilityWarning {
  @ApiProperty({ enum: ['LANGUAGE_MODE_DEGRADED', 'LANGUAGE_MODE_UNSUPPORTED'] })
  code!: 'LANGUAGE_MODE_DEGRADED' | 'LANGUAGE_MODE_UNSUPPORTED';

  @ApiProperty({ description: 'The SPEECH_TO_TEXT agent the warning is about.' })
  agentSlug!: string;

  @ApiProperty({ description: 'The spoken-language mode id.', example: 'ml-en' })
  mode!: string;

  @ApiProperty({ description: 'The agent’s PRIMARY engine (`AiModelFormat`).', example: 'WHISPER_CPP' })
  engine!: string;

  @ApiProperty({ enum: ['degraded', 'unsupported'] })
  level!: 'degraded' | 'unsupported';

  @ApiProperty({ description: 'What an operator should know, in one sentence.' })
  message!: string;
}
