import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The platform TTS catalog derived from the AiModel registry
 * (SYSTEM-tenant ENABLED `TEXT_TO_SPEECH` rows, voices from `metaData.voices`).
 * Falls back to the code-constant provider universe (with no voice metadata)
 * when the registry has no TTS rows yet (pre-seed).
 */
export class TtsCatalogVoice {
  @ApiProperty({ description: 'Provider voice identifier (the value bound in voiceBindings)' })
  id!: string;

  @ApiProperty({ description: 'BCP-47 locale of the voice', example: 'en-IN' })
  locale!: string;

  @ApiPropertyOptional({ description: 'Voice gender when declared' })
  gender?: string;

  @ApiPropertyOptional({ description: 'Alternate display/binding name when declared' })
  name?: string;
}

export class TtsCatalogProvider {
  @ApiProperty({ description: 'TTS routing provider id (azure, sarvam, kokoro, indic_parler, indic_f5, ...)' })
  provider!: string;

  @ApiProperty({ description: 'Backing AiModel registry slug (equals the provider id in the pre-seed fallback)' })
  slug!: string;

  @ApiProperty({ description: 'Human-readable engine name' })
  name!: string;

  @ApiProperty({ description: 'Voices this engine offers (empty when the registry row declares none)', type: [TtsCatalogVoice] })
  voices!: TtsCatalogVoice[];
}

export class TtsPlatformCatalogResponse {
  @ApiProperty({ description: 'Platform TTS engines', type: [TtsCatalogProvider] })
  providers!: TtsCatalogProvider[];
}
